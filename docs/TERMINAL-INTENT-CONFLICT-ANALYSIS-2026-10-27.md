# 「把最左侧 block 翻译成中文」失败分析：一次只读调用吃掉了整轮唯一的终局名额

- 日期：2026-10-27
- 事故请求：`65563d03-7e11-49c1-bbd5-c969fdc8e1dd` / session `5ec316a4-fe3e-48a6-862f-b9da3a6d8ec7`
- 文档：`gantt-table.drawio`（112 cells / 105 vertices / 6 edges）
- 报错：`conflicting_terminal_tools` — "More than one terminal intent tool was called in the same model turn."

**结论：模型第一步打了一发"terminal 的只读脚本"，把这一轮唯一的终局名额用掉了。随后它按计划提交的 10 条 `set_label` 被判定为"第二个终局工具"，错误又被 SDK 压成一句无信息的 `Tool execution failed`，于是它连试 7 次、9 次模型调用、42 秒、54 万 token，最后整轮作废。而用户的任务本身一步就能做完。**

---

## 0. 现场处置

| 项 | 状态 |
|---|---|
| 图内容 | **未改变**（`nativeEditCount: 0`，没有任何 dispatch） |
| 磁盘文件 | **未写入**（`turn.failed` 在持久化之前） |
| History | 未新增快照 |
| 用户任务 | 未完成 |

**直接重发即可，无需回滚任何东西。** 另外：模型在被杀之前已经把 10 条中文标签算好了（见 §6），重发时大概率一次成功。

---

## 1. 时间线：9 次模型调用 / 8 次工具调用 / 只有第 1 次成功

| 轮 | 模型说 | 调用 | 结果 |
|---|---|---|---|
| 0 | "I'll first read the exact labels…, then translate them" | `run_drawio_script {mode:"read"}` | ✅ `accepted:true`（**零数据**） |
| 1 | **"Read completed."** | `propose_native_edits` ×10 `set_label` | ❌ `Tool execution failed` |
| 2 | "The typed batch failed; applying … through a native script instead" | `run_drawio_script {mode:"mutate"}` | ❌ 同上 |
| 3 | "Both edit paths returned generic failures. Let me verify the runtime bridge…" | `run_drawio_script {mode:"read"}`（最小读） | ❌ 同上 |
| 4 | — | `run_drawio_script {mode:"read"}` | ❌ 同上 |
| 5 | — | `select_diagram_element` | ❌ 同上 |
| 6 | — | `propose_native_edits`（单条） | ❌ 同上 |
| 7 | — | `report_intent_outcome {outcome:"unsupported"}` | ❌ 同上 |
| 8 | "every Draw.io tool call failed with `Tool execution failed`… the bridge is unreachable" | — | 结束 |

7 次失败的错误字符串**完全一致**：`{"message":"Tool execution failed","code":"failure"}`。

---

## 2. 根因 A：`mode=read` 是"终局的只读"，自相矛盾

### 2.1 代码：read 和 mutate 走完全相同的终局注册

`server/copilot/intent-route.ts:781-790`：

```ts
const mode = args.mode === "read" ? "read" : "mutate";
const parsed = parseNativeEditOperations([{ op: "run_drawio_script", …, mode }]);
…
registerTerminalIntent(sessionId, "native_edit");   // ← 没有 mode 分支
pendingNativeEdits.set(sessionId, { operations: resolved.operations, summary });
```

`registerTerminalIntent`（`:118-124`）是**单槽位**：第二次调用直接抛错并把整个 session 标记为冲突。

### 2.2 返回值：成功的样子，零数据

`intent-route.ts:800-806`：

```ts
return {
  accepted: true, execution: "after_model_turn", summary, mode,
  scriptLength: args.script.length, terminal: true,
  instructions: mode === "read" ? "This is a terminal read-only script call. …" : "…"
};
```

模型实际收到的内容（session 事件原文）：

```json
{"accepted":true,"execution":"after_model_turn","mode":"read","terminal":true,
 "instructions":"This is a terminal read-only script call. It must not mutate any document/editor state…"}
```

**没有任何 label 数据。** 脚本要到模型这一轮结束之后才在 iframe 里执行。

