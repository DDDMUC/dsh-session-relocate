/**
 * 客户端 bundle 的行为测试。
 *
 * 不依赖浏览器：自己造 window.__ModuleLoader__ 抓取工厂，用极小的 react 替身
 * （useState 在多次渲染之间保留状态）跑组件状态机，并把 fetch 换成可断言的桩。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SESSION_ID = 'session-abc12345-0000-4000-8000-000000000001';
const PREFIX = '/api/dsh-session-relocate';

/** 抓取 bundle 注册的工厂。 */
async function loadBundle() {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry; } } };
  await import('../lib/client.js?case=' + String(Date.now()) + '-' + String(Math.random()));
  assert.ok(captured !== null, 'bundle 应当调用 window.__ModuleLoader__.load');
  return captured;
}

/** 极小的 react 替身：createElement + 跨渲染保留状态的 useState。 */
function makeReact() {
  const cells = [];
  let cursor = 0;
  return {
    Fragment: 'Fragment',
    createElement(type, props) {
      const children = Array.prototype.slice.call(arguments, 2).flat(Infinity)
        .filter((child) => child !== null && child !== undefined && child !== false);
      return { type, props: props === null || props === undefined ? {} : props, children };
    },
    useState(initial) {
      const at = cursor;
      cursor += 1;
      if (cells[at] === undefined) cells[at] = { value: initial };
      const cell = cells[at];
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
    },
    reset() { cursor = 0; },
  };
}

function collectButtons(node, out) {
  const found = out === undefined ? [] : out;
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) collectButtons(child, found);
    return found;
  }
  if (node.type === 'button') found.push(node);
  if (node.children !== undefined) collectButtons(node.children, found);
  return found;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node !== null && typeof node === 'object' && node.children !== undefined) return textOf(node.children);
  return '';
}

function makeFetch(routes) {
  const calls = [];
  const impl = async (url, options) => {
    const body = options !== undefined && typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
    calls.push({ url, body });
    for (const suffix of Object.keys(routes)) {
      if (url.endsWith(suffix)) {
        return { status: 200, json: async () => routes[suffix](body) };
      }
    }
    throw new Error('unexpected fetch: ' + url);
  };
  return { impl, calls };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 把一个 bundle 挂起来，返回渲染器与调用记录。 */
async function mount(routes) {
  const entry = await loadBundle();
  const react = makeReact();
  const api = entry.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });

  let injectedSlot = null;
  let registration = null;
  let disposer = null;
  const fakeCtx = {
    slots: {
      inject(slot, factory) {
        injectedSlot = slot;
        disposer = factory();
        return disposer;
      },
      register(spec, component) {
        registration = { spec, component };
        return () => {};
      },
    },
  };
  const returned = api.apply(fakeCtx);

  const fetchHarness = makeFetch(routes);
  globalThis.fetch = fetchHarness.impl;
  globalThis.__DSH_SESSION_RELOCATE__ = { prefix: PREFIX };
  // Node 25 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖。
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });

  const menuOpens = [];
  const props = {
    sessionId: SESSION_ID,
    displayTitle: '演示对话',
    useMenuOpenState: () => [true, (open) => menuOpens.push(open)],
  };

  const render = () => {
    react.reset();
    return registration.component(props);
  };
  const renderApi = () => {
    const saved = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('rendering must not fetch'); };
    try { return api.__entry(props); } finally { globalThis.fetch = saved; }
  };

  return { api, entry, fakeCtx, injectedSlot, registration, returned, props, render, renderApi, calls: fetchHarness.calls, menuOpens, buttons: (tree) => collectButtons(tree) };
}

test('兼容：主机侧还注入旧引导全局名时，客户端照样用它的前缀（改名过渡期）', async () => {
  const harness = await mount({
    '/describe': () => ({ ok: true, workspaces: [], session: { id: SESSION_ID, canMove: true, reason: null } }),
  });
  // mount() 默认给的是新名字；这里模拟「主机侧还没重启、只有旧名字」的那半截状态。
  delete globalThis.__DSH_SESSION_RELOCATE__;
  globalThis.__DSH_SESSION_MOVE__ = { prefix: '/api/legacy-move' };
  harness.buttons(harness.render())[0].props.onClick();
  await flush();
  assert.equal(harness.calls[0].url, '/api/legacy-move/describe', '应当用旧引导全局里的前缀，而不是新默认值');
  delete globalThis.__DSH_SESSION_MOVE__;
});

test('bundle 形状：id/工厂/导出与 slot 注册都对', async () => {
  const harness = await mount({});
  assert.equal(harness.entry.id, 'dsh-session-relocate');
  assert.equal(typeof harness.entry.factory, 'function');
  assert.deepEqual(harness.api.inject, ['slots']);
  assert.equal(harness.injectedSlot, 'sidebar.workspaces.session.menu.item');
  assert.deepEqual(harness.registration.spec, {
    name: 'sidebar.workspaces.session.menu.item', id: 'session-relocate', order: 350,
  });
  assert.equal(typeof harness.registration.component, 'function');
  assert.equal(typeof harness.returned, 'function', 'apply 应当返回 disposer');
});

test('idle：只渲染一个可点的菜单项', async () => {
  const harness = await mount({});
  const buttons = harness.buttons(harness.render());
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.role, 'menuitem');
  assert.equal(buttons[0].props.type, 'button');
  assert.equal(buttons[0].props.disabled, undefined);
  assert.equal(textOf(buttons[0]), '移动到');
});

