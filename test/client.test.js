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

/**
 * 挂一个「带官方 primitives」的 bundle，并把每个槽的注册组件记下来。
 * primitives 传 null 表示宿主没提供（走自绘回退）。
 */
async function mountDock(primitives, routes, services) {
  const entry = await loadBundle();
  const react = makeReact();
  const api = entry.factory((name) => {
    if (name === 'react') return react;
    if (primitives !== null && name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('unexpected require: ' + name);
  });
  const registrations = new Map();
  const fakeCtx = {
    get(name) {
      if (services !== null && services !== undefined && Object.prototype.hasOwnProperty.call(services, name)) return services[name];
      return undefined;
    },
    slots: {
      inject(slot, factory) {
        const disposer = factory();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      register(spec, component) {
        registrations.set(spec.name, { spec, component });
        return () => {};
      },
    },
  };
  api.apply(fakeCtx);
  const fetchHarness = makeFetch(routes);
  globalThis.fetch = fetchHarness.impl;
  globalThis.__DSH_SESSION_RELOCATE__ = { prefix: PREFIX };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
  const registration = registrations.get('conversation.input.dock');
  assert.ok(registration !== undefined, '应当注册 conversation.input.dock');
  const props = { sessionId: SESSION_ID };
  const render = () => {
    react.reset();
    return registration.component(props);
  };
  return { api, registrations, registration, react, render, calls: fetchHarness.calls };
}

const FAKE_PRIMITIVES = {
  Menu(props) { return { type: 'Menu', props, children: [] }; },
  IconFolderCloseRegular(props) { return { type: 'FolderIcon', props, children: [] }; },
  IconPlusOutlineRegular(props) { return { type: 'PlusIcon', props, children: [] }; },
  MenuItemButton(props) { return { type: 'MenuItemButton', props, children: [props.children] }; },
};

test('chip：有官方 Menu 时点开就是官方那套工作区下拉（当前项画勾 + 添加工作区…）', async () => {
  const harness = await mountDock(FAKE_PRIMITIVES, {
    '/describe': () => ({
      ok: true,
      session: { id: SESSION_ID, currentWorkspaceId: 'ws-a' },
      workspaces: [
        { id: 'ws-a', title: 'DSH web', path: 'E:\\E\\DSH web' },
        { id: 'ws-b', title: 'DSH', path: 'E:\\E\\DSH' },
      ],
    }),
  });

  const first = harness.render();
  const chip = first.children[0];
  assert.equal(chip.type, 'button');
  assert.equal(chip.props['aria-haspopup'], 'menu', '有 Menu 时应当是下拉而不是弹窗');
  assert.equal(chip.props['aria-expanded'], 'false');

  chip.props.onClick();
  await flush();
  const second = harness.render();
  const menu = second.children.find((node) => node !== null && node !== undefined && node.type === FAKE_PRIMITIVES.Menu);
  assert.ok(menu !== undefined, '打开后应当渲染官方 Menu');
  assert.equal(menu.props.open, true);
  assert.equal(menu.props.selectedId, 'ws-a', '当前工作区由 selectedId 画勾');
  assert.deepEqual(menu.props.items.map((item) => item.label), ['DSH web', 'DSH']);
  assert.equal(menu.props.items[0].icon.type, FAKE_PRIMITIVES.IconFolderCloseRegular, '每行前面是官方文件夹图标');
  assert.deepEqual(menu.props.footer.map((item) => item.label), ['添加工作区…']);
  assert.equal(menu.props.footer[0].icon.type, FAKE_PRIMITIVES.IconPlusOutlineRegular);
  assert.equal(menu.props.portal, true);
  assert.equal(menu.props.align, 'start');
  assert.equal(typeof menu.props.getAnchorRect, 'function');
  assert.equal(menu.props.getAnchorRect(), null, '还没挂到 DOM 上时锚点为空也不该抛');

  // 选另一个工作区 → 发一次 /move
  menu.props.onSelect('ws-b');
  await flush();
  const moveCalls = harness.calls.filter((call) => /\/move$/.test(call.url));
  assert.equal(moveCalls.length, 1, '选另一个工作区应当发一次 /move');
  assert.equal(moveCalls[0].body.sessionId, SESSION_ID);
  assert.equal(moveCalls[0].body.targetWorkspaceId, 'ws-b');
});

test('chip：选了当前工作区不发请求；没有官方 Menu 时不声称自己是下拉', async () => {
  const harness = await mountDock(FAKE_PRIMITIVES, {
    '/describe': () => ({
      ok: true,
      session: { id: SESSION_ID, currentWorkspaceId: 'ws-a' },
      workspaces: [{ id: 'ws-a', title: 'DSH web', path: 'E:\\E\\DSH web' }],
    }),
  });
  const chip = harness.render().children[0];
  chip.props.onClick();
  await flush();
  const menu = harness.render().children.find((node) => node !== null && node !== undefined && node.type === FAKE_PRIMITIVES.Menu);
  assert.equal(menu.props.items.length, 1);
  assert.deepEqual(menu.props.footer.map((item) => item.label), ['添加工作区…'], '只有一个工作区时也能添加');
  menu.props.onSelect('ws-a');
  await flush();
  assert.equal(harness.calls.filter((call) => /\/move$/.test(call.url)).length, 0, '选当前工作区不该发 /move');

  const fallback = await mountDock(null, { '/describe': () => ({ ok: true, session: {}, workspaces: [] }) });
  const fallbackChip = fallback.render().children[0];
  assert.equal(fallbackChip.props['aria-haspopup'], undefined, '没有 Menu 时退回自绘面板，不设 aria-haspopup');
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 把一个 bundle 挂起来，返回右键菜单贡献项与调用记录。
 *
 * 「移动到」只有一个入口：注册给 contextMenus（target=session）的那个贡献项 ——
 * 和官方「在应用中打开」同一套机制，不再有槽里的行内版本。
 */
async function mount(routes) {
  const entry = await loadBundle();
  const react = makeReact();
  const api = entry.factory((name) => {
    if (name === 'react') return react;
    throw new Error('unexpected require: ' + name);
  });

  const contributions = [];
  const slotRegistrations = [];
  const fakeCtx = {
    // inject 里声明了 contextMenus：Cordis 会等它就绪再 apply，所以这里一定是真对象。
    contextMenus: {
      register(input) { contributions.push(input); return () => {}; },
    },
    effect(fn) { return fn(); },
    slots: {
      inject(slot, factory) {
        const disposer = factory();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      register(spec, component) { slotRegistrations.push({ spec, component }); return () => {}; },
    },
  };
  const returned = api.apply(fakeCtx);

  const fetchHarness = makeFetch(routes);
  globalThis.fetch = fetchHarness.impl;
  globalThis.__DSH_SESSION_RELOCATE__ = { prefix: PREFIX };
  // Node 25 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖。
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });

  const props = { sessionId: SESSION_ID, displayTitle: '演示对话' };
  const contribution = () => {
    assert.equal(contributions.length, 1, '应当向 contextMenus 贡献一项');
    return contributions[0];
  };
  /** resolve 一次，拿到菜单里的父项（可能是 undefined = 这一项不出现）。 */
  const resolveParent = async (value) => {
    const actions = await contribution().resolve(value === undefined ? { sessionId: props.sessionId } : value, { aborted: false });
    return actions.length === 0 ? null : actions[0];
  };
  /** 子菜单里的可点项：等价于「鼠标悬停在父项上展开」。 */
  const childrenOf = (parent) => (parent === null || parent.children === undefined ? [] : parent.children);

  return {
    api, entry, fakeCtx, contributions, slotRegistrations, returned, props,
    contribution, resolveParent, childrenOf,
    calls: fetchHarness.calls,
  };
}

/** 装上自绘 toast 需要的假 document，并返回它追加过的节点（用来看提示文案）。 */
function withToastDocument() {
  const { doc } = makeFakeDocument();
  globalThis.document = doc;
  return { doc, lastText: () => { const nodes = doc.body.children.filter((node) => node.textContent !== ''); return nodes.length === 0 ? '' : nodes[nodes.length - 1].textContent; } };
}

test('兼容：主机侧还注入旧引导全局名时，客户端照样用它的前缀（改名过渡期）', async () => {
  const harness = await mount({
    '/describe': () => ({ ok: true, workspaces: [], session: { id: SESSION_ID, canMove: true, reason: null } }),
  });
  // mount() 默认给的是新名字；这里模拟「主机侧还没重启、只有旧名字」的那半截状态。
  delete globalThis.__DSH_SESSION_RELOCATE__;
  globalThis.__DSH_SESSION_MOVE__ = { prefix: '/api/legacy-move' };
  await harness.resolveParent();
  assert.equal(harness.calls[0].url, '/api/legacy-move/describe', '应当用旧引导全局里的前缀，而不是新默认值');
  delete globalThis.__DSH_SESSION_MOVE__;
});

test('bundle 形状：id/工厂/inject/右键贡献项都对', async () => {
  const harness = await mount({});
  assert.equal(harness.entry.id, 'dsh-session-relocate');
  assert.equal(typeof harness.entry.factory, 'function');
  // 和 open-in-app 一样：contextMenus 写在 inject 里，靠 Cordis 保证就绪，不用 ctx.get 探测。
  assert.deepEqual(harness.api.inject, ['slots', 'contextMenus']);
  assert.equal(typeof harness.returned, 'function', 'apply 应当返回 disposer');
});

test('菜单：注册成 contextMenus 的 session 子菜单（和「在应用中打开」同一形态）', async () => {
  const harness = await mount({
    '/describe': () => ({
      ok: true,
      session: { id: SESSION_ID, canMove: true, reason: null, currentWorkspaceId: 'ws-a' },
      workspaces: [
        { id: 'ws-a', title: '工作区 A', path: 'E:\\A', current: true },
        { id: 'ws-b', title: '工作区 B', path: 'E:\\B' },
        { id: 'ws-c', title: '工作区 C', path: 'E:\\C' },
      ],
    }),
  });
  const contribution = harness.contribution();
  assert.equal(contribution.target, 'session', '挂在会话右键菜单上（和「在应用中打开」同一个 target）');
  assert.equal(contribution.id, 'session-relocate.move-out-menu');
  // 官方右键项顺序：pin 100 / rename 200 / fork 300 / 复制 Session ID 450 / 在应用中打开 500 / 归档 600。
  assert.equal(contribution.order, 550, '必须落在「在应用中打开」(500) 与「归档」(600) 之间');
  assert.equal(typeof contribution.resolve, 'function');

  const parent = await harness.resolveParent();
  assert.equal(parent.label, '移动到');
  assert.equal(parent.icon === undefined, false, '父项必须带 icon.key（否则右键行首没有图标）');
  assert.equal(parent.icon.key, 'session-relocate.move');
  assert.equal(parent.children === undefined, false, '必须是子菜单（children），不是行内展开');

  const children = harness.childrenOf(parent);
  const labels = children.map((child) => (typeof child.label === 'string' ? child.label : textOf(child.label)));
  assert.deepEqual(labels, ['工作区 B', '工作区 C', '其它目录…', '未分组'], '当前工作区不列；末尾是「其它目录…」和「未分组」');
  assert.equal(children.every((child) => typeof child.run === 'function'), true, '每个子项都能执行');
});

test('菜单：槽里不再注册「移动到」（否则同一个菜单出现两次）', async () => {
  const harness = await mount({});
  const ids = harness.slotRegistrations.map((entry) => entry.spec.id);
  assert.equal(ids.includes('session-relocate'), false, '行内那套已经删掉，只剩右键子菜单');
  assert.equal(ids.includes('session-relocate-bulk'), true, '「多选」入口仍然留在槽里');
});

test('菜单：选目标工作区就发 /move，并弹提示', async () => {
  const harness = await mount({
    '/describe': () => ({
      ok: true,
      session: { id: SESSION_ID, canMove: true, reason: null, currentWorkspaceId: 'ws-a' },
      workspaces: [
        { id: 'ws-a', title: '工作区 A', path: 'E:\\A', current: true },
        { id: 'ws-b', title: '工作区 B', path: 'E:\\B' },
      ],
    }),
    '/move': (body) => ({ ok: true, applied: 'live', targetTitle: '工作区 B', sessionId: body.sessionId }),
  });
  const toast = withToastDocument();
  const parent = await harness.resolveParent();
  const target = harness.childrenOf(parent)[0];
  assert.equal(target.id, 'ws:ws-b');
  target.run();
  await flush();
  assert.deepEqual(harness.calls[1], {
    url: PREFIX + '/move',
    body: { sessionId: SESSION_ID, targetWorkspaceId: 'ws-b' },
  });
  assert.match(toast.lastText(), /已移动.*工作区 B/);
  assert.deepEqual(harness.calls[0], { url: PREFIX + '/describe', body: { sessionId: SESSION_ID } });
});

test('菜单：不可移动时父项置灰（disabled），且不会调 move', async () => {
  const harness = await mount({
    '/describe': () => ({
      ok: true,
      workspaces: [],
      session: { id: SESSION_ID, canMove: false, reason: '这个对话当前正打开着，请先切到别的对话再移动', live: true },
    }),
  });
  const parent = await harness.resolveParent();
  assert.equal(parent.disabled, true);
  assert.equal(parent.label, '移动到');
  assert.equal(parent.children, undefined, '不能搬就不要给子菜单');
  assert.equal(harness.calls.length, 1, '只应当有 describe 这一次请求');
});

test('菜单：「其它目录…」用 prompt 的路径调 move', async () => {
  const harness = await mount({
    '/describe': () => ({ ok: true, workspaces: [], session: { id: SESSION_ID, canMove: true, reason: null } }),
    '/move': () => ({ ok: true, applied: 'live', targetTitle: '新目录' }),
  });
  const toast = withToastDocument();
  globalThis.__DSH_DIRECTORY_PICKER__ = undefined;
  globalThis.prompt = () => '  D:\\示例\\新目录  ';
  const parent = await harness.resolveParent();
  const choose = harness.childrenOf(parent).find((child) => child.id === 'choose-dir');
  assert.ok(choose !== undefined, '必须有一项「其它目录…」');
  assert.equal(typeof choose.label, 'string');
  choose.run();
  await flush();
  assert.deepEqual(harness.calls[1].body, { sessionId: SESSION_ID, targetPath: 'D:\\示例\\新目录' });
  assert.match(toast.lastText(), /已移动.*新目录/);
});

test('菜单：prompt 被取消时什么都不做', async () => {
  const harness = await mount({
    '/describe': () => ({ ok: true, workspaces: [], session: { id: SESSION_ID, canMove: true, reason: null } }),
  });
  withToastDocument();
  globalThis.prompt = () => null;
  const parent = await harness.resolveParent();
  harness.childrenOf(parent).find((child) => child.id === 'choose-dir').run();
  await flush();
  assert.equal(harness.calls.length, 1, '取消 prompt 不应该发起 move');
});

test('菜单：「未分组」走 /move-out（只摘归属，不发 /move）', async () => {
  const harness = await mount({
    '/describe': () => ({
      ok: true,
      session: { id: SESSION_ID, canMove: true, reason: null, currentWorkspaceId: 'ws-a' },
      workspaces: [{ id: 'ws-a', title: 'A', path: 'E:\\A', current: true }],
    }),
    '/move-out': () => ({ ok: true, sessionId: SESSION_ID, detachedFrom: { id: 'ws-a', title: 'A' } }),
  });
  const toast = withToastDocument();
  const parent = await harness.resolveParent();
  const ungroup = harness.childrenOf(parent).find((child) => child.id === 'ungroup');
  assert.equal(ungroup.label, '未分组', '只有三个字，没有括号没有其它字，也没有图标');
  assert.equal(ungroup.icon, undefined);
  ungroup.run();
  await flush();
  const outs = harness.calls.filter((call) => /\/move-out$/.test(call.url));
  assert.equal(outs.length, 1);
  assert.equal(outs[0].body.sessionId, SESSION_ID);
  assert.equal(harness.calls.filter((call) => /\/move$/.test(call.url)).length, 0, '不该发 /move');
  assert.match(toast.lastText(), /已移出/);
});

test('菜单：收尾待补时给出明确提示；桥接报错时显示失败原因', async () => {
  const oneTarget = [{ id: 'ws-b', title: '工作区 B', path: 'E:\\B' }];
  const pending = await mount({
    '/describe': () => ({ ok: true, workspaces: oneTarget, session: { id: SESSION_ID, canMove: true, reason: null } }),
    '/move': () => ({ ok: true, applied: 'pending', targetTitle: '工作区 B' }),
  });
  const pendingToast = withToastDocument();
  pending.childrenOf(await pending.resolveParent())[0].run();
  await flush();
  assert.match(pendingToast.lastText(), /下次启动 DSH 时自动补齐/);

  const failed = await mount({
    '/describe': () => ({ ok: true, workspaces: oneTarget, session: { id: SESSION_ID, canMove: true, reason: null } }),
    '/move': () => ({ ok: false, code: 'session-live', message: '这个对话当前正打开着' }),
  });
  const failedToast = withToastDocument();
  failed.childrenOf(await failed.resolveParent())[0].run();
  await flush();
  assert.match(failedToast.lastText(), /移动失败.*正打开着/);
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
  const head = { children: [], appendChild(node) { head.children.push(node); node.parentNode = head; } };
  const doc = {
    body,
    head,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    createElement() { return { style: {}, dataset: {}, textContent: '', parentNode: null, setAttribute() {}, appendChild() {} }; },
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
  assert.deepEqual(slots, ['conversation.input.dock', 'sidebar.footer.action', 'plugins.row.config', 'plugins.bundle.config', 'sidebar.workspaces.session.menu.item'], '五处注入：composer chip + 页脚底栏 + 行配置页 + 包配置页 + 会话菜单');
  assert.equal(registered, 5, '五个 slot 各注入一次');
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

test('批量：applied=attached 的直接算已搬，不 defer、不 commit', async () => {
  const api = await makeBulkApi();
  installBulkGlobals();
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/status')) return { status: 200, json: async () => ({ ok: true, bulkDefer: true }) };
    if (url.endsWith('/move')) return { status: 200, json: async () => ({ ok: true, applied: 'attached', targetTitle: '源工作区' }) };
    if (url.endsWith('/move-commit')) return { status: 200, json: async () => ({ ok: true, results: body.sessionIds.map((id) => ({ sessionId: id, status: 'moved' })) }) };
    return { status: 200, json: async () => ({ ok: false }) };
  };
  const result = await api.__bulk.runBulkMove(['session-orphan-1'], 'ws-src', {});
  assert.equal(result.moved, 1, '补归属也算这一条成功');
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 0);
  assert.equal(result.results[0].applied, 'attached');
  assert.equal(calls.some((call) => call.url.endsWith('/move-commit')), false, '没有文件事务，不该进 commit');
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

test('多选入口：有宿主基座时用 MenuItemButton 并带图标（和 dsh-delete-session 一致）', async () => {
  // 没有图标的「多选」是裸文字：菜单里「置顶 / 分叉 / 移动到」那几行左边都有图标，
  // 只有它空着。两个插件都装时看到的是对方那一行（有图标），单独装本插件就没有 ——
  // 同一件控件两种样子。
  const primitives = {
    MenuItemButton(props) { return { type: 'MenuItemButton', props, children: [props.children] }; },
  };
  const entry = await loadBundle();
  const react = makeReact();
  const api = entry.factory((name) => {
    if (name === 'react') return react;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('unexpected require: ' + name);
  });
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true, writable: true });
  delete globalThis.__DSH_DELETE_SESSION__;
  const node = api.__bulkEntry({ useMenuOpenState: () => [true, () => {}] });
  assert.equal(node.type, primitives.MenuItemButton, '走宿主的菜单行组件，行高/hover 才和别的行一致');
  assert.equal(node.props.icon.type, 'svg', '必须带图标，否则这一行是裸文字');
  assert.equal(node.props.icon.props.width, 16, '16px，和宿主菜单图标同尺寸');
  assert.equal(node.props.icon.children.length, 4, '四条路径（两个圆点 + 两条横线）');
  assert.equal(textOf(node), '多选', '文案不变');
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

test('设置页：localStorage 读不了（隐私模式）时仍然默认开', async () => {
  globalThis.localStorage = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('denied') },
  };
  const harness = await mount({});
  assert.equal(harness.api.__settings.wantChildren(), true, '读不到就按默认开，而不是按关');
  const node = harness.api.__settings.ChildrenSetting({});
  const toggle = node.children[0].children[1];
  assert.equal(toggle.props['aria-checked'], 'true', '开关显示为开');
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
  assert.equal(node.props.className, 'dshsm-card');
  const setting = node.children[0];
  const toggle = setting.children[1];
  assert.equal(toggle.props.role, 'switch');
  assert.equal(toggle.props['aria-checked'], 'true', '默认开');
  toggle.props.onClick();
  assert.deepEqual(writes, [['dsh-session-relocate.includeChildren', 'false']], '点一下关掉并持久化');
  assert.equal(harness.api.__settings.wantChildren(), false);
  const modeSetting = node.children[1];
  assert.equal(modeSetting.props.className, 'dshsm-setting', '第二块是「chip 什么时候出现」');
  const seg = modeSetting.children[1];
  assert.equal(seg.props.className, 'dshsm-seg');
  assert.equal(seg.children.length, 4, '四档：一直出现 / 悬浮在那一行 / 只悬浮胶囊 / 不出现');
  assert.deepEqual(seg.children.map((button) => button.props['data-on']), ['true', 'false', 'false', 'false'], '默认「一直出现」');
  seg.children[1].props.onClick();
  assert.equal(harness.api.__settings.chipMode(), 'hover', '点「悬浮才出现」后立即生效');
  assert.ok(writes.some((pair) => pair[0] === 'dsh-session-relocate.chipMode' && pair[1] === 'hover'), '写入 localStorage');
  seg.children[2].props.onClick();
  assert.equal(harness.api.__settings.chipMode(), 'hover-self', '第三档是「只悬浮胶囊才出现」');
  assert.ok(writes.some((pair) => pair[0] === 'dsh-session-relocate.chipMode' && pair[1] === 'hover-self'), '写入 localStorage');
  const css = harness.api.__ui.css();
  assert.ok(css.includes('.dshsm-chip[data-mode="hover-self"]:hover'), '只悬浮胶囊本身才显形');
  assert.ok(css.includes('.dshsm-dock:hover .dshsm-chip[data-mode="hover"]'), '整行悬浮是另一档');

  const star = node.children[2];
  assert.equal(star.type, 'a', '和 free-search 一样是整条链接');
  assert.equal(star.props.href, 'https://github.com/DDDMUC/dsh-session-relocate');
  assert.equal(star.props.target, '_blank');
  assert.deepEqual(star.children.map((child) => child.children[0]), ['⭐', '顺手留颗 Star，作者能高兴一整天', '行，给你一颗 Star']);
  delete globalThis.localStorage;
  delete globalThis.document;
});


test('样式：皮肤插件把 input.dock 子元素刷成配件时，我们的容器有高特异性复位', async () => {
  const harness = await mount({});
  const css = harness.api.__ui.css();
  assert.match(
    css,
    /html:root:root:root \[data-phase="active"\] \[data-slot="conversation\.input\.dock"\] > \.dshsm-dock\.dshsm-dock/,
    '复位选择器必须同时命中 active 相位并压过皮肤的通配规则',
  );
  assert.match(css, /backdrop-filter:none !important/, '玻璃效果要清掉');
  assert.match(css, /border-radius:0 !important/, '圆角要清掉');
  assert.match(css, /padding:0 16px 0 20px !important/, '自己的内边距要保留');
});

test('样式：多选底栏只用正面选择器让位，按钮不被压扁', async () => {
  const harness = await mount({});
  const css = harness.api.__ui.css();
  // 只禁止「除了我的类名之外全隐藏」那种写法；footArea 那条点名保留 footerActions 的 :not 是文档原文。
  assert.doesNotMatch(css, /:not\([^)]*dshsm/, '不要写排除式选择器（槽位容器是 display:contents，会连自己一起藏掉）');
  assert.match(css, /body\.dshsm-selecting \[data-slot="sidebar\.footer\.action"\] > \[data-dsh-plugin\]\{display:none\}/);
  assert.match(css, /body\.dshsm-selecting \[data-slot="sidebar\.footer\.action"\] > \[class\*="_entryRow"\]\{display:none\}/);
  assert.match(css, /body\.dshsm-selecting \[class\*="_footArea"\] > \*:not\(\[class\*="_footerActions"\]\)\{display:none\}/);
  assert.match(
    css,
    /body\.dshsm-selecting \[data-slot="sidebar\.footer\.action"\] > button:not\(\[role="toolbar"\]\)\{display:none\}/,
    '页脚里的按钮型入口（如 dsh-sidebar-declutter 的 .dhns-footer-btn）也要让位',
  );
  assert.doesNotMatch(css, /\[data-slot="sidebar\.footer\.action"\] > button\{display:none\}/, '不能无条件藏 button —— 底栏自己可能就是 button');
  assert.match(css, /\.dshsm-bar-btn\{[^}]*flex:0 0 auto[^}]*white-space:nowrap/, '按钮不许被压扁/换行');
  assert.match(css, /\.dshsm-bar-count\{[^}]*flex:1/, '计数让路');
});

test('多选底栏：常驻槽组件，没进多选返回 null；进了渲染计数 + 取消 + 移动', async () => {
  const { doc } = makeFakeDocument();
  const added = [];
  doc.body.classList = { add: (c) => added.push(['add', c]), remove: (c) => added.push(['remove', c]) };
  globalThis.document = doc;
  try {
    const idle = await mount({});
    assert.equal(idle.api.__bulk.BulkBar({}), null, '槽位组件常驻，靠 null 表示不存在');

    const harness = await mount({});
    assert.equal(harness.api.__bulk.slotReady(), true, 'apply 里应当已注册页脚槽');
    harness.api.__bulk.enterBulk();
    assert.deepEqual(added, [['add', 'dshsm-selecting']], '进多选给 body 打标记');
    const bar = harness.api.__bulk.BulkBar({});
    assert.equal(bar.props.className, 'dshsm-bar');
    assert.equal(bar.props.role, 'toolbar');
    assert.equal(textOf(bar.children[0]), '已选 0 个');
    const buttons = collectButtons(bar);
    assert.deepEqual(buttons.map((b) => textOf(b)), ['取消', '移动']);
    assert.equal(buttons[1].props.disabled, true, '一个都没选时「移动」禁用');

    harness.api.__bulk.state.selected[SESSION_ID] = true;
    harness.api.__bulk.bulkUpdateBar();
    assert.deepEqual(harness.api.__bulk.bulkSnapshot(), { selecting: true, count: 1, text: '已选 1 个', busy: false });

    harness.api.__bulk.exitBulk();
    assert.deepEqual(added[added.length - 1], ['remove', 'dshsm-selecting'], '退出时摘掉标记');
  } finally {
    delete globalThis.document;
  }
});

test('chip：「添加工作区…」走官方目录选择器（uiWorkspace.pickDirectory），不弹手输框', async () => {
  const savedPrompt = globalThis.prompt;
  let prompts = 0;
  globalThis.prompt = () => { prompts += 1; return ''; };
  try {
    const harness = await mountDock(FAKE_PRIMITIVES, {
      '/describe': () => ({
        ok: true,
        session: { id: SESSION_ID, currentWorkspaceId: 'ws-a' },
        workspaces: [{ id: 'ws-a', title: 'DSH web', path: 'E:\\E\\DSH web' }],
      }),
      '/move': () => ({ ok: true, applied: 'live', targetTitle: '新建', targetWorkspaceId: 'ws-new' }),
    }, { uiWorkspace: { pickDirectory: async () => 'E:\\E\\新建' } });

    const chip = harness.render().children[0];
    chip.props.onClick();
    await flush();
    const menu = harness.render().children.find((node) => node !== null && node !== undefined && node.type === FAKE_PRIMITIVES.Menu);
    menu.props.onSelect('__dshsm-add-workspace');
    await flush();
    await flush();

    assert.equal(prompts, 0, '有官方选择器时不该再弹手输框');
    const moveCalls = harness.calls.filter((call) => /\/move$/.test(call.url));
    assert.equal(moveCalls.length, 1);
    assert.equal(moveCalls[0].body.targetPath, 'E:\\E\\新建', '选中目录直接作为 targetPath 发出去');
    assert.equal(moveCalls[0].body.sessionId, SESSION_ID);
  } finally {
    if (savedPrompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = savedPrompt;
  }
});

test('chip：没有目录选择器时，「添加工作区…」退回手输路径；取消则不发请求', async () => {
  const savedPrompt = globalThis.prompt;
  try {
    const routed = {
      '/describe': () => ({
        ok: true,
        session: { id: SESSION_ID, currentWorkspaceId: 'ws-a' },
        workspaces: [{ id: 'ws-a', title: 'DSH web', path: 'E:\\E\\DSH web' }],
      }),
      '/move': () => ({ ok: true, applied: 'live', targetTitle: '手输', targetWorkspaceId: 'ws-x' }),
    };

    // ① 用户手输一个路径
    globalThis.prompt = () => '  E:\\E\\手输  ';
    const typed = await mountDock(FAKE_PRIMITIVES, routed, null);
    const chip = typed.render().children[0];
    chip.props.onClick();
    await flush();
    const menu = typed.render().children.find((node) => node !== null && node !== undefined && node.type === FAKE_PRIMITIVES.Menu);
    menu.props.onSelect('__dshsm-add-workspace');
    await flush();
    await flush();
    const typedMoves = typed.calls.filter((call) => /\/move$/.test(call.url));
    assert.equal(typedMoves.length, 1);
    assert.equal(typedMoves[0].body.targetPath, 'E:\\E\\手输', '首尾空白要去掉');

    // ② 用户取消手输
    globalThis.prompt = () => null;
    const cancelled = await mountDock(FAKE_PRIMITIVES, routed, null);
    const chip2 = cancelled.render().children[0];
    chip2.props.onClick();
    await flush();
    const menu2 = cancelled.render().children.find((node) => node !== null && node !== undefined && node.type === FAKE_PRIMITIVES.Menu);
    menu2.props.onSelect('__dshsm-add-workspace');
    await flush();
    await flush();
    assert.equal(cancelled.calls.filter((call) => /\/move$/.test(call.url)).length, 0, '取消后不该发请求');
  } finally {
    if (savedPrompt === undefined) delete globalThis.prompt;
    else globalThis.prompt = savedPrompt;
  }
});

test('拖动：拖到「未分组」组 = 移出工作区（调 /move-out，不发 /move）', async () => {
  const harness = await mountDrag({
    '/move-out': (body) => ({ ok: true, sessionId: body && body.sessionId, detachedFrom: { id: 'ws-src', title: '源工作区' } }),
  });
  const src = makeGroup('ws-src', [SESSION_ID]);
  const ungrouped = makeGroup('', [OTHER_SESSION]);   // data-row-key="workspace:" → 未分组组
  makeTree([src, ungrouped]);

  harness.drag.onDragStart(makeEvent(rowsIn(src, 'session:')[0]));
  assert.equal(harness.drag.state.sourceWorkspaceId, 'ws-src', '前置：源工作区');

  const dropEvent = makeEvent(rowsIn(ungrouped, 'session:')[0]);
  harness.drag.onDrop(dropEvent);
  await flush();

  assert.equal(dropEvent.propagationStopped, true, '必须吃掉官方的 drop');
  const outs = harness.calls.filter((call) => /\/move-out$/.test(call.url));
  assert.equal(outs.length, 1, '移出工作区走 /move-out');
  assert.equal(outs[0].body.sessionId, SESSION_ID);
  assert.equal(harness.calls.filter((call) => /\/move$/.test(call.url)).length, 0, '不该发 /move');
  assert.equal(harness.drag.state.sessionId, null, '拖完要清状态');
  delete globalThis.document;
});

test('拖动：本来就在「未分组」的行，拖回未分组组不接管（交给官方）', async () => {
  const harness = await mountDrag({});
  const ungrouped = makeGroup('', [SESSION_ID]);
  makeTree([ungrouped]);

  harness.drag.onDragStart(makeEvent(rowsIn(ungrouped, 'session:')[0]));
  const dropEvent = makeEvent(rowsIn(ungrouped, 'session:')[0]);
  harness.drag.onDrop(dropEvent);
  await flush();
  delete globalThis.document;
  assert.equal(dropEvent.propagationStopped, false, '不该接管');
  // onDragStart 可能问一次 /describe 探源工作区（本来就在未分组时拿不到），但绝不该发搬移请求。
  const writes = harness.calls.filter((call) => /\/move(-out)?$/.test(call.url));
  assert.equal(writes.length, 0, '一个搬移请求都不该发');
});

test('拖动：边缘自动滚动——步骤曲线（越靠边越快，2~22px）', async () => {
  const harness = await mountDrag({});
  assert.equal(harness.drag.scrollStepFor(0), 2, '刚进边缘最慢');
  assert.equal(harness.drag.scrollStepFor(84), 22, '贴到边上最快');
  assert.equal(harness.drag.scrollStepFor(999), 22, '超出不更大');
  const near = harness.drag.scrollStepFor(60);
  const far = harness.drag.scrollStepFor(20);
  assert.ok(near > far, '越靠边（distance 越大）滚得越快');
  delete globalThis.document;
});

test('拖动：自动滚动认滚动容器（不依赖 class 名），滚到底会自己停', async () => {
  const harness = await mountDrag({});
  const scroll = { overflowY: 'auto', scrollHeight: 900, clientHeight: 400, parentElement: null };
  const row = { parentElement: scroll };
  const savedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = (node) => (node === scroll ? { overflowY: 'auto' } : { overflowY: 'visible' });

  assert.equal(harness.drag.findScrollableAncestor(row), scroll, '应当认出可滚动的祖先');
  assert.equal(harness.drag.findScrollableAncestor({ parentElement: null }), null, '找不到就返回 null');

  // 造一个会被夹住的滚动条：滚到底再滚就不会再变
  let top = 100;
  const scroller = {
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(1600, value)); },
    getBoundingClientRect: () => ({ top: 0, bottom: 400, left: 0, right: 280, height: 400 }),
  };
  let frames = 0;
  const savedRaf = globalThis.requestAnimationFrame;
  const savedCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => { frames += 1; return frames; };
  globalThis.cancelAnimationFrame = () => {};

  const state = harness.drag.state;
  state.sessionId = SESSION_ID;
  state.scrollEl = scroller;
  state.pointer = { x: 100, y: 398 };          // 贴着底部边缘
  harness.drag.autoScrollTick();
  assert.ok(scroller.scrollTop > 100, '应当往下滚');
  assert.equal(frames, 1, '滚动了就排下一帧');

  state.pointer = { x: 100, y: 200 };          // 中间：不滚
  const before = scroller.scrollTop;
  harness.drag.autoScrollTick();
  assert.equal(scroller.scrollTop, before, '不在边缘就不滚');
  assert.equal(frames, 1, '没滚就不该排帧');

  top = 1600;                                   // 到底了
  state.pointer = { x: 100, y: 398 };
  const atBottom = frames;
  harness.drag.autoScrollTick();
  assert.equal(frames, atBottom, '到底了要停，不能空转 rAF');

  state.pointer = { x: 900, y: 398 };          // 指针甩出侧栏
  top = 100;
  const outside = frames;
  harness.drag.autoScrollTick();
  assert.equal(frames, outside, '指针不在侧栏里就不滚');

  globalThis.getComputedStyle = savedStyle;
  if (savedRaf === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = savedRaf;
  if (savedCancel === undefined) delete globalThis.cancelAnimationFrame;
  else globalThis.cancelAnimationFrame = savedCancel;
  delete globalThis.document;
});


// ── 全选（工作区标题行 + 每个工作区行） ──────────────────────────────────────
//
// 官方结构（client-ui-workspace 的 renderGroup + ProjectRowItem）：
//   div[role="tree"]
//     div.groupSection
//       span (HoverCard wrapper) → div[data-row-key="workspace:X"][role="treeitem"]
//           子节点：slot(folder) / slot(chevron) / span.projectText / span.rowActions
//       span (wrapper) → div[data-row-key="session:…"][role="treeitem"]
//     （嵌套工作区是 groupSection 里的 div[role="group"]）
// 标题行是独立的一个 div[data-sidebar-workspace-header]，含 sectionLabel / searchSlot / headerActions。

/** 一个够用的 DOM：支持 querySelector(All)、类/属性/前缀选择器、insertBefore、remove、监听。 */
function makeSelectAllDom() {
  const listeners = new Map();
  let observerCallback = null;
  const observedRoots = [];

  function matches(node, selector) {
    const text = String(selector).trim();
    if (text.length === 0) return false;
    if (text.charAt(0) === '.') return node.classList.contains(text.slice(1));
    const classStar = /^\[class\*=["']([^"']+)["']\]$/.exec(text);
    if (classStar !== null) return node.className.indexOf(classStar[1]) >= 0;
    const attrStarts = /^\[([a-zA-Z-]+)\^=["']([^"']*)["']\]$/.exec(text);
    if (attrStarts !== null) {
      const value = node.getAttribute(attrStarts[1]);
      return typeof value === 'string' && value.indexOf(attrStarts[2]) === 0;
    }
    const role = /^\[role=["']([^"']+)["']\]$/.exec(text);
    if (role !== null) return node.getAttribute('role') === role[1];
    const attrEq = /^\[([a-zA-Z-]+)(?:=["']([^"']*)["'])?\]$/.exec(text);
    if (attrEq !== null) {
      const value = node.getAttribute(attrEq[1]);
      if (value === null) return false;
      return attrEq[2] === undefined ? true : value === attrEq[2];
    }
    return false;
  }

  function queryAll(root, selector) {
    for (const part of String(selector).split(',')) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child, part)) found.push(child);
          walk(child);
        }
      };
      walk(root);
      if (found.length > 0) return found;
    }
    return [];
  }

  function makeEl(tag, className) {
    const node = {
      tagName: tag === undefined ? 'div' : tag,
      children: [],
      parentElement: null,
      textContent: '',
      style: {},
      attributes: {},
      handlers: new Map(),
      classList: {
        set: new Set(String(className === undefined ? '' : className).split(/\s+/).filter(Boolean)),
        add(name) { this.set.add(name); },
        remove(name) { this.set.delete(name); },
        contains(name) { return this.set.has(name); },
      },
      get className() { return Array.from(this.classList.set).join(' '); },
      set className(value) { this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
      appendChild(child) {
        if (child.parentElement !== null) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.push(child);
        return child;
      },
      insertBefore(child, before) {
        if (before === undefined || before === null) return this.appendChild(child);
        const at = this.children.indexOf(before);
        if (at < 0) return this.appendChild(child);
        if (child.parentElement !== null) child.parentElement.removeChild(child);
        child.parentElement = this;
        this.children.splice(at, 0, child);
        return child;
      },
      removeChild(child) {
        const at = this.children.indexOf(child);
        if (at >= 0) this.children.splice(at, 1);
        child.parentElement = null;
      },
      remove() { if (this.parentElement !== null) this.parentElement.removeChild(this); },
      addEventListener(type, handler) { this.handlers.set(type, handler); },
      get firstChild() { return this.children.length === 0 ? null : this.children[0]; },
      querySelector(selector) {
        const found = queryAll(this, selector);
        return found.length === 0 ? null : found[0];
      },
      querySelectorAll(selector) { return queryAll(this, selector); },
    };
    return node;
  }

  const body = makeEl('body');
  const head = makeEl('head');
  const tree = makeEl('div');
  tree.setAttribute('role', 'tree');
  const root = makeEl('div');
  root.appendChild(tree);

  const header = makeEl('div', '_sectionHeader');
  header.setAttribute('data-sidebar-workspace-header', '');
  header.appendChild(makeEl('span', '_sectionLabel'));
  header.appendChild(makeEl('span', '_searchSlot'));
  header.appendChild(makeEl('span', '_headerActions'));
  root.appendChild(header);

  /** 一个工作区分组；extra 支持 nested（子组）与 overflow（折叠行）。 */
  function addGroup(workspaceId, sessionIds, extra) {
    const options = extra === undefined ? {} : extra;
    const section = makeEl('div', '_groupSection');
    const wrapper = makeEl('span', '_HoverCard_root');
    const headRow = makeEl('div', '_projectRow');
    headRow.setAttribute('data-row-key', 'workspace:' + workspaceId);
    headRow.setAttribute('role', 'treeitem');
    headRow.appendChild(makeEl('span', '_projectText'));
    headRow.appendChild(makeEl('span', '_rowActions'));
    wrapper.appendChild(headRow);
    section.appendChild(wrapper);

    const appendSessions = (into, ids) => {
      for (const id of ids) {
        const sw = makeEl('span');
        const row = makeEl('div', '_sessionRow');
        row.setAttribute('data-row-key', 'session:' + id);
        row.setAttribute('role', 'treeitem');
        sw.appendChild(row);
        into.appendChild(sw);
      }
    };
    appendSessions(section, sessionIds);

    if (options.nested !== undefined) {
      const nest = makeEl('div');
      nest.setAttribute('role', 'group');
      const outer = makeEl('div', '_groupSection');
      const iw = makeEl('span', '_HoverCard_root');
      const ih = makeEl('div', '_projectRow');
      ih.setAttribute('data-row-key', 'workspace:' + options.nested.id);
      ih.setAttribute('role', 'treeitem');
      ih.appendChild(makeEl('span', '_projectText'));
      ih.appendChild(makeEl('span', '_rowActions'));
      iw.appendChild(ih);
      outer.appendChild(iw);
      appendSessions(outer, options.nested.sessions);
      nest.appendChild(outer);
      section.appendChild(nest);
    }

    if (options.overflow === true) {
      const ow = makeEl('span');
      const orow = makeEl('div');
      orow.setAttribute('data-row-key', 'overflow:' + workspaceId);
      orow.setAttribute('role', 'treeitem');
      ow.appendChild(orow);
      section.appendChild(ow);
    }

    tree.appendChild(section);
    return { section, headRow, wrapper };
  }

  const doc = {
    body,
    head,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    createElement(tag) { return makeEl(tag); },
    querySelector(selector) {
      const found = queryAll(root, selector);
      return found.length === 0 ? null : found[0];
    },
    querySelectorAll(selector) { return queryAll(root, selector); },
    dispatchEvent() { return true; },
  };

  /** 装一个记录回调的 MutationObserver 替身（真实浏览器里就是它驱动补装饰）。 */
  function installObserver() {
    globalThis.MutationObserver = class {
      constructor(callback) { observerCallback = callback; }
      observe(node) { observedRoots.push(node); }
      disconnect() { observerCallback = null; }
    };
  }

  return {
    doc, tree, header, body, root, addGroup, makeEl, listeners, observedRoots,
    installObserver,
    fire(records) { if (typeof observerCallback === 'function') observerCallback(records); },
    observerActive() { return typeof observerCallback === 'function'; },
    groupBox(id) {
      const row = doc.querySelector('[data-row-key="workspace:' + id + '"]');
      return row === null ? null : row.querySelector('.dshsm-select-all');
    },
    headerBox() { return doc.querySelector('.dshsm-select-all-head'); },
  };
}