`mode=read` 确实有合法用途——`src/hooks/useCopilotIntent.ts:242-270` 会把结果渲染进聊天（"Read-only inspection completed. The diagram was not changed." + 结果 JSON）。但那是**"这一轮就是一次检查"**的语义。

模型把它当成了 **"先读，再写"** 的第一步。于是：

- 第 0 轮它说 "I'll first read …, then translate them" → 它预期读完能拿到数据
- 第 1 轮它说 **"Read completed."** → 这是 `accepted:true` 直接诱导出的幻觉

### 2.3 契约本身也在自相矛盾

同一个工具的描述里同时写着：

> "Prefer `inspect_drawio_graph` for non-terminal read-only surveys"
> "This tool is **terminal** for the current model turn."
> "mode=read is a guarded inspection: it must not mutate the document and does not require postconditions"

"terminal" 和 "inspection" 放在一起，模型无从判断到底能不能接着干。它选择了继续干——这是唯一能让用户拿到结果的选项。

---

## 3. 根因 B：终局冲突的错误被吞成 `Tool execution failed`

`intent-route.ts:118-124`：

```ts
function registerTerminalIntent(sessionId: string, kind: TerminalIntentKind): void {
  if (pendingTerminalIntents.has(sessionId)) {
    conflictingTerminalIntents.add(sessionId);
    throw new Error("The model called more than one final intent tool in a turn. No operation will be dispatched.");
  }
  pendingTerminalIntents.set(sessionId, kind);
}
```

这句话本身写得很好——**但模型永远看不到它**。`@github/copilot-sdk` 把抛出的异常压成：

```json
{"success": false, "error": {"message": "Tool execution failed", "code": "failure"}}
```

对照正常返回：`result.content` 是完整 JSON（102 tokens）。**只有抛错路径会丢信息。**

后果是决定性的：

- 模型无法区分「顺序错了」和「编辑器桥断了」
- 它按字面理解 `Tool execution failed`，第 3 轮做出正确但错误的诊断："Let me verify the runtime bridge is responsive"
- 然后连做 4 次探测，全部同样失败
- 最后只能报 `unsupported`，并给用户写了一段"桥不可达，请重连"的说明——**全是错的**

这是本次事故里**唯一一个把单点误判放大成 42 秒空转的因素**。

---

## 4. 根因 C：一次误判 = 整轮作废，连第一顺位有效意图一起丢

`intent-route.ts:1270-1294`：

```ts
const terminalConflict = conflictingTerminalIntents.has(sessionId);
pendingTerminalIntents.delete(sessionId);
conflictingTerminalIntents.delete(sessionId);
…
if (plan.terminalConflict) {
  pendingNativeEdits.delete(sessionId);       // ← 连合法的那个也删了
  pendingAgentSelections.delete(sessionId);
  pendingReportedOutcomes.delete(sessionId);
  res.status(200).json({ outcome: "failed", reply: "Copilot returned conflicting final actions. …" });
  return;
}
```

两个问题：

1. **第一次注册的 `native_edit` 是完全合法的**，但被一并丢弃。设计目标应该是"后者无效、前者生效"或"只丢后者"，现在实现成了"两个都杀"。
2. **冲突状态是 session 级、整轮不可恢复的**。模型即使意识到错误，也无法在后续轮次里自救——每多试一次就多烧一次完整模型调用。

---

## 5. 根因 D：`report_intent_outcome` 也是终局工具，堵死了最后一条退路

`intent-route.ts:454` 同样调用 `registerTerminalIntent(sessionId, "no_mutation")`。所以模型想在失败后"老实报告一句"，也被同一个 guard 打回。它的第 7 轮就是这么死的。

也就是说：**当前 4 个终局工具（`run_drawio_script` / `propose_native_edits` / `select_diagram_element` / `report_intent_outcome`）覆盖了所有出口。一旦第一次调用用错，模型没有任何合法方式结束这一轮。**

---

## 6. 数据侧：这次读根本不需要

模型要读的 12 个 cell ID，**全部已经在 prompt 的 `projectWorkspace.diagram.cells` 里，并且带 label**：

