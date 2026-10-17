/**
 * 真浏览器拖动验证：用 CDP 驱动一个 headless Chrome，在**真实 DSH 页面**上
 * 合成 HTML5 拖放事件，验证拖动搬移整条链路。
 *
 * 为什么需要它：单测里的 DOM 是替身，证明不了官方页面真的有那两个属性。
 * 这里断言的是真东西 —— 真实 DOM 里的 data-row-key、真事件流、真 /move。
 *
 * 用法（需要该 profile 打开 selftest: true）：
 *   $env:DSH_HOME = '<repo>\.live-home'
 *   node scripts/drag-verify.mjs --port 3203 --token <页面 token> [--chrome <路径>]
 *
 * @module dsh-session-relocate/scripts/drag-verify
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const flag = (name, fallback) => {
  const at = process.argv.indexOf('--' + name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
};
const PORT = flag('port', '3203');
const TOKEN = flag('token', '');
const BASE = 'http://127.0.0.1:' + PORT;
const API = BASE + '/api/dsh-session-relocate';
// 随机挑一个高位端口，免得上一轮残留的 Chrome 占着固定的那个。
const DEBUG_PORT = flag('debug-port', String(9400 + Math.floor(Math.random() * 500)));
const CHROME_CANDIDATES = [
  flag('chrome', ''),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((entry) => entry.length > 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('找不到 Chrome/Edge，用 --chrome <路径> 指定');
}

// 这个 DSH 版本的 /api 也走鉴权围栏：先用 token 换 cookie，再带着它调 API。
let cookie = '';
async function authenticate() {
  if (TOKEN.length === 0) return;
  const response = await fetch(BASE + '/?token=' + TOKEN, { redirect: 'follow' });
  const jar = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  cookie = jar.map((entry) => entry.split(';')[0]).join('; ');
  await response.text();
}

async function post(path, body) {
  const headers = { 'content-type': 'application/json' };
  if (cookie.length > 0) headers.cookie = cookie;
  const response = await fetch(API + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return await response.json();
}

/** 在页面里求值并取回结果。 */
async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails !== undefined) {
    throw new Error('页面里抛错：' + JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  }
  return result.result.value;
}

