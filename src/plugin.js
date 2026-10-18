/**
 * dsh-session-relocate —— 主机侧。
 *
 * 提供 /api/dsh-session-relocate/{describe,move,status} 桥接给网页端，并在启动时补完
 * 上次没做完的迁移。
 *
 * 刻意**不 import 任何 @deepseek-ai/* 包**：
 *   - 需要的服务全部从 cordis ctx 上取（workspaceRegistry / sessionPersistence / sessions）；
 *   - dsh home 自己按 DSH_HOME > ~/.dsh 的顺序解析。
 * 这样即使 profile 的 node_modules 布局和预期不同，插件也能加载。
 *
 * @module dsh-session-relocate
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeSegment, sessionDir } from './paths.js';
import { commitMoves, createMoveStore, MoveError, recoverPendingMoves, relocateSession, samePath } from './relocate.js';

/** 插件名（必须与 package.json 的 name 一致）。 */
export const name = 'dsh-session-relocate';

/**
 * 需要的工作区注册表与会话持久层。两者都是 web 组合里的常规成员；
 * 缺任一个就说明这个部署没有「工作区」概念，插件不应该加载。
 */
export const inject = ['workspaceRegistry', 'sessionPersistence'];

/** 桥接默认前缀。 */
const DEFAULT_PREFIX = '/api/dsh-session-relocate';
/**
 * 插件版本：**唯一来源是 package.json**（发布规程 §1.1：版本号只能写一处，
 * 写两处就会漂移 —— 这个常量曾经是硬编码的 '0.4.0'，package.json 升到 0.5.0 后
 * 运行时自报的版本就骗人了）。读不到才退化成显眼的 unknown。
 */
const PLUGIN_VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version;
  } catch {
    return '0.0.0-unknown';
  }
})();
/** 允许挂在 window 上的引导全局名，供客户端读前缀。 */
const BOOT_GLOBAL = '__DSH_SESSION_RELOCATE__';
/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024;

/** 解析 DSH home：显式配置 > $DSH_HOME > ~/.dsh（与 dsh-home-paths 的优先级一致）。 */
function resolveHome(settings) {
  if (typeof settings.home === 'string' && settings.home.trim().length > 0) return settings.home.trim();
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim().length > 0) return env.trim();
  return join(homedir(), '.dsh');
}

/** 请求体解析失败。映射成 400 + code: 'bad-request'，而不是 500 internal。 */
class BadRequestBodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadRequestBodyError';
    this.code = 'bad-request';
  }
}

/** 读一个 JSON 请求体。 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequestBodyError('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new BadRequestBodyError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 写一个 JSON 响应。 */
function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

