# V2 错误处理审计：该 catch 而未 catch 的错误 / 该进 server terminal 而没进终端的错误

> 审计时间：2026-10-23 · HEAD：`8f4a672` · 范围：`v2/` 全部非测试源码（22 个 TS/TSX 文件，约 7,600 行）
> 方法：逐文件通读 `server/`（`copilot-server.ts`、`copilot/*`）与 `src/`（hooks、组件、`diagnostics.ts`、`intent/`），并核对每个 route、每个异步调用链、每个 catch 与 console 调用点。
> 术语：**终端打印规则**指 `v2/server/copilot-server.ts:336-345` —— `writeLog` 的事件只有以 `.failed`/`.error`/`.fatal` 结尾才输出到终端（`[studio:ERROR]`），`.conflict`/`.rejected`/`.warning` 输出 `[studio:WARN]`，其余仅写入 JSONL 文件（`~/.architecture-diagram-studio/logs/copilot-sessions.jsonl`），除非设 `STUDIO_LOG_LEVEL=info`。

优先级：P0 = 排障时会误导或丢失关键信息；P1 = 明确的可补缺口；P2 = 低影响 / 设计权衡可接受。

---

## A. 服务端：未捕获（落入兜底）或静默吞掉、本身没有日志的错误

### A1 · P1 **四个 async 路由没有 try/catch，错误落入 Express 5 默认处理器（HTML 响应，终端无 `[studio:*]` 标记、无 writeLog）**
- `v2/server/copilot-server.ts:456-462` — `GET /api/workspace/configuration`：`getStudioConfig()` 与 `readFile(CONFIG_HISTORY_FILE)`（非 ENOENT 会 rethrow，见 `:100-101`）在 handler 顶部 await，无 try/catch。
- `v2/server/copilot-server.ts:839` — `GET /api/copilot/health`：`await copilot.health()` 无 try/catch（`health()` 内部 `getAuthStatus().catch` 已兜，但 `client.getAuthStatus` 之外的意外 reject 仍会穿透）。
- `v2/server/copilot-server.ts:897-900` — `GET /api/copilot/sessions`：`await getProjectWorkspace()` 无 try/catch（`readJsonFile` 非 ENOENT 会 throw，见 `:190-193`）。
- `v2/server/copilot/intent-route.ts:106/:124/:132` — `POST /api/copilot/intent`：`getStudioConfig()`、`copilot.resolveModel()`、`persistSessionId()` 三个 await 位于 `try {`（`:133`）**之前**，无保护；`persistSessionId` 里的 `getWorkspaceState/persistWorkspaceState`（`copilot-server.ts:889-893`）任意一步失败都会穿透。
- 影响：这些错误返回默认 HTML 500（还会 dev 模式带堆栈），客户端 `aiProvider.ts:131` 的 `response.json().catch(() => null)` 只能显示 "HTTP 500"，没有 JSON error 信息；服务器终端没有 `[studio:ERROR]`/writeLog 记录，只有一个 Express 默认堆栈（`intent-route` 的浏览器对话、与 SDK 会话都不可恢复现场）。
- 建议：给这四个路由统一加 `try/catch`（比照 `:353-361` 的写法），对 500 分支 `writeLog("...failed", {error})` —— `.failed` 后缀会自动进终端。

### A2 · P0 **`intent-route.ts:37/129` `contextBySession` Map 只增不减 —— 内存泄漏**
- `v2/server/copilot/intent-route.ts:103-105`：请求无有效 `sessionId`（客户端首次对话可能带）或格式非法时生成 `randomUUID()` 作为键；`:129` `contextBySession.set(sessionId, context)`，**没有任何 `contextBySession.delete(...)`**（`pendingAgentSelections`/`pendingNativeEdits` 都有清，这个没有；`tool` handler `:79` 与 finally `:280` 只读它）。
- 影响：每次不带有效 sessionId 的 turn、以及每个会话的画面上下文（最多 200 cell）都永久滞留在进程内存里；开发期长时间运行会让进程缓慢增长。
- 建议：turn 完成后（finally 或 `turn.finished` 事件）`contextBySession.delete(sessionId)`，或 Map 换 LRU（比照 `pendingNativeEdits` 的 set/delete 模式）。

