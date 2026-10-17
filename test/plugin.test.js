/**
 * 主机插件的集成测试：用假的 cordis ctx 把 src/plugin.js 真正挂起来，
 * 然后**通过 HTTP 处理器**跑 describe / move / status，验证桥接形状与端到端行为。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { encodeSegment, projectDir } from '../src/paths.js';
import { readFirstLine } from '../src/zstd.js';
import { apply } from '../src/plugin.js';
import { SESSION_ID, makeFixture, assertSingleOccurrence } from './helpers.js';

/** 造一个够用的假 cordis ctx，并把 webServer 注册到的路由抓出来。 */
function makeCtx(fixture, config) {
  const routes = [];
  const events = new Map();
  const effects = [];
  const calls = [];
  const live = new Map();
  /** 模拟 SessionStore 的 entered 记录表：detach() 就是「释放活会话」的那条私有缝。 */
  const liveEntries = new Map();
  /** 模拟后端的 writers 表：live 写句柄，就地接管要从这里取。 */
  const writers = new Map();
  const handles = new Map();
  /** 模拟注册表的路径索引（entity.mutate 会用它过滤 sessionIds）。 */
  const sessionPaths = new Map();
  const state = { openFails: false };
  const workspaces = [];

  /** 模拟 JsonlSessionHandle 里我们用到的那些面。 */
  function makeHandle(id, cwd) {
    let chain = Promise.resolve();
    const handle = {
      header: { version: 4, id, createdAt: Date.now(), cwd, isSeeded: false },
      lease: { async release() { calls.push(['lease-release', id]); } },
      async drainLive() { calls.push(['drain', id]); },
      async flush() { calls.push(['handle-flush', id]); },
      async ensureLease() {
        calls.push(['ensure-lease', id]);
        if (handle.lease === null) handle.lease = { async release() { calls.push(['lease-release-again', id]); } };
      },
      enqueueChain(op) {
        const next = chain.then(op);
        chain = next.catch(() => {});
        return next;
      },
    };
    return handle;
  }

  function directoryOf(workspacePath) {
    return join(projectDir(fixture.sessionsRoot, workspacePath), encodeSegment(SESSION_ID));
  }

  function makeEntity(id, path, title) {
    const record = { id, path, title, sessionIds: [] };
    const entity = {
      id, path, title, record,
      get sessionIds() { return record.sessionIds; },
      async attachSession(sessionId) {
        const dir = directoryOf(path);
        const file = join(dir, 'session.v4.jsonl.zstd');
        if (!existsSync(file)) throw new Error('cannot attach: no log under ' + dir);
        const header = JSON.parse(readFirstLine(readFileSync(file)));
        if (header.cwd !== path) throw new Error('cannot attach ' + sessionId + ' to ' + path + ': its cwd is ' + header.cwd);
        calls.push(['attach', id, sessionId]);
        if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
      },
      async detachSession(sessionId) {
        calls.push(['detach', id, sessionId]);
        record.sessionIds = record.sessionIds.filter((entry) => entry !== sessionId);
      },
      // 复刻真实 entity.mutate：写入前按 host.sessionPath(id) 过滤 sessionIds。
      async mutate(fn) {
        const next = fn(record);
        if (next !== record) {
          record.sessionIds = next.sessionIds.filter((entry) => sessionPaths.get(entry) === next.path);
        }
        calls.push(['mutate', id]);
      },
    };
    workspaces.push(entity);
    return entity;
  }

  makeEntity('ws-src', fixture.srcWs, '源工作区');
  makeEntity('ws-dst', fixture.dstWs, '目标工作区');

  const sctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    effect(fn, name) { effects.push(name); return fn(); },
    on(event, handler) { events.set(event, handler); return () => {}; },
    get: (name) => ctx.get(name),
  };

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => live.get(id),
          flush: async (session) => { calls.push(['flush', session.id]); },
          store: liveEntries,
        };
      }
      return undefined;
    },
    sessionPersistence: {
      root: fixture.sessionsRoot,
      // 真实位置是后端的 tracker.writers（不是持久化服务本身）
      tracker: { writers },
      // 写打开探针：成功即代表没有活跃写者（也就是释放成功）。
      async open(id, access) {
        calls.push(['open', id, access]);
        if (state.openFails === true) throw new Error('session "' + id + '" is already owned by an active writer');
        return { close: async () => { calls.push(['close', id]); } };
      },
      async stat(id) {
        if (id !== SESSION_ID) return undefined;
        for (const dir of [fixture.srcDir, fixture.dstDir]) {
          const file = join(dir, 'session.v4.jsonl.zstd');
          if (existsSync(file)) return { header: JSON.parse(readFirstLine(readFileSync(file))) };
        }
        return undefined;
      },
      // 复刻后端的 locate：返回当前 generation 的路径；插件取父目录当会话目录。
      locate(meta) {
        return { kind: 'jsonl', path: join(projectDir(fixture.sessionsRoot, meta.cwd), encodeSegment(meta.id), 'session.v4.jsonl.zstd') };
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: (id) => workspaces.find((entity) => entity.id === id),
      async create(path) {
        // 复刻真实注册表：内部会先 realpath 目标路径（目录不存在就 ENOENT）。
        if (!existsSync(path)) throw new Error("ENOENT: no such file or directory, realpath '" + path + "'");
        calls.push(['create', path]);
        const entity = makeEntity('ws-new', path, path);
        return entity;
      },
      async listStoredHeaders() { return []; },
      async replaceHeaderIndex() { calls.push(['refresh']); },
      async enqueueOperation(operation) { return await operation(); },
      sessionPaths,
      headers: new Map(),
      invalidSessionPaths: new Map(),
    },
    async waterfall() { return []; },
    inject(names, callback) {
      if (names.includes('webServer')) callback(sctx);
    },
    on(event, handler) {
      events.set(event, handler);
      return () => {};
    },
  };

  /** 把一个会话造成「已打开」：live + entered 记录（+ 可选 live 写句柄）。 */
  function makeLive(id, options) {
    const withWriter = options === undefined || options.withWriter !== false;
    live.set(id, { id });
    liveEntries.set(id, {
      id,
      detach() {
        calls.push(['detach-live', id]);
        live.delete(id);
        liveEntries.delete(id);
      },
    });
    sessionPaths.set(id, fixture.srcWs);
    if (withWriter) {
      const handle = makeHandle(id, fixture.srcWs);
      writers.set(id, handle);
      handles.set(id, handle);
    }
  }

  apply(ctx, config);
  return { ctx, routes, events, calls, live, liveEntries, writers, handles, sessionPaths, state, workspaces, effects, makeLive };
}

