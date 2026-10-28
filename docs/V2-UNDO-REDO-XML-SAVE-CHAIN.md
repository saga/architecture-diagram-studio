# V2 分析：在 Draw.io UI 上做 Undo / Redo，是否会保存到 XML 文件？

> 审计时间：2026-10-23 · HEAD：`8f4a672` · 范围：`v2/src`（Studio 宿主侧）+ `v2/public/drawio`（Draw.io v32.0.2 源码，bundle 自带未压缩源文件）
> 方法：从 mxGraph / drawio 源码逐行确认 undo → 事件 → postMessage 链路，再从 Studio 侧逐行确认 auto-save → HTTP → 落盘链路，最后用 `application-events.jsonl` 实际运行日志对照。

## 一、结论（TL;DR）

**会保存，链路闭环成立。** Studio 没有为 undo/redo 写任何专门代码——也不需要：Draw.io 嵌入模式把"每一次模型事务完成"（天然包括 undo、redo）都即时序列化成 `{event:'autosave', xml}` 回传宿主，Studio 收到后走已有的自动保存链写入服务器版本与 `.drawio` 源文件。undo/redo 的保存路径与用户拖拽、改样式、Copilot 批量编辑**完全同一条链**。

只有两点例外需要知晓：

1. **标签内联编辑（双击文本框内）按 Ctrl+Z**：走 textarea 自己的 `execCommand('undo')`，只撤销文字、不改模型 → 不落盘。这是正确语义（编辑还没提交）。
2. **恢复历史版本 / 打开新文件后**：原生 undo 栈被清空（见 §4.3），用户不能 Ctrl+Z 越过恢复点。

---

## 当前 main 复核（2026-10-23）

以下结论按复核时的当前 `main` 代码更新；原审计记录的 HEAD `8f4a672` 是历史基线，不能再把旧发现全部当作未修复项。

| 原发现 | 当前结论 | 处置 |
|---|---|---|
| §4.1 向 Draw.io 发送不支持的 `action: "save"` | 已修复 | 使用 `{ action: "export", format: "xml" }` 请求序列化；只允许显式 XML export 响应参与确认，并逐项验证目标单元格/属性的期望结果。普通 autosave 不会清除待确认项，匹配失败则等待超时并 fail closed。 |
| §4.2 XML 校验前更新 `lastSent` | 已修复 | 当前只在接收端通过 `isDrawioXmlDocument` 校验后，才更新 `lastSent`。 |
| §4.3 恢复版本会清空原生 Undo 栈 | 行为仍然存在，提示已补充 | 恢复本地或服务器历史版本后，状态栏说明原生 Undo/Redo 历史已重置；继续回退应使用版本历史。 |
| §4.4 409 后每次编辑都重复失败 | 已修复 | 首次 409 后熔断自动保存，不自动覆盖服务器版本；本地编辑仍留在画布。先导出本地草稿，再恢复/重新加载权威版本才解除熔断。 |
| §4.5 Undo/Redo 增加版本记录 | 保留为产品取舍 | 版本簿保留用户可见的时间线，且有数量上限；当前不按历史 hash 去重，以免隐藏一次真实的回退操作。 |
| §4.6 原生 Undo/Redo 与普通编辑共用保存链 | 仍然成立 | 无需新增专门的 Undo/Redo 保存实现。 |

409 熔断会在成功恢复服务器版本后解除；切换工作区/主图文件时也会解除。顶部保存指示不再固定显示 Saved：服务器文档会反映保存中、已保存、冲突暂停或失败；无本地文件写入权限的独立文档显示 Export to save，成功导出后显示 Exported copy，文档再有修改时自动回到 Export to save。晚到的旧上下文 409 只记诊断，不会暂停新文档。排队保存会使用文档上下文 epoch 作废已过期的操作；自动保存还会比较 XML、工作区 ID 和主图路径，避免在恢复版本或切换主图后把旧 XML 写进新文件。属性编辑在 30 秒内未得到 XML 序列化确认时，会产生诊断；对等待序列化的 Copilot 批编辑返回失败回执，而不是无限等待。

## 二、Draw.io 侧证据链（undo/redo 为什么会触发 autosave）

按事件发生顺序（全部经过逐行核对，非推断）：