### A3 · P1 **无全局兜底：`express.json({ limit: "25mb" })` 超限、以及任何未想到的抛错，都走 Express 默认错误页**
- `v2/server/copilot-server.ts:297` 之后**没有**注册 `(err, req, res, next)` 四参数错误中间件（全文件仅 `:297` body-parser 与 `:298` origin 检查两个 `app.use`）。客户端因为 `AbortSignal.timeout(90_000)` 发送超过 25MB 的 body（或将来任何 route 漏 catch）时：端点返回 body-parser 产生的 HTML 413/500，终端无 writeLog。
- 建议：注册一个错误中间件，把 `err` 映射为 JSON `{error}` 并 `writeLog`（`.failed` 后缀自动打印）。
- 顺带：`process.on("uncaughtException"/"unhandledRejection")` 均未注册（`v2/server/copilot-server.ts:934-935` 仅注册 SIGINT/SIGTERM）。当前代码路径确实没有已知浮动 rejection，但一旦出现（例如 A5 场景）会以裸堆栈崩溃而不是记录一条 `[studio:ERROR]`。

### A4 · P2 **`shutdown()` 失败仍退出码 0**
- `v2/server/copilot-server.ts:929-935`：`void shutdown().finally(() => process.exit(0))` —— 若 `copilot.stop()` reject，`finally` 依旧 `exit(0)`，rejection 被丢弃（进程马上退出，最多闪一条 unhandledRejection）。若 SDK stop 失败，应 `exit(1)` 并打印。
- 建议：`shutdown` 内部 `copilot.stop().catch(...)` 打日志，并按失败与否选择退出码。

### A5 · P2 **`releaseActiveHandle`/临时文件清理路径静默**
- `v2/server/copilot-server.ts:514/:579`：`handle.close().catch(() => undefined)` 与 `unlink(createdPath).catch(() => undefined)` —— 属有意容错（清理例程失败不应掩盖原始错误），可接受；列出仅供知晓，不是缺口。

### A6 · P2 **降级事件只写 JSONL，不进终端（有名称可用，属"应该输出而没有输出"清单）**
- `v2/server/copilot/runtime.ts:320` `models.effort.unresolved`、`:337` `model.substituted` —— 实际 routing 与请求模型不同却不打印。
- `v2/server/copilot/intent-route.ts:81` `tool.propose_native_edits.unresolved` —— 模型给出未解析目标只写 JSONL；同样语义的 `.rejected`（`:76`）反而会打 WARN。
- `v2/server/copilot/runtime.ts:251/254/:482` `session.invalidated`、`client.reset`、`turn.recovering` —— Copilot CLI 崩溃/重建这一最值得肉眼确认的事件链完全不进终端（kind：这组是排障时最需要的）。
- `v2/server/copilot/runtime.ts:517` `turn.abort.idle-timeout`（浮动 `void ... .catch(() => undefined)`，安全但 JSONL-only）。
- 建议：给 `writeLog` 的打印规则加一张显式名单（如 `client.reset`、`turn.recovering`、`model.substituted`、`tool.*.unresolved`），落 `.warning`/`.error` 后缀即可复用现有机制，无需改动调用点。

### A7 · P0 **客户端 error 只写 JSONL，永不进任何终端（跨端系统性缺口，见 D1/D2）**

---

## B. 服务端其余 catch 盘点（核对过，无缺口）

