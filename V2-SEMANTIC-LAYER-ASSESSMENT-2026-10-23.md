# 评估：给 Agent 一份「语义层说明书」以保证脚本正确性

触发事件：`V2-CURVED-SCRIPT-INCIDENT-2026-10-23.md` —— 模型第一版脚本就写错 API（`model.getDefaultParent()`），整批 fail-closed 回滚。用户提议：**列出当前 draw.io 支持的全部操作，做成说明书，给 Agent 一个 semantic layer 定义**。

基线：HEAD `f3126da`。本报告评估该想法，并给出替代/组合方案。

---

## 结论先行

1. **方向完全正确**：模型不该"猜"API——这次事故已经证明第一版脚本就会写错，且运行时没有任何纠错回路（一次失败直接终止回合）。
2. **但"列出全部操作"的形态不可行**：实测本 bundle 可调用面约 **1,100+ 方法**（mxGraph 389 + grapheditor/Graph 223 + mxGraphModel 88 + mxGraphView 85 + mxCell 40 + App 85，另加 ~200 个 EditorUi actions），仅 mxGraph+mxGraphModel 两个源文件就 423KB。全量说明书 ≈ 60–90KB 文本（约 2–2.5 万 tokens），而 curved 一次回合实测输入已是 21.6k tokens（`turn.model-call.completed` second model call）——**说明书会把每次意图调用的输入翻倍**，且更长的清单反而给幻觉提供更多可抄错的 API。
3. **推荐形态不是"百科全书"，而是"四层契约"**（下文第 3 节），其核心是把用户的"semantic layer"落成三个机器可校验的产物：
   - **typed 操作词表扩容**（高频任务走结构化 op，不用写脚本——这是最可靠的正确性保证：服务器端校验失败就 fail-closed，根本到不了编辑器）；
   - **脚本契约说明书**（精选、版本化、注入预算 2–4KB：配方 + 禁改清单 + pitfall 表 + mxGraph/mxGraphModel 分工表）；
   - **运行时能力 manifest**（插件启动时 introspect 生成，说明书只允许引用 manifest 校验过的 API 名，版本漂移自动禁用脚本能力）。
   另加一个机制修正：**失败反馈重试回路**（一次失败的价值远不止给用户看，应该喂回模型）。

---

## 1. 想法的事实基础（都验过）

| 事实 | 数据 / 位置 |
| --- | --- |
| 当前模型拿到的 API 契约有多薄 | schema 只列 4 个变量名（`native-edit-tool-schema.ts:53`）；提示词给了零散示例（`intent-route.ts:374`），没有方法归属说明 |
| 模型实际怎么犯错 | 第 1 行就 `model.getDefaultParent()` → TypeError → 整批回滚（事故报告 §API 核对表） |
| 犯错的类别是"归属"而非"拼写" | 提示词里明明有 `model.getChildCount/getChildAt`、`graph.getChildCells` 等**正确**例子，模型仍把图级 helper 安到了 model 上 —— 说明变量列表式说明不够，需要 **API 归属/分工表** |
| 运行时其实有自检能力 | 插件里已有 `typeof graph.groupCells !== "function"` 这类存在性检查（`studio-selection-plugin.js:242,247`）→ manifest 可由同模式 introspect 生成 |
| 失败信号已完整可用 | 插件回传具体错误文本（如 `model.getDefaultParent is not a function`），但现在只到 diagnostics/用户消息就断了，不进模型回路（事故报告 D5 相关） |
| e2e 与模型犯同一个错 | `02-canvas.spec.ts:209/:263` 两条脚本用例自身就写着错误 API —— 契约必须**机器可校验**，靠人写文档所有人都落在同一个坑里 |

---

## 2. 为什么"列出全部 draw.io 操作的说明书"不可行

