# dsh-session-relocate

**让 DSH 的对话能跨工作区搬家 —— 连正在回答的那个也能搬。**

装完之后，你在侧边栏里就能把一个对话从「工作区 A」搬到「工作区 B」：它在 A 里消失、在 B 里出现，
而且**接着继续聊** —— 它的文件沙箱根、工具工作目录、后续读写全部变成 B。

---

## 三步用起来

### 1. 装

~~~bash
# 从 npm 装：
dsh plugin --profile web add dsh-session-relocate

# 或者从源码装（把路径换成你 clone 下来的 checkout）：
dsh plugin --profile web add <你 clone 下来的 dsh-session-relocate 目录>
~~~

### 2. 重启 `dsh web`

主机侧是 Node 模块，**必须重启才会加载**。

### 3. 确认它活了

- 侧边栏里任意一个对话的 **「…」菜单**里会多出一项 **移动到**；
- 或者直接问它一句：

~~~bash
curl http://127.0.0.1:3080/api/dsh-session-relocate/status
~~~

返回 `{"ok":true, ...}` 就是在线。

---

## 怎么用

### 方式一：菜单

1. 鼠标移到侧边栏里某个对话上，点 **…**；
2. 点 **移动到** —— 会列出除「它当前所在的工作区」以外的所有工作区；
3. 点目标工作区。列表立刻刷新，这个对话出现在目标工作区下；
4. 打开它继续聊：它现在就运行在新目录里。

想搬到一个**还不存在的工作区**：点 **其它目录…**，输入一个绝对路径 —— 目录会被创建，
并自动注册成一个新工作区。

### 方式二：直接拖

把侧边栏里的对话**拖到另一个工作区上**，松手就搬，不用点菜单。

投放目标是**整块工作区分组**，不是那个 34px 的文件夹行：

- 拖到目标工作区的**文件夹行**上 —— 可以；
- 拖到它下面**任意一条会话行**上 —— 也可以；
- 拖到分组里的空隙、或「展开其余 N 个会话」上 —— 一样可以。

松手前，整块目标分组会亮起蓝框。

**组内上下拖动仍然是官方的排序功能，插件一点不抢。** 判断依据是"指针落在哪个分组里"：
在**别的**分组里才接管并搬走；在**它自己所在**的那个分组里就完全让路。

### 批量搬（多选）

侧边栏某个对话的「…」菜单里点 **多选**，每行左侧就会出现勾选圈；点整行即勾选（**不会打开对话**），底部出现操作条 **已选 N 个 / 取消 / 移动**。选好目标工作区后逐条搬，进度实时显示「正在移动 x/N…」，失败的那条**原地不动**、保留选中方便重试。

