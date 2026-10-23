# 事故分析：把线变 curved 失败（`model.getDefaultParent is not a function`）

基线：HEAD `f3126da`。用户消息原文：「把线都变成 curved 形式」→ 结果「Nothing was applied: Convert all connectors on the active page to curved (curved=1, drop orthogonal edgeStyle) failed (model.getDefaultParent is not a function). The batch was rolled back.」

本报告是事故复盘，与 `V2-NATIVE-SCRIPT-REVIEW-2026-10-23.md`（能力审查）互补：该报告收的是「能力边界」，这里收的是「这次为什么没成 + 回滚诚实性链路断裂」。所有结论均有运行日志与代码行号佐证。

---

## 一句话结论

模型写的脚本只有 **一处 API 误用**（`model.getDefaultParent()`，该方法属于 Graph 不属于 mxGraphModel），fail-closed 机制正确拦截并回滚了；但复盘暴露了三个真实缺陷：**插件回滚代码自身调用了不存在的 API（回滚永远不可能"干净"）**、**宿主把插件的 `batchRolledBack:false` 丢在半路导致 UI 谎称"已回滚"**、**新加的两条 e2e 脚本用例自己就写了同一个错误 API 且断言在当前实现下不可能满足**。

---

## 时间线（实证日志）

| 时间 (UTC) | 事件 | 佐证 |
| --- | --- | --- |
| 03:05:47 | 同请求第一回合：模型按当时的提示词**正确地拒绝**（"curved 不在允许的操作范围"）并报 `unsupported` | copilot-sessions.jsonl |
| 03:36 (+0800 11:36) | `a44206c` 提交，新增 `run_drawio_script` 能力；服务器重启 | git log |
| 03:46:57 | 重发请求；会话上下文提醒了早前被拒的回合 | turn.started |
| 03:47:04.817 | 模型推理："per the system prompt, run_drawio_script is available… let's do it with a script" | sdk.event |
| 03:47:04.830 | `tool.propose_native_edits.accepted`（1 op，脚本 453 字符） | server 日志 |
| 03:47:06.789 | 浏览器 dispatch `cell:execute-script` | application-events.jsonl |
| 03:47:06.766 | ⚠️ 模型先行输出了成功文案「我已把…改为 curved」（早于编辑器结果 122ms） | sdk.event |
| 03:47:06.841 | **插件失败并回滚**（29ms）：脚本第 1 行抛 TypeError；回滚对页内 3 个已有快照 cell 各报 `activeModel.setConnectable is not a function` → `batchRolledBack:false` 已发出 | update.failed 事件 |
| 03:47:06.956 | App 侧 step 事件 `rollbackConfirmed: null`（false 已丢） | application-events.jsonl |
| 03:47:06.964 | `copilot.native-edit.rejected`，`batchRolledBack: null`、`rollbackErrors: 3 条` | application-events.jsonl |
| 03:47:06.888 | 服务端 `turn.native-edit.final-outcome`：outcome=failed，editorAcknowledged=false，未落盘 | server 日志 |
| 随后 | UI 显示「Nothing was applied: … failed (model.getDefaultParent is not a function). **The batch was rolled back.**」 | 用户消息 |

图状态核实：`test.drawio` 未变（连线仍是 `edgeStyle=orthogonalEdgeStyle;rounded=0`），**curved 至今没有生效**。

---

## 失败脚本与 API 事实核对

模型提交的脚本（application-events.jsonl `copilot.native-edits.dispatch` 全文捕获）：

```js
var parent = model.getDefaultParent();          // ← 唯一的错误：mxGraphModel 没有这个方法
var edges = graph.getChildEdges(parent);
model.beginUpdate();
try {
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i];
    graph.setCellStyles('edgeStyle', null, [e]);
    graph.setCellStyles('orthogonalLoop', null, [e]);
    graph.setCellStyles('rounded', '1', [e]);
    graph.setCellStyles('curved', '1', [e]);
  }
} finally {
  model.endUpdate();
}
graph.refresh();
return {updated: edges.length};
```