1. **规模与成本**：≈1,100+ 可调用方法 + ~200 个 EditorUi action。完整文档 60–90KB / 2 万+ tokens，每次意图注入或随图附送都会显著放大成本与上下文占用（当前一次 curved 意图输入已 21.6k tokens）。
2. **清单 ≠ 正确性**：错误率最高的部分不是"知道方法名"，而是**签名/语义**：`setCellStyles(key, null, cells)` 的"null 即移除"、`getDefaultParent()` 在 Graph 而非 mxGraphModel、`value` 可能是 DOM 节点（UserObject）、几何对象必须 `clone()` 再改。全量罗列不解决语义错误，反而诱导模型去用复杂 API。
3. **漂移**：站点依赖固定版本 v32.0.2 bundle，但插件/`scripts/bundle-drawio.mjs` 的产物护栏本就缺位（`V2-NATIVE-SCRIPT-REVIEW` P2-5）；手写说明书与运行时必然失同步，而且没有机制发现。
4. **放大审查缺口的暴露面**：脚本目前免审（review P1-1）、在同源 iframe 里全权执行（P0-1）。说明书鼓励模型写更长的脚本 = 接触面更大。**契约扩容之前必须先落 P1-1 的一行止血（脚本一律 requiresExplicitConfirmation）**。
5. **维护负担与"谁来保证说明书是对的"**：本次 e2e 事件说明，人与智能体都会把同一错误固化进"文档/测试"。说明书必须能被运行时反证（manifest 对账 + 用例校验），否则它会变成第二份东施效应。

结论：**全量说明书 ❌；分层契约 ✅**（下节）。

---

## 3. 推荐方案：四层契约 + 一个失败回路

### Tier 1 · typed 操作词表扩容（最优先 —— 高频任务根本不该写脚本）

绝大多数"改样式/改排版"类请求应落在**结构化、可校验、可逐格确认**的 typed op 上。按 ADR-0012 与 `native-diagram-capabilities.ts` 既定的扩展口接入（operation provider 返回 operations，仍走共享校验/revision 检查/Native 反射确认），例如本次事故的任务：

```jsonc
// 新 op 草案：set_cells_style（kind: "style"）
{ "op": "set_cells_style",
  "scope": "active_page",            // active_page | named(目标列表)
  "kinds": ["edge"],                 // vertex | edge | all
  "add": { "curved": "1", "rounded": "1" },
  "remove": ["edgeStyle", "orthogonalLoop", "jettySize"] }
```

要点：
- key/value 在**双向 allowlist** 内由服务器校验（允许 `curved/rounded/edgeStyle/orthogonalLoop/fillColor/…`，禁止任意键直达 style 字符串注入）；
- 落到本地 bridge 仍是现有 `style:<key>` 路径（插件已支持 patch 语义，`studio-selection-plugin.js:349-364`），**不需要新插件代码**；
- 逐格确认复用 `nativeEditIsReflectedInXml` 的 `styleKeyMatches`（`native-edit-confirmation.ts:156-166,230`）——确认语义保持严格，而不是脚本那种"页面任意变化"的弱确认；
- 收益：curved 这个事故任务从此**一次可达**、每次变更逐格可证伪、且天然可建版本对照。

同类值得优先纳入的批量 op：`reorder_cells`、`set_edge_style`（若单独建模）、`distribute/align`（插件已实现，只是没暴露成 typed op）。**每个新 op 必须同时补 e2e**（用真实 bundle 跑 playwright——事故 D3 的教训）。

### Tier 2 · 脚本契约说明书（回答用户"说明书怎么办"）

版本化文档 `docs/DRAWIO-AGENT-API-CONTRACT.md`，四节，注入预算 2–4KB：

1. **API 归属表（分工表）**——本次事故的直接解药：
   | 变量 | 类型 | 职责 | 典型方法 |
   | --- | --- | --- | --- |
   | graph | mxGraph(drawio Graph) | 图级/视图 helper：**getDefaultParent()、getChildEdges(parent)、getChildCells(parent,v,e)、setCellStyles(key,val,cells)、refresh()、insertVertex/insertEdge/removeCells** |
   | model | mxGraphModel | 数据+事务：beginUpdate/endUpdate、setStyle/setValue/setGeometry/setTerminal、getChildCount/getChildAt/getCell。**没有 getDefaultParent/refresh** |
   | ui / editor | EditorUi / mxEditor | 页与动作层（默认禁改清单，见 §3） |
