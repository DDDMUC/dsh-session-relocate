/**
 * dsh-session-relocate —— 网页端。
 *
 * 往侧边栏「会话行 ->  ...  」菜单里注入一项「移动到」：点开列出其它工作区，
 * 选中后调用主机侧桥接 /api/dsh-session-relocate/move 完成迁移。
 *
 * 形态是 DSH 客户端的 lazy-CJS 包：只注册一个工厂，模块体副作用在首次物化时才跑。
 * 唯一的外部依赖是 react（平台基座模块），因此不需要打包器。
 *
 * 有意只用 <button role="menuitem"> 作为树的节点（不套 div）：菜单的键盘遍历读 DOM，
 * 这样每一项都能正常加入，也不会破坏既有菜单结构。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-relocate',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');

    var STYLE_ID = 'dsh-session-relocate-styles';
    var CSS = [
      '.dshsm-item{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:13px;line-height:1.45;padding:6px 10px;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;white-space:normal;overflow-wrap:anywhere}',
      '.dshsm-item:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12))}',
      '.dshsm-item:disabled{color:var(--dsw-alias-label-caption,#8b8b8b);cursor:default}',
      '.dshsm-target{padding-left:18px}',
      '.dshsm-meta{display:block;font-size:11px;color:var(--dsw-alias-label-caption,#8b8b8b);overflow-wrap:anywhere}',
      '.dshsm-bad{color:#ff453a}',
      // 拖动时给工作区行加的高亮（官方行本身没有 drop 语义，所以这个类只由本插件加）
      '.dshsm-drop{outline:2px solid #4c8dff;outline-offset:-2px;border-radius:6px}',
    ].join('');

    function ensureStyles() {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-session-relocate';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * 引导全局。0.1.0 起叫 __DSH_SESSION_RELOCATE__；**改名过渡期**里主机侧可能还是旧版
     * （注入的是 __DSH_SESSION_MOVE__），所以两个名字都认 —— 否则「客户端已改名、主机还没重启」
     * 这半截状态下，页面刷新后菜单和拖动会去请求一个主机根本不服务的前缀。
     */
    function bootGlobal() {
      if (typeof globalThis === 'undefined') return null;
      var current = globalThis.__DSH_SESSION_RELOCATE__;
      if (current !== null && current !== undefined) return current;
      var legacy = globalThis.__DSH_SESSION_MOVE__;
      if (legacy !== null && legacy !== undefined) return legacy;
      return null;
    }

    /** 桥接前缀由主机侧通过引导全局下发；取不到就用默认值。 */
    function bridgePrefix() {
      var boot = bootGlobal();
      if (boot !== null && typeof boot === 'object' && typeof boot.prefix === 'string' && boot.prefix.length > 0) {
        return boot.prefix;
      }
      return '/api/dsh-session-relocate';
    }

    function isChinese() {
      var language = globalThis.navigator !== undefined ? globalThis.navigator.language : '';
      return typeof language === 'string' && /^zh/i.test(language);
    }

    var ZH = {
      open: '移动到',
      loading: '正在读取工作区…',
      pick: '移动到：',
      noTargets: '没有其它工作区',
      chooseDir: '其它目录…',
      chooseDirPrompt: '输入目标目录的绝对路径（不存在会被创建并注册成新工作区）：',
      moving: '正在移动…',
      done: '已移动',
      pending: '文件已搬移；工作区归属会在下次启动 DSH 时自动补齐',
      cannot: '这个对话无法移动',
      failed: '移动失败',
      needsReload: '（刷新页面后生效）',
      dragMoved: '已移动到「{ws}」',
      dragFailed: '移动失败：',
    };
    var EN = {
      open: 'Move to',
      loading: 'Loading workspaces…',
      pick: 'Move to:',
      noTargets: 'No other workspace',
      chooseDir: 'Other directory…',
      chooseDirPrompt: 'Absolute path of the target directory (it is created and registered as a new workspace if missing):',
      moving: 'Moving…',
      done: 'Moved',
      pending: 'Files moved; the workspace accounting is completed on the next DSH start',
      cannot: 'This conversation cannot be moved',
      failed: 'Move failed',
      needsReload: ' (reload the page to apply)',
      dragMoved: 'Moved to “{ws}”',
      dragFailed: 'Move failed: ',
    };

    function text() {
      return isChinese() ? ZH : EN;
    }

    function post(path, body) {
      var options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body !== undefined ? body : {}) };
      return fetch(bridgePrefix() + path, options).then(function (response) {
        return response.json().then(function (payload) { return payload; }, function () {
          return { ok: false, code: 'bad-response', message: 'HTTP ' + String(response.status) };
        });
      });
    }

    function errorText(error) {
      if (error !== null && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
        return error.message;
      }
      return String(error);
    }

    /** 渲染一个菜单按钮。 */
    function button(key, label, options) {
      var props = Object.assign({ key: key, type: 'button', role: 'menuitem', className: 'dshsm-item' }, options || {});
      return react.createElement('button', props, label);
    }

    /** 带标题 + 灰色副标题的两行按钮内容。 */
    function twoLine(title, meta) {
      return [title, react.createElement('span', { key: 'meta', className: 'dshsm-meta' }, meta)];
    }

    /**
     * 会话行菜单项。
     * props: sessionId / displayTitle / useMenuOpenState（由 slot 提供）。
     */
    function Entry(props) {
      var sessionId = props.sessionId;
      var useMenuOpenState = props.useMenuOpenState;

      // 必须在顶层无条件调用（hooks 规则）。
      var menuState = null;
      if (typeof useMenuOpenState === 'function') {
        try {
          menuState = useMenuOpenState();
        } catch (error) {
          menuState = null;
        }
      }
      var setMenuOpen = menuState !== null && Array.isArray(menuState) && typeof menuState[1] === 'function' ? menuState[1] : null;

      var stateHook = react.useState({ phase: 'idle' });
      var state = stateHook[0];
      var setState = stateHook[1];
      var strings = text();

      function open() {
        setState({ phase: 'loading' });
        post('/describe', { sessionId: sessionId }).then(function (result) {
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            setState({ phase: 'error', message: (result !== null && typeof result === 'object' && result.message !== undefined) ? result.message : strings.failed });
            return;
          }
          var session = result.session;
          var all = Array.isArray(result.workspaces) ? result.workspaces : [];
          var targets = all.filter(function (workspace) { return workspace.current !== true; });
          if (session === null || typeof session !== 'object' || session.canMove !== true) {
            setState({ phase: 'blocked', message: (session !== null && typeof session === 'object' && session.reason !== undefined && session.reason !== null) ? session.reason : strings.cannot });
            return;
          }
          setState({ phase: 'picking', targets: targets });
        }, function (error) {
          setState({ phase: 'error', message: errorText(error) });
        });
      }

      function run(request) {
        setState({ phase: 'moving' });
        post('/move', Object.assign({ sessionId: sessionId }, request)).then(function (result) {
          if (result === null || typeof result !== 'object' || result.ok !== true) {
            setState({ phase: 'error', message: (result !== null && typeof result === 'object' && result.message !== undefined) ? result.message : strings.failed });
            return;
          }
          setState({ phase: 'done', title: result.targetTitle !== undefined ? result.targetTitle : result.to, applied: result.applied });
          // 成功后排这一行会被工作区列表刷新带走；这里顺手关掉菜单更干净。
          if (setMenuOpen !== null) setMenuOpen(false);
        }, function (error) {
          setState({ phase: 'error', message: errorText(error) });
        });
      }

      function chooseDirectory() {
        var picked = globalThis.prompt(strings.chooseDirPrompt, '');
        if (typeof picked !== 'string' || picked.trim().length === 0) return;
        run({ targetPath: picked.trim() });
      }

      if (state.phase === 'idle') {
        return button('open', strings.open, { onClick: open });
      }
      if (state.phase === 'loading') {
        return button('loading', strings.loading, { disabled: true });
      }
      if (state.phase === 'moving') {
        return button('moving', strings.moving, { disabled: true });
      }
      if (state.phase === 'blocked') {
        return button('blocked', state.message, { disabled: true });
      }
      if (state.phase === 'error') {
        return button('error', strings.failed + '：' + state.message, { disabled: true, className: 'dshsm-item dshsm-bad' });
      }
      if (state.phase === 'done') {
        var suffix = state.applied === 'pending' ? strings.pending : (state.applied === 'live' ? '' : strings.needsReload);
        return button('done', strings.done + ' ' + String(state.title) + (suffix.length > 0 ? '；' + suffix : ''), { disabled: true });
      }
      // picking
      var nodes = [button('caption', strings.pick + (state.targets.length === 0 ? ' ' + strings.noTargets : ''), { disabled: true })];
      for (var i = 0; i < state.targets.length; i++) {
        (function (workspace) {
          nodes.push(button('ws-' + workspace.id, twoLine(workspace.title, workspace.path), {
            className: 'dshsm-item dshsm-target',
            onClick: function () { run({ targetWorkspaceId: workspace.id }); },
          }));
        })(state.targets[i]);
      }
      nodes.push(button('choose-dir', strings.chooseDir, { className: 'dshsm-item dshsm-target', onClick: chooseDirectory }));
      return react.createElement(react.Fragment, null, nodes);
    }

    // ── 拖动搬移 ────────────────────────────────────────────────────────────
    //
    // 官方侧边栏给每一行都写了稳定的 data-row-key（client-ui-workspace）：
    //   会话行   data-row-key="session:<sessionId>"      (client.js:2250)
    //   工作区行 data-row-key="workspace:<workspaceId>"  (client.js:1945，key 就是 workspaceId)
    // 所以这里**不依赖任何未公开的拖拽载荷**（dataTransfer 在 dragover 阶段本来就取不到
    // 数据），只读这两个属性。
    //
    // 官方自己的拖动只做排序：会话拖到别的会话行上 = 在**本工作区**内重排
    // （commitSessionDrag → setSessionOrder(accountKey, …)，accountKey 就是源工作区），
    // 拖到工作区行上官方什么都不做。跨工作区搬移是官方没有的语义，所以由本插件接管。
    //
    // 关键：按**分组归属**决定介不介入，而不是按「指针下那一行是不是文件夹行」。
    // 官方每个工作区渲染成一个分组容器（renderGroup → div.groupSection：先文件夹行、再它的会话行），
    // 于是：
    //   - 指针在**别的**分组里（文件夹行 / 它的任意一条会话行 / 分组里的空隙）→ 接管，搬过去；
    //   - 指针在**它自己所在**的那个分组里 → 完全让路，官方的工作区内排序照旧。
    // 这样「拖到对应工作区那块区域就能换」成立，官方的组内重排一点也没被抢。
    var ROW_KEY_ATTR = 'data-row-key';
    var SESSION_PREFIX = 'session:';
    var WORKSPACE_PREFIX = 'workspace:';
    var DROP_CLASS = 'dshsm-drop';
    var TOAST_ATTR = 'data-dshsm-toast';
    var ROW_WALK_LIMIT = 8;

    var dragState = {
      sessionId: null,
      sourceWorkspaceId: null,
      targetSection: null,
      sourceBySession: {},
    };
    var toastNode = null;
    var toastTimer = null;

    /** 从事件目标向上找最近的 data-row-key 元素（会话行 / 工作区行都不是彼此的祖先）。 */
    function nearestRow(target) {
      var node = target;
      for (var depth = 0; depth < ROW_WALK_LIMIT && node !== null && node !== undefined; depth += 1) {
        if (typeof node.getAttribute === 'function') {
          var key = node.getAttribute(ROW_KEY_ATTR);
          if (typeof key === 'string' && key.length > 0) return node;
        }
        node = node.parentElement;
      }
      return null;
    }

    var WORKSPACE_ROW_SELECTOR = '[' + ROW_KEY_ATTR + '^="' + WORKSPACE_PREFIX + '"]';

    /**
     * 指针下这个位置属于哪个工作区分组 —— **整块分组区域都算投放目标**，不再只认那 34px 的文件夹行。
     *
     * 官方侧边栏把每个工作区渲染成一个分组容器（renderGroup → div.groupSection：先放工作区行，
     * 再放它自己的会话行）。所以「最近的、恰好只含一个工作区行的祖先」就是这个分组：
     *   - 指针落在文件夹行上 → 就是它自己那一层；
     *   - 指针落在它下面任意一条会话行上（或「展开其余 N 个会话」上、或分组里的空隙上）→ 向上走到同一个容器；
     *   - 再往上整棵 role="tree" 列表含多个工作区行，说明指针不在任何分组里 → null。
     *
     * 拿不到分组（老版本 DSH / 结构变了）就返回 null，自动退化成「只认工作区行」的老行为。
     */
    function workspaceGroupOf(target) {
      var node = target;
      var best = null;
      for (var depth = 0; depth < ROW_WALK_LIMIT && node !== null && node !== undefined; depth += 1) {
        // 列表根（role="tree"）之上就再没有分组了，别把整棵列表当成分组。
        if (typeof node.getAttribute === 'function' && node.getAttribute('role') === 'tree') break;
        if (typeof node.querySelectorAll === 'function') {
          var rows = node.querySelectorAll(WORKSPACE_ROW_SELECTOR);
          if (rows !== null && rows !== undefined && typeof rows.length === 'number') {
            // 含多个工作区行 = 已经越过分组这一层（整棵列表 / 滚动容器），停。
            if (rows.length > 1) break;
            // 恰好一个 = 就是「这个分组」（或行外面那层 wrapper）→ 继续向上取最高的那一层。
            if (rows.length === 1) best = { section: node, row: rows[0], workspaceId: workspaceIdOf(rows[0]) };
          }
        }
        node = node.parentElement;
      }
      return best !== null && best.workspaceId !== null ? best : null;
    }

    function workspaceIdOf(row) {
      if (row === null || row === undefined || typeof row.getAttribute !== 'function') return null;
      var key = row.getAttribute(ROW_KEY_ATTR);
      if (typeof key !== 'string' || key.indexOf(WORKSPACE_PREFIX) !== 0) return null;
      var id = key.slice(WORKSPACE_PREFIX.length);
      return id.length > 0 ? id : null;
    }

    function toggleDropClass(row, on) {
      if (row === null || row === undefined) return;
      var list = row.classList;
      if (list === undefined || list === null || typeof list.add !== 'function') return;
      if (on) list.add(DROP_CLASS);
      else list.remove(DROP_CLASS);
    }

    /** 高亮**整块分组**（不是那一行）：让人一眼看出「松手就搬到这个工作区」。 */
    function highlightGroup(section) {
      if (dragState.targetSection === section) return;
      clearHighlight();
      dragState.targetSection = section;
      toggleDropClass(section, true);
    }

    function clearHighlight() {
      toggleDropClass(dragState.targetSection, false);
      dragState.targetSection = null;
    }

    function resetDrag() {
      clearHighlight();
      dragState.sessionId = null;
      dragState.sourceWorkspaceId = null;
    }

    /** 解析投放目标：没有正在拖的会话、或指针不在任何工作区分组里，就返回 null。 */
    function resolveDrop(event) {
      if (dragState.sessionId === null) return null;
      var target = event !== null && event !== undefined ? event.target : null;
      var group = workspaceGroupOf(target);
      if (group === null) {
        // 退化路径：读不到分组结构（老版本 DSH / 结构变了）时，回到「只认工作区行」的老行为，
        // 绝不因为读不到就去乱接管（那会破坏官方的工作区内排序）。
        var row = nearestRow(target);
        var fallbackId = row === null ? null : workspaceIdOf(row);
        if (fallbackId === null) return null;
        if (dragState.sourceWorkspaceId !== null && dragState.sourceWorkspaceId === fallbackId) return null;
        return { sessionId: dragState.sessionId, targetWorkspaceId: fallbackId, section: row };
      }
      // 落在**它自己所在的那个分组**里 = 官方的工作区内排序区，让路（官方照旧重排）。
      if (dragState.sourceWorkspaceId !== null && dragState.sourceWorkspaceId === group.workspaceId) return null;
      return { sessionId: dragState.sessionId, targetWorkspaceId: group.workspaceId, section: group.section };
    }

    function onDragStart(event) {
      var row = nearestRow(event !== null && event !== undefined ? event.target : null);
      if (row === null || typeof row.getAttribute !== 'function') return;
      var key = row.getAttribute(ROW_KEY_ATTR);
      if (typeof key !== 'string' || key.indexOf(SESSION_PREFIX) !== 0) return;
      var sessionId = key.slice(SESSION_PREFIX.length);
      if (sessionId.length === 0) return;
      resetDrag();
      dragState.sessionId = sessionId;
      if (Object.prototype.hasOwnProperty.call(dragState.sourceBySession, sessionId)) {
        dragState.sourceWorkspaceId = dragState.sourceBySession[sessionId];
        return;
      }
      // 源工作区先从 DOM 直接读（同步、稳）：拖起来的那一行就在它自己的分组里。
      // 读不到再问主机；还是拿不到也无所谓 —— 服务端会用 already-there 兜住。
      var own = workspaceGroupOf(row);
      if (own !== null) {
        dragState.sourceBySession[sessionId] = own.workspaceId;
        dragState.sourceWorkspaceId = own.workspaceId;
        return;
      }
      post('/describe', { sessionId: sessionId }).then(function (result) {
        var session = result !== null && result !== undefined ? result.session : null;
        if (session === null || session === undefined) return;
        dragState.sourceBySession[sessionId] = session.currentWorkspaceId;
        if (dragState.sessionId === sessionId) dragState.sourceWorkspaceId = session.currentWorkspaceId;
      }, function () { /* 探测失败就让服务端兜 */ });
    }

    function onDragOver(event) {
      if (dragState.sessionId === null) return;
      var drop = resolveDrop(event);
      if (drop === null) {
        clearHighlight();
        return;
      }
      if (typeof event.preventDefault === 'function') event.preventDefault();
      var transfer = event.dataTransfer;
      if (transfer !== undefined && transfer !== null) {
        try {
          transfer.dropEffect = 'move';
        } catch (error) { /* 只读实现就算了 */ }
      }
      highlightGroup(drop.section);
    }

    function onDrop(event) {
      if (dragState.sessionId === null) return;
      var drop = resolveDrop(event);
      if (drop === null) {
        clearHighlight();
        return;
      }
      // 必须吃掉这个事件：官方在会话行上还有一套排序用的 drop 处理。
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (typeof event.preventDefault === 'function') event.preventDefault();
      var sessionId = drop.sessionId;
      var targetWorkspaceId = drop.targetWorkspaceId;
      resetDrag();
      moveByDrag(sessionId, targetWorkspaceId);
    }

    function onDragEnd() {
      resetDrag();
    }

    function onDragLeave(event) {
      var related = event !== null && event !== undefined ? event.relatedTarget : null;
      if (related === null || related === undefined) {
        clearHighlight();
        return;
      }
      if (typeof document !== 'undefined' && document.body !== undefined && document.body !== null
        && typeof document.body.contains === 'function' && document.body.contains(related) === false) {
        clearHighlight();
      }
    }

    /** 拖完立刻搬（不再问一次；搬错了再拖回去就行）。 */
    function moveByDrag(sessionId, targetWorkspaceId) {
      var strings = text();
      toast(strings.moving);
      post('/move', { sessionId: sessionId, targetWorkspaceId: targetWorkspaceId }).then(function (result) {
        if (result !== null && result !== undefined && result.ok === true) {
          var title = result.targetTitle;
          var label = typeof title === 'string' && title.length > 0 ? title : targetWorkspaceId;
          toast(strings.dragMoved.replace('{ws}', label));
          return;
        }
        var message = result !== null && result !== undefined && typeof result.message === 'string' ? result.message : '';
        toast(strings.dragFailed + message);
      }, function (error) {
        toast(strings.dragFailed + errorText(error));
      });
    }

    /** 自绘 toast（不依赖官方是否暴露通知服务）。 */
    function toast(message) {
      if (typeof document === 'undefined' || document.body === undefined || document.body === null) return;
      if (toastNode === null || toastNode.parentNode === null || toastNode.parentNode === undefined) {
        toastNode = document.createElement('div');
        toastNode.setAttribute(TOAST_ATTR, '');
        toastNode.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;'
          + 'max-width:70vw;padding:8px 14px;border-radius:8px;background:rgba(28,32,40,.92);color:#fff;'
          + 'font-size:13px;line-height:1.5;overflow-wrap:anywhere;pointer-events:none;opacity:0;'
          + 'box-shadow:0 6px 24px rgba(0,0,0,.28);transition:opacity .22s ease';
        document.body.appendChild(toastNode);
      }
      toastNode.textContent = message;
      toastNode.style.opacity = '1';
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastTimer = null;
        if (toastNode !== null) toastNode.style.opacity = '0';
      }, 2600);
    }

    /** 拖动搬移是否启用（主机侧 config.dragMove，默认开）。 */
    function dragEnabled() {
      var boot = bootGlobal();
      if (boot !== null && typeof boot === 'object' && boot.drag === false) return false;
      return true;
    }

    /** 挂上拖动搬移，返回卸载函数。环境没有 document 就整个不启用。 */
    function installDrag() {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return function () {};
      }
      var capture = true; // 捕获阶段先于官方（React）的处理
      document.addEventListener('dragstart', onDragStart, capture);
      document.addEventListener('dragover', onDragOver, capture);
      document.addEventListener('drop', onDrop, capture);
      document.addEventListener('dragend', onDragEnd, capture);
      document.addEventListener('dragleave', onDragLeave, capture);
      return function () {
        document.removeEventListener('dragstart', onDragStart, capture);
        document.removeEventListener('dragover', onDragOver, capture);
        document.removeEventListener('drop', onDrop, capture);
        document.removeEventListener('dragend', onDragEnd, capture);
        document.removeEventListener('dragleave', onDragLeave, capture);
        resetDrag();
      };
    }

    /** 需要 slots 服务。 */
    var inject = ['slots'];

    function apply(ctx) {
      ensureStyles();
      // 拖动搬移：与菜单那条路并存（拖不动就点菜单）。
      if (!dragEnabled()) {
        // 主机侧关掉了：什么都不挂。
      } else if (typeof ctx.effect === 'function') {
        ctx.effect(installDrag, 'dsh-session-relocate:drag');
      } else {
        installDrag();
      }
      return ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        return ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-relocate', order: 350 },
          Entry,
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__entry = Entry;
    // 给测试用的内部入口（浏览器里没人用）。
    exports.__drag = {
      installDrag: installDrag,
      onDragStart: onDragStart,
      onDragOver: onDragOver,
      onDrop: onDrop,
      onDragEnd: onDragEnd,
      onDragLeave: onDragLeave,
      state: dragState,
      reset: resetDrag,
      nearestRow: nearestRow,
      workspaceGroupOf: workspaceGroupOf,
      workspaceIdOf: workspaceIdOf,
    };
    return module.exports;
  },
});