- 装了 [`dsh-delete-session`](https://www.npmjs.com/package/dsh-delete-session) 的话，它的「多选」底栏会多出一个 **移动** 按钮 —— 两个插件共用同一套选择模式，不会出现两个「多选」入口。
- 批量不是把 N 次单搬简单循环：文件事务逐条做（进度、失败隔离），**工作区归属最后一次性写入**。按实测的单条固定开销推算，3 条会话的总耗时从约 0.96 秒降到约 0.6 秒，条数越多差距越大。
- 中途崩了也不怕：每条会话的迁移日志还在，下次启动（或下一次桥接调用）会按文件状态幂等补完归属。

### 正在回答的对话也能搬

**包括正在回答、正跑子代理、正跑后台任务的那个。** 插件会先拿到它的写所有权，再动文件：

- **打开着但空闲**：先把它从 DSH 内存里安全释放，再搬；
- **正在跑活**：**就地接管** —— 换掉写句柄的 header 并在写链内搬文件，**不打断这一轮回答**。

一句诚实的话：正在跑的那一轮会继续跑完，但它**手里的工具工作目录仍然是旧目录**
（会话在内存里的 header 是冻结的，改不了）；文件和归属都已经搬走，这个对话**下次打开**时才真正
在新目录里跑。想要"正在跑活就拒绝"的保守行为，把 `moveLive` 设为 `false`。

### 如果你搬的正是屏幕上打开的那个对话

页面需要**跳转/刷新一次**再打开它（客户端手里那份是旧的）。搬别的对话则完全无感。

---

## 出问题怎么办

| 症状 | 多半是 | 怎么办 |
| --- | --- | --- |
| 「…」菜单里没有 **移动到** | 装完没重启，或插件没加载 | 重启 `dsh web`；再 `curl .../status` 看是不是 200 |
| 拖动一点反应都没有 | DSH 改了侧边栏的 DOM 约定，或 `dragMove` 被关 | 看 `dragMove`（设回 `true`）；**菜单那条路不受影响，先用它** |
| 搬完打开是空的 / 还在旧工作区 | 搬的正是当前打开的那个对话 | 刷新页面，再打开它 |
| 提示"归属会在下次启动自动补齐" | 这个 DSH 版本的注册表没有可用的刷新入口 | 重启一次 DSH，归属会自动补上 |
| 提示"这个对话正在跑" | `moveLive` 被设成 `false` | 等它跑完，或把 `moveLive` 设回 `true` |
| 提示"打开着的会话搬不了" | `releaseLive` 被设成 `false` | 先切到别的对话，或把 `releaseLive` 设回 `true` |
| 搬完这一轮的工具还在旧目录 | 设计如此（内存 header 冻结） | 不用管；下次打开就在新目录了 |

---

## 它是怎么做到的

### 为什么 DSH 自己搬不了

DSH 发行版里没有任何跨工作区移动会话的能力（`moveSession` / `relocateSession` / `changeCwd` 零命中），
因为「对话属于哪个工作区」被编码在几个互相约束的地方：

| 事实 | 说明 |
| --- | --- |
| 目录名由 cwd 推导 | 会话存在 `~/.dsh/sessions/<由 cwd 编码的项目目录>/<会话目录>/session.vN.jsonl.zstd`，项目目录名是 cwd 的编码（分隔符折叠成 `-`，非 ASCII 变 `~XXXX`）。 |
| cwd 住在日志第一行 | 每个 generation 文件的第一行就是 header，含 `cwd`；header 的 cwd 与物理位置不一致会被判定成 **`corrupt session log`**。 |
| 归属 = 注册表 + 校验 | 工作区记录在 `~/.dsh/storages/workspace.json` 的 `sessionIds` 里，但 `attachSession` 还会**校验 header 的 cwd 必须等于工作区 path**。 |
| 不能出现「两份」 | `findLog(id)` 一旦发现同一个 id 出现在两个项目目录里就直接抛错 —— 这个会话会**永久打不开**。 |

所以「移动」必须同时做三件事，而且中间态必须不伤源数据：
**改 header 的 `cwd` → 把会话目录搬到新项目目录 → 改注册表归属。**

### 移动是一个可恢复事务，不是一次 rename

1. 校验：会话存在、目标工作区存在、源 ≠ 目标、日志读得出来；正在跑活时确认能就地接管；
2. 如果这个对话正打开着：空闲的走 release、正在跑的走 handoff（见下两节）；
3. 写迁移日志（`~/.dsh/session-move/<opId>.json`）；
4. 把整个会话目录**复制到暂存区** `<sessionsRoot>/_session-move-staging/<opId>/<会话目录>/`。
   暂存区比 DSH 认的会话目录深一层，所以后端的扫描器**永远看不到它**；
5. 在暂存区里改每个 generation 的 header `cwd`，并**逐字节自校验**：除第一行外，
   明文必须与源文件完全一致、行数也必须一致 —— 不满足就整体放弃；
6. `rename` 到目标目录（同一存储根下，是原子操作）；
7. 删源目录；
8. 刷新注册表的 header 索引 → `attachSession` 到目标 → 从源 `detachSession`；
9. 失效该会话的投影缓存条目，删掉迁移日志。

关键取舍：**改写发生在暂存区，源目录在改名之前一个字节都没被动过**。所以任何一步失败都能干净回滚；
即使进程在改名后被杀死，也只会留下「目标已完整 + 源还在」这一种中间态，由启动时的恢复流程
（`recoverPendingMoves`）幂等推完。

### A.「先释放再搬」—— 打开着但空闲的对话

会话日志是**单写者**的：写所有权由 `agent-loop` 的写句柄持有（它调
`sessionPersistence.open(id, 'write')`），只在 DSH 进程退出时才释放。不释放就搬文件，
那个句柄会继续往**旧路径**写、并在旧位置重建一个空壳目录 —— 这就是生态里其它迁移插件
要么直接拒绝、要么排队等重启的原因。

释放的缝是存在的（`SessionStore` 每个条目自带 `detach()`），同一个 DSH 版本里
`dsh-delete-session` 已经在生产里用它。本插件的顺序：

1. `sessions.flush(session)` —— 持久化屏障，把缓冲的事件落盘；
2. `sessions.store.get(id).detach()` —— 从 live store 摘掉，派发 `session/disposed`；
3. 持久层收到 `session/disposed` 会 `close()` 那个写句柄，从而释放 `session.lock` 租约
   （它是 fire-and-forget 的异步动作）；
4. **探针确认**：反复尝试 `sessionPersistence.open(id, 'write')` —— 能拿到就证明已经没有活跃写者，
   立刻 `close()` 归还；
5. 探针通过后才开始文件事务。

任何一步失败都会**整体放弃且不碰任何文件**（`release-failed`）。想恢复旧行为就把
`releaseLive` 设为 `false`：打开中的会话直接拒绝。

第 8 步里「刷新 header 索引」是必需的：注册表的 header 缓存是启动时建的，不刷新的话它会拿旧 cwd
去比目标路径、然后自己把 attach 拒掉。这个入口是包私有方法，所以做了 feature-detect ——
探测不到时磁盘操作照样完成，归属会在下次启动时自动补齐（菜单会告诉你）。

### B.「就地接管」—— 正在跑的对话也能搬

写句柄的写入路径是**每次从它手上的 header 现算**的，而这个 header 是**可写槽位**（被冻结的是
那个对象，不是这个属性）。所以顺序是：

1. 从后端的 `tracker.writers` 取到这个会话的 live 写句柄（**取不到就整体放弃**，
   绝不静默搬 —— 那会留下「文件已搬、句柄还指着旧路径」的坏状态）；
2. `await handle.drainLive()` + `await handle.flush()` —— 把缓冲事件落盘。
   `drainLive` 自己会往写链上排队，所以必须在进入临界区**之前**调用，否则死锁；
3. `await handle.enqueueChain(...)` —— 进入该句柄**唯一的串行点**。此后所有
   `append` / `flush` 都排在我们后面；
4. 在临界区里：释放内核写锁并置空 → `handle.header = { ...header, cwd: 目标 }` →
   跑文件事务（暂存 / 改写 / 原子改名 / 删源）。失败就把 header 与锁状态一起回滚；
5. 归属**绕开** `attachSession`：live 会话在内存里的 header 是 deep-frozen 的旧 cwd，
   注册表的 cwd 校验必然失败。改为直接走注册表自己的写路径（`entity.mutate` →
   `table.update`），并**先**把路径索引指到新 cwd（`mutate` 内部会用它过滤 `sessionIds`，
   顺序反了会把刚加进去的 id 自己滤掉）。

写锁的形态值得单独记一句：**Windows 上是由路径派生的命名内核信号量，根本没有锁文件**；
POSIX 上才是会话目录里的 `session.lock`（flock）。两种情况下锁的名字/对象都跟路径绑定，
所以「先释放、让下一次写入在新路径重取」是必需且正确的。

---

## 配置

`cordis.patch.yml` 里这一行的 `config`（profile 层可覆盖）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `bridgePrefix` | `/api/dsh-session-relocate` | 主机桥接前缀。改动后客户端自动跟随（通过引导全局下发）。 |
| `journalsDir` | `<dsh home>/session-move` | 迁移日志目录。 |
| `sessionsRoot` | 后端的 root，退化为 `<dsh home>/sessions` | 会话存储根。一般不用设。 |
| `home` | `$DSH_HOME` 或 `~/.dsh` | DSH home。 |
| `moveLive` | `true` | 正在跑活的对话是否走「就地接管」。设 `false` 则正在跑活的会被拒绝。 |
| `dragMove` | `true` | 侧边栏拖动搬移（整块工作区分组都是投放目标）。依赖官方的 DOM 行属性与分组结构；DSH 改了约定时可一键关掉（菜单那条路不受影响）。 |
| `releaseLive` | `true` | 打开着但空闲的对话，搬之前是否自动释放它。设 `false` 则打开中的直接拒绝。 |
| `releaseRetries` / `releaseRetryDelayMs` | `24` / `150` | 释放后探测写租约的重试次数与间隔（最坏约 3.6 秒）。 |
| `selftest` | `false` | 打开后多挂几个 `__selftest/*` 路由，用来在真实进程里造/清一个测试会话、施加写入压力、验证接管。 |

## 桥接 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `<prefix>/describe` | `{ sessionId? }` → 工作区列表；带 sessionId 时额外给出 `currentWorkspaceId`、`live`、`willHandoff`（正在跑，会就地接管）、`willRelease`（空闲，会先释放）、`activity`、`canMove`、`reason`。 |
| POST | `<prefix>/move` | `{ sessionId, targetWorkspaceId }` 或 `{ sessionId, targetPath }` → 迁移回执（`applied: 'live' \| 'pending'`、`released`、`handedOff`、`handoffWriter`）。 |
| GET | `<prefix>/status` | 版本/配置（含 `moveLive`/`releaseLive`）/待收尾的迁移列表；调用时会顺带尝试恢复。 |
| POST | `<prefix>/__selftest/create-live` | 仅 `selftest: true` 时存在。造一个「已打开 + 持有写租约」的会话（`{ workspacePath, pressure? }`）。 |
| POST | `<prefix>/__selftest/state` | 仅自测时存在。写入压力的采样时间戳 + 每次接管的窗口 + 写句柄现状。 |
| POST | `<prefix>/__selftest/ensure-lease` | 仅自测时存在。强制写句柄重取内核锁，用来证明它把路径算到了新目录。 |
| POST | `<prefix>/__selftest/drop` | 仅自测时存在。释放 + 摘归属 + 删目录 +（可选）注销工作区。 |

失败一律是 `{ ok: false, code, message }`，`code` 形如 `session-live`、`session-active`、
`already-there`、`corrupt-log`。

## 测试与验证

~~~bash
node --test
~~~

覆盖：路径编码与真实 `~/.dsh/sessions` 目录名逐一比对、对真实会话日志做 header 外科手术的逐字节校验、
完整迁移 / 回滚 / 崩溃恢复、桥接端到端（假 cordis ctx）、客户端状态机（假 module loader + react 替身）、
以及拖动的分组归属规则。全部用合成数据，不碰你的真实会话。

三条真机验证（都不需要额外装包）：

| 脚本 | 验证什么 |
| --- | --- |
| `scripts/e2e.mjs live` | 在临时 `DSH_HOME` 里造一个**持有真实写租约 + 持续写入压力**的会话（等价于"正在回答"），边跑边搬：断言 header 换成目标、内核锁释放、**没有任何一次写入插进接管窗口**、搬完还活着、旧目录绝不被重建。 |
| `scripts/drag-verify.mjs` | CDP 驱动 headless Chrome 打开真实 DSH 页面：客户端半真的执行、引导全局带上 `drag: true`、合成拖放事件后会话**真的落到了目标工作区**。 |
| `scripts/drag-live-check.mjs` | 对着**你正在跑的那个 DSH** 做只读检查：分组契约在真实 DOM 上成立、拖到别组会话行被接管并高亮、拖回自己分组完全让路。它**只合成事件、绝不投放**，所以永远不会搬动任何会话。 |

## 已知限制

- **拖动搬移依赖官方的 DOM 约定**：行属性（`data-row-key="session:<id>"` / `"workspace:<workspaceId>"`）
  加上**分组结构**（官方 `renderGroup` 把每个工作区渲染成一个「恰好只含一个工作区行」的容器）。
  它读的是官方渲染出来的东西，不是未公开的拖拽载荷；DSH 若改掉这些，拖动会**分级退化**：
  分组读不到 → 退化成「只认文件夹行」；连行属性也没有 → 完全不介入。
  菜单那条路始终不受影响，`dragMove: false` 可以一键全关。
- **嵌套工作区**（工作区套工作区）时，父分组里若渲染了子分组，父分组的会话行不再算投放目标
  —— 这是保守取舍：宁可少接管，也不猜错工作区。
- **正在跑活的那一轮不会换工作目录**：会话在内存里的 header 是 deep-frozen 的，改不了；
  文件与归属都搬走了，但那一轮的工具仍然用旧目录，**下次打开**才真正在新目录里跑。
- **正在跑活的接管依赖私有内部结构**（`tracker.writers`、写句柄的 `header` 槽位、`enqueueChain`、
  以及注册表的 `entity.mutate`）。DSH 换 rc 版本时这些都可能变，所以每一处都 feature-detect：
  探测不到就整体放弃（`handoff-failed`），绝不半途而废。
- **多进程共用一个 DSH home 时**：接管期间会短暂释放内核写锁，理论上另一个进程可能抢进来。
  单进程部署（默认）没有这个问题。
- 搬「当前屏幕上打开的那个」之后，页面要跳转/刷新一次再打开它（客户端手里那份是旧的）。
- 只移动这一个会话。由它 fork 出来的子会话是自包含的（继承事件已物理写入子日志），留在原处不会坏；
  子代理子会话同样留在原处。
- 一个会话同时只能属于一个工作区，这是 DSH 的模型，不是插件的选择。
- 主机侧假设会话存储根下可以放一个 `_session-move-staging` 暂存目录（对 DSH 不可见，用完即清）。