2. **任务配方（recipes，一问一路径）**：枚举全部连线、改全部样式、改单个样式（优先 Tier1）、新增连线/节点、重连端点、组/解组、对齐分布——每条给 5–10 行验证过的代码模板（以 curved 事故为例，模板就是修正版脚本）。
3. **禁改清单（negative list）**：不调用 `editor.setGraphXml`、不增删页（`ui.editor.addPage/...`）、不调用保存/退出类 action、不写文件/不发网络请求、必须同步。
4. **pitfall 表**：`value` 可能是 Element；样式是";-join 字符串"；几何改前 `clone()`；`beginUpdate/endUpdate` 必须配对（script 事务嵌套规则）；等等。

**关键纪律**：说明书里出现的**每个方法名/变量名**，必须是 Tier 3 manifest 的成员；CI 用例（vitest）可静态抽取该文档中的 API 标识符与 manifest 对账——防"文档自嗨"。模型提示词（`intent-route.ts:374`）引用该文档的压缩版，而不是全文照搬。

### Tier 3 · 运行时能力 manifest（防漂移的机器层）

- 插件 `studioBridgeReady` 时（或独立 message）introspect 生成：
  ```jsonc
  { "bundleVersion": "v32.0.2", "pluginVersion": "<sha8>",
    "graph": ["getDefaultParent","getChildEdges","setCellStyles","insertVertex","insertEdge","removeCells","getChildCells","refresh", ...],
    "model": ["beginUpdate","endUpdate","setStyle","setValue","setGeometry","setTerminal","getChildAt", ...],
    "pluginPaths": ["style:","style","label","geometry:","cell:execute-script", ...] }
  ```
- 服务器侧持同名静态清单 `v2/server/copilot/drawio-capability-manifest.json`（schema description 与 prompt 生成共用的唯一源）；
- 宿主收到 ready 后与静态清单比对：**不匹配 → 禁用 run_drawio_script 并在 UI 明示**（同时解决 review P2-5 的 bundle 漂移问题）；
- manifest introspect 本身 ≈30–60 行插件代码，模式与现有 `typeof` 自检相同。
### Tier 4 · 失败反馈重试回路（机制修正，性价比最高的一次）

- 浏览器在 `run_drawio_script` 执行失败且错误形如 `TypeError/ReferenceError` 时，自动向 `/api/copilot/intent` 发一次补充回合：内容 = 失败原因 + 脚本全文 + Tier2 契约缩略表；要求模型**只返回修正脚本**；
- 预算：每请求最多 1 次、每次脚本失败 50s 回合预算内复用现有排队（`runtime.ts` turnLocks）；UI 显示「自动重试 1/1，原因：…」；
- 配合 review P1-1：重试产物同样过 proposal 确认门（若该门已启用）。
- 这一步做完，"第一次就写对"不再是正确性的唯一支柱。

---

## 4. 方案对比矩阵

| 方案 | 正确性收益 | 成本 | 风险 | 取舍 |
| --- | --- | --- | --- | --- |
| A 全量清单/说明书 | 中（新增更多信息反而更多抄错点） | 注入 +2 万 tokens/意图；文档维护 | 漂移无从发现；放大 P0-1/P1-1 | ❌ |
| B 精选契约说明书（Tier2） | 高（直接消除本次差错类别） | 文档 2–4KB + 提示词小改 | 需 manifest 对账防漂移 | ✅ 必做 |
| C typed op 扩容（Tier1） | **最高**（服务器校验 + 失败 fail-closed + 逐格确认） | 每 op：schema+parse+确认+e2e（半天/个） | 无实质风险（附带现成桥接路径） | ✅ 优先 |
| D manifest 自校验（Tier3） | 减幻觉 + 防产品漂移 | 插件 ~40 行 + 静态 JSON + host 比对 | 低；解决 P2-5 | ✅ 必做 |
| E 失败重试回路（Tier4） | 高（错误信号进模型回路） | 浏览器发起、复用现有意图接口 | 需预算与确认门约束 | ✅ 做 |
| F 沙箱包装器（Proxy 遮蔽/报错友好） | 低 | Proxy 包覆会破坏 draw.io 对象恒等与内部检查 | 高 | ❌（review P0-1 已论证正则/遮蔽可绕） |

---

## 5. 与 AGENTS.md / 既有决策的合规边界