| ID 尾号 | shape | label（prompt 原文） |
|---|---|---|
| 73 | partialRectangle | `''` |
| 74 | partialRectangle | `''` |
| 67 | partialRectangle | `Feasibility` |
| 3 | partialRectangle | `Requirements Readiness` |
| 68 | partialRectangle | `Planning` |
| 16 | partialRectangle | `Timeline & policies Approvals Team creation` |
| 69 | partialRectangle | `Development` |
| 29 | partialRectangle | `Design Prototype Programming Testing` |
| 70 | partialRectangle | `Launch Prep` |
| 42 | partialRectangle | `Documentation Translation Marketing` |
| 71 | partialRectangle | `Launch & Support` |
| 55 | partialRectangle | `Review Customer management` |

```
missing from prompt context: []
total cells in prompt: 111 | with label: 21
```

而且它在第 1 轮提交的 10 条 `set_label` **全部合法**（target 都是上下文里的真实 ID，label 是正常中文串）：

```json
{"op":"set_label","target":"H4MNtB89670sYT-ne7Wz-67","label":"可行性"}
{"op":"set_label","target":"H4MNtB89670sYT-ne7Wz-3","label":"需求就绪"}
… 共 10 条
```

**如果没有那次只读调用，这一批就是终局动作，5 秒内完成。**

---

## 7. 成本

| 指标 | 值 |
|---|---|
| 模型调用 | 9 次（本该 1–2 次） |
| 工具调用 | 8 次（1 成功 / 7 同错） |
| 输入 token | **541,656** |
| 输出 token | 5,141 |
| 墙钟 | 42.7 s |
| 图变更 | **0** |

---

## 8. 为什么 `inspect_drawio_graph` 没被用

系统提示写得很明确：

> "Use `inspect_drawio_graph` for non-terminal read-only inventory by shape, unlabeled status, point/bounds and pagination before editing unnamed objects."

模型 **0 次**调用它。原因不是提示不够清楚，而是：

- 两个工具的描述在**互相指路**（`run_drawio_script` 说"prefer inspect_drawio_graph"，`search_drawio_elements` 也说"use inspect_drawio_graph"）
- 但 `run_drawio_script` 多了 `mode` 参数，读起来像"这个工具也能只读"
- 模型选了更熟悉的那个（脚本），而且它确实返回了 `accepted:true`

**设计上缺少硬隔离**：一个"看起来能读"的工具，行为却是"终局"。

---

## 9. 修复建议

### P0-1｜`registerTerminalIntent` 不许抛错，改为结构化拒绝

抛错 → SDK 吞消息 → 模型盲试。应改为返回一个模型能读懂的结果：

```ts
// 不 throw，让工具正常返回
return { accepted: false, reason: "terminal_intent_already_registered",
         registeredKind: "native_edit",
         message: "This turn already has a terminal action (run_drawio_script). Do not call another terminal tool; the previous action will be dispatched." };
```

注意：`search_drawio_elements` 已经用 `{found:false,…}` 这种"返回而非抛错"的范式，说明这条路可行，只是终局 guard 没沿用。

### P0-2｜`mode=read` 不能占用终局名额

三选一，按推荐度排序：

- **(a) 直接删掉 `mode=read`**。`inspect_drawio_graph` 已经覆盖只读需求，且是非终局的。read 模式唯一独有的能力（"本轮就是一次检查"）用 `report_intent_outcome` + `inspect_drawio_graph` 也能表达。
- **(b) 保留但拆开**：read 模式**不**调 `registerTerminalIntent`、**不**写 `pendingNativeEdits`；改成一个独立的"待执行检查"队列，结果下一轮注入。
- **(c) 最小改动**：read 模式下若后续出现 mutate 意图，**静默丢弃 read**，而不是判死。

### P0-3｜冲突时保住第一个有效意图

`terminalConflict` 分支目前把 `pendingNativeEdits` 一起删了。应改为：**第一个注册的 `native_edit` 优先 dispatch**，后续调用只做"忽略 + 告知"。只有两个都是 `native_edit` 且内容不同才需要人工介入。

### P1-1｜给这个 guard 补测试

