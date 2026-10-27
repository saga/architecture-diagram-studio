# 「PLC 边线变黄」被中止分析：一次过严的陈旧状态检查，扔掉了一个完全正确的编辑

- 日期：2026-10-27
- 事故请求：`775872eb-afcf-4b25-9610-0e583f4e9183` / session `40cd01c8-405a-402b-b00a-556291fddf87`
- 文档：`Page-1`（71 cells / 54 vertices / 17 edges，单页）
- 报错：`The diagram, page, or selected target changed while Copilot was responding. No edit was sent to Draw.io; retry against the current state.`

**结论：模型给出的脚本是正确的、可执行的、断言齐备的，但它在 11 秒后被客户端一道"三合一"的陈旧状态检查拦下。真正变化的只有「选中项」，而这次编辑根本不用选中项——脚本完全按 label 匹配。检查逻辑对"选中项"的敏感度过高，同时错误信息不告诉你是哪一项变了。**

---

## 0. 现场处置

| 项 | 状态 |
|---|---|
| 图内容 | **未改变**（`copilot.native-edits.dispatch` 从未出现） |
| 磁盘文件 | 未写入 |
| History | 未新增 |
| 用户任务 | 未完成 |

**直接重发即可。** 但要提醒：模型在最后一条消息里已经写了「已将全部 7 个…的边框色设为黄色」——**这句话是假的**，实际一个 cell 都没改。如果之后有人翻 Agent traces，别被它误导。

---

## 1. 时间线

| 时刻 (UTC) | 事件 | 关键数据 |
|---|---|---|
| 14:22:08.643 | `drawio.runtime-inspection.requested` | revision `ad1e9ed4…`，pageId `02w9a8T47N6eudm4lY3D` |
| 14:22:08.652 | `drawio.runtime-inspection.completed` | 72 cells / 54 vertex / 17 edge，**returnedCells 60，truncated** |
| 14:22:08.659 | `copilot.agent.request.started` | `promptCharacters: 26`，`nativeCellCount: 71`，**`selectedCellPresent: true`** |
| 14:22:08.901 | `turn.model-call.started` | `requestPromptLength: 130653`，`toolCount: 9` |
| 14:22:18.9 | 模型调用 `run_drawio_script` | 服务端 `accepted: true`（脚本见 §4） |
| 14:22:19.635 | `copilot.agent.response.validated` | `nativeEditCount: 1`，`durationMs: 10973` |
| 14:22:19.638 | **`copilot.request.failed`** | 客户端抛错，**没有任何 dispatch** |

**关键空白**：`14:22:08.659 → 14:22:19.635` 这 11 秒里，日志中**没有任何 `drawio.document.saved` 事件**。

---

## 2. 拦截点在哪

`src/hooks/useCopilotIntent.ts:154-158`：

```ts
const stateAfterResponse = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
if (stateAfterResponse.drawioXml !== sourceXml || stateAfterResponse.selectedNativePageId !== sourcePageId ||
    (sourceSelectedCellId && stateAfterResponse.selectedNativeCellId !== sourceSelectedCellId)) {
  throw new Error("The diagram, page, or selected target changed while Copilot was responding. …");
}
```

`sourceXml / sourceSelectedCellId / sourcePageId` 在 `:88-91` 从 `latestDiagramStateRef.current` 快照（`App.tsx:262-263`，每次 render 重新赋值）。

这是一个 **3 条件 OR**：

1. `drawioXml` 字符串不等
2. `selectedNativePageId` 不等
3. `selectedNativeCellId` 不等（仅当发请求时本来有选中项）

任何一条命中，整轮作废。

---

## 3. 到底是哪一条命中（可以确定是第 3 条）

### 3.1 `drawioXml` 没变 —— 有硬证据

`drawio.document.saved` 在 `DrawioFrame.tsx:1082` 是**无条件**写的（只有 `duplicateXml` 的早退分支会跳过，而那种情况也不会调 `onDocumentChange`）：

```ts
lastSent.current = data.xml;
recordDiagnostic("drawio.document.saved", …);   // :1082
onDocumentChangeRef.current(data.xml);          // :1085
```

而这 11 秒的日志里**一条都没有**。所以 `onDocumentChange` 没触发，`nativeXmlOverride` 没变，`drawioXml` 没变。

### 3.2 `selectedNativePageId` 不会变 —— 单页 + 稳定实现

`currentPageId()`（`plugins/studio-selection-plugin.js:56-60`）返回 `ui.currentPage.getId()`，单页文档恒定 `02w9a8T47N6eudm4lY3D`。日志里也只出现过这一个 pageId。

### 3.3 只剩选中项

`selectedNativeCellId` 的唯一写入点是 `App.tsx:1965-1968` 的 `onSelectionChange`，它由插件 `studioSelectionChanged` 驱动（`plugin:123-135`），而该事件只在：