| 位置 | 行为 | 结论 |
|---|---|---|
| `copilot-server.ts:328-331` | 日志队列持久化失败 → `console.error` | ✅ 进终端（队列继续）。注意随后 `:332` `await logWriteQueue` 等待被吞错后的链，无阻塞 |
| `copilot-server.ts:30/:84` | env/config 历史解析的注释式空 catch | ✅ 有意容错（启动广播/历史记录），不符"应打印"标准 |
| `copilot-server.ts:458-460/:466-467/:740-741/:905/:100-101` | `readFile(...).catch` ENOENT → 空串；非 ENOENT rethrow | ✅ 前者进 204/200，后者走 A1/B 表内 try |
| `copilot-server.ts:190-193` | `readJsonFile`：ENOENT → fallback，其他 rethrow | ✅ 调用方都有 try（除 A1 列出的路径） |
| `copilot-server.ts:203-238` | `getWorkspaceState` 主图读取：非 ENOENT rethrow | ✅ 调用方有 try |
| `copilot-server.ts:288-291` | `getDiagramVersions` 失败重置缓存再 rethrow | ✅ |
| `copilot-server.ts:599/:665-676/:707/:834` | `* .save.failed` / `.restore.failed` → writeLog | ✅ `.failed` 后缀自动进终端，含 stack 字段（`:339` 取 stack 打印） |
| `copilot-server.ts:732` | app log 持久化失败 → `console.error` | ✅ 见 D2（这是少数直接进终端的） |
| `storage.ts:50-60` | 串行写队列 `try{resolve}catch{reject}` | ✅ 错误正确传递给 await 方，队列不拒 |
| `workspace-files.ts:34/:44/:58/:68/:91-102` | 方言兜底/目录 readdir catch/symlink 拒绝 | ✅ 设计如此：扫描期单文件失败跳过、不中断面板。`agent-context` 单文件 `:124` `catch(() => "")` 跳过该文件，属既定的宽容策略 |
| `copilot-server.ts:574-579` | 创建图失败回滚（关句柄 + 删半建文件） | ✅ |
| `copilot/runtime.ts:134/188/220/255/271/281/473/519/553/602/654/769` | 全部 try/catch 并 `log("...failed")` 或注释式容错 | ✅（raw catch 点：`compactEvent` 不可序列化 → "[unserializable]"；`forceStop` 已死；`sweep`、`stop()`、`withTurn`、`sendAttempt` 重试、`acquireSession`、usage 指标读取等都有日志或回退）|
| `copilot/runtime.ts:268/:272/:652/:655` | `void this.options.log(...)` 浮动调用 | ✅ 安全：`writeLog`（copilot-server.ts:321-346）设计为永不 reject |
| `copilot/intent-route.ts:113/:119-122/:155` | 校验与 pending 清理 | ✅ |
| `model-routing.ts:117` | `new URL` try/catch → host undefined | ✅ 纯函数，无 IO；`describeModelRouting`/`isModelConfiguredWithoutProvider` 仅读内存 |
| `native-edit-tool.ts` / `native-edit-tool-schema.ts` | 纯函数/常量 | ✅ 无错误路径（`resolveNativeEditTargets` 返回 result 对象而非抛错） |

结论：**服务端 33 处 `res.status(...) .json` 中，除 A1 的 4 个路由 + body-parser 全局行为（A3）外，错误处理闭合且终端输出可预期。**

---

## C. 客户端：未 catch、静默或只降级不记录的位置

### C1 · P1 **`App.tsx:331` traces 拉取失败静默回退，不留任何诊断**
```ts
.catch(() => setTraceEntries(readDiagnosticEntries()))
```
- Agent traces 页面打开时 `/api/workspace/logs` 失败（服务器 500、重启中）→ 直接回到本地 localStorage 列表，用户以为"已经看到全量"。连 `recordDiagnostic` 都没有，失败不可追踪。
- 建议：至少 `void recordDiagnostic("workspace.logs.load.failed", ...)`（error），甚至 console.error。

### C2 · P1 **`App.tsx:536-539` `openDrawioFile` 文件选择器异常只设 lastAction，不 recordDiagnostic**
```ts
} catch (error) { if (AbortError) return; setLastAction("Could not open...") }
```
- 只在底栏闪一条消息；出错细节（非 AbortError）不进错误链路。建议补 error 级 recordDiagnostic（对齐 `openStandaloneDiagram:577-583` 的做法）。

