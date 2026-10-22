# 多选底栏：占领宿主的页脚槽位

给 `dsh-session-relocate` 的改动说明。**只影响「只装了 relocate」那条路（路径 B）**；装了 `dsh-delete-session` 时走路径 A，本说明不适用。

`dsh-delete-session` 已经按这套做法改完并上线，两边形态一致。

## 一句话

不再自己造一根 `position:fixed` 的底栏，而是把「已选 N 个 / 取消 / 移动」渲染进宿主的官方槽位 `sidebar.footer.action`；选择期间用一个 body 标记让页脚的其他内容让位。

## 为什么

自绘底栏有两个问题：

1. **位置靠猜**：只能 `left:12px;bottom:12px` 贴一个大概位置，永远和宿主页脚差几像素，还压在账户行上面。
2. **和别的插件打架**：宿主的页脚本来就有别人的按钮（`dsh-update`、`remote-bridge`、`remote-web-ui`、用量胶囊），自绘底栏盖上去之后，要么挡着它们，要么被它们顶开。

槽位是宿主自己的排版契约，位置、宽度、上下文都是它算好的。

## 真实 DOM（DSH 0.2.1-rc.2，实测）

```html
<div class="hHd-Xa_footArea">
  <div class="hHd-Xa_footerActions">
    <div data-slot="sidebar.footer.action" style="display: contents;">
      <button class="WYT-ka_trigger" data-dsh-plugin="update" ...>        <!-- dsh-update -->
      <button class="sd7VOG_trigger" data-dsh-plugin="remote-bridge" ...>  <!-- 配对手机 -->
      <div class="fThDlQ_entryRow" data-rail="rail">                       <!-- remote-web-ui -->
        <button class="fThDlQ_trigger" aria-label="远程访问">...</button>
      </div>
      <div data-slot-error="sidebar.footer.action"></div>                  <!-- 崩溃占位符 -->
    </div>
  </div>
  <div data-dsh-usage-foot-card>…用量胶囊…</div>
  <div class="hHd-Xa_settingsArea">
    <div data-slot="sidebar.settings" style="display: contents;">…账户行…</div>
  </div>
</div>
```

两个关键事实：

- **槽位容器是 `display: contents`**：它的子元素在布局上直接参与 `footerActions` 的 flex 排版，但在 CSS 选择器上仍然是它的子元素。这一点决定了下面第 3 条怎么写。
- **CSS module 类名带哈希前缀**（`hHd-Xa_footArea`），不同版本可能变；但 `data-slot` / `data-dsh-plugin` / `data-slot-error` 是宿主自己的契约，稳定。

## 改动

### 1. 组件注册进槽位

```js
disposers.push(ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
  { name: 'sidebar.footer.action', id: 'dsh-session-relocate-bulkbar', order: 40, locale: NS },
  BulkBar,
)))
```

- `order` 用 40，`dsh-delete-session` 用的是 30。
- 加 `locale: NS`，宿主才会把 `t` 注入进来。

### 2. 组件：不在多选时返回 `null`

```js
function BulkBar(props) {
  // 装了 dsh-delete-session 时走路径 A，它那根底栏负责一切；这里必须让位，
  // 否则两个插件会各渲染一根，页脚里并排两根。
  if (hostSupportsBulkMove()) return null
  if (bulkState.selecting !== true) return null
  ...
}
```

第二条尤其重要：槽位组件是**常驻**的，靠返回 `null` 来「不存在」。别用 `display:none` 的 DOM 元素当开关。

### 3. 让位规则（这是唯一涉及宿主 DOM 的地方）

进入多选时给 `<body>` 加一个标记类，离开时去掉：

```js
function markSelecting(on) {
  var classes = document.body.classList
  if (on) classes.add('dshsm-selecting')
  else classes.remove('dshsm-selecting')
}
```

配三条样式（**照抄，别改写成排除式**，理由见第 4 条）：

```css
/* 用量胶囊 + 账户行让位，只留 footerActions 这一块 */
body.dshsm-selecting [class*="_footArea"] > *:not([class*="_footerActions"]){display:none}

/* 别家插件的页脚按钮让位 */
body.dshsm-selecting [data-slot="sidebar.footer.action"] > [data-dsh-plugin]{display:none}

/* entryRow 那个容器不带 data-dsh-plugin，单独点名 */
body.dshsm-selecting [data-slot="sidebar.footer.action"] > [class*="_entryRow"]{display:none}
```

### 4. 千万不要用「除了我全隐藏」的选择器

这是我在 `dsh-delete-session` 上连续踩了三轮、每次都让底栏整个消失的坑。三个失败的写法：

