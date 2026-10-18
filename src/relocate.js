/**
 * 跨工作区迁移的**事务引擎**（纯文件系统部分，不依赖 DSH 运行时）。
 *
 * 为什么不是简单 rename：
 *   1. 会话目录名由 header 里的 cwd 推导，cwd 变了目录就必须跟着变，否则 DSH 的
 *      assertStoredIdentity 会把它判定成 "corrupt session log"。
 *   2. DSH 的 findLog(id) 一旦发现同一个 id 出现在两个项目目录里就直接抛错，
 *      这个会话会**永久打不开**。所以绝不能出现「复制过去但没删源」的中间态。
 *
 * 因此采用「暂存区 + 原子改名」：
 *
 *   <sessionsRoot>/_session-move-staging/<opId>/<encodedId>/   ← 暂存区
 *
 * 暂存区比 DSH 的会话目录**深一层**，所以后端的扫描器（只认
 * <projectDir>/<encodedId>/ 目录下的规范 generation 文件名）永远看不到它。
 *
 *   校验 → 写日志(staging) → 复制到暂存区 → 在暂存区改 header → 自校验
 *        → 写日志(staged) → mkdir 目标项目目录 → 原子 rename 到目标
 *        → 写日志(moved) → 删源目录 → 写日志(src-removed)
 *        → 注册表 attach/detach → 失效投影缓存 → 删日志
 *
 * 崩溃安全性：改名之前的任何失败都能整体回滚（源目录一个字节都没动过）；
 * 改名之后只剩「删源目录」这一步，由 recoverPendingMoves() 幂等推完。
 *
 * @module dsh-session-relocate/relocate
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { encodeSegment, isCanonicalGenerationName } from './paths.js';
import { isZstdArtifact, readFirstLine, replaceFirstLine, scanZstdFrames } from './zstd.js';

/** 暂存区目录名（在会话存储根目录下，靠「深一层」对后端不可见）。 */
export const STAGING_DIR_NAME = '_session-move-staging';

/** 迁移日志格式版本。 */
export const JOURNAL_VERSION = 1;

/** 迁移失败的类型化错误：code 供桥接层转成机器可读的失败原因。 */
export class MoveError extends Error {
  /**
   * @param code - 机器可读错误码。
   * @param message - 面向用户的中文说明。
   * @param details - 附加信息（如仍在运行的活动）。
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'MoveError';
    this.code = code;
    this.details = details;
  }
}

/** 平台相关的路径比较（Windows 大小写不敏感）。 */
export function samePath(left, right) {
  if (left === right) return true;
  return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase();
}

/** 原子写：先写临时文件再改名，避免读者看到半个文件。 */
async function atomicWrite(path, buffer) {
  const tmp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
  await writeFile(tmp, buffer);
  await rename(tmp, path);
}

/**
 * 建立迁移引擎。
 *
 * @param options - 引擎配置。
 * @param options.sessionsRoot - 会话存储根目录（DSH 的 persistence root）。
 * @param options.journalsDir - 迁移日志目录（放 DSH home 下，与存储根同一盘无所谓）。
 * @param options.sessionDirFor - (sessionId, cwd) => 该会话目录的绝对路径。优先由
 *   后端自己的 locate() 提供；缺失时回退到本包的 projectKey 移植实现。
 * @param options.log - 可选 (level, message) 日志函数。
 * @returns 事务引擎。
 */
export function createMoveStore(options) {
  const sessionsRoot = options.sessionsRoot;
  const journalsDir = options.journalsDir;
  const sessionDirFor = options.sessionDirFor;
  const log = options.log ?? (() => {});
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) {
    throw new Error('createMoveStore requires a sessionsRoot');
  }
  if (typeof journalsDir !== 'string' || journalsDir.length === 0) {
    throw new Error('createMoveStore requires a journalsDir');
  }
  if (typeof sessionDirFor !== 'function') {
    throw new Error('createMoveStore requires a sessionDirFor(sessionId, cwd) function');
  }
  const stagingRoot = join(sessionsRoot, STAGING_DIR_NAME);
  /** 校验强度：'auto'（小日志全文解码、大日志帧级抽样）或 'full'（永远全文解码）。 */
  const verifyMode = options.verify === 'full' ? 'full' : 'auto';
  /** 超过这个大小（压缩后字节数）就走抽样校验。 */
  const fullVerifyLimit = Number.isSafeInteger(options.fullVerifyLimit) && options.fullVerifyLimit > 0
    ? options.fullVerifyLimit
    : 2 * 1024 * 1024;