test('点击后列出其它工作区（排除当前所在的），并可选中执行', async () => {
  const harness = await mount({
    '/describe': () => ({
      ok: true,
      workspaces: [
        { id: 'ws-a', title: '工作区 A', path: 'E:\\A', current: true },
        { id: 'ws-b', title: '工作区 B', path: 'E:\\B', current: false },
        { id: 'ws-c', title: '工作区 C', path: 'E:\\C' },
      ],
      session: { id: SESSION_ID, canMove: true, reason: null, currentWorkspaceId: 'ws-a' },
    }),
    '/move': (body) => ({ ok: true, applied: 'live', targetTitle: '工作区 B', sessionId: body.sessionId }),
  });

  harness.buttons(harness.render())[0].props.onClick();
  await flush();

  const picking = harness.buttons(harness.render());
  const texts = picking.map(textOf);
  assert.equal(texts.some((entry) => entry.includes('工作区 A')), false, '当前工作区不该出现在候选里');
  assert.ok(texts.some((entry) => entry.includes('工作区 B')));
  assert.ok(texts.some((entry) => entry.includes('工作区 C')));
  assert.ok(texts.some((entry) => entry.includes('其它目录')));

  assert.deepEqual(harness.calls[0], { url: PREFIX + '/describe', body: { sessionId: SESSION_ID } });
  assert.equal(harness.calls[0].url.startsWith(PREFIX), true, '应当使用主机下发的桥接前缀');

  const targetIndex = textingIndex(picking, '工作区 B');
  picking[targetIndex].props.onClick();
  await flush();

  assert.deepEqual(harness.calls[1], {
    url: PREFIX + '/move',
    body: { sessionId: SESSION_ID, targetWorkspaceId: 'ws-b' },
  });
  const done = harness.buttons(harness.render());
  assert.match(textOf(done[0]), /已移动.*工作区 B/);
  assert.deepEqual(harness.menuOpens, [false], '成功后应当关掉菜单');
});

function textingIndex(buttons, needle) {
  for (let i = 0; i < buttons.length; i++) {
    if (textOf(buttons[i]).includes(needle)) return i;
  }
  throw new Error('找不到按钮：' + needle);
}

test('不可移动时显示原因（disabled），且不会调 move', async () => {
  const harness = await mount({
    '/describe': () => ({
      ok: true,
      workspaces: [],
      session: { id: SESSION_ID, canMove: false, reason: '这个对话当前正打开着，请先切到别的对话再移动', live: true },
    }),
  });
  harness.buttons(harness.render())[0].props.onClick();
  await flush();
  const buttons = harness.buttons(harness.render());
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true);
  assert.match(textOf(buttons[0]), /正打开着/);
  assert.equal(harness.calls.length, 1, '只应当有 describe 这一次请求');
});

test('选择其它目录时用 prompt 的路径调 move', async () => {
  const harness = await mount({
    '/describe': () => ({ ok: true, workspaces: [], session: { id: SESSION_ID, canMove: true, reason: null } }),
    '/move': () => ({ ok: true, applied: 'live', targetTitle: '新目录' }),
  });
  globalThis.prompt = () => '  D:\\示例\\新目录  ';
  harness.buttons(harness.render())[0].props.onClick();
  await flush();
  const picking = harness.buttons(harness.render());
  picking[textingIndex(picking, '其它目录')].props.onClick();
  await flush();
  assert.deepEqual(harness.calls[1].body, { sessionId: SESSION_ID, targetPath: 'D:\\示例\\新目录' });
});

test('prompt 被取消时什么都不做', async () => {
  const harness = await mount({
    '/describe': () => ({ ok: true, workspaces: [], session: { id: SESSION_ID, canMove: true, reason: null } }),
  });
  globalThis.prompt = () => null;
  harness.buttons(harness.render())[0].props.onClick();
  await flush();
  const picking = harness.buttons(harness.render());
  picking[textingIndex(picking, '其它目录')].props.onClick();
  await flush();
  assert.equal(harness.calls.length, 1, '取消 prompt 不应该发起 move');
});

test('收尾待补时给出明确提示；桥接报错时显示失败原因', async () => {
  const oneTarget = [{ id: 'ws-b', title: '工作区 B', path: 'E:\\B' }];
  const pending = await mount({
    '/describe': () => ({ ok: true, workspaces: oneTarget, session: { id: SESSION_ID, canMove: true, reason: null } }),
    '/move': () => ({ ok: true, applied: 'pending', targetTitle: '工作区 B' }),
  });
  pending.buttons(pending.render())[0].props.onClick();
  await flush();
  const pendingPicking = pending.buttons(pending.render());
  pendingPicking[textingIndex(pendingPicking, '工作区 B')].props.onClick();
  await flush();
  assert.match(textOf(pending.buttons(pending.render())[0]), /下次启动 DSH 时自动补齐/);

  const failed = await mount({
    '/describe': () => ({ ok: true, workspaces: oneTarget, session: { id: SESSION_ID, canMove: true, reason: null } }),
    '/move': () => ({ ok: false, code: 'session-live', message: '这个对话当前正打开着' }),
  });
  failed.buttons(failed.render())[0].props.onClick();
  await flush();
  const failedPicking = failed.buttons(failed.render());
  failedPicking[textingIndex(failedPicking, '工作区 B')].props.onClick();
  await flush();
  const tree = failed.buttons(failed.render())[0];
  assert.equal(tree.props.disabled, true);
  assert.match(textOf(tree), /移动失败.*正打开着/);
});