1. **Studio 装载文档时携带 autosave 标志**
   `v2/src/components/DrawioFrame.tsx:160-163` 发送 `{action:"load", xml, autosave:1, ...}`；
   drawio 侧接收：`v2/public/drawio/js/diagramly/EditorUi.js:28166-28169` `data.action=='load'` → `autosave = data.autosave == 1`。

2. **装载完成后安装“模型 CHANGE 监听器”**（autosave 的全部动力来自它）
   `EditorUi.js:28789-28852`：`if (autosave && changeListener == null)` → `graph.model.addListener(mxEvent.CHANGE, changeListener)`。回调逻辑（`:28791-28833`）：`data = getData(); if (data != lastData && !ignoreChange) { msg = createLoadMessage('autosave'); msg.xml = data; parent.postMessage(...) }`——即**只要文档内容相对上一次有变化就整文档回传**，且装载期间 `ignoreChange=true` 防止自环。

3. **CHANGE 事件的触发点：任何模型事务结束时**
   - `v2/public/drawio/mxgraph/src/model/mxGraphModel.js:2005-2011`：`endUpdate` 结束时 `fireEvent(UNDO, edit)` 并调用 `tmp.notify()`；
   - `mxGraphModel.js:2033-2044`：`createUndoableEdit` 里定义的 `notify()` 向 model 发出 **`mxEvent.CHANGE`**（携带 edit/changes）。
   - 用户每次 UI 编辑（拖动、样式、删除、加节点）都是一次 `beginUpdate…endUpdate` → CHANGE 触发。

4. **Undo / Redo 明确走同一条事件**
   - 入口动作带原生快捷键：`v2/public/drawio/js/diagramly/EditorUi.js` undo/redo action（`addAction("undo", …)` 源码引用同 `app.min.js`）→ `EditorUi.prototype.undo` → `editor.undoManager.undo()`。
   - `v2/public/drawio/mxgraph/src/util/mxUndoManager.js:144-158`：`undo()` 对每个 edit 调 `edit.undo()`；
   - `v2/public/drawio/mxgraph/src/util/mxUndoableEdit.js:146-163`：`mxUndoableEdit.prototype.undo()` 重放各 change 后**结尾调用 `this.notify()`**（redo 同，`prototype.redo` 同样结尾 notify）→ 即 §第 2 步的 `notify()` → model CHANGE → autosave 回传。
   - 换句话说，**undo/redo 与普通编辑共享同一个 `endUpdate`→`notify()`→CHANGE 通路**，无需（也没有）任何专门监听。

5. **回传内容是完整多页文档**
   `EditorUi.js:27331-27335` `getData()` = `getFileData(true)`（pages 非 0 时）→ 整个 mxfile（含所有页）；zip 压缩页由 Studio 校验器解码（`drawio-xml-schema`）。

6. **内联文本编辑的撤销不会触发**：`EditorUi.prototype.undo` 在 `graph.isEditing()` 时走 `document.execCommand('undo')`，模型不变 → `data == lastData` → 无 autosave。提交编辑（焦点离开）后才有事务、才有保存。

---

## 三、Studio 侧证据链（autosave 如何变成磁盘文件）

1. **接收**：`v2/src/components/DrawioFrame.tsx:285-313` —— `receive` 对 `data.event === "save" || "autosave"` 一并处理：`data.xml === lastSent.current` 先挡（防 load↔save 自环，line 287），`isDrawioXmlDocument` 校验（line 289），然后 `onDocumentChangeRef.current(data.xml)`（line 307）。
2. **进入 React 状态**：`App.tsx:986` `onDocumentChange={(nativeXml) => { setNativeXmlOverride(nativeXml); … }}` —— 活动文档唯一来源更新。
3. **自动保存**：`v2/src/hooks/useWorkspacePersistence.ts:41-52` —— `[drawioXml…]` 变化 → 250ms 防抖 → `persistDocumentNow(drawioXml, saveLabelRef.current)`；`saveQueueRef` 串行化（line 38 吞掉队列尾部错误，链不断）。
4. **乐观并发保存**：`persistDocumentNow`（line 15-40）PUT `/api/workspace/document` 带 `baseRevision = serverRevisionRef.current`；409 抛出并 `workspace.persist.conflict` 诊断。
5. **服务端**：`v2/server/copilot-server.ts:604-683` —— `withDataWrite` 串行 → `isWorkspaceSaveContextCompatible` + `matchesWorkspaceRevision`（`storage.ts:16-28`，sha256 双检）→ 内容与当前状态不同才新建 `DiagramVersion`（`:632-656`，相同内容 `saved:false` 不产生版本）→ `writeTextAtomic` **原子写主图源文件**（`storage.ts:4-9`，临时文件+rename）→ workspace state JSONL 事件 → 200 带新 `workspaceRevision` → `serverRevisionRef` 更新（persistence 层 line 32），下一轮 autosave 继续连贯。

