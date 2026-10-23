# V2 代码审查：结构性大问题

> 审查时间：2026-10-23 11:06 · 基线：`d8a810c`（`Keep page matching safe for bare GraphModel input`）
> 范围：`v2/server/`（`copilot-server.ts`、`copilot/*`、`workspace-files.ts`、`storage.ts`）、`v2/src/`（`App.tsx`、`hooks/*`、`components/DrawioFrame.tsx`、`intent/*`）、`scripts/bundle-drawio.mjs`、`.github/workflows/v2.yml`
> 方法：逐条走完「浏览器 → 本地 API → 状态落盘 → SDK 会话 → 回执」的完整链路；对写放大、工作区扫描做了本机实测；`tsc --noEmit` 与 `vitest run` 实跑验证。
> 重要前提：审查期间 `main` 仍在收到提交（11:01–11:06 有 6 个提交落地，含持久化补偿写），下面所有结论锚定到 `d8a810c`，行号以该提交为准。
> 结论口径：只列会造成**数据损失、成本浪费、越用越慢、安全越界**的问题；纯风格、纯测试覆盖不在此列。P0 = 会在正常使用中必然发作；P1 = 明确缺口，需要设计；P2 = 局部加固。

---

## 0. 一句话结论

功能与测试都站得住（143 个单测全绿，类型检查通过），但这套系统**没有存储层**：文档、版本历史、聊天、配置全部塞进几个 JSON 文件整文件重写，写放大是 `文档大小 × 版本数` 量级；同时 Copilot 回合**没有取消路径、没有排队上限**，客户端 90 秒先放弃、服务端继续跑完并计费。

这两条是唯一会在真实使用中表现为「越用越慢、越用越贵、偶尔卡死」的问题，其余都是局部加固。

---

## 1. 总览

| 编号 | 级别 | 问题 | 触发条件 | 后果 |
|---|---|---|---|---|
| P0-1 | P0 | 版本历史与工作区状态是单个 JSON 全量重写 | 每次自动保存 / 每条聊天消息 | 大图下每次编辑写数百 MB，累计数十 GB；启动与内存同步劣化 |
| P0-2 | P0 | Copilot 回合无取消、队列无上限，客户端超时早于服务端 | 连点、重试、慢模型 | 用户看到失败，服务端跑完并计费；重试即翻倍 |
| P1-1 | P1 | standalone 模式把整份 XML 写进 localStorage（100 份） | 大图 standalone 编辑 | 配额耗尽后**所有编辑被永久拒绝** |
| P1-2 | P1 | API 无鉴权，workspace 根默认是仓库根 | 任意本机进程 | `?path=v2/.env` 直接读走模型密钥 |
| P1-3 | P1 | 日志/事件文件无轮转，读取是全量 parse | 长期使用 | 磁盘无界增长，Trace 页越用越慢 |
| P1-4 | P1 | 单进程内存态 + 文件为唯一真相 | 两个实例（不同端口同 `DATA_DIR`） | 静默互相覆盖 |
| P1-5 | P1 | 每轮 Copilot 请求都全量扫描工作区 | 每个 turn | 3k 文件 65 ms；10k 上限内线性增长 |
| P1-6 | P1 | 聊天文本无长度上限 | 粘贴长文 / 恶意 body | 单条 25 MB 可写进 `workspace.json` 并每轮重写 |
| P1-7 | P1 | standalone 下 Import 到已打开文件后不会写盘 | 导入后直接关闭 | 导入内容丢失，UI 却显示「Imported」 |
| P1-8 | P1 | 原生编辑 30 s 超时后的迟到结果仍会落盘并记为 applied | 编辑器慢 / 大图批量 | UI 判失败、磁盘和服务器判成功；重试即重复编辑 |

---

## 2. P0

### P0-1 · 存储层缺失：单文件全量重写，版本历史随文档线性膨胀

**证据**

- 版本索引文件含**完整 XML**：`DiagramVersion = { …, drawioXml }`（`copilot-server.ts:166-173`），全部版本存在一个数组里。
- 每次保存都重写整份索引：`persistDiagramVersions(nextVersions)` → `writeJsonAtomic(VERSIONS_FILE, versions)`（`:214-216`、`:711`）。
- 保留上限按**条数**而非字节：100 条/工作区、500 条全局（`:258-259`），单条上限 20 MB。
- 启动时把整份索引一次 `JSON.parse`，并对**每个版本**跑一遍 zod 校验（`:275-309`）。
- 同一轮里 `workspace.json` 又存了一份完整 XML（`WorkspaceState.drawioXml`），并且：
  - 每个 Copilot 请求前 `persistSessionId` 全量写一次（`intent-route.ts:649` → `copilot-server.ts:1048-1052`）；
  - 每条聊天消息 `PUT /api/workspace/chat` 全量写一次，**未防抖**（`useWorkspacePersistence.ts:222-233` → `copilot-server.ts:806-811`），一轮对话至少 2–3 次。