// ── 拖动搬移 ────────────────────────────────────────────────────────────────
// 官方 DOM 约定（client-ui-workspace）：
//   - 每个工作区渲染成一个**分组容器**（renderGroup → div.groupSection）：里面先放工作区行
//     data-row-key="workspace:<workspaceId>"，再放它自己的会话行 data-row-key="session:<id>"；
//   - 整棵列表是 role="tree"，包含所有分组。
// 本插件的规则：指针在**别的**分组里（文件夹行 / 它的任意会话行 / 分组空隙）就接管并搬过去；
// 指针在**它自己所在**的分组里就完全让路，官方的工作区内排序照旧。

function makeClassList() {
  const set = new Set();
  return { add: (name) => set.add(name), remove: (name) => set.delete(name), contains: (name) => set.has(name) };
}

function matchesSelector(element, selector) {
  const match = /^\[data-row-key\^="([^"]+)"\]$/.exec(selector);
  if (match === null) return false;
  const key = element.getAttribute('data-row-key');
  return typeof key === 'string' && key.indexOf(match[1]) === 0;
}

/** 极小的元素替身：只实现本插件用到的那几样（属性 / 父指针 / classList / querySelectorAll）。 */
function makeElement(key) {
  const attributes = {};
  if (key !== undefined) attributes['data-row-key'] = key;
  const element = {
    parentElement: null,
    children: [],
    style: {},
    classList: makeClassList(),
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
    },
    appendChild(child) {
      child.parentElement = element;
      element.children.push(child);
      return child;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (matchesSelector(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(element);
      return found;
    },
  };
  return element;
}

/** 行外面套一层 wrapper（真实 DOM 就是这样），用来验证「向上走到分组」这一步。 */
function makeWrappedRow(key) {
  const wrapper = makeElement();
  wrapper.appendChild(makeElement(key));
  return wrapper;
}

/** 造一个工作区分组：容器 + 文件夹行 + 它的会话行（都套着 wrapper）。 */
function makeGroup(workspaceId, sessionIds) {
  const section = makeElement();
  section.appendChild(makeWrappedRow('workspace:' + workspaceId));
  for (const id of sessionIds === undefined ? [] : sessionIds) section.appendChild(makeWrappedRow('session:' + id));
  return section;
}

/** 把分组挂进一棵 role="tree" 的列表里（真实结构就是这样）。 */
function makeTree(sections) {
  const tree = makeElement();
  for (const section of sections) tree.appendChild(section);
  return tree;
}

function rowsIn(section, prefix) {
  return section.querySelectorAll('[data-row-key^="' + prefix + '"]');
}

function makeFakeDocument() {
  const listeners = new Map();
  const hostMarks = [];
  const dispatched = [];
  const body = {
    children: [],
    appendChild(node) { body.children.push(node); node.parentNode = body; },
    contains: () => true,
  };
  const doc = {
    body,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    createElement() { return { style: {}, textContent: '', parentNode: null, setAttribute() {} }; },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '.dsdel-check-on' ? hostMarks : []; },
    dispatchEvent(event) { dispatched.push(event); return true; },
  };
  return { doc, listeners, hostMarks, dispatched };
}

function makeEvent(target) {
  return {
    target,
    defaultPrevented: false,
    propagationStopped: false,
    dataTransfer: { dropEffect: '' },
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

/** 挂一个只装了拖动那半的 bundle。 */
async function mountDrag(routes) {
  const entry = await loadBundle();
  const react = makeReact();
  const api = entry.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });
  const { doc, listeners, hostMarks, dispatched } = makeFakeDocument();
  globalThis.document = doc;
  const fetchHarness = makeFetch(routes);
  globalThis.fetch = fetchHarness.impl;
  globalThis.__DSH_SESSION_RELOCATE__ = { prefix: PREFIX };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
  const uninstall = api.__drag.installDrag();
  return { api, drag: api.__drag, listeners, calls: fetchHarness.calls, uninstall, doc, hostMarks, dispatched };
}

const OTHER_SESSION = 'session-other-0000-4000-8000-000000000002';

test('拖动：挂 5 个 document 级监听；dragstart 直接从分组认出源工作区（不问主机）', async () => {
  const harness = await mountDrag({ '/describe': () => { throw new Error('DOM 读得到就不该问主机'); } });
  assert.equal(harness.listeners.size, 5, '应当挂 dragstart/dragover/drop/dragend/dragleave');

  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  assert.equal(harness.drag.state.sessionId, SESSION_ID, 'dragstart 应当从 data-row-key 认出会话 id');
  assert.equal(harness.drag.state.sourceWorkspaceId, 'ws-src', '源工作区应当直接从 DOM 分组读出来');
  assert.equal(harness.calls.length, 0, 'DOM 读得到就不该再问主机');
  delete globalThis.document;
});

