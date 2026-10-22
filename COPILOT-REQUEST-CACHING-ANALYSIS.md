# Copilot 请求缓存分析：哪些东西本可以缓存，但没做好

> 分析时间：2026-10-23 · HEAD：`ecf0e2b` · 范围：`v2/server/copilot/*`、`v2/server/copilot-server.ts`、`v2/server/workspace-files.ts`、`v2/src/intent/aiProvider.ts`、`v2/src/hooks/useCopilotIntent.ts`、`v2/src/hooks/useWorkspacePersistence.ts`、`v2/src/components/WorkspacePages.tsx`、`v2/src/App.tsx`
> 方法：沿一次 `POST /api/copilot/intent` 的完整调用链逐段核对「每次请求是否重新计算 / 是否有缓存 / 缓存的失效方式是否正确」，并在本仓库实测工作区扫描与上下文读取的真实耗时。
> 术语：**一轮（turn）** = 用户在 Copilot 面板发一句话到拿到结果；**稳定块** = 同一会话内多轮之间内容不变的 prompt 片段（工作区上下文、图结构）；**prefix caching** = 模型服务端按「请求前缀」命中缓存（Anthropic / OpenAI 均以此计价打折）。
> 实测环境：本机 SSD，仓库 3253 个文件（已排除 `.git` / `node_modules` / `dist` / `build` 等默认排除项）。

优先级：**P0** = 每轮都在重复付出、且改动收敛的浪费；**P1** = 明显缺口，需要一点设计；**P2** = 低影响或属于设计权衡。

---

## 0. 一句话结论

有，而且最大的浪费**不在 HTTP 层，在「每轮重复构建 + 重复解析」**。

一轮 Copilot 请求会：把整个工作区重新递归扫一遍并 `stat` 每个文件 → 重读最多 200 个文件 → 把最多 **90,000 字符（约 22k–30k tokens）** 原样塞进本轮 prompt → 把同一份 Draw.io XML **全量 DOM 解析 3~5 次、SHA-256 算 2~3 次**。这些结果全部可以按「revision / 文件 mtime」缓存，目前一个都没缓存。

另有两处方向性错误：① `refresh=1` 刷模型列表会**重建整个 SDK client 并 invalidate 所有会话**（为了一个下拉框杀掉全部对话）；② 每轮 prompt 里「用户这句话」排在 90KB 稳定块**之前**，provider 侧的 prefix caching 从第一个 token 就断开，白付全价。

---

## 1. 一轮请求到底做了什么（全链路清单）

| # | 步骤 | 位置 | 缓存现状 | 每轮代价 |
|---|---|---|---|---|
| 1 | 客户端计算 XML revision（SHA-256） | `aiProvider.ts:154` / `useCopilotIntent.ts:71` | 无 | 全量哈希一次（≤20 MB） |
| 2 | 保存当前文档「Before Copilot request」 | `useCopilotIntent.ts:74` | 无（服务端有 unchanged 短路） | 一次 HTTP + 一次原子写 |
| 3 | `POST /api/copilot/intent`（body 含完整 XML） | `aiProvider.ts:175-186` | **无压缩、无去重** | ≤20 MB 上行/轮 |
| 4 | `validateDrawioXmlDocument` | `intent-route.ts:446` | 无 | DOM 解析 #1 + zod 校验 |
| 5 | `workspaceRevision`（校验 revision 自洽） | `intent-route.ts:452` | 无 | SHA-256 #1 |
| 6 | `getNativeDiagramPageInfo` | `intent-route.ts:460` | 无 | DOM 解析 #2 |
| 7 | `extractNativeEditTargets` | `intent-route.ts:465` | 无 | DOM 解析 #3（压缩页再 +1，含 inflate） |
| 8 | `getWorkspaceDiagramSnapshot`（前置校验） | `intent-route.ts:499` | 无 | SHA-256 #2 |
| 9 | `resolveModel` → `listModels` | `intent-route.ts:514` → `runtime.ts:341` | **有**（5 min TTL） | 命中即 0 |
| 10 | `acquireSession` → `prepare()` | `runtime.ts:361` | **无（命中复用就丢弃）** | 重建 systemMessage + 3 个 `defineTool` |
| 11 | `collectAgentWorkspaceContext` | `intent-route.ts:581-583` | **无** | 全量扫描 + 读 200 文件（实测 ~120 ms） |
| 12 | 第 1 次模型调用（50 s 超时） | `intent-route.ts:611` | 无（**不应缓存**） | 真实 token 成本 |
| 13 | 未调用工具 → 第 2 次纠偏调用（25 s） | `intent-route.ts:621` | 无（**不应缓存**） | 真实 token 成本 |
| 14 | `getWorkspaceDiagramSnapshot`（后置校验） | `intent-route.ts:656` | 无 | SHA-256 #3 |
| 15 | `PUT /api/workspace/chat`（2 次/轮，未防抖） | `useWorkspacePersistence.ts:66-77` | 无 | 全量聊天数组重写 |