  /**
   * 校验「改写后的日志」与「源日志」等价：除首行（header 的 cwd）外一切不变。
   *
   * 两种强度：
   *   - full：逐帧解码 → 顺带证明每个完整帧都能解压、校验和对（小日志默认走这条）；
   *   - sampled：帧级字节比对 + 解头 + 解尾 → 大日志走这条，调用方必须在回执里标明。
   *
   * @returns 'full' | 'sampled'
   */
  function verifyRewrite(source, patched) {
    if (!isZstdArtifact(source)) {
      // 明文日志：第一个换行之后的字节必须完全一致（等价于逐行比对，但没有解码成本）。
      const nlSource = source.indexOf(10);
      const nlPatched = patched.indexOf(10);
      if (nlSource < 0 || nlPatched < 0) throw new MoveError('corrupt-log', '日志里找不到完整的一行');
      if (source.subarray(nlSource).compare(patched.subarray(nlPatched)) !== 0) {
        throw new MoveError('patch-differs', '改写后首行以外的内容与源不一致');
      }
      return 'full';
    }
    const before = scanZstdFrames(source);
    const after = scanZstdFrames(patched);
    if (before.frames.length !== after.frames.length) {
      throw new MoveError('patch-lost-frames', '改写后帧数变了（' + String(before.frames.length) + ' -> ' + String(after.frames.length) + '）');
    }
    if (before.frames.length === 0) throw new MoveError('corrupt-log', '日志里没有完整帧');
    // 第一帧：解出来，除 cwd 外必须完全一样，且首行必须真的变了。
    const firstBefore = zstdDecompressSync(source.subarray(before.frames[0].start, before.frames[0].end));
    const firstAfter = zstdDecompressSync(patched.subarray(after.frames[0].start, after.frames[0].end));
    const nlBefore = firstBefore.indexOf(10);
    const nlAfter = firstAfter.indexOf(10);
    if (nlBefore < 0 || nlAfter < 0) throw new MoveError('corrupt-log', '第一帧里没有完整的 header 行');
    const lineBefore = firstBefore.subarray(0, nlBefore).toString('utf8');
    const lineAfter = firstAfter.subarray(0, nlAfter).toString('utf8');
    if (lineBefore === lineAfter) throw new MoveError('patch-noop', '改写后 header 没有变化');
    let headerBefore;
    let headerAfter;
    try {
      headerBefore = JSON.parse(lineBefore);
      headerAfter = JSON.parse(lineAfter);
    } catch {
      throw new MoveError('corrupt-log', 'header 行不是合法 JSON');
    }
    const left = { ...headerBefore };
    const right = { ...headerAfter };
    delete left.cwd;
    delete right.cwd;
    if (JSON.stringify(left) !== JSON.stringify(right)) throw new MoveError('patch-differs', 'header 除 cwd 之外还变了');
    if (firstBefore.subarray(nlBefore).compare(firstAfter.subarray(nlAfter)) !== 0) {
      throw new MoveError('patch-differs', '第一帧首行之后的内容变了');
    }
    // 其余帧：逐字节相同（我们根本没有重写它们）。
    for (let i = 1; i < before.frames.length; i += 1) {
      const fa = source.subarray(before.frames[i].start, before.frames[i].end);
      const fb = patched.subarray(after.frames[i].start, after.frames[i].end);
      if (fa.length !== fb.length || fa.compare(fb) !== 0) {
        throw new MoveError('patch-differs', '第 ' + String(i + 1) + ' 帧被改动了');
      }
    }
    // 尾部未写完的字节也必须原样保留。
    const tailBefore = source.subarray(before.frames[before.frames.length - 1].end);
    const tailAfter = patched.subarray(after.frames[after.frames.length - 1].end);
    if (tailBefore.length !== tailAfter.length || tailBefore.compare(tailAfter) !== 0) {
      throw new MoveError('patch-differs', '尾部未完成的字节变了');
    }
    if (verifyMode !== 'full' && source.length > fullVerifyLimit) {
      // 抽样：只解最后一帧 —— 追加写崩溃留下的损坏几乎都在尾巴上。
      const last = after.frames.length - 1;
      zstdDecompressSync(patched.subarray(after.frames[last].start, after.frames[last].end));
      return 'sampled';
    }
    // 全量：每一帧都解一遍，坏帧（校验和/位流损坏）会当场抛错。
    for (const frame of before.frames) zstdDecompressSync(source.subarray(frame.start, frame.end));
    return 'full';
  }

  /**
   * 算出一次迁移涉及的全部路径。
   *
   * @param sessionId - 会话 id。
   * @param fromCwd - 源 cwd（规范化的）。
   * @param toCwd - 目标 cwd（规范化的，即工作区 path）。
   * @param opId - 本次迁移的 id。
   */
  function layout(sessionId, fromCwd, toCwd, opId) {
    const encId = encodeSegment(sessionId);
    const dstDir = sessionDirFor(sessionId, toCwd);
    return {
      opId,
      encId,
      srcDir: sessionDirFor(sessionId, fromCwd),
      dstProjectDir: dirname(dstDir),
      dstDir,
      stagingDir: join(stagingRoot, opId, encId),
      stagingOpDir: join(stagingRoot, opId),
    };
  }