test('拖动：拖到**别的分组里的会话行**上也接管，并高亮整块分组', async () => {
  const harness = await mountDrag({});
  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const over = makeEvent(rowsIn(dst, 'session:')[0]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, true, '别的分组里的会话行也是投放目标');
  assert.equal(over.dataTransfer.dropEffect, 'move');
  assert.equal(dst.classList.contains('dshsm-drop'), true, '整块目标分组应当被高亮');
  assert.equal(src.classList.contains('dshsm-drop'), false, '源分组不该被高亮');

  harness.drag.onDragEnd();
  assert.equal(dst.classList.contains('dshsm-drop'), false, 'dragend 之后要撤掉高亮');
  assert.equal(harness.drag.state.sessionId, null);
  delete globalThis.document;
});

test('拖动：拖到别的分组的文件夹行上照样接管（老行为保留）', async () => {
  const harness = await mountDrag({});
  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', []);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const over = makeEvent(rowsIn(dst, 'workspace:')[0]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, true);
  assert.equal(dst.classList.contains('dshsm-drop'), true, '高亮的是整块分组');
  delete globalThis.document;
});

test('拖动：拖到**自己所在分组**里的会话行上完全让路（官方组内排序不受影响）', async () => {
  const harness = await mountDrag({});
  const src = makeGroup('ws-src', [SESSION_ID, OTHER_SESSION]);
  makeTree([src, makeGroup('ws-dst', [])]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const over = makeEvent(rowsIn(src, 'session:')[1]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, false, '同一个分组 = 官方的工作区内排序区，不能抢');
  assert.equal(harness.drag.state.targetSection, null, '也不该高亮');
  assert.equal(src.classList.contains('dshsm-drop'), false);
  delete globalThis.document;
});

test('拖动：拖到自己分组的文件夹行上也不接管', async () => {
  const harness = await mountDrag({});
  const src = makeGroup('ws-src', [SESSION_ID]);
  makeTree([src]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const over = makeEvent(rowsIn(src, 'workspace:')[0]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, false, '落在源分组里一律让路');
  delete globalThis.document;
});

test('拖动：指针落在整棵列表（不在任何分组里）完全不介入', async () => {
  const harness = await mountDrag({});
  const src = makeGroup('ws-src', [SESSION_ID]);
  const tree = makeTree([src, makeGroup('ws-dst', [OTHER_SESSION])]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const over = makeEvent(tree);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, false, '含多个工作区行的祖先 = 列表本身，不是分组');
  delete globalThis.document;
});

test('拖动：投放到别的分组的会话行上就真的搬，并弹提示', async () => {
  const harness = await mountDrag({
    '/move': () => ({ ok: true, applied: 'live', targetTitle: '目标工作区' }),
  });
  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const drop = makeEvent(rowsIn(dst, 'session:')[0]);
  harness.drag.onDrop(drop);
  assert.equal(drop.propagationStopped, true, '必须吃掉事件，免得官方也处理一次');
  assert.equal(drop.defaultPrevented, true);

  const moves = harness.calls.filter((call) => call.url === PREFIX + '/move');
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0].body, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst' });
  assert.equal(harness.drag.state.sessionId, null, '投放后要清状态');

  await flush();
  assert.match(harness.doc.body.children[0].textContent, /已移动到「目标工作区」/);
  delete globalThis.document;
});

test('拖动：落到它自己所在的分组里不搬', async () => {
  const harness = await mountDrag({ '/move': () => ({ ok: true }) });
  const src = makeGroup('ws-src', [SESSION_ID, OTHER_SESSION]);
  makeTree([src]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const drop = makeEvent(rowsIn(src, 'session:')[1]);
  harness.drag.onDrop(drop);
  assert.equal(drop.defaultPrevented, false, '同分组不该接管');
  assert.equal(harness.calls.filter((call) => call.url === PREFIX + '/move').length, 0);
  delete globalThis.document;
});

test('拖动：拖工作区行不会被误判成拖会话（官方工作区排序不受影响）', async () => {
  const harness = await mountDrag({});
  const src = makeGroup('ws-a', []);
  const dst = makeGroup('ws-b', []);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'workspace:')[0]));
  assert.equal(harness.drag.state.sessionId, null);
  const over = makeEvent(rowsIn(dst, 'workspace:')[0]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, false);
  delete globalThis.document;
});

test('拖动：没有 dragstart 的 drop 什么都不做', async () => {
  const harness = await mountDrag({ '/move': () => ({ ok: true }) });
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([dst]);
  const drop = makeEvent(rowsIn(dst, 'session:')[0]);
  harness.drag.onDrop(drop);
  assert.equal(drop.defaultPrevented, false);
  assert.equal(harness.calls.length, 0);
  delete globalThis.document;
});

test('拖动：搬失败时把服务端的话原样弹出来', async () => {
  const harness = await mountDrag({
    '/move': () => ({ ok: false, code: 'already-there', message: '这个对话已经在「目标工作区」里了。' }),
  });
  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  harness.drag.onDrop(makeEvent(rowsIn(dst, 'session:')[0]));
  await flush();
  assert.match(harness.doc.body.children[0].textContent, /移动失败：这个对话已经在/);
  delete globalThis.document;
});

