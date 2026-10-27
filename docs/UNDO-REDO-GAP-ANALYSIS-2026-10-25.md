# Undo / Redo 一致性缺口分析

> 审计时间：2026-10-25 · HEAD：`02570e5` · 范围：`v2/src`（Studio 宿主）+ `v2/plugins`（本地 Draw.io 插件）+ `v2/public/drawio`（pinned Draw.io v32.0.2，含未压缩源码）
> 方法：从 mxGraph/draw.io 源码确认 undo 栈的**入栈条件**，再从宿主侧逐个操作确认它是否满足该条件；最后用 `docs/V2-UNDO-REDO-XML-SAVE-CHAIN.md` 的既有结论交叉验证。

---

## 一、结论（TL;DR）

1. **现状是"半套 undo"**：draw.io 原生 undo 只覆盖**模型事务**；app 级操作（Diagram colors 预设、打开/导入、版本恢复）走**整文档 XML 替换**，必然清空原生 undo 栈，且无法 Ctrl+Z 越过该点。

2. **"把 app 级操作映射到内置 draw.io 的 undo"这个方向是对的，而且对 theme preset 具体可行**——它只改 cell 的 `fillColor` / `strokeColor` / `fontColor`，正好落在 `graph.setCellStyles()` 的表达范围内。这不是妥协方案，而是**回到 ADR 已经规定的架构**（ADR-0011 §2、ADR-0008 §7）。

3. **比"能不能撤销"更基础的问题被漏掉了：焦点边界。** 宿主侧完全没有键盘处理（`src/` 里 `metaKey|keydown|ctrlKey` 零命中）。用户点过任何 Studio 控件（Theme 下拉、布局按钮、属性输入框）之后焦点在宿主文档里，此时 **Cmd+Z 连原生 undo 都不会触发**。这很可能是"感觉 undo 没了"的直接来源。

4. **真正不该进 undo 的是文档边界操作**：打开文件、导入、切换工作区、版本恢复、切页。这些已经在 History（服务端版本 + standalone 快照）里有正确归宿，不要往 undo 栈里塞。

5. 现状唯一"看起来自洽"的操作是自动布局：它已经走模型事务，**一次 Ctrl+Z 能整体回退**——可以作为 theme preset 改造的现成模板。

---

## 二、现状基线

### 2.1 app 级 undo 是被哪次提交删掉的

```
7933787  Delete semantic document editing, auto-layout, undo/redo and diagram-kind switching
         (2026-10-22, v2/src/App.tsx, 1 insertion, 167 deletions)
```

被删掉的东西（`git show 7933787`）：

- `historyRef`：最多 50 个 XML 快照的数组
- `historyIndexRef`：当前指针
- `canUndo` / `canRedo` 状态
- `undoDocument()` / `redoDocument()`：把快照写回 `nativeXmlOverride`
- 诊断事件 `diagram.history.undo` / `diagram.history.redo`

删除动机是合理的（语义层整体下线，快照式 undo 与"XML 单一事实来源"重复）。但**没有为"非语义的 app 级操作"留替代方案**——theme preset 就是漏出来的那一个。

### 2.2 现在仅存的 undo 痕迹

| 位置 | 内容 |
|---|---|
| `App.tsx:1190` | 一句状态提示："native Undo/Redo history was reset. Use version history…" |
| `src/` 全目录 grep `Undo\|Redo` | **只有上面这 1 处**，没有任何按钮、菜单项、快捷键 |
| `src/` 全目录 grep `metaKey\|keydown\|ctrlKey\|onKeyDown` | **零命中** |
| `plugins/studio-selection-plugin.js:192` | `undoManager` 被放进 runtimeMethods（只读巡检用，未对外暴露 canUndo） |

现有"粗粒度回退"只有 History：
- 工作区：服务端 `DiagramVersion`（每图 100 个、全局 500 个，`copilot-server.ts:243-244`）
- standalone：`synchronizeStandaloneSnapshot()` 快照（`App.tsx:1101`）

---

## 三、三条边界：原生 undo 到底能接住什么

### 3.1 模型事务边界 —— 能接住

入栈链路（逐行核对）：

```
model.beginUpdate()
  … setStyle / setGeometry / setValue / setTerminal / add …
model.endUpdate()
  → this.currentEdit.isEmpty() === false
  → fireEvent(mxEvent.UNDO, 'edit', tmp)            mxGraphModel.js:1989-2019
  → Editor.createUndoManager 的 listener            grapheditor/Editor.js:1652-1670
  → mxUndoManager.undoableEditHappened(edit)        mxgraph/src/util/mxUndoManager.js
```