/** 用一个假的 req/res 调一次路由处理器。 */
async function call(route, method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    end(payload) { this.body = payload === undefined ? '' : payload.toString('utf8'); },
  };
  await route.handler(req, res);
  return { status: res.statusCode, json: res.body.length > 0 ? JSON.parse(res.body) : undefined };
}

function routeFor(routes, suffix) {
  const found = routes.find((route) => route.path.endsWith(suffix));
  assert.ok(found !== undefined, '找不到路由 ' + suffix + '（已注册：' + routes.map((r) => r.path).join(', ') + '）');
  return found;
}

test('apply 注册 4 条桥接路由，并注入引导全局', async () => {
  const fixture = makeFixture('plugin-wire', 'plugin');
  const harness = makeCtx(fixture, { bridgePrefix: '/api/test-move', sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  assert.deepEqual(harness.routes.map((route) => route.path).sort(), [
    '/api/test-move/describe', '/api/test-move/move', '/api/test-move/move-commit', '/api/test-move/status',
  ]);
  assert.deepEqual(harness.routes.map((route) => route.kind), ['exact', 'exact', 'exact', 'exact']);

  const table = [];
  harness.events.get('webserver/index-inject')(table);
  assert.equal(table.length, 1);
  assert.equal(table[0].kind, 'global');
  assert.equal(table[0].name, '__DSH_SESSION_RELOCATE__');
  assert.equal(table[0].value.prefix, '/api/test-move');
  rmSync(fixture.base, { recursive: true, force: true });
});

test('describe：不带 sessionId 时列出工作区', async () => {
  const fixture = makeFixture('plugin-describe-list', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const result = await call(routeFor(harness.routes, '/describe'), 'POST', {});
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.session, null);
  assert.deepEqual(result.json.workspaces.map((workspace) => workspace.id).sort(), ['ws-dst', 'ws-src']);
  assert.equal(result.json.workspaces.every((workspace) => workspace.current === undefined), true);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('describe：带 sessionId 时给出当前工作区与可迁移性', async () => {
  const fixture = makeFixture('plugin-describe-one', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const result = await call(routeFor(harness.routes, '/describe'), 'POST', { sessionId: SESSION_ID });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.session.canMove, true);
  assert.equal(result.json.session.currentWorkspaceId, 'ws-src');
  assert.equal(result.json.session.reason, null);
  assert.equal(result.json.session.live, false);
  const current = result.json.workspaces.filter((workspace) => workspace.current);
  assert.deepEqual(current.map((workspace) => workspace.id), ['ws-src']);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('describe：打开中的会话可搬，并标明会「就地接管」', async () => {
  const fixture = makeFixture('plugin-describe-live', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  harness.makeLive(SESSION_ID);
  const result = await call(routeFor(harness.routes, '/describe'), 'POST', { sessionId: SESSION_ID });
  assert.equal(result.json.session.live, true);
  assert.equal(result.json.session.canMove, true, '打开中也应当可以搬');
  assert.equal(result.json.session.willHandoff, true, '界面据此提示「会就地接管」');
  assert.equal(result.json.session.willRelease, false);
  assert.equal(result.json.session.reason, null);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('describe：moveLive=false 且 releaseLive=false 时打开中的会话被拒', async () => {
  const fixture = makeFixture('plugin-describe-norelease', 'plugin');
  const harness = makeCtx(fixture, {
    sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base,
    moveLive: false, releaseLive: false,
  });
  harness.makeLive(SESSION_ID);
  const result = await call(routeFor(harness.routes, '/describe'), 'POST', { sessionId: SESSION_ID });
  assert.equal(result.json.session.canMove, false);
  assert.match(result.json.session.reason, /releaseLive=false/);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：通过桥接真的把会话搬走，之后再 describe 指向新工作区', async () => {
  const fixture = makeFixture('plugin-move', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const moveRoute = routeFor(harness.routes, '/move');
  const describeRoute = routeFor(harness.routes, '/describe');

  const before = await call(describeRoute, 'POST', { sessionId: SESSION_ID });
  assert.equal(before.json.session.currentWorkspaceId, 'ws-src');

  const result = await call(moveRoute, 'POST', { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.applied, 'live');
  assert.equal(result.json.to, fixture.dstWs);
  assert.ok(!existsSync(fixture.srcDir));
  assert.ok(existsSync(fixture.dstDir));
  assert.deepEqual(harness.calls, [['refresh'], ['attach', 'ws-dst', SESSION_ID], ['detach', 'ws-src', SESSION_ID]]);

  const after = await call(describeRoute, 'POST', { sessionId: SESSION_ID });
  assert.equal(after.json.session.currentWorkspaceId, 'ws-dst');
  assert.equal(after.json.session.cwd, fixture.dstWs);
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：正在跑的会话走「就地接管」——不释放、换 header、写链内搬文件', async () => {
  const fixture = makeFixture('plugin-move-live', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  harness.makeLive(SESSION_ID);
  const handle = harness.handles.get(SESSION_ID);
  assert.equal(handle.header.cwd, fixture.srcWs, '前置：写句柄的 header 指向源工作区');

  const result = await call(routeFor(harness.routes, '/move'), 'POST', { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });

  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.applied, 'live');
  assert.equal(result.json.handedOff, true, '回执必须标明这次是就地接管');
  assert.equal(result.json.released, false, '就地接管不该释放会话');
  assert.equal(harness.live.has(SESSION_ID), true, '会话必须还活着（turn 不中断）');
  // 写句柄已经被指向新路径，锁已释放（下次写入会在新路径重建）
  assert.equal(handle.header.cwd, fixture.dstWs, '写句柄的 header 必须换成目标 cwd');
  assert.equal(handle.lease, null, '内核写锁必须已释放');
  // 归属走的是旁路（adoptSession），不是 attachSession
  assert.deepEqual(harness.calls, [
    ['drain', SESSION_ID],
    ['handle-flush', SESSION_ID],
    ['ensure-lease', SESSION_ID],
    ['lease-release', SESSION_ID],
    ['mutate', 'ws-dst'],
    ['mutate', 'ws-src'],
  ]);
  assert.equal(harness.sessionPaths.get(SESSION_ID), fixture.dstWs, '路径索引必须指向新工作区');
  assert.ok(!existsSync(fixture.srcDir));
  assert.ok(existsSync(fixture.dstDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：探测不到写句柄时绝不静默接管，退回释放路径', async () => {
  const fixture = makeFixture('plugin-move-live-nowriter', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  harness.makeLive(SESSION_ID, { withWriter: false });
  const result = await call(routeFor(harness.routes, '/move'), 'POST', { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.handedOff, false, '没有写句柄就不该声称接管');
  assert.equal(result.json.released, true, '应当退回「先释放再搬」');
  assert.equal(harness.live.has(SESSION_ID), false);
  assert.deepEqual(harness.calls, [
    ['flush', SESSION_ID],
    ['detach-live', SESSION_ID],
    ['open', SESSION_ID, 'write'],
    ['close', SESSION_ID],
    ['refresh'],
    ['attach', 'ws-dst', SESSION_ID],
    ['detach', 'ws-src', SESSION_ID],
  ]);
  assert.ok(!existsSync(fixture.srcDir));
  assert.ok(existsSync(fixture.dstDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：moveLive=false 时退回「先释放再搬」（flush → detach → 探针）', async () => {
  const fixture = makeFixture('plugin-move-release', 'plugin');
  const harness = makeCtx(fixture, {
    sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base, moveLive: false,
  });
  harness.makeLive(SESSION_ID);
  const result = await call(routeFor(harness.routes, '/move'), 'POST', { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.applied, 'live');
  assert.equal(result.json.released, true);
  assert.equal(result.json.handedOff, false);
  assert.equal(harness.live.has(SESSION_ID), false, '释放路径下它不该还在内存里');
  assert.deepEqual(harness.calls, [
    ['flush', SESSION_ID],
    ['detach-live', SESSION_ID],
    ['open', SESSION_ID, 'write'],
    ['close', SESSION_ID],
    ['refresh'],
    ['attach', 'ws-dst', SESSION_ID],
    ['detach', 'ws-src', SESSION_ID],
  ]);
  assert.ok(!existsSync(fixture.srcDir));
  assert.ok(existsSync(fixture.dstDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：释放不掉（写所有权仍被占用）时拒绝，源目录不动', async () => {
  const fixture = makeFixture('plugin-move-stuck', 'plugin');
  const harness = makeCtx(fixture, {
    sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base,
    moveLive: false, releaseRetries: 1, releaseRetryDelayMs: 1,
  });
  harness.makeLive(SESSION_ID);
  harness.state.openFails = true;
  const result = await call(routeFor(harness.routes, '/move'), 'POST', { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, 'release-failed');
  assert.ok(existsSync(fixture.srcDir), '释放失败时源目录必须完好');
  assert.ok(!existsSync(fixture.dstDir));
  assert.equal(harness.calls.some((entry) => entry[0] === 'refresh'), false, '没能释放就不该去动注册表');
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：目标目录不存在时会先创建它再注册（文档承诺的行为）', async () => {
  const fixture = makeFixture('plugin-move-newdir', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const newDir = join(fixture.base, 'brand-new-ws');
  assert.equal(existsSync(newDir), false, '前置：这个目录还不存在');
  const result = await call(routeFor(harness.routes, '/move'), 'POST', { sessionId: SESSION_ID, targetPath: newDir });
  assert.equal(result.json.ok, true, JSON.stringify(result.json));
  assert.equal(result.json.applied, 'live');
  assert.equal(existsSync(newDir), true, '目标目录必须被创建出来');
  assert.ok(harness.calls.some((entry) => entry[0] === 'create' && entry[1] === newDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('move：缺 sessionId / 方法不对 / 坏 JSON 都有稳定响应', async () => {
  const fixture = makeFixture('plugin-move-bad', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const moveRoute = routeFor(harness.routes, '/move');

  const noId = await call(moveRoute, 'POST', {});
  assert.equal(noId.json.ok, false);
  assert.equal(noId.json.code, 'bad-request');

  const wrongMethod = await call(moveRoute, 'GET');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.code, 'method-not-allowed');

  // 直接发一段坏 JSON
  const req = Readable.from([Buffer.from('{not json', 'utf8')]);
  req.method = 'POST';
  const res = { statusCode: 0, setHeader() {}, end(payload) { this.body = payload === undefined ? '' : payload.toString('utf8'); } };
  await moveRoute.handler(req, res);
  assert.equal(res.statusCode, 400);
  const malformed = JSON.parse(res.body);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'bad-request', '坏 JSON 应当是 bad-request 而不是 internal');
  rmSync(fixture.base, { recursive: true, force: true });
});

test('status：报告未收尾的迁移并尝试恢复', async () => {
  const fixture = makeFixture('plugin-status', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const result = await call(routeFor(harness.routes, '/status'), 'GET');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.deepEqual(result.json.pending, []);
  assert.equal(result.json.sessionsRoot, fixture.sessionsRoot);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('版本号：/status 报的就是 package.json 的版本（防止再写两处漂移）', async () => {
  const fixture = makeFixture('plugin-version', 'plugin');
  const harness = makeCtx(fixture, { sessionsRoot: fixture.sessionsRoot, journalsDir: fixture.journalsDir, home: fixture.base });
  const result = await call(routeFor(harness.routes, '/status'), 'GET');
  assert.equal(result.status, 200);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(result.json.version, pkg.version, '运行时自报的版本必须等于 package.json 的版本');
  assert.notEqual(result.json.version, '0.0.0-unknown', 'package.json 应当读得到');
  rmSync(fixture.base, { recursive: true, force: true });
});