test('拖动：读不到分组结构时退化成「只认工作区行」的老行为，且不误伤官方排序', async () => {
  const harness = await mountDrag({
    '/describe': () => ({ ok: true, session: { id: SESSION_ID, currentWorkspaceId: 'ws-src' } }),
  });
  // 裸行：没有任何分组容器（模拟结构变了 / 老版本 DSH）。
  const sessionRow = makeElement('session:' + SESSION_ID);
  harness.drag.onDragStart(makeEvent(sessionRow));
  await flush();
  assert.equal(harness.drag.state.sourceWorkspaceId, 'ws-src', 'DOM 读不到分组就退回问主机');

  const bareSession = makeEvent(makeElement('session:' + OTHER_SESSION));
  harness.drag.onDragOver(bareSession);
  assert.equal(bareSession.defaultPrevented, false, '裸会话行仍然完全让路（官方排序）');

  const bareWorkspace = makeElement('workspace:ws-dst');
  const over = makeEvent(bareWorkspace);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, true, '退化路径下工作区行照旧可投放');
  assert.equal(bareWorkspace.classList.contains('dshsm-drop'), true, '退化路径高亮那一行本身');
  delete globalThis.document;
});

test('拖动：重复 install 只挂一套监听；卸载其中一个后拖动仍然有效（幂等）', async () => {
  const harness = await mountDrag({});
  const firstUninstall = harness.uninstall;
  const secondUninstall = harness.drag.installDrag();
  assert.equal(harness.listeners.size, 5, '第二次 install 不应重复挂监听');

  // 模拟「旧 effect 的 disposer 先跑」：还有一个 install 在用，监听不能被撤掉。
  firstUninstall();
  assert.equal(harness.listeners.size, 5, '还有一次 install 没卸载，监听必须保留');

  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([src, dst]);
  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  const over = makeEvent(rowsIn(dst, 'session:')[0]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, true, '剩余那次 install 的拖动必须还能用');

  secondUninstall();
  assert.equal(harness.listeners.size, 0, '最后一次卸载后监听应清空');
  delete globalThis.document;
});

test('拖动：会话被搬到别处后，同一页面再拖不应把旧分组当源（源缓存不能陈旧）', async () => {
  const harness = await mountDrag({});
  const oldHome = makeGroup('ws-src', [SESSION_ID]);
  makeTree([oldHome, makeGroup('ws-dst', [OTHER_SESSION])]);

  // 第一次拖动：源 = ws-src（如果实现有缓存，这次会把它记住）。
  harness.drag.onDragStart(makeEvent(rowsIn(oldHome, 'session:')[0]));
  assert.equal(harness.drag.state.sourceWorkspaceId, 'ws-src');
  harness.drag.onDragEnd();

  // 会话已被搬到 ws-dst：DOM 里它现在在 ws-dst 分组里，ws-src 成了「别的工作区」。
  const newHome = makeGroup('ws-dst', [SESSION_ID]);
  makeTree([newHome, makeGroup('ws-extra', [])]);

  harness.drag.onDragStart(makeEvent(rowsIn(newHome, 'session:')[0]));
  assert.equal(harness.drag.state.sourceWorkspaceId, 'ws-dst', '源工作区必须每次从 DOM 现读，不能用上一次的缓存');

  const over = makeEvent(rowsIn(oldHome, 'workspace:')[0]);
  harness.drag.onDragOver(over);
  assert.equal(over.defaultPrevented, true, '搬回旧工作区应当被接管，而不是被当成「源分组」让路');
  assert.equal(oldHome.classList.contains('dshsm-drop'), true);
  delete globalThis.document;
});

test('拖动：多选拖动把选中的整批搬走（宿主底栏的选中标记）', async () => {
  const harness = await mountDrag({
    '/status': () => ({ ok: true, bulkDefer: true }),
    '/move': () => ({ ok: true, applied: 'live', targetTitle: '目标工作区' }),
    '/move-commit': () => ({
      ok: true,
      results: [
        { sessionId: SESSION_ID, status: 'moved' },
        { sessionId: OTHER_SESSION, status: 'moved' },
      ],
    }),
  });
  const src = makeGroup('ws-src', [SESSION_ID, OTHER_SESSION]);
  const dst = makeGroup('ws-dst', []);
  makeTree([src, dst]);

  // 宿主（dsh-delete-session）给每条选中行的复选框挂 .dsdel-check-on。
  for (const row of rowsIn(src, 'session:')) {
    const mark = makeElement();
    mark.classList.add('dsdel-check-on');
    row.appendChild(mark);
    harness.hostMarks.push(mark);
  }

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  assert.deepEqual(harness.drag.state.sessionIds, [SESSION_ID, OTHER_SESSION], '拖其中一条要带上整批选中');

  harness.drag.onDrop(makeEvent(rowsIn(dst, 'workspace:')[0]));
  await flush();
  await flush();

  const moves = harness.calls.filter((call) => call.url === PREFIX + '/move');
  assert.equal(moves.length, 2, '两条都要发 /move');
  assert.deepEqual(moves.map((call) => call.body.sessionId).sort(), [SESSION_ID, OTHER_SESSION].sort());
  assert.equal(moves.every((call) => call.body.deferRegistry === true), true, '多选走两段式：先 defer 文件事务');
  const commits = harness.calls.filter((call) => call.url === PREFIX + '/move-commit');
  assert.equal(commits.length, 1, '整批只 commit 一次');
  assert.deepEqual(commits[0].body.sessionIds.slice().sort(), [SESSION_ID, OTHER_SESSION].sort());
  assert.ok(
    harness.dispatched.some((event) => event.type === 'keydown' && event.key === 'Escape'),
    '搬完要让宿主的选中态收起来',
  );
  delete globalThis.document;
});