  /** 列出目录里全部规范 generation 文件（忽略 .tmp/.bak/session.lock 等）。 */
  async function listGenerationNames(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isCanonicalGenerationName(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  async function writeJournal(entry) {
    await mkdir(journalsDir, { recursive: true });
    await atomicWrite(join(journalsDir, entry.opId + '.json'), Buffer.from(JSON.stringify(entry, null, 2), 'utf8'));
  }

  async function removeJournal(opId) {
    await rm(join(journalsDir, opId + '.json'), { force: true });
  }

  async function readJournals() {
    if (!existsSync(journalsDir)) return [];
    const entries = await readdir(journalsDir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(journalsDir, entry.name), 'utf8'));
        if (parsed !== null && typeof parsed === 'object' && parsed.version === JOURNAL_VERSION && typeof parsed.opId === 'string') {
          out.push(parsed);
        }
      } catch (error) {
        log('warn', '无法解析迁移日志 ' + entry.name + '：' + String(error && error.message));
      }
    }
    return out;
  }

  /**
   * 把 srcDir 复制到暂存区，然后在暂存区把每个 generation 的 header cwd 改成
   * toCwd，并逐字节自校验（除首行外明文必须完全一致）。
   *
   * 源目录在这一步只读，不会被改。
   *
   * @param plan - layout() 的产物。
   * @param sessionId - 会话 id。
   * @param toCwd - 目标 cwd。
   * @returns 处理过的 generation 文件名。
   */
  async function stageAndPatch(plan, sessionId, toCwd) {
    await mkdir(plan.stagingOpDir, { recursive: true });
    await cp(plan.srcDir, plan.stagingDir, { recursive: true, errorOnExist: true, force: false });

    const names = await listGenerationNames(plan.stagingDir);
    if (names.length === 0) {
      throw new MoveError('no-generation', '会话目录里没有可识别的日志文件：' + plan.srcDir);
    }
    const modes = [];
    for (const name of names) {
      const stagedPath = join(plan.stagingDir, name);
      const staged = await readFile(stagedPath);
      const line = readFirstLine(staged);
      let header;
      try {
        header = JSON.parse(line);
      } catch {
        throw new MoveError('corrupt-log', '会话日志 ' + name + ' 的首行不是合法 JSON，拒绝改写');
      }
      if (header === null || typeof header !== 'object' || header.type !== 'session') {
        throw new MoveError('foreign-log', '会话日志 ' + name + ' 的首行不是 session header，拒绝改写');
      }
      if (header.id !== sessionId) {
        throw new MoveError('id-mismatch', '会话日志 ' + name + ' 的 header id 与目标不一致，拒绝改写');
      }
      const patched = replaceFirstLine(staged, JSON.stringify({ ...header, cwd: toCwd }));
      // 自校验：除首行外一切不变（小日志全文解码，大日志帧级比对，见 verifyRewrite）。
      modes.push(verifyRewrite(staged, patched));
      await atomicWrite(stagedPath, patched);
    }
    return { names, verification: modes.includes('sampled') ? 'sampled' : 'full' };
  }

  /** 校验一个目录里每个 generation 的 header id 与 cwd 都对。 */
  async function verifyPromoted(dir, sessionId, toCwd) {
    const names = await listGenerationNames(dir);
    if (names.length === 0) throw new MoveError('no-generation', '目标目录里没有可识别的日志文件：' + dir);
    for (const name of names) {
      let header;
      try {
        header = JSON.parse(readFirstLine(await readFile(join(dir, name))));
      } catch {
        throw new MoveError('corrupt-log', '目标日志 ' + name + ' 无法解析');
      }
      if (header.id !== sessionId) throw new MoveError('id-mismatch', '目标日志 ' + name + ' 的 id 不对');
      if (header.cwd !== toCwd) {
        throw new MoveError('cwd-mismatch', '目标日志 ' + name + ' 的 cwd 不是 ' + toCwd);
      }
    }
    return names;
  }

  /** 删掉某个 op 的暂存目录。 */
  async function dropStaging(opId) {
    await rm(join(stagingRoot, opId), { recursive: true, force: true });
  }

  /** 清扫没有对应迁移日志的暂存残留。 */
  async function sweepStaging(keepOpIds) {
    if (!existsSync(stagingRoot)) return 0;
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || keepOpIds.has(entry.name)) continue;
      await rm(join(stagingRoot, entry.name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  return {
    sessionsRoot,
    journalsDir,
    stagingRoot,
    layout,
    listGenerationNames,
    stageAndPatch,
    verifyPromoted,
    writeJournal,
    readJournals,
    removeJournal,
    dropStaging,
    sweepStaging,
  };
}

/** 生成一个不可猜的 opId（导出的工厂，便于测试注入）。 */
export function newOpId() {
  return Date.now().toString(36) + '-' + randomBytes(6).toString('hex');
}

/**
 * 执行一次跨工作区迁移。
 *
 * @param host - DSH 适配层（见 src/plugin.js 的 createHostAdapter）。
 * @param store - createMoveStore 的产物。
 * 一个「活着但空闲」的会话会被先释放（flush + detach + 写打开探针确认租约已释放），
 * 再走文件事务；只有**正在跑活**的会话才会被拒绝。
 *
 * @param request - { sessionId, targetWorkspaceId, targetPath, newOpId, releaseLive }。
 *   ``releaseLive`` 为 false 时恢复旧行为（打开中的会话直接拒绝）。
 * @returns 迁移回执。
 */
export async function relocateSession(host, store, request) {
  const sessionId = request.sessionId;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new MoveError('bad-request', '缺少 sessionId');
  }

  let snapshot;
  try {
    snapshot = await host.statSession(sessionId);
  } catch (error) {
    // 后端读取 header 时若发现日志损坏会直接抛错；包成类型化错误交给桥接层。
    throw new MoveError('session-unreadable', '读取这个对话的日志失败（可能已损坏），拒绝迁移：' + String(error && error.message));
  }
  if (snapshot === undefined) throw new MoveError('session-not-found', '找不到会话 ' + sessionId);
  const header = snapshot.header;
  if (typeof header.cwd !== 'string' || header.cwd.length === 0) {
    throw new MoveError('no-cwd', '这个对话没有记录工作目录，无法迁移；这类会话只能在原处查看。');
  }

  let target;
  if (typeof request.targetWorkspaceId === 'string' && request.targetWorkspaceId.length > 0) {
    target = host.getWorkspace(request.targetWorkspaceId);
    if (target === undefined) throw new MoveError('workspace-not-found', '找不到目标工作区 ' + request.targetWorkspaceId);
  } else if (typeof request.targetPath === 'string' && request.targetPath.length > 0) {
    target = await host.createWorkspace(request.targetPath);
  } else {
    throw new MoveError('no-target', '没有指定目标工作区');
  }

  let sourceCanonical;
  try {
    sourceCanonical = await realpath(header.cwd);
  } catch {
    throw new MoveError('source-cwd-unresolved', '这个对话记录的目录已不存在：' + header.cwd + '，无法安全迁移。');
  }
  if (samePath(sourceCanonical, target.path)) {
    throw new MoveError('already-there', '这个对话已经在「' + target.title + '」里了。');
  }

  // 三种情况：
  //   a) 没打开的会话        —— 直接搬；
  //   b) 打开着、但没在跑活   —— 先把它从内存里释放，再搬（release 路径）；
  //   c) 打开着、还在跑活     —— **就地接管**：换掉 live 写句柄的 header，
  //                            并在持有该句柄写链的情况下搬文件（handoff 路径）。
  //                            c 需要 host.handoffLive 可用；不可用就退回「拒绝」。
  const activity = await host.listActivity(sessionId);
  const live = host.isSessionLive(sessionId);
  // 只有**确实能找到 live 写句柄**时才谈得上接管；找不到就退回释放路径（或拒绝）。
  const useHandoff = live
    && request.moveLive !== false
    && typeof host.handoffLive === 'function'
    && typeof host.canHandoff === 'function'
    && host.canHandoff(sessionId) === true;

  if (activity.length > 0 && !useHandoff) {
    throw new MoveError(
      'session-active',
      '这个对话还有正在运行的工作（' + host.describeActivity(activity) + '），请先停止再移动。',
      activity,
    );
  }
  if (live && !useHandoff && request.releaseLive === false) {
    throw new MoveError(
      'session-live',
      '这个对话当前正打开着，而 releaseLive=false 禁止自动释放它。请重启 DSH 后再移动，或把 releaseLive 打开。',
    );
  }

  const source = host.findWorkspaceByPath(sourceCanonical);
  const opId = (request.newOpId ?? newOpId)();
  const plan = store.layout(sessionId, sourceCanonical, target.path, opId);

  if (!existsSync(plan.srcDir)) throw new MoveError('source-dir-missing', '找不到这个会话的存储目录：' + plan.srcDir);
  if (existsSync(plan.dstDir)) {
    throw new MoveError('target-dir-exists', '目标位置已存在同名会话目录，请先手工清理：' + plan.dstDir);
  }

  // release 路径：所有校验都过了才动状态，释放失败就整体放弃、绝不碰文件。
  let released = false;
  let releaseAttempts = 0;
  if (live && !useHandoff) {
    const outcome = await host.releaseSession(sessionId).catch((error) => ({
      released: false,
      detail: String(error && error.message !== undefined ? error.message : error),
    }));
    if (outcome === undefined || outcome.released !== true) {
      throw new MoveError(
        'release-failed',
        '无法释放这个对话的写所有权，已放弃（没有改动任何文件）：' + String(outcome !== undefined ? outcome.detail : '无返回'),
      );
    }
    released = true;
    releaseAttempts = Number.isSafeInteger(outcome.attempts) ? outcome.attempts : 0;
    host.log('info', '已释放会话 ' + sessionId + ' 的写所有权：' + String(outcome.detail));
    if (!existsSync(plan.srcDir)) {
      throw new MoveError('source-dir-missing', '释放之后找不到这个会话的存储目录：' + plan.srcDir);
    }
  }

  const journal = {
    version: JOURNAL_VERSION,
    opId,
    sessionId,
    fromCwd: sourceCanonical,
    toCwd: target.path,
    srcDir: plan.srcDir,
    dstDir: plan.dstDir,
    phase: 'staging',
    startedAt: new Date().toISOString(),
  };

  // 复制与改写全部发生在暂存区；源目录此时一个字节都没动。
  await store.writeJournal(journal);

  /** 文件事务本体：暂存 → 改写 header → 自校验 → 原子改名 → 删源。 */
  const performFileTransaction = async () => {
    let promoted = false;
    try {
      // 只写一次日志（下面不再逐相位重写）：recoverOne 完全按「源在不在、目标在不在」
      // 推导该补哪一步，相位字段对恢复没有作用，逐相位 atomicWrite 是纯开销。
      const staged = await store.stageAndPatch(plan, sessionId, target.path);
      const verification = staged !== null && staged !== undefined && typeof staged === 'object' && typeof staged.verification === 'string'
        ? staged.verification
        : 'full';
      await store.verifyPromoted(plan.stagingDir, sessionId, target.path);
      await mkdir(plan.dstProjectDir, { recursive: true });
      await rename(plan.stagingDir, plan.dstDir);
      promoted = true;
      await rm(plan.srcDir, { recursive: true, force: true });
      return { ok: true, verification };
    } catch (error) {
      if (!promoted) {
        // 源目录完好，整体回滚。
        await store.dropStaging(opId).catch(() => {});
        await store.removeJournal(opId).catch(() => {});
        host.log('warn', '迁移 ' + opId + ' 回滚：' + String(error && error.message));
        throw error instanceof MoveError
          ? error
          : new MoveError('stage-failed', '迁移失败，已回滚（源对话未受影响）：' + String(error && error.message));
      }
      // 目标已就位；只剩删源这一步。这一步没做完就绝不能去写注册表，
      // 否则会出现「同 id 双目录」，DSH 会拒绝打开这个会话。
      await rm(plan.srcDir, { recursive: true, force: true }).catch((rmError) => {
        host.log('warn', '迁移 ' + opId + ' 删除源目录失败：' + String(rmError && rmError.message));
      });
      if (existsSync(plan.srcDir)) {
        host.log('warn', '迁移 ' + opId + ' 目标已就位但源目录仍在，保留日志待恢复');
        return { ok: true, pending: true, pendingReason: '源目录尚未删除完成，需要重试' };
      }
      host.log('warn', '迁移 ' + opId + ' 在收尾阶段出错，继续补齐注册表：' + String(error && error.message));
      return { ok: true };
    }
  };

  let outcome;
  let handedOff = false;
  if (useHandoff) {
    // 就地接管：换掉 live 写句柄的 header，并在**持有该句柄写链**的情况下跑文件事务，
    // 这样搬迁期间任何写入都排在我们后面，落地时已经是新路径。
    const result = await host.handoffLive(sessionId, target.path, performFileTransaction);
    if (result === undefined || result.ok !== true) {
      throw new MoveError(
        'handoff-failed',
        '无法就地接管这个正在运行的对话，已放弃（没有改动任何文件）：' + String(result !== undefined ? result.detail : '无返回'),
      );
    }
    handedOff = true;
    outcome = result.transaction !== undefined ? result.transaction : { ok: true };
    host.log('info', '已就地接管会话 ' + sessionId + '：' + String(result.detail));
  } else {
    outcome = await performFileTransaction();
  }

  if (outcome.pending === true) {
    return {
      ok: true,
      opId,
      sessionId,
      from: sourceCanonical,
      to: target.path,
      targetWorkspaceId: target.id,
      targetTitle: target.title,
      movedTo: plan.dstDir,
      applied: 'pending',
      released,
      handedOff,
      pendingReason: outcome.pendingReason,
    };
  }

  // 批量搬移用：文件事务做完就返回，注册表留给 commitMoves 一次性写。
  // 这样 N 条会话只付 2 次注册表写，而不是 2N 次。日志故意不删 —— 它既是
  // commit 的输入，也是"commit 之前崩掉"时恢复的依据（recoverOne 按文件状态幂等补完）。
  if (request.deferRegistry === true) {
    return {
      ok: true,
      deferred: true,
      opId,
      sessionId,
      from: sourceCanonical,
      to: target.path,
      targetWorkspaceId: target.id,
      targetTitle: target.title,
      movedTo: plan.dstDir,
      released,
      releaseAttempts,
      handedOff,
      verification: outcome.verification !== undefined ? outcome.verification : 'full',
    };
  }

  return await finishAndReport(host, store, {
    opId,
    sessionId,
    sourceCanonical,
    target,
    source,
    dstDir: plan.dstDir,
    released,
    releaseAttempts,
    handedOff,
    verification: outcome.verification !== undefined ? outcome.verification : 'full',
    handoffWriter: outcome.writerRetargeted === true,
  });
}