### 实证对照（`~/.architecture-diagram-studio/data/application-events.jsonl`，2026-10-22 会话）

```
22:31:21.625 drawio.selection.property.requested            ← Copilot 批量编辑注入插件
22:31:21.643 drawio.message.first_seen  event=autosave …     ← 插件 endUpdate→CHANGE→autosave
22:31:21.646 drawio.document.saved {event:'autosave'}        ← Studio 收到回传
22:31:21.649 copilot.native-batch.step.applied / acknowledged
22:31:21.968 workspace.version.persisted {versionId:'v-…'}   ← 440ms 内已写盘
22:33:15.588 drawio.selection.property.save_confirmed …      ← 迟到的确认（见 §4.1）
22:33:15.592 drawio.document.saved {event:'autosave'}        ← 用户后续操作再次触发，又生成版本
22:33:15.877 workspace.version.persisted {versionId:'v-…'}
```

`autosave` 事件真实存在、Studio 真实落盘——undo/redo 复用它的机制在源码层已经证明（§2.4），无需改代码。

---

## 四、发现的边界与问题（按严重度）

### 4.1 · P2 `{action:"save"}` 是死消息（Draw.io 没有该处理器）
- Studio 在属性编辑 ack 后发送 `postMessage({action:"save"})`（`DrawioFrame.tsx:243-246`），注释称"编程修改不总触发 autosave，需要强制序列化"。
- 但 drawio v32.0.2 的嵌入消息分发器**没有 `data.action=='save'` 分支**（`EditorUi.js` 全部 `data.action ==` 列表：dialog/layout/prompt/draft/textContent/status/spinner/exit/viewport/invokeAction/resetEditor/fit/viewbox/fullscreenChanged/snapshot/export/template/load/merge/patch/getDiff/resetDiff/remoteInvoke*，无 save）→ 落入 `:28734-28740` 的 `unknownMessage` 兜底，回发 `{error:'unknownMessage'}` 给宿主（Studio 的 `receive` 无 `event` 字段，静默忽略）。
- **实际序列化根本不靠它**：插件批编辑在 `endUpdate()`（`studio-selection-plugin.js:192`）→ model CHANGE → autosave（日志 22:31:21.643 证实，早于 ack 3ms）。`setModified(true)` 只影响编辑器状态栏。
- 日志佐证：`save_requested`（22:31:21.661）后 **114 秒**才出现 `save_confirmed`（22:33:15.588）——pendingSaveConfirmationsRef 挂起条目实际上等到了一次不相关的后续 autosave 才被 flush，`durationMs` 读数是用户行为间隔，不是保存耗时（诊断页读起来有误导）。
- **建议**：改发真实存在的 `{action:"invokeAction", actionName:"save"}`（`EditorUi.js:27688-27697` 支持），或直接删掉强制 save 依赖 autosave 通道；同时把 pendingSaveConfirmationsRef 加超时回收，避免旧确认条目跨请求误记。

### 4.2 · P2 `lastSent` 在 XML 校验前赋值
- `DrawioFrame.tsx:287` 先 `lastSent.current = data.xml`，`:289` 才校验；若 drawio 返回非法 XML：`lastSent` 记下了一个从未被采纳的值，且此时 React 状态留的是上一个合法 xml——编辑器画面与 Studio 状态分叉（编辑器显示非法文档、Studio 仍是旧文档），状态对不齐但不会死循环。
- **建议**：把 `lastSent` 赋值移到 `isDrawioXmlDocument` 校验成功之后（与 `setStartupError` 一起构成"拒收后保持旧基线"）。