- `graph.getSelectionModel().addListener("change", publishSelection)`（`plugin:1410`）
- 模型 `change` 事件（`plugin:144`，会重新读取当前选中项）
- `pageSelected`（`plugin:1411`）

也就是说：**选中项真的变了**。发请求时有一个 cell 被选中（`selectedCellPresent: true`），11 秒后它不再相同（被清空或换成了别的 cell）。

**最可能的触发**：用户在等待的 11 秒里点了画布空白处 / 按了 Esc / 点选了别的元素。draw.io 在这些操作下会 `clearSelection()` 或替换 `cells[0]`。

> 这一条是**推断**，不是直接证据——因为日志里没有记录 before/after 的选中 id。这本身就是一个缺陷，见 §5。

---

## 4. 被丢掉的那个脚本，其实是对的

模型提交的脚本（`run_drawio_script`，服务端已 `accepted`）：

```js
const model = graph.getModel();
const parent = graph.getDefaultParent();
const targets = [];
for (let i = 0; i < model.getChildCount(parent); i++) {
  const c = model.getChildAt(parent, i);
  if (c && c.vertex && String(model.getValue(c)) === 'PLC') targets.push(c);
}
if (targets.length === 0) throw new Error('No cells with label PLC found');
model.beginUpdate();
try { graph.setCellStyles('strokeColor', '#FFFF00', targets); } finally { model.endUpdate(); }
…
return { ok: true, postconditions: { allSevenPlcCellsFound: targets.length === 7, … }, xmlAssertions };
```

我用 prompt 里的真实 cell 清单核对了它：

| 核对项 | 结果 |
|---|---|
| label 恰好等于 `PLC` 的 cell 数 | **7**（id 46/47/48/49/52/59/64） |
| 这 7 个的 `parentId` | 全部是层 cell（`…-1`），即 `graph.getDefaultParent()` 的直接子节点 |
| 脚本的 `getChildCount(parent)` 遍历能否命中 | **能**（不需要递归） |
| `targets.length === 7` 断言 | 会通过 |
| 是否读 `getSelectionCells()` / `selectedCell` | **完全没有** |

**这是一个正确、简洁、带自校验的脚本。** 它唯一"错"的地方是：它来自一次 11 秒的模型调用，而在这 11 秒里用户碰了一下画布。

顺带确认：模型说的「Line 1 中的 3 个、Line 2 的 2 个、Line 3 的 1 个、Line 4 的 1 个」也准确——文档里确实有 `Line 4`（id 22，y=571，在截图裁剪范围之外）。

---

## 5. 三个真正的缺陷

### P0｜检查项与编辑的依赖关系不匹配

这次编辑的输入只有 **label**，输出只有 **style**。它不依赖：

- 选中项（脚本从不读 selection）
- 页面内容（除了"这些 cell 还在"）

但检查把 `selectedNativeCellId` 当成硬条件。**只要用户随手点一下画布，一个与选中项毫无关系的批量改色就会被丢弃。**

同样的过严也适用于 `drawioXml`：它用的是**字符串逐字节相等**，不是语义比较。draw.io 序列化时会把当前视口 `dx/dy` 写进 XML（上一份报告 `WALNUT-TABLE-…` 已实测证实），所以用户只要在等待期间平移/缩放画布并触发一次 autosave，`drawioXml` 就会变——**语义零变化，编辑照样被扔**。这次没触发只是因为那 11 秒内 autosave 恰好没落。

### P0｜错误信息不告诉你是哪一项变了

三条件 OR 压成一句话：

> "The diagram, page, or selected target changed while Copilot was responding."

排查时只能靠"日志里没有 `drawio.document.saved`"反推。应改为携带字段级明细：

```json
{ "staleField": "selection", "before": "H4MNtB…-46", "after": null,
  "xmlChanged": false, "pageChanged": false }
```

并写一条 `copilot.request.stale-context` 诊断事件（现在**完全没有**）。

### P1｜被丢弃的合法动作没有任何回收

服务端已经 `accepted` 了这个脚本（`turn.completed.with-native-edits` 已记录 `operationCount: 1`），客户端才否决。否决之后：

- 脚本不执行
- 不重试（`copilot.native-script-repair` 只在**编辑器报错 + 回滚确认**时启动，这里是客户端中止，走不到）
- 用户只得到一句"retry"

而"retry"意味着**再花 11 秒、再花 13 万 token**，而且下一次如果用户又碰了画布，会再次失败——**这不是偶发，是只要手不老实就必然复现的循环**。

---

## 6. 为什么"选中项变化"这件事本身值得怀疑

`publishSelection`（`plugin:123-135`）只取 `cells[0]`：

```js
var cells = selectedGraph.getSelectionCells();
var cell = cells && cells.length ? cells[0] : null;
```

这意味着：