**关键推论：入栈条件与"是否走了 draw.io 的 UI 命令路径"无关**，只与"是否在 `beginUpdate/endUpdate` 内写了 model"有关。所以插件里那些被注释描述为"bypass Draw.io's normal UI command path"的编程式修改（`studio-selection-plugin.js:1042-1044`），**照样能 Ctrl+Z**——那句注释说的是 `setModified` / 导出确认，不是 undo。

由此可直接判定为**可撤销**：

| 操作 | 实现 | 证据 |
|---|---|---|
| 属性面板编辑 | `NativeSelectionInspector` → `cellEdit` → plugin `editCell` | `studio-selection-plugin.js:1040` 单事务 `endUpdate` |
| 自动布局 | `runAutoLayout` → `applyAutoLayout` → `applyNativeLayoutPlan` | `plugin:361` 函数内一次 `beginUpdate` + N 次 `setGeometry` |
| Copilot 批量编辑 / C4 转换 | `cell:batch` → `model.setValue/setStyle/setTerminal` | 同上事务包装 |
| 画布内任何手工操作 | draw.io UI | 原生 |

**自动布局是现成范本**：一个 `beginUpdate/endUpdate` 包住全部 `setGeometry`，用户按一次 Ctrl+Z 整体回退，并且 `endUpdate` → `notify()` → autosave 自动落盘（`V2-UNDO-REDO-XML-SAVE-CHAIN.md` §2.4 已验证）。

### 3.2 load 边界 —— 接不住

```
setNativeXmlOverride(nextXml)                      App.tsx:640 / 659 / 678
  → drawioXml 变化 → <DrawioFrame xml={drawioXml}> App.tsx:1605
  → useEffect: xml !== lastSent.current            DrawioFrame.tsx:302-303
  → postMessage({action:"load", xml, autosave:1})  DrawioFrame.tsx:316-319
  → draw.io App.loadEmbedded: setFileData(f) …
    → this.editor.undoManager.clear()              app.min.js（offset ≈ 9,232,536）
```

`load` 之后原生栈被 `clear()`，**历史不可穿越**。这就是 `V2-UNDO-REDO-XML-SAVE-CHAIN.md` §4.3 记录的行为，当时判定为"info / 需知晓"，但它成立的前提是"只有版本恢复和打开文件才会 load"——**theme preset 也 load，这个前提已经破了**。

对照组：draw.io 自己的编辑不会触发 load，因为 `DrawioFrame.tsx:687` 在 `onDocumentChange` 之前先执行 `lastSent.current = data.xml`，把回传的 XML 记为基线，`xml === lastSent.current` 于是跳过 load。这条"回声抑制"是整套设计能工作的关键。

### 3.3 焦点边界 —— 连原生 undo 都够不着

- draw.io 的 Ctrl+Z 是 `Actions.js:147` 注册的 iframe 内快捷键
- 宿主没有任何 keydown 监听
- 用户操作 Studio 控件后焦点在宿主文档里 → 按键不会进 iframe → **没有任何一层响应**

所以"undo 没了"实际是三种失效叠加：① 焦点不在画布时键盘完全失效；② app 级操作不进栈；③ app 级操作会把栈清零。

---

## 四、逐操作归类表

| 操作 | 入口 | 改动方式 | Ctrl+Z 可撤 | 判定 |
|---|---|---|---|---|
| 画布拖动 / 改样式 / 删除 / 连线 | draw.io UI | model 事务 | ✅ | 正常 |
| 属性面板编辑（label/style/geometry/attr） | `App.tsx:1803` → `cellEdit` → `plugin:editCell` | model 事务 | ✅ | 正常 |
| 自动布局（Dagre / ELK） | `App.tsx:1217` → `frame.applyAutoLayout` → `plugin:361` | 单事务 `setGeometry` | ✅ 一次回退全部 | 正常，**可作范本** |
| Copilot 批量编辑、C4 类型转换 | `cell:batch` | model 事务 | ✅ | 正常 |
| **Diagram colors 预设（4 套）** | `App.tsx:591` `applyDiagramTheme` | **XML 全量重写** `applyDrawioDiagramTheme` | ❌ 栈被清空 | **本次缺口** |
| 打开 / 导入 / 切工作区 / 切主图 | `App.tsx:380 / 894 / 929` | load | ❌ | 文档边界，合理 |
| 恢复版本 / standalone 快照 | `App.tsx:1186 / 1151` | load | ❌ | 文档边界，已有提示 |
| 画布背景色（`studioSetBackground`） | `plugin:1115` | 直接改 `graph.background` | ❌ | 视图属性非 model；当前未暴露给用户 |