### C3 · P1 **`vite.config.ts:9-80` `/__studio/log` 终端中间件是死代码，且设置页文案宣传它**
- 全代码只有 `vite.config.ts:9` 一处出现 `/__studio/log`；`recordDiagnostic`（`diagnostics.ts:86`）只 POST 到 `/api/workspace/logs`，从不打这个中间件。
- 但 `WorkspacePages.tsx:429-433`（"Terminal output and diagnostics" 设置卡）与 `DrawioFrame.tsx:98`（提示"Check the [studio:v2] drawio output in the terminal"）、`WorkspacePages.tsx:426` 一起向用户承诺"浏览器诊断 → Vite dev 终端 → [studio:v2]"。`[studio:v2]` 日志行只在 `diagnostics.ts:82-83` 的 **浏览器**console 出现，不是终端。
- 两种修法任选：(a) `diagnostics.ts` 在 dev 模式附带 POST（或 `navigator.sendBeacon`）到 `/__studio/log`，兑现宣传；客户端 error 就能即时进 localStorage 那一栏之外的 Vite 终端；(b) 文案改为指向 `/api/workspace/logs`（并把 D1 的映射补上）。

### C4 · P2 **`App.tsx:196` 嵌套 `/api/workspace/files` 拉取 `.catch(() => undefined)` 静默**
- 仅在配置成功后的分支；文件列表拿不到时右侧弹窗不显示文件、且无任何记录。建议提升为 warn 级诊断或把它并入外层 catch（`[studio:ERROR]` 不打印问题同 D1）。

### C5 · P2 **`aiProvider.ts:131` `response.json().catch(() => null)`**
- 响应体非法 JSON 时丢正文。当前消息退化为 "HTTP xxx"（`:135`），兜底可用；若想更准，可读一次文本。列出仅供知晓。

### C6 · P2 **`useWorkspacePersistence.ts:22` `response.json().catch(() => ({}))` 与 `useWorkspacePersistence.ts:58` 聊天 PUT 的浮动链**
- 保存 409/HTTP 错误的 message 可能为空 → "HTTP xxx"；聊天 PUT 失败已有 `.then/.catch → onDiagnostic`，浮链安全。仅知晓。

### C7 · P2 **客户端其余 localStorage/剪贴板空 catch 均为设计内的"存储可选"**
- `App.tsx:34/47/81/105/119-132/395/404`、`useWorkspaceBootstrap.ts:86-87`、`diagnostics.ts:44/52/78`。全部有 UI 级回退；不打印浏览器东西也是有意为之。无需改动。

### C8 · ✅ 无缺口的客户端路径（核对清单）
- `useCopilotIntent.ts:45-198`：整段 try/catch/finally，`copilot.request.failed`（error 级）+ finally 都有；`window.localStorage` 写入有 try。
- `useWorkspaceBootstrap.ts:48-111/118-148`：两处 fetch 全 catch + error 级诊断；XML 校验失败也会停用持久化。
- `DrawioFrame.tsx`：全部 postMessage/JSON.parse/error 事件都 try 或守卫；`drawio.editor.error`、`drawio.document.xml.invalid`、`drawio.document.parse.failed`、iframe onError（`:379-384`）、init 超时（`:99-101`）都 recordDiagnostic。
- `aiProvider.ts` / `native-edit-operations.ts`（隐含）校验型 throw 全部被上游 catch。
- `WorkspacePages.tsx:221-250` 模型列表拉取有 `.catch`（仅 UI 提示，建议顺手补一条 recordDiagnostic —— 与 A6/C3 文案一并考虑）。
- 顶层 React/浏览器场景：`App.tsx:333-348` 注册了 `window.addEventListener("error"/"unhandledrejection")` → `runtime.window.error` / `runtime.unhandled_rejection`（error 级）。兜底存在 ✓（但输出走 D1 的路径，同样不进终端）。

---

## D. 跨端系统性结论与推荐修复顺序

