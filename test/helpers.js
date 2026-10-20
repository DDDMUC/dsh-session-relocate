/**
 * 测试夹具：一个临时的「类 DSH 存储」+ 一个像 DSH 一样严格的假注册表。
 *
 * 假 attachSession 会真的去磁盘读 header 并校验 cwd 等于工作区 path —— 这正是
 * DSH 的 Workspace.attachSession 行为，用来验证「必须先改 header 再 attach」。
 *
 * @module dsh-session-relocate/test/helpers
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { encodeSegment, isCanonicalGenerationName, projectDir } from '../src/paths.js';
import { readFirstLine, scanZstdFrames } from '../src/zstd.js';
import { createMoveStore } from '../src/relocate.js';

export const SESSION_ID = 'session-abc12345-0000-4000-8000-000000000001';
export const COMPRESS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };

export function headerLine(id, cwd, version, createdAt) {
  return JSON.stringify({ type: 'session', version, id, createdAt, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
}

/**
 * DSH 的真实约束（assertIndependentHeaderFrame）：第一个 Zstandard 帧必须**恰好**
 * 是 header 一行（唯一的换行在末尾）。夹具都过这一关，才不会造出现实里不存在的日志。
 */
export function assertDshHeaderFrame(buffer) {
  const scan = scanZstdFrames(buffer);
  if (scan.frames.length === 0) throw new Error('夹具缺少完整的 Zstandard 帧');
  const plain = zstdDecompressSync(buffer.subarray(scan.frames[0].start, scan.frames[0].end));
  if (plain.length === 0 || plain.indexOf(10) !== plain.length - 1) {
    throw new Error('夹具违反 DSH 约束：第一帧不是恰好一行 header');
  }
  return JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8'));
}

/** 造一个多帧 zstd 会话日志：第一帧只有 header，其余每批一帧。 */
export function makeLog(id, cwd, version, batches) {
  const frames = [zstdCompressSync(Buffer.from(headerLine(id, cwd, version, 1700000000000) + '\n', 'utf8'), COMPRESS)];
  for (const batch of batches) {
    frames.push(zstdCompressSync(Buffer.from(batch.join('\n') + '\n', 'utf8'), COMPRESS));
  }
  const buffer = Buffer.concat(frames);
  assertDshHeaderFrame(buffer);
  return buffer;
}

/** 造一个未压缩会话日志。 */
export function makePlainLog(id, cwd, version, batches) {
  return Buffer.from(headerLine(id, cwd, version, 1700000000000) + '\n' + batches.flat().join('\n') + '\n', 'utf8');
}

/** 目录里版本最高的那个规范 generation 文件（与后端的选择规则一致）。 */
export function headerFileIn(dir) {
  if (!existsSync(dir)) return undefined;
  const names = readdirSync(dir).filter(isCanonicalGenerationName).sort();
  const name = names[names.length - 1];
  return name === undefined ? undefined : join(dir, name);
}

/**
 * 造一个临时 DSH 存储。
 *
 * @param name - 夹具名（用作临时子目录）。
 * @param group - 分组目录名，避免并行测试文件互相清理。
 */