**结论：** 除去真正该花钱的 12/13 两步，其余 13 步里只有第 9 步有缓存。

---

## 2. 可缓存但没做好的项（按收益排序）

### C1 · P0 每轮全量重建工作区上下文

- 调用点：`intent-route.ts:581-583`（非 standalone 时每轮必调）。
- 实现：`workspace-files.ts:109-135`
  - `scanWorkspaceFiles`（`:52-76`）：递归 depth ≤ 8、上限 10 000 文件、**每个文件一次 `stat`**、结果全量排序，无 mtime 校验、无跨轮复用。
  - 随后读最多 200 个文件（`:117`），diagram 每份取 20 000 字符、其他 4 000 字符，总预算 **90 000 字符**（`:119,125-126`）。
- 实测（本仓库 3253 文件）：**扫描 65 ms + 读 200 文件 54 ms ≈ 120 ms/轮**，与仓库规模线性增长；产出上限 90 000 字符 ≈ **22k–30k tokens/轮**。
- 双重代价：① 每轮白等；② 这块内容原样进入第 1 次调用的 user message（`:610`），SDK 会话保留历史 → **N 轮就是 N × 90 KB 常驻上下文**，并且因为它排在最后，把缓存前缀也一起打断（见 C5）。
- 图没改、文件没动、配置没变，也照样重建。
- 建议：
  1. 以 `hash(workspaceId, primaryDiagram, include/excludePatterns, 各文件 path+size+mtimeMs 集合)` 为 key 做 **容量 1~2 的 LRU**，命中直接复用；
  2. 更彻底的做法：工作区上下文**只在会话首轮注入**（放进 session 的 `systemMessage`，`runtime.ts:578`），后续轮只带「自上次以来变化的文件」或一句 `workspace context unchanged since turn N`；
  3. 退而求其次也至少加 30–60 s TTL + 上一条 hash 校验，并把预算从 90 000 降到 20 000–30 000（当前量级对「帮我改个颜色」这类请求毫无用处）。

### C2 · P0 同一份 XML 每轮重复解析 3~5 次、SHA-256 算 2~3 次

- 解析点：`intent-route.ts:446`（validate）→ `:460`（page info，`native-edit-operations.ts:73`）→ `:465`（targets，`native-edit-operations.ts:98-138`，压缩页还要 `atob` + inflate + **再解析**）。
- 哈希点：`:452`、`:499`、`:656`（`getWorkspaceDiagramSnapshot` 每次对同一字符串重算 `workspaceRevision`）。
- 确认路径再来一轮：`/api/copilot/intent/confirm` 的 `:180-210`（validate + revision + page info + targets）。
- `revision` 本身就是内容哈希，是天然正确的失效键，却一次都没用于缓存。
- 建议：加一个以 `(revision)` 为 key、容量 4~8 的 LRU，缓存 `{ valid, pageInfo, targets }`；`getWorkspaceDiagramSnapshot` 里对同一 `drawioXml` 的记忆化 revision。20 MB 级图下收益最大。

### C3 · P1 模型列表：TTL 有了，失效方式过粗

- `runtime.ts:305-318`：5 分钟 TTL、**空结果不缓存**（这点是对的，注释也写明了 SDK 会把空数组永久缓存）。
- 问题：
  - `refresh=1` → `resetClient`（`:306` → `:243-256`）：重建整个 SDK client 并 invalidate **所有会话**。设置页每次挂载都请求（`WorkspacePages.tsx:222`），用户点一下「重新读取模型」，正在进行的所有对话上下文全废。
  - `modelsCache` 不感知 provider 变化：`readCopilotProvider()` 的结果变了（改了 `.env` 之外的路径、BYOK↔GitHub 切换），缓存照样命中到 TTL 结束。
  - 每次进设置页都会触发一次 IPC（TTL 内命中缓存，TTL 外打到 CLI）。
- 建议：`refresh` 只清 `modelsCache` 并强制一次 `listModels`，把「重建 client」降级成单独的运维动作；`modelsCache` 的 key 加上 `provider.mode + host`。

### C4 · P1 `acquireSession` 先 `prepare()` 再判断复用，命中就整份丢弃