对本 bundle 的 API 核对（`v2/public/drawio/mxgraph/src/`）：

| 调用 | 归属 | 是否存在 |
| --- | --- | --- |
| `graph.getDefaultParent()` | mxGraph | ✅ mxGraph.js:11916 |
| `model.getDefaultParent()` | mxGraphModel | ❌ **不存在**（这就是本次 TypeError） |
| `graph.getChildEdges(parent)` | mxGraph | ✅ mxGraph.js:12216 |
| `model.beginUpdate()/endUpdate()` | mxGraphModel | ✅ mxGraphModel.js:1964/1989 |
| `graph.setCellStyles(key, value, cells)` | mxGraph | ✅ mxGraph.js:3576 |
| `graph.refresh()` | mxGraph | ✅ |
| `activeModel.setConnectable(cell, v)`（插件回滚用） | mxGraphModel | ❌ **不存在**（见缺陷 D1） |
| `activeModel.setVisible/setCollapsed` | mxGraphModel | ✅ mxGraphModel.js:1869/1814 |

也就是说：**脚本本身只差一个词**。修正版（第 1 行 `model.` → `graph.`，其余原样）：

```js
var parent = graph.getDefaultParent();
var edges = graph.getChildEdges(parent);
model.beginUpdate();
try {
  for (var i = 0; i < edges.length; i++) {
    var e = edges[i];
    graph.setCellStyles('edgeStyle', null, [e]);
    graph.setCellStyles('orthogonalLoop', null, [e]);
    graph.setCellStyles('rounded', '1', [e]);
    graph.setCellStyles('curved', '1', [e]);
  }
} finally {
  model.endUpdate();
}
graph.refresh();
return {updated: edges.length};
```

沙箱绑定核对：插件 `new Function("ui","editor","graph","model", …)`，`model = activeGraph.getModel()`，即 mxGraphModel（`plugins/studio-selection-plugin.js:314-315`）。提示词（`intent-route.ts:374`）确实说明了 `model (the live mxGraphModel)`，但只给了零散示例，没有点明 **Graph 与 mxGraphModel 的分工**，也没有给「枚举全部连线」这种高频配方的标准写法。schema 描述（`native-edit-tool-schema.ts:53`）同样只列了四个变量名。结果模型第一行就猜错。

---

## 这次链路里做对的部分

- **fail-closed 全链生效**：脚本第 1 行抛错 → 批次停止 → 快照回滚执行 → 插件 `studioPropertyEditResult{success:false}` → 服务端 `outcome=failed, editorAcknowledged=false`，未导出 XML、未持久化、revision 未动（`turn.native-edit.final-outcome`）。
- **30 s 超时兜底没用上**：失败在 29ms 内返回，用户体验是"立即知道没改成"。
- **诊断链完整**：dispatch → requested → failed → rolled-back → rejected → final-outcome，脚本全文（453 字符）都有记录，可复盘。
- **模型"抢跑"的成功文案被结果消息纠正**：`useCopilotIntent.ts:206-211` 用编辑器确认结果（而非模型散文）生成最终消息，符合"Never claim success without editor acknowledgement"。
- 快照机制按设计工作：脚本 op 对整页所有 cell 建快照（plugin `:102-111`），本次未发生任何实际修改，回滚后 XML 逐字节不变。

---

## 新发现缺陷（本报告的增量）

### D1 · 插件回滚本身调用不存在的 API —— 脚本批次的回滚永远不可能"干净"

`plugins/studio-selection-plugin.js:215`：

```js
if ((restoreAll || paths.indexOf("cell:connectable") >= 0) && typeof snapshot.connectable === "boolean")
  activeModel.setConnectable(item, snapshot.connectable);
```