const profileDir = mkdtempSync(join(tmpdir(), 'dshsm-drag-'));
let chrome;
let exitCode = 0;
try {
  // 1) 先问主机：这个会话现在在哪个工作区，目标是哪个
  // 计划走文件（--plan-file）最稳：PowerShell 传 JSON 参数会把引号吃掉。
  const planFile = flag('plan-file', '');
  const plan = planFile.length > 0
    ? JSON.parse(readFileSync(planFile, 'utf8'))
    : JSON.parse(flag('plan', '') || '{}');
  const { sessionId, currentWorkspaceId, targetWorkspaceId } = plan;
  if (sessionId === undefined) throw new Error('需要 --plan-file <path> 或 --plan <json>（sessionId/currentWorkspaceId/targetWorkspaceId）');
  process.stdout.write('计划：把 ' + sessionId + ' 从 ' + currentWorkspaceId + ' 拖到 ' + targetWorkspaceId + '\n');

  await authenticate();

  // 2) 起一个 headless Chrome
  const chromePath = await findChrome();
  const url = TOKEN.length > 0 ? BASE + '/?token=' + TOKEN : BASE + '/';
  chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profileDir,
    '--window-size=1500,950', '--hide-scrollbars', url,
  ], { stdio: 'ignore' });

  // 3) 等调试端口，拿到页面 target
  let target = null;
  for (let attempt = 0; attempt < 60 && target === null; attempt += 1) {
    await sleep(500);
    try {
      const list = await (await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list')).json();
      target = list.find((entry) => entry.type === 'page' && typeof entry.webSocketDebuggerUrl === 'string') ?? null;
    } catch { /* 还没起来 */ }
  }
  if (target === null) throw new Error('Chrome 调试端口没起来');
  const send = await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');

  // 客户端半的检查放在侧边栏渲染**之后**：页面刚打开时脚本还没执行，早查必然为 null。

  // 4) 等真实页面把侧边栏渲染出来
  // 注意：会话行只在**它所在的分组展开**时才渲染，所以按 aria-expanded 精确展开源工作区，
  // 不能盲点（盲点会把已展开的分组折叠掉，来回切换）。
  const probe = `(() => {
    const rows = [...document.querySelectorAll('[data-row-key]')].map((row) => row.getAttribute('data-row-key'));
    return {
      rows: rows.slice(0, 40),
      sessions: rows.filter((key) => key.startsWith('session:')).length,
      workspaces: rows.filter((key) => key.startsWith('workspace:')).length,
      sourceCollapsed: (() => {
        const row = document.querySelector('[data-row-key="workspace:${currentWorkspaceId}"]');
        return row === null ? null : row.getAttribute('aria-expanded');
      })(),
      tree: [...document.querySelectorAll('[role="treeitem"]')].map((row) => ({
        key: row.getAttribute('data-row-key'),
        expanded: row.getAttribute('aria-expanded'),
        text: (row.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
      })),
      sidebarText: ((document.querySelector('aside') || document.body).innerText || '').slice(0, 400),
    };
  })()`;
  const expanded = new Map();
  let seen = { sessions: 0, workspaces: 0, rows: [], sourceCollapsed: null, sidebarText: '' };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    seen = await evaluate(send, probe);
    if (seen.sessions > 0 && seen.workspaces > 1) break;
    // 折叠的分组不渲染会话行 —— 点开它。每轮最多点一次，且点了之后必须看到状态变化。
    if (seen.sourceCollapsed === 'false' && (expanded.get(currentWorkspaceId) ?? 0) < 3) {
      expanded.set(currentWorkspaceId, (expanded.get(currentWorkspaceId) ?? 0) + 1);
      await evaluate(send, `(() => { const row = document.querySelector('[data-row-key="workspace:${currentWorkspaceId}"]'); if (row !== null) row.click(); return true; })()`);
      await sleep(400);
    }
  }
  // 证明「本插件的客户端半真的在这个页面里跑过」：apply() 会注入一个 style 标签，
  // 引导全局会带着 drag 开关，模块图里应当有我们的 client.js。
  // 引导全局两个名字都认（改名过渡期里主机侧可能还是旧版）。
  const bundleLive = await evaluate(send, `(() => {
    const boot = globalThis.__DSH_SESSION_RELOCATE__ ?? globalThis.__DSH_SESSION_MOVE__ ?? null;
    return {
      styleTag: document.querySelector('style[data-plugin-css="dsh-session-relocate-styles"]') !== null,
      boot: typeof boot === 'object' ? boot : null,
      inGraph: [...document.querySelectorAll('script[src]')].some((tag) => String(tag.src).includes('dsh-session-relocate/client.js')),
    };
  })()`);
  process.stdout.write('客户端半：' + JSON.stringify(bundleLive) + '\n');
  if (bundleLive.boot === null || bundleLive.boot.drag !== true) throw new Error('引导全局里没有 drag 开关');
  // style 标签是「我的 apply() 真的跑过」的硬证据。
  // （inGraph 只作参考：客户端 bundle 是运行时按需加载的，不一定以 <script src> 出现。）
  if (bundleLive.styleTag !== true) throw new Error('客户端半的 apply() 没跑（style 标签不在）');

  process.stdout.write('真实 DOM：会话行 ' + seen.sessions + ' 个，工作区行 ' + seen.workspaces + ' 个\n');
  if (seen.sessions === 0) {
    // 隔离 home 里造不出「DSH 自己创建、且有真实消息」的会话（那需要真跑一轮模型），
    // 而侧边栏不渲染空会话。于是退一步：按官方源码的属性注入一个会话行，
    // 用它验证**我的处理链路**（真页面 / 真事件 / 真 /move）。官方属性本身由
    // client.js:2250 的源码 + 工作区行的实测共同背书。
    if (flag('inject-row', '') !== 'true') {
      process.stdout.write('现场：data-row-key = ' + JSON.stringify(seen.rows) + '\n');
      process.stdout.write('源分组 aria-expanded = ' + String(seen.sourceCollapsed) + '\n');
      throw new Error('页面里找不到会话行（[data-row-key^="session:"]）；加 --inject-row true 可以退化为注入式验证');
    }
    await evaluate(send, `(() => {
      const anchor = document.querySelector('[data-row-key="workspace:${currentWorkspaceId}"]');
      if (anchor === null) return false;
      const row = document.createElement('div');
      row.setAttribute('data-row-key', 'session:${sessionId}');
      row.setAttribute('role', 'treeitem');
      row.style.cssText = 'height:26px;margin:2px 0;border-radius:4px;background:rgba(127,127,127,.25)';
      row.textContent = 'injected session row';
      anchor.parentElement.appendChild(row);
      return true;
    })()`);
    process.stdout.write('（真实会话行不存在：已按官方属性注入一行用于验证处理链路）\n');
    seen = await evaluate(send, probe);
    if (seen.sessions === 0) throw new Error('注入会话行失败');
  }
  if (seen.workspaces < 2) throw new Error('需要至少两个工作区行才能测拖动');

  // 5) 合成一次真实拖放
  const dragScript = `(() => {
    const sessionRow = document.querySelector('[data-row-key="session:${sessionId}"]');
    const wsRow = document.querySelector('[data-row-key="workspace:${targetWorkspaceId}"]');
    if (sessionRow === null) return { error: '找不到会话行' };
    if (wsRow === null) return { error: '找不到目标工作区行' };
    const transfer = new DataTransfer();
    const fire = (type, target) => {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(event);
      return { prevented: event.defaultPrevented };
    };
    const started = fire('dragstart', sessionRow);
    const over = fire('dragover', wsRow);
    const highlighted = wsRow.classList.contains('dshsm-drop');
    const dropped = fire('drop', wsRow);
    return {
      started: started.prevented,
      overPrevented: over.prevented,
      highlighted,
      dropPrevented: dropped.prevented,
      highlightCleared: !wsRow.classList.contains('dshsm-drop'),
    };
  })()`;
  const drag = await evaluate(send, dragScript);
  process.stdout.write('合成拖放：' + JSON.stringify(drag) + '\n');
  if (drag.error !== undefined) throw new Error(drag.error);
  if (drag.overPrevented !== true) throw new Error('dragover 没有被接管（preventDefault 没发生）');
  if (drag.highlighted !== true) throw new Error('目标工作区行没有被高亮');
  if (drag.dropPrevented !== true) throw new Error('drop 没有被接管');
  if (drag.highlightCleared !== true) throw new Error('投放后高亮没有撤掉');

  // 6) 等主机侧的迁移真的落地
  let moved = false;
  let last = null;
  for (let attempt = 0; attempt < 30 && !moved; attempt += 1) {
    await sleep(500);
    last = await post('/describe', { sessionId });
    moved = last.session !== undefined && last.session !== null && last.session.currentWorkspaceId === targetWorkspaceId;
  }
  process.stdout.write('拖后归属：' + String(last?.session?.currentWorkspaceId) + '（cwd ' + String(last?.session?.cwd) + '）\n');
  if (!moved) throw new Error('拖动之后会话没有落到目标工作区');
  process.stdout.write('OK：真浏览器里拖动搬移成功（真实 DOM 约定 + 真事件流 + 真迁移）\n');
} catch (error) {
  exitCode = 1;
  process.stdout.write('失败：' + String(error && error.message) + '\n');
} finally {
  if (chrome !== undefined) chrome.kill();
  await sleep(800);
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    // Chrome 还占着这个目录，无所谓 —— 它在系统临时目录里。
  }
  process.exit(exitCode);
}
