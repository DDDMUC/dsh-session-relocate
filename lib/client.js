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
    // 官方 UI 基座：菜单（Menu）和图标。声明在 package.json 的 dsh.client.inject 里；
    // 取不到（老宿主 / 没声明）时所有调用点都退回自绘面板，不影响其余功能。
    var primitives = null;
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (error) { primitives = null; }

    var STYLE_ID = 'dsh-session-relocate-styles';
    var CSS = [
      '.dshsm-item{display:block;width:100%;box-sizing:border-box;text-align:left;font:inherit;font-size:13px;line-height:1.45;padding:6px 10px;border:0;border-radius:6px;background:0 0;color:inherit;cursor:pointer;white-space:normal;overflow-wrap:anywhere}',
      '.dshsm-item:hover:not(:disabled){background:var(--dsw-alias-fill-secondary,rgba(127,127,127,.12))}',
      '.dshsm-item:disabled{color:inherit;opacity:.45;cursor:default}',
      // 菜单行：左边一个 16px 图标列，和官方那些菜单项（置顶/重命名/分叉…）对齐
      '.dshsm-row{display:flex;align-items:center;gap:16px;padding-left:8px}',
      '.dshsm-rowIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary,currentColor)}',
      '.dshsm-rowIcon svg{display:block}',
      '.dshsm-rowLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshsm-target{padding-left:18px}',
      '.dshsm-meta{display:block;font-size:11px;color:inherit;opacity:.65;overflow-wrap:anywhere}',
      '.dshsm-bad{color:#ff453a}',
      // 拖动时给工作区行加的高亮（官方行本身没有 drop 语义，所以这个类只由本插件加）
      '.dshsm-drop{outline:2px solid #4c8dff;outline-offset:-2px;border-radius:6px}',
      // 多选模式：行首勾选圈 + 底部操作条 + 目标工作区面板
      // 会话行勾选圈：逐字对齐 dsh-delete-session 的 .dsdel-check。
      // 原来是「蓝底 + inset 白环」的空心蓝圈，对方是「实心蓝底 + ::after 白勾」；
      // 单独装本插件的人看到的必须是同一套控件。
      '.dshsm-check{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l3,rgba(128,128,128,.5));background:transparent;flex:none;margin-right:8px;box-sizing:border-box;cursor:pointer}',
      '.dshsm-check-on{background:var(--dsw-alias-state-business-primary,#4c6ef5);border-color:var(--dsw-alias-state-business-primary,#4c6ef5)}',
      '.dshsm-check-on::after{content:"";width:9px;height:5px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) translateY(-1px)}',
      // 全选框：形态逐字对齐 dsh-delete-session（dsh-delete-session 单独装时用户看到的
      // 就是这一套）。15px 方框、1px 描边、radius 4px、10px 字号、同一个颜色 token ——
      // 两个插件都装时这里根本不渲染（BulkEntry / BulkBar 会让位），所以只有
      // 单独装本插件的人才看得见它，它必须和「两个都装」时的样子一致。
      '.dshsm-select-all{flex:0 0 auto;box-sizing:border-box;width:15px;height:15px;min-width:15px;margin:0 0 0 6px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.45));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:10px;line-height:1;cursor:pointer;opacity:1;visibility:visible;align-self:center}',
      '.dshsm-select-all:hover{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.dshsm-select-all[aria-checked="true"]{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:var(--dsw-alias-brand-primary,#4c8dff);color:#fff}',
      '.dshsm-select-all[aria-checked="mixed"]{border-color:var(--dsw-alias-brand-primary,#4c8dff);color:var(--dsw-alias-brand-primary,#4c8dff)}',
      '.dshsm-select-all:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4c8dff);outline-offset:1px}',
      // spacer 占住 flex 剩余宽度，框才会落在名字后面而不是被推到行尾。
      '.dshsm-flex-spacer{flex:1 1 auto;min-width:0;align-self:center;height:1px}',
      // 多选期间让名字块按自己的文字宽度排。宿主给的是 flex:1，名字块会填满整行，
      // 于是插在它后面的全选框被推到行中间（和名字之间空出一大截），而且一悬停、
      // 右侧 ⋯/⊕ 出现把名字压成省略号时，框还会跟着往左跳。
      // 这条和 dsh-delete-session 的 body.dsdel-selecting 那条同源。
      'body.dshsm-selecting [class*="_projectText"]{flex:0 1 auto;min-width:0}',
      // 暗色主题不再需要 inset 白环覆盖：勾现在由 ::after 画，白勾在两种主题下都够亮。
      // 多选底栏：注册进宿主槽 sidebar.footer.action，位置/宽度交给宿主排版。
      '.dshsm-bar{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 8px;box-sizing:border-box;font-size:13px}',
      '.dshsm-bar-count{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dshsm-bar-btn{flex:0 0 auto;white-space:nowrap;appearance:none;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font:inherit;font-size:13px;cursor:pointer}',
      '.dshsm-bar-btn:disabled{opacity:.5;cursor:default}',
      '.dshsm-bar-primary{border-color:#4c8dff;background:#4c8dff;color:#fff}',
      // 老宿主（没有那个槽）时的回退：自绘浮动卡片。
      '.dshsm-bar-float{position:fixed;left:12px;bottom:12px;z-index:2147483600;width:auto;gap:10px;padding:10px 12px;border-radius:12px;border:1px solid transparent;box-shadow:0 8px 28px rgba(0,0,0,.28)}',
      '.dshsm-bar-float.dshsm-dark{background:#1f232b;color:#f2f3f5;border-color:rgba(255,255,255,.18);color-scheme:dark}',
      '.dshsm-bar-float.dshsm-light{background:#fff;color:#12151a;border-color:rgba(0,0,0,.14);color-scheme:light}',
      '.dshsm-dark .dshsm-bar-btn:hover:not(:disabled){background:rgba(255,255,255,.08)}',
      '.dshsm-light .dshsm-bar-btn:hover:not(:disabled){background:rgba(0,0,0,.06)}',
      // 多选期间让页脚其他内容让位。只用**正面选择器点名别人**（[data-dsh-plugin] / [class*="_entryRow"]）；
      // 槽位容器是 display: contents，写「> *:not(.我的类)」会连自己一起藏掉（dsh-delete-session 上踩过三轮）。
      'body.dshsm-selecting [class*="_footArea"] > *:not([class*="_footerActions"]){display:none}',
      'body.dshsm-selecting [data-slot="sidebar.footer.action"] > [data-dsh-plugin]{display:none}',
      'body.dshsm-selecting [data-slot="sidebar.footer.action"] > [class*="_entryRow"]{display:none}',
      // 页脚里的「按钮型」入口也要让位。槽入口是**无包装层**的直接子节点
      // （renderer 的 SlotOutlet 是 <div data-slot style="display:contents">，入口组件直接挂成子节点），
      // 所以 '> button' 精确命中按钮型入口 —— 例如 dsh-sidebar-declutter 的 .dhns-footer-btn，
      // 它没带 data-dsh-plugin，上面两条规则都漏了它，多选时会和底栏挤在同一行。
      // :not([role="toolbar"]) 保证永远藏不到底栏自己（两家底栏都是 div + role="toolbar"）。
      'body.dshsm-selecting [data-slot="sidebar.footer.action"] > button:not([role="toolbar"]){display:none}',
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
      '.dshsm-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));flex:none}',
      '.dshsm-segBtn{border:0;background:0 0;color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:18px;padding:3px 8px;border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.dshsm-segBtn[data-on="true"]{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,inherit)}',
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
      '.dshsm-dock-slot{display:contents}',
      '.dshsm-dock{display:flex;align-items:center;justify-content:flex-start;gap:8px;width:min(calc(var(--dsh-composer-card-max-width,760px) + 2 * var(--dsh-composer-side-clearance,0px)),100%);align-self:center;padding:0 16px 0 20px;box-sizing:border-box}',
      '.dshsm-chip{border-radius:var(--dsw-radius-sm,8px);max-width:min(100%,360px);min-height:28px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;background:0 0;border:none;align-items:center;gap:4px;padding:0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;min-width:0}',
      '.dshsm-chip:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dshsm-chip-icon{color:var(--dsw-alias-label-primary,inherit);flex:none;display:inline-flex}',
      '.dshsm-chip-icon svg{display:block}',
      '.dshsm-chip-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.dshsm-chip-chevron{color:var(--dsw-alias-label-caption,#a7b0bf);flex:none;display:inline-flex}',
      '.dshsm-chip-chevron svg{display:block}',
      // 官方 Menu 里两行同名工作区时的「标题 + 末尾路径段」（照官方 WorkspacePicker 的样式）
      '.dshsm-menu-disambig{display:flex;align-items:center;gap:4px;min-width:0}',
      '.dshsm-menu-title{text-overflow:ellipsis;min-width:0;overflow:hidden}',
      '.dshsm-menu-suffix{flex:none;max-width:75%;text-overflow:ellipsis;min-width:0;overflow:hidden;color:var(--dsw-alias-label-secondary,inherit)}',
      // hover        → 整行悬浮显形（盯 .dshsm-dock）
      // hover-self   → 只有指针落进胶囊自己那一小块才显形（最早的做法）。
      // 两种都只是 opacity:0，仍然占位、仍然收得到指针事件，所以不会跳、也好点。
      '.dshsm-chip[data-mode="hover"]{opacity:0;transition:opacity .12s ease}',
      '.dshsm-dock:hover .dshsm-chip[data-mode="hover"]{opacity:1}',
      '.dshsm-chip[data-mode="hover-self"]{opacity:0;transition:opacity .12s ease}',
      '.dshsm-chip[data-mode="hover-self"]:hover,.dshsm-chip[data-mode="hover-self"]:focus-visible{opacity:1}',
      '.dshsm-dock--hidden{justify-content:flex-end}',
      // 皮肤插件（@linxin666/dsh-client-ui-skin-center）把 input.dock 的每个直接子元素都当
      // 「小配件」刷底板：
      //   html[data-dsh-skin] [data-phase="active"] [data-slot="conversation.input.dock"] > * {
      //     background/border/box-shadow/backdrop-filter … !important }
      // 我们这行是**全宽容器**，于是整条被刷成一块玻璃横条。这条复位只针对自己的容器：
      // 必须带 !important，且比特异性（皮肤最高 (0,4,1)，这里 (0,7,1)），
      // 否则平局时后加载的皮肤赢、看起来像没修好。没装皮肤时是空操作。
      'html:root:root:root [data-phase="active"] [data-slot="conversation.input.dock"] > .dshsm-dock.dshsm-dock,',
      'html:root:root:root [data-slot="conversation.input.dock"] > .dshsm-dock.dshsm-dock{',
      'background:none !important;',
      'background-image:none !important;',
      'border:0 !important;',
      'border-radius:0 !important;',
      'box-shadow:none !important;',
      'backdrop-filter:none !important;',
      '-webkit-backdrop-filter:none !important;',
      'margin:0 !important;',
      'padding:0 16px 0 20px !important;',   // 保留自己的内边距（左 20px 对齐 hero 那条）
      '}',
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

    // 官方 uiWorkspace 服务（由 apply 里 ctx.get('uiWorkspace') 填）。它带 pickDirectory()，
    // 也就是官方「添加工作区」用的那个目录选择器 —— 插件通过服务调用，不碰它的 UI。
    var uiWorkspaceService = null;

    /**
     * 弹官方目录选择器（原生系统对话框）。
     * @returns Promise<string|null|undefined>：路径 = 选了；null = 用户取消；undefined = 本机没有可用选择器。
     */
    function pickDirectoryNative() {
      var desktop = globalThis.__DSH_DIRECTORY_PICKER__;
      if (desktop !== null && typeof desktop === 'object' && typeof desktop.pick === 'function') {
        return Promise.resolve().then(function () { return desktop.pick(); }).then(
          function (path) { return typeof path === 'string' && path.length > 0 ? path : null; },
          function () { return null; },
        );
      }
      var service = uiWorkspaceService;
      if (service !== null && service !== undefined && typeof service.pickDirectory === 'function') {
        return Promise.resolve().then(function () { return service.pickDirectory(); }).then(
          function (path) { return typeof path === 'string' && path.length > 0 ? path : null; },
          function () { return null; },
        );
      }
      return Promise.resolve(undefined);
    }

    /** 目录选择器是否可用（决定「添加工作区…」是弹系统对话框还是手输路径）。 */
    function hasNativeDirectoryPicker() {
      var desktop = globalThis.__DSH_DIRECTORY_PICKER__;
      if (desktop !== null && typeof desktop === 'object' && typeof desktop.pick === 'function') return true;
      return uiWorkspaceService !== null && uiWorkspaceService !== undefined && typeof uiWorkspaceService.pickDirectory === 'function';
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
      dragDetached: '已从「{ws}」移出，现在是未分组',
      dragDetachedNoWs: '已移出工作区，现在是未分组',
      bulkDetached: '已移出 {ok} 个',
      selectAllGroup: '全选这个工作区',
      selectAllWorkspaces: '全选所有工作区',
      ungroupAction: '未分组',
      ungroupAlready: '这个对话本来就不在任何工作区里',
      ungroupDone: '已移出「{ws}」',
      ungroupFailed: '移出失败',
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
      chipModeTitle: '工作区 chip 什么时候出现',
      chipModeDesc: '「一直出现」常驻在输入框上方；「悬浮在那一行才出现」鼠标移到整行才显示；「只悬浮胶囊才出现」鼠标要正好落在胶囊那一小块；两者都保留占位，不会跳。「不出现」完全不渲染，预设胶囊会自动回到右边。',
      chipModeAlways: '一直出现',
      chipModeHover: '悬浮在那一行才出现',
      chipModeHoverSelf: '只悬浮胶囊才出现',
      chipModeNever: '不出现',
      starPrompt: '顺手留颗 Star，作者能高兴一整天',
      starCta: '行，给你一颗 Star',
      chipPick: '移动这个对话到：',
      chipAddWorkspace: '添加工作区…',
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
      dragDetached: 'Removed from “{ws}” — now ungrouped',
      dragDetachedNoWs: 'Removed from its workspace — now ungrouped',
      bulkDetached: 'Removed {ok}',
      selectAllGroup: 'Select every session in this workspace',
      selectAllWorkspaces: 'Select every session in every workspace',
      ungroupAction: 'Ungrouped',
      ungroupAlready: 'This conversation is not in any workspace',
      ungroupDone: 'Removed from “{ws}”',
      ungroupFailed: 'Remove failed',
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
      chipModeTitle: 'When to show the workspace chip',
      chipModeDesc: '"Always" keeps it above the composer; "On row hover" reveals it when the pointer enters that row; "Only when hovering the chip" needs the pointer on the chip itself. Both keep their space, so nothing jumps. "Never" hides it and the preset chip moves back to the right.',
      chipModeAlways: 'Always',
      chipModeHover: 'On row hover',
      chipModeHoverSelf: 'Only when hovering the chip',
      chipModeNever: 'Never',
      starPrompt: 'Leave a star — it makes the author’s day',
      starCta: 'Give a star',
      chipPick: 'Move this conversation to:',
      chipAddWorkspace: 'Add workspace…',
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

    // ── 工作区 chip 的出现方式：一直出现 / 悬浮才出现 / 不出现 ────────────────
    var CHIP_MODE_KEY = 'dsh-session-relocate.chipMode';
    // always = 常驻；hover = 整行悬浮显形；hover-self = 只悬浮胶囊那一小块才显形；
    // never = 完全不渲染。（和预设工作台的四种模式同名同义）
    var CHIP_MODES = ['always', 'hover', 'hover-self', 'never'];
    var chipModeListeners = [];

    function chipMode() {
      var stored = null;
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) stored = localStorage.getItem(CHIP_MODE_KEY);
      } catch (error) { /* 读不到就按默认 */ }
      return CHIP_MODES.indexOf(stored) >= 0 ? stored : 'always';
    }

    function setChipMode(mode) {
      var next = CHIP_MODES.indexOf(mode) >= 0 ? mode : 'always';
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) localStorage.setItem(CHIP_MODE_KEY, next);
      } catch (error) { /* 存不了就只在内存里生效 */ }
      for (var i = 0; i < chipModeListeners.length; i += 1) {
        try { chipModeListeners[i](next); } catch (error) { /* 单个订阅者出错不影响别人 */ }
      }
      return next;
    }

    function subscribeChipMode(listener) {
      chipModeListeners.push(listener);
      return function () {
        var at = chipModeListeners.indexOf(listener);
        if (at >= 0) chipModeListeners.splice(at, 1);
      };
    }

    /** 插件设置页里的「连同子对话」开关（行配置页与包配置页共用）。 */
    function ChildrenSetting() {
      var strings = text();
      var state = react.useState(wantChildren() ? 'on' : 'off');
      var on = state[0] === 'on';
      var modeState = react.useState(chipMode());
      var mode = modeState[0];
      function modeButton(value, label) {
        return react.createElement('button', {
          key: value,
          type: 'button',
          className: 'dshsm-segBtn',
          'data-on': mode === value ? 'true' : 'false',
          'aria-pressed': mode === value ? 'true' : 'false',
          onClick: function () { modeState[1](setChipMode(value)); },
        }, label);
      }
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
        react.createElement('div', { className: 'dshsm-setting', key: 'chipmode' }, [
          react.createElement('div', { className: 'dshsm-setting-text', key: 'text' }, [
            react.createElement('div', { className: 'dshsm-setting-title', key: 'title' }, strings.chipModeTitle),
            react.createElement('div', { className: 'dshsm-setting-desc', key: 'desc' }, strings.chipModeDesc),
          ]),
          react.createElement('div', { className: 'dshsm-seg', key: 'seg' }, [
            modeButton('always', strings.chipModeAlways),
            modeButton('hover', strings.chipModeHover),
            modeButton('hover-self', strings.chipModeHoverSelf),
            modeButton('never', strings.chipModeNever),
          ]),
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

    /** 官方 IconFolderOpenRegular（16px）的原始路径，菜单行图标复用。 */
    var FOLDER_OPEN_PATH = 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z';

    /**
     * 「多选」菜单项的图标（和 dsh-delete-session 的 SELECT_PATHS 同一套形状：
     * 左侧两个圆点 + 右侧两条横线）。少了它这一行就是裸文字，两个插件都装时
     * 切换安装方式会看到有无图标两种样子。
     */
    var SELECT_PATHS = [
      'M5 7m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
      'M5 17m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
      'M11 7h9',
      'M11 17h9',
    ];

    /** 把一串 SVG 路径画成 16px 图标（24 视窗，和宿主菜单图标同尺寸）。 */
    function menuGlyph(paths) {
      return react.createElement('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, paths.map(function (d) { return react.createElement('path', { key: d, d: d }); }));
    }

    /** 右键菜单里「移动到」那行的图标 key（要注册进 contextMenu.icon 槽才会渲染）。 */
    var CONTEXT_ICON_KEY = 'session-relocate.move';

    /** contextMenu.icon 槽的组件：右键菜单按 action.icon.key 查这条，渲染的工作区文件夹图标。 */
    function MoveContextIcon() {
      return react.createElement('svg', {
        width: 16,
        height: 16,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth: 1,
      }, [
        react.createElement('path', { key: 'a', d: FOLDER_OPEN_PATH, stroke: 'currentColor' }),
        react.createElement('path', { key: 'b', d: 'M3.63501 7.66614H12.3647', stroke: 'currentColor' }),
      ]);
    }
    /** 渲染一个菜单按钮。 */
    function button(key, label, options) {
      var props = Object.assign({ key: key, type: 'button', role: 'menuitem', className: 'dshsm-item' }, options || {});
      return react.createElement('button', props, label);
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
      // 自动滚动：拖动源所在的滚动容器、当前指针、rAF 句柄
      scrollEl: null,
      scrollRaf: null,
      pointer: null,
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

    /**
     * 「未分组」那个分组：它的工作区行 data-row-key 恰好是 "workspace:"（id 为空）。
     * 拖到它上面 = 移出工作区（只改归属，文件与 header 都不动）。
     */
    function ungroupedGroupOf(target) {
      var node = target;
      for (var depth = 0; depth < ROW_WALK_LIMIT && node !== null && node !== undefined; depth += 1) {
        if (typeof node.getAttribute === 'function' && node.getAttribute('role') === 'tree') break;
        if (typeof node.querySelectorAll === 'function') {
          var rows = node.querySelectorAll(WORKSPACE_ROW_SELECTOR);
          if (rows !== null && rows !== undefined && typeof rows.length === 'number') {
            if (rows.length > 1) break;
            if (rows.length === 1) {
              var key = typeof rows[0].getAttribute === 'function' ? rows[0].getAttribute(ROW_KEY_ATTR) : null;
              if (key === WORKSPACE_PREFIX) return { section: node, row: rows[0], workspaceId: '' };
            }
          }
        }
        node = node.parentElement;
      }
      return null;
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

    // ── 拖到侧栏上下边缘自动滚动 ────────────────────────────────────────────
    //
    // 侧栏很长时，「能拖到」和「看得见」是两件事：不滚就只能拖到眼前那几个工作区。
    // 这里用 rAF 自己滚（HTML5 拖拽时浏览器不会帮你滚），并且不依赖任何 class 名：
    // 向上找第一个 overflow-y 可滚且内容确实超出的祖先，官方/第三方侧栏都适用。
    var SCROLL_EDGE = 84;      // 指针进入距边缘这么多像素就开滚
    var SCROLL_MAX_STEP = 22;  // 每帧最多滚多少像素
    var SCROLL_TAIL = 40;      // 指针越出滚动区这么多以内继续（避免边缘抖动）

    /** 从元素向上找真正的滚动容器；找不到返回 null。 */
    function findScrollableAncestor(element) {
      if (typeof document === 'undefined') return null;
      var node = element;
      while (node !== null && node !== undefined && node !== document.body && node !== document.documentElement) {
        var style = null;
        try {
          style = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(node) : null;
        } catch (error) {
          style = null;
        }
        var overflowY = style !== null && style !== undefined ? String(style.overflowY || '') : '';
        if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
          && typeof node.scrollHeight === 'number' && typeof node.clientHeight === 'number'
          && node.scrollHeight > node.clientHeight + 4) return node;
        node = node.parentElement;
      }
      return null;
    }

    /** 离边缘越近每帧滚得越多：比例平方曲线，2~22px。 */
    function scrollStepFor(distance) {
      var ratio = Math.min(1, Math.max(0, Number(distance) / SCROLL_EDGE));
      return Math.max(2, Math.round(ratio * ratio * SCROLL_MAX_STEP));
    }

    function stopAutoScroll() {
      if (dragState.scrollRaf !== null) {
        try {
          if (typeof globalThis.cancelAnimationFrame === 'function') globalThis.cancelAnimationFrame(dragState.scrollRaf);
          else clearTimeout(dragState.scrollRaf);
        } catch (error) { /* ignore */ }
        dragState.scrollRaf = null;
      }
      dragState.scrollEl = null;
      dragState.pointer = null;
    }

    function ensureAutoScroll() {
      if (dragState.scrollRaf !== null) return;
      if (dragState.scrollEl === null || dragState.scrollEl === undefined) return;
      if (typeof globalThis.requestAnimationFrame !== 'function') return;
      dragState.scrollRaf = globalThis.requestAnimationFrame(autoScrollTick);
    }

    function autoScrollTick() {
      dragState.scrollRaf = null;
      var element = dragState.scrollEl;
      var pointer = dragState.pointer;
      if (element === null || element === undefined || pointer === null || dragState.sessionId === null) return;
      var rect = null;
      try { rect = element.getBoundingClientRect(); } catch (error) { rect = null; }
      if (rect === null || rect === undefined || !(rect.height > 0)) return;
      // 指针甩到侧栏外面（比如拖去聊天区）就别滚了
      if (pointer.x < rect.left - SCROLL_TAIL || pointer.x > rect.right + SCROLL_TAIL) return;
      if (pointer.y < rect.top - SCROLL_TAIL || pointer.y > rect.bottom + SCROLL_TAIL) return;
      var delta = 0;
      if (pointer.y < rect.top + SCROLL_EDGE) delta = -scrollStepFor(rect.top + SCROLL_EDGE - pointer.y);
      else if (pointer.y > rect.bottom - SCROLL_EDGE) delta = scrollStepFor(pointer.y - (rect.bottom - SCROLL_EDGE));
      if (delta === 0) return;
      var before = element.scrollTop;
      element.scrollTop = before + delta;
      // 到底 / 到顶：滚不动了，等下一次 dragover 再说，别空转烧 rAF
      if (element.scrollTop === before) return;
      // 内容滚了但不会再收到 dragover：按指针位置重算一次投放目标，高亮才跟得上
      hoverAtPoint(pointer.x, pointer.y);
      ensureAutoScroll();
    }

    /** 自动滚动后按指针重算高亮（等价于一次没有事件的 dragover）。 */
    function hoverAtPoint(x, y) {
      if (typeof document === 'undefined' || typeof document.elementFromPoint !== 'function') return;
      var node = null;
      try { node = document.elementFromPoint(x, y); } catch (error) { node = null; }
      if (node === null || node === undefined) { clearHighlight(); return; }
      var drop = resolveDrop({ target: node });
      if (drop === null) { clearHighlight(); return; }
      highlightGroup(drop.section);
    }

    function resetDrag() {
      stopAutoScroll();
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
      // 「未分组」组 = 移出工作区。本来就在未分组时不接管（无事可做，让官方排序照旧）。
      var ungrouped = ungroupedGroupOf(target);
      if (ungrouped !== null) {
        if (dragState.sourceWorkspaceId === null || dragState.sourceWorkspaceId === undefined || dragState.sourceWorkspaceId === '') return null;
        return { sessionId: dragState.sessionId, kind: 'ungrouped', targetWorkspaceId: null, section: ungrouped.section };
      }
      var group = workspaceGroupOf(target);
      if (group === null) {
        // 退化路径：读不到分组结构（老版本 DSH / 结构变了）时，回到「只认工作区行」的老行为，
        // 绝不因为读不到就去乱接管（那会破坏官方的工作区内排序）。
        var row = nearestRow(target);
        var fallbackId = row === null ? null : workspaceIdOf(row);
        if (fallbackId === null) return null;
        if (dragState.sourceWorkspaceId !== null && dragState.sourceWorkspaceId === fallbackId) return null;
        return { sessionId: dragState.sessionId, kind: 'workspace', targetWorkspaceId: fallbackId, section: row };
      }
      // 落在**它自己所在的那个分组**里 = 官方的工作区内排序区，让路（官方照旧重排）。
      if (dragState.sourceWorkspaceId !== null && dragState.sourceWorkspaceId === group.workspaceId) return null;
      return { sessionId: dragState.sessionId, kind: 'workspace', targetWorkspaceId: group.workspaceId, section: group.section };
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
      dragState.scrollEl = findScrollableAncestor(row);
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
      // 记下指针位置并驱动自动滚动（HTML5 拖拽时浏览器自己不滚）
      if (event !== null && event !== undefined && typeof event.clientX === 'number' && typeof event.clientY === 'number') {
        dragState.pointer = { x: event.clientX, y: event.clientY };
        ensureAutoScroll();
      }
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
      var kind = drop.kind === 'ungrouped' ? 'ungrouped' : 'workspace';
      resetDrag();
      if (kind === 'ungrouped') {
        if (ids.length > 1) detachManyByDrag(ids, hostSelected);
        else detachByDrag(sessionId, hostSelected);
        return;
      }
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

    /** 拖到「未分组」组上：只把归属摘掉 —— 会话日志、header 的 cwd、写句柄全都不动。 */
    function detachByDrag(sessionId, hostSelected) {
      var strings = text();
      toast(strings.moving);
      post('/move-out', { sessionId: sessionId }).then(function (result) {
        if (result !== null && result !== undefined && result.ok === true) {
          var from = result.detachedFrom !== null && result.detachedFrom !== undefined && typeof result.detachedFrom.title === 'string'
            ? result.detachedFrom.title
            : '';
          toast(from.length > 0 ? strings.dragDetached.replace('{ws}', from) : strings.dragDetachedNoWs);
          if (bulkState.selecting === true) exitBulk();
          else if (hostSelected === true) dismissHostSelection();
          refreshSidebar();
          return;
        }
        var message = result !== null && result !== undefined && typeof result.message === 'string' ? result.message : '';
        toast(strings.dragFailed + message);
      }, function (error) {
        toast(strings.dragFailed + errorText(error));
      });
    }

    /** 多选时整批移出工作区：逐条摘归属（只改注册表，很快），失败按条隔离。 */
    function detachManyByDrag(ids, hostSelected) {
      var strings = text();
      toast(strings.moving);
      var done = 0;
      var failed = 0;
      var chain = Promise.resolve();
      for (var i = 0; i < ids.length; i += 1) {
        (function (id) {
          chain = chain.then(function () {
            return post('/move-out', { sessionId: id }).then(function (result) {
              if (result !== null && result !== undefined && result.ok === true) done += 1;
              else failed += 1;
              toast(strings.bulkProgress.replace('{d}', String(done + failed)).replace('{t}', String(ids.length)));
            }, function () {
              failed += 1;
            });
          });
        })(ids[i]);
      }
      chain.then(function () {
        var summary = failed === 0
          ? strings.bulkDetached.replace('{ok}', String(done))
          : strings.bulkPartial.replace('{ok}', String(done)).replace('{fail}', String(failed));
        toast(summary);
        if (bulkState.selecting === true) exitBulk();
        else if (hostSelected === true) dismissHostSelection();
        refreshSidebar();
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
    // 全选框（两个位置：整个「工作区 N」标题行 + 每个工作区行），形态和 dsh-delete-session 一致。
    var SELECT_ALL_CLASS = 'dshsm-select-all';
    var SPACER_CLASS = 'dshsm-flex-spacer';
    /** 自建元素的标记属性：observer 靠它认出「这是我自己插的」，不再为它调度下一帧。 */
    var OWN_ATTR = 'data-dshsm';
    var ALL_HEADER_SELECTOR = '[data-sidebar-workspace-header]';
    var LIST_SELECTOR = '[role="tree"]';
    var WORKSPACE_ROW_SELECTOR = '[data-row-key^="workspace:"]';
    /** 标题行的锚点：框插在名字后面、动作区前面（动作区那段不能带 margin-left:auto）。 */
    var HEAD_ANCHOR = '[class*="_searchSlot"], [class*="_headerActions"]';
    var ROW_ANCHOR = '[class*="_rowActions"]';
    /** 当前挂着的列表 observer（只在多选期间存在）。 */
    var rowObserver = null;
    var bulkState = { selecting: false, selected: {}, bar: null, countNode: null, moveNode: null, raf: null, moveSelectionFn: null, text: '', busy: false };
    /** 宿主有没有 sidebar.footer.action 这个槽（老宿主没有 → 回退自绘浮动卡片）。 */
    var bulkSlotReady = false;
    var bulkListeners = [];

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
    // 位置：靠自绘容器（宽度抄 .wSkVaW_composerHero、左内边距 20px 抄 .wSkVaW_heroWorkspaceRow），
    // 槽本身不负责定位。

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

    /**
     * 同名工作区用末尾路径段区分，免得菜单里两行一模一样。
     * 和官方 WorkspacePicker 的 distinguishingPathSuffixes 同一个思路，只是取最短尾部一段。
     */
    function withPathSuffix(rows) {
      var counts = {};
      var i;
      for (i = 0; i < rows.length; i += 1) {
        var name = rows[i].title;
        counts[name] = (counts[name] === undefined ? 0 : counts[name]) + 1;
      }
      for (i = 0; i < rows.length; i += 1) {
        if (counts[rows[i].title] > 1 && typeof rows[i].path === 'string') {
          var parts = rows[i].path.split(/[\\/]+/).filter(function (part) { return part.length > 0; });
          if (parts.length > 0) rows[i].suffix = parts[parts.length - 1];
        }
      }
      return rows;
    }

    /**
     * 把 /describe 的结果整理成「移动到」子菜单的条目（右键菜单用）。
     *
     * 和「在应用中打开」一样是 **children 子菜单**：鼠标悬停展开，位置/样式/键盘导航全交给官方。
     * 当前工作区不列出来；工作区名字重名时补末尾路径段区分。
     */
    function moveTargetActions(result, strings) {
      if (result === null || result === undefined || typeof result !== "object") return [];
      var session = result.session;
      var all = Array.isArray(result.workspaces) ? result.workspaces : [];
      if (session === null || session === undefined || typeof session !== "object") return [];
      var rows = withPathSuffix(all.map(function (workspace) {
        return {
          workspace: workspace,
          id: String(workspace.id),
          title: typeof workspace.title === "string" && workspace.title.length > 0 ? workspace.title : String(workspace.id),
          path: workspace.path,
        };
      }));
      var actions = [];
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].workspace.current === true) continue;
        var label = rows[i].title;
        if (rows[i].suffix !== undefined) {
          label = react.createElement("span", { className: "dshsm-menu-disambig", key: "label", title: rows[i].path }, [
            react.createElement("span", { className: "dshsm-menu-title", key: "title" }, rows[i].title),
            " ",
            react.createElement("span", { className: "dshsm-menu-suffix", key: "suffix" }, rows[i].suffix),
          ]);
        }
        actions.push({ id: "ws:" + rows[i].id, label: label, workspace: rows[i].workspace, kind: "workspace" });
      }
      // 和面板同一顺序：各工作区 → 其它目录… → 未分组（有归属时才出现）。
      actions.push({ id: "choose-dir", label: strings.chooseDir, kind: "choose-dir" });
      var inWorkspace = typeof session.currentWorkspaceId === "string" && session.currentWorkspaceId.length > 0;
      if (inWorkspace) actions.push({ id: "ungroup", label: strings.ungroupAction, kind: "ungroup" });
      return actions;
    }

    /** 搬移成功后的提示文案：规则和面板里的完成态一致（pending / 需要刷新都要说出来）。 */
    function moveDoneText(result, fallbackTitle) {
      var strings = text();
      var title = typeof result.targetTitle === "string" && result.targetTitle.length > 0 ? result.targetTitle : String(fallbackTitle);
      var head = result.applied === "attached" ? strings.attached.replace("{ws}", title) : strings.dragMoved.replace("{ws}", title);
      var suffix = result.applied === "pending"
        ? strings.pending
        : (result.applied === "live" || result.applied === "attached" ? "" : strings.needsReload);
      return head + receiptNotes(result) + (suffix.length > 0 ? "；" + suffix : "");
    }

    /** 右键菜单里选中一项之后真正执行（单个会话）。 */
    function runMenuAction(sessionId, action) {
      var strings = text();
      if (action === null || action === undefined) return;
      if (action.kind === "ungroup") {
        toast(strings.moving);
        post("/move-out", { sessionId: sessionId }).then(function (result) {
          if (result !== null && typeof result === "object" && result.ok === true) {
            var from = result.detachedFrom !== null && result.detachedFrom !== undefined && typeof result.detachedFrom.title === "string"
              ? result.detachedFrom.title
              : "";
            toast(from.length > 0 ? strings.ungroupDone.replace("{ws}", from) : strings.dragDetachedNoWs);
            refreshSidebar();
            return;
          }
          if (result !== null && typeof result === "object" && result.code === "already-ungrouped") {
            toast(strings.ungroupAlready);
            return;
          }
          var message = result !== null && typeof result === "object" && typeof result.message === "string" ? result.message : "";
          toast(strings.dragFailed + message);
        }, function (error) {
          toast(strings.dragFailed + errorText(error));
        });
        return;
      }
      if (action.kind === "choose-dir") {
        // 目录选择器（官方那头）优先；没有就退回手输。
        pickDirectoryNative().then(function (picked) {
          var path = picked;
          if (path === undefined) {
            var typed = globalThis.prompt(strings.chooseDirPrompt, "");
            if (typeof typed !== "string" || typed.trim().length === 0) return;
            path = typed.trim();
          }
          if (typeof path !== "string" || path.length === 0) return;
          toast(strings.moving);
          var payload = { sessionId: sessionId, targetPath: path };
          if (wantChildren() === false) payload.includeChildren = false;
          post("/move", payload).then(function (result) {
            if (result !== null && typeof result === "object" && result.ok === true) {
              toast(moveDoneText(result, path));
              refreshSidebar();
              return;
            }
            var message = result !== null && typeof result === "object" && typeof result.message === "string" ? result.message : "";
            toast(strings.dragFailed + message);
          }, function (error) {
            toast(strings.dragFailed + errorText(error));
          });
        }, function () { /* 选择器自己会报错 */ });
        return;
      }
      if (action.kind === "workspace" && action.workspace !== null && action.workspace !== undefined) {
        toast(strings.moving);
        var payload = { sessionId: sessionId, targetWorkspaceId: action.workspace.id };
        if (wantChildren() === false) payload.includeChildren = false;
        post("/move", payload).then(function (result) {
          if (result !== null && typeof result === "object" && result.ok === true) {
            toast(moveDoneText(result, action.workspace.title));
            refreshSidebar();
            return;
          }
          var message = result !== null && typeof result === "object" && typeof result.message === "string" ? result.message : "";
          toast(strings.dragFailed + message);
        }, function (error) {
          toast(strings.dragFailed + errorText(error));
        });
      }
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

    /** 按路径搬（菜单里的「添加工作区…」）：目录不存在会由主机侧创建并注册成新工作区。 */
    function moveFromChipPath(sessionId, path, onMoved) {
      var strings = text();
      toast(strings.moving);
      var payload = { sessionId: sessionId, targetPath: path };
      if (wantChildren() === false) payload.includeChildren = false;
      post('/move', payload).then(function (result) {
        if (result !== null && typeof result === 'object' && result.ok === true) {
          var title = typeof result.targetTitle === 'string' && result.targetTitle.length > 0 ? result.targetTitle : path;
          toast(result.applied === 'attached'
            ? strings.attached.replace('{ws}', title)
            : strings.chipMoved.replace('{ws}', title));
          if (typeof onMoved === 'function') onMoved(title, result.targetWorkspaceId);
          refreshSidebar();
          return;
        }
        var message = result !== null && typeof result === 'object' && typeof result.message === 'string' ? result.message : '';
        toast(strings.dragFailed + message);
      }, function (error) {
        toast(strings.dragFailed + errorText(error));
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
    /** 官方 Menu 可用吗（取不到就退回自绘面板）。 */
    function menuReady() {
      return primitives !== null && primitives !== undefined && typeof primitives.Menu === 'function';
    }

    /** 菜单里的文件夹图标（官方 WorkspacePicker 用的是 IconFolderCloseRegular）。 */
    function chipFolderIcon() {
      if (primitives !== null && primitives !== undefined && primitives.IconFolderCloseRegular !== undefined) {
        return react.createElement(primitives.IconFolderCloseRegular, { size: 16 });
      }
      return undefined;
    }

    /** 菜单里「添加工作区…」前面的加号图标。 */
    function chipPlusIcon() {
      if (primitives !== null && primitives !== undefined && primitives.IconPlusOutlineRegular !== undefined) {
        return react.createElement(primitives.IconPlusOutlineRegular, { size: 16 });
      }
      return undefined;
    }

    var CHIP_ADD_WORKSPACE = '__dshsm-add-workspace';
    var CHIP_EMPTY_ID = '__dshsm-none';

    /**
     * 把 /describe 的结果拼成官方 Menu 的 items / footer：
     *   [📁 工作区 A ✓] [📁 工作区 B] ── [＋ 添加工作区…]
     * 当前工作区由 selectedId 画勾（和官方工作区下拉一样）。
     */
    function chipMenuEntries(snapshot, strings) {
      var spaces = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.spaces) ? snapshot.spaces.slice() : [];
      if (snapshot === null || snapshot === undefined) {
        return { items: [{ id: CHIP_EMPTY_ID, label: strings.loading, disabled: true }], footer: [] };
      }
      var rows = withPathSuffix(spaces.map(function (space) {
        return {
          id: space.id,
          title: typeof space.title === 'string' && space.title.length > 0 ? space.title : String(space.id),
          path: space.path,
        };
      }));
      var items = [];
      for (var i = 0; i < rows.length; i += 1) {
        var label = rows[i].title;
        if (rows[i].suffix !== undefined) {
          label = react.createElement('span', { className: 'dshsm-menu-disambig', key: 'label', title: rows[i].path }, [
            react.createElement('span', { className: 'dshsm-menu-title', key: 'title' }, rows[i].title),
            ' ',
            react.createElement('span', { className: 'dshsm-menu-suffix', key: 'suffix' }, rows[i].suffix),
          ]);
        }
        items.push({ id: rows[i].id, label: label, icon: chipFolderIcon() });
      }
      if (items.length === 0) {
        return { items: [{ id: CHIP_EMPTY_ID, label: strings.noTargets, disabled: true }], footer: [] };
      }
      return {
        items: items,
        footer: [{ id: CHIP_ADD_WORKSPACE, label: strings.chipAddWorkspace, icon: chipPlusIcon() }],
      };
    }

    function WorkspaceDockChip(props) {
      var strings = text();
      var sessionId = props !== null && props !== undefined
        ? (typeof props.sessionId === 'string'
          ? props.sessionId
          : (props.session !== undefined && props.session !== null && typeof props.session.id === 'string' ? props.session.id : undefined))
        : undefined;
      // 官方 hero 那一排（工作区胶囊 + 预设胶囊）在的时候，我们完全不渲染 ——
      // 否则同一条工作区 chip 会同时出现两次（官方一条、我们一条）。
      var session = props !== null && props !== undefined && props.session !== null && typeof props.session === 'object'
        ? props.session
        : undefined;
      var heroPresent = session !== undefined && session.blank === true;
      if (!heroPresent && typeof document !== 'undefined' && typeof document.querySelector === 'function') {
        try {
          heroPresent = document.querySelector('[class*="heroWorkspaceRow"]') !== null;
        } catch (error) {
          heroPresent = false;
        }
      }

      var useState = typeof react.useState === 'function' ? react.useState : function (initial) { return [initial, function () {}]; };
      var useEffect = typeof react.useEffect === 'function' ? react.useEffect : function () {};
      var useRef = typeof react.useRef === 'function' ? react.useRef : function () { return { current: null }; };

      var titleState = useState(strings.chipUnknown);
      var title = titleState[0];
      var setTitle = titleState[1];
      // snapshot：最近一次 /describe 的结果（currentId + 工作区列表），菜单用它渲染。
      var snapshotState = useState(null);
      var snapshot = snapshotState[0];
      var setSnapshot = snapshotState[1];
      var openState = useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var anchorRef = useRef(null);
      var modeState = useState(chipMode());
      var mode = modeState[0];
      useEffect(function () {
        return subscribeChipMode(function (next) { modeState[1](next); });
      }, []);

      function applyDescribe(result) {
        var spaces = result !== null && typeof result === 'object' && Array.isArray(result.workspaces) ? result.workspaces : [];
        var described = result !== null && typeof result === 'object' ? result.session : null;
        var currentId = null;
        if (described !== null && described !== undefined && typeof described === 'object') {
          currentId = described.currentWorkspaceId !== undefined && described.currentWorkspaceId !== null
            ? described.currentWorkspaceId
            : (described.cwdMatchesWorkspaceId === undefined ? null : described.cwdMatchesWorkspaceId);
        }
        setSnapshot({ currentId: currentId, spaces: spaces });
        var next = titleFromDescribe(result);
        if (next !== null && next !== undefined) setTitle(next);
      }

      function loadDescribe() {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        post('/describe', { sessionId: sessionId }).then(function (result) {
          applyDescribe(result);
        }, function () { /* 读不到就保持上一次的显示 */ });
      }

      useEffect(function () {
        if (heroPresent || typeof sessionId !== 'string' || sessionId.length === 0) return function () {};
        var alive = true;
        post('/describe', { sessionId: sessionId }).then(function (result) {
          if (alive) applyDescribe(result);
        }, function () { /* 读不到就保持上一次的显示 */ });
        return function () { alive = false; };
      }, [sessionId, heroPresent]);

      // hooks 都调用过了，这里提前退出是安全的（顺序不变）。
      if (heroPresent) return null;

      function anchorRect() {
        var node = anchorRef.current;
        if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null;
        return node.getBoundingClientRect();
      }

      function onChipClick() {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return;
        // 有官方 Menu 就弹官方那套下拉（和 hero 那条工作区胶囊一模一样）；
        // 取不到就退回自绘面板。
        if (menuReady()) {
          if (open === true) { setOpen(false); return; }
          setOpen(true);
          if (snapshot === null) setSnapshot(null);
          loadDescribe();
          return;
        }
        pickMoveTarget(sessionId).then(function (workspace) {
          if (workspace === null) return;
          moveFromChip(sessionId, workspace, function (next) { setTitle(next); });
        }, function () { /* 面板自己会报错 */ });
      }

      function onChipSelect(id) {
        setOpen(false);
        if (id === CHIP_EMPTY_ID) return;
        if (id === CHIP_ADD_WORKSPACE) {
          // 和官方「添加工作区…」一样弹系统目录选择器；本机没有选择器才退回手输路径。
          pickDirectoryNative().then(function (picked) {
            var path = picked;
            if (path === undefined) {
              var typed = globalThis.prompt(strings.chooseDirPrompt, '');
              if (typeof typed !== 'string' || typed.trim().length === 0) return;
              path = typed.trim();
            }
            if (typeof path !== 'string' || path.length === 0) return;   // 用户取消
            moveFromChipPath(sessionId, path, function (next, nextId) {
              setTitle(next);
              setSnapshot({
                currentId: typeof nextId === 'string' ? nextId : (snapshot !== null ? snapshot.currentId : null),
                spaces: snapshot !== null && Array.isArray(snapshot.spaces) ? snapshot.spaces : [],
              });
            });
          });
          return;
        }
        var spaces = snapshot !== null && Array.isArray(snapshot.spaces) ? snapshot.spaces : [];
        var target = null;
        for (var i = 0; i < spaces.length; i += 1) {
          if (spaces[i] !== null && spaces[i] !== undefined && spaces[i].id === id) target = spaces[i];
        }
        if (target === null) return;
        if (snapshot !== null && snapshot.currentId === id) return;   // 已经是这个工作区了
        moveFromChip(sessionId, target, function (next) {
          setTitle(next);
          setSnapshot({ currentId: id, spaces: spaces });
        });
      }

      var renderSlot = props !== null && props !== undefined && typeof props.renderSlot === 'function' ? props.renderSlot : null;
      var SessionProvider = props !== null && props !== undefined && typeof props.SessionProvider === 'function' ? props.SessionProvider : null;
      var tail = null;
      if (renderSlot !== null) {
        // 子槽是 session 作用域：必须用 SessionProvider 包一层，否则子槽拿不到会话、什么都不渲染。
        // 不传 session prop —— renderer 里 Object.hasOwn(props,'session') 为 false 时继承当前会话绑定。
        var inner = renderSlot('session-relocate.dock', { sessionId: sessionId });
        tail = SessionProvider === null ? inner : react.createElement(SessionProvider, null, inner);
      }
      var label = typeof title === 'string' && title.length > 0 ? title : strings.chipUnknown;
      var folderPath = 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z';
      var chipNode = mode === 'never' ? null : react.createElement('button', {
          key: 'chip',
          type: 'button',
          className: 'dshsm-chip',
          'data-mode': mode,
          ref: anchorRef,
          'aria-label': strings.chipAria.replace('{ws}', label),
          title: strings.chipAria.replace('{ws}', label),
          'aria-haspopup': menuReady() ? 'menu' : undefined,
          'aria-expanded': menuReady() ? (open === true ? 'true' : 'false') : undefined,
          onClick: onChipClick,
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
        ]);

      var menuNode = null;
      if (open === true && menuReady()) {
        var entries = chipMenuEntries(snapshot, strings);
        menuNode = react.createElement(primitives.Menu, {
          key: 'chipmenu',
          open: true,
          anchor: null,
          items: entries.items,
          footer: entries.footer,
          selectedId: snapshot !== null && typeof snapshot.currentId === 'string' ? snapshot.currentId : '',
          onSelect: onChipSelect,
          onClose: function () { setOpen(false); },
          side: 'bottom',
          align: 'start',
          portal: true,
          getAnchorRect: anchorRect,
        });
      }

      return react.createElement('div', { className: mode === 'never' ? 'dshsm-dock dshsm-dock--hidden' : 'dshsm-dock' }, [
        chipNode,
        menuNode,
        tail === null ? null : react.createElement('span', { className: 'dshsm-dock-slot', key: 'slot' }, tail),
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

    // ── 全选框 ──────────────────────────────────────────────────────────────
    //
    // 和 dsh-delete-session 一样提供两个位置：
    //   [data-sidebar-workspace-header]  = 「工作区 N」那一行 → 全选所有会话
    //   [data-row-key^="workspace:"]     = 每个工作区行     → 全选该组的会话
    // 只在多选模式里出现，和手动勾选双向同步。

    /** 元素在 parent.children 里的位置；HTMLCollection 没有 indexOf，不能用它。 */
    function childIndex(parent, node) {
      if (parent === null || parent === undefined) return -1;
      var kids = parent.children;
      if (kids === null || kids === undefined) return -1;
      for (var i = 0; i < kids.length; i += 1) {
        if (kids[i] === node) return i;
      }
      return -1;
    }

    function rowKeyOf(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return null;
      return node.getAttribute(ROW_KEY_ATTR);
    }

    /**
     * 只取 node 的**直系**行（穿透一层 wrapper，跳过嵌套工作区）。
     *
     * 宿主把工作区行包在 HoverCard 的 <span> 里，所以工作区行的 parentElement 是那个 span，
     * 从它往下查不到任何会话行 —— 必须能穿透。div[role="group"] 是**嵌套工作区**，
     * 跳过，否则父组的全选会把子组的会话一起选上。
     */
    function ownRows(node) {
      var rows = [];
      var visit = function (parent, depth) {
        if (parent === null || parent === undefined || parent.children === undefined) return;
        for (var i = 0; i < parent.children.length; i += 1) {
          var child = parent.children[i];
          var key = rowKeyOf(child);
          if (typeof key === 'string') { rows.push(child); continue; }
          if (depth >= 2) continue;
          if (typeof child.getAttribute === 'function' && child.getAttribute('role') === 'group') continue;
          visit(child, depth + 1);
        }
      };
      visit(node, 0);
      return rows;
    }

    /**
     * 一个工作区行所属的容器，以及里面的直系行。
     *
     * 向上爬而不是假设层级：wrapper 会让「父元素就是分组」这个假设失效。
     * 一旦爬到含**多于一个**工作区行的容器就停手 —— 那是共享列表，在那里取会把别组的也拿进来。
     */
    function groupContainerOf(headRow) {
      var node = headRow === null || headRow === undefined ? null : headRow.parentElement;
      for (var depth = 0; depth < 6; depth += 1) {
        if (node === null || node === undefined) return null;
        var rows = ownRows(node);
        var workspaces = 0;
        var sessions = [];
        var overflow = false;
        for (var i = 0; i < rows.length; i += 1) {
          var key = rowKeyOf(rows[i]);
          if (typeof key !== 'string') continue;
          if (key.indexOf(WORKSPACE_PREFIX) === 0) workspaces += 1;
          else if (key.indexOf(SESSION_PREFIX) === 0) sessions.push(key.slice(SESSION_PREFIX.length));
          else if (key.indexOf('overflow:') === 0) overflow = true;
        }
        // 到共享列表了（这里能看见别的组）→ 停手，否则会把别组的会话也拿进来。
        if (workspaces > 1) return null;
        // 找到会话行了才算真的到分组：工作区行外面那层 wrapper 里一个会话都没有，
        // 在那里返回就会得到一个空列表，全选框点了什么也不做。
        if (sessions.length > 0 || overflow === true) return { sessions: sessions, overflow: overflow };
        node = node.parentElement;
      }
      return null;
    }

    /** 本组的会话 id（只含当前渲染出来的；被折叠的不在 DOM 里）。 */
    function sessionsUnderWorkspace(headRow) {
      var found = groupContainerOf(headRow);
      return found === null ? [] : found.sessions;
    }

    /** 整棵列表里所有会话 id。 */
    function everySessionId(rows) {
      var ids = [];
      for (var i = 0; i < rows.length; i += 1) {
        var key = rowKeyOf(rows[i]);
        if (typeof key === 'string' && key.indexOf(SESSION_PREFIX) === 0 && key.length > SESSION_PREFIX.length) {
          ids.push(key.slice(SESSION_PREFIX.length));
        }
      }
      return ids;
    }

    /** 三态：全在 = true，部分 = mixed，没有 = false。 */
    function groupState(ids) {
      if (ids.length === 0) return 'false';
      var picked = 0;
      for (var i = 0; i < ids.length; i += 1) {
        if (bulkState.selected[ids[i]] === true) picked += 1;
      }
      if (picked === 0) return 'false';
      return picked === ids.length ? 'true' : 'mixed';
    }

    /** 空 → 填满；半选或满 → 补齐/清空。和 dsh-delete-session 的 toggleGroup 一致：
     *  半选时再点应当是「补齐剩下那些」，而不是把已选的清掉（那需要连点两次才回到全选）。 */
    function toggleGroup(ids) {
      if (ids.length === 0) return;
      var state = groupState(ids);
      var fill = state !== 'true';
      for (var i = 0; i < ids.length; i += 1) {
        if (fill) bulkState.selected[ids[i]] = true;
        else delete bulkState.selected[ids[i]];
      }
      refreshGroupBoxes();
      scheduleBulkDecorate();
      bulkUpdateBar();
    }

    /**
     * 放一个全选框（幂等）。
     *
     * 只有位置真的不对时才动 DOM：每次 insertBefore 都是一次真实变异，列表 observer
     * 会把它当成变化，于是「装饰 → 变异 → 再装饰」每帧循环，框被反复摘除再插入，
     * 点击往往落在已摘除的瞬间 —— 表现就是要连点十几次才生效一次。
     */
    function placeGroupBox(host, extraClass, label, ids, anchor) {
      if (host === null || host === undefined) return;
      var box = typeof host.querySelector === 'function' ? host.querySelector('.' + SELECT_ALL_CLASS) : null;
      var created = box === null;
      if (created) {
        box = document.createElement('button');
        box.type = 'button';
        box.className = extraClass === undefined || extraClass === null || extraClass.length === 0
          ? SELECT_ALL_CLASS
          : SELECT_ALL_CLASS + ' ' + extraClass;
        box.setAttribute(OWN_ATTR, 'select-all');
        box.setAttribute('role', 'checkbox');
        box.addEventListener('click', function (event) {
          // 工作区行本身的 onClick 是折叠/展开：不拦就会顺带收起整组。
          if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation();
          if (event !== null && event !== undefined && typeof event.preventDefault === 'function') event.preventDefault();
          toggleGroup(box.__dshsmIds === undefined ? [] : box.__dshsmIds);
        });
      }
      // 锚点是逗号列表，逐个试：文档顺序命中可能挑到比调用方本意更靠后的兄弟。
      var before = null;
      var selectors = String(anchor === undefined || anchor === null ? '' : anchor).split(',');
      for (var i = 0; i < selectors.length; i += 1) {
        var found = typeof host.querySelector === 'function' ? host.querySelector(selectors[i].trim()) : null;
        if (found !== null && found !== undefined) { before = found; break; }
      }
      if (before !== null && before !== undefined) {
        var spacer = host.querySelector('.' + SPACER_CLASS);
        if (spacer === null || spacer === undefined) {
          spacer = document.createElement('span');
          spacer.className = SPACER_CLASS;
          spacer.setAttribute('aria-hidden', 'true');
          spacer.setAttribute(OWN_ATTR, 'spacer');
        }
        // 工作区的名字块是 flex:1，会把剩余宽度全吃掉，框插在它后面视觉上仍被推到行尾；
        // 补一条 flex:1 的 spacer 占住空间，位置才落在名字后面。
        var boxAt = childIndex(host, box);
        var spacerAt = childIndex(host, spacer);
        var beforeAt = childIndex(host, before);
        if (boxAt === -1 || spacerAt === -1 || beforeAt === -1
          || boxAt !== spacerAt - 1 || beforeAt !== spacerAt + 1) {
          host.insertBefore(spacer, before);
          host.insertBefore(box, spacer);
        }
      } else if (created) {
        host.appendChild(box);
      }

      box.__dshsmIds = ids;
      applyGroupBoxState(box, label);
    }

    /** 把一个框的三种状态写进去（✓ / − / 空）。 */
    function applyGroupBoxState(box, label) {
      if (box === null || box === undefined) return;
      var ids = box.__dshsmIds === undefined ? [] : box.__dshsmIds;
      var state = groupState(ids);
      var glyph = state === 'true' ? '\u2713' : (state === 'mixed' ? '\u2212' : '');
      if (box.textContent !== glyph) box.textContent = glyph;
      if (box.getAttribute('aria-checked') !== state) box.setAttribute('aria-checked', state);
      if (label !== undefined && label !== null && box.getAttribute('aria-label') !== label) box.setAttribute('aria-label', label);
    }

    /** 已经挂着的框就地刷新（点一下要**立刻**看到 ✓ / −，不等下一帧）。 */
    function refreshGroupBoxes() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      var boxes = document.querySelectorAll('.' + SELECT_ALL_CLASS);
      for (var i = 0; i < boxes.length; i += 1) applyGroupBoxState(boxes[i]);
    }

    /** 两个位置的总装饰（只在多选期间）。 */
    function decorateSelectAll(rows) {
      if (typeof document === 'undefined') return;
      var strings = text();
      var headings = typeof document.querySelectorAll === 'function' ? document.querySelectorAll(ALL_HEADER_SELECTOR) : [];
      if (headings !== null && headings.length > 0) {
        // 宿主每个组底部都有一行 `overflow:<ws>`（「收起」/「展开其余 N 个会话」）。
        // 它只说明「这里有个折叠开关」，不等于「有会话被藏起来」：组全展开时它
        // 照样在，写的是「收起」。所以不能拿它当「这一组选不全」的证据 ——
        // 之前就是这么判断的，结果两个框永远显示 −，30 个全勾也不打勾。
        // 框的状态只看 ids 全不全：全勾 = ✓。
        var every = everySessionId(rows);
        placeGroupBox(headings[0], 'dshsm-select-all-head', strings.selectAllWorkspaces, every, HEAD_ANCHOR);
      }
      var workspaceRows = typeof document.querySelectorAll === 'function' ? document.querySelectorAll(WORKSPACE_ROW_SELECTOR) : [];
      for (var i = 0; i < workspaceRows.length; i += 1) {
        var found = groupContainerOf(workspaceRows[i]);
        placeGroupBox(workspaceRows[i], '', strings.selectAllGroup,
          found === null ? [] : found.sessions, ROW_ANCHOR);
      }
    }

    /** 退出多选时立刻摘掉框和 spacer（不等下一帧：spacer 撑着，留一帧会看见行尾抖一下）。 */
    function removeSelectAll() {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
      var doomed = ['.' + SELECT_ALL_CLASS, '.' + SPACER_CLASS];
      for (var i = 0; i < doomed.length; i += 1) {
        var nodes = document.querySelectorAll(doomed[i]);
        for (var j = 0; j < nodes.length; j += 1) {
          if (nodes[j] !== null && nodes[j] !== undefined && typeof nodes[j].remove === 'function') nodes[j].remove();
        }
      }
    }

    /** 这个节点是不是本插件自己插进侧边栏的。 */
    function isOwnNode(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return false;
      return node.getAttribute(OWN_ATTR) !== null;
    }

    function allOwnNodes(list) {
      if (list === null || list === undefined || list.length === 0) return true;
      for (var i = 0; i < list.length; i += 1) {
        if (!isOwnNode(list[i])) return false;
      }
      return true;
    }

    function onRowMutations(records) {
      if (records === undefined || records === null) { scheduleBulkDecorate(); return; }
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        var added = record === null || record === undefined ? null : record.addedNodes;
        var removed = record === null || record === undefined ? null : record.removedNodes;
        var hasAdded = added !== null && added !== undefined && added.length > 0;
        var hasRemoved = removed !== null && removed !== undefined && removed.length > 0;
        if (!hasAdded && !hasRemoved) continue;
        // 自己插的框和 spacer 不是「再过一遍」的理由：把它们也算进来，
        // 每一轮都会给下一轮排程，框就在光标底下反复搬。
        if (allOwnNodes(added) && allOwnNodes(removed)) continue;
        scheduleBulkDecorate();
        return;
      }
    }

    function startBulkObserver() {
      if (typeof MutationObserver !== 'function') return;
      if (rowObserver !== null) return;
      rowObserver = new MutationObserver(onRowMutations);
      // 观察根是列表本身，不是 document：下面的正文每来一个 token 都会被唤醒一次。
      var list = typeof document.querySelector === 'function' ? document.querySelector(LIST_SELECTOR) : null;
      rowObserver.observe(list !== null && list !== undefined ? list : document.body, { childList: true, subtree: true });
    }

    function stopBulkObserver() {
      if (rowObserver === null) return;
      try { rowObserver.disconnect(); } catch (error) { /* ignore */ }
      rowObserver = null;
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
          check.setAttribute(OWN_ATTR, 'check');
          row.insertBefore(check, row.firstChild);
        }
        if (bulkState.selected[id] === true) check.classList.add(CHECK_ON_CLASS);
        else check.classList.remove(CHECK_ON_CLASS);
      }
      if (bulkState.selecting === true) decorateSelectAll(rows);
      else removeSelectAll();
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
      bulkState.text = text().bulkSelected.replace('{n}', String(count));
      bulkState.busy = false;
      if (bulkState.countNode !== null) bulkState.countNode.textContent = bulkState.text;
      if (bulkState.moveNode !== null) bulkState.moveNode.disabled = count === 0;
      bulkNotify();
      return count;
    }

    function buildBulkBar() {
      var strings = text();
      var bar = document.createElement('div');
      bar.className = 'dshsm-bar dshsm-bar-float ' + themeClass();
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
      bulkState.busy = true;
      bulkNotify();
      var run = typeof bulkState.moveSelectionFn === 'function' ? bulkState.moveSelectionFn : moveSelection;
      run(ids, {
        onProgress: function (done, total) {
          bulkState.text = strings.bulkProgress.replace('{d}', String(done)).replace('{t}', String(total));
          if (bulkState.countNode !== null) bulkState.countNode.textContent = bulkState.text;
          bulkNotify();
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
      refreshGroupBoxes();
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
      markSelecting(true);
      // 宿主有 sidebar.footer.action 就用它那根底栏（位置/宽度交给宿主排版）；没有才自绘浮动卡片。
      if (bulkSlotReady !== true) buildBulkBar();
      bulkUpdateBar();   // 初始化文案（已选 0 个）+ 通知订阅者重渲染
      document.addEventListener('click', onBulkRowClick, true);
      document.addEventListener('keydown', onBulkKeydown, true);
      // 宿主重渲染后勾选圈和全选框会消失且不会回来 —— 观察列表补一次装饰。
      startBulkObserver();
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
      bulkState.text = '';
      bulkState.busy = false;
      stopBulkObserver();
      removeSelectAll();
      markSelecting(false);
      bulkNotify();
      bulkDecorate();
    }

    // ── 多选底栏（宿主槽 sidebar.footer.action） ───────────────────────────────
    //
    // 不再自绘 position:fixed 的卡片：位置、宽度、和页脚其它按钮的关系都交给宿主排版，
    // 也就不会压住账户行、不会和别家页脚按钮互相顶。选择期间用 body 上的
    // dshsm-selecting 让用量胶囊/账户行/别家按钮让位（见上面三条样式）。

    /** 多选期间给 body 打标记（进出多选时切换）。 */
    function markSelecting(on) {
      if (typeof document === 'undefined' || document.body === undefined || document.body === null) return;
      var classes = document.body.classList;
      if (classes === undefined || classes === null || typeof classes.add !== 'function' || typeof classes.remove !== 'function') return;
      if (on === true) classes.add('dshsm-selecting');
      else classes.remove('dshsm-selecting');
    }

    function bulkSubscribe(listener) {
      bulkListeners.push(listener);
      return function () {
        var at = bulkListeners.indexOf(listener);
        if (at >= 0) bulkListeners.splice(at, 1);
      };
    }

    function bulkNotify() {
      for (var i = 0; i < bulkListeners.length; i += 1) {
        try { bulkListeners[i](); } catch (error) { /* 单个订阅者出错不影响别人 */ }
      }
    }

    /** 底栏渲染用的一份快照（每次 notify 重新取，保证是新对象）。 */
    function bulkSnapshot() {
      return {
        selecting: bulkState.selecting === true,
        count: bulkSelectedIds().length,
        text: typeof bulkState.text === 'string' ? bulkState.text : '',
        busy: bulkState.busy === true,
      };
    }

    function useBulkSnapshot() {
      var useState = typeof react.useState === 'function' ? react.useState : function (initial) { return [initial, function () {}]; };
      var useEffect = typeof react.useEffect === 'function' ? react.useEffect : function () {};
      var pair = useState(bulkSnapshot());
      useEffect(function () {
        return bulkSubscribe(function () { pair[1](bulkSnapshot()); });
      }, []);
      return pair[0];
    }

    /**
     * 多选底栏：注册进 sidebar.footer.action（list / scope root，宿主渲染在 footArea > footerActions）。
     * 槽位组件是**常驻**的，靠返回 null 表示「不存在」——不要用 display:none 的 DOM 当开关。
     */
    function BulkBar() {
      // 装了 dsh-delete-session 时走路径 A，它那根底栏负责一切；这里让位，否则页脚里并排两根。
      var skip = hostSupportsBulkMove();
      var snapshot = useBulkSnapshot();
      if (skip || snapshot.selecting !== true) return null;
      var strings = text();
      return react.createElement('div', { className: 'dshsm-bar', role: 'toolbar' }, [
        react.createElement('span', { className: 'dshsm-bar-count', key: 'count' }, snapshot.text),
        react.createElement('button', {
          key: 'cancel',
          type: 'button',
          className: 'dshsm-bar-btn',
          onClick: function (event) { if (event) event.stopPropagation(); exitBulk(); },
        }, strings.bulkCancel),
        react.createElement('button', {
          key: 'move',
          type: 'button',
          className: 'dshsm-bar-btn dshsm-bar-primary',
          disabled: snapshot.count === 0 || snapshot.busy === true,
          onClick: function (event) { if (event) event.stopPropagation(); bulkMoveSelected(); },
        }, strings.bulkMove),
      ]);
    }

    /** 菜单里的「多选」入口：宿主支持批量动作时让位给它那根底栏。 */
    function BulkEntry(props) {
      var useMenuOpenState = props !== null && props !== undefined ? props.useMenuOpenState : null;
      var menuState = null;
      if (typeof useMenuOpenState === 'function') {
        try { menuState = useMenuOpenState(); } catch (error) { menuState = null; }
      }
      if (hostSupportsBulkMove()) return null;
      var strings = text();
      var onSelect = function () {
        if (menuState !== null && Array.isArray(menuState) && typeof menuState[1] === 'function') {
          try { menuState[1](false); } catch (error) { /* ignore */ }
        }
        enterBulk();
      };
      // 宿主有 MenuItemButton 就走它：行高、hover、左图标列都由宿主排版，
      // 图标才和「置顶 / 分叉 / 移动到」那几行对齐。没有基座时退回自绘按钮。
      if (primitives !== null && primitives !== undefined && primitives.MenuItemButton !== undefined) {
        return react.createElement(primitives.MenuItemButton, {
          icon: menuGlyph(SELECT_PATHS),
          onSelect: onSelect,
        }, strings.bulk);
      }
      return button('bulk', strings.bulk, { onClick: onSelect });
    }

    /**
     * 需要的服务。
     *
     * `contextMenus` 必须**声明**在这里，不能靠 ctx.get 探测 ——
     * 官方的 dsh-client-ui-open-in-app 就是把它写进 inject 再直接 ctx.contextMenus.register()。
     * 探测是不可靠的：服务什么时候就绪取决于插件加载顺序，同一份代码会出现
     * 「一次拿到、一次拿不到」的抖动，菜单形态也就随机退化。
     */
    var inject = ['slots', 'contextMenus'];

    function apply(ctx) {
      ensureStyles();
      // uiWorkspace 是**服务**不是模块：ctx.get 是可选查找，不需要在 inject 里声明，
      // 所以拿它不需要宿主重启。拿不到就退回手输路径。
      try {
        var workspaceService = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
        uiWorkspaceService = workspaceService !== null && workspaceService !== undefined && typeof workspaceService === 'object' ? workspaceService : null;
      } catch (error) {
        uiWorkspaceService = null;
      }
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
            // 自己的子槽：别的插件（如 dsh-preset-workbench 的预设胶囊）注册进来，
            // 就会落在工作区 chip 的右边，和官方 hero 那一排 [工作区] [预设] 一致。
            children: { 'session-relocate.dock': { kind: 'list', scope: 'session' } },
          }, WorkspaceDockChip);
        }));
      }
      // 多选底栏：宿主有 sidebar.footer.action 就注册进去（位置/宽度交给宿主排版），
      // 没有（老宿主）就退回自绘浮动卡片。order 40：dsh-delete-session 用的是 30。
      if (typeof ctx.slots.inject === 'function') {
        disposers.push(ctx.slots.inject('sidebar.footer.action', function () {
          bulkSlotReady = true;
          return ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'session-relocate-bulkbar', order: 40 },
            BulkBar,
          );
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
      // 右键菜单里的「移动到」：注册成 contextMenus 的 target=session 贡献项 ——
      // 和官方「在应用中打开」同一个位置、同样的子菜单形态（children 交给官方 Menu 渲染）。
      // 左键「…」那个菜单是另一套组件（见下一个 inject），两边都要有，用户点哪个都能用。
      // 右键菜单里的「移动到」：ctx.contextMenus 来自 inject 声明，服务就绪后 apply 才会跑，
      // 所以这里不需要任何探测 / 兜底。
      if (typeof ctx.effect === 'function') {
        ctx.effect(function () {
          // 右键菜单按 action.icon.key 去 contextMenu.icon 槽里查图标；
          // 不注册这条，行首就是空的（官方的「在应用中打开」也各自注册了自己的 key）。
          var iconDisposer = null;
          if (typeof ctx.slots.inject === 'function') {
            iconDisposer = ctx.slots.inject('contextMenu.icon', function () {
              return ctx.slots.register({ name: 'contextMenu.icon', key: CONTEXT_ICON_KEY }, MoveContextIcon);
            });
          }
          var menuDisposer = ctx.contextMenus.register({
            id: 'session-relocate.move-out-menu',
            target: 'session',
            // 550：排在官方「在应用中打开」(500) 之后、「归档」(600，本来就进 footer) 之前。
            // 别用 350 —— 那样会排到「复制 Session ID」(450) 上面，整个位置就跑到菜单最前了。
            order: 550,
            observe: function () { return []; },
            resolve: function (value, signal) {
              var sessionId = value !== null && value !== undefined && typeof value.sessionId === 'string' ? value.sessionId : null;
              if (sessionId === null || sessionId.length === 0) return [];
              return post('/describe', { sessionId: sessionId }).then(function (result) {
                if (signal !== null && signal !== undefined && typeof signal.aborted === 'boolean' && signal.aborted === true) return [];
                if (result === null || result === undefined || result.ok !== true) return [];
                var strings = text();
                var canMove = result.session !== null && result.session !== undefined && result.session.canMove === false ? false : true;
                if (canMove === false) {
                  // 官方 Menu 的条目只投影 disabled，不投影 disabledReason，
                  // 所以这里只能给一行置灰的「移动到」，原因交给左键那条面板（那里有完整文案）。
                  return [{ id: 'move-out', label: strings.open, icon: { key: CONTEXT_ICON_KEY }, disabled: true }];
                }
                var actions = moveTargetActions(result, strings);
                if (actions.length === 0) return [];
                return [{
                  id: 'move-out',
                  label: strings.open,
                  icon: { key: CONTEXT_ICON_KEY },
                  children: actions.map(function (action) {
                    return {
                      id: action.id,
                      label: action.label,
                      run: function () { runMenuAction(sessionId, action); },
                    };
                  }),
                }];
              }, function () { return []; });
            },
          });
          return function () {
            if (typeof menuDisposer === 'function') {
              try { menuDisposer(); } catch (error) { /* ignore */ }
            }
            if (typeof iconDisposer === 'function') {
              try { iconDisposer(); } catch (error) { /* ignore */ }
            }
            return undefined;
          };
        }, 'dsh-session-relocate: context menu');
      }

      disposers.push(ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
        var items = [];
        // 「多选」入口：dsh-delete-session 支持批量动作时该组件渲染 null（入口交给它那根底栏）。
        items.push(ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'session-relocate-bulk', order: 351 },
          BulkEntry,
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
    exports.__ui = { pageIsDark: pageIsDark, themeClass: themeClass, css: function () { return CSS; } };
    exports.__settings = {
      ChildrenSetting: ChildrenSetting,
      wantChildren: wantChildren,
      setWantChildren: setWantChildren,
      chipMode: chipMode,
      setChipMode: setChipMode,
    };
    exports.inject = inject;
    exports.__bulkEntry = BulkEntry;
    // 给测试用的内部入口（浏览器里没人用）。
    exports.__bulk = {
      moveSelection: moveSelection,
      runBulkMove: runBulkMove,
      pickBulkTarget: pickBulkTarget,
      planTargetsWith: planTargetsWith,
      hostSupportsBulkMove: hostSupportsBulkMove,
      BulkBar: BulkBar,
      bulkSnapshot: bulkSnapshot,
      bulkUpdateBar: bulkUpdateBar,
      markSelecting: markSelecting,
      pickDirectoryNative: pickDirectoryNative,
      hasNativeDirectoryPicker: hasNativeDirectoryPicker,
      slotReady: function () { return bulkSlotReady; },
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
      ungroupedGroupOf: ungroupedGroupOf,
      workspaceIdOf: workspaceIdOf,
      scrollStepFor: scrollStepFor,
      findScrollableAncestor: findScrollableAncestor,
      autoScrollTick: autoScrollTick,
      detachByDrag: detachByDrag,
    };
    return module.exports;
  },
});