**实测**（本机 SSD，Node 22，1 MB XML × N 个版本，`JSON.stringify` + 写盘）：

| 版本数 | 文件大小 | stringify | 写入 |
|---|---|---|---|
| 10 | 10 MB | 22 ms | 6 ms |
| 100 | 100 MB | 235 ms | 34 ms |

**后果**

- 5 MB 的图 + 100 个版本 → 每次保存重写约 **500 MB**（stringify ≈1.2 s），前 100 次保存累计写盘 **≈25 GB**，之后每次仍是 500 MB。
- 内存峰值 = JSON 字符串 + 解析后对象（各 500 MB 级），Node 默认堆会直接顶到上限。
- 启动把 100 × 5 MB 的 XML 逐个 zod 解析，冷启动可达数十秒。
- 三个文件（versions / 主图文件 / workspace.json）之间没有跨文件原子性，补偿事务（`runCompensatingTransaction`，`7d50afd`）只覆盖运行期异常，不覆盖进程崩溃。

**修法**（按收益排序）

1. 版本落成独立文件：`data/versions/<id>.xml` + 索引只存元数据（id/时间/标签/大小/摘要）。保存时写一个新文件，索引退化到 KB 级。
2. 版本保留改为**按总字节**（如 50 MB/工作区）+ 超限淘汰，而不是按条数。
3. `workspace.json` 拆成 `state.json`（无 XML：sessionId、路径、更新时间）+ `document.drawio`（单份 XML）+ `chat.json`（聊天）。这样聊天写入与文档大小解耦。
4. 版本 XML 用 zlib 存（Draw.io XML 压缩比通常 8–15×）。

---

### P0-2 · Copilot 回合没有取消路径，队列没有上限，客户端超时早于服务端

**证据**

- 客户端硬超时 90 s：`AbortSignal.timeout(90_000)`（`aiProvider.ts:213`）。
- 服务端预算 50 s（首轮）+ 25 s（纠偏）= 75 s（`intent-route.ts:746`、`:756`），**不含** `acquireSession`（可能触发 `resumeSession`/`createSession`/`listModels`）与 `collectAgentWorkspaceContext`（`:704`）的耗时。
- 服务端没有任何请求中断处理：全仓 `grep` 无 `req.on("close")` / `res.on("close")` / `AbortController`，浏览器断开后 handler 照常跑完。
- 回合锁是无长度上限的 Promise 链：`withTurn` 的 `turnLocks`（`runtime.ts:456-483`），排队者只能等前一轮结束。

**后果**

- 正常路径（75 s + 准备开销）已经贴着 90 s；一旦模型慢一点或上下文收集慢一点，**浏览器先超时**，服务端继续把这一轮跑完并把 token 记到账上。
- 用户看到「失败」后重试，第 2 个请求在锁上排队，必然超过 90 s：**N 次重试 = N 次计费 + 0 次可见结果**。
- 更糟的是第 2 个请求失败后，第 1 个请求的结果可能在第 2 个请求的响应之后才写日志，排障时因果反了。

**修法**

1. `req.on("close")` → 若响应未完成则 `turn.session.abort()` 并释放队列（`abortAfterWatchdog` 已有可复用实现）。
2. `turnLocks` 增加等待者计数，超过 1 个直接返回 `429 / busy`，前端提示「上一轮还在处理」。
3. 服务端总预算压到客户端之内（如 40 s + 20 s），并把剩余时间随请求传下去，避免排队后仍在用满额超时。

---

## 3. P1

### P1-1 · standalone 模式把整份 XML 写进 localStorage，写满后编辑被永久拒绝

- `archiveStandaloneHistory`（`App.tsx:440-457`）每次把**整份 `drawioXml`** push 进 localStorage，保留 100 份（`existing.slice(-100)`）。
- 调用点是**每一次**原生属性编辑与批量编辑：`:468`（`path !== "cell:select"`）、`:477`。standalone 下单改一个颜色也会写一份全文。
- localStorage 配额约 5 MB/源（Safari 按 UTF-16 计，实际约 2.5 M 字符）。50 KB 的图约 100 份后写满；1 MB 的图第 5 份就写满。
- 写失败时 `throw new Error("Copilot edit cancelled because a local history snapshot could not be saved")`（`:455`）——因为写入失败，旧条目**不会被裁剪**，之后每次编辑都在同一处失败，**没有 UI 出口**，只能手动清 localStorage。