- **多选**时只上报第一个。用户 shift-click 加选一个更靠前的 cell，上报值就变了。
- 用户点空白处 → `cells` 为空 → 上报 `null`。
- 模型 `change` 事件（`plugin:144`）也会重新上报一次当前选中项——如果某个内部操作短暂清空了 selection，也会上报 `null` 再报回原值。

App 侧 `setSelectedNativeCellId(cellId)` 是**无条件覆盖**（`App.tsx:1966`），没有"只在非空时更新"的保护。于是任何一次瞬时清空都会永久污染 `selectedNativeCellId`，直到用户重新选中。

---

## 7. 成本

| 指标 | 值 |
|---|---|
| 模型调用 | 1 次（10.7 s） |
| 请求 prompt | **130,653 字符**（用户输入 26 字符） |
| 被丢弃的编辑 | 1 个正确的 7-cell 批量改色 |
| 图变更 | 0 |
| 用户可做的补救 | 只有"再发一次" |

---

## 8. 修复建议

### P0-1｜按依赖关系分级校验，而不是三合一 OR

`drawioXml` 变化必须拦（编辑基于旧快照）。但**选中项变化不应拦**——除非这次操作真的用了选中项。两种做法：

- **(a) 简单可靠**：从检查里去掉 `selectedNativeCellId`。选中项只是上下文提示，不是编辑前提；服务端解析目标时用的是 `cells` 快照 + label/id，与 selection 无关。
- **(b) 更精确**：只有当 `plan` 里存在"以选中项为目标"的操作（`target === "__selection__"` 或 `selection.cellId`）时才校验选中项。

推荐 (a)。它同时修掉了 §6 里"瞬时清空污染状态"的连带问题。

### P0-2｜`drawioXml` 用语义比较代替字符串比较

仓库里已经有 `summarizeNativeDiagramXmlDiff`（`src/model/native-edit-confirmation.ts`）和 `calculateDrawioXmlRevision`。把 `stateAfterResponse.drawioXml !== sourceXml` 换成"cell 级 diff 是否为空"，就能同时消掉 `dx/dy` 平移导致的误报——这正是上一份报告里的同源缺陷，只是那次发生在确认器、这次发生在客户端守卫。

### P0-3｜陈旧状态必须写诊断事件

新增 `copilot.request.stale-context`，带 `staleField / before / after / xmlChanged / pageChanged / selectionChanged`。当前**零诊断**，导致这次只能靠"某条日志没出现"来反推。

### P1-1｜`selectedNativeCellId` 不要被空值覆盖

`App.tsx:1966` 无条件 `setSelectedNativeCellId(cellId)`。建议改成"仅当 `cellId` 非空或用户确实清空了选择时更新"，并在插件侧区分"selection cleared by user" 与 "selection temporarily unavailable"。至少要让 `publishSelection` 在 `cells.length > 1` 时上报完整 id 列表，而不是只取 `cells[0]`。

### P1-2｜客户端否决后，别让用户从零开始

服务端已经有完整的 `plan`（含脚本与断言）。客户端否决时，可以在聊天里给一个"重试这次编辑"的按钮，直接复用同一份 plan 对新 revision 重新校验并下发，而不是让模型再算一遍。

---

## 9. 回归清单

| 测试 | 断言 |
|---|---|
| 请求期间改变选中项（xml 不变） | **编辑仍然下发**；不报 stale |
| 请求期间平移画布导致 `dx/dy` 变化（autosave 落盘） | 编辑仍下发；语义 diff 为空 |
| 请求期间真的改了 cell 内容 | 拦下，并报 `staleField: "document"` |
| 请求期间切换页面 | 拦下，并报 `staleField: "page"` |
| 任一 stale 场景 | 必有一条 `copilot.request.stale-context` 诊断事件 |
| 多选 2 个 cell 后请求 | `selectedNativeCellId` 不因 `cells[0]` 抖动而误判 |

---

## 10. 证据位置

| 内容 | 路径 |
|---|---|
| 完整会话（17 条事件，含脚本全文与模型回复） | `~/.architecture-diagram-studio/copilot/session-state/40cd01c8-405a-402b-b00a-556291fddf87-cfg-f6dddd3bdd5c8551/events.jsonl` |
| 应用事件（13 条，含 `copilot.request.failed`） | `~/.architecture-diagram-studio/logs/application-events.jsonl`（`2026-10-27T14:2*`） |
| 拦截点 | `v2/src/hooks/useCopilotIntent.ts:154-158` |
| 状态快照 | `v2/src/App.tsx:262-263` |
| 选中项写入 | `v2/src/App.tsx:1965-1968` |
| 选中项上报 | `v2/plugins/studio-selection-plugin.js:123-135`、`:1410` |
| 保存事件（用于反证 xml 未变） | `v2/src/components/DrawioFrame.tsx:1082-1085` |

**本次未修改任何代码。**