mxGraphModel **没有** `setConnectable`（mxCell.js:357 才有 `mxCell.prototype.setConnectable`；mxGraphModel 只有 `setVisible/setCollapsed/setValue/setStyle/setGeometry/setTerminal/add/remove`）。脚本 op 对整页快照且 `restoreAll:true`，因此**任何一个脚本批次失败，每个被快照的 cell 都会在回滚的第 215 行抛 TypeError** → `rollbackErrors ≥ 1` → `:224` `failure.batchRolledBack = false`。

后果：插件侧对"脚本批次回滚成功"这一状态**永远无法报告为真**。本次事故里脚本其实什么都没改，回滚实际上是干净的，但插件仍然报了 3 条 rollbackErrors、`batchRolledBack:false` —— 回滚成功与否的信号被自身 bug 污染，不可信。

**修法**：改用 `item.setConnectable(snapshot.connectable)`（mxCell 级 setter，与 mxGraphModel 内部 `collapsedStateForCellChanged` 调 `a.setCollapsed(b)` 的同一模式），并加 `typeof item.setConnectable === "function"` 门。改后，本次这类"脚本未改动任何东西"的失败将得到 `rollbackErrors:[]`、`batchRolledBack:true`。

### D2 · 宿主把 `batchRolledBack:false` 丢在半路 —— UI 谎称「The batch was rolled back.」

实证链条（同一事故）：

1. 插件发出 `batchRolledBack:false`，DrawioFrame **诊断事件**里如实记录（update.failed 事件末尾 `"batchRolledBack": false`）；
2. 但 `DrawioFrame.tsx:314-317` 的**失败分支**构造 `NativeEditResult` 时只转发 `{requestId, success, cellId, path, error, batchResults, failedIndex, rollbackErrors}` —— **没有 `batchRolledBack`**；
3. `App.tsx:486`：`rolledBack: result.batchRolledBack !== false` → `undefined !== false` → **true**；
4. `useCopilotIntent.ts:208-211` 渲染成「The batch was rolled back.」；step 事件里 `rollbackConfirmed: null`（`:1115`）。

也就是说：插件明确说了"没回滚干净"，宿主不但没传达，反而推导出相反的结论告诉用户。当前用户消息「The batch was rolled back.」是**误导性断言**（本次脚本恰好未改任何东西，结果上无害；若脚本先改了再抛错，就会掩盖真实损坏）。这正落在 `V2-NATIVE-SCRIPT-REVIEW` P1-3（回滚声明不可靠）的枪口上，但 P1-3 只列了快照逃逸路径，**没有抓到这两行管道级的丢弃**。

**修法**：
- `DrawioFrame.tsx:314-317` 补 `batchRolledBack: typeof data.batchRolledBack === "boolean" ? data.batchRolledBack : null`；
- `App.tsx:486` 改三态：`false` → false，`true` → true，`null/undefined` → unknown（该分支来自非 batch 失败时本就无此字段）；
- `useCopilotIntent.ts:206-211` 文案按三态区分：true → 「已回滚」；false → 「已尝试回滚，但 N 个单元格未完全恢复（见 rollbackErrors），请重新加载或比对历史版本」；unknown → 现行兜底文案。顺带把 `rollbackErrors` 数量写进用户可见消息（只报个数，不贴 detail，避免泄漏脚本内容）。

### D3 · 新加的两条 e2e 脚本用例自己就写着错误 API，且断言在当前实现下不可能满足

`v2/e2e/02-canvas.spec.ts`：

- **:209**（成功用例"通过通用原生脚本修改连线样式"）：`const parent = model.getDefaultParent();` → 与线上失败完全相同的 TypeError。该用例在当前 bundle 下 `result.success` 必为 false，:250 断言必挂；
- **:263**（回滚用例）：`graph.insertVertex(model.getDefaultParent(), …)` → 同样第一行即抛；且用例断言 `batchRolledBack===true`（:292）与 `rollbackErrors===[]`（:293），而 D1 决定了脚本批次失败时 rollbackErrors 恒非空 —— **这两个断言对当前实现是不可满足的**；
- 第三条 typed batch 回滚用例（:301-346）不含 script op，`pathsById` 不含 `cell:execute-script`，不会走到 :215，所以它合法地通过（对比之下更衬托出脚本用例的问题）。