/** 写注册表并产出最终回执（磁盘部分已经完成）。 */
async function finishAndReport(host, store, ctx) {
  // 就地接管（会话还活着）时不能走 attachSession —— live Session 的 header 是
  // deep-frozen 的旧 cwd，注册表的 cwd 校验一定过不了。所以走 host.adoptSession
  // 这条旁路（它直接改注册表的归属表与路径索引）。
  // 三条路径，优先级从快到慢：
  //   1. 就地接管：走 adoptSession（live header 冻结，只能旁路写）；
  //   2. 冷搬移：走 adoptSessions + detachSessions（定向写索引 + 每边一次 mutate，
  //      **不**重建全量 header 索引 —— 那一步在大库上是白花的）；
  //   3. 主机没给批量原语（老版本）：退回官方的 refresh + attach + detach。
  let registry;
  if (ctx.handedOff === true && typeof host.adoptSession === 'function') {
    registry = await host.adoptSession(ctx.sessionId, ctx.target, ctx.source, ctx.target.path);
  } else if (typeof host.adoptSessions === 'function' && typeof host.detachSessions === 'function') {
    registry = await adoptCold(host, ctx.sessionId, ctx.target, ctx.source);
  } else {
    registry = await finalizeRegistry(host, ctx.sessionId, ctx.target, ctx.source);
  }
  if (registry.applied) {
    await store.removeJournal(ctx.opId).catch(() => {});
    await store.dropStaging(ctx.opId).catch(() => {});
    await host.invalidateProjection(ctx.sessionId);
    return {
      ok: true,
      opId: ctx.opId,
      sessionId: ctx.sessionId,
      from: ctx.sourceCanonical,
      to: ctx.target.path,
      targetWorkspaceId: ctx.target.id,
      targetTitle: ctx.target.title,
      movedTo: ctx.dstDir,
      applied: 'live',
      released: ctx.released === true,
      releaseAttempts: Number.isSafeInteger(ctx.releaseAttempts) ? ctx.releaseAttempts : 0,
      handedOff: ctx.handedOff === true,
      handoffWriter: ctx.handoffWriter === true,
      headerIndexRefreshed: registry.refreshed === true,
      verification: ctx.verification !== undefined ? ctx.verification : 'full',
    };
  }
  // 磁盘已就位，但归属没写成：保留日志，下次桥接调用或下次启动自动补齐。
  host.log('warn', '迁移 ' + ctx.opId + ' 磁盘已完成，工作区归属待收尾：' + String(registry.reason));
  return {
    ok: true,
    opId: ctx.opId,
    sessionId: ctx.sessionId,
    from: ctx.sourceCanonical,
    to: ctx.target.path,
    targetWorkspaceId: ctx.target.id,
    targetTitle: ctx.target.title,
    movedTo: ctx.dstDir,
    applied: 'pending',
    released: ctx.released === true,
    handedOff: ctx.handedOff === true,
    verification: ctx.verification !== undefined ? ctx.verification : 'full',
    pendingReason: registry.reason,
  };
}