- **允许并推荐**："semantic layer"只落为**两类产物**：机器可校验的操作词表（typed ops + manifest）与版本化文档/配方（说明书）。修改路径不变：typed ops 或单脚本 op，服务器校验、编辑器确认、持久化对账全部沿用。
- **红线（防走样）**：
  1. 说明书不得成为"生成/替代 XML 的来源"，不得指示模型输出 XML（AGENTS.md 与 intent-route `:377` 已有"Do not author/replace XML"）；
  2. 不得借"语义层"复活被移除的语义意图引擎/持久图模型——本方案的所有内容都是**无状态契约**，不落盘、不建第二个图；
  3. 新 batch op 一律挂 ADR-0012 `NativeDiagramOperationProvider`（kind: style/structure），不在 plugin 里开私有通道；
  4. 顺序上先落 review P1-1（脚本免审 → 需确认），再扩契约。

## 6. 落地计划（建议顺序与锚点）

| 阶段 | 内容 | 文件/位置 | 量级 |
| --- | --- | --- | --- |
| P0-a | `requiresExplicitConfirmation` 对 script op 恒 true（review P1-1） | `intent-route.ts:140-143` | 1 行 |
| P0-b | 契约说明书 v1 + 提示词/ schema 引用（含 mxGraph/mxGraphModel 分工表 + curved 等配方） | `docs/DRAWIO-AGENT-API-CONTRACT.md`、`intent-route.ts:374`、`native-edit-tool-schema.ts:53` | 0.5–1 天 |
| P0-c | manifest：插件 introspect + host 对账 + 失配禁用脚本 | `studio-selection-plugin.js`（ready 消息）、`DrawioFrame.tsx` ready 分支、`drawio-capability-manifest.json` | 0.5 天 |
| P1-a | `set_cells_style` typed op（含确认与 e2e） | `native-diagram-capabilities.ts` provider + `native-edit-tool-schema.ts` + `native-edit-confirmation.ts`（复用 `styleKeyMatches`）+ e2e | 0.5–1 天 |
| P1-b | 失败重试回路（1 次、类型化触发、显示原因） | `useCopilotIntent.ts` 失败分支 → 补充 intent 请求 | 1 天 |
| P2 | 其余批量 op（reorder/reconnect…）、契约文档 CI 对账用例、review 报告其余项 | — | 迭代 |

P0 三项合计 ≈ 1.5–2 天，即可使"第一版脚本大概率写对 + 写错也不会撒谎 + 高频任务不再需要脚本"。

---

## 附录 A · 说明书（契约文档）骨架草案

```
docs/DRAWIO-AGENT-API-CONTRACT.md  (v1, 校验于 bundle v32.0.2)

§1 归属表   graph=图级helper / model=数据+事务 / ui,editor=动作层(默认禁)
§2 配方     R1 枚举连线   R2 全页改样式  R3 单格改样式(优先Tier1)
            R4 增节点/连线 R5 重连端点    R6 组合/对齐
            —— 每条 ≤10 行模板 + 断言(如 return {updated:n})
§3 禁改     setGraphXml / 页增删改 / 保存/退出 action / 网络+存储 / async
§4 坑       value可为Element；样式";"化；几何先clone()；事务配对；
            setCellStyles(null)=移除键；不要持有跨op的cell引用
对账        每个标识符必须是 manifest 成员（CI 用例）
```

## 附录 B · 提示词注入的最小速查块（可直接合入 `intent-route.ts:374`）

> Contract: model is mxGraphModel — data+transactions ONLY (beginUpdate/endUpdate, setStyle/setValue/setGeometry/setTerminal, getChildCount/getChildAt/getCell). It has NO getDefaultParent and NO refresh — call those on graph. graph (mxGraph) owns view/shape helpers: graph.getDefaultParent(), graph.getChildEdges(parent), graph.getChildCells(parent, v, e), graph.setCellStyles(key, value, cells), graph.insertVertex/insertEdge/removeCells, graph.refresh(). Do not call editor.setGraphXml or manage pages. Scripts are synchronous; one wrong call rolls back the whole batch. Prefer typed operations; use run_drawio_script only what typed operations cannot express.

（节选自事故报告 D4 修法，正式版走 docs 文档 + manifest。）
