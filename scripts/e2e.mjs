/**
 * 隔离的端到端验证脚本（不碰真实 DSH 数据）。
 *
 * 用途：在一个临时 DSH_HOME 里起一个只加载了本插件的 DSH 实例，让真实的注册表、
 * 真实的 zstd 解码器、真实的 domain 写路径一起跑一遍迁移，确认它真的生效。
 *
 * 用法（PowerShell）：
 *   $env:DSH_HOME = '<repo>\.smoke-home'
 *   node scripts/e2e.mjs seed                                    # 重置并预置一个会话日志
 *   dsh smoke --from-default-profile web --dump-config           # 首次：派生 profile（选一次）
 *   dsh plugin --profile smoke add <repo>                        # 首次：装进该 profile
 *   dsh smoke --port 3201 --no-open                              # 另开一个终端启动
 *   node scripts/e2e.mjs verify                                  # 跑 describe / move / describe 并校验
 *   $env:SMOKE_PORT='3202'                                       # 活体验证（需要该 profile 开 selftest: true）
 *   node scripts/e2e.mjs live                                    # 造一个持租约+带写入压力的 live 会话 → 就地接管 → 读回 → 清理
 *
 * @module dsh-session-relocate/scripts/e2e
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';
import { encodeSegment, projectKey } from '../src/paths.js';

const HOME = process.env.DSH_HOME;
if (typeof HOME !== 'string' || HOME.length === 0) throw new Error('请先把 DSH_HOME 设成隔离的临时 home');
const PORT = process.env.SMOKE_PORT ?? '3201';
const SESSION_ID = 'session-e2e00001-0000-4000-8000-000000000001';
const BASE = 'http://127.0.0.1:' + PORT + '/api/dsh-session-relocate';
const COMPRESS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const srcWs = join(HOME, 'ws-src');
const dstWs = join(HOME, 'ws-dst');

/** 重置注册表与会话历史，并写入一个结构合法的会话日志。 */
function seed() {
  for (const dir of ['sessions', 'storages']) {
    const p = join(HOME, dir);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  mkdirSync(srcWs, { recursive: true });
  mkdirSync(dstWs, { recursive: true });

  const header = JSON.stringify({
    type: 'session', version: 4, id: SESSION_ID, createdAt: 1700000000000,
    cwd: srcWs, isSeeded: false, delegationDepth: 0, agentPreset: 'standard',
  });
  // 事件必须是 DSH 认的形状：{ type, seq, time, data }。
  // （早先这里写的是 {"seq":1,"kind":"user"}，缺 type —— DSH 会把整个会话当垃圾排除，
  //   侧边栏根本不渲染它，而工作区分组却照常出现，很容易误判成"已经好了"。）
  const at = 1700000001000;
  const events = [
    { type: 'permission/preset', seq: 0, time: at, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time: at + 1, data: { mode: 'workspace-write' } },
    { type: 'approval/policy', seq: 2, time: at + 2, data: { policy: 'ask' } },
    { type: 'session/end-seed', seq: 3, time: at + 3, data: {} },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n';

  // DSH 的硬约束：第一帧恰好只有 header 一行（唯一的换行在末尾）。
  const frames = [
    zstdCompressSync(Buffer.from(header + '\n', 'utf8'), COMPRESS),
    zstdCompressSync(Buffer.from(events, 'utf8'), COMPRESS),
  ];
  const dir = join(HOME, 'sessions', projectKey(srcWs), encodeSegment(SESSION_ID));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  process.stdout.write('seeded ' + SESSION_ID + ' -> ' + dir + '\n');
}

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await response.json();
}

/** 对运行中的隔离实例跑一遍完整迁移并逐项断言。 */
async function verify() {
  const before = await post('/describe', { sessionId: SESSION_ID });
  process.stdout.write('before: ' + JSON.stringify({
    current: before.session?.currentWorkspaceId, cwd: before.session?.cwd, canMove: before.session?.canMove,
  }) + '\n');
  if (before.session?.canMove !== true) throw new Error('前置条件不满足：canMove 不是 true');

  const moved = await post('/move', { sessionId: SESSION_ID, targetPath: dstWs });
  process.stdout.write('move  : ' + JSON.stringify(moved) + '\n');
  if (moved.ok !== true) throw new Error('迁移失败：' + String(moved.message));
  if (moved.applied !== 'live') throw new Error('迁移没有实时生效：' + String(moved.applied));

  // 这一步会让 DSH 自己的解码器重新读改写过的日志 —— 读得通才说明文件是合法产物。
  const after = await post('/describe', { sessionId: SESSION_ID });
  process.stdout.write('after : ' + JSON.stringify({
    current: after.session?.currentWorkspaceId, cwd: after.session?.cwd, unreadable: after.session?.unreadable ?? false,
  }) + '\n');
  if (after.session?.cwd !== dstWs) throw new Error('cwd 没有变成目标工作区');
  if (after.session?.unreadable === true) throw new Error('DSH 读不懂改写后的日志：' + String(after.session.message));

  const srcDir = join(HOME, 'sessions', projectKey(srcWs), encodeSegment(SESSION_ID));
  const dstDir = join(HOME, 'sessions', projectKey(dstWs), encodeSegment(SESSION_ID));
  if (existsSync(srcDir)) throw new Error('源目录还在：' + srcDir);
  if (!existsSync(dstDir)) throw new Error('目标目录不在：' + dstDir);

  // 同一个 id 绝不能出现在两个项目目录里（DSH 会因此永久拒绝打开它）。
  let occurrences = 0;
  for (const project of readdirSync(join(HOME, 'sessions'))) {
    if (project === '_session-move-staging') continue;
    if (existsSync(join(HOME, 'sessions', project, encodeSegment(SESSION_ID)))) occurrences += 1;
  }
  if (occurrences !== 1) throw new Error('会话 id 出现了 ' + String(occurrences) + ' 次（必须恰好 1 次）');

  for (const dir of ['session-move', join('sessions', '_session-move-staging')]) {
    const p = join(HOME, dir);
    if (!existsSync(p)) continue;
    const left = readdirSync(p);
    if (left.length > 0) throw new Error('有未清理的残留：' + p + ' -> ' + left.join(', '));
  }

  const store = JSON.parse(readFileSync(join(HOME, 'storages', 'workspace.json'), 'utf8'));
  const rows = Object.values(store.tables.workspaces);
  const owners = rows.filter((row) => (row.sessionIds ?? []).includes(SESSION_ID));
  if (owners.length !== 1 || owners[0].path !== dstWs) {
    throw new Error('注册表归属不正确：' + JSON.stringify(owners.map((row) => row.path)));
  }
  process.stdout.write('OK：迁移、注册表归属、磁盘现场全部正确\n');
}

/**
 * 活体验证：造一个「已打开 + 持有真实写租约 + 有持续写入压力」的会话，然后搬它。
 *
 * 这是**就地接管**（handoff）这条链路的回归测试，也是本插件与生态里其它迁移插件的
 * 关键差别：正在跑的会话也能搬，不用重启 DSH、不中断 turn。
 * 需要 profile 里这一行打开 `selftest: true`（默认关闭）。
 */
async function live() {
  const created = await post('/__selftest/create-live', { workspacePath: srcWs, pressure: true });
  process.stdout.write('create: ' + JSON.stringify(created) + '\n');
  if (created.ok !== true) throw new Error('造会话失败：' + String(created.message));
  if (created.live !== true) throw new Error('会话没有变成 live');
  if (created.leaseHeld !== true) throw new Error('没有拿到写租约，这个验证就不算数：' + String(created.leaseError));
  if (created.pressure !== true) throw new Error('写入压力循环没有起来');
  const sessionId = created.sessionId;

  const before = await post('/describe', { sessionId });
  process.stdout.write('before: ' + JSON.stringify({
    live: before.session?.live, willHandoff: before.session?.willHandoff, canMove: before.session?.canMove,
  }) + '\n');
  if (before.session?.willHandoff !== true) throw new Error('describe 没报告 willHandoff');
  if (before.session?.canMove !== true) throw new Error('正在跑的会话应当可以就地接管');

  const moved = await post('/move', { sessionId, targetPath: dstWs });
  process.stdout.write('move  : ' + JSON.stringify(moved) + '\n');
  if (moved.ok !== true) throw new Error('迁移失败：' + String(moved.message));
  if (moved.handedOff !== true) throw new Error('没有走就地接管');
  if (moved.handoffWriter !== true) throw new Error('没有真的改写 live 写句柄');
  if (moved.released !== false) throw new Error('就地接管不该释放会话');

  const state = await post('/__selftest/state', {});
  const window = state.handoffs?.[0];
  const marks = state.pressure?.marks ?? [];
  if (window === undefined) throw new Error('没有记录到接管窗口');
  const interleaved = marks.filter((mark) => mark > window.start && mark < window.end);
  process.stdout.write('window: ' + JSON.stringify({
    spanMs: window.end - window.start, samples: marks.length, interleaved: interleaved.length,
  }) + '\n');
  if (marks.length === 0) throw new Error('压力循环一次都没跑，这个验证不算数');
  if (interleaved.length !== 0) throw new Error('有 ' + String(interleaved.length) + ' 次写入插进了接管窗口');
  if (state.writer?.headerCwd !== dstWs) throw new Error('写句柄的 header.cwd 没有换成目标工作区：' + String(state.writer?.headerCwd));
  if (state.writer?.leaseHeld !== false) throw new Error('写句柄的锁没有被释放');

  // 再取一次锁：路径必须由**新** header.cwd 推导（写入以后就落这里）。
  const lease = await post('/__selftest/ensure-lease', {});
  process.stdout.write('lease : ' + JSON.stringify({ headerCwd: lease.headerCwd, sessionDir: lease.sessionDir }) + '\n');
  if (lease.headerCwd !== dstWs) throw new Error('重新取锁时用的还是旧 cwd');
  if (!String(lease.sessionDir).includes(projectKey(dstWs))) throw new Error('锁的目录不是目标工作区的目录');

  // 让 DSH 自己的解码器重新读改写后的日志，并确认会话**还活着**。
  const after = await post('/describe', { sessionId });
  process.stdout.write('after : ' + JSON.stringify({
    cwd: after.session?.cwd, live: after.session?.live, unreadable: after.session?.unreadable ?? false,
  }) + '\n');
  if (after.session?.cwd !== dstWs) throw new Error('cwd 没有变成目标工作区');
  if (after.session?.live !== true) throw new Error('就地接管之后会话必须还活着');
  if (after.session?.unreadable === true) throw new Error('DSH 读不懂改写后的日志：' + String(after.session.message));

  const srcDir = join(HOME, 'sessions', projectKey(srcWs), encodeSegment(sessionId));
  const dstDir = join(HOME, 'sessions', projectKey(dstWs), encodeSegment(sessionId));
  if (existsSync(srcDir)) throw new Error('源目录还在：' + srcDir);
  if (!existsSync(dstDir)) throw new Error('目标目录不在：' + dstDir);

  // 压力循环再跑一会儿：旧目录**绝不能**被重建（那说明写入还落在旧路径）。
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (existsSync(srcDir)) throw new Error('旧目录被重建了 —— 写入仍然落在旧路径！');
  if (!existsSync(dstDir)) throw new Error('新目录消失了');

  await post('/__selftest/stop-pressure', {});
  const dropped = await post('/__selftest/drop', { sessionId, deleteWorkspacePaths: [srcWs, dstWs] });
  process.stdout.write('drop  : ' + JSON.stringify(dropped) + '\n');
  if (dropped.ok !== true) throw new Error('清理失败');
  if (existsSync(dstDir)) throw new Error('清理后目标目录还在');
  process.stdout.write('OK：就地接管（写链内搬 → 换 header → 释放锁 → 会话仍活 → 旧目录不复活 → 清理）全部正确\n');
}



const command = process.argv[2];
if (command === 'seed') seed();
else if (command === 'verify') await verify();
else if (command === 'live') await live();
else throw new Error('用法: node scripts/e2e.mjs <seed|verify|live>');