**只有一个操作真正"缺位"：theme preset。** 其余不可撤销项都属于文档边界，语义上就不该由 undo 承担。

---

## 五、根因：ADR 的假设缺一个前提

ADR 已经把 undo 的所有权交给了 draw.io：

> **ADR-0011 §2**：The bundled Draw.io editor owns interactive editing, selection, **undo/redo**, geometry, styles and relationships. Use its native model for editor-side changes.

> **ADR-0008 §7**：Property edits are sent through a validated same-origin message bridge and are **applied by Draw.io's own graph model so normal undo/autosave behavior is preserved**.

这个决定成立需要一条隐含前提：

> **所有"内容级"修改都必须表达为 model 事务。**

今天唯一违反该前提的是 theme preset。而它出现的时间顺序很关键：

```
7933787  删掉 app 级 undo + 语义层          （2026-10-22）
02570e5  fix: apply color presets to native Draw.io diagrams   （更晚）
```

theme preset 是**后加的**，加的时候选了最省事的实现：`src/model/drawio-theme.ts` 做纯 DOM 字符串变换，然后在 App 里 `setNativeXmlOverride` 触发整文档 load。两条线各自都自洽，合起来就漏了一个"内容级但非模型级"的操作。

顺带说明：`drawio-theme.ts` 的实现质量本身没问题（`safeColor` 校验、只改颜色键、保留未知 XML、支持压缩页），**问题只在执行通道选错了层**。

---

## 六、三条路线对比

| 维度 | A：theme 映射到原生 model | B：恢复 app 级快照 undo 栈 | C：不做 undo，改"可逆操作 + History" |
|---|---|---|---|
| theme 能否 Ctrl+Z | ✅ 与手工编辑同一个栈 | ✅ 但是第二个栈 | ❌ |
| 是否保留视图（缩放/选中/滚动） | ✅ 无 load | ❌ 每次 undo 都 load | ✅ |
| 与 ADR-0008/0011 一致性 | ✅ 完全一致 | ⚠️ 引入第二套历史语义 | ✅ 不新增机制 |
| 能否覆盖未来的 app 级操作 | ⚠️ 只覆盖"模型可表达"的 | ✅ 任意 XML 变换都能覆盖 | ❌ |
| 实现成本 | 中（新插件消息 + 计划计算 + 多页处理） | 中（快照栈 + 按钮 + 冲突处理） | 低（一次反操作） |
| 主要风险 | 多页语义、文本节点特例、撤销粒度 | 两套 undo 让用户无法预测 Ctrl+Z 行为；undo 自身又会清空原生栈 | 不是 undo，用户仍要手动点 |

**结论：A 为主，B 不做，C 作为兜底补丁。**

B 的致命问题是"双栈"：Ctrl+Z 在画布内撤销 draw.io 的栈，在画布外撤销 App 的栈，用户无法建立稳定心智模型；而 App 栈的 undo 又通过 load 实现，会把 draw.io 栈清零——两个栈互相破坏。

---

## 七、推荐落地路径（三步，可独立发布）

### Step 1 · 宿主级 undo/redo 代理（小改动，立刻解决 3.3 焦点边界）

**目标**：无论焦点在哪，Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z 都能驱动原生 undo；工具栏出现可用的 Undo/Redo 按钮。

draw.io 的 embed 协议已经支持，不需要改 bundle：

```js
// diagramly/EditorUi.js:27688
else if (data.action == 'invokeAction') {
  var action = this.actions.get(data.actionName);
  if (action != null) action.funct();     // 'undo' → ui.undo() → editor.undoManager.undo()
}
// grapheditor/Actions.js:147
this.addAction('undo', function() { ui.undo(); }, null, '', Editor.ctrlKey + '+Z');
```

实现要点：