`conflictingTerminalIntents` / `terminalConflict` 在整个仓库里 **0 条测试**（`grep -rn "conflictingTerminalIntents" --include="*.test.ts"` 无结果）。`f50f753d` 引入了一个"一次误判即整轮作废"的致命路径，却没有一条用例。至少补：

- 两个终局工具连续调用 → 第一个生效，第二个返回结构化拒绝
- read 后接 mutate → mutate 生效，read 被丢弃
- 7 次连续失败不应产生 7 次模型调用（幂等拒绝）

### P1-2｜`run_drawio_script` 的 read 返回值不能长得像成功

`accepted:true` 是模型判断"我拿到了数据"的主要依据。read 模式应改为：

```json
{"accepted":true,"mode":"read","result_available":false,
 "instructions":"The script runs after this turn ends. You do NOT have its result. Do not proceed with an edit in this turn; use inspect_drawio_graph if you need data now."}
```

---

## 10. 回归清单

| 测试 | 断言 |
|---|---|
| `run_drawio_script{mode:"read"}` 后接 `propose_native_edits` | 编辑生效；不产生 `conflicting_terminal_tools` |
| `propose_native_edits` 后接 `report_intent_outcome` | 不整轮作废；返回结构化拒绝 |
| 连续 3 次终局调用 | 只 dispatch 第一次；后续返回可读原因 |
| 任意终局冲突 | 用户看到的不是 "No diagram changes were dispatched; submit the request again" 这种无信息文案 |
| `mode=read` 的返回值 | 明确不含数据，且不暗示"已完成" |

---

## 11. 一句话给后续排查的人

看到 `conflicting_terminal_tools`，先去看**第一次**终局调用是什么——它往往是一个只读调用（`mode=read`）或一次试探性 `select_diagram_element`。真正想做的编辑在第 2 次，而第 2 次的错误消息在 SDK 里已经被压成 `Tool execution failed`，日志里看不到原因。**本报告 §2–§4 是这条链路的完整解释。**

---

## 12. 证据位置

| 内容 | 路径 |
|---|---|
| 完整 9 轮会话（87 条事件） | `~/.architecture-diagram-studio/copilot/session-state/5ec316a4-fe3e-48a6-862f-b9da3a6d8ec7-cfg-f6dddd3bdd5c8551/events.jsonl` |
| 应用事件（含 `turn.failed`） | `~/.architecture-diagram-studio/logs/application-events.jsonl`（`2026-10-27T13:3*`） |
| 终端 guard 实现 | `v2/server/copilot/intent-route.ts:114-124`、`:1270-1294` |
| read 模式注册终局 | `v2/server/copilot/intent-route.ts:781-806` |
| read 结果的聊天渲染 | `v2/src/hooks/useCopilotIntent.ts:242-270` |

## 13. 实施记录（2026-10-27）

已按本报告修复并提交：

- `run_drawio_script(mode:"read")` 现在返回 `accepted:false`、`result_available:false`、`terminal:false`，明确告知“脚本不会在本轮执行，也没有返回数据”，并引导模型调用非终局的 `inspect_drawio_graph` / `search_drawio_elements`。它不会创建待执行脚本，也不会占用终局名额。
- `registerTerminalIntent` 不再通过抛异常表达冲突。后续终局调用得到结构化拒绝，因此 SDK 不会把它压成无信息的 `Tool execution failed`。
- 已排队的 `native_edit` 优先保留；后续 selection/report/其他 edit 会收到结构化拒绝，第一条合法编辑仍会派发。若先注册的是较弱的 `selection` 或 `no_mutation`，随后出现已解析的真实 `native_edit`，则升级为编辑意图并清除先前的待处理状态。
- 常驻指令和工具说明明确区分“本轮可用的只读查询”与“本轮结束后才执行的终局脚本”；避免模型把异步脚本返回的 `accepted` 当成已经读到数据。
- `intent-route.test.ts` 新增回归覆盖：read → 中文 `set_label` → report；report → 中文编辑升级；重复编辑只保留第一条，并验证不会再走整轮 `conflicting_terminal_tools` 失败分支。

代码与测试已提交至 `main`。V2 CI 运行状态以最新提交的 GitHub Actions 为准；不把尚未结束的 E2E 声称为通过。