/**
 * 冷搬移的归属写入：定向更新本会话的 header 缓存/路径索引，然后目标、源各一次 mutate。
 * 和批量 commit 用的是同一组原语，只是这里只有一条。
 */
async function adoptCold(host, sessionId, target, source) {
  const adopted = await host.adoptSessions([sessionId], target, target.path);
  if (adopted === undefined || adopted === null || adopted.applied !== true) {
    return { applied: false, refreshed: false, reason: adopted !== null && adopted !== undefined && typeof adopted.reason === 'string' ? adopted.reason : '写入目标工作区归属失败' };
  }
  if (source !== undefined && source.id !== target.id) {
    const detached = await host.detachSessions([sessionId], source);
    if (detached !== undefined && detached !== null && detached.applied === false) {
      return { applied: false, refreshed: false, reason: typeof detached.reason === 'string' ? detached.reason : '从源工作区摘除失败' };
    }
  }
  return { applied: true, refreshed: false };
}

/**
 * 把工作区归属写进注册表：刷新 header 索引 → attach 到目标 → 从源 detach。
 *
 * 刷新索引是**必需**的：注册表的 header 缓存是启动时建的，不刷新的话它仍认为
 * 这个会话的 cwd 是旧路径，attach 会被它自己拒掉。
 *
 * @param host - DSH 适配层。
 * @param sessionId - 会话 id。
 * @param target - 目标工作区实体。
 * @param source - 源工作区实体（可能 undefined）。
 * @returns { applied, refreshed, reason }。
 */