### 4.3 · info（需知晓，非缺陷）恢复版本/重开会清空原生 Undo 栈
- 任何 `load` 动作 → `Editor.setGraphXml` → `editor.setModified(false); editor.undoManager.clear()`（`grapheditor/Editor.js` 相应源码路径；也为 `EditorUi.js:28149-28151` `setFileData` 装载共用）。
- 后果：在"历史 → Restore 版本"或切换工作区/文件后，用户 Ctrl+Z **不能撤销越过恢复点**；原生编辑器从恢复内容重新起算。这是 Draw.io 继承行为，fail-safe 方向（不会丢内容），但 UX 上值得在恢复提示里说明。

### 4.4 · P2 保存冲突（409）后自动保存会持续失败，靠手动恢复
- `useWorkspacePersistence.ts:23-30`：409 → 提示 + `workspace.persist.conflict`（error）→ **不更新 baseRevision、不禁用后续自动保存**；每次画布编辑（包括 undo/redo）都会再触发一次 409，诊断日志刷屏，直到用户点击"History → Restore 最新版本"（`restoreVersion` 成功后 revision 对齐）。
- undo/redo 与此无关：服务端 revision 校验的是 sha256（`storage.ts:30-32`），编辑器本地 undo 栈解决不了 cross-tab/restore 造成的冲突。
- 属于既定的 fail-closed 设计，单浏览器本地场景几乎不会触发；但可以加两个小缓解：409 后暂停自动保存（等用户显式动作/恢复）；或冲突后自动拉取 `/api/workspace/state` 对比，若客户端无未保存独占编辑则静默对齐 revision。任选其一即可，不建议自动覆盖。

### 4.5 · P2 每个"内容有变化的动作"都生成一个版本（undo/redo 会加速版本簿）
- 服务端仅对**当前状态**去重（`copilot-server.ts:632` `unchanged` 判定基于 `workspaceState.drawioXml` 与本次提交的比较），不与历史版本去重：编辑→undo→会被记成两个版本（undo 后的旧状态也会成为新版本）。
- 上限：每工作区/每图 100 个版本、全局 500 个（`copilot-server.ts:243-244`），满后挤掉最旧的。频繁 undo/redo 快速消耗历史空间——无数据风险，只是历史列表噪音。如在意，可加"相邻版本内容 hash 相同跳过"或把 undo 场景的 label 标为 "Autosave (undo)"。

### 4.6 · info 客户端确认过无收口问题的链路
- `DrawioFrame` 消息守卫：来源校验（`:200-212` origin/source + 无效 JSON 丢弃）、`autosave`/`save` 全文校验、批结果拆解逐条记录诊断；
- 装载协议不会死循环：load → `ignoreChange=true` → 装载后 `lastData=getData()` 基线（`EditorUi.js:28781`）→ 归零；Studio 侧 `lastSent` 同步基线（`DrawioFrame.tsx:287/164`）；
- Copilot 批编辑具备用户级可撤销性：插件编辑全部经 `model.beginUpdate/endUpdate` 包装 → model `UNDO` 事件 → `Editor.createUndoManager` 收进 undo 栈（`grapheditor/Editor.js:1668-1670`），因此**用户 Ctrl+Z 可以撤销 Copilot 刚做的修改**，撤销结果同样走 autosave 链落盘；
- 失败批次的回滚在同一个事务内做补偿（`studio-selection-plugin.js:140-189`），事务结束状态即"未应用"，不会污染 undo 栈或落盘内容，仅多一条 `copilot.native-edits.failed` 诊断。

---

## 五、场景覆盖表

| 场景 | 是否落盘 | 通道 |
|---|---|---|
| 画布拖动/改样式/删除/加节点（用户手动） | ✅ | 模型事务 endUpdate → CHANGE → autosave → PUT |
| **Ctrl+Z / Ctrl+Shift+Z（canvas 级 undo/redo）** | **✅** | `mxUndoableEdit.undo()/redo()` 结尾 `notify()` → CHANGE（同一通路） |
| 菜单 Edit → Undo / Redo | ✅ | 同上（action 入口不同，终点相同） |
| 标签内联编辑中的 Ctrl+Z（textarea 撤销） | ❌（未提交编辑，符合预期） | `graph.isEditing()` 分支，无模型事务 |
| Copilot 批量编辑及用户随后撤销 | ✅ | 插件事务 → CHANGE → autosave；undo 同 |
| 独立文件模式（有本地写权限 handle） | ✅ | `App.tsx:361-382` 250ms 防抖直写本地文件 |
| 独立文件模式（无 handle，系统不支持） | ❌ 需手动 Export（设计如此） | `App.tsx:572` |
| 恢复版本后立即 undo | ❌（新基线生效） | load 清空 undoManager（§4.3） |