修法：只在需要时存差异/摘要；按总字节裁剪（写前先算大小、超限先淘汰）；失败降级为「历史快照不可用但编辑继续」，而不是阻断编辑。

### P1-2 · API 无鉴权，workspace 根默认就是仓库根

- 监听 `127.0.0.1`（`copilot-server.ts:1113`）——局域网安全，这点是对的。
- 但完全没有 token：任何本机进程 `curl` 即可调用全部 API。
- Origin 校验在**没有 Origin 也没有 Referer** 时直接放行（`:313-324` 的 `if (!source) { next(); return; }`），只挡浏览器跨站，不挡本机程序和 `no-referrer` 的简单请求。
- workspace 默认为仓库根（`suggestedRootPath` = `v2/..`，`:394`），而 `/api/workspace/files/content` 只限制在 root 之内（`workspace-files.ts:109-140`）——`GET /api/workspace/files/content?path=v2/.env` 会直接返回 `COPILOT_PROVIDER_API_KEY`。

修法：启动时生成一次性 token 写进 `.studio-token` 并由前端注入请求头；`.env`/`.git` 之类的路径加入显式拒绝名单；Origin 缺失时按「非浏览器」处理并同样要求 token。

### P1-3 · 日志与事件文件无轮转，读取是全量 parse

- `writeLog` 每条 `appendFile`（`copilot-server.ts:353-364`），一轮请求产生 15–25 条；`APP_LOG_FILE` 另有一份。
- 读取端点把**整个文件**读进内存、逐行 `JSON.parse`、排序后 `slice(-limit)`：`/api/workspace/logs`（`:798-833`）、`/api/copilot/sessions/:id/logs`（`:1001-1014`）。
- 无轮转、无大小上限（全仓无 rotate/truncate）。

后果：Trace 页随使用时间线性变慢；磁盘可被写满（尤其开启了 `STUDIO_LOG_LEVEL=info` 时，`turn.model-call.completed` 还会带 `responseText`）。

修法：按大小切分（如 20 MB × 5）+ 保留尾部索引；读取改为从文件尾按块反向扫描，凑够 `limit` 即停。

### P1-4 · 单进程内存态 + 文件为唯一真相，多实例会静默互相覆盖

`studioConfig`（`:61`）、`projectWorkspace`（`:138`）、`workspaceState`（`:186`）、`diagramVersions`（`:187`）都是模块级缓存，写路径靠进程内 `withDataWrite` 串行。

`npm run dev`（tsx，4175）与 `npm run start:copilot`（同端口会挡），但用 `COPILOT_PORT=4176` 起第二个实例指向同一 `DATA_DIR` 时，两个进程各自持有旧内存态，互相整文件覆盖。同理，未来若要做「多窗口共享服务」或 Electron 多进程，这个模型会直接崩。

修法：至少加一个 `data/.lock`（PID + 端口 + 时间戳），第二个实例启动即拒绝；长期把内存态降级为「只读缓存 + 版本号校验」。

### P1-5 · 每轮 Copilot 请求都全量扫描工作区

`collectAgentWorkspaceContext`（`workspace-files.ts:141-218`）每轮先 `scanWorkspaceFiles`（`:84-108`，递归 depth 8、上限 10k 文件、**每个文件一次 `stat`**），再做词频排序取 ≤40 个文件、26k 字符预算。

实测本仓库（3253 个文件）：扫描 65 ms。上下文片段本身已有 LRU（key = workspaceId + path + size + mtime，`:188`），但**文件列表扫描没有缓存**，与仓库规模线性增长，10k 文件时是数百毫秒且每轮都发生。

修法：给 `scanWorkspaceFiles` 加 3–5 s TTL 或按根目录 mtime 失效；请求时若命中直接复用。

### P1-6 · 聊天文本无长度上限

`PUT /api/workspace/chat` 只校验 `role/text/id` 的**类型**（`copilot-server.ts:800-806`），`text` 长度不限，单次 body 上限 25 MB（`:312`）。这些文本会进 `workspace.json`，并在每条消息、每个 Copilot 请求前被整份重写（见 P0-1）。

修法：单条 `text` 限 8k、总条数按字节裁剪；客户端也截断。

### P1-7 · standalone 下 Import 进已打开的文件后不会落盘

