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
      '.dshsm-item{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:13px;line-height:1.45;padding:6px 10px;border:0;border-radius:6px;background:0 0;color:inherit;cursor:pointer;white-space:normal;overflow-wrap:anywhere}',
      '.dshsm-item:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12))}',
      '.dshsm-item:disabled{color:inherit;opacity:.45;cursor:default}',
      '.dshsm-target{padding-left:18px}',
      '.dshsm-meta{display:block;font-size:11px;color:inherit;opacity:.65;overflow-wrap:anywhere}',
      '.dshsm-bad{color:#ff453a}',
      // 拖动时给工作区行加的高亮（官方行本身没有 drop 语义，所以这个类只由本插件加）
      '.dshsm-drop{outline:2px solid #4c8dff;outline-offset:-2px;border-radius:6px}',
      // 多选模式：行首勾选圈 + 底部操作条 + 目标工作区面板
      '.dshsm-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-right:6px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.5));background:0 0;flex:none}',
      '.dshsm-check-on{border-color:#4c8dff;background:#4c8dff;box-shadow:inset 0 0 0 3px #fff}',
      '.dshsm-dark .dshsm-check-on{box-shadow:inset 0 0 0 3px #1f232b}',
      '.dshsm-bar{position:fixed;left:12px;bottom:12px;z-index:2147483600;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid transparent;box-shadow:0 8px 28px rgba(0,0,0,.28)}',
      '.dshsm-bar.dshsm-dark{background:#1f232b;color:#f2f3f5;border-color:rgba(255,255,255,.18);color-scheme:dark}',
      '.dshsm-bar.dshsm-light{background:#fff;color:#12151a;border-color:rgba(0,0,0,.14);color-scheme:light}',
      '.dshsm-bar-count{font-size:13px;white-space:nowrap}',
      '.dshsm-bar-btn{appearance:none;min-height:30px;padding:0 12px;border-radius:8px;border:1px solid rgba(127,127,127,.45);background:0 0;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.dshsm-dark .dshsm-bar-btn:hover:not(:disabled){background:rgba(255,255,255,.08)}',
      '.dshsm-light .dshsm-bar-btn:hover:not(:disabled){background:rgba(0,0,0,.06)}',
      '.dshsm-bar-btn:disabled{opacity:.5;cursor:default}',
      '.dshsm-bar-primary{border-color:#4c8dff;background:#4c8dff;color:#fff}',
      '.dshsm-picker-backdrop{position:fixed;inset:0;z-index:2147483602;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42)}',
      '.dshsm-picker{width:min(440px,92vw);max-height:70vh;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:16px;border-radius:14px;border:1px solid transparent;box-shadow:0 18px 48px rgba(0,0,0,.36)}',
      '.dshsm-picker.dshsm-dark{background:#1f232b;color:#f2f3f5;border-color:rgba(255,255,255,.18);color-scheme:dark}',
      '.dshsm-picker.dshsm-light{background:#fff;color:#12151a;border-color:rgba(0,0,0,.14);color-scheme:light}',
      '.dshsm-picker-title{font-size:14px;font-weight:600}',
      '.dshsm-picker-list{display:flex;flex-direction:column;gap:6px}',
      '.dshsm-picker-item{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:8px 10px;border-radius:8px;border:1px solid transparent;background:0 0;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.dshsm-dark .dshsm-picker-item:hover{background:rgba(255,255,255,.08)}',
      '.dshsm-light .dshsm-picker-item:hover{background:rgba(0,0,0,.06)}',
      '.dshsm-picker-name{font-weight:500;color:inherit}',
      '.dshsm-picker-path{font-size:11px;overflow-wrap:anywhere}',
      '.dshsm-dark .dshsm-picker-path,.dshsm-dark .dshsm-picker-empty{color:#a7b0bf}',
      '.dshsm-light .dshsm-picker-path,.dshsm-light .dshsm-picker-empty{color:#667085}',
      '.dshsm-picker-count{font-size:11px}',
      '.dshsm-dark .dshsm-picker-count{color:#a7b0bf}',
      '.dshsm-light .dshsm-picker-count{color:#667085}',
      '.dshsm-picker-item:disabled{opacity:.55;cursor:default}',
      '.dshsm-picker-empty{font-size:12px}',
      '.dshsm-picker-actions{display:flex;justify-content:flex-end}',
      '.dshsm-picker-btn{appearance:none;min-height:30px;padding:0 12px;border-radius:8px;border:1px solid rgba(127,127,127,.45);background:0 0;color:inherit;font:inherit;font-size:13px;cursor:pointer}',
      '.dshsm-dark .dshsm-picker-btn:hover:not(:disabled){background:rgba(255,255,255,.08)}',
      '.dshsm-light .dshsm-picker-btn:hover:not(:disabled){background:rgba(0,0,0,.06)}',
      '.dshsm-picker-btn:disabled{opacity:.45;cursor:default}',
      // 插件设置页：连同子对话开关
      '.dshsm-setting{display:flex;align-items:flex-start;gap:16px;padding:12px 0;width:100%}',
      '.dshsm-setting-text{flex:1;min-width:0}',
      '.dshsm-setting-title{font-size:13px;font-weight:600;line-height:20px}',
      '.dshsm-setting-desc{font-size:12px;line-height:18px;opacity:.7;margin-top:2px}',
      '.dshsm-switch{position:relative;flex:none;width:38px;height:22px;border-radius:11px;border:0;padding:0;cursor:pointer;background:rgba(127,127,127,.4)}',
      '.dshsm-switch[aria-checked="true"]{background:#4c8dff}',
      '.dshsm-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s ease}',
      '.dshsm-switch[aria-checked="true"]::after{left:18px}',
      '.dshsm-card{display:flex;flex-direction:column;gap:10px;width:100%}',
      '.dshsm-star{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;padding:8px 10px;border-radius:8px;border:1px solid rgba(0,0,0,.08);background:rgba(255,196,0,.06);color:inherit;text-decoration:none;font-size:12px;line-height:1.4}',
      '.dshsm-star:hover{background:rgba(255,196,0,.14)}',
      '.dshsm-starIcon{font-size:14px;line-height:1}',
      '.dshsm-starCta{margin-left:auto;color:#8a6d00;font-weight:600}',
      '@media (prefers-color-scheme: dark){.dshsm-star{border-color:rgba(255,255,255,.12);background:rgba(255,196,0,.08)}.dshsm-starCta{color:#e8c15a}}',
      // 会话页 composer 里常驻的工作区 chip —— 逐项对齐官方 hero chip 的计算样式
      '.dshsm-dock{position:absolute;left:50%;transform:translateX(-50%);top:4px;bottom:0;display:flex;align-items:center;justify-content:flex-start;gap:8px;width:min(calc(var(--dsh-composer-card-max-width,760px) + 2 * var(--dsh-composer-side-clearance,0px)),100%);padding:0 16px 0 20px;box-sizing:border-box;pointer-events:none;z-index:1}',
      '.dshsm-dock .dshsm-chip{pointer-events:auto}',
      '.dshsm-chip{border-radius:var(--dsw-radius-sm,8px);max-width:min(100%,360px);min-height:28px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;min-width:0}',
      '.dshsm-chip:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dshsm-chip-icon{color:var(--dsw-alias-label-primary,inherit);flex:none;display:inline-flex}',
      '.dshsm-chip-icon svg{display:block}',
      '.dshsm-chip-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.dshsm-chip-chevron{color:var(--dsw-alias-label-caption,#a7b0bf);flex:none;display:inline-flex}',
      '.dshsm-chip-chevron svg{display:block}',
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
      attached: '已补上「{ws}」的工作区归属',
      cannot: '这个对话无法移动',
      failed: '移动失败',
      needsReload: '（刷新页面后生效）',
      dragMoved: '已移动到「{ws}」',
      dragFailed: '移动失败：',
      bulk: '多选',
      bulkMove: '移动',
      bulkCancel: '取消',
      bulkSelected: '已选 {n} 个',
      bulkPicking: '移动 {n} 个对话到：',
      bulkProgress: '正在移动 {d}/{t}…',
      bulkDone: '已移动 {ok} 个',
      bulkPartial: '已移动 {ok} 个，{fail} 个失败',
      bulkSkipped: '（{n} 个本来就在目标工作区）',
      bulkPlanMove: '将移动 {m} 个',
      bulkPlanSkip: ' · 跳过 {s} 个',
      bulkPlanAllHere: '全部已在这里',
      bulkFailed: '批量移动失败：',
      noteReleaseRetries: '（释放重试 {n} 次）',
      noteSampled: '（大会话：抽样校验）',
      childrenSettingTitle: '连同子对话一起移动',
      childrenSettingDesc: '默认开。移动父对话时，它的子智能体会话（侧边栏里隐藏的 subagent 会话）一起搬到目标工作区；关掉后只搬父对话。',
      starPrompt: '顺手留颗 Star，作者能高兴一整天',
      starCta: '行，给你一颗 Star',
      chipPick: '移动这个对话到：',
      chipMoved: '已移动到「{ws}」',
      chipAria: '当前工作区「{ws}」，点击移动',
      chipUnknown: '未分组',
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
      attached: 'Workspace membership restored for “{ws}”',
      cannot: 'This conversation cannot be moved',
      failed: 'Move failed',
      needsReload: ' (reload the page to apply)',
      dragMoved: 'Moved to “{ws}”',
      dragFailed: 'Move failed: ',
      bulk: 'Select multiple',
      bulkMove: 'Move',
      bulkCancel: 'Cancel',
      bulkSelected: '{n} selected',
      bulkPicking: 'Move {n} conversations to:',
      bulkProgress: 'Moving {d}/{t}…',
      bulkDone: 'Moved {ok}',
      bulkPartial: 'Moved {ok}, {fail} failed',
      bulkSkipped: ' ({n} already there)',
      bulkPlanMove: 'Move {m}',
      bulkPlanSkip: ' · skip {s}',
      bulkPlanAllHere: 'All already here',
      bulkFailed: 'Bulk move failed: ',
      noteReleaseRetries: ' (release retried {n}×)',
      noteSampled: ' (large session: sampled verify)',
      childrenSettingTitle: 'Move child conversations too',
      childrenSettingDesc: 'On by default. Moving a conversation also moves its hidden subagent sessions to the target workspace; turn it off to move only the parent conversation.',
      starPrompt: 'Leave a star — it makes the author’s day',
      starCta: 'Give a star',
      chipPick: 'Move this conversation to:',
      chipMoved: 'Moved to “{ws}”',
      chipAria: 'Workspace “{ws}” — click to move',
      chipUnknown: 'Ungrouped',
    };

    function text() {
      return isChinese() ? ZH : EN;
    }

    /** 「连同子对话」开关：插件设置页里改，存 localStorage，默认开。 */
    function wantChildren() {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          return localStorage.getItem('dsh-session-relocate.includeChildren') !== 'false';
        }
      } catch (error) { /* 隐私模式读不了就按默认 */ }
      return true;
    }

    function setWantChildren(value) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          localStorage.setItem('dsh-session-relocate.includeChildren', value ? 'true' : 'false');
        }
      } catch (error) { /* 写不进去就算了，下次还是默认开 */ }
    }

    /** 插件设置页里的「连同子对话」开关（行配置页与包配置页共用）。 */
    function ChildrenSetting() {
      var strings = text();
      var state = react.useState(wantChildren() ? 'on' : 'off');
      var on = state[0] === 'on';
      function toggle() {
        var next = on !== true;
        state[1](next ? 'on' : 'off');
        setWantChildren(next);
      }
      return react.createElement('div', { className: 'dshsm-card' }, [
        react.createElement('div', { className: 'dshsm-setting', key: 'setting' }, [
          react.createElement('div', { className: 'dshsm-setting-text', key: 'text' }, [
            react.createElement('div', { className: 'dshsm-setting-title', key: 'title' }, strings.childrenSettingTitle),
            react.createElement('div', { className: 'dshsm-setting-desc', key: 'desc' }, strings.childrenSettingDesc),
          ]),
          react.createElement('button', {
            key: 'switch',
            type: 'button',
            role: 'switch',
            'aria-checked': on === true ? 'true' : 'false',
            className: 'dshsm-switch',
            onClick: toggle,
          }),
        ]),
        react.createElement('a', {
          key: 'star',
          className: 'dshsm-star',
          href: 'https://github.com/DDDMUC/dsh-session-relocate',
          target: '_blank',
          rel: 'noopener noreferrer',
        }, [
          react.createElement('span', { className: 'dshsm-starIcon', key: 'icon' }, '⭐'),
          react.createElement('span', { key: 'prompt' }, strings.starPrompt),
          react.createElement('span', { className: 'dshsm-starCta', key: 'cta' }, strings.starCta),
        ]),
      ]);
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

    /**
     * 把回执里值得说一句的信息拼成后缀：释放重试了几次、大会话是不是只做了抽样校验。
     * 没有要说的就返回空串。
     */
    function receiptNotes(result) {
      if (result === null || typeof result !== 'object') return '';
      var strings = text();
      var notes = [];
      if (Number.isSafeInteger(result.releaseAttempts) && result.releaseAttempts > 1) {
        notes.push(strings.noteReleaseRetries.replace('{n}', String(result.releaseAttempts)));
      }
      if (result.verification === 'sampled') notes.push(strings.noteSampled);
      return notes.length === 0 ? '' : notes.join('');
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
          setState({
            phase: 'done',
            title: result.targetTitle !== undefined ? result.targetTitle : result.to,
            applied: result.applied,
            note: receiptNotes(result),
          });
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
        var doneText = state.applied === 'attached'
          ? strings.attached.replace('{ws}', String(state.title))
          : strings.done + ' ' + String(state.title);
        var suffix = state.applied === 'pending'
          ? strings.pending
          : (state.applied === 'live' || state.applied === 'attached' ? '' : strings.needsReload);
        var note = typeof state.note === 'string' ? state.note : '';
        return button('done', doneText + note + (suffix.length > 0 ? '；' + suffix : ''), { disabled: true });
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
      sessionIds: null,
      sourceWorkspaceId: null,
      targetSection: null,
      hostSelected: false,
    };
    var dragInstallRefs = 0;
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
      dragState.sessionIds = null;
      dragState.sourceWorkspaceId = null;
      dragState.hostSelected = false;
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

    /**
     * 当前多选中的会话 id。两个来源：
     *   - 我们自己的多选模式（bulkState）；
     *   - dsh-delete-session 的多选底栏：它给选中行的复选框挂 `.dsdel-check-on`
     *     （那是它的 DOM 契约，我们只读、不改）。
     * 没有多选时返回空数组。
     */
    function selectedIdsForDrag() {
      if (bulkState.selecting === true) return bulkSelectedIds();
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
      var marks = document.querySelectorAll('.dsdel-check-on');
      var ids = [];
      for (var i = 0; marks !== null && marks !== undefined && i < marks.length; i += 1) {
        var row = nearestRow(marks[i]);
        var id = row === null ? null : sessionIdFromRow(row);
        if (id !== null && ids.indexOf(id) < 0) ids.push(id);
      }
      return ids;
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
      // 多选拖动：宿主底栏（或我们自己的多选）里选中的整批一起搬。
      var selectedIds = selectedIdsForDrag();
      var multi = selectedIds.length > 1 && selectedIds.indexOf(sessionId) >= 0;
      dragState.sessionIds = multi ? selectedIds : [sessionId];
      dragState.hostSelected = bulkState.selecting !== true && selectedIds.indexOf(sessionId) >= 0;
      // 源工作区**每次**从 DOM 现读（同步、稳）：拖起来的那一行就在它自己的分组里。
      // 不能跨拖动缓存 —— 会话可能刚被搬走，旧分组已经不是它的家了。
      // 读不到再问主机；还是拿不到也无所谓 —— 服务端会用 already-there 兜住。
      var own = workspaceGroupOf(row);
      if (own !== null) {
        dragState.sourceWorkspaceId = own.workspaceId;
        return;
      }
      post('/describe', { sessionId: sessionId }).then(function (result) {
        var session = result !== null && result !== undefined ? result.session : null;
        if (session === null || session === undefined) return;
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
      var ids = dragState.sessionIds !== null && dragState.sessionIds.length > 1 ? dragState.sessionIds : [sessionId];
      var hostSelected = dragState.hostSelected === true;
      resetDrag();
      if (ids.length > 1) moveManyByDrag(ids, targetWorkspaceId, hostSelected);
      else moveByDrag(sessionId, targetWorkspaceId, hostSelected);
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
    function moveByDrag(sessionId, targetWorkspaceId, hostSelected) {
      var strings = text();
      toast(strings.moving);
      var payload = { sessionId: sessionId, targetWorkspaceId: targetWorkspaceId };
      if (wantChildren() === false) payload.includeChildren = false;
      post('/move', payload).then(function (result) {
        if (result !== null && result !== undefined && result.ok === true) {
          var title = result.targetTitle;
          var label = typeof title === 'string' && title.length > 0 ? title : targetWorkspaceId;
          var summary = result.applied === 'attached'
            ? strings.attached.replace('{ws}', label)
            : strings.dragMoved.replace('{ws}', label);
          toast(summary + receiptNotes(result));
          if (bulkState.selecting === true) exitBulk();
          else if (hostSelected === true) dismissHostSelection();
          return;
        }
        var message = result !== null && result !== undefined && typeof result.message === 'string' ? result.message : '';
        toast(strings.dragFailed + message);
      }, function (error) {
        toast(strings.dragFailed + errorText(error));
      });
    }

    /** 多选拖动：整批搬到同一个目标（目标就是松手的分组，不再弹选择面板）。 */
    function moveManyByDrag(ids, targetWorkspaceId, hostSelected) {
      var strings = text();
      toast(strings.moving);
      runBulkMove(ids, targetWorkspaceId, {
        onProgress: function (done, total) {
          toast(strings.bulkProgress.replace('{d}', String(done)).replace('{t}', String(total)));
        },
      }).then(function (result) {
        var summary = result.failed === 0
          ? strings.bulkDone.replace('{ok}', String(result.moved))
          : strings.bulkPartial.replace('{ok}', String(result.moved)).replace('{fail}', String(result.failed));
        if (result.skipped > 0) summary += strings.bulkSkipped.replace('{n}', String(result.skipped));
        summary += receiptNotes(result);
        toast(summary);
        if (bulkState.selecting === true) exitBulk();
        else if (hostSelected === true) dismissHostSelection();
        refreshSidebar();
      }, function (error) {
        toast(strings.bulkFailed + errorText(error));
      });
    }

    /**
     * 收起宿主（dsh-delete-session）的多选态：它监听 document 的 Escape（capture），
     * 我们只发一个 Escape，不碰它的内部状态。
     */
    function dismissHostSelection() {
      if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return;
      var event = typeof KeyboardEvent === 'function'
        ? new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        : { type: 'keydown', key: 'Escape', bubbles: true, stopPropagation: function () {}, preventDefault: function () {} };
      try { document.dispatchEvent(event); } catch (error) { /* ignore */ }
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

    /**
     * 挂上拖动搬移，返回卸载函数。环境没有 document 就整个不启用。
     *
     * 引用计数：客户端可能被重复 apply（热重载 / 换 fiber）。DOM 里同一个监听函数
     * 重复 add 是 no-op，但 remove 一次就真删掉了 —— 不计数的话，旧的 disposer 一跑
     * 就会把还在用的监听整套撤掉（菜单还在、拖动却全没了）。
     */
    function installDrag() {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return function () {};
      }
      var capture = true; // 捕获阶段先于官方（React）的处理
      if (dragInstallRefs === 0) {
        document.addEventListener('dragstart', onDragStart, capture);
        document.addEventListener('dragover', onDragOver, capture);
        document.addEventListener('drop', onDrop, capture);
        document.addEventListener('dragend', onDragEnd, capture);
        document.addEventListener('dragleave', onDragLeave, capture);
      }
      dragInstallRefs += 1;
      var disposed = false;
      return function () {
        if (disposed) return;
        disposed = true;
        dragInstallRefs -= 1;
        if (dragInstallRefs > 0) return;
        document.removeEventListener('dragstart', onDragStart, capture);
        document.removeEventListener('dragover', onDragOver, capture);
        document.removeEventListener('drop', onDrop, capture);
        document.removeEventListener('dragend', onDragEnd, capture);
        document.removeEventListener('dragleave', onDragLeave, capture);
        resetDrag();
      };
    }

    // ── 批量搬移（多选）───────────────────────────────────────────────────────
    //
    // 两条路，靠 dsh-delete-session 显式暴露的能力位决定走哪条：
    //   A. 它装了且支持批量动作（window.__DSH_DELETE_SESSION__.supportsBulkMove）→ 它那根
    //      底栏上出现「移动」，它调我们暴露的 window.__DSH_SESSION_RELOCATE__.moveSelection(ids, hooks)。
    //   B. 只有我们 → 菜单里多一项「多选」，自己画勾选圈 + 底栏（已选 N / 取消 / 移动）。
    // 判断只认能力位、不猜 DOM：它没给能力位就按 B 走（宁可多一个入口，也不静默丢功能）。
    var CHECK_CLASS = 'dshsm-check';
    var CHECK_ON_CLASS = 'dshsm-check-on';
    var bulkState = { selecting: false, selected: {}, bar: null, countNode: null, moveNode: null, raf: null, moveSelectionFn: null };

    /** 宿主（dsh-delete-session）是否支持把「移动」放进它那根底栏。 */
    function hostSupportsBulkMove() {
      var host = globalThis.__DSH_DELETE_SESSION__;
      return host !== null && typeof host === 'object' && host.supportsBulkMove === true;
    }

    /** 搬完让侧边栏重新取一次（官方一般会因会话事件自己刷新，这里补一次兜底）。 */
    function refreshSidebar() {
      try { globalThis.dispatchEvent(new Event('resize')); } catch (error) { /* 没有 Event 的环境就算了 */ }
    }

    // ── composer 里常驻的工作区 chip ───────────────────────────────────────────
    //
    // 用官方槽 `conversation.input.dock` —— 和 dsh-preset-workbench 的预设胶囊**同一个槽**。
    // 宿主里只有这个槽在「空白会话 / 已开聊会话」都渲染（composer 的 zone !== undefined），
    // 而且节点由 React 自己维护：不会像 DOM 注入那样被重渲染顶掉、来回跳。
    // 位置：dock 是 justify-content:center 的一行（预设胶囊靠右）；我们把自己绝对定位到
    // dock 的左边（padding-left:16px，和 pwtDock 一致），同一行、左工作区右预设。

    /** 从 /describe 结果里挑出这条会话该显示的工作区名（注册表优先，其次 cwd 命中）。 */
    function titleFromDescribe(result) {
      if (result === null || typeof result !== 'object') return null;
      var session = result.session;
      var workspaceId = session !== null && session !== undefined && typeof session === 'object'
        ? (session.currentWorkspaceId !== undefined && session.currentWorkspaceId !== null
          ? session.currentWorkspaceId
          : session.cwdMatchesWorkspaceId)
        : null;
      var spaces = Array.isArray(result.workspaces) ? result.workspaces : [];
      for (var i = 0; i < spaces.length; i += 1) {
        if (spaces[i] !== null && spaces[i] !== undefined && spaces[i].id === workspaceId) return spaces[i].title;
      }
      return workspaceId === null || workspaceId === undefined ? text().chipUnknown : null;
    }

    /** 从 composer chip 弹目标面板；取消返回 null。 */
    function pickMoveTarget(sessionId) {
      return new Promise(function (resolve) {
        var strings = text();
        var backdrop = document.createElement('div');
        backdrop.className = 'dshsm-picker-backdrop';
        var panel = document.createElement('div');
        panel.className = 'dshsm-picker ' + themeClass();
        panel.setAttribute('role', 'dialog');
        var title = document.createElement('div');
        title.className = 'dshsm-picker-title';
        title.textContent = strings.chipPick;
        panel.appendChild(title);
        var list = document.createElement('div');
        list.className = 'dshsm-picker-list';
        panel.appendChild(list);
        var actions = document.createElement('div');
        actions.className = 'dshsm-picker-actions';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dshsm-picker-btn';
        cancel.textContent = strings.bulkCancel;
        actions.appendChild(cancel);
        panel.appendChild(actions);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);

        var settled = false;
        function done(value) {
          if (settled) return;
          settled = true;
          if (typeof backdrop.remove === 'function') backdrop.remove();
          document.removeEventListener('keydown', onKey, true);
          resolve(value);
        }
        function onKey(event) {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          done(null);
        }
        cancel.addEventListener('click', function () { done(null); });
        backdrop.addEventListener('mousedown', function (event) { if (event.target === backdrop) done(null); });
        document.addEventListener('keydown', onKey, true);

        var loading = document.createElement('div');
        loading.className = 'dshsm-picker-empty';
        loading.textContent = strings.loading;
        list.appendChild(loading);

        post('/describe', { sessionId: sessionId }).then(function (result) {
          if (settled) return;
          if (typeof list.removeChild === 'function') list.removeChild(loading);
          var spaces = result !== null && typeof result === 'object' && Array.isArray(result.workspaces) ? result.workspaces : [];
          var targets = [];
          for (var i = 0; i < spaces.length; i += 1) {
            if (spaces[i] !== null && spaces[i] !== undefined && spaces[i].current !== true) targets.push(spaces[i]);
          }
          if (targets.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'dshsm-picker-empty';
            empty.textContent = strings.noTargets;
            list.appendChild(empty);
            return;
          }
          for (var j = 0; j < targets.length; j += 1) {
            (function (workspace) {
              var item = document.createElement('button');
              item.type = 'button';
              item.className = 'dshsm-picker-item';
              var name = document.createElement('span');
              name.className = 'dshsm-picker-name';
              name.textContent = workspace.title;
              item.appendChild(name);
              if (typeof workspace.path === 'string' && workspace.path.length > 0) {
                var path = document.createElement('span');
                path.className = 'dshsm-picker-path';
                path.textContent = workspace.path;
                item.appendChild(path);
              }
              item.addEventListener('click', function () { done(workspace); });
              list.appendChild(item);
            })(targets[j]);
          }
        }, function (error) {
          if (settled) return;
          if (typeof list.removeChild === 'function') list.removeChild(loading);
          var failed = document.createElement('div');
          failed.className = 'dshsm-picker-empty';
          failed.textContent = strings.dragFailed + errorText(error);
          list.appendChild(failed);
        });
      });
    }

    /** 搬完通知 chip 换名字（回执里就有新工作区名）。 */
    function moveFromChip(sessionId, workspace, onMoved) {
      var strings = text();
      toast(strings.moving);
      var payload = { sessionId: sessionId, targetWorkspaceId: workspace.id };
      if (wantChildren() === false) payload.includeChildren = false;
      post('/move', payload).then(function (result) {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          var title = typeof result.targetTitle === 'string' && result.targetTitle.length > 0 ? result.targetTitle : workspace.title;
          toast(result.applied === 'attached'
            ? strings.attached.replace('{ws}', title)
            : strings.chipMoved.replace('{ws}', title));
          if (typeof onMoved === 'function') onMoved(title);
          refreshSidebar();
          return;
        }
        var message = result !== null && typeof result === 'object' && typeof result.message === 'string' ? result.message : '';
        toast(strings.dragFailed + message);
      }, function (error) {
        toast(strings.dragFailed + errorText(error));
      });
    }

    /**
     * composer 里常驻的工作区 chip（注册进 conversation.input.dock）。
     * 外观逐项对齐官方 hero 那条：同一个文件夹图标 / 箭头 / 圆角 / 高度 / 字号 / hover。
     */
    function WorkspaceDockChip(props) {
      var strings = text();
      var sessionId = props !== null && props !== undefined
        ? (typeof props.sessionId === 'string'
          ? props.sessionId
          : (props.session !== undefined && props.session !== null && typeof props.session.id === 'string' ? props.session.id : undefined))
        : undefined;
      var useState = typeof react.useState === 'function' ? react.useState : function (initial) { return [initial, function () {}]; };
      var useRef = typeof react.useRef === 'function' ? react.useRef : function () { return { current: null }; };
      var useEffect = typeof react.useEffect === 'function' ? react.useEffect : function () {};
      var state = useState(strings.chipUnknown);
      var title = state[0];
      var setTitle = state[1];
      var wrapRef = useRef(null);

      useEffect(function () {
        var node = wrapRef.current;
        var parent = node !== null && node !== undefined ? node.parentElement : null;
        if (parent !== null && parent !== undefined && parent.style !== undefined) {
          // dock 容器默认 static；设成 relative 才能把自己绝对定位到它左边，且不动预设胶囊的排版。
          parent.style.position = 'relative';
        }
        return function () {};
      }, []);

      useEffect(function () {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return function () {};
        var alive = true;
        post('/describe', { sessionId: sessionId }).then(function (result) {
          if (!alive) return;
          var next = titleFromDescribe(result);
          if (next !== null && next !== undefined) setTitle(next);
        }, function () { /* 读不到就保持上一次的显示 */ });
        return function () { alive = false; };
      }, [sessionId]);

      function onOpen() {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        pickMoveTarget(sessionId).then(function (workspace) {
          if (workspace === null) return;
          moveFromChip(sessionId, workspace, function (next) { setTitle(next); });
        }, function () { /* 面板自己会报错 */ });
      }

      var label = typeof title === 'string' && title.length > 0 ? title : strings.chipUnknown;
      var folderPath = 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z';
      return react.createElement('div', { className: 'dshsm-dock', ref: wrapRef }, [
        react.createElement('button', {
          key: 'chip',
          type: 'button',
          className: 'dshsm-chip',
          'aria-label': strings.chipAria.replace('{ws}', label),
          title: strings.chipAria.replace('{ws}', label),
          onClick: onOpen,
        }, [
          react.createElement('span', { className: 'dshsm-chip-icon', key: 'icon' }, react.createElement('svg', {
            key: 'folder', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
          }, [
            react.createElement('path', { key: 'a', d: folderPath, stroke: 'currentColor' }),
            react.createElement('path', { key: 'b', d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
          ])),
          react.createElement('span', { className: 'dshsm-chip-label', key: 'label' }, label),
          react.createElement('span', { className: 'dshsm-chip-chevron', key: 'chevron' }, react.createElement('svg', {
            key: 'chevron', width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none',
            xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', strokeWidth: 1,
          }, react.createElement('path', { key: 'a', d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6', stroke: 'currentColor' }))),
        ]),
      ]);
    }


    /**
     * 纯逻辑：串行把一批会话搬到同一个目标工作区。不碰 DOM，方便单测。
     *
     * 两段式：先逐条 `/move` + `deferRegistry`（每条只做文件事务，进度能实时显示），
     * 最后一次性 `/move-commit` 把整批归属写进注册表 —— N 条会话只付 2 次注册表写，
     * 而不是 2N 次（实测这是单条搬移里最贵的部分）。
     */
    function runBulkMove(sessionIds, targetWorkspaceId, hooks) {
      var ids = Array.isArray(sessionIds) ? sessionIds.filter(function (id) { return typeof id === 'string' && id.length > 0; }) : [];
      if (ids.length === 0) return Promise.resolve({ canceled: false, moved: 0, failed: 0, skipped: 0, total: 0, results: [] });
      // 主机支不支持两段式，问一次 /status 并缓存：不支持就退回逐条单发（老主机照常能用）。
      return hostSupportsDefer().then(function (twoPhase) {
        return runBulkMoveInner(ids, targetWorkspaceId, hooks, twoPhase);
      });
    }

    var bulkCapability = null;
    function hostSupportsDefer() {
      if (bulkCapability !== null) return Promise.resolve(bulkCapability);
      return post('/status').then(function (result) {
        bulkCapability = result !== null && typeof result === 'object' && result.bulkDefer === true;
        return bulkCapability;
      }, function () {
        bulkCapability = false;
        return false;
      });
    }

    function runBulkMoveInner(ids, targetWorkspaceId, hooks, twoPhase) {
      var byId = {};
      var deferred = [];
      var moved = 0;
      var failed = 0;
      var skipped = 0;
      var sampled = false;
      var releaseRetries = 0;
      function record(entry) {
        byId[entry.sessionId] = entry;
      }
      function finish() {
        // results 按传入顺序输出（commit 会把成功项推到后面，这里统一回填）。
        var ordered = [];
        for (var i = 0; i < ids.length; i += 1) if (byId[ids[i]] !== undefined) ordered.push(byId[ids[i]]);
        return {
          canceled: false,
          moved: moved,
          failed: failed,
          skipped: skipped,
          total: ids.length,
          results: ordered,
          verification: sampled ? 'sampled' : 'full',
          releaseAttempts: releaseRetries,
        };
      }
      /** 第二段：一次提交，把 defer 过的归属一次性写进注册表。 */
      function commit(pending) {
        return post('/move-commit', { sessionIds: pending }).then(function (result) {
          var okCommit = result !== null && typeof result === 'object' && result.ok === true;
          var committed = result !== null && typeof result === 'object' && Array.isArray(result.results) ? result.results : [];
          var byId = {};
          for (var i = 0; i < committed.length; i += 1) {
            var entry = committed[i];
            if (entry !== null && typeof entry === 'object' && typeof entry.sessionId === 'string') byId[entry.sessionId] = entry;
          }
          for (var j = 0; j < pending.length; j += 1) {
            var id = pending[j];
            var one = byId[id];
            if (okCommit && one !== undefined && one.status === 'moved') {
              moved += 1;
              record({ sessionId: id, status: 'moved', targetWorkspaceId: targetWorkspaceId });
            } else {
              failed += 1;
              record({
                sessionId: id,
                status: 'failed',
                code: one !== undefined && typeof one.status === 'string' ? one.status : 'commit-failed',
                message: one !== undefined && typeof one.message === 'string'
                  ? one.message
                  : (result !== null && typeof result === 'object' && typeof result.message === 'string' ? result.message : ''),
              });
            }
          }
          return finish();
        }, function (error) {
          for (var k = 0; k < pending.length; k += 1) {
            failed += 1;
            record({ sessionId: pending[k], status: 'failed', code: 'commit-failed', message: errorText(error) });
          }
          return finish();
        });
      }
      function step(index) {
        if (index >= ids.length) return twoPhase && deferred.length > 0 ? commit(deferred) : Promise.resolve(finish());
        var sessionId = ids[index];
        var payload = { sessionId: sessionId, targetWorkspaceId: targetWorkspaceId, deferRegistry: twoPhase };
        if (wantChildren() === false) payload.includeChildren = false;
        var done = post('/move', payload).then(function (result) {
          if (result !== null && typeof result === 'object' && result.ok === true) {
            if (result.verification === 'sampled') sampled = true;
            if (Number.isSafeInteger(result.releaseAttempts) && result.releaseAttempts > releaseRetries) releaseRetries = result.releaseAttempts;
            if (result.applied === 'attached') {
              // 目录本来就在目标、只补了归属：没有可提交的文件事务，直接算已搬。
              moved += 1;
              record({ sessionId: sessionId, status: 'moved', targetWorkspaceId: targetWorkspaceId, applied: 'attached' });
            } else if (twoPhase) {
              deferred.push(sessionId);
            } else {
              moved += 1;
              record({ sessionId: sessionId, status: 'moved', targetWorkspaceId: targetWorkspaceId });
            }
          } else if (result !== null && typeof result === 'object' && result.code === 'already-there') {
            skipped += 1;
            record({ sessionId: sessionId, status: 'skipped', code: 'already-there', message: typeof result.message === 'string' ? result.message : '' });
          } else {
            failed += 1;
            record({
              sessionId: sessionId,
              status: 'failed',
              code: result !== null && typeof result === 'object' && typeof result.code === 'string' ? result.code : 'failed',
              message: result !== null && typeof result === 'object' && typeof result.message === 'string' ? result.message : '',
            });
          }
        }, function (error) {
          failed += 1;
          record({ sessionId: sessionId, status: 'failed', code: 'network', message: errorText(error) });
        });
        return done.then(function () {
          if (hooks !== null && hooks !== undefined && typeof hooks.onProgress === 'function') {
            try { hooks.onProgress(index + 1, ids.length); } catch (error) { /* 回调抛错不能打断批量 */ }
          }
          return step(index + 1);
        });
      }
      return step(0);
    }

    /** 把一个 CSS 颜色转成 0..1 的相对亮度；透明 / 解析不了返回 null。 */
    function colorLuminance(value) {
      var match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(String(value));
      if (match === null) return null;
      if (match[4] !== undefined && Number(match[4]) === 0) return null;
      return (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
    }

    /**
     * 页面是深色还是浅色 —— 先看 body 的**背景亮度**，背景拿不到再看**文字亮度**。
     * 不读 `--dsw-*` token：实测某些主题/皮肤下 token 缺失或与背景不配对，选择面板会变成
     * 「深底 + 深字」。拿不到任何样式时退回深色（深底浅字在任何主题下都能看清）。
     */
    function pageIsDark() {
      try {
        if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return true;
        var style = getComputedStyle(document.body);
        var bg = colorLuminance(style.backgroundColor);
        if (bg !== null) return bg < 0.5;
        var fg = colorLuminance(style.color);
        if (fg !== null) return fg > 0.5;
        return true;
      } catch (error) {
        return true;
      }
    }

    function themeClass() {
      return pageIsDark() ? 'dshsm-dark' : 'dshsm-light';
    }

    /** 这条会话现在挂在哪个工作区分组里（按侧边栏 DOM；行没渲染就返回 null）。 */
    function ownerWorkspaceOf(sessionId) {
      if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
      var row = null;
      try {
        row = document.querySelector('[data-row-key="session:' + sessionId + '"]');
      } catch (error) {
        row = null;
      }
      if (row === null || row === undefined) return null;
      var group = workspaceGroupOf(row);
      return group === null ? null : group.workspaceId;
    }

    /**
     * 纯逻辑：按每条会话的归属，给每个目标算出「将移动 m / 跳过 s」。
     * 归属未知（行没渲染、读不到分组）一律算「会搬」，宁可多问一次也不误导用户。
     */
    function planTargetsWith(ids, workspaces, ownerOf) {
      var owners = {};
      for (var i = 0; i < ids.length; i += 1) {
        try { owners[ids[i]] = ownerOf(ids[i]); } catch (error) { owners[ids[i]] = null; }
      }
      var plans = [];
      for (var j = 0; j < workspaces.length; j += 1) {
        var workspace = workspaces[j];
        var moved = 0;
        var skipped = 0;
        for (var k = 0; k < ids.length; k += 1) {
          var owner = owners[ids[k]];
          if (owner !== null && owner !== undefined && owner === workspace.id) skipped += 1;
          else moved += 1;
        }
        plans.push({ workspace: workspace, moved: moved, skipped: skipped, disabled: moved === 0 });
      }
      return plans;
    }

    function planTargets(ids, workspaces) {
      return planTargetsWith(ids, workspaces, ownerWorkspaceOf);
    }

    /** 弹一个居中的目标工作区面板；取消返回 { canceled: true }。 */
    function pickBulkTarget(sessionIds) {
      var ids = Array.isArray(sessionIds) ? sessionIds.filter(function (id) { return typeof id === 'string' && id.length > 0; }) : [];
      return new Promise(function (resolve) {
        var strings = text();
        var backdrop = document.createElement('div');
        backdrop.className = 'dshsm-picker-backdrop';
        var panel = document.createElement('div');
        panel.className = 'dshsm-picker ' + themeClass();
        panel.setAttribute('role', 'dialog');
        var title = document.createElement('div');
        title.className = 'dshsm-picker-title';
        title.textContent = strings.bulkPicking.replace('{n}', String(ids.length));
        panel.appendChild(title);
        var list = document.createElement('div');
        list.className = 'dshsm-picker-list';
        panel.appendChild(list);
        var actions = document.createElement('div');
        actions.className = 'dshsm-picker-actions';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dshsm-picker-btn';
        cancel.textContent = strings.bulkCancel;
        actions.appendChild(cancel);
        panel.appendChild(actions);
        backdrop.appendChild(panel);
        document.body.appendChild(backdrop);

        var settled = false;
        function done(value) {
          if (settled) return;
          settled = true;
          if (typeof backdrop.remove === 'function') backdrop.remove();
          document.removeEventListener('keydown', onKey, true);
          resolve(value);
        }
        function onKey(event) {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          done({ canceled: true });
        }
        cancel.addEventListener('click', function () { done({ canceled: true }); });
        backdrop.addEventListener('mousedown', function (event) { if (event.target === backdrop) done({ canceled: true }); });
        document.addEventListener('keydown', onKey, true);

        var loading = document.createElement('div');
        loading.className = 'dshsm-picker-empty';
        loading.textContent = strings.loading;
        list.appendChild(loading);

        post('/describe', {}).then(function (result) {
          if (settled) return;
          if (typeof list.removeChild === 'function') list.removeChild(loading);
          var spaces = result !== null && typeof result === 'object' && Array.isArray(result.workspaces) ? result.workspaces : [];
          if (spaces.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'dshsm-picker-empty';
            empty.textContent = strings.noTargets;
            list.appendChild(empty);
            return;
          }
          var plans = planTargets(ids, spaces);
          for (var i = 0; i < plans.length; i += 1) {
            (function (plan) {
              var workspace = plan.workspace;
              var item = document.createElement('button');
              item.type = 'button';
              item.className = 'dshsm-picker-item';
              var name = document.createElement('span');
              name.className = 'dshsm-picker-name';
              name.textContent = workspace.title;
              item.appendChild(name);
              if (typeof workspace.path === 'string' && workspace.path.length > 0) {
                var path = document.createElement('span');
                path.className = 'dshsm-picker-path';
                path.textContent = workspace.path;
                item.appendChild(path);
              }
              var countLine = document.createElement('span');
              countLine.className = 'dshsm-picker-count';
              countLine.textContent = plan.disabled === true
                ? strings.bulkPlanAllHere
                : strings.bulkPlanMove.replace('{m}', String(plan.moved))
                  + (plan.skipped > 0 ? strings.bulkPlanSkip.replace('{s}', String(plan.skipped)) : '');
              item.appendChild(countLine);
              if (plan.disabled === true) {
                item.disabled = true;
              } else {
                item.addEventListener('click', function () { done({ workspace: workspace }); });
              }
              list.appendChild(item);
            })(plans[i]);
          }
        }, function (error) {
          if (settled) return;
          if (typeof list.removeChild === 'function') list.removeChild(loading);
          var failedNode = document.createElement('div');
          failedNode.className = 'dshsm-picker-empty dshsm-bad';
          failedNode.textContent = strings.failed + '：' + errorText(error);
          list.appendChild(failedNode);
        });
      });
    }

    /**
     * 对外契约（dsh-delete-session 会用）：选目标 → 串行搬 → 汇总。
     * 返回 { canceled?, moved, failed, skipped, total, results[] }；
     * hooks.onProgress(done, total) 的 done = 已处理条数（成功 + 失败 + 跳过）。
     */
    function moveSelection(sessionIds, hooks) {
      var ids = Array.isArray(sessionIds) ? sessionIds.filter(function (id) { return typeof id === 'string' && id.length > 0; }) : [];
      if (ids.length === 0) {
        return Promise.resolve({ canceled: false, moved: 0, failed: 0, skipped: 0, total: 0, results: [] });
      }
      return pickBulkTarget(ids).then(function (picked) {
        if (picked === null || picked === undefined || picked.workspace === undefined) {
          return { canceled: true, moved: 0, failed: 0, skipped: 0, total: ids.length, results: [] };
        }
        return runBulkMove(ids, picked.workspace.id, hooks);
      });
    }

    /** 行 → 会话 id（只认会话行；工作区行不是会话）。 */
    function sessionIdFromRow(row) {
      var node = row;
      for (var depth = 0; depth < ROW_WALK_LIMIT && node !== null && node !== undefined; depth += 1) {
        if (typeof node.getAttribute === 'function') {
          var key = node.getAttribute(ROW_KEY_ATTR);
          if (typeof key === 'string' && key.indexOf(SESSION_PREFIX) === 0 && key.length > SESSION_PREFIX.length) {
            return key.slice(SESSION_PREFIX.length);
          }
        }
        node = node.parentElement;
      }
      return null;
    }

    function bulkDecorate() {
      bulkState.raf = null;
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      var rows = Array.prototype.slice.call(document.querySelectorAll('[role="treeitem"]'));
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var id = sessionIdFromRow(row);
        if (id === null) continue;
        var check = typeof row.querySelector === 'function' ? row.querySelector(':scope > .' + CHECK_CLASS) : null;
        if (bulkState.selecting !== true) {
          if (check !== null && typeof check.remove === 'function') check.remove();
          continue;
        }
        if (check === null) {
          check = document.createElement('span');
          check.className = CHECK_CLASS;
          check.setAttribute('aria-hidden', 'true');
          row.insertBefore(check, row.firstChild);
        }
        if (bulkState.selected[id] === true) check.classList.add(CHECK_ON_CLASS);
        else check.classList.remove(CHECK_ON_CLASS);
      }
    }

    function scheduleBulkDecorate() {
      if (bulkState.raf !== null) return;
      bulkState.raf = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(bulkDecorate)
        : setTimeout(bulkDecorate, 16);
    }

    function bulkSelectedIds() {
      var ids = [];
      for (var key in bulkState.selected) if (bulkState.selected[key] === true) ids.push(key);
      return ids;
    }

    function bulkUpdateBar() {
      var count = bulkSelectedIds().length;
      if (bulkState.countNode !== null) bulkState.countNode.textContent = text().bulkSelected.replace('{n}', String(count));
      if (bulkState.moveNode !== null) bulkState.moveNode.disabled = count === 0;
      return count;
    }

    function buildBulkBar() {
      var strings = text();
      var bar = document.createElement('div');
      bar.className = 'dshsm-bar ' + themeClass();
      bar.setAttribute('role', 'toolbar');
      var count = document.createElement('span');
      count.className = 'dshsm-bar-count';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'dshsm-bar-btn';
      cancel.textContent = strings.bulkCancel;
      cancel.addEventListener('click', function (event) { if (event) event.stopPropagation(); exitBulk(); });
      var move = document.createElement('button');
      move.type = 'button';
      move.className = 'dshsm-bar-btn dshsm-bar-primary';
      move.textContent = strings.bulkMove;
      move.disabled = true;
      move.addEventListener('click', function (event) {
        if (event) event.stopPropagation();
        bulkMoveSelected();
      });
      bar.appendChild(count);
      bar.appendChild(cancel);
      bar.appendChild(move);
      document.body.appendChild(bar);
      bulkState.bar = bar;
      bulkState.countNode = count;
      bulkState.moveNode = move;
      bulkUpdateBar();
    }

    function bulkMoveSelected() {
      var strings = text();
      var ids = bulkSelectedIds();
      if (ids.length === 0) return;
      if (bulkState.moveNode !== null) bulkState.moveNode.disabled = true;
      var run = typeof bulkState.moveSelectionFn === 'function' ? bulkState.moveSelectionFn : moveSelection;
      run(ids, {
        onProgress: function (done, total) {
          if (bulkState.countNode !== null) {
            bulkState.countNode.textContent = strings.bulkProgress.replace('{d}', String(done)).replace('{t}', String(total));
          }
        },
      }).then(function (result) {
        if (result.canceled === true) { bulkUpdateBar(); return; }
        var summary = result.failed === 0
          ? strings.bulkDone.replace('{ok}', String(result.moved))
          : strings.bulkPartial.replace('{ok}', String(result.moved)).replace('{fail}', String(result.failed));
        if (result.skipped > 0) summary += strings.bulkSkipped.replace('{n}', String(result.skipped));
        summary += receiptNotes(result);
        toast(summary);
        exitBulk();
        refreshSidebar();
      }, function (error) {
        toast(strings.bulkFailed + errorText(error));
        bulkUpdateBar();
      });
    }

    function onBulkRowClick(event) {
      if (bulkState.selecting !== true) return;
      var target = event !== null && event !== undefined ? event.target : null;
      var row = target !== null && target !== undefined && typeof target.closest === 'function' ? target.closest('[role="treeitem"]') : null;
      if (row === null || row === undefined) return;
      var id = sessionIdFromRow(row);
      if (id === null) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      if (bulkState.selected[id] === true) delete bulkState.selected[id];
      else bulkState.selected[id] = true;
      scheduleBulkDecorate();
      bulkUpdateBar();
    }

    function onBulkKeydown(event) {
      if (bulkState.selecting !== true) return;
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      exitBulk();
    }

    function enterBulk() {
      if (typeof document === 'undefined' || document.body === undefined || document.body === null) return;
      if (bulkState.selecting === true) return;
      bulkState.selecting = true;
      bulkState.selected = {};
      buildBulkBar();
      document.addEventListener('click', onBulkRowClick, true);
      document.addEventListener('keydown', onBulkKeydown, true);
      scheduleBulkDecorate();
      // 关掉菜单（和官方一样：在别处点一下）
      try { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (error) { /* ignore */ }
      try { document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch (error) { /* ignore */ }
    }

    function exitBulk() {
      if (bulkState.selecting !== true) return;
      bulkState.selecting = false;
      bulkState.selected = {};
      if (bulkState.raf !== null) {
        try {
          if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(bulkState.raf);
          else clearTimeout(bulkState.raf);
        } catch (error) { /* ignore */ }
        bulkState.raf = null;
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('click', onBulkRowClick, true);
        document.removeEventListener('keydown', onBulkKeydown, true);
      }
      if (bulkState.bar !== null) {
        if (typeof bulkState.bar.remove === 'function') bulkState.bar.remove();
        bulkState.bar = null;
        bulkState.countNode = null;
        bulkState.moveNode = null;
      }
      bulkDecorate();
    }

    /** 菜单里的「多选」入口：宿主支持批量动作时让位给它那根底栏。 */
    function BulkEntry(props) {
      var useMenuOpenState = props !== null && props !== undefined ? props.useMenuOpenState : null;
      var menuState = null;
      if (typeof useMenuOpenState === 'function') {
        try { menuState = useMenuOpenState(); } catch (error) { menuState = null; }
      }
      if (hostSupportsBulkMove()) return null;
      return button('bulk', text().bulk, {
        onClick: function () {
          if (menuState !== null && Array.isArray(menuState) && typeof menuState[1] === 'function') {
            try { menuState[1](false); } catch (error) { /* ignore */ }
          }
          enterBulk();
        },
      });
    }

    /** 需要 slots 服务。 */
    var inject = ['slots'];

    function apply(ctx) {
      ensureStyles();
      // 对外契约：dsh-delete-session 会检测这个全局，把「移动」放进它那根底栏。
      var boot = bootGlobal();
      var version = boot !== null && typeof boot === 'object' && typeof boot.version === 'string' ? boot.version : '0.0.0';
      // 注意：这个全局**同时**是主机注入的引导信息（prefix / version / drag）和客户端对外契约，
      // 所以只能合并、不能整个覆盖 —— 覆盖掉 prefix 会让桥接请求打到一个不存在的地址。
      var contract = globalThis.__DSH_SESSION_RELOCATE__;
      if (contract === null || typeof contract !== 'object') contract = {};
      contract.version = version;
      contract.supportsBulkMove = true;
      contract.moveSelection = moveSelection;
      globalThis.__DSH_SESSION_RELOCATE__ = contract;
      try {
        document.dispatchEvent(new CustomEvent('dsh-session-relocate:ready', { detail: { version: version } }));
      } catch (error) { /* 没有 CustomEvent 的环境就算了 */ }
      // 拖动搬移：与菜单那条路并存（拖不动就点菜单）。
      if (!dragEnabled()) {
        // 主机侧关掉了：什么都不挂。
      } else if (typeof ctx.effect === 'function') {
        ctx.effect(installDrag, 'dsh-session-relocate:drag');
      } else {
        installDrag();
      }
      var disposers = [];
      // 会话页 composer 里的常驻工作区 chip：注册进官方槽 conversation.input.dock
      // （和 dsh-preset-workbench 的预设胶囊同一个槽），React 维护节点，不会来回跳。
      if (typeof ctx.slots.inject === 'function') {
        disposers.push(ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register({
            name: 'conversation.input.dock',
            id: 'session-relocate-workspace',
            order: 10,
            inject: function (sessionId) { return { sessionId: sessionId }; },
          }, WorkspaceDockChip);
        }));
      }
      // 插件设置页（Plugins → 本插件）：把「连同子对话」开关挂到这一行的配置页。
      // 槽的 renderSlot 用 options.key 过滤，所以这里把「行 id 的两种可能写法」都登记上，
      // 行页和包页各一条，匹配不上的那条不会渲染。
      if (typeof ctx.slots.inject === 'function') {
        disposers.push(ctx.slots.inject('plugins.row.config', function () {
          var keys = ['dsh-session-relocate#session-relocate', 'dsh-session-relocate#dsh-session-relocate'];
          var entries = [];
          for (var i = 0; i < keys.length; i += 1) {
            entries.push(ctx.slots.register(
              { name: 'plugins.row.config', key: keys[i], id: 'session-relocate-children-row-' + i, order: 100 },
              ChildrenSetting,
            ));
          }
          return function () {
            for (var j = 0; j < entries.length; j += 1) {
              if (typeof entries[j] === 'function') {
                try { entries[j](); } catch (error) { /* ignore */ }
              }
            }
          };
        }));
        disposers.push(ctx.slots.inject('plugins.bundle.config', function () {
          return ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-session-relocate', id: 'session-relocate-children-bundle', order: 100 },
            ChildrenSetting,
          );
        }));
      }
      disposers.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        var items = [];
        // 「多选」入口：dsh-delete-session 支持批量动作时该组件渲染 null（入口交给它那根底栏）。
        items.push(ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-relocate-bulk', order: 351 },
          BulkEntry,
        ));
        items.push(ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-relocate', order: 350 },
          Entry,
        ));
        return function () {
          for (var i = 0; i < items.length; i += 1) {
            if (typeof items[i] === 'function') {
              try { items[i](); } catch (error) { /* ignore */ }
            }
          }
        };
      }));
      return function () {
        for (var i = 0; i < disposers.length; i += 1) {
          if (typeof disposers[i] === 'function') {
            try { disposers[i](); } catch (error) { /* ignore */ }
          }
        }
      };
    }

    exports.apply = apply;
    exports.__ui = { pageIsDark: pageIsDark, themeClass: themeClass };
    exports.__settings = {
      ChildrenSetting: ChildrenSetting,
      wantChildren: wantChildren,
      setWantChildren: setWantChildren,
    };
    exports.inject = inject;
    exports.__entry = Entry;
    exports.__bulkEntry = BulkEntry;
    // 给测试用的内部入口（浏览器里没人用）。
    exports.__bulk = {
      moveSelection: moveSelection,
      runBulkMove: runBulkMove,
      pickBulkTarget: pickBulkTarget,
      planTargetsWith: planTargetsWith,
      hostSupportsBulkMove: hostSupportsBulkMove,
      enterBulk: enterBulk,
      exitBulk: exitBulk,
      bulkDecorate: bulkDecorate,
      bulkMoveSelected: bulkMoveSelected,
      state: bulkState,
      sessionIdFromRow: sessionIdFromRow,
    };
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