## 六、建议（按当前 main 复核后的处置）

1. **已完成**：使用 Draw.io 支持的 `export` 序列化协议；XML 先校验再更新 `lastSent`；属性编辑确认增加 30 秒超时。
2. **已完成**：服务端 revision 返回 409 后暂停后续自动保存，并在显式恢复服务器版本或切换工作区/主图时解除；不自动覆盖较新版本。
3. **已完成**：恢复历史版本时提醒原生 Undo/Redo 栈已重置；排队 autosave 还会校验主图路径。
4. **暂不做**：历史版本 hash 去重。undo/redo 回到既有内容仍是一项用户可见操作，是否合并版本属于历史产品语义，不应为减少日志而擅自抹掉时间线。版本数量上限已控制存储增长。

主链（undo/redo → 保存到 XML 文件）**无需另建任何保存实现**。


## 2026-10-23 追加复核：确认请求必须与预期编辑结果对应

### 修复：禁止把任意不同的 XML 快照当作 Copilot 编辑确认

旧逻辑在收到 save、autosave 或 export XML 后，会遍历并清除全部 pendingSaveConfirmationsRef 项；只要 XML 与编辑前快照不同，就把待确认批编辑作为成功回执。这会把同一时刻发生的无关用户编辑误认为 Copilot 修改已被序列化。

当前实现调整为：

- save / autosave 只更新当前原生 XML 与保存链，不消费属性编辑确认。
- 只有带 format: "xml" 的显式 export 响应才尝试确认待处理编辑。
- 通过 nativeEditIsReflectedInXml 读取完整 Draw.io XML（包括压缩页），验证目标 cell、属性和值是否体现请求结果；批量编辑要求每一项操作都能在快照中验证。
- 不匹配的快照只记录 drawio.selection.property.save-confirmation.unmatched，保留超时计时器和待确认项；未知操作按 fail-closed 处理，不发虚假的成功回执。
- 页面 ID 随待确认记录一起保存，避免同一文档不同页具有相同 cell ID 时跨页匹配。
- 增加单元测试覆盖无关节点变化、批量操作缺项和压缩页面的确认场景。

协议限制：Draw.io 的 embed export 响应没有透传 Studio 请求 ID，因此无法用 request ID 做一对一相关联。当前采用“显式 export + 请求结果内容匹配”的确认方式；不匹配时宁可报告超时，也不把无关快照误认为成功。

### 仍需明确的持久化边界

/api/workspace/document 已加入补偿式写入：先记录主图文件原内容，再按版本索引、主图文件、workspace state 的顺序执行；后续步骤失败时按逆序恢复已完成的步骤。若恢复动作本身失败，错误会显式带出 compensation was incomplete，不能静默当作保存成功。版本写入、主图写入与 workspace state 写入的原子性仍是逐文件级别，不是跨文件系统事务，也不能保证进程被强制终止或机器断电时绝无中间状态。版本事件与诊断日志改为 best-effort，不会因为提交之后的日志失败而向客户端误报文档保存失败。新增存储层测试覆盖补偿回滚顺序和回滚失败的显式报告。

### 验证状态

本次代码改动新增 native-edit-confirmation.test.ts，覆盖核心内容匹配规则。还需通过仓库自身的 npm test、npm run typecheck、npm run build 与原生 Draw.io E2E 验证；源码提交本身不等于这些命令已通过。


## 2026-10-25 统一 Undo/Redo 接入说明

