/**
 * 真机拖动接线检查（**只读**）：对着**正在运行的** DSH Web 打开一个 headless Chrome，
 * 在真实侧边栏上验证拖动接线 —— 它只合成 dragstart / dragover / dragend，
 * **绝不投放（drop）**，所以永远不会搬动任何会话。
 *
 * 为什么需要它：单测里的 DOM 是替身，隔离 home 里又造不出「DSH 自己创建、有真实消息」的会话，
 * 于是「真实侧边栏里的分组结构」一直只能靠源码背书。这个脚本补上那一段。
 *
 * 它验证的是**分组归属规则**：整块工作区分组（文件夹行 + 它的会话行 + 分组空隙）都是投放目标，
 * 落在**别的**分组里就接管，落在**它自己所在**的分组里完全让路（官方组内排序不受影响）。
 *
 * 用法：
 *   node scripts/drag-live-check.mjs                      # token 从 ~/.dsh/dsh-web-auth.log 读
 *   node scripts/drag-live-check.mjs --port 3080 --token <页面 token> [--chrome <路径>]
 *
 * 退出码 0 = 接线正常；1 = 有断言不成立（打印每一项的实际值）。
 *
 * @module dsh-session-relocate/scripts/drag-live-check
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const flag = (name, fallback) => {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
};
const PORT = flag('port', '3080');
const BASE = 'http://127.0.0.1:' + PORT;
const DEBUG_PORT = flag('debug-port', String(9600 + Math.floor(Math.random() * 300)));
const CHROME_CANDIDATES = [
  flag('chrome', ''),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((entry) => entry.length > 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** token 优先取参数，其次从 DSH 自己的启动日志里读（那个日志只有本机可读）。 */
function resolveToken() {
  const given = flag('token', '');
  if (given.length > 0) return given;
  const log = join(homedir(), '.dsh', 'dsh-web-auth.log');
  if (existsSync(log) === false) return '';
  const match = readFileSync(log, 'utf8').match(/token=([A-Za-z0-9._~-]+)/);
  return match === null ? '' : match[1];
}

/** 极小的 CDP 客户端（只用 Node 自带的 WebSocket）。 */
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    ws.addEventListener('error', (error) => reject(new Error('CDP 连接失败：' + String(error.message))));
    ws.addEventListener('open', () => {
      resolve((method, params) => new Promise((res, rej) => {
        const id = nextId += 1;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }));
      }));
    });
  });
}

const failures = [];
function expect(label, actual, wanted) {
  const ok = actual === wanted;
  process.stdout.write((ok ? '  ok   ' : '  FAIL ') + label + ' = ' + JSON.stringify(actual) + (ok ? '' : '（期望 ' + JSON.stringify(wanted) + '）') + '\n');
  if (ok === false) failures.push(label);
}