async function bootSelectAll(dom) {
  const api = await makeBulkApi();
  globalThis.document = dom.doc;
  installBulkGlobals();
  return api;
}

test('全选：工作区框只含本组会话（HoverCard 包一层后仍然正确）', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1', 'ses-2']);
  dom.addGroup('ws-b', ['ses-3']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  const box = dom.groupBox('ws-a');
  assert.ok(box !== null, '工作区行里应当有全选框');
  assert.equal(box.getAttribute('role'), 'checkbox');
  assert.deepEqual(box.__dshsmIds, ['ses-1', 'ses-2'], '只含本组会话（工作区行外面那层 HoverCard wrapper 不能让这里变空）');
  assert.deepEqual(dom.groupBox('ws-b').__dshsmIds, ['ses-3']);
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：嵌套工作区（role="group"）里的会话不算进父组', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1'], { nested: { id: 'ws-child', sessions: ['ses-9'] } });
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  assert.deepEqual(dom.groupBox('ws-a').__dshsmIds, ['ses-1'], '父组只含自己的会话');
  assert.deepEqual(dom.groupBox('ws-child').__dshsmIds, ['ses-9'], '子组自己那一份');
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：标题行「工作区 N」全选所有会话', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1', 'ses-2']);
  dom.addGroup('ws-b', ['ses-3']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  const box = dom.headerBox();
  assert.ok(box !== null, '标题行里应当有全选框');
  assert.deepEqual(box.__dshsmIds, ['ses-1', 'ses-2', 'ses-3']);
  box.handlers.get('click')({ stopPropagation() {}, preventDefault() {} });
  assert.equal(api.__bulk.state.selecting, true, '点全选不该退出多选');
  assert.deepEqual(api.__bulk.state.selected, { 'ses-1': true, 'ses-2': true, 'ses-3': true });
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：点一下全选本组，再点清空；组框点击要 stopPropagation', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1', 'ses-2']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  const box = dom.groupBox('ws-a');
  let stopped = null;
  box.handlers.get('click')({ stopPropagation() { stopped = 'yes'; }, preventDefault() {} });

  assert.equal(stopped, 'yes', '必须拦住，否则工作区行会顺带折叠/展开整组');
  assert.deepEqual(api.__bulk.state.selected, { 'ses-1': true, 'ses-2': true }, '点一下 → 本组全选中');
  assert.equal(box.getAttribute('aria-checked'), 'true');
  assert.equal(box.textContent, '\u2713');

  box.handlers.get('click')({ stopPropagation() {}, preventDefault() {} });
  assert.deepEqual(api.__bulk.state.selected, {}, '再点 → 全部移出');
  assert.equal(box.getAttribute('aria-checked'), 'false');
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：手动勾一个后组框变 mixed（双向同步）', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1', 'ses-2']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  const row = dom.doc.querySelector('[data-row-key="session:ses-1"]');
  dom.listeners.get('click')({ target: { closest: () => row }, preventDefault() {}, stopPropagation() {} });
  await flush();
  api.__bulk.bulkDecorate();

  const box = dom.groupBox('ws-a');
  assert.equal(box.getAttribute('aria-checked'), 'mixed', '选了一半 → mixed');
  assert.equal(box.textContent, '\u2212', 'mixed 用减号，和圆点风格一致');
  assert.equal(api.__bulk.state.countNode.textContent, '已选 1 个');
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：退出多选时框和 spacer 立刻都不在 DOM 里', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();
  assert.ok(dom.groupBox('ws-a') !== null);
  assert.ok(dom.headerBox() !== null);
  assert.ok(dom.doc.querySelector('.dshsm-flex-spacer') !== null, 'spacer 撑住位置');

  api.__bulk.exitBulk();
  assert.equal(dom.doc.querySelector('.dshsm-select-all'), null, '同步摘掉，不等下一帧');
  assert.equal(dom.doc.querySelector('.dshsm-flex-spacer'), null, 'spacer 也要同步摘掉，否则行尾会抖一下');
  assert.equal(dom.observerActive(), false, 'observer 要断开');
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：observer 不因自己插的节点而再次调度（忽略自己）', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1']);
  const api = await bootSelectAll(dom);
  dom.installObserver();
  api.__bulk.enterBulk();
  await flush();

  assert.equal(dom.observedRoots[0], dom.tree, '观察根应当是列表本身（不是 document：正文每个 token 都会唤醒）');

  // 装饰是 rAF 排程的，单次 flush 不保证已经跑完 —— 框还没被创建时
  // `groupBox()` 返回 null，这一发就变成了「null 不是自己插的节点」而误判调度，
  // 整个用例于是随机红。这里先同步跑一趟装饰，拿到真的框再测观察器。
  api.__bulk.bulkDecorate();
  const ownBox = dom.groupBox('ws-a');
  assert.ok(ownBox !== null, '被测的前提：框已经挂上');

  // 自己插的框/spacer 造成的变异 → 不该再调度
  let ownScheduled = false;
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => { ownScheduled = true; fn(); return 1; };
  api.__bulk.state.raf = null;
  dom.fire([{ addedNodes: [ownBox], removedNodes: [] }]);
  assert.equal(ownScheduled, false, '自己插的节点不该触发下一轮装饰');

  // 宿主新增了一行 → 必须补装饰
  let hostScheduled = false;
  globalThis.requestAnimationFrame = (fn) => { hostScheduled = true; fn(); return 1; };
  api.__bulk.state.raf = null;
  const hostRow = dom.makeEl('div', '_sessionRow');
  hostRow.setAttribute('data-row-key', 'session:ses-2');
  hostRow.setAttribute('role', 'treeitem');
  dom.fire([{ addedNodes: [hostRow], removedNodes: [] }]);
  globalThis.requestAnimationFrame = original;
  api.__bulk.state.raf = null;
  assert.equal(hostScheduled, true, '宿主新增一行时应当重新装饰');
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：半选时再点框 → 补齐成全部选中（不是清空）', async () => {
  // 空 → 全选，半选 → 补齐，全选 → 清空（和 dsh-delete-session 的 toggleGroup 同语义）。
  // 本插件原来写的是 state === 'false' 才算 fill，半选时点一下把已选的全清掉。
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1', 'ses-2', 'ses-3']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  // 先手动勾一个 → 组框变 mixed
  const row = dom.doc.querySelector('[data-row-key="session:ses-2"]');
  dom.listeners.get('click')({ target: { closest: () => row }, preventDefault() {}, stopPropagation() {} });
  assert.equal(dom.groupBox('ws-a').getAttribute('aria-checked'), 'mixed', '1/3 → mixed');

  // 点框：补齐成 3/3，而不是把 ses-2 清掉（toggleGroup 同步，直接断言）
  dom.groupBox('ws-a').handlers.get('click')({ stopPropagation() {}, preventDefault() {} });
  assert.equal(api.__bulk.state.selected['ses-2'], true, '已选的不能被清掉');
  assert.equal(api.__bulk.state.selected['ses-1'], true, '补上别的');
  assert.equal(api.__bulk.state.selected['ses-3'], true, '补上别的');
  assert.equal(dom.groupBox('ws-a').getAttribute('aria-checked'), 'true', '补齐后是 true');
  delete globalThis.document;
  delete globalThis.MutationObserver;
})