test('拖动：多选里没选中的行被拖时只搬它自己', async () => {
  const harness = await mountDrag({
    '/status': () => ({ ok: true, bulkDefer: true }),
    '/move': () => ({ ok: true, applied: 'live' }),
  });
  const src = makeGroup('ws-src', [SESSION_ID, OTHER_SESSION]);
  const dst = makeGroup('ws-dst', []);
  makeTree([src, dst]);

  // 只选中了 OTHER_SESSION；拖的是 SESSION_ID。
  const mark = makeElement();
  mark.classList.add('dsdel-check-on');
  rowsIn(src, 'session:')[1].appendChild(mark);
  harness.hostMarks.push(mark);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  assert.deepEqual(harness.drag.state.sessionIds, [SESSION_ID]);

  harness.drag.onDrop(makeEvent(rowsIn(dst, 'workspace:')[0]));
  await flush();
  await flush();

  const moves = harness.calls.filter((call) => call.url === PREFIX + '/move');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].body.sessionId, SESSION_ID);
  assert.equal(moves[0].body.deferRegistry, undefined, '单条不走两段式');
  assert.equal(harness.dispatched.length, 0, '没选中它就不该动宿主的选中态');
  delete globalThis.document;
});

test('选择面板：按页面文字亮度选深/浅色，不依赖可能缺失的主题 token', async () => {
  const harness = await mountDrag({});
  assert.equal(typeof harness.api.__ui, 'object', '主题判定要暴露给测试');

  globalThis.getComputedStyle = () => ({ color: 'rgb(240, 240, 240)' });
  assert.equal(harness.api.__ui.themeClass(), 'dshsm-dark', '浅色字 = 深色主题');

  globalThis.getComputedStyle = () => ({ color: 'rgb(15, 17, 21)' });
  assert.equal(harness.api.__ui.themeClass(), 'dshsm-light', '深色字 = 浅色主题');

  delete globalThis.getComputedStyle;
  assert.equal(harness.api.__ui.themeClass(), 'dshsm-dark', '拿不到样式时退回深色（深底浅字仍可读）');
  delete globalThis.document;
});

// ── 批量搬移（多选）──────────────────────────────────────────────────────────
// 逻辑（runBulkMove）不碰 DOM；独立模式（勾选圈 + 底栏）用极小的 DOM 替身驱动。
// 宿主（dsh-delete-session）存在时，入口让位给它的底栏，只保留 moveSelection 契约。

/** 造一个够用的 DOM：body/head、元素工厂、treeitem 行、监听与事件记录。 */
function makeBulkDom(rowIds) {
  const listeners = new Map();
  const dispatched = [];
  function makeEl(tag) {
    const node = {
      tagName: tag, children: [], parentNode: null, style: {}, dataset: {}, textContent: '', disabled: false, type: '',
      classList: {
        set: new Set(),
        add(name) { this.set.add(name); },
        remove(name) { this.set.delete(name); },
        contains(name) { return this.set.has(name); },
      },
      attributes: {},
      get className() { return Array.from(this.classList.set).join(' '); },
      set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      insertBefore(child) { child.parentNode = this; this.children.unshift(child); return child; },
      removeChild(child) { const at = this.children.indexOf(child); if (at >= 0) this.children.splice(at, 1); },
      remove() { if (this.parentNode !== null) this.parentNode.removeChild(this); },
      addEventListener() {},
      querySelector(selector) {
        if (selector === ':scope > .dshsm-check') {
          return this.children.find((child) => child.classList.contains('dshsm-check')) ?? null;
        }
        return null;
      },
      get firstChild() { return this.children.length > 0 ? this.children[0] : null; },
    };
    return node;
  }
  const body = makeEl('body');
  const head = makeEl('head');
  const rows = (rowIds ?? []).map((id) => { const row = makeEl('div'); row.setAttribute('data-row-key', 'session:' + id); return row; });
  const doc = {
    body, head,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    createElement(tag) { return makeEl(tag); },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[role="treeitem"]' ? rows : []; },
    dispatchEvent(event) { dispatched.push(event); return true; },
  };
  return { doc, listeners, dispatched, rows, body };
}

async function makeBulkApi() {
  const entry = await loadBundle();
  const react = makeReact();
  return entry.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });
}

function installBulkGlobals() {
  globalThis.__DSH_SESSION_RELOCATE__ = { prefix: PREFIX };
  delete globalThis.__DSH_DELETE_SESSION__;
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
}

test('批量：apply 把契约合并进引导全局（不覆盖 prefix），并派发 ready 事件', async () => {
  const api = await makeBulkApi();
  const dom = makeBulkDom([]);
  globalThis.document = dom.doc;
  installBulkGlobals();
  let registered = 0;
  const slots = [];
  api.apply({
    effect() {},
    slots: {
      inject(name, factory) {
        registered += 1;
        slots.push(name);
        const value = factory();
        return typeof value === 'function' ? value : () => {};
      },
      register() { return () => {}; },
    },
  });
  const contract = globalThis.__DSH_SESSION_RELOCATE__;
  assert.equal(contract.prefix, PREFIX, '主机注入的 prefix 不能被覆盖');
  assert.equal(contract.supportsBulkMove, true);
  assert.equal(typeof contract.moveSelection, 'function');
  assert.ok(dom.dispatched.some((event) => event.type === 'dsh-session-relocate:ready'), '应当派发 ready 事件');
  assert.deepEqual(slots, ['plugins.row.config', 'plugins.bundle.config', 'sidebar.workspaces.session.menu.item'], '三处注入：行配置页 + 包配置页 + 会话菜单');
  assert.equal(registered, 3, '三个 slot 各注入一次');
  delete globalThis.document;
});