### D1 · P0 **客户端 error 进不了终端（本次审计唯一 P0 的跨端问题）**
- 完整链路：任何 UI/编辑器错误 → `recordDiagnostic(level:"error")`（`diagnostics.ts:58-97`）→ (1) 浏览器 console（`[studio:v2]` 前缀，用户看不见的 DevTools）；(2) `POST /api/workspace/logs` → `copilot-server.ts:712-735` → 写 JSONL。
- **痛点**：服务器接收侧（`:718-730`）从不调用 `console.error/warn`（仅持久化失败 `:732` 会 console.error），Vite 终端中间件又是死代码（C3）。结果：**无论用户看 `npm run dev` 的哪一路终端，都看不到客户端 error**。而设置页谎称看得到（C3）。
- 推荐最小修法（单一改动点、覆盖所有客户端错误）：在 `copilot-server.ts:729`（persist 成功后）按 `record.level` 映射：
```ts
const line = "[studio:v2] " + JSON.stringify(record);
if (record.level === "error") console.error("\n\u001b[1;31m" + line + "\u001b[0m");
else if (record.level === "warn") console.warn(line);
```
  加上 C2/C1 补的 recordDiagnostic，A7 即闭合。

### D2 · P1 **`POST /api/workspace/logs` 若持久化失败则该客户端事件**已记录失败但只在终端，客户端侧没有任何重试**；同一时刻若 2 个 error 先后到达，`withDataWrite` 串行不过丢——可接受。仅知晓（`copilot-server.ts:718-735`）。

### D3 · P2 **`GET /api/workspace/logs` 聚合读取（`:737-772`）对两份 JSONL 里的坏行静默跳过**（`:746/:763` `catch { return [] }`）——符合预期（防止一条坏 JSON 弄丢整个页面），仅知晓。

### 推荐修复顺序
1. **D1**（copilot-server.ts ingest 映射 console，几行）→ 修复面最大：所有 C 类/C1-C4 添加的 recordDiagnostic 自动进终端。
2. **A2** contextBySession.delete（一行 + finally，已在 `:280`）。
3. **A1** 四个路由 try/catch + writeLog("...failed"...)。
4. **C3** dev 转发到 `/__studio/log` 或改文案（顺手让 `WorkspacePages.tsx:432` 的示例与真实行为一致）。
5. **A6** writeLog 名单（把 `model.substituted`、`turn.recovering`、`client.reset`、`tool.*.unresolved` 映射到 WARN 打印）。
6. 其余 P2 按顺手处理。

---

## 附：核对过但**不需要**改的浮动 promise / 空 catch 清单
`App.tsx:379`（standalone 自动保存在内层 try 内）、`App.tsx:473-483/:486-497`（save/clear AI 设置均有 catch）、`App.tsx:823-837`（scan 按钮 inline async 有 catch）、`App.tsx:847/:874/:888/:918/:927/:931/:935-937/:1007/:1032/:1013`（`void fnName()` 调用的全部 async 都有各自 catch）、`useWorkspacePersistence.ts:38`（保存队列吞错为尾随链设计）、`DrawioFrame.tsx` 全部、`useWorkspaceBootstrap.ts` 全部、`aiProvider.ts` catch → throw 模式、`intent-route.ts:113-132` 的 writeLog 调用（永不 reject）、`copilot-server.ts` 剩余 27 个路由（除 A1 四个）都有 try/catch 或纯静默降级（409/404/403 类明确 JSON），`runtime.ts` 其余 catch 点（见 A6 备注）、`storage.ts`/`workspace-files.ts`/`diagram-file.ts`/`native-edit-tool*.ts`/`model-routing.ts`/`drawio-xml-schema.ts`/`drawio-theme.ts`（后两者本次亦核对过：schema `:297/:316/:376-410` 的 try 全在解析边界、theme `:24` 的 localStorage try，均有回退）。

> 终端打印规则速查：`.failed`/`.error`/`.fatal` → error（含 `fields.stack` 时打堆栈，`:339`）；`.conflict`/`.rejected`/`.warning` → warn；其余 JSONL-only，`STUDIO_LOG_LEVEL=info` 可打开。