1. `DrawioFrame` 暴露 `undo()` / `redo()`，内部发 `{action:"invokeAction", actionName:"undo"|"redo"}`
2. `App` 加 `window.addEventListener("keydown")`：`(metaKey||ctrlKey) && key==='z'` → 代理；注意排除宿主自身的输入框（`target.closest('input,textarea,[contenteditable]')` 时放行给浏览器原生文本撤销）
3. 按钮禁用态：`invokeAction` **不检查 `action.isEnabled()`**（直接调 `funct()`），所以必须自己维护 canUndo/canRedo
4. 状态回传最省事的方式：`plugin` 里 `model.addListener("change", publishSelection)` 已经存在（`plugin:1132`），在 `publishSelection` 的 payload 里附加 `canUndo: ui.editor.undoManager.canUndo()`、`canRedo: …`；`DrawioFrame` 的 `onSelectionChange` 已有通道，扩一个可选字段即可
5. 工具条位置：`.canvas-toolbar-actions` 最左，与现有紧凑按钮同规格

风险：低。不改任何数据路径，纯代理。

### Step 2 · theme preset 改走模型事务（核心修复）

**目标**：切换配色变成一次可 Ctrl+Z 的模型编辑，不再 load，不再清栈，视图和选中保留。

沿用自动布局的"宿主算计划 + 插件执行"范式（`calculateNativeAutoLayout` / `applyAutoLayout` 已经在跑）：

1. **计划在 TS 侧算**（保持单一事实来源，不把配色规则复制进 plugin）
   复用 `drawio-theme.ts` 的判定逻辑，产出：
   ```ts
   type NativePalettePlan = {
     pageId: string;
     documentRevision: string;              // sha256，与 layout 同一套乐观校验
     changes: Array<{
       cellId: string;
       values: Record<string, string>;      // {fillColor, strokeColor, fontColor}
     }>;
   };
   ```
   `isTextOnlyVertex` 的 `{fillColor:"none", strokeColor:"none"}` 特例在计划里直接固化。

2. **插件新增 `studioApplyPaletteRequest`**，与 `studioNativeLayoutRequest` 并列：
   ```
   model.beginUpdate()
     for each change: graph.setCellStyles(key, value, [cell])   // 或直接 model.setStyle
   model.endUpdate()
   ```
   必须做到：
   - 校验 `plan.pageId === currentPageId()`、`plan.documentRevision === 当前 XML revision`（照抄 layout 的 fail-closed 前置检查）
   - 校验每个 cellId 存在且 vertex/edge 类型与计划一致
   - **changes 为空时不要开事务**（空事务不产生 undo 条目，但会白白触发 refresh）
   - 失败回滚：事务内恢复快照，与 layout 的 `snapshots` 写法一致

3. **序列化确认**：复用 layout 的 `action:"export"` 回传通道（`DrawioFrame.tsx:620-693`），拿到 XML 后走既有 `persistDocumentNow` / `enqueueStandaloneSave`，保存链零改动。

4. **撤销粒度**：一次换色 = 一个 undo 条目。`model.endUpdate` 的 `currentEdit` 天然聚合，不需要额外处理。

5. **多页问题（A 的主要成本，需先决策）**

   `applyDrawioDiagramTheme` 今天会处理**所有页**（含压缩页，`drawio-theme.ts:186-204`）。而模型事务只能触达**当前活动页**。三个选择：

   | 选项 | 行为 | 成本 |
   |---|---|---|
   | A1 | 只对当前页生效，UI 文案改为 "Diagram colors (this page)" | 最低，但语义收窄 |
   | A2 | 插件逐页切页应用（`ui.currentPage` 可读，切页 API 需 spike） | 中，且撤销条目会跨页、当前页状态要还原 |
   | A3 | 当前页走模型（可撤销），其余页仍走 XML 重写 | 高复杂度，两套语义并存，不推荐 |

   **建议先做 A1**：绝大多数架构图是单页；如果确实需要全页，再把 A2 作为独立迭代（届时撤销语义按页记录，比"一个 undo 回退所有页"更符合直觉）。

6. **状态一致性**：undo 之后 `diagramTheme` 选择器要能反映实际配色。建议不再把 `diagramTheme` 当作权威状态，而是从当前 XML 反推（或干脆在 undo 后清空为 `""`，显示 "Diagram colors" 占位）。

### Step 3 · 兜底：不可模型化操作给"反操作"

未来若再出现"内容级但无法表达为 model 事务"的操作，不要恢复快照栈，而是给它一个**显式反操作**：

- 换色：记录上一套 palette → 状态栏 / toast 提供 "Revert to <上一套>"
- 任何 XML 级变换：把 `beforeXml` 存在操作句柄里，提供 "Revert this change"（一次 load，可接受，因为是用户显式点击）