export async function finalizeRegistry(host, sessionId, target, source) {
  let refreshed = false;
  try {
    refreshed = await host.refreshHeaderIndex();
  } catch (error) {
    return { applied: false, refreshed: false, reason: '刷新会话头索引失败：' + String(error && error.message) };
  }
  try {
    await target.attachSession(sessionId);
  } catch (error) {
    return { applied: false, refreshed, reason: '登记到目标工作区失败：' + String(error && error.message) };
  }
  if (source !== undefined && source.id !== target.id) {
    try {
      await source.detachSession(sessionId);
    } catch (error) {
      // attach 已成功，归属已经正确；detach 失败只留一条会被剪掉的冗余记录。
      host.log('warn', '从源工作区摘除失败（不影响归属正确性）：' + String(error && error.message));
    }
  }
  return { applied: true, refreshed };
}

/**
 * 启动/惰性恢复：把上次没做完的迁移推完。
 *
 * 不盲信日志里的 phase，而是按文件系统的实际状态决定 —— 这样「写完 phase 之前
 * 崩溃」也不会误判。
 *
 * @param host - DSH 适配层。
 * @param store - createMoveStore 的产物。
 * @returns 每条日志的处理结果。
 */
export async function recoverPendingMoves(host, store) {
  const journals = await store.readJournals();
  const results = [];
  for (const journal of journals) results.push(await recoverOne(host, store, journal));
  if (journals.length > 0) {
    await store.sweepStaging(new Set(journals.map((entry) => entry.opId))).catch(() => 0);
  }
  return results;
}