/** 把内部错误转成稳定的失败载荷。 */
function failure(error) {
  if (error instanceof MoveError) {
    return { ok: false, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof BadRequestBodyError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return { ok: false, code: 'internal', message: String(error && error.message ? error.message : error) };
}

/**
 * 挂载插件。
 *
 * @param ctx - cordis 上下文。
 * @param config - profile 里这一行的 config。
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {};
  const home = resolveHome(settings);
  const prefix = typeof settings.bridgePrefix === 'string' && settings.bridgePrefix.trim().length > 0
    ? settings.bridgePrefix.trim().replace(/\/+$/, '')
    : DEFAULT_PREFIX;
  const journalsDir = typeof settings.journalsDir === 'string' && settings.journalsDir.trim().length > 0
    ? settings.journalsDir.trim()
    : join(home, 'session-move');
  // 默认会自动释放「打开中但空闲」的会话，好让它能被搬走。releaseLive=false 恢复旧行为。
  const releaseLive = settings.releaseLive !== false;
  // 「就地接管」：打开中且**还在跑活**的会话也能搬 —— 换掉 live 写句柄的 header，
  // 在持有写链的情况下搬文件，正在跑的 turn 不中断。默认开；关掉就退回「正在跑活的拒绝」。
  const moveLive = settings.moveLive !== false;
  // 侧边栏拖动搬移（客户端读引导全局里的 drag 开关）。DSH 改了 DOM 约定时可以一键关掉。
  const dragMove = settings.dragMove !== false;
  /** 每次就地接管的窗口，供自测断言「搬迁期间没有写入插进来」。 */
  const handoffLog = [];
  const releaseRetries = Number.isSafeInteger(settings.releaseRetries) && settings.releaseRetries >= 0
    ? settings.releaseRetries
    : 24;
  const releaseRetryDelayMs = Number.isFinite(settings.releaseRetryDelayMs) && settings.releaseRetryDelayMs > 0
    ? settings.releaseRetryDelayMs
    : 150;
  // 自测接口默认关闭；打开后会多出 __selftest/* 路由（用来造一个 live 会话做验证）。
  const selftest = settings.selftest === true;
  const selftestLeases = new Map();
  /** 自测用的「写入压力」循环状态。 */
  const selftestPressure = { timer: null, sessionId: null, marks: [] };

  /** 等一小会儿（释放租约是异步的，靠重试确认）。 */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 找到某个会话的 live 写句柄。
   *
   * 它在后端的 **tracker** 上（JsonlBackendTracker.writers），不在持久化服务本身；
   * 顺手也认直接挂在服务上的写法，免得换个 rc 版本就静默失效。
   * writers 里可能是 null（已创建但未物化的占位），那也当成「没有句柄」。
   */
  function findWriteHandle(sessionId) {
    const persistence = ctx.sessionPersistence;
    const maps = [
      persistence.writers,
      persistence.tracker !== undefined ? persistence.tracker.writers : undefined,
    ];
    for (const map of maps) {
      if (map === undefined || map === null || typeof map.get !== 'function') continue;
      const handle = map.get(sessionId);
      if (handle !== undefined && handle !== null && typeof handle.enqueueChain === 'function') return handle;
    }
    return undefined;
  }

  const logger = ctx.logger;
  const log = (level, message) => {
    const sink = logger !== undefined && typeof logger[level] === 'function' ? logger[level].bind(logger) : undefined;
    if (sink !== undefined) {
      sink('[dsh-session-relocate] ' + message);
      return;
    }
    if (level === 'warn') console.warn('[dsh-session-relocate] ' + message);
    else console.log('[dsh-session-relocate] ' + message);
  };

  /** 会话存储根目录。后端把 root 作为私有字段持有，取不到就按 home 惯例回退。 */
  function sessionsRoot() {
    if (typeof settings.sessionsRoot === 'string' && settings.sessionsRoot.trim().length > 0) {
      return settings.sessionsRoot.trim();
    }
    const root = ctx.sessionPersistence.root;
    if (typeof root === 'string' && root.length > 0) return root;
    return join(home, 'sessions');
  }

  /**
   * 一个会话在某个 cwd 下的目录。优先问后端自己（locate 返回的是当前 generation
   * 的路径，取父目录即会话目录），这样 projectKey 的细节永远与后端保持一致。
   */
  function sessionDirFor(sessionId, cwd) {
    const persistence = ctx.sessionPersistence;
    if (typeof persistence.locate === 'function') {
      try {
        const located = persistence.locate({ id: sessionId, cwd });
        if (located !== undefined && typeof located.path === 'string' && located.path.length > 0) {
          return dirname(located.path);
        }
      } catch {
        // 落到回退实现
      }
    }
    return sessionDir(sessionsRoot(), cwd, sessionId);
  }

  const store = createMoveStore({
    sessionsRoot: sessionsRoot(),
    journalsDir,
    sessionDirFor,
    log,
    // 校验强度：auto（小日志全文解码，大日志帧级抽样）或 full（永远全文解码）。
    verify: settings.verify === 'full' ? 'full' : 'auto',
    fullVerifyLimit: Number.isSafeInteger(settings.fullVerifyLimit) && settings.fullVerifyLimit > 0
      ? settings.fullVerifyLimit
      : undefined,
  });

  /** 组装一次迁移需要的 DSH 运行时能力。 */
  function buildHost() {
    const registry = ctx.workspaceRegistry;
    return {
      async statSession(sessionId) {
        return await ctx.sessionPersistence.stat(sessionId);
      },
      getWorkspace(workspaceId) {
        return registry.get(workspaceId);
      },
      async createWorkspace(path) {
        // 注册表内部会先 realpath 目标路径，所以「目录不存在会被创建」这条承诺
        // 必须由我们先把目录建出来，否则 realpath 会直接 ENOENT。
        await mkdir(path, { recursive: true });
        return await registry.create(path);
      },
      findWorkspaceByPath(canonicalPath) {
        for (const entity of registry.list()) {
          if (samePath(entity.path, canonicalPath)) return entity;
        }
        return undefined;
      },
      isSessionLive(sessionId) {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || typeof sessions.get !== 'function') return false;
        try {
          return sessions.get(sessionId) !== undefined;
        } catch {
          return false;
        }
      },
      async listActivity(sessionId) {
        if (typeof ctx.waterfall !== 'function') return [];
        try {
          const activity = await ctx.waterfall(
            'workspace/session-activity',
            { sessionId },
            () => Promise.resolve([]),
          );
          return Array.isArray(activity) ? activity : [];
        } catch (error) {
          log('warn', '查询会话活动失败，按「无活动」继续：' + String(error && error.message));
          return [];
        }
      },
      describeActivity(activity) {
        return activity.map((entry) => (entry !== null && typeof entry === 'object' ? entry.kind : '?')).join('、');
      },
      /**
       * 释放一个「活着」的会话：flush → 摘掉 entered 记录 → 用写打开探针确认写租约真的没了。
       *
       * 为什么需要它：会话日志是**单写者**的，写所有权由 agent-loop 的写句柄持有
       * （它调 persistence.open(id,'write')），只在 DSH 进程退出时才释放。不释放就搬文件，
       * 那个句柄会继续往旧路径写、并在旧位置重建一个空壳目录。
       *
       * 摘除走的是 SessionStore 的私有缝 sessions.store.get(id).detach() —— 同一版本里
       * dsh-delete-session 也在生产里用它。它会派发 session/disposed，持久层据此
       * close 写句柄、释放 session.lock 租约；释放是异步的（fire-and-forget），
       * 所以这里用「写打开探针 + 重试」来确认。
       */
      /**
       * 就地接管一个正在运行的会话：**不释放它**，而是换掉它的 live 写句柄的 header，
       * 并在持有该句柄写链的情况下跑文件事务 —— 这样搬迁期间任何写入都排在我们后面，
       * 落地时已经指向新路径，正在跑的 turn 不会断。
       *
       * 依据（都在源码里核过）：
       *  - JsonlSessionHandle 的写入路径是每次从 this.header 现算的：
       *    persistContiguous → storage.persistBatch(header) → logPath(root, header.cwd, …)；
       *  - this.header 是**可写槽位**（deepFreeze 冻的是那个对象，不是这个属性）；
       *  - 内核写锁 this.lease 懒获取（ensureLease 用 ??=）：先释放再置空，
       *    下一次写入就会在新路径重新获取；
       *  - enqueueChain 是该句柄唯一的串行点，append/flush/drain 都走它；
       *  - drainLive 自己会往 chain 上排队，所以必须在进入临界区**之前**调用，否则死锁。
       */
      /** 现在能不能就地接管：有 live 写句柄才算能（没句柄就走释放路径）。 */
      canHandoff(sessionId) {
        return findWriteHandle(sessionId) !== undefined;
      },
      async handoffLive(sessionId, targetCwd, runTransaction) {
        const handle = findWriteHandle(sessionId);
        if (handle === undefined) {
          // 探测不到写句柄就**绝不静默搬** —— 那会留下「文件已搬、句柄还指着旧路径」
          // 的坏状态（下一次写入就把旧目录重建出来）。整体放弃，让调用方改走释放路径。
          return { ok: false, code: 'no-writer', detail: '找不到这个会话的 live 写句柄' };
        }
        if (typeof handle.drainLive === 'function') await handle.drainLive();
        if (typeof handle.flush === 'function') await handle.flush();

        const start = Date.now();
        let detail = '';
        const transaction = await handle.enqueueChain(async () => {
          if (typeof handle.ensureLease === 'function') await handle.ensureLease();
          const originalHeader = handle.header;
          try {
            if (handle.lease !== undefined && handle.lease !== null && typeof handle.lease.release === 'function') {
              await handle.lease.release();
            }
            handle.lease = null;
            handle.header = { ...originalHeader, cwd: targetCwd };
            const result = await runTransaction();
            detail = '写链已接管：header.cwd -> ' + targetCwd;
            result.writerRetargeted = true;
            return result;
          } catch (error) {
            // 回滚：恢复 header 与锁状态，让后续写入继续落在原路径。
            handle.header = originalHeader;
            handle.lease = null;
            throw error;
          }
        });
        const end = Date.now();
        handoffLog.push({ sessionId, start, end });
        return { ok: true, detail, transaction, window: { start, end } };
      },
      /**
       * 就地接管后的归属写入：**绕开 attachSession 的 cwd 校验**，直接走注册表自己的
       * 写路径（entity.mutate → table.update），并同步它的路径/header 索引。
       *
       * 为什么要绕：注册表校验归属时会 readSessionHeader(id)，而它优先取内存里的
       * live Session —— 那个 header 是 deep-frozen 的旧 cwd，改不了，所以校验必然失败。
       *
       * 顺序很关键：entity.mutate 内部会用 host.sessionPath(id) 过滤 sessionIds，
       * 所以必须**先**把 sessionPaths 指到新 cwd，否则刚加进去的 id 会被它自己滤掉。
       */
      async adoptSession(sessionId, targetEntity, sourceEntity, targetCwd) {
        const registry = ctx.workspaceRegistry;
        try {
          const liveSession = ctx.get('sessions')?.get(sessionId);
          const existing = registry.headers instanceof Map ? registry.headers.get(sessionId) : undefined;
          const base = liveSession !== undefined && liveSession.header !== undefined
            ? liveSession.header
            : (existing !== undefined ? existing : { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false });
          if (registry.sessionPaths instanceof Map) registry.sessionPaths.set(sessionId, targetCwd);
          if (registry.invalidSessionPaths instanceof Map) registry.invalidSessionPaths.delete(sessionId);
          if (registry.headers instanceof Map) registry.headers.set(sessionId, { ...base, cwd: targetCwd });
          if (typeof targetEntity.mutate !== 'function') {
            return { applied: false, refreshed: false, reason: '目标工作区实体没有 mutate 接口（DSH 版本变了）' };
          }
          await targetEntity.mutate((record) => (record.sessionIds.includes(sessionId)
            ? record
            : { ...record, sessionIds: [sessionId, ...record.sessionIds] }));
          if (sourceEntity !== undefined && sourceEntity.id !== targetEntity.id && typeof sourceEntity.mutate === 'function') {
            await sourceEntity.mutate((record) => (record.sessionIds.includes(sessionId)
              ? { ...record, sessionIds: record.sessionIds.filter((entry) => entry !== sessionId) }
              : record));
          }
          return { applied: true, refreshed: false };
        } catch (error) {
          return { applied: false, refreshed: false, reason: '直接写注册表归属失败：' + String(error && error.message) };
        }
      },
      /**
       * 批量归属写入（commitMoves 用）：先把这批会话的 header 缓存/路径索引一次性指到
       * 目标 cwd，再**一次 mutate** 把整批加进目标工作区 —— 注册表只落盘一次。
       * 和 adoptSession 同一条旁路，区别只是按批做。
       */
      async adoptSessions(sessionIds, targetEntity, targetCwd) {
        const registry = ctx.workspaceRegistry;
        try {
          if (typeof targetEntity.mutate !== 'function') {
            return { applied: false, refreshed: false, reason: '目标工作区实体没有 mutate 接口（DSH 版本变了）' };
          }
          for (const sessionId of sessionIds) {
            const liveSession = ctx.get('sessions')?.get(sessionId);
            const existing = registry.headers instanceof Map ? registry.headers.get(sessionId) : undefined;
            const base = liveSession !== undefined && liveSession.header !== undefined
              ? liveSession.header
              : (existing !== undefined ? existing : { version: 4, id: sessionId, createdAt: Date.now(), isSeeded: false });
            if (registry.sessionPaths instanceof Map) registry.sessionPaths.set(sessionId, targetCwd);
            if (registry.invalidSessionPaths instanceof Map) registry.invalidSessionPaths.delete(sessionId);
            if (registry.headers instanceof Map) registry.headers.set(sessionId, { ...base, cwd: targetCwd });
          }
          await targetEntity.mutate((record) => {
            const add = sessionIds.filter((id) => !record.sessionIds.includes(id));
            return add.length === 0 ? record : { ...record, sessionIds: [...add, ...record.sessionIds] };
          });
          return { applied: true, refreshed: false };
        } catch (error) {
          return { applied: false, refreshed: false, reason: '批量写目标归属失败：' + String(error && error.message) };
        }
      },
      /** 批量摘除（commitMoves 用）：一次 mutate 把整批从源工作区拿掉。 */
      async detachSessions(sessionIds, sourceEntity) {
        if (sourceEntity === undefined || sourceEntity === null || typeof sourceEntity.mutate !== 'function') {
          return { applied: true };
        }
        try {
          const drop = new Set(sessionIds);
          await sourceEntity.mutate((record) => {
            const keep = record.sessionIds.filter((id) => !drop.has(id));
            return keep.length === record.sessionIds.length ? record : { ...record, sessionIds: keep };
          });
          return { applied: true };
        } catch (error) {
          return { applied: false, reason: '批量摘除源归属失败：' + String(error && error.message) };
        }
      },
      async releaseSession(sessionId) {
        const sessions = ctx.get('sessions');
        if (sessions === undefined || typeof sessions.get !== 'function') {
          return { released: true, attempts: 0, detail: '没有 sessions 服务，视为无需释放' };
        }
        const live = sessions.get(sessionId);
        if (live === undefined) return { released: true, attempts: 0, detail: '本来就不在内存里' };

        if (typeof sessions.flush === 'function') {
          try {
            await sessions.flush(live);
          } catch (error) {
            log('warn', '释放前 flush 失败（继续释放）：' + String(error && error.message));
          }
        }

        const entries = sessions.store;
        const entered = entries !== undefined && typeof entries.get === 'function' ? entries.get(sessionId) : undefined;
        if (entered === undefined || typeof entered.detach !== 'function') {
          return { released: false, attempts: 0, detail: '拿不到可释放的 entered 记录（DSH 版本可能变了）' };
        }
        entered.detach();

        const persistence = ctx.sessionPersistence;
        if (typeof persistence.open !== 'function') return { released: true, attempts: 0, detail: '已从内存摘除（没有 open 可探测）' };
        // 前几次探得很快（正常情况 detach 完立刻就能拿到租约），之后退回常规间隔。
        // 这样"正常情况"几乎零等待，"被 GUI 抢着"时也仍然能等到，且总时长不变。
        const quickDelays = [0, 10, 25, 50, 100];
        let last = 'unknown';
        for (let attempt = 0; attempt <= releaseRetries; attempt++) {
          let handle;
          try {
            handle = await persistence.open(sessionId, 'write');
          } catch (error) {
            last = String(error && error.message !== undefined ? error.message : error);
            if (attempt === releaseRetries) break;
            const delay = attempt < quickDelays.length ? quickDelays[attempt] : releaseRetryDelayMs;
            if (delay > 0) await sleep(delay);
            continue;
          }
          try {
            await handle.close();
          } catch (error) {
            log('warn', '探针句柄关闭失败（不影响结论）：' + String(error && error.message));
          }
          return { released: true, attempts: attempt + 1, detail: '写租约已释放（第 ' + String(attempt + 1) + ' 次探测拿到写所有权）' };
        }
        return { released: false, attempts: releaseRetries + 1, detail: '写所有权仍被占用（试了 ' + String(releaseRetries + 1) + ' 次）：' + last };
      },
      /**
       * 重建注册表的 header 缓存。
       *
       * 这是**必需**的一步：注册表的 header 索引是启动时建的，磁盘上的 cwd 被我们改
       * 了以后它并不知道，不刷新的话 attachSession 会拿旧 cwd 去比目标路径然后拒掉。
       * 这两个成员是包私有实现，所以此处 feature-detect；取不到就返回 false，
       * 迁移会在下次启动时自动补齐归属。
       */
      async refreshHeaderIndex() {
        const listStored = registry.listStoredHeaders;
        const replace = registry.replaceHeaderIndex;
        if (typeof listStored !== 'function' || typeof replace !== 'function') return false;
        const rebuild = async () => {
          await replace.call(registry, await listStored.call(registry));
        };
        if (typeof registry.enqueueOperation === 'function') await registry.enqueueOperation(rebuild);
        else await rebuild();
        return true;
      },
      async invalidateProjection(sessionId) {
        const file = join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
        await rm(file, { force: true }).catch((error) => {
          log('warn', '清理投影缓存失败（不影响迁移）：' + String(error && error.message));
        });
      },
      log,
    };
  }

  // ---- 未完成迁移的恢复 ----------------------------------------------------

  let recovery = null;

  /** 单飞地补完未完成的迁移。启动时调用一次，之后每次桥接调用都会再兜一次。 */
  function kickRecovery() {
    if (recovery !== null) return recovery;
    recovery = (async () => {
      try {
        const results = await recoverPendingMoves(buildHost(), store);
        for (const result of results) {
          log(result.status === 'failed' || result.status === 'lost' ? 'warn' : 'info',
            '恢复未完成的迁移 ' + result.opId + '：' + result.status
            + (result.message !== undefined ? '（' + result.message + '）' : '')
            + (result.to !== undefined ? ' -> ' + result.to : ''));
        }
        return results;
      } catch (error) {
        log('warn', '恢复未完成的迁移失败：' + String(error && error.message));
        return [];
      } finally {
        recovery = null;
      }
    })();
    return recovery;
  }

  // 启动后跑一次（不阻塞启动）。
  setTimeout(() => { void kickRecovery(); }, 0);

  // ---- HTTP 桥接 ----------------------------------------------------------

  /** 描述当前状态：可选带一个 sessionId，用来告诉界面「能不能搬、为什么不能」。 */
  async function describe(body) {
    const registry = ctx.workspaceRegistry;
    const workspaces = registry.list().map((entity) => ({ id: entity.id, title: entity.title, path: entity.path }));
    const payload = {
      ok: true,
      version: PLUGIN_VERSION,
      prefix,
      home,
      releaseLive,
      workspaces,
      session: null,
    };
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    if (sessionId.length === 0) return payload;

    const host = buildHost();
    let snapshot;
    try {
      snapshot = await ctx.sessionPersistence.stat(sessionId);
    } catch (error) {
      payload.session = { id: sessionId, unreadable: true, message: String(error && error.message) };
      return payload;
    }
    if (snapshot === undefined) {
      payload.session = { id: sessionId, missing: true };
      return payload;
    }
    const cwd = snapshot.header.cwd;
    let canonical;
    if (typeof cwd === 'string' && cwd.length > 0) {
      try {
        canonical = await realpath(cwd);
      } catch {
        canonical = undefined;
      }
    }
    const current = canonical === undefined
      ? undefined
      : workspaces.find((workspace) => samePath(workspace.path, canonical));
    const activity = await host.listActivity(sessionId);
    const live = host.isSessionLive(sessionId);
    // 就地接管可用时，连「正在跑活」都能搬（换掉 live 写句柄的 header，turn 不断）。
    const handoffAvailable = live && moveLive && typeof host.handoffLive === 'function';
    const reason = canonical === undefined
      ? '这个对话记录的目录已不存在，无法安全迁移'
      : (activity.length > 0 && !handoffAvailable
        ? '这个对话还有正在运行的工作，请先停止'
        : (live && !handoffAvailable && !releaseLive
          ? '这个对话正打开着，而 releaseLive=false 禁止自动释放它；请重启 DSH 后再移动'
          : null));
    payload.session = {
      id: sessionId,
      cwd: cwd ?? null,
      canonicalCwd: canonical ?? null,
      currentWorkspaceId: current === undefined ? null : current.id,
      live,
      willHandoff: handoffAvailable && reason === null,
      willRelease: live && !handoffAvailable && reason === null,
      activity,
      activityText: host.describeActivity(activity),
      canMove: reason === null,
      reason,
    };
    payload.workspaces = workspaces.map((workspace) => ({
      ...workspace,
      current: workspace.id === payload.session.currentWorkspaceId,
    }));
    return payload;
  }

  /** 执行一次迁移。 */
  async function move(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (sessionId.length === 0) return { ok: false, code: 'bad-request', message: '缺少 sessionId' };
    const targetWorkspaceId = typeof body.targetWorkspaceId === 'string' ? body.targetWorkspaceId : '';
    const targetPath = typeof body.targetPath === 'string' ? body.targetPath.trim() : '';
    try {
      const receipt = await relocateSession(buildHost(), store, {
        sessionId,
        targetWorkspaceId,
        targetPath,
        releaseLive,
        moveLive,
        // 批量搬移时客户端逐条 defer：文件事务各自做完，注册表最后一次性写。
        deferRegistry: body.deferRegistry === true,
      });
      return { ok: true, ...receipt };
    } catch (error) {
      log('warn', '迁移失败：' + String(error && error.message));
      return failure(error);
    }
  }

  /** 批量收尾：把一串 defer 过的迁移的归属一次性写进注册表。 */
  async function moveCommit(body) {
    const ids = Array.isArray(body.sessionIds)
      ? body.sessionIds.filter((entry) => typeof entry === 'string' && entry.length > 0)
      : [];
    if (ids.length === 0) return { ok: false, code: 'bad-request', message: '缺少 sessionIds' };
    try {
      const result = await commitMoves(buildHost(), store, ids);
      return { ok: result.ok !== false, ...result };
    } catch (error) {
      log('warn', '批量结算失败：' + String(error && error.message));
      return failure(error);
    }
  }

  /** 报告还有哪些迁移没收尾。 */
  async function status() {
    await kickRecovery();
    const journals = await store.readJournals();
    return {
      ok: true,
      version: PLUGIN_VERSION,
      prefix,
      home,
      releaseLive,
      moveLive,
      dragMove,
      selftest,
      // 批量搬移的两段式（defer 文件事务 + 一次 commit 写注册表）由客户端按这个能力位决定是否启用。
      bulkDefer: true,
      verify: settings.verify === 'full' ? 'full' : 'auto',
      sessionsRoot: store.sessionsRoot,
      journalsDir: store.journalsDir,
      pending: journals.map((journal) => ({
        opId: journal.opId,
        sessionId: journal.sessionId,
        from: journal.fromCwd,
        to: journal.toCwd,
        phase: journal.phase,
        startedAt: journal.startedAt,
      })),
    };
  }

  // ---- 自测辅助（默认关闭，config.selftest=true 才挂路由）------------------------
  // 用来在**真实进程**里造一个「已打开（live）且持有写租约」的会话，验证「释放后再搬」，
  // 而不必碰任何真实对话。

  /** 造一个 live 会话；lease=true 时同时持有写租约（等价于被 DSH 打开）。 */
  async function selftestCreateLive(body) {
    const sessions = ctx.get('sessions');
    if (sessions === undefined || typeof sessions.create !== 'function') {
      return { ok: false, code: 'no-sessions', message: '这个组合没有 sessions 服务' };
    }
    const workspacePath = typeof body.workspacePath === 'string' && body.workspacePath.trim().length > 0
      ? body.workspacePath.trim()
      : join(home, 'session-move-selftest');
    await mkdir(workspacePath, { recursive: true });
    const workspace = await ctx.workspaceRegistry.create(workspacePath);
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
      ? body.sessionId.trim()
      : 'session-' + randomBytes(4).toString('hex') + '-0000-4000-8000-' + randomBytes(6).toString('hex');
    // 按 agent-loop 的真实顺序：先取得持久化写所有权（= 物化日志 + 持有 session.lock
    // 租约），再把它发布成 live 会话。这样自测出来的状态与「DSH 真的打开了这个会话」一致。
    let leaseHeld = false;
    let leaseError = null;
    if (body.lease !== false) {
      try {
        selftestLeases.set(sessionId, await ctx.sessionPersistence.create({
          version: 4,
          id: sessionId,
          createdAt: Date.now(),
          cwd: workspace.path,
          isSeeded: false,
          delegationDepth: 0,
          agentPreset: 'standard',
        }));
        leaseHeld = true;
      } catch (error) {
        leaseError = String(error && error.message !== undefined ? error.message : error);
      }
    }
    const session = sessions.create(sessionId, { meta: { cwd: workspace.path } });
    if (typeof sessions.flush === 'function') await sessions.flush(session);
    await workspace.attachSession(sessionId);

    // pressure=true：起一个循环，持续往这个会话的**写链**上排队 —— 等价于「正在跑的
    // turn 不断产生写入」。搬迁期间如果有任何一次插进来，就会被自测断言抓到。
    let pressure = false;
    if (body.pressure === true && leaseHeld) {
      const handle = selftestLeases.get(sessionId);
      selftestPressure.sessionId = sessionId;
      selftestPressure.marks = [];
      if (selftestPressure.timer !== null) clearInterval(selftestPressure.timer);
      selftestPressure.timer = setInterval(() => {
        try {
          void Promise.resolve(handle.enqueueChain(async () => {
            selftestPressure.marks.push(Date.now());
          })).catch(() => {});
        } catch {
          // 句柄关了就算了
        }
      }, 4);
      pressure = true;
    }

    return {
      ok: true,
      sessionId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      live: sessions.get(sessionId) !== undefined,
      leaseHeld,
      leaseError,
      pressure,
    };
  }

  /** 自测观察窗：压力循环记录的时间戳 + 每次就地接管的窗口。 */
  async function selftestState() {
    const handle = selftestPressure.sessionId !== null ? selftestLeases.get(selftestPressure.sessionId) : undefined;
    return {
      ok: true,
      pressure: {
        sessionId: selftestPressure.sessionId,
        running: selftestPressure.timer !== null,
        marks: selftestPressure.marks,
      },
      handoffs: handoffLog,
      writer: handle === undefined ? null : {
        headerCwd: handle.header !== undefined ? handle.header.cwd : null,
        leaseHeld: handle.lease !== undefined && handle.lease !== null,
      },
    };
  }

  /**
   * 强制自测句柄重新获取内核锁 —— 用来**证明**它现在把路径算到新目录去了。
   *
   * 注意：写锁在 Windows 上是**由路径派生的命名内核信号量**（没有锁文件）；
   * 只在 POSIX 上才有一个 <sessionDir>/session.lock。所以这里的判据是
   * sessionDir/headerCwd，而不是文件是否存在。
   */
  async function selftestEnsureLease() {
    const id = selftestPressure.sessionId;
    const handle = id !== null ? selftestLeases.get(id) : undefined;
    if (handle === undefined) return { ok: false, code: 'no-handle', message: '没有可用的自测句柄' };
    await handle.ensureLease();
    const dir = sessionDirFor(id, handle.header.cwd);
    return {
      ok: true,
      headerCwd: handle.header.cwd,
      sessionDir: dir,
      platform: process.platform,
      // 只有 POSIX 才有锁文件；Windows 是路径派生的命名信号量。
      lockFile: process.platform === 'win32' ? null : join(dir, 'session.lock'),
      lockFileExists: process.platform === 'win32' ? null : existsSync(join(dir, 'session.lock')),
      leaseHeld: handle.lease !== undefined && handle.lease !== null,
    };
  }

  /** 停掉压力循环（清理用）。 */
  async function selftestStopPressure() {
    if (selftestPressure.timer !== null) {
      clearInterval(selftestPressure.timer);
      selftestPressure.timer = null;
    }
    return { ok: true, stopped: true };
  }

  /** 清掉自测造出来的会话：释放 + 摘归属 + 删目录 + 清投影缓存。 */
  async function selftestDrop(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (sessionId.length === 0) return { ok: false, code: 'bad-request', message: '需要 sessionId' };
    const host = buildHost();
    const release = await host.releaseSession(sessionId).catch((error) => ({
      released: false,
      detail: String(error && error.message),
    }));
    for (const entity of ctx.workspaceRegistry.list()) {
      if (Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId)) {
        await entity.detachSession(sessionId).catch(() => {});
      }
    }
    const enc = encodeSegment(sessionId);
    const removed = [];
    const root = store.sessionsRoot;
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(root, project.name, enc);
      if (!existsSync(dir)) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    await host.invalidateProjection(sessionId);
    selftestLeases.delete(sessionId);
    const deletedWorkspaces = [];
    const paths = Array.isArray(body.deleteWorkspacePaths) ? body.deleteWorkspacePaths : [];
    for (const entity of ctx.workspaceRegistry.list()) {
      if (!paths.some((path) => samePath(entity.path, path))) continue;
      await ctx.workspaceRegistry.delete(entity.id).catch(() => {});
      deletedWorkspaces.push(entity.path);
    }
    return { ok: true, sessionId, release, removed, deletedWorkspaces };
  }

  function route(path, methods, handler) {
    return {
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const method = String(req.method ?? 'GET').toUpperCase();
        if (!methods.includes(method)) {
          writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: '只接受 ' + methods.join('/') });
          return;
        }
        try {
          const body = method === 'POST' ? await readJsonBody(req) : {};
          writeJson(res, 200, await handler(body));
        } catch (error) {
          writeJson(res, 400, failure(error instanceof Error ? error : new Error(String(error))));
        }
      },
    };
  }

  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const routes = [
        route(prefix + '/describe', ['POST'], describe),
        route(prefix + '/move', ['POST'], move),
      route(prefix + '/move-commit', ['POST'], moveCommit),
        route(prefix + '/status', ['GET', 'POST'], status),
      ];
      if (selftest) {
        routes.push(route(prefix + '/__selftest/create-live', ['POST'], selftestCreateLive));
        routes.push(route(prefix + '/__selftest/drop', ['POST'], selftestDrop));
        routes.push(route(prefix + '/__selftest/state', ['GET', 'POST'], selftestState));
        routes.push(route(prefix + '/__selftest/ensure-lease', ['POST'], selftestEnsureLease));
        routes.push(route(prefix + '/__selftest/stop-pressure', ['POST'], selftestStopPressure));
      }
      const disposers = routes.map((entry) => sctx.webServer.register(entry));
      const offInject = sctx.on('webserver/index-inject', (table) => {
        table.push({ kind: 'global', name: BOOT_GLOBAL, value: { prefix, version: PLUGIN_VERSION, drag: dragMove } });
      });
      return () => {
        for (const dispose of disposers) dispose();
        offInject();
      };
    }, 'dsh-session-relocate: bridge');
  });

  log('info', '就绪：' + prefix + '（会话存储 ' + store.sessionsRoot + '，迁移日志 ' + store.journalsDir + '）');
}