- `handleImport` 在导入成功后把 `standaloneLastSavedXmlRef.current = xml`（`App.tsx:658`）。
- standalone 自动保存的判据是 `drawioXml === standaloneLastSavedXmlRef.current` 就跳过（`App.tsx:389`），所以**导入这份内容被直接标记为「已保存」**，从未写入文件句柄。
- 结果是：导入后不再改动、直接关闭窗口 → 本地文件还是导入前的内容，但状态栏显示「Imported …」。只有当用户之后又改了一笔，才会把（含导入内容的）整份 XML 写下去。

修法：导入后显式写一次文件（或把 `standaloneLastSavedXmlRef` 置为导入前的值，让自动保存自然触发）。

### P1-8 · 批量原生编辑 30 秒超时后的「迟到结果」仍会落盘并记账，但 UI 已经判失败

作用域仅限**批量路径** `applyNativeCellEdits`（`App.tsx:474-502`、`:1025-1105`）；单条属性编辑路径（`:465-473`）不写 ack 上下文、无 resolver、无超时，不受影响。

- 超时分支只删 resolver，**不删** ack 上下文，也不取消编辑：`App.tsx:494-500`（`nativeEditResolversRef.delete`，`nativeEditAckContextsRef` 保留）。
- 迟到结果到达时：`resolver` 已不存在，但 `acknowledgement` 还在，于是代码照常
  1. `persistDocumentNow(result.serializedXml, "Copilot native edit")` 把结果写进工作区（`:1043`）；
  2. `POST /api/copilot/intent/ack`，`outcome` 传 `"applied"`（`:1063-1072`）；
  3. 然后 `:1102` 才判断「无人等待」，只记一条 `unobserved` 日志。
- 此时用户看到的是 `useCopilotIntent` 在 30 s 时返回的「Nothing was applied / 编辑未确认」，而磁盘和服务器都认为这笔编辑已生效。用户按提示重试 → 同一操作执行第二次（`add_node_after` 会再多一个节点，`delete` 会删掉第二个目标）；更麻烦的是重试所基于的文档**已经被第一次编辑改过**，而界面没有任何对账入口。

修法：超时即视作编辑可能已生效——要么让调用方在超时后进入「unknown，需刷新确认」而不是「失败」，要么在超时分支直接丢弃迟到结果并明确告知「已放弃确认，请刷新画布」。二者选一，不能一边判失败一边落盘。

---

## 4. P2（局部加固，不展开）

| 项 | 位置 | 说明 |
|---|---|---|
| 全局 25 MB body 上限 | `copilot-server.ts:312` | 所有路由（含 `/api/workspace/logs`）都接受 25 MB；按路由收紧更安全 |
| 配置历史手写扫描器 | `:63-96` | JSONL 每行一个对象，直接用 `split("\n")` + `JSON.parse` 更稳；当前实现遇到半行会**静默回退到上一条配置**（模型/effort 悄悄变了） |
| 一个请求三次取快照 | `intent-route.ts:535/611/791` | 已有 revision 缓存，成本低但语义重复，可合并为一次 |
| `contextBySession` 无 TTL | `intent-route.ts:126` | 只有正常/异常路径删除；若进程内异常退出该请求，条目会残留（内存小，影响小） |
| 无压缩中间件 | `package.json` | 首屏 `GET /api/workspace/state` 会回传完整 XML + 最多 2000 条聊天，本地也值得 gzip |
| `event.origin === "null"` 放行 | `DrawioFrame.tsx:230` | 有 `event.source !== iframe.contentWindow` 兜底（`:229`），实际风险低，但 `null` 分支没有存在必要 |
| 客户端与服务器双写聊天 | `App.tsx:424` + `useWorkspacePersistence.ts:222` | 同一份聊天存 localStorage 和服务器，语义重复 |
| 关闭页面不冲刷待保存内容 | `useWorkspacePersistence.ts:211-221` | 只有 250 ms 防抖，没有 `beforeunload` 强制提交；关窗前的最后一笔可能丢 |
| 聊天 PUT 没有串行化 | `useWorkspacePersistence.ts:222-233` | 文档保存有 `saveQueueRef`，聊天没有；两次请求乱序落地会回退聊天记录 |
| 工作区不匹配后首次保存必然 409 | `useWorkspaceBootstrap.ts:74-77` + `:131-136` | 该分支把 `serverRevisionRef` 置空，而补载主图的路径不回填 revision，下一次自动保存 baseRevision 为 null → 409 → 冲突闩锁（只能手动 reload 解除） |
| standalone 恢复服务器版本会写本地文件 | `App.tsx:796-814` | `restoreVersion` 不更新 `standaloneLastSavedXmlRef`，自动保存会把恢复内容写进当前打开的本地文件 |
| 回执回调无 try/catch | `App.tsx:1025-1101` | `resolver()` 放在 `persistDocumentNow` 与 `/ack` 之后，前面任一步抛错（例如 `batchResults` 含 null 元素时 `:487` 的 `step.index` 取空引用）都会跳过 `resolver()`，调用方只能等 30 s 超时，而 ack 可能已经发出 |
| 非安全上下文下 Copilot 整体不可用 | `aiProvider.ts:182`（`globalThis.crypto.subtle`） | `dev:web`/`preview` 绑 `0.0.0.0`，用 `http://<LAN IP>:5173` 打开时 `crypto.subtle` 为 `undefined`，第一次请求就在算 revision 时抛错 |
| 提交前未跑类型检查 | 历史 `b3e6ada` | 该提交上 `tsc --noEmit` 报 TS6133（`native-edit-confirmation.ts:158`），CI 第一步就会红；11:05 的提交已修好。建议加 pre-commit |