const token = resolveToken();
const url = token.length > 0 ? BASE + '/?token=' + token : BASE + '/';
const profileDir = mkdtempSync(join(tmpdir(), 'dshsm-live-'));
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
let chrome;
let ws;
try {
  if (chromePath === undefined) throw new Error('找不到 Chrome/Edge，用 --chrome <路径> 指定');
  process.stdout.write('目标：' + BASE + (token.length > 0 ? '（带 token）' : '（无 token）') + '\n');
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profileDir,
    '--window-size=1400,900', '--hide-scrollbars', url,
  ], { stdio: 'ignore' });

  let target = null;
  for (let attempt = 0; attempt < 60 && target === null; attempt += 1) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
      target = list.find((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string') ?? null;
    } catch { /* 还没起来 */ }
  }
  if (target === null) throw new Error('Chrome 调试端口没起来');
  ws = await connect(target.webSocketDebuggerUrl);
  await ws('Runtime.enable');
  await ws('Page.enable');
  const evaluate = async (expression) => {
    const result = await ws('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error('页面里抛错：' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    }
    return result.result.value;
  };

  // 侧边栏要等一会儿才渲染；折叠的分组不渲染会话行，点开它。
  const probe = `(() => {
    const rows = [...document.querySelectorAll('[data-row-key]')].map((row) => row.getAttribute('data-row-key'));
    return {
      sessions: rows.filter((key) => key.startsWith('session:')).length,
      workspaces: rows.filter((key) => key.startsWith('workspace:') && key.length > 'workspace:'.length).length,
    };
  })()`;
  let seen = { sessions: 0, workspaces: 0 };
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(800);
    seen = await evaluate(probe);
    if (seen.workspaces > 1) break;
    await evaluate(`(() => {
      const row = document.querySelector('[data-row-key^="workspace:"][aria-expanded="false"]');
      if (row === null) return false;
      row.click();
      return true;
    })()`);
  }

  // 客户端半真的在页面里跑过吗？（apply() 注入的 style 标签 + 引导全局）
  // 引导全局两个名字都认：改名过渡期里主机侧可能还是旧版。
  const boot = await evaluate(`(() => {
    const boot = globalThis.__DSH_SESSION_RELOCATE__ ?? globalThis.__DSH_SESSION_MOVE__ ?? null;
    return {
      styleTag: document.querySelector('style[data-plugin-css="dsh-session-relocate-styles"]') !== null,
      boot: typeof boot === 'object' ? boot : null,
    };
  })()`);
  process.stdout.write('客户端半：' + JSON.stringify(boot) + '\n');
  expect('客户端半 apply() 跑过（style 标签）', boot.styleTag, true);
  expect('引导全局 drag 开关', boot.boot === null ? null : boot.boot.drag, true);

  /**
   * 分组契约：官方每个工作区渲染成一个分组容器（renderGroup → div.groupSection），
   * 它「恰好只含一个工作区行」。这里在**真实 DOM** 上把这条契约验一遍，
   * 并顺手数一下每个分组里有几条真实会话行。
   */
  const groupContract = await evaluate(`(() => {
    const WORKSPACE = '[data-row-key^="workspace:"]';
    const groups = [];
    for (const row of document.querySelectorAll(WORKSPACE)) {
      const key = row.getAttribute('data-row-key');
      if (key.length <= 'workspace:'.length) continue;
      let node = row;
      let best = null;
      for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
        if (node.getAttribute && node.getAttribute('role') === 'tree') break;
        const rows = node.querySelectorAll(WORKSPACE);
        if (rows.length > 1) break;
        if (rows.length === 1) best = node;
        node = node.parentElement;
      }
      if (best === null) { groups.push({ key, section: false }); continue; }
      const sessions = [...best.querySelectorAll('[data-row-key^="session:"]')].map((r) => r.getAttribute('data-row-key'));
      groups.push({ key, section: true, sessions: sessions.length, isTree: best.getAttribute('role') === 'tree' });
    }
    return { groups, treeRows: document.querySelectorAll('[role="tree"] [data-row-key^="workspace:"]').length };
  })()`);
  process.stdout.write('真实 DOM：工作区分组 ' + groupContract.groups.length + ' 个（会话行 ' + seen.sessions + ' 条）\n');
  for (const group of groupContract.groups) {
    process.stdout.write('  ' + group.key + ' → 分组容器=' + group.section + '，组内真实会话行=' + (group.sessions === undefined ? '-' : group.sessions) + '\n');
  }
  expect('每个工作区行都能找到自己的分组容器', groupContract.groups.every((group) => group.section === true), true);
  expect('分组容器都不是整棵列表（role="tree"）', groupContract.groups.every((group) => group.isTree === false), true);
  expect('至少有两个工作区分组可做跨组投放', groupContract.groups.length > 1, true);
  if (groupContract.groups.length < 2) throw new Error('侧边栏里不足两个工作区分组，没法验证跨组投放');

  const sourceGroup = groupContract.groups[0];
  const targetGroup = groupContract.groups[1];
  process.stdout.write('合成拖动：' + sourceGroup.key + ' → ' + targetGroup.key + '（只 dragstart/dragover/dragend，不 drop）\n');

  /**
   * 在真实分组容器里取/造一条会话行：
   *   - 组里本来就有真实会话行（你的 DSH 里有会话）→ 直接用真的；
   *   - 没有（全新 home / 侧边栏还没列会话）→ 按官方属性在**真实分组容器**里补一条。
   * 补的那条只活在这个一次性的 headless 页面里。
   */
  const result = await evaluate(`(() => {
    const WORKSPACE = '[data-row-key^="workspace:"]';
    const sectionOf = (row) => {
      let node = row;
      let best = null;
      for (let depth = 0; depth < 8 && node !== null && node !== undefined; depth += 1) {
        if (node.getAttribute && node.getAttribute('role') === 'tree') break;
        const rows = node.querySelectorAll(WORKSPACE);
        if (rows.length > 1) break;
        if (rows.length === 1) best = node;
        node = node.parentElement;
      }
      return best;
    };
    const sectionFor = (key) => {
      const row = document.querySelector('[data-row-key="' + key + '"]');
      return row === null ? null : sectionOf(row);
    };
    const sessionRowIn = (section, workspaceKey) => {
      const real = section.querySelector('[data-row-key^="session:"]');
      if (real !== null) return { row: real, injected: false };
      const row = document.createElement('div');
      row.setAttribute('data-row-key', 'session:live-check-' + workspaceKey);
      section.appendChild(row);
      return { row, injected: true };
    };

    const sourceSection = sectionFor('${sourceGroup.key}');
    const targetSection = sectionFor('${targetGroup.key}');
    if (sourceSection === null || targetSection === null) return { error: 'section-missing' };

    const dragged = sessionRowIn(sourceSection, 'src');
    const dropped = sessionRowIn(targetSection, 'dst');
    const transfer = new DataTransfer();
    globalThis.__dshsmTransfer = transfer;

    const out = { injectedSource: dragged.injected, injectedTarget: dropped.injected };
    dragged.row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));

    // 1) **立刻**（同一个 tick、还没等任何网络往返）把指针移到源分组里的另一条会话行上：
    //    插件必须已经知道源工作区，并且完全让路（官方组内排序照旧）。
    const sameGroupRow = document.createElement('div');
    sameGroupRow.setAttribute('data-row-key', 'session:live-check-same-group');
    sourceSection.appendChild(sameGroupRow);
    const sameOver = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    sameGroupRow.dispatchEvent(sameOver);
    out.sameGroupPrevented = sameOver.defaultPrevented;

    // 2) 移到**别的分组里的会话行**上 → 必须接管，并高亮整块目标分组。
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    dropped.row.dispatchEvent(over);
    out.overPrevented = over.defaultPrevented;
    out.targetHighlighted = targetSection.classList.contains('dshsm-drop');
    out.sourceHighlighted = sourceSection.classList.contains('dshsm-drop');
    out.dropEffect = transfer.dropEffect;
    targetSection.scrollIntoView({ block: 'center' });
    return out;
  })()`);
  if (result.error !== undefined) throw new Error('页面里找不到分组容器：' + result.error);
  process.stdout.write('会话行来源：源分组 ' + (result.injectedSource ? '注入（该分组里没有真实会话）' : '真实') + '，目标分组 ' + (result.injectedTarget ? '注入' : '真实') + '\n');
  expect('落在别的分组里的会话行上被接管（preventDefault）', result.overPrevented, true);
  expect('整块目标分组被高亮', result.targetHighlighted, true);
  expect('源分组没有被高亮', result.sourceHighlighted, false);
  expect('落在自己分组里的会话行上完全让路（官方组内排序）', result.sameGroupPrevented, false);

  // 收尾：结束拖动（不投放 → 什么都没搬）。
  const after = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-row-key^="session:live-check-"]')];
    const first = rows[0] ?? document.querySelector('[data-row-key^="session:"]');
    if (first !== null) first.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: globalThis.__dshsmTransfer }));
    for (const row of rows) row.remove();
    return { highlightsLeft: document.querySelectorAll('.dshsm-drop').length, toast: document.querySelector('[data-dshsm-toast]')?.textContent ?? null };
  })()`);
  expect('dragend 后没有残留高亮', after.highlightsLeft, 0);
  expect('全程没有搬移（没有提示条）', after.toast, null);
} catch (error) {
  failures.push(String(error?.message ?? error));
  process.stdout.write('错误：' + String(error?.stack ?? error) + '\n');
} finally {
  try { ws?.close(); } catch { /* 关不掉就算了 */ }
  try { chrome?.kill(); } catch { /* 同上 */ }
  await sleep(800);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 同上 */ }
}
process.stdout.write(failures.length === 0 ? 'OK：真实页面拖动接线正常（未投放，未搬移任何会话）\n' : 'FAIL：' + failures.length + ' 项不成立\n');
process.exit(failures.length === 0 ? 0 : 1);