/** 把一个 id 归到 map[key] 的数组里。 */
function groupInto(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * 批量收尾：把 deferRegistry 留下的一摞迁移日志一次性结算。
 *
 * 做三件事：
 *   1. 逐条确认文件状态（源还在就删、目标没就位就重做），与 recoverOne 同一套幂等规则；
 *   2. 注册表只写「每个目标工作区一次 + 每个源工作区一次」，不再是每会话两次；
 *   3. 清日志、清暂存区、失效投影缓存。
 *
 * 注册表写失败时**故意保留日志**：recoverOne 会在下次桥接调用或下次启动时补完归属。
 *
 * @param host - DSH 适配层（需要 adoptSessions / detachSessions）。
 * @param store - 迁移引擎。
 * @param sessionIds - 只结算这些会话；缺省表示结算全部未完成日志。
 * @returns { ok, results, message? }。
 */
export async function commitMoves(host, store, sessionIds) {
  const wanted = Array.isArray(sessionIds) && sessionIds.length > 0 ? new Set(sessionIds) : null;
  const journals = (await store.readJournals()).filter((entry) => wanted === null || wanted.has(entry.sessionId));
  const results = [];
  const byTarget = new Map();
  const bySource = new Map();
  const settled = [];

  for (const journal of journals) {
    try {
      const srcExists = existsSync(journal.srcDir);
      const dstExists = existsSync(journal.dstDir);
      if (!srcExists && !dstExists) {
        await store.removeJournal(journal.opId).catch(() => {});
        results.push({ sessionId: journal.sessionId, status: 'lost', message: '源目录与目标目录都不存在' });
        continue;
      }
      if (!dstExists) {
        // 目标还没就位（多半是 commit 之前崩了）：照着日志重做一遍文件事务。
        const plan = store.layout(journal.sessionId, journal.fromCwd, journal.toCwd, journal.opId);
        plan.srcDir = journal.srcDir;
        plan.dstDir = journal.dstDir;
        await rm(plan.stagingOpDir, { recursive: true, force: true });
        await store.stageAndPatch(plan, journal.sessionId, journal.toCwd);
        await store.verifyPromoted(plan.stagingDir, journal.sessionId, journal.toCwd);
        await mkdir(plan.dstProjectDir, { recursive: true });
        await rename(plan.stagingDir, plan.dstDir);
      }
      if (existsSync(journal.srcDir)) await rm(journal.srcDir, { recursive: true, force: true });
      const target = host.findWorkspaceByPath(journal.toCwd);
      if (target === undefined) {
        results.push({ sessionId: journal.sessionId, status: 'pending-workspace', message: '目标工作区未找到：' + journal.toCwd });
        continue;
      }
      groupInto(byTarget, journal.toCwd, journal.sessionId);
      groupInto(bySource, journal.fromCwd, journal.sessionId);
      settled.push(journal);
      results.push({ sessionId: journal.sessionId, status: 'moved', to: journal.toCwd, targetWorkspaceId: target.id });
    } catch (error) {
      results.push({ sessionId: journal.sessionId, status: 'failed', message: String(error && error.message !== undefined ? error.message : error) });
    }
  }

  if (settled.length === 0) return { ok: true, results };

  try {
    for (const [toCwd, ids] of byTarget) {
      const target = host.findWorkspaceByPath(toCwd);
      const adopted = await host.adoptSessions(ids, target, toCwd);
      if (adopted !== undefined && adopted !== null && adopted.applied === false) {
        throw new MoveError('registry-failed', '写入目标工作区归属失败：' + String(adopted.reason));
      }
    }
    for (const [fromCwd, ids] of bySource) {
      const source = host.findWorkspaceByPath(fromCwd);
      if (source === undefined) continue;
      const detached = await host.detachSessions(ids, source);
      if (detached !== undefined && detached !== null && detached.applied === false) {
        throw new MoveError('registry-failed', '从源工作区摘除失败：' + String(detached.reason));
      }
    }
  } catch (error) {
    host.log('warn', '批量结算写注册表失败（文件已就位，日志保留待恢复）：' + String(error && error.message));
    return {
      ok: false,
      message: '文件已搬移，但工作区归属写入失败（下次桥接调用会自动补齐）：' + String(error && error.message),
      results: results.map((entry) => (entry.status === 'moved' ? { ...entry, status: 'failed', message: '归属待补齐' } : entry)),
    };
  }

  for (const journal of settled) {
    await store.removeJournal(journal.opId).catch(() => {});
    await store.dropStaging(journal.opId).catch(() => {});
  }
  for (const journal of settled) {
    await host.invalidateProjection(journal.sessionId);
  }
  return { ok: true, results };
}

async function recoverOne(host, store, journal) {
  const { opId, sessionId, toCwd, srcDir, dstDir } = journal;
  const srcExists = existsSync(srcDir);
  const dstExists = existsSync(dstDir);
  let movedNow = false;

  if (!srcExists && !dstExists) {
    await store.removeJournal(opId).catch(() => {});
    return { opId, sessionId, status: 'lost', message: '源目录与目标目录都不存在，无法恢复' };
  }

  try {
    if (!dstExists && srcExists) {
      // 目标还没就位：无论上次复制到哪一步，直接从头重做（幂等）。
      const plan = store.layout(sessionId, journal.fromCwd, toCwd, opId);
      plan.srcDir = srcDir;
      plan.dstDir = dstDir;
      await rm(plan.stagingOpDir, { recursive: true, force: true });
      await store.stageAndPatch(plan, sessionId, toCwd);
      await store.verifyPromoted(plan.stagingDir, sessionId, toCwd);
      await mkdir(plan.dstProjectDir, { recursive: true });
      await rename(plan.stagingDir, plan.dstDir);
      await rm(srcDir, { recursive: true, force: true });
      movedNow = true;
    } else if (dstExists && srcExists) {
      // 目标已就位、源还在：删源即可完成。
      await rm(srcDir, { recursive: true, force: true });
    } else {
      // 只剩目标：文件已经在位，只需要补注册表。
      await store.verifyPromoted(dstDir, sessionId, toCwd);
    }

    const target = host.findWorkspaceByPath(toCwd);
    if (target === undefined) {
      host.log('warn', '迁移 ' + opId + ' 文件已就位，但目标工作区 ' + toCwd + ' 未找到，保留日志待重试');
      return { opId, sessionId, status: 'pending-workspace', message: '目标工作区未找到：' + toCwd };
    }
    const source = host.findWorkspaceByPath(journal.fromCwd);
    const registry = await finalizeRegistry(host, sessionId, target, source);
    if (!registry.applied) {
      return { opId, sessionId, status: 'pending-registry', message: registry.reason };
    }
    await host.invalidateProjection(sessionId);
    await store.removeJournal(opId).catch(() => {});
    await store.dropStaging(opId).catch(() => {});
    return { opId, sessionId, status: movedNow ? 'completed-now' : 'completed', to: toCwd };
  } catch (error) {
    host.log('warn', '迁移 ' + opId + ' 恢复失败：' + String(error && error.message));
    return { opId, sessionId, status: 'failed', message: String(error && error.message) };
  }
}
