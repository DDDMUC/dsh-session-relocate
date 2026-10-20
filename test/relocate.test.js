import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { encodeSegment, projectDir } from '../src/paths.js';
import { decodeAllFrames, readFirstLine, scanZstdFrames } from '../src/zstd.js';
import { commitMoves, recoverPendingMoves, relocateSession, MoveError } from '../src/relocate.js';
import {
  SESSION_ID, COMPRESS, makeFixture, makeLog, makePlainLog,
  assertSingleOccurrence, stagingCount, journalCount,
} from './helpers.js';

test('正常迁移：源目录消失、目标就位、header 改成目标 cwd、其余字节不变', async () => {
  const fixture = makeFixture('happy');
  const before = readFileSync(join(fixture.srcDir, 'session.v4.jsonl.zstd'));
  const store = fixture.makeStore();

  const receipt = await relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.applied, 'live');
  assert.equal(receipt.to, fixture.dstWs);
  assert.equal(receipt.targetTitle, '目标工作区');
  assert.equal(receipt.headerIndexRefreshed, false, '定向写入不再重建全量 header 索引');
  assert.equal(receipt.verification, 'full', '小日志走全文解码校验');

  assert.ok(!existsSync(fixture.srcDir), '源目录必须被删除');
  assert.ok(existsSync(fixture.dstDir), '目标目录必须就位');

  for (const name of ['session.jsonl.zstd', 'session.v4.jsonl.zstd']) {
    const header = JSON.parse(readFirstLine(readFileSync(join(fixture.dstDir, name))));
    assert.equal(header.cwd, fixture.dstWs, name + ' 的 cwd 必须是目标工作区');
    assert.equal(header.id, SESSION_ID);
    assert.equal(header.type, 'session');
  }
  const after = readFileSync(join(fixture.dstDir, 'session.v4.jsonl.zstd'));
  const wantLines = decodeAllFrames(before).toString('utf8').split('\n');
  const gotLines = decodeAllFrames(after).toString('utf8').split('\n');
  assert.deepEqual(gotLines.slice(1), wantLines.slice(1), '除首行外的历史必须一字节不差');

  // 冷搬移现在走定向归属写入：目标、源各一次 mutate，不再重建全量 header 索引。
  assert.deepEqual(fixture.calls, [
    ['adopt-batch', 'ws-dst', SESSION_ID],
    ['detach-batch', 'ws-src', SESSION_ID],
  ]);
  assert.deepEqual(fixture.projections, [SESSION_ID]);
  assert.equal(journalCount(fixture), 0);
  assert.equal(stagingCount(fixture), 0);
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('迁移中暂存区对 DSH 扫描器不可见（日志不在 <staging>/<id>/ 下）', async () => {
  const fixture = makeFixture('staging-shape');
  const store = fixture.makeStore();
  const stagingRoot = join(fixture.sessionsRoot, '_session-move-staging');
  const seen = [];
  const originalStage = store.stageAndPatch;
  const wrapped = Object.create(store);
  wrapped.stageAndPatch = async (...args) => {
    const result = await originalStage.apply(store, args);
    seen.push(existsSync(join(stagingRoot, fixture.encId)));
    seen.push(existsSync(join(stagingRoot, args[0].opId, fixture.encId, 'session.v4.jsonl.zstd')));
    return result;
  };
  await relocateSession(fixture.host, wrapped, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.deepEqual(seen, [false, true], '暂存副本必须比 <staging>/<id> 深一层，才不会被后端当成会话');
  rmSync(fixture.base, { recursive: true, force: true });
});

test('打开中但空闲：先释放再搬，且释放排在动文件之前', async () => {
  const fixture = makeFixture('live-release');
  fixture.state.live = true;
  const receipt = await relocateSession(fixture.host, fixture.makeStore(), {
    sessionId: SESSION_ID,
    targetWorkspaceId: 'ws-dst',
  });
  assert.equal(receipt.applied, 'live');
  assert.equal(receipt.released, true, '回执必须标明这次做过释放');
  assert.equal(fixture.state.live, false, '释放后该会话不该再是 live');
  assert.deepEqual(fixture.calls, [
    ['release', SESSION_ID],
    ['adopt-batch', 'ws-dst', SESSION_ID],
    ['detach-batch', 'ws-src', SESSION_ID],
  ]);
  assert.ok(!existsSync(fixture.srcDir));
  assert.ok(existsSync(fixture.dstDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('releaseLive=false：打开中的会话被拒绝，且什么都不做', async () => {
  const fixture = makeFixture('live-refuse');
  fixture.state.live = true;
  await assert.rejects(
    () => relocateSession(fixture.host, fixture.makeStore(), {
      sessionId: SESSION_ID,
      targetWorkspaceId: 'ws-dst',
      releaseLive: false,
    }),
    (error) => error instanceof MoveError && error.code === 'session-live',
  );
  assert.equal(fixture.calls.length, 0, '拒绝时不该做任何动作');
  assert.ok(existsSync(fixture.srcDir), '被拒绝时源目录不能被动过');
  assert.ok(!existsSync(fixture.dstDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('释放失败：整体放弃，源目录一个字节不动、不留日志', async () => {
  const fixture = makeFixture('live-release-fail');
  fixture.state.live = true;
  fixture.state.releaseFails = true;
  const before = readFileSync(join(fixture.srcDir, 'session.v4.jsonl.zstd'));
  await assert.rejects(
    () => relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' }),
    (error) => error instanceof MoveError && error.code === 'release-failed',
  );
  assert.ok(existsSync(fixture.srcDir), '释放失败后源目录必须完好');
  assert.ok(!existsSync(fixture.dstDir));
  assert.deepEqual(readFileSync(join(fixture.srcDir, 'session.v4.jsonl.zstd')), before);
  assert.equal(journalCount(fixture), 0, '释放失败不该留下迁移日志');
  assert.equal(stagingCount(fixture), 0);
  assert.deepEqual(fixture.calls, [['release', SESSION_ID]], '只应当尝试过释放');
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('拒绝：会话还有正在跑的工作', async () => {
  const fixture = makeFixture('active');
  fixture.state.live = false;
  fixture.state.activity = [{ kind: 'turn' }];
  await assert.rejects(
    () => relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' }),
    (error) => error instanceof MoveError && error.code === 'session-active',
  );
  assert.ok(existsSync(fixture.srcDir));
  rmSync(fixture.base, { recursive: true, force: true });
});

test('拒绝：已经在目标工作区', async () => {
  const fixture = makeFixture('already');
  await assert.rejects(
    () => relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetWorkspaceId: 'ws-src' }),
    (error) => error instanceof MoveError && error.code === 'already-there',
  );
  rmSync(fixture.base, { recursive: true, force: true });
});

test('路径已在目标、但注册表没有归属：补归属，不当作 already-there', async () => {
  const fixture = makeFixture('attach-orphan');
  const store = fixture.makeStore();
  // 模拟孤儿：目录在源工作区的 cwd 下，但不在 DSH 的 sessionIds 里。
  fixture.srcEntity.sessionIds.length = 0;
  const receipt = await relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-src' });
  assert.equal(receipt.applied, 'attached');
  assert.equal(receipt.targetWorkspaceId, 'ws-src');
  assert.equal(receipt.targetTitle, '源工作区');
  assert.deepEqual(fixture.calls, [['adopt-batch', 'ws-src', SESSION_ID]], '同源：只补归属，不 detach');
  assert.equal(journalCount(fixture), 0, '没动文件就不该有迁移日志');
  assert.equal(existsSync(join(fixture.srcDir, 'session.v4.jsonl.zstd')), true, '文件原地不动');
  assert.deepEqual(fixture.projections, [SESSION_ID], '归属补上后清掉投影缓存');
  rmSync(fixture.base, { recursive: true, force: true });
});

test('拒绝：不存在的会话 / 不存在的工作区 / 没有目标', async () => {
  const fixture = makeFixture('bad-targets');
  const store = fixture.makeStore();
  await assert.rejects(() => relocateSession(fixture.host, store, { sessionId: 'nope', targetWorkspaceId: 'ws-dst' }),
    (error) => error.code === 'session-not-found');
  await assert.rejects(() => relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-nope' }),
    (error) => error.code === 'workspace-not-found');
  await assert.rejects(() => relocateSession(fixture.host, store, { sessionId: SESSION_ID }),
    (error) => error.code === 'no-target');
  rmSync(fixture.base, { recursive: true, force: true });
});

test('拒绝：日志损坏时给出类型化错误，源目录不动', async () => {
  const fixture = makeFixture('unreadable');
  // 让 header 本身读不出来：把最高版本日志的首行换成非 JSON。
  writeFileSync(join(fixture.srcDir, 'session.v9.jsonl.zstd'),
    zstdCompressSync(Buffer.from('not json at all\n', 'utf8'), COMPRESS));
  await assert.rejects(
    () => relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' }),
    (error) => error instanceof MoveError && error.code === 'session-unreadable',
  );
  assert.ok(existsSync(fixture.srcDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('回滚：自校验失败时源目录一个字节都没变，暂存与日志都清掉', async () => {
  const fixture = makeFixture('rollback');
  const before = {};
  for (const name of readdirSync(fixture.srcDir)) before[name] = readFileSync(join(fixture.srcDir, name));
  // 塞一个较低版本的损坏 generation，让引擎走到 corrupt-log 分支。
  writeFileSync(join(fixture.srcDir, 'session.v1.jsonl.zstd'),
    zstdCompressSync(Buffer.from('not json at all\n', 'utf8'), COMPRESS));

  await assert.rejects(
    () => relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' }),
    (error) => error instanceof MoveError && error.code === 'corrupt-log',
  );

  assert.ok(!existsSync(fixture.dstDir), '回滚后不能留下目标目录');
  for (const [name, buf] of Object.entries(before)) {
    assert.deepEqual(readFileSync(join(fixture.srcDir, name)), buf, name + ' 必须原样未改');
  }
  assert.equal(journalCount(fixture), 0, '回滚后必须删掉迁移日志');
  assert.equal(stagingCount(fixture), 0, '回滚后暂存区必须清空');
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('恢复：崩在「已 promote 但源目录还在」时，重启后自动推完', async () => {
  const fixture = makeFixture('recover-promoted');
  const store = fixture.makeStore();

  mkdirSync(fixture.dstDir, { recursive: true });
  writeFileSync(join(fixture.dstDir, 'session.v4.jsonl.zstd'),
    makeLog(SESSION_ID, fixture.dstWs, 4, [['{"seq":1,"kind":"user"}']]));
  const opId = 'manual-op-1';
  mkdirSync(fixture.journalsDir, { recursive: true });
  writeFileSync(join(fixture.journalsDir, opId + '.json'), JSON.stringify({
    version: 1, opId, sessionId: SESSION_ID, fromCwd: fixture.srcWs, toCwd: fixture.dstWs,
    srcDir: fixture.srcDir, dstDir: fixture.dstDir, phase: 'moved', startedAt: new Date().toISOString(),
  }));

  const results = await recoverPendingMoves(fixture.host, store);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'completed');
  assert.ok(!existsSync(fixture.srcDir), '恢复必须删掉残留的源目录');
  assert.ok(existsSync(fixture.dstDir));
  assert.deepEqual(fixture.calls, [['refresh'], ['attach', 'ws-dst', SESSION_ID], ['detach', 'ws-src', SESSION_ID]]);
  assert.equal(journalCount(fixture), 0);
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('恢复：崩在只有暂存副本时（源完好）重做并完成', async () => {
  const fixture = makeFixture('recover-staged');
  const store = fixture.makeStore();
  const opId = 'manual-op-2';
  mkdirSync(join(fixture.sessionsRoot, '_session-move-staging', opId, fixture.encId), { recursive: true });
  writeFileSync(join(fixture.sessionsRoot, '_session-move-staging', opId, fixture.encId, 'session.v4.jsonl.zstd'), Buffer.from('garbage'));
  mkdirSync(fixture.journalsDir, { recursive: true });
  writeFileSync(join(fixture.journalsDir, opId + '.json'), JSON.stringify({
    version: 1, opId, sessionId: SESSION_ID, fromCwd: fixture.srcWs, toCwd: fixture.dstWs,
    srcDir: fixture.srcDir, dstDir: fixture.dstDir, phase: 'staged', startedAt: new Date().toISOString(),
  }));

  const results = await recoverPendingMoves(fixture.host, store);
  assert.equal(results[0].status, 'completed-now', '目标未就位时应当重做并完成');
  assert.ok(!existsSync(fixture.srcDir));
  const header = JSON.parse(readFirstLine(readFileSync(join(fixture.dstDir, 'session.v4.jsonl.zstd'))));
  assert.equal(header.cwd, fixture.dstWs);
  const lines = decodeAllFrames(readFileSync(join(fixture.dstDir, 'session.v4.jsonl.zstd'))).toString('utf8').split('\n');
  assert.equal(lines[1], '{"seq":1,"kind":"user"}', '内容必须来自源而不是那段 garbage');
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('未压缩（compression: none）的日志同样能迁移', async () => {
  const fixture = makeFixture('plain');
  rmSync(join(fixture.srcDir, 'session.v4.jsonl.zstd'));
  rmSync(join(fixture.srcDir, 'session.jsonl.zstd'));
  writeFileSync(join(fixture.srcDir, 'session.v4.jsonl'),
    makePlainLog(SESSION_ID, fixture.srcWs, 4, [['{"seq":1,"kind":"user"}', '{"seq":2,"kind":"assistant"}']]));

  const receipt = await relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(receipt.applied, 'live');
  const header = JSON.parse(readFirstLine(readFileSync(join(fixture.dstDir, 'session.v4.jsonl'))));
  assert.equal(header.cwd, fixture.dstWs);
  assert.equal(readFileSync(join(fixture.dstDir, 'session.v4.jsonl'), 'utf8').split('\n')[1], '{"seq":1,"kind":"user"}');
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('用目录路径作为目标时会先注册新工作区', async () => {
  const fixture = makeFixture('by-path');
  const newDir = join(fixture.base, 'brand-new-ws');
  mkdirSync(newDir, { recursive: true });
  const receipt = await relocateSession(fixture.host, fixture.makeStore(), { sessionId: SESSION_ID, targetPath: newDir });
  assert.equal(receipt.applied, 'live');
  assert.equal(receipt.targetWorkspaceId, 'ws-new');
  assert.ok(fixture.calls.some((call) => call[0] === 'create' && call[1] === newDir));
  assert.ok(existsSync(join(projectDir(fixture.sessionsRoot, newDir), fixture.encId)));
  rmSync(fixture.base, { recursive: true, force: true });
});

test('注册表收尾失败时磁盘已就位、日志保留，之后可自动补齐', async () => {
  const fixture = makeFixture('pending-registry');
  const store = fixture.makeStore();
  // 让定向归属写入失败（模拟注册表拒绝），磁盘部分必须已经完成、日志必须保留。
  const failing = Object.create(fixture.host);
  failing.adoptSessions = async () => ({ applied: false, reason: 'stale header index' });

  const receipt = await relocateSession(failing, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(receipt.applied, 'pending');
  assert.ok(existsSync(fixture.dstDir), '磁盘部分必须已经完成');
  assert.ok(!existsSync(fixture.srcDir));
  assert.equal(journalCount(fixture), 1, '收尾未完成时必须保留迁移日志');

  const results = await recoverPendingMoves(fixture.host, store);
  assert.equal(results[0].status, 'completed');
  assert.equal(journalCount(fixture), 0);
  assert.deepEqual(fixture.calls, [['refresh'], ['attach', 'ws-dst', SESSION_ID], ['detach', 'ws-src', SESSION_ID]]);
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('deferRegistry：只做文件事务，注册表一个字都不写，日志故意留着', async () => {
  const fixture = makeFixture('defer');
  const store = fixture.makeStore();
  const receipt = await relocateSession(fixture.host, store, {
    sessionId: SESSION_ID,
    targetWorkspaceId: 'ws-dst',
    deferRegistry: true,
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.deferred, true);
  assert.ok(existsSync(fixture.dstDir), '文件必须已经就位');
  assert.ok(!existsSync(fixture.srcDir), '源目录必须已经删除');
  assert.deepEqual(fixture.calls, [], 'defer 阶段不许碰注册表');
  assert.equal(fixture.projections.length, 0, '投影缓存留到 commit 再失效');
  assert.equal(journalCount(fixture), 1, '日志必须留着当下一次 commit 的输入');
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('commitMoves：整批只写一次注册表，清日志、清暂存、失效投影', async () => {
  const fixture = makeFixture('commit');
  const store = fixture.makeStore();
  await relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst', deferRegistry: true });
  const result = await commitMoves(fixture.host, store, [SESSION_ID]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.status), ['moved']);
  assert.deepEqual(fixture.calls, [
    ['adopt-batch', 'ws-dst', SESSION_ID],
    ['detach-batch', 'ws-src', SESSION_ID],
  ], '整个批次只该有两次注册表写，且不刷新全量 header 索引');
  assert.equal(journalCount(fixture), 0);
  assert.equal(stagingCount(fixture), 0);
  assert.deepEqual(fixture.projections, [SESSION_ID]);
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('commitMoves：注册表写失败时保留日志，不假装成功', async () => {
  const fixture = makeFixture('commit-fail');
  const store = fixture.makeStore();
  await relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst', deferRegistry: true });
  const brokenHost = Object.create(fixture.host);
  brokenHost.adoptSessions = async () => ({ applied: false, reason: '模拟注册表拒绝' });
  const result = await commitMoves(brokenHost, store, [SESSION_ID]);
  assert.equal(result.ok, false);
  assert.match(result.message, /自动补齐|归属/);
  assert.equal(journalCount(fixture), 1, '日志必须留着让 recoverOne 补完归属');
  rmSync(fixture.base, { recursive: true, force: true });
});

/** 把源日志里第 index 个帧的载荷拧坏一个字节（帧头保持合法，扫帧仍能扫出来）。 */
function corruptFrame(fixture, index) {
  const file = join(fixture.srcDir, 'session.v4.jsonl.zstd');
  const buffer = readFileSync(file);
  const scan = scanZstdFrames(buffer);
  const frame = scan.frames[index];
  if (frame === undefined) throw new Error('没有第 ' + String(index) + ' 帧');
  const at = Math.min(frame.end - 2, frame.start + 20);
  buffer[at] = buffer[at] ^ 0xff;
  writeFileSync(file, buffer);
}

test('A2：小日志走全文解码，中间帧损坏时拒绝搬移', async () => {
  const fixture = makeFixture('verify-full-corrupt');
  corruptFrame(fixture, 1);
  const store = fixture.makeStore();
  await assert.rejects(
    () => relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' }),
    /迁移失败|corrupt|解压|Zstd|checksum|invalid/i,
  );
  assert.ok(existsSync(fixture.srcDir), '拒绝时源目录必须原样保留');
  assert.equal(journalCount(fixture), 0, '回滚后不能留下日志');
  rmSync(fixture.base, { recursive: true, force: true });
});

test('A2：超过阈值的日志走抽样校验（帧级比对 + 解头解尾），回执里明确标注', async () => {
  const fixture = makeFixture('verify-sampled');
  corruptFrame(fixture, 1);
  // 阈值设成 1 字节：这份小日志也走抽样路径，方便验证行为而不是造大文件。
  const store = fixture.makeStore({ fullVerifyLimit: 1 });
  const receipt = await relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verification, 'sampled', '抽样校验必须在回执里标出来');
  assert.ok(existsSync(fixture.dstDir));
  assert.ok(!existsSync(fixture.srcDir));
  assertSingleOccurrence(fixture);
  rmSync(fixture.base, { recursive: true, force: true });
});

test('A2：verify=full 时忽略大小阈值，一律全文解码', async () => {
  const fixture = makeFixture('verify-force-full');
  corruptFrame(fixture, 1);
  const store = fixture.makeStore({ verify: 'full', fullVerifyLimit: 1 });
  await assert.rejects(
    () => relocateSession(fixture.host, store, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' }),
    /迁移失败|corrupt|解压|Zstd|checksum|invalid/i,
  );
  assert.ok(existsSync(fixture.srcDir));
  rmSync(fixture.base, { recursive: true, force: true });
});