结合 `V2-NATIVE-SCRIPT-REVIEW` 记录的验证范围（"vitest 155 个用例全绿"，未提 playwright），可以判定：**脚本 e2e 从未有跑绿的记录**，能力是在 e2e 红灯（或未跑）状态下合入的。这违反 AGENTS.md「test … actual Draw.io bridge acknowledgement」的要求——恰好这两个 case 就是要覆盖 bridge 层。

**修法**：
1. 两个用例的脚本改为 `graph.getDefaultParent()`（成功用例可顺便采用本报告的修正脚本，断言 curved=1 落盘）；
2. 回滚用例在 D1 修复后保留 `rollbackErrors===[]` / `batchRolledBack===true` 断言；在 D1 修复前，这两个断言先改成对当前行为的准确描述，或干脆等 D1 一起解；
3. 流程上：native 能力的 PR 必须附 playwright e2e 运行结果（这一类改动 vitest 全绿没有意义）。
4. 讽刺的注脚：**写 e2e 的人和写线上脚本的两个智能体犯了同一个错**，说明这不是模型个体问题，而是"契约里根本没写清楚 mxGraphModel vs Graph 的 API 分工"（D4）。

### D4 · 沙箱 API 契约缺口：变量名给了，API 面没给

`native-edit-tool-schema.ts:53`（"Available variables: ui, editor, graph, model"）与 `intent-route.ts:374`（给了 insertVertex/insertEdge/removeCells/groupCells/alignCells/setTerminal、getChildCount/getChildAt 等零散例子）都没有说明：

- `graph`（mxGraph）持有**一切视图/图级 helper**：getDefaultParent、getChildEdges/getChildCells、setCellStyles、refresh、insertVertex/insertEdge、removeCells…；
- `model`（mxGraphModel）只有**数据与事务**方法：beginUpdate/endUpdate、setStyle/setValue/setGeometry/setTerminal、getChildCount/getChildAt、getCell…；**它没有 getDefaultParent/refresh 等任何图级方法**。

deepseek-flash 正是把图级 helper 放到了 `model` 上。审查报告 P0-1 提过"模型幻觉写错 API"是已知风险方向，但没有给出最便宜的缓解。

**修法（成本极低、收益立现）**：在 `intent-route.ts:374` 与 schema description 里加一小段速查，例如：
"graph (mxGraph) owns view-level helpers: graph.getDefaultParent(), graph.getChildEdges(parent), graph.getChildCells(parent, v, e), graph.setCellStyles(key, value, cells), graph.refresh(), graph.insertVertex/insertEdge/removeCells. model (mxGraphModel) only owns data + transactions: model.beginUpdate()/endUpdate(), model.setStyle/setValue/setGeometry/setTerminal, model.getChildCount/getChildAt/getCell. mxGraphModel has NO getDefaultParent and NO refresh — call them on graph."
顺手可加一条明确警告："A single wrong API call rolls back the whole batch."

### D5（次级，UX 观感）· 模型抢跑成功文案

模型在编辑器结果返回前 122ms 输出了「我已把连线改为 curved…」（sdk.event 03:47:06.766，final-outcome 在 :888）。最终用户会同时看到"已改成"与"Nothing was applied"两条矛盾消息（后者是宿主出的，正确）。设计上宿主消息为准，但目前没有对早到的成功散文做任何标记或撤回。

**修法（轻量）**：`turn.completed.with-native-edits` 之前不把模型散文消息渲染为"结果态"；或执行结果回来后若失败，把模型散文消息折叠/标注"模型自述，实际未生效"。可与审查报告 P1-2（proposal 卡片展示真实代码）一起做。

---

## 与既有报告的对照