这条兜底的成本很低，且不会制造第二套历史语义。

---

## 八、实施细节与坑

1. **`invokeAction` 不做 enabled 检查**（`EditorUi.js:27688` 直接 `action.funct()`），按钮态必须自维护，否则会在空栈时抛错或静默无效。

2. **不要用 `setModified(true)` 当"已变更"信号**（`plugin:1044`）：它只影响编辑器状态栏。落盘靠 `endUpdate` → `notify()` → CHANGE → autosave（`V2-UNDO-REDO-XML-SAVE-CHAIN.md` §2.4）。

3. **`lastSent` 回声抑制不能破**（`DrawioFrame.tsx:687`）：Step 2 之后 theme 不再改 `xml` prop，但"插件编辑 → export → onDocumentChange"这条链仍然依赖 `lastSent` 先更新再通知宿主，改代码时别动顺序。

4. **压缩页**：模型事务天然绕开压缩编码问题（draw.io 内部已解码），这实际上是 A 方案相对 XML 重写的一个额外好处——`drawio-theme.ts` 里 `encodeCompressedPage` 那条路径在 Step 2 之后只服务 A2/导出场景。

5. **版本簿噪音**：undo 也是一次内容变化，会生成新版本（`V2-UNDO-REDO-XML-SAVE-CHAIN.md` §4.5 已判定为产品取舍）。Step 2 落地后"换色 + 撤销"会占 2 个版本位，属可接受。

6. **不要在宿主 keydown 里拦 `Cmd+Z` 拦得太死**：属性面板的 `<textarea>`（`NativeSelectionInspector.tsx:102`）里用户期望撤销的是文字，不是图形。

7. **`ui=min` 主题下没有可见的 undo 按钮**，所以 Step 1 的宿主按钮是唯一可见入口；draw.io 菜单里的 `Edit → Undo` 仍然可用（`min` 主题把面板降级为菜单 toggle，不影响 action 注册）。

---

## 九、测试计划

| 层级 | 用例 |
|---|---|
| 单元（plugin） | 空 changes 不产生事务；pageId/revision 不匹配时 fail-closed 且不改动任何 cell；类型不符（vertex→edge）拒绝；文本节点走 `fillColor=none` 分支 |
| 单元（TS） | `plan` 与 `applyDrawioDiagramTheme` 对同一份 XML 产出**等价的颜色结果**（回归对比测试，防止两条实现漂移） |
| E2E | ① 换色 → Ctrl+Z → 颜色回退且 `diagramTheme` 显示一致；② 换色 → 点工具栏（焦点移出画布）→ Ctrl+Z 仍生效；③ 自动布局 → Ctrl+Z 整体回退（现状回归）；④ 换色后缩放/选中保持；⑤ 版本恢复后 Ctrl+Z 不越界（现状保留） |
| 诊断 | 新增 `drawio.palette.applied` / `drawio.palette.rejected`，与 `drawio.layout.ui.*` 同规格 |

---

## 十、证据索引

| 结论 | 证据 |
|---|---|
| app 级 undo 被删除 | `git show 7933787 -- v2/src/App.tsx`（167 行删除） |
| theme preset 后加、走 XML 重写 | `02570e5`；`App.tsx:591-690`；`src/model/drawio-theme.ts:177-207` |
| 模型事务 → undo 栈 | `mxgraph/src/model/mxGraphModel.js:1989-2019`；`grapheditor/Editor.js:1652-1670` |
| 插件编辑也是模型事务 | `plugins/studio-selection-plugin.js:1040-1045` |
| 自动布局单事务 | `plugins/studio-selection-plugin.js:361`（`beginUpdate` → N×`setGeometry` → `endUpdate`） |
| xml prop 变化触发 load | `DrawioFrame.tsx:302-330` |
| load 清空 undo 栈 | `app.min.js`（`loadEmbedded` 内 `… chromelessResize && this.chromelessResize(); this.editor.undoManager.clear()`） |
| 回声抑制 | `DrawioFrame.tsx:687`（`lastSent.current = data.xml` 早于 `onDocumentChange`） |
| 宿主可代理原生 undo | `diagramly/EditorUi.js:27688`（`invokeAction`）；`grapheditor/Actions.js:147`（`undo` action） |
| undo 可用态 API | `EditorUi.js:30892`（`actions.get('undo').setEnabled(this.canUndo() && editable)`） |
| 宿主无键盘处理 | `src/` grep `metaKey|keydown|ctrlKey|onKeyDown` → 零命中 |
| ADR 的所有权约定 | `docs/adr/0011-native-drawio-only-model.md:22`；`docs/adr/0008-native-drawio-is-the-only-diagram-canvas.md:23` |
| 既有审计结论 | `docs/V2-UNDO-REDO-XML-SAVE-CHAIN.md` §2.4、§4.3、§4.5、§4.6 |