test('全选：全勾状态下再点框 → 清空', async () => {
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1', 'ses-2']);
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  // 先把两个都勾上（走真实的行点击，这样组框会变成 ✓）。
  for (const id of ['ses-1', 'ses-2']) {
    const row = dom.doc.querySelector('[data-row-key="session:' + id + '"]');
    dom.listeners.get('click')({ target: { closest: () => row }, preventDefault() {}, stopPropagation() {} });
  }
  assert.equal(dom.groupBox('ws-a').getAttribute('aria-checked'), 'true', '前提：已经全勾');

  // 现在点一次框 → 清空
  dom.groupBox('ws-a').handlers.get('click')({ stopPropagation() {}, preventDefault() {} });
  assert.equal(api.__bulk.state.selected['ses-1'], undefined, '再点 → 清空');
  assert.equal(dom.groupBox('ws-a').getAttribute('aria-checked'), 'false', '清零后是空');
  delete globalThis.document;
  delete globalThis.MutationObserver;
})

test('全选：组底部有 overflow 行（收起）时，全勾仍然显示 ✓', async () => {
  // 宿主每个组底部都有一行 `overflow:<ws>`：组展开时它写「收起」，折叠时写
  // 「展开其余 N 个会话」。**它存在不等于有会话被藏起来**。曾经拿它当
  // 「这组选不全」的证据，结果两个框永远显示 −，30 个全勾也打不了勾。
  const dom = makeSelectAllDom();
  dom.addGroup('ws-a', ['ses-1'], { overflow: true });
  const api = await bootSelectAll(dom);
  api.__bulk.enterBulk();
  api.__bulk.bulkDecorate();

  const box = dom.groupBox('ws-a');
  assert.ok(box !== null, '前提：框已经挂上');
  box.handlers.get('click')({ stopPropagation() {}, preventDefault() {} });
  assert.deepEqual(api.__bulk.state.selected, { 'ses-1': true });
  assert.equal(box.getAttribute('aria-checked'), 'true', '这一组可见的都勾上了 → ✓');
  assert.equal(box.textContent, '\u2713', '符号也是勾');
  delete globalThis.document;
  delete globalThis.MutationObserver;
});

