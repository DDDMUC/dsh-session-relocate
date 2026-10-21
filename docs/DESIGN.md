# 设计依据：DSH 会话存储与工作区归属

这份笔记记录**已核实**的内部约定（都读过实现、并在真实数据上验证过）。改动这个插件之前
请先读它 —— 这里的每一条都是踩点结论，不是推测。

## 存储布局

~~~text
~/.dsh/
  sessions/
    --E-E-DSH--/                      # 项目目录 = projectKey(cwd)
      session-<uuid>/                 # 会话目录 = encodeSegment(sessionId)
        session.jsonl.zstd            # v0 generation（如果迁移过格式就还在）
        session.v4.jsonl.zstd         # 当前 generation
        session.lock                  # 写租约（flock）
    _no-cwd/                          # 没有 cwd 的会话
  storages/
    workspace.json                    # 工作区注册表（domain 表）
    session_projcache/
      sessions/<sessionId>.json       # 投影缓存，identity.cwd 也在这儿
  session-move/                       # 本插件的迁移日志
~~~

### projectKey（对照实现 `dsh-session-persistence-jsonl/lib/index.js`）

- `/`、`\`、`:` → `-`，**连续分隔符折叠成一个**；
- 除 `~` 外的 `[A-Za-z0-9._-]` 原样保留；
- 其余码元 → `~` + UTF-16 码元的十六进制（大写，补到 4 位）；
- 两端包 `--`，整体只**剥前导** `-`，再截断到 251 字符。

已验证（下面的期望值按上面规则手推，不是把函数跑一遍抄回来）：

~~~text
D:\示例\A            -> --D-~793A~4F8B-A--
E:\工作\AI\甲        -> --E-~5DE5~4F5C-AI-~7532--
E:/work/ws          -> --E-work-ws--     （连续分隔符折叠）
C:\                 -> --C---           （只剥前导，所以尾部留下分隔符）
~~~

### encodeSegment

只有整个段恰好是 `.` / `..` 才特殊处理（`~002E` / `~002E~002E`）；
段内的 `.` 是安全字符，保持原样。会话 id 形如 `session-<uuid>`，字符全安全，通常原样。

## header

每个 generation 文件的第一行（也是第一个 Zstandard 帧的开头）：

~~~json
{"type":"session","version":4,"id":"session-...","createdAt":1791369275769,
 "cwd":"D:\\示例\\A","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
~~~

`version` 必须等于文件名里的版本号；`cwd` 必须是绝对路径。

## 后端读路径的两条硬约束

1. `assertStoredIdentity`：`generationLogPath(root, header.cwd, id, version)` 必须
   等于被选中的物理路径（或经 `sameFile` 同源），否则报 **`corrupt session log`**。
   → **header 的 cwd 与物理位置必须一致。**
2. `findLog(id)` 会遍历所有项目目录；命中超过一个就抛
   `duplicate JSONL session id`。
   → **绝不能出现同 id 双目录。**

另外 `open(id)` 是按 id 全库扫描的（不靠 cwd），所以搬目录本身不会让会话找不到。

## 工作区归属

`~/.dsh/storages/workspace.json`：

~~~json
{ "global": { "workspaceIds": ["..."], "archivedSessionIds": [], "pinnedSessionIds": [] },
  "tables": { "workspaces": { "<workspaceId>": { "path": "...", "title": "...",
               "sessionIds": ["..."], "createdAt": "...", "updatedAt": "..." } } } }
~~~

- `Workspace.sessionIds` 的 getter 会**按 `host.sessionPath(id) === record.path` 过滤**
  —— 归属是「注册表登记」**且**「header cwd 规范化后等于 workspace.path」。
- `Workspace.attachSession(id)`：读 header → `realpathNormalize(header.cwd)` → 必须
  等于 `record.path`，然后把 id 插到 `sessionIds` 最前面。
- `Workspace.detachSession(id)`：只从 `sessionIds` 里摘掉，**从不碰日志文件**。
- `WorkspaceRegistry.readSessionHeader(id)` 的取值顺序：
  1. `ctx.sessions.get(id)`（**内存里的活会话**）—— 它的 header 是 deep-frozen 的，
     所以「就地接管」这条路**必须绕开 attachSession**（见后文 B 节）
  2. 注册表启动时建的 header 缓存
  3. 都没有才重新 `sessionPersistence.list()`

  第 2 条是关键：磁盘改完不刷新缓存，`attachSession` 会拿旧的 cwd 去比目标 path 然后拒绝。
  因此本插件在 attach 前调用私有的 `replaceHeaderIndex(listStoredHeaders())`（feature-detect，
  拿不到就降级为「下次启动补齐归属」）。

**already-there 的判定**：目录相同（`cwd == target.path`）**不等于**已在目标工作区 —— DSH 的分组
依据是 `workspace.json` 的 `sessionIds`。目录在、归属不在（孤儿/未分组）时，`relocateSession` 走
`attachExisting`：优先 `host.adoptSession`，老宿主退回 `adoptSessions + detachSessions`，补写归属后
返回 `applied: "attached"`，不动文件、不写迁移日志。`/describe` 的 `currentWorkspaceId` 也**只认归属**，
并额外返回 `memberOfWorkspaceId` / `cwdMatchesWorkspaceId`，避免 UI 把孤儿会话当成「已在目标工作区」
而不给补归属的入口。

## Zstandard 容器

- 日志是**一串彼此独立的 Zstandard 帧**：第一帧**恰好只有 header 一行**，后续每批一帧。
- 压缩参数：`{ params: { [constants.ZSTD_c_checksumFlag]: 1 } }`（带校验和）。
- **第一帧必须恰好是 header 一行**（唯一的换行在末尾）—— 这是 DSH 的硬约束
  （`assertIndependentHeaderFrame`：`plaintext.indexOf(10) === plaintext.length - 1`）。
  违反它会得到 `corrupt Zstandard session log: first frame is not exactly one header line`。
  本插件的 `replaceFirstLine` 保留 `plain.subarray(nl)`（即那个换行），所以改写后仍恰好一行；
  `test/zstd.test.js` 在**真实日志**上断言改写前后这条不变量都成立。
- 帧的结构扫描（`scanZstdFrames`）只读帧头与块头、不解压；被本插件移植过来，用来
  **只重编第一帧**、其余字节原样保留（连尾部未写完的 torn 帧都不碰）。

## 释放一个「活着的」会话（本插件的关键缝）

写所有权的事实链（都在源码里核过）：

- `dsh-agent-loop` 是会话写句柄的**生产环境获取点**：它调 `persistence.open(id,'write')`
  （新建时走 `persistence.create(header)`），拿到句柄就等于持有 `session.lock` 租约。
- 后端的 tracker 把写句柄登记在 `this.writers` 里
  （`if (handle.access === "write") this.writers.set(handle.id, handle)`）。
- `SessionStore.enter()` 给每个条目挂了 `detach()`；`detachEntered()` 做
  `store.delete(id)` + `attachments.delete(session)` + 派发 `session/disposed`。
- 后端监听 `session/disposed`：`this.writers.get(id).close()` —— 这一 close 就释放了租约。
  注意它是 **fire-and-forget（没有 await）**，所以必须用探针确认，不能假设它已完成。
- 探针 = 反复 `sessionPersistence.open(id, 'write')`：能拿到就证明没有活跃写者，立刻 close 归还。
  同一个 DSH 版本里 `dsh-delete-session` 用的就是这个办法（200ms × 12）。
- 官方**没有**公开的「关闭会话 / 释放所有权」入口；这条缝是 `sessions.store` 上的包私有成员，
  所以本插件 feature-detect，并且**释放失败就整体放弃、不碰任何文件**。

边界：**跑着活的绝不释放**（turn / job / subagent / schedule 任一存在就拒绝）。释放一个正在写日志的
会话是危险的；释放一个只是驻留在内存里的空闲会话是安全的。这是本插件与生态里其它迁移插件的
关键差别 —— 它们要么直接拒绝活跃会话（zhengjy01 / limo13 / hucj09），要么排队等 DSH 重启
（TOBYCAI/dsh-sessions-manager 的 pending-moves 队列）。

## B. 就地接管：正在跑的会话怎么搬

**为什么 attachSession 不行**：它读 header 时优先取内存里的活会话，而活会话的 header 被
`validateSessionHeader` 末尾的 `return deepFreeze(record)` 冻住了 —— cwd 改不了，
校验必然失败。所以接管这条路要绕开它，直接走注册表自己的写路径。

**为什么写句柄可以就地改**（四条源码事实）：

1. 写入路径是**每次现算**的：
   `persistContiguous → storage.persistBatch(this.header, …) → logPath(root, meta.cwd, meta.id)`
   —— 所以换掉句柄手上的 header，后续写入就落到新目录。
2. header 对象虽然被 deepFreeze，但 `JsonlSessionHandle` 的构造是 `this.header = header;`
   —— **槽位可写**：`handle.header = { ...header, cwd: 目标 }` 合法。
3. 内核写锁懒获取：`ensureLease() { this.lease ??= await acquireWriteLease(this.header) }`
   —— 释放并置空后，下一次写入会在**新路径**重取。
   锁的形态：**Windows 是由路径派生的命名内核信号量，没有锁文件**；POSIX 才是
   `<sessionDir>/session.lock`（flock）。两者都与路径绑定，所以「释放→重取」是必需且正确的。
4. 串行点只有一个：`enqueueChain(op) { const next = this.chain.then(op); this.chain = next.catch(() => {}) }`
   —— `append` / `flush` / `drainBuffered` 全部走它。
   **注意 `drainLive()` 自己会往 chain 上排队**，所以在临界区里调它必然死锁；
   必须在进入临界区**之前**调用。

**写句柄在哪**：`ctx.sessionPersistence.tracker.writers`（`JsonlBackendTracker` 上），
**不在持久化服务本身**。这里踩过一次坑：第一版查了 `persistence.writers`，取到 undefined，
于是走了「没有写句柄」的早退分支 —— 文件搬走了、句柄还指着旧路径，**下一次真实写入就会把旧目录
重建出来**。是隔离实例的活体验证抓到的（回执写着 `handedOff: true`，但探针显示
`headerCwd` 还是旧路径、锁还拿着）。现在改成：**取不到写句柄就整体放弃**
（`handoff-failed`），绝不静默搬。

**归属旁路**：`entity.mutate` 内部会用 `host.sessionPath(id)` 过滤 `sessionIds`，
所以必须**先**把 `registry.sessionPaths` 指到新 cwd，再 mutate；顺序反了，刚加进去的 id 会被
它自己滤掉。

**语义边界（诚实说明）**：接管让**文件与归属**立刻搬走、且不打断那一轮回答，但活会话在内存里的
header 是冻的，所以**那一轮的工具仍然用旧目录**；下次打开才真正在新目录里跑。

## 客户端扩展点

- 会话行「…」菜单 = `sidebar.workspaces.session.menu.item`，`kind: 'list'`，按
  `order` 排序（官方 pin=100 / rename=200 / fork=300 / archive=400，本插件 350）。
- 每项渲染一个 `role="menuitem"` 的 `<button>`；菜单的键盘遍历**读 DOM**，
  所以自绘按钮也会被正常纳入。owner props：`{ sessionId, displayTitle }`，外加
  `useMenuOpenState` hook。
- 客户端 bundle 形态是 lazy-CJS：`window.__ModuleLoader__.load({ id, factory })`，
  只有 `react` 是基座模块；`require` 走平台表。因此不需要打包器。
- 桥接前缀由主机侧通过 `webserver/index-inject` 事件的 `{ kind: 'global' }` 行下发，
  客户端读 `globalThis.__DSH_SESSION_RELOCATE__`。

## 拖动搬移：官方 DOM 契约与让路规则

官方侧边栏给每一行都渲染了稳定的行属性，并且**把每个工作区渲染成一个分组容器**
（都在 `dsh-client-ui-workspace/lib/client.js` 里）：

| 东西 | 契约 | 出处 |
| --- | --- | --- |
| 会话行 | `data-row-key="session:<sessionId>"` | 2250 |
| 工作区行 | `data-row-key="workspace:<workspaceId>"`（key 就是 workspaceId，见 1058） | 1945 |
| 工作区分组 | `renderGroup` 把「文件夹行 + 它的会话行」放进同一个 `div.groupSection` | 3097–3141 |

拖动搬移**只读这些东西**，不读未公开的拖拽载荷（`dataTransfer` 在 dragover 阶段本来就取不到数据）。

**投放目标 = 整块分组，而不是那 34px 的文件夹行。** 判定方式是「指针向上找到最近的、**恰好只含一个
工作区行**的祖先」：

- 指针在文件夹行上 → 向上走到它自己那个 `groupSection`；
- 指针在它下面任意一条会话行 / 「展开其余 N 个会话」/ 分组空隙上 → 走到同一个 `groupSection`；
- 再往上（`role="tree"` 的整棵列表）含多个工作区行 → 说明指针不在任何分组里，直接不介入。

**让路规则（关键）**：拿到的分组如果是**它自己所在**的那个，就完全不介入 —— 官方的组内排序
（`commitSessionDrag → setSessionOrder(accountKey, …)`，accountKey 就是源工作区）一点没被抢；
指针在**别的**分组里时才接管并搬过去。源工作区**先从 DOM 同步读**（拖起来的那一行就在自己分组里），
读不到才回落到 `/describe` —— 这样「立刻把指针挪到自己分组里」也不会误接管。
投放时 `stopPropagation()` 吃掉事件，避免官方在同一事件上再处理一次。

**多选拖动**：dragstart 时读当前选中集合 —— 本插件的多选读 `bulkState`；`dsh-delete-session`
的多选读它给选中行挂的 `.dsdel-check-on`（只读它的 DOM，不动它的状态）。拖的会话在选中集合里且
不止一条时，投放走 `runBulkMove`（逐条 defer + 一次 commit），完成后发一个 `Escape` 让宿主收起
多选；拖一条没被选中的行仍按单条搬。

**目标预分类**：打开目标面板时不隐藏任何工作区，而是按选中会话当前的 DOM 归属，给每一项算出
「将移动 M / 跳过 K」；M=0 的项置灰、不绑点击 —— 省掉纯 no-op 的 N 次请求，又不会在多选跨工作区时
误删合法目标（例如 A 里 2 条、B 里 1 条，选 A 是合法的：搬 B 的 1 条、跳过 A 的 2 条）。

**composer 常驻 chip**：官方只在 hero 里渲染 workspace chip；插件把 chip 插进
`[data-composer-seat]` 的第一个子节点（该座位是 flex 列，高度被 ResizeObserver 记进
`--dsh-composer-height`，不会压住消息）。会话从侧栏 `[data-row-key^="session:"][aria-selected="true"]`
认，工作区名从对应 `[data-row-key="workspace:<id>"]` 的文本读；hero 页检测
`[class*="heroWorkspaceRow"]` 后隐藏，避免两条。点 chip → `/describe` → 选目标 → `/move`。
全部是 DOM 约定，找不到就隐藏（降级不报错）。

**连同子对话**：主机在搬完一条会话后，用 `sessionPersistence.list()` 的 header 关系找
`origin === 'subagent' && parentSession === 本会话` 的后代（递归到孙），逐条走完整的
`relocateSession`（文件 + 归属），`already-there` 记为跳过、其余失败按条隔离。开关在插件设置页
（`plugins.row.config` 槽），值存 localStorage，**默认开**；关掉时客户端在 `/move` 里显式传
`includeChildren: false`，主机就不找子会话。不搬子对话不会破坏父对话（子代理的产出事件本来就在
父日志里），但子会话的日志/`cwd`/归属会留在旧工作区 —— 旧目录被删就一起没了。

失效降级（分级，绝不错猜）：分组结构读不到 → 退化成「只认文件夹行」（更早版本的老行为）；
连行属性也读不到 → 完全不介入（不会误伤官方拖动）。菜单那条路始终可用；
`config.dragMove = false` 让客户端根本不挂这些监听。

### 这条链路的验证是分层的

1. **单测**（`test/client.test.js`）：假 DOM（含 `role="tree"` → `groupSection` → wrapper → 行的真实层次）
   + 假事件，覆盖：拖到**别的分组里的会话行**上接管并高亮整块分组、拖到**自己分组**里的会话行/文件夹行上让路、
   指针落在整棵列表上不介入、源工作区从 DOM 同步读出、分组结构读不到时退化成老行为、
   没有 dragstart 时不动作、失败时把服务端的话原样弹出来；
2. **真浏览器**（`scripts/drag-verify.mjs`，CDP 驱动 headless Chrome，不需要装任何包）：
   证明客户端半真的在页面里跑过（`apply()` 注入的 style 标签）、引导全局带上了 `drag: true`、
   **真实工作区行**确实是 `data-row-key="workspace:<id>"`（实测 2 行），然后合成真实的
   HTML5 拖放事件，断言 dragover 被接管并高亮、drop 被接管、**会话真的落到了目标工作区**。

诚实说明第 2 步的缺口：隔离 home 里造不出「DSH 自己创建、且有真实消息」的会话（那需要真跑一轮
模型），而侧边栏不渲染空会话 —— 所以**会话行**那条属性是由官方源码（2250）＋同一次渲染里的
工作区行实测共同背书的；实测时按该属性注入一行来跑通处理链路。

3. **真机**（`scripts/drag-live-check.mjs`）：直接连到**正在运行的 DSH**（例如 3080），在**真实侧边栏**上
   把第 2 步那个缺口补掉 —— 在真实 DOM 上验**分组契约**（每个工作区行都能找到自己那个「恰好只含一个
   工作区行」的容器，且那个容器不是 `role="tree"` 的整棵列表），然后在真实分组容器里合成
   `dragstart` → `dragover`，断言：别的分组里的会话行被接管 + 整块目标分组高亮 + 落在自己分组里完全让路
   （这条在 dragstart 之后**立刻**发，所以它同时证明源工作区是 DOM 同步读出来的，没有等网络）。
   它**只合成事件、绝不投放**（不 drop），所以永远不会搬动任何会话；token 从 `~/.dsh/dsh-web-auth.log` 读。
   侧边栏没渲染真实会话行时（全新 home / 还没列会话），它会在**真实分组容器里**补一条按官方属性构造的行 ——
   分组容器、事件路径、插件逻辑都是真的，只有那条会话行是造的。（本仓库不放真机截图。）

## 怎么验证（真实 DSH，不动你的数据）

单元测试覆盖纯逻辑与事务；此外在临时 `DSH_HOME` 里（只加载 `dsh-base + dsh-web-app + 本插件`）
起一个隔离实例，跑两种真实验证：

**A. 普通迁移（`seed` → `verify`）**

1. 在临时 home 里预置一个会话日志（header cwd 指向 `ws-src`，第一帧恰好一行 header）；
2. 启动 —— DSH 会**自己**按会话 header bootstrap 出 ws-src 工作区；
3. `/describe` 确认 `canMove: true`、`currentWorkspaceId` 指向 ws-src → `/move { targetPath: ws-dst }`；
4. 再调 `/describe`：它内部会让 **DSH 自己的解码器**重新读改写后的日志，读得通就说明头部
   外科手术确实产出了 DSH 认的文件；同时校验 `workspace.json` 的归属、源目录已删、日志/暂存已清空。

**B. 就地接管（`live`）—— 验证「正在跑的会话也能搬」**

1. `POST __selftest/create-live { workspacePath, pressure: true }`：按 agent-loop 的真实顺序
   `persistence.create(header)`（物化日志 + 持有写租约）→ `sessions.create(...)`（发布成 live）
   → `attachSession`；然后起一个**写入压力循环**，每 4ms 往该句柄的写链上排一个链接
   （等价于「正在回答的 turn 不断产生写入」）。返回 `live: true, leaseHeld: true, pressure: true`；
2. `/describe` 应当给出 `live: true, willHandoff: true, canMove: true`；
3. `/move` 应当返回 `applied: 'live', released: false, handedOff: true, handoffWriter: true`；
4. `__selftest/state` 取观察窗，断言：
   - 压力采样 ≥ 40 次，而**插进接管窗口的必须是 0 次**（写链确实挡住了并发写入）；
   - 写句柄的 `header.cwd` 已经等于目标工作区；
   - 写句柄的内核锁已释放（`leaseHeld: false`）；
5. `__selftest/ensure-lease`：强制重取锁，断言 `headerCwd` 与 `sessionDir` 都按**新**路径推导
   （写入以后就落这里）；
6. 再 `/describe`：`cwd` 指向新工作区、**`live: true`（会话还活着）**、且没有 `unreadable`；
7. 让压力循环再跑 1.5 秒，断言**旧目录没有被重建**（重建就说明写入仍落在旧路径）；
8. `__selftest/drop` 收尾。

这两条验证覆盖真实 cordis ctx、真实写租约的获取/释放/重取、真实的写链串行、真实 zstd 读取、
真实 domain 写路径 —— 都是单元测试碰不到的环节。**B 这条抓到过两个只有真跑才会暴露的 bug**：
查错了写句柄所在的 Map（见上文），以及「目标目录不存在时 realpath 先炸」导致「目录会被自动创建」
这条承诺其实没兑现。

## 顺带被处理的旁支

- **投影缓存** `storages/session_projcache/sessions/<id>.json` 里存了 `identity.cwd`；
  本插件在搬完后显式删掉它。其实它的 `identityMatches` 含 `cwd`，所以一改 header 它就会
  自动失效（zhengjy01/dsh-session-relocate 就是这么判断的）—— 显式删除是**多余但无害**的保险。
- **写租约**：不再要求「会话必须没被打开」—— 空闲的先释放（A 节）、正在跑的换 header + 释放锁
  再让下一次写入在新路径重取（B 节）。
- **Windows 没有锁文件**：写锁是由路径派生的命名内核信号量，`session.lock` 只存在于 POSIX。
- **DSH 第一帧不变量**：`assertIndependentHeaderFrame` 要求第一帧恰好只有 header 一行。
  本插件的改写保留那个换行，所以改写后仍然成立（`test/zstd.test.js` 在真实日志上断言）。