Undo/Redo 的所有权仍属于 Draw.io 原生 `undoManager`。Studio 没有引入第二个快照撤销栈：画布工具栏、宿主级键盘快捷键和插件中的可用态，都代理原生历史入口。按钮可用态根据当前原生 undo/redo 状态更新；命令执行时插件会再次检查，防止延迟状态导致空栈操作。键盘代理不会拦截 Studio 的输入框、文本域或 contenteditable 文本编辑。

颜色预设之前直接改写整份 XML 并通过 `setNativeXmlOverride` 重载文档，这会清除原生撤销栈。现在颜色预设先由 TypeScript 根据当前页计算 revision-bound plan，再由 Draw.io 插件在活动页用单个模型事务应用。该事务与手工编辑、Copilot 批次和自动布局使用同一 native history / autosave 机制。颜色预设仅应用于当前页；多页文档的页面切换本身不当作文档边界，只有 open/load/import/restore 建立新的历史基线。

颜色事务完成后，Studio 通过原生 XML export 获取已序列化的完整文档，并复用现有工作区持久化或独立文件写入路径。Undo/Redo 的持久化通路保持不变：原生模型 CHANGE → Draw.io autosave XML → Studio XML 校验与状态更新 → 250ms 防抖持久化。恢复版本后撤销栈按 Draw.io 原生语义清空，继续浏览旧状态仍应使用 History。

验证清单：颜色预设与已有颜色规则的单元测试、压缩页与多页计划测试、预设一步 Undo/Redo 与快捷键 E2E、自动布局几何一步 Undo，以及现有 typecheck / unit / build / E2E CI。对尚未完成的 CI 不应提前标记通过。

## 2026-10-25 失败事务不得污染原生 Undo/Redo 栈

原生模型事务发生异常后，如果补偿写入已恢复原值，仍不能直接认为撤销历史也保持不变。Draw.io 在最外层 `endUpdate()` 时根据当前 edit 的 changes 集合生成 undoable edit；若把“先改、再补偿改回”的所有 change 一并提交，就可能产生一个实际无效果的 Undo 项，并清空原本可用的 Redo 栈。

当前插件在开始 Studio 原生事务前记录 pinned Draw.io 模型的 `currentEdit.changes` 检查点。仅当颜色预设、自动布局或原子批处理的补偿恢复成功且结构验证通过时，才移除该检查点之后的事务 change，再结束外层事务。这样失败但完整恢复的操作不会进入 Undo 栈，也不会清掉 Redo 栈。若模型检查点不可用、补偿不完整或原生 cell 树验证失败，则不会将该操作伪装为干净回滚；错误回执会显式标记恢复未获确认，保留可供用户恢复的原生状态。

新增 `v2/src/model/native-undo-rollback.test.ts`，通过实际插件消息桥测试“颜色事务中途失败并恢复”与“批编辑第二步失败并恢复”两条路径，断言既有 Undo/Redo 栈与 cell 样式均未变化。它是当前 pinned Draw.io `mxGraphModel.currentEdit.changes` 实现的防回归测试；如果未来升级 Draw.io 并改变事务内部结构，测试需要随升级一起验证。


## 5. 2026-10-28 复核补充：确认回执必须绑定真实序列化结果

后续实现已将宿主请求改为 `{ action: "export", format: "xml" }`，而不是不存在的 `action: "save"`。因此，旧版 §4.1 关于当前代码仍发送 `action:"save"` 的描述已过时；当前确认流程等待 XML export/autosave 消息，并由 `pendingSaveConfirmationsRef` 的超时回收关闭未完成请求。

仍需遵守的状态边界：

- Draw.io bridge 的成功回执只表示编辑器执行阶段结束，不等于 XML 已序列化、工作区已落盘或服务器 ack 已接受。
- `changed-unverified` 必须保持失败/待人工检查语义；即使为诊断目的保存了实际 XML，也不能把它报告为已验证成功。
- 工作区模式只有在保存接口返回的 revision 与序列化 XML revision 一致、且取得 version ID 后，才能报告持久化成功；独立文件模式必须等待浏览器文件句柄写入完成。
- 迟到的 native-edit 结果需要以原始 requestId 幂等关闭服务端回执；不得把超时后的旧结果归属到新的编辑请求。

本补充是代码路径的复核记录，不代表已经完成所有并发竞态的 E2E 验证。当前 CI 状态未能从 GitHub 获取到可用的 workflow run 记录。