test('全选：两个插件同时存在时，BulkEntry / BulkBar 仍返回 null（互让没被破坏）', async () => {
  const api = await makeBulkApi();
  const dom = makeBulkDom([]);
  globalThis.document = dom.doc;
  installBulkGlobals();
  globalThis.__DSH_DELETE_SESSION__ = { supportsBulkMove: true };
  assert.equal(api.__bulkEntry({}), null, '多选入口仍让位');
  assert.equal(api.__bulk.BulkBar({}), null, '底栏仍让位');
  delete globalThis.__DSH_DELETE_SESSION__;
  delete globalThis.document;
});

test('全选：框的形态和 dsh-delete-session 一致', async () => {
  // 两个都装时本插件的入口与底栏都让位，用户看到的全选来自 dsh-delete-session；
  // 只有单独装本插件的人才会见到这里的框。两套框必须长得一样，
  // 否则同一个人在不同机器上会见到两种控件。
  const api = await makeBulkApi();
  const css = api.__ui.css();
  assert.match(css, /\.dshsm-select-all\{[^}]*width:15px/, '15px 宽，和 dsh-delete-session 一致');
  assert.match(css, /\.dshsm-select-all\{[^}]*height:15px/, '15px 高');
  assert.match(css, /\.dshsm-select-all\{[^}]*min-width:15px/, 'flex 不能把它压没');
  assert.match(css, /\.dshsm-select-all\{[^}]*border:1px solid/, '1px 描边（不是 1.5px）');
  assert.match(css, /\.dshsm-select-all\{[^}]*border-radius:4px/, '4px 圆角方框（不是圆点）');
  assert.match(css, /\.dshsm-select-all\{[^}]*font-size:10px/, '10px 字号');
  // 会话行的勾选圈仍然保持圆形（和 dsh-delete-session 的 .dsdel-check 一样），
  // 只有全选框要变成方框 —— 所以把范围限定在那条规则上。
  const baseRule = /\.dshsm-select-all\{[^}]*\}/.exec(css);
  assert.ok(baseRule !== null, '.dshsm-select-all 的基础规则存在');
  assert.equal(baseRule[0].includes('border-radius:50%'), false, '全选框不是圆点');
})