test('批量：runBulkMove 逐条 defer + 一次 commit、逐条分类、进度 1..N', async () => {
  const api = await makeBulkApi();
  installBulkGlobals();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/status')) return { status: 200, json: async () => ({ ok: true, bulkDefer: true }) };
    if (url.endsWith('/move-commit')) {
      // 只有 defer 成功的那条会进 commit
      return { status: 200, json: async () => ({ ok: true, results: body.sessionIds.map((id) => ({ sessionId: id, status: 'moved' })) }) };
    }
    if (body.sessionId.indexOf('ok') >= 0) return { status: 200, json: async () => ({ ok: true, deferred: true }) };
    if (body.sessionId.indexOf('skip') >= 0) return { status: 200, json: async () => ({ ok: false, code: 'already-there', message: '已经在目标工作区' }) };
    return { status: 200, json: async () => ({ ok: false, code: 'session-active', message: '这个对话正在跑' }) };
  };
  const progress = [];
  const result = await api.__bulk.runBulkMove(['session-ok-1', 'session-skip-1', 'session-bad-1'], 'ws-dst', {
    onProgress: (done, total) => progress.push([done, total]),
  });
  const moveCalls = calls.filter((call) => call.url.endsWith('/move'));
  const commitCall = calls.find((call) => call.url.endsWith('/move-commit'));
  assert.deepEqual(moveCalls.map((call) => call.body.sessionId), ['session-ok-1', 'session-skip-1', 'session-bad-1'], '三条依次 defer');
  assert.equal(moveCalls[0].body.deferRegistry, true, '逐条搬移必须 defer 注册表');
  assert.deepEqual(commitCall.body.sessionIds, ['session-ok-1'], '只有 defer 成功的那条进 commit');
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
  assert.equal(result.moved, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(result.results.map((item) => item.status), ['moved', 'skipped', 'failed']);
  assert.equal(result.results[2].code, 'session-active');
});

test('批量：老主机没有 bulkDefer 时退回逐条单发（不调 /move-commit）', async () => {
  const api = await makeBulkApi();
  installBulkGlobals();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/status')) return { status: 200, json: async () => ({ ok: true }) };
    return { status: 200, json: async () => ({ ok: true, applied: 'live' }) };
  };
  const result = await api.__bulk.runBulkMove(['session-a', 'session-b'], 'ws-dst', {});
  assert.equal(result.moved, 2, '老主机上逐条直接搬，照常可用');
  assert.equal(result.failed, 0);
  assert.equal(calls.some((call) => call.url.endsWith('/move-commit')), false, '不支持时不该调 commit');
  assert.equal(calls.find((call) => call.url.endsWith('/move')).body.deferRegistry, false, '不支持时不能 defer');
});

test('批量：commit 失败时不乐观隐藏（那条按失败计，并带上原因）', async () => {
  const api = await makeBulkApi();
  installBulkGlobals();
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/status')) return { status: 200, json: async () => ({ ok: true, bulkDefer: true }) };
    if (url.endsWith('/move-commit')) {
      return { status: 200, json: async () => ({ ok: false, message: '归属写入失败' }) };
    }
    return { status: 200, json: async () => ({ ok: true, deferred: true }) };
  };
  const result = await api.__bulk.runBulkMove(['session-a', 'session-b'], 'ws-dst', {});
  assert.equal(result.moved, 0, 'commit 没成功就不能报已搬');
  assert.equal(result.failed, 2);
  assert.equal(result.results[0].code, 'commit-failed');
  assert.match(result.results[0].message, /归属写入失败/);
});

test('批量：宿主支持批量动作时，「多选」入口让位（渲染 null）', async () => {
  const api = await makeBulkApi();
  const dom = makeBulkDom([]);
  globalThis.document = dom.doc;
  installBulkGlobals();
  globalThis.__DSH_DELETE_SESSION__ = { supportsBulkMove: true };
  assert.equal(api.__bulkEntry({}), null, '宿主在时不该出现第二个多选入口');
  delete globalThis.__DSH_DELETE_SESSION__;
  const node = api.__bulkEntry({ useMenuOpenState: () => [true, () => {}] });
  assert.equal(node.type, 'button');
  assert.equal(textOf(node), '多选');
  delete globalThis.document;
});