| 审查报告条目 | 本事故的关系 |
| --- | --- |
| P0-1 脚本=同源任意代码 | 本次未触发恶用面，但"模型写错 API 也算幻觉注入"的论断多了实例（D4） |
| P0-2 同步脚本挂死 | 本次 29ms 结束未触发；`intent-route.ts:373` 确在推动模型"别拒绝、写代码"，风险真实 |
| P1-1 破坏性脚本免审 | 本次是"改全部连线样式"，恰好属于应审而未审的一类 |
| P1-3 回滚边界与 `batchRolledBack:true` 自欺 | 本事故给出**更上游的两个实锤**：插件侧信号被自身 bug 污染（D1）、宿主侧信号被管道丢弃（D2）—— P1-3 建议的三态化必须先修这两处才有意义 |
| P2-1 确认语义=页面任意变化 | 本次失败未到确认环节，逻辑闭环成立 |
| P2-3 失败时全文回传脚本 | 本次 453 字符无碍；上限 50KB 的隐患仍在 |

---

## 修复清单（按优先级）

| 级别 | 项 | 位置 | 动作 |
| --- | --- | --- | --- |
| P0 | D1 | `plugins/studio-selection-plugin.js:215` | `item.setConnectable(snapshot.connectable)` + typeof 门 |
| P0 | D2 | `DrawioFrame.tsx:314-317` | 转发 `batchRolledBack`（boolean / null） |
| P0 | D2 | `App.tsx:486` | 三态语义；`useCopilotIntent.ts:206-211` 文案按三态 + rollbackErrors 计数 |
| P0 | D3 | `e2e/02-canvas.spec.ts:209/:263`（含 :292/:293 断言） | 改 `graph.getDefaultParent()`；D1 修复后保留严格断言；**实际跑 playwright** |
| P1 | D4 | `intent-route.ts:374`、`native-edit-tool-schema.ts:53` | 加 mxGraph vs mxGraphModel API 速查与显式警告 |
| P1 | （对齐审查 P1-1） | `intent-route.ts:140-143` | script op 一律 `requiresExplicitConfirmation` |
| P2 | D5 | `useCopilotIntent.ts` 消息流 | 失败后标注/折叠模型早到的成功散文 |
| P2 | （对齐审查 P2-3） | plugin `:158-160` | 失败条目对脚本只回 `scriptLength` + 前 200 字符 + hash |

顺序建议：D1 → D2（各一行到两行的止血改动）→ 修 e2e 并跑绿 → 速查文案 → 审查报告的 P1-1。

---

## 立刻完成「把线都变成 curved」的两条路

1. **马上可用**：用上面"修正脚本"（第 1 行 `model.`→`graph.`）驱动任一执行路径；或直接在 re-prompt 里贴上这段脚本让模型照抄执行。
2. **修复后的默认路径**：等 D1/D2/D4 修复并部署后，重新发送「把线都变成 curved 形式」——拿到 API 速查的模型大概率一次写对；即便写错，回滚信号也会诚实。

---

## 附录 · 实证日志摘录

```
update.failed (03:47:06.841, durationMs 29)
  errorMessage: "Batch rolled back after operation 1 failed: model.getDefaultParent is not a function"
  failedIndex: 0
  batchResults[0].error: "model.getDefaultParent is not a function"
  rollbackErrors: [
    {cellId:"MRDE1TfU6mpqhOhdJKLE-1", error:"activeModel.setConnectable is not a function"},
    {cellId:"7BtfhEyduUxMANLAR_PL-1", error:"activeModel.setConnectable is not a function"},
    {cellId:"7BtfhEyduUxMANLAR_PL-2", error:"activeModel.setConnectable is not a function"}]
  batchRolledBack: false        ← 插件如实上报
copilot.native-edit.rejected (.964)   batchRolledBack: null   ← 已丢
copilot.native-batch.step.rolled-back (.956)  rollbackConfirmed: null ← 已丢
turn.native-edit.final-outcome (.888) outcome:"failed", editorAcknowledged:false,
  persistenceStatus:"not_attempted", error:"Batch rolled back…getDefaultParent…"
```

> 图状态：`test.drawio:13` 连线 style 仍为 `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;…` → curved 未生效，本次无任何写入。