```css
/* ❌ 全部失败：底栏连同「取消」一起消失 */
[class*="_footerActions"] > *:not(.my-bar){display:none}
[class*="_footerActions"] > *:not(:has(.my-bar)){display:none}
[data-slot="sidebar.footer.action"] > *:not(.my-bar){display:none}
```

原因：槽位容器是 `display: contents`，中间的层级关系不直观；实测「除了我的类名之外」这种写法会命中槽位容器本身，把里面的所有东西（包括自己）一起藏掉。

**只用正面选择器点名别人**（`[data-dsh-plugin]`、`[class*="_entryRow"]`），永远不写「除了我」。

### 5. 按钮不许被压扁

底栏是 flex 行，计数会占满剩余宽度；进度文案一长（「正在移动 0/2…」），按钮会被挤成两个字宽然后换行：

```css
.dshsm-bar{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:6px 8px;box-sizing:border-box;font-size:13px}
.dshsm-bar-count{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,inherit)}
.dshsm-bar-btn{flex:0 0 auto;white-space:nowrap;appearance:none;min-height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));background:var(--dsw-alias-fill-elevated,rgba(128,128,128,.08));color:var(--dsw-alias-label-primary,inherit);border-radius:8px;font-size:13px;cursor:pointer}
.dshsm-bar-btn:disabled{opacity:.5;cursor:default}
.dshsm-bar-primary{border-color:#4c8dff;background:#4c8dff;color:#fff}
```

计数让路（省略号），按钮保持原宽。

### 6. 绝不把参数交给宿主的 `t`

**这是导致底栏整个消失的真正原因**，比 CSS 严重得多。

`dsh-client-locale` 的 `translate(ns, key, params)` 只要拿到 params，就会对取到的词条调 `template.replace(...)`。而这类插件的字典里，参数化词条基本都是**函数**：

```js
selectedCount: (n) => `已选 ${n} 个`,
```

于是宿主对着函数调 `.replace` → `TypeError: template.replace is not a function` → 槽位边界捕获 → 渲染成 `<div data-slot-error="sidebar.footer.action">` → **底栏整根消失，取消也点不到**。

而不带 params 调用也不行：宿主（以及很多自绘的 `t`）会用**零参数**执行函数词条，得到「已选 undefined 个」。

正确做法：**自己查字典、自己插值**，宿主只用来兜底本插件没有的 key。

```js
function translate(key, a, b) {
  var local = (lang() === 'en' ? en : zh)[key]
  if (local !== undefined) {
    if (typeof local === 'function') return local(a, b)
    if (typeof local === 'string' && local.indexOf('{') >= 0 && a !== undefined) {
      var params = (a !== null && typeof a === 'object') ? a : { n: a, done: a, total: b, ok: a, fail: b }
      return local.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] === undefined ? match : String(params[name])
      })
    }
    return local
  }
  var value = hostTranslate(key)          // 只对没有的 key 用宿主
  return typeof value === 'function' ? value(a, b) : (value == null ? key : value)
}
```

## 排障口令

页脚里看到空 div：

```html
<div data-slot-error="sidebar.footer.action"></div>
```

**立刻判定「某个槽位项在渲染时抛异常了」**，去浏览器控制台找 `slot entry crashed in 'sidebar.footer.action':` 后面的错误。此时调 CSS 是白费功夫——DOM 里根本没有你的节点。

## 测试要点

1. **桩里的 `t` 必须和真实宿主一致**：函数词条**原样返回**，不要代执行。代执行会把上面第 6 条的 bug 完全掩盖掉。
2. 加一条「严格宿主」测试，模拟真实插值：

```js
const strict = function (key, params) {
  var value = dict[key]
  if (value === undefined) return key
  if (params === undefined) return value
  return value.replace(/\{(\w+)\}/g, function (m, name) {
    return (params && name in params) ? String(params[name]) : m
  })
}
// 用 strict 渲染底栏组件，断言它不抛、并且计数文案正确
```

3. 断言样式里**没有**排除式选择器（`> *:not(`），防止以后又写回去。
4. 断言按钮规则带 `flex:0 0 auto` 和 `white-space:nowrap`。

## 回退

槽位不存在（老版本宿主）时，保留现有的自绘底栏路径：进多选先探测 `ctx.get('slots')` 与页面里有没有 `[data-slot="sidebar.footer.action"]`，没有就退回原 `dshsm-bar` 浮动卡片。两条路只走一条，别同时挂。

## 验收

- 只装 relocate：进入多选，页脚只剩一行（计数 + 取消 + 移动），用量胶囊、账户行、别家按钮全部让位；退出后全部回来
- 移动过程中：按钮不换行、不被压扁，计数过长时省略
- 两个都装：行为与现在完全一致（路径 A 不变），且**只有一根底栏**
- 侧边栏收起 / 展开、窗口缩放：形态稳定（槽位由宿主排版，无需自己重算）