- `runtime.ts:361-366`：`const prepared = await request.prepare()` 在复用判断**之前**无条件执行；命中复用（`:363`）时，刚构建的 `systemMessage` + 3 个 `defineTool`（`intent-route.ts:552-564`）直接丢弃。
- 同一处还有正确性侧问题：`matches()`（`:378-382`）只比较 `configRevisionId / model / requestedEffort`，**不含 workspaceId/primaryDiagram**，`revisionKey`（`:619`）同样不含 → 换了主图但配置 revision 没变时，会话被复用，systemMessage 里的工作区描述是旧的（工具侧靠 `contextBySession` 兜住了当前图，但系统提示是陈的）。
- 建议：先查缓存，命中就只更新 `lastUsedAt`（需要时再 `prepare`）；把 `workspaceId` 与 `primaryDiagram` 折进 `matches()` 和 `revisionKey`。

### C5 · P1 prompt 里稳定块排在易变块之后，prefix caching 命中不了

- `intent-route.ts:610`：`JSON.stringify({ request: prompt, diagram: context, projectWorkspace: projectContext })`。
- 每轮第一个字段就是用户这句话（每轮都不同）→ **前缀在第 1 个 token 就断**；90 KB 的 `projectWorkspace` 排在最后，永远进不了缓存前缀。
- 建议：
  1. 顺序改成 `projectWorkspace → diagram → request`（稳定块在前）；
  2. 与 C1 的 LRU 联动：若本轮工作区上下文与上一轮逐字节相同，直接发 `workspace_context: "unchanged since turn N"` 而不是 90 KB 原文；
  3. 这样既省 token 又让 provider 侧前缀缓存能命中大块。

### C6 · P1 HTTP 层完全没有缓存：无 ETag / 无 Cache-Control / 无条件请求

- 全仓 `grep` 无任何 `Cache-Control` / `ETag`（唯一的 `etag` 是 `drawio-xml-schema.ts:27` 里 Draw.io 文件属性字段，与 HTTP 无关）。
- `GET /api/workspace/files`（`copilot-server.ts:585`）：每次全量扫描后返回完整文件列表；`App.tsx:200` 每次挂载都拉一遍，切工作区后再拉。
- `GET /api/copilot/models`（`copilot-server.ts:857`）：每次进设置页都拉（`WorkspacePages.tsx:222`），客户端不缓存。
- 建议：`files` / `agent-context` 返回扫描结果的哈希作 `ETag` + `Cache-Control: no-cache`，客户端带 `If-None-Match`；`models` 在客户端加 60 s 内存缓存。

### C7 · P1 工作区模式下每轮上行完整 XML（无压缩、且服务端本已持有）

- `aiProvider.ts:175-186`：body 携带 `diagramXml`（上限 20 MB），express 无 `compression` 中间件。
- 但**工作区模式下客户端在发请求前已经 `PUT /api/workspace/document` 保存过同一 revision**（`useCopilotIntent.ts:74`），服务端手里就有这份 XML（`getWorkspaceDiagramSnapshot`）—— 上行是纯冗余。
- 建议：工作区模式下 body 只带 `documentRevision`，由服务端按 revision 取权威 XML（standalone 模式仍带全文）；另加 gzip（对 standalone 有效）。

### C8 · P2 日志接口每次读整个 JSONL 并逐行 `JSON.parse`

- `copilot-server.ts:737-772`（`/api/workspace/logs`）与 `:908-921`（`/api/copilot/sessions/:id/logs`）：`readFile` 整个文件 → `split("\n")` → 每行 `JSON.parse` → 排序 → `slice(-limit)`。
- 两个文件都是 append-only 且**无轮转、无上限**（`APP_LOG_FILE` / `LOG_FILE`），读取耗时随使用线性增长；每轮请求本身还在持续写入 5~6 条（`request.received`、`turn.*`、`turn.model-call.*`）。
- 建议：改为从文件尾部按块读取直到凑够 `limit` 条；同时加日志轮转或按大小截断。

### C9 · P2 聊天记录写入未防抖，与文档 autosave 各写一次全量

- `useWorkspacePersistence.ts:66-77`：`messages` 每次变化都 `PUT /api/workspace/chat`，body 是最多 2000 条全量；一轮对话至少触发 2 次（用户消息、助手消息，失败/提案场景更多），服务端 `writeJsonAtomic` 重写整个 `workspace.json`。
- 同一 hook 的文档 autosave 有 250 ms 防抖（`:54-65`），两者不合并 → 连续两次原子写。
- 建议：聊天持久化也加 250–500 ms 防抖，并与文档保存共用同一写队列（`withDataWrite` 已在服务端串行，但客户端仍发两次请求）。