---

## 5. 已经做对的（避免误伤，改造时别拆掉）

- **单文件写入是原子的**：`writeTextAtomic` / `writeJsonAtomic` 都是 tmp + `rename`（`storage.ts:4-14`），并按 `withDataWrite` 串行（`:45-61`）。
- **跨文件补偿事务**：`runCompensatingTransaction`（`7d50afd`）对「版本索引 → 主图文件 → 工作区状态」三步做回滚，日志失败不再把已提交的保存变成 500。
- **解析快照缓存**：`diagram-snapshot-cache.ts` 以内容 revision + pageId 为键，容量 4×4，失败不入缓存——键本身就是内容哈希，失效天然正确。
- **工作区上下文片段缓存**：`workspace-files.ts:53-82`，key 含 size + mtime，LRU 按条数与字符双限。
- **prompt 结构**：稳定块（`projectWorkspace` → `diagram`）排在易变的 `request` 之前（`intent-route.ts:745`），provider 前缀缓存能命中。
- **会话层**：`resumeSession` → `createSession`、`scopeKey` 折进 `revisionKey`（`runtime.ts:673`）、idle TTL 清扫、`matches()` 同时比较配置 revision/模型/effort/作用域。
- **回执协议**：`acknowledgements` 用 fingerprint 保证同请求幂等、proposal 有 10 分钟 TTL、`applied` 必须带 `serializedXmlRevision` 与不可变版本号双重校验（`intent-route.ts:264-359`）。
- **模型列表刷新**：`refresh` 走隔离 client（`runtime.ts:320-327`），不再为了刷下拉框杀掉所有会话。
- **工作区模式不再上行完整 XML**：客户端只发 `documentRevision`（`aiProvider.ts:203-208`），服务端用权威快照比对。

---

## 6. 建议落地顺序

| 顺序 | 项 | 改动量 | 收益 | 风险 |
|---|---|---|---|---|
| 1 | P0-1 版本独立文件 + 按字节保留 | 中（存储层 + 3 个路由） | 写放大从 O(版本×文档) 降到 O(文档) | 中：迁移旧 `diagram-versions.json` |
| 2 | P0-2 取消 + 队列上限 + 预算收敛 | 小（runtime + 一个 `req.on("close")`） | 直接止血计费浪费 | 低 |
| 3 | P1-1 localStorage 按字节裁剪 + 失败降级 | 小 | 解除 standalone 的硬死锁 | 低 |
| 4 | P1-3 日志轮转 + 尾部读取 | 中 | 长期可用性 | 低 |
| 5 | P1-2 token + 路径拒绝名单 | 小 | 密钥不再可被本机任意进程读走 | 低（要改前端注入） |
| 6 | P1-5 / P1-6 / P2 | 小 | 逐轮延迟与边界 | 低 |

---

## 7. 本次审查的实跑记录

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit`（`d8a810c`） | 通过（exit 0） |
| `npx vitest run` | 15 个文件 143 个用例全部通过，用时 1.07 s |
| 写放大实测 | 1 MB × 100 版本：100 MB JSON，stringify 235 ms + 写 34 ms |
| 工作区扫描实测 | 3253 个文件、排除规则同代码：65 ms |
| `gh run list` | 11:01–11:06 期间 main 连续 6 次 push，CI 多次被后续提交取消（concurrency） |