test('批量：进入多选 → 底部条（已选 0、移动禁用）→ 点行选中 → 退出清理', async () => {
  const api = await makeBulkApi();
  const dom = makeBulkDom(['session-a', 'session-b']);
  globalThis.document = dom.doc;
  installBulkGlobals();
  const bulk = api.__bulk;
  bulk.enterBulk();
  assert.equal(bulk.state.selecting, true);
  assert.equal(bulk.state.countNode.textContent, '已选 0 个');
  assert.equal(bulk.state.moveNode.disabled, true, '0 个时「移动」必须禁用');
  assert.ok(dom.body.children.includes(bulk.state.bar), '底栏应当挂到 body');

  const click = dom.listeners.get('click');
  click({ target: { closest: () => dom.rows[0] }, preventDefault() {}, stopPropagation() {} });
  assert.equal(bulk.state.countNode.textContent, '已选 1 个');
  assert.equal(bulk.state.moveNode.disabled, false);
  bulk.bulkDecorate();
  const check = dom.rows[0].querySelector(':scope > .dshsm-check');
  assert.ok(check !== null, '选中后行首应当出现勾选圈');
  assert.equal(check.classList.contains('dshsm-check-on'), true);
  const otherCheck = dom.rows[1].querySelector(':scope > .dshsm-check');
  assert.ok(otherCheck !== null, '没选的行也该有圈（空圈），方便点选');
  assert.equal(otherCheck.classList.contains('dshsm-check-on'), false, '没选的行不该是选中态');

  bulk.exitBulk();
  assert.equal(bulk.state.selecting, false);
  assert.equal(dom.body.children.length, 0, '底栏要被移除');
  assert.equal(dom.rows[0].querySelector(':scope > .dshsm-check'), null, '勾选圈要被移除');
  assert.equal(dom.listeners.has('click'), false, '监听要摘掉');
  delete globalThis.document;
});

test('批量：移动被取消时保留选中、不退出多选', async () => {
  const api = await makeBulkApi();
  const dom = makeBulkDom(['session-a']);
  globalThis.document = dom.doc;
  installBulkGlobals();
  const bulk = api.__bulk;
  bulk.state.moveSelectionFn = async () => ({ canceled: true, moved: 0, failed: 0, skipped: 0, total: 1, results: [] });
  bulk.enterBulk();
  dom.listeners.get('click')({ target: { closest: () => dom.rows[0] }, preventDefault() {}, stopPropagation() {} });
  bulk.bulkMoveSelected();
  await flush();
  assert.equal(bulk.state.selecting, true, '取消不该退出多选');
  assert.equal(bulk.state.countNode.textContent, '已选 1 个', '取消后选中还在');
  assert.equal(bulk.state.moveNode.disabled, false);
  delete globalThis.document;
});

test('多选目标面板：按归属算「将移动 M / 跳过 K」，全部已在目标里的项置灰', async () => {
  const harness = await mount({});
  const owners = { a: 'ws-1', b: 'ws-1', c: 'ws-2' };
  const ownerOf = (id) => (Object.prototype.hasOwnProperty.call(owners, id) ? owners[id] : null);
  const spaces = [{ id: 'ws-1' }, { id: 'ws-2' }, { id: 'ws-3' }];
  const plans = harness.api.__bulk.planTargetsWith(['a', 'b', 'c'], spaces, ownerOf);
  assert.deepEqual(plans.map((p) => ({ id: p.workspace.id, moved: p.moved, skipped: p.skipped, disabled: p.disabled })), [
    { id: 'ws-1', moved: 1, skipped: 2, disabled: false },
    { id: 'ws-2', moved: 2, skipped: 1, disabled: false },
    { id: 'ws-3', moved: 3, skipped: 0, disabled: false },
  ]);

  const allHere = harness.api.__bulk.planTargetsWith(['a', 'b'], [{ id: 'ws-1' }], ownerOf);
  assert.equal(allHere[0].disabled, true, '全部已在目标里 → 置灰，点了也不发请求');

  const unknown = harness.api.__bulk.planTargetsWith(['x'], [{ id: 'ws-1' }], () => null);
  assert.deepEqual(
    { moved: unknown[0].moved, skipped: unknown[0].skipped, disabled: unknown[0].disabled },
    { moved: 1, skipped: 0, disabled: false },
    '归属未知（行没渲染）按「会搬」处理，保守',
  );
});

test('拖动：关掉「连同子对话」后，单条搬移显式传 includeChildren:false', async () => {
  globalThis.localStorage = { getItem: () => 'false', setItem() {} };
  const harness = await mountDrag({ '/move': () => ({ ok: true, applied: 'live', targetTitle: '目标' }) });
  const src = makeGroup('ws-src', [SESSION_ID]);
  const dst = makeGroup('ws-dst', [OTHER_SESSION]);
  makeTree([src, dst]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  harness.drag.onDrop(makeEvent(rowsIn(dst, 'session:')[0]));
  const moves = harness.calls.filter((call) => call.url === PREFIX + '/move');
  assert.deepEqual(moves[0].body, { sessionId: SESSION_ID, targetWorkspaceId: 'ws-dst', includeChildren: false }, '显式告诉主机只搬父');
  delete globalThis.localStorage;
  delete globalThis.document;
});

test('设置页：连同子对话开关默认开，点一下写入关闭', async () => {
  const writes = [];
  const store = { value: null };
  globalThis.localStorage = {
    getItem: () => store.value,
    setItem: (key, value) => { writes.push([key, value]); store.value = value; },
  };
  const harness = await mount({});
  const node = harness.api.__settings.ChildrenSetting({});
  assert.equal(node.props.className, 'dshsm-setting');
  const toggle = node.children[1];
  assert.equal(toggle.props.role, 'switch');
  assert.equal(toggle.props['aria-checked'], 'true', '默认开');
  toggle.props.onClick();
  assert.deepEqual(writes, [['dsh-session-relocate.includeChildren', 'false']], '点一下关掉并持久化');
  assert.equal(harness.api.__settings.wantChildren(), false);
  delete globalThis.localStorage;
  delete globalThis.document;
});