export function makeFixture(name, group = 'relocate') {
  const base = join(import.meta.dirname, '..', '.test-tmp', group, name);
  rmSync(base, { recursive: true, force: true });
  const sessionsRoot = join(base, 'sessions');
  const journalsDir = join(base, 'session-move');
  const srcWs = join(base, 'src-ws');
  const dstWs = join(base, 'dst-ws');
  const extraWs = join(base, 'extra-ws');
  for (const dir of [srcWs, dstWs, extraWs, sessionsRoot]) mkdirSync(dir, { recursive: true });

  const calls = [];
  const logs = [];
  const projections = [];
  const state = { live: false, activity: [], releaseFails: false };
  const encId = encodeSegment(SESSION_ID);
  const srcDir = join(projectDir(sessionsRoot, srcWs), encId);
  const dstDir = join(projectDir(sessionsRoot, dstWs), encId);

  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, 'session.jsonl.zstd'), makeLog(SESSION_ID, srcWs, 0, [
    ['{"seq":1,"kind":"user"}'],
    ['{"seq":2,"kind":"assistant"}', '{"seq":3,"kind":"tool"}'],
  ]));
  writeFileSync(join(srcDir, 'session.v4.jsonl.zstd'), makeLog(SESSION_ID, srcWs, 4, [
    ['{"seq":1,"kind":"user"}'],
    ['{"seq":2,"kind":"assistant"}'],
  ]));

  function directoryOf(workspacePath) {
    return join(projectDir(sessionsRoot, workspacePath), encId);
  }

  function makeEntity(id, path, title) {
    return {
      id,
      path,
      title,
      sessionIds: [],
      async attachSession(sessionId) {
        const file = headerFileIn(directoryOf(path));
        if (file === undefined) throw new Error('cannot attach ' + sessionId + ': no log under ' + directoryOf(path));
        const header = JSON.parse(readFirstLine(readFileSync(file)));
        if (header.cwd !== path) throw new Error('cannot attach ' + sessionId + ' to ' + path + ': its cwd is ' + header.cwd);
        calls.push(['attach', id, sessionId]);
      },
      async detachSession(sessionId) {
        calls.push(['detach', id, sessionId]);
      },
    };
  }

  const srcEntity = makeEntity('ws-src', srcWs, '源工作区');
  // 现实里会话创建时就登记在所属工作区；孤儿场景由测试自己把它摘掉。
  srcEntity.sessionIds.push(SESSION_ID);
  const dstEntity = makeEntity('ws-dst', dstWs, '目标工作区');
  const extraEntity = makeEntity('ws-extra', extraWs, '别的');

  const host = {
    async statSession(id) {
      if (id !== SESSION_ID) return undefined;
      for (const dir of [srcDir, dstDir]) {
        const file = headerFileIn(dir);
        if (file !== undefined) return { header: JSON.parse(readFirstLine(readFileSync(file))) };
      }
      return undefined;
    },
    getWorkspace(id) {
      return [srcEntity, dstEntity, extraEntity].find((entity) => entity.id === id);
    },
    async createWorkspace(path) {
      calls.push(['create', path]);
      const entity = makeEntity('ws-new', path, path);
      entity.attachSession = async (sessionId) => { calls.push(['attach', 'ws-new', sessionId]); };
      return entity;
    },
    findWorkspaceByPath(path) {
      return [srcEntity, dstEntity, extraEntity].find((entity) => entity.path === path);
    },
    isSessionLive: () => state.live,
    async releaseSession(id) {
      calls.push(['release', id]);
      if (state.releaseFails === true) return { released: false, detail: '模拟释放失败：写所有权仍被占用' };
      state.live = false;
      return { released: true, detail: '模拟释放成功' };
    },
    listActivity: async () => state.activity,
    describeActivity: (activity) => activity.map((entry) => entry.kind).join('、'),
    refreshHeaderIndex: async () => { calls.push(['refresh']); return true; },
    async adoptSessions(ids, targetEntity, cwd) {
      calls.push(['adopt-batch', targetEntity.id, ids.slice().join(',')]);
      return { applied: true, refreshed: false };
    },
    async detachSessions(ids, sourceEntity) {
      calls.push(['detach-batch', sourceEntity.id, ids.slice().join(',')]);
      return { applied: true };
    },
    invalidateProjection: async (id) => { projections.push(id); },
    log: (level, message) => { logs.push([level, message]); },
  };

  return {
    base, sessionsRoot, journalsDir, srcWs, dstWs, srcDir, dstDir, encId,
    calls, logs, projections, state, host, srcEntity, dstEntity, extraEntity,
    attachRule: { directoryOf, makeEntity, headerFileIn },
    makeStore: (overrides = {}) => createMoveStore({
      sessionsRoot,
      journalsDir,
      sessionDirFor: (id, cwd) => join(projectDir(sessionsRoot, cwd), encodeSegment(id)),
      log: (level, message) => { logs.push([level, message]); },
      ...overrides,
    }),
  };
}

/** 断言整个存储里这个 id 最多只出现在一个项目目录下（DSH 的硬约束）。 */
export function assertSingleOccurrence(fixture) {
  let count = 0;
  for (const project of readdirSync(fixture.sessionsRoot)) {
    if (project === '_session-move-staging') continue;
    if (existsSync(join(fixture.sessionsRoot, project, fixture.encId))) count += 1;
  }
  assert.equal(count, 1, '同一个 session id 只能出现在一个项目目录里，否则 DSH 会永久拒绝打开它');
}

export function stagingCount(fixture) {
  const staging = join(fixture.sessionsRoot, '_session-move-staging');
  return existsSync(staging) ? readdirSync(staging).length : 0;
}

export function journalCount(fixture) {
  return existsSync(fixture.journalsDir) ? readdirSync(fixture.journalsDir).length : 0;
}