### C10 · P2 两份重复的工作区上下文实现 + 两个无调用方接口

- `copilot-server.ts:587` 的 `/api/workspace/agent-context`（250 文件 / 120 000 字符预算）与 `workspace-files.ts:109` 的 `collectAgentWorkspaceContext`（200 文件 / 90 000 字符预算）逻辑重复且参数不一致；前者**无任何调用方**。
- `copilot-server.ts:839` 的 `/api/copilot/health` 同样无调用方。
- 建议：加缓存改造前先删除/合并，否则要缓存两份、并维护两套失效规则。

---

## 3. 明确不该缓存的（避免误伤）

| 对象 | 为什么不该缓存 |
|---|---|
| 模型回答 / `nativeEdits` | 有副作用：工具调用、编辑器原子批次、版本快照、baseRevision 校验。响应级缓存会直接把「已应用」和「已回滚」搞混。省成本只能靠会话复用 + 稳定前缀（C1/C5）。 |
| `getWorkspaceDiagramSnapshot` 的状态本身 | 必须反映磁盘权威状态，只能在「同 revision」前提下缓存它的**解析结果**（C2），不能缓存状态。 |
| `listModels()` 的空结果 | 现在的行为正确（空列表通常代表 entitlement/quota 未解析，缓存会让它粘住整个进程）。 |
| `validateDrawioXmlDocument` 的失败结果 | 低成本且与安全相关，保持实时校验；可缓存的只是「同 revision 已通过」这一结论（C2）。 |

---

## 4. 已经做对的缓存（确认无需改动）

- **SDK 会话缓存**：`sessions` Map + resume→create + 30 min idle sweep（`runtime.ts:360-376`、`568-667`、`684-692`），跨服务端重启靠磁盘 session-state 复用。
- **进程级状态缓存**：`studioConfig`（`copilot-server.ts:98`）、`projectWorkspace`（`:140`）、`diagramVersions`（`:260`，带 in-flight 去重）。
- **模型列表缓存**：5 min TTL + 空结果不缓存 + in-flight 合并（`runtime.ts:305-318`）。
- **并发串行化**：`turnLocks` / `sessionLocks`（`runtime.ts:384-435`）保证同一会话的并发请求排队，**不会重复调模型**。
- **纠偏轮不重带上下文**：第 2 次调用的 prompt 只带 `request` + `diagram`，不带 `projectWorkspace`（`intent-route.ts:617-621`），已省下一次 90 KB。
- **文档未变更短路**：`PUT /api/workspace/document` 在 XML 与内存一致时返回 `saved:false` 不建版本（`copilot-server.ts:632`）。

---

## 5. 落地顺序建议

| 顺序 | 项 | 改动量 | 主要收益 | 风险 |
|---|---|---|---|---|
| 1 | C2 XML 解析/revision 记忆化 | 小（新增一个 LRU，改 4 个调用点） | 大图下每轮省数百 ms | 低：revision 即内容哈希，失效天然正确 |
| 2 | C1 工作区上下文 LRU + 降级注入 | 中（要决定放 systemMessage 还是按轮注入） | 每轮省 ~120 ms + 20k–30k tokens | 中：上下文变了模型却以为没变 → 必须用 mtime 集合哈希做 key |
| 3 | C5 prompt 字段重排 | 极小 | prefix caching 命中大块 | 低（注意 SDK 是否自行包裹消息体） |
| 4 | C3 模型缓存失效细化 | 小 | 不再为刷新列表杀掉全部会话 | 中：BYOK 下真需要重建 client 的场景要保留入口 |
| 5 | C7 工作区模式不再上行 XML | 中（改请求协议 + 服务端取数） | 20 MB 级图省掉每轮上行 | 中：standalone 路径要保留全量传输 |
| 6 | C6 / C8 / C9 / C10 | 小~中 | 减少无谓 I/O 与重复实现 | 低 |

---

## 6. 验证方式

1. `STUDIO_LOG_LEVEL=info` 起服务，看 `request.session.acquire.completed` 的 `durationMs` 与 `turn.workspace-context.loaded` 的 `snippetCount`，改造前后对比。
2. 在 `turn.workspace-context.loaded` 里加 `cacheHit` 字段，直接读 JSONL 统计命中率。
3. 用大仓库（>10 000 文件）或 5 MB+ 的图复测：聚焦「`turn.model-call.started` 之前」的墙钟时间。
4. 加缓存后必须回归：`/api/copilot/intent` 的 revision 冲突分支（改动文件 → 立刻发请求，应仍能拿到新内容）、切主图后 `systemMessage` 是否更新（C4）。