---

## 十一、一句话答复"app 级 undo 有没有必要"

**不要再建第二套 app 级 undo 栈。** 统一设计的唯一操作历史仍是 Draw.io 原生 `undoManager`；Studio 只负责键盘代理、按钮与可用态。所有内容级修改（手工编辑、Copilot、自动布局、颜色预设）都应进入原生模型事务；打开/导入/恢复版本等文档边界仍由 History 管理。


## 十二、统一历史栈实施记录（2026-10-25）

本次实现采用第七节 A 方案，不恢复快照式 App Undo 栈，也不通过重新加载 XML 来撤销单个编辑。

- `DrawioFrame` 对外提供 `undo()` / `redo()`；Studio 工具栏按钮和 Cmd/Ctrl+Z、Cmd/Ctrl+Shift+Z（Windows/Linux 也支持 Ctrl+Y）都通过同源插件桥接到 Draw.io 的原生历史入口。请求时再次检查原生可用态，避免按钮状态延迟时误操作。宿主输入框、textarea 和 contenteditable 保留各自文本撤销。
- 插件在当前原生模型的 CHANGE 事件、选择变化和页面切换时发布 `canUndo` / `canRedo`。切换 mxfile 内的页面不主动清空栈；真正的文档 load、打开/导入/恢复仍以 Draw.io 清栈后的状态为新基线。
- 颜色预设按当前活动页生成 revision-bound plan，插件校验活动页、单元 ID 集合、目标单元类型与原始样式，然后用一个 `beginUpdate/endUpdate` 事务修改原生样式。空计划不进入事务；计划不再引发 XML 属性覆盖或触发 Draw.io load，因此保持缩放、选择和原生 Undo/Redo。
- 颜色预设仅作用于当前页，控件文案已明确标记这一语义。选择器从当前页 XML 反推匹配的预设；Undo/Redo 之后若当前配色是自定义或混合状态，选择器回到占位态。
- 颜色事务复用 native autosave、显式 XML export、`persistDocumentNow` / `enqueueStandaloneSave` 的现有保存链，不另建文档栈或保存通道。保存失败时会明确提示“编辑器已变更、但保存未确认”，不会把它误报成“未修改”。

新增的单元与 E2E 覆盖：native palette plan 和既有颜色规则的等价性、多页活动页计划、压缩页 plan、预设的一步撤销/重做、宿主焦点下的快捷键、自动布局几何的一步撤销。插件事务的异常路径仍以运行时校验与原生事务内回滚为防线。实际验证状态以本次分支 / PR 的 CI 结果为准；代码落地本身不代表测试已经通过。

## 2026-10-25 追加发现：失败事务的补偿写入也可能污染原生历史

统一 Undo/Redo 已合入后，进一步审查失败路径发现一个细化问题：模型变更失败后，插件会在同一 `beginUpdate/endUpdate` 事务内用模型 setter 将状态补偿回原值。状态恢复不等于 history 恢复；这些“改动 + 改回”的 change 如果进入 Draw.io `currentEdit`，最外层 `endUpdate` 仍可能把它们作为一条 Undo edit 提交，并清掉此前可用的 Redo。

后续修复在原生事务开始前记录 pinned Draw.io 的 `currentEdit.changes` 长度。仅当补偿恢复成功、原生 cell 树/页面检查通过时，才丢弃该检查点之后的 changes；如果检查点不可用或回滚未完全验证，则保留错误状态并且不宣称回滚成功。此处理覆盖颜色预设、自动布局以及原子批编辑，并加上对齐/分布事务的保护。该操作不创建第二套历史栈，只清理尚未提交、且已确认被完全补偿的当前原生 edit。

回归测试：`v2/src/model/native-undo-rollback.test.ts` 直接启动实际插件消息桥，模拟颜色事务的第二次样式写入失败，以及批操作后续目标不存在的失败；两者均断言 cell 状态和已有 Undo/Redo 栈原样保留。测试依赖所固定 Draw.io 版本的 `mxGraphModel.currentEdit.changes` 机制，Draw.io 升级时必须重新验证。
