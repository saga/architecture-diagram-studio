# Copilot「选中元素 + 改背景色」只返回“已选中”的分析报告

> **历史分析，已被当前 V2 原生编辑链路取代。** 本文基于旧提交，关于前端正则、缺少填色工具和 selection 优先返回的结论不代表当前实现。当前入口使用服务端 Copilot SDK、类型化 `propose_native_edits`、active-page cell ID/label 校验，以及 Draw.io 原生编辑器回执。当前行为以 `v2/server/copilot/intent-route.ts`、`v2/src/model/native-edit-operations.ts` 和最新 CI 为准。

分析对象：`main @ 63cdeea`（Analyze at 2026-10-22）
涉及模块：`v2/server/copilot/*`、`v2/src/hooks/useCopilotIntent.ts`、`v2/plugins/studio-selection-plugin.js`

---

## 1. 结论

输入「选择 X 元素，然后改背景色为红色」时，系统只完成了前半句，并且把“选中”当成整个请求的最终结果返回。
这不是模型偷懒，而是三处设计与实现叠加出的必然结果：

1. **Agent 工具集里根本没有任何“元素样式 / 填充色”操作**（`apply_diagram_operation` 无颜色参数），所以后半句无工具可调。
2. **响应协议是单值优先级**：服务端先判 `selection` 再判 `application`，命中 selection 就直接 `res.json` 返回；客户端同样在 `plan.selection` 处提前 `return`。即使同一轮模型既选中又改了图，改动结果也会被丢弃。
3. **唯一能改颜色的路径是客户端正则**，它（a）只在 standalone 模式生效，（b）只接受单指令且整句锚定，（c）连最自然的中文“改为红色”都匹配不上。

因此，无论用户处在 project workspace 还是 standalone 模式，这个复合请求都只能落到“选中 → 结束”。

---

## 2. 实际链路（按时序）

```
用户: "选择xx元素，然后改背景色为红色"
  │
  ├─ ① 客户端先跑本地正则解释器  useCopilotIntent.ts:66-199
  │     · recolor 正则要求整句匹配并以颜色结尾              → 不匹配（含“选择…然后…”前缀）
  │     · 批量分支只认分号分隔，且仅支持 rename/resize/delete → 不进入
  │     · workspace 模式则整段跳过（条件 standaloneMode）     → 直接进 Agent
  │
  ├─ ② 请求 POST /api/copilot/intent {request, diagram, ...}
  │
  ├─ ③ 服务端注册工具  intent-route.ts:120-134
  │     · select_diagram_element        （唯一与半句请求匹配的工具）
  │     · propose_layout_plan
  │     · apply/propose 系列语义操作     （仅在非 standalone 模式）
  │
  ├─ ④ 模型调用 select_diagram_element("xx")   intent-route.ts:272-297
  │     → pendingAgentSelections.set(sessionId, {...})
  │     · 没有第二个能改颜色的工具，模型输出最终文本，回合结束
  │
  ├─ ⑤ 服务端组装响应  intent-route.ts:189-195
  │     if (plan.capturedSelection) → { commands: [], reply: "Selected diagram element: X", selection }
  │     ↑ 在 capturedApplication / capturedProposal / captured 之前 return
  │
  └─ ⑥ 客户端  useCopilotIntent.ts:226-232
        if (plan.selection) { applyNativeCellEdit(cellId,"cell:select"); setMessages("Selected …"); return; }
        ↑ 同样在 plan.application / plan.proposal / plan.commands 之前 return
```

用户看到的“xx 元素被选中了”，是第 ⑥ 步那条写死的英文文案（`Selected "X" on the diagram. No document change or commit was needed.`）；服务端 `reply` 字段（`Selected diagram element: X`）在这个分支里不会被展示。

---

## 3. 根因

### R1 能力缺口：工具集中没有颜色操作（P0）

`apply_diagram_operation` 的参数表只覆盖几何、名称、角色、关系、布局、边界、时序片段（`v2/server/copilot/diagram-tools.ts:112-143`）。全仓 `server/` 内搜不到 `fillColor` / `setFill` / `background` 任何写色实现。

模型能表达的“变红”只有 `visualRole: "highlight"`（主题语义角色），与“红色”不是一回事，也不可指定色值。

→ 后半句在协议层就不可执行。

### R2 响应协议单值化：selection 吞掉同轮的 apply/proposal（P0）

服务端（`intent-route.ts:189-228`）：

```ts
if (plan.capturedSelection) { ...; res.json({ commands: [], reply: "Selected diagram element: …", selection }); return; }
if (plan.capturedApplication) { ... }
if (plan.capturedProposal)    { ... }
```

客户端（`useCopilotIntent.ts:226-260`）是同一套优先级。

后果不止是“少回一句话”：

- 若模型在同一轮**先选中、后调用 `apply_diagram_operation`**，服务端已经落库并生成了新版本，但响应里只有 `selection`。
- 客户端拿不到新 `document`，画布与 `baseRevision` 仍是旧的；下一次 autosave 会被 `PUT /api/workspace/document` 的修订校验拒绝（`copilot-server.ts:1014-1015` → 409 “The document changed…”）。
- 用户看到的是“已选中”，实际磁盘上已经变了 —— 表现为“莫名其妙提示文档已变更”。

即：一次成功的编辑被响应协议降级成了一次纯选中。

### R3 复合指令没有解析路径（P0）

客户端正则解释器（`useCopilotIntent.ts`）的设计是“整句匹配单条指令”：

- `recolor` 正则（第 72 行）以 `\s*$` 锚定结尾，前面不接受“选择…，然后…”这类前缀；
- 批量分支（第 111 行）只按 `;` / `；` 切分，且只实现 `rename` / `resize` / `delete` 三种语句，**没有颜色语句**；
- 因此“选中 + 改色”既不是单指令，也不在批量白名单内。

更关键的是：这条批量/正则路径本身违反 `docs/adr/0010` 定下的“前端不得包含第二个意图解释器”。

### R4 模式差异：standalone 模式下 Agent 一个写工具都没有（P0）

`intent-route.ts:123`：

```ts
...(standalone ? [] : deps.createDiagramTools(...))
```

standalone 模式只注册 `select_diagram_element` 与 `propose_layout_plan`。于是：

| 模式 | 改色的可行路径 | 实际结果 |
| --- | --- | --- |
| workspace | 无（Agent 无颜色工具） | 只能选中 |
| standalone | 仅客户端单指令正则 | 正则不匹配即落到 Agent，而 Agent 无写工具 → 只能选中 |

两条分支都收敛到“选中”。

### R5 语义混淆：“highlight” 被映射成 select，“背景色” 指代不明（P1）

系统提示词（`intent-route.ts:40/47/48`）写的是：

> For requests to select, **highlight** or focus a diagram element, use `select_diagram_element`

对模型来说，“把它改成红色”最接近的可用动作就是 highlight → select。这条提示词实际上把“着色”引导成了“选中”。

同时代码里“背景色”有三个不同所指，且只有一种是“元素填充色”：

| 概念 | 实现位置 | 是否可达 |
| --- | --- | --- |
| 元素填充/描边 `fillColor` / `strokeColor` | 插件 `style:fillColor`（`studio-selection-plugin.js:237-252`） | 仅客户端正则可达 |
| 画布背景 `graph.background` | 插件 `studioSetBackground`（`:355-367`） | **全仓无调用方**，死代码 |
| 主题语义 `visualRole` | `diagram-tools.ts` `update_node` | 只有 5 个预设角色 |

### R6 重试保护被“选中”绕过（P1）

`intent-route.ts:168` 的补偿逻辑只在“一个工具都没调”时触发：

```ts
if (!captured && !capturedProposal && !capturedApplication && !capturedSelection && usedToolNames.size === 0) { ...retry... }
```

选中本身就算“调过工具”，所以这条本该问一句“还有一步没做，要继续吗”的保护，恰好被半完成的请求短路掉了。

### R7 选择目标来自陈旧快照（P1）

`select_diagram_element` 的候选集是闭包捕获的 `context`（`intent-route.ts:272-288`），而 `context` 在 `prepare()` 里捕获（第 121 行）。会话复用时 `acquireSession` 会先 `await request.prepare()` 再判定可复用并直接返回旧会话（`runtime.ts:258-264`），**新算出来的工具集被丢弃**。

→ 同一会话里第二次、第三次请求做选择时，用的仍是会话创建那一刻的节点表；图改过之后就会出现“元素找不到 / 选错对象”。

### R8 选择的输入上下文不完整（P1）

`useCopilotIntent.ts:216-219` 只上送 `{kind, title, selectedNode, nodes.slice(0,80)}`：

- 没有 native `cellId` / `pageId`，所以 `selection.pageId` 恒为 `null`，ADR-0010 §4「native selection 是一等上下文」未实现；
- 只发前 80 个节点，投影之外的元素无法被选中，报错文案却是“元素不存在”。

### R9 附带副作用（P2）

- `cell:select` 会走 `applyNativeCellEdit`，而 App 对**每一次** cell 编辑都写一条 standalone 历史快照（`App.tsx:665-686`）。纯选中不需要编辑，却会污染 100 条历史上限。
- 历史快照 label 固定为 `"Before Copilot: " + path`，选中也会产生 “Before Copilot: cell:select on X”。

---

## 4. 正则覆盖实测（standalone 模式唯一可用通道）

用当前代码里的 `recolor` 正则实测：

| 输入 | 结果 |
| --- | --- |
| `数据库填充色改成红色` | ✅ target=数据库 color=红色 |
| `数据库填充色为红色` | ✅ |
| `数据库填充色设置为红色` | ✅ |
| `set Database fill to red` | ✅ |
| `数据库的填充色 #ff0000` | ⚠️ target=`数据库的`（未剥离所有格，查不到元素） |
| **`数据库填充色改为红色`** | ❌ 连接词表是 `to|为|改成|设置为`，**缺 `改为`** |
| **`把数据库背景色改为红色`** | ❌ 关键词表缺 `背景色` |
| `change the fill color of Database to red` | ❌ 目标必须在关键词之前 |
| **`选择数据库元素，然后改背景色为红色`** | ❌ 整句锚定 + 无 `背景色` + 无 `改为` |

也就是说：最口语、最常见的中文写法（“改为”）反而是坏的。

---

## 5. 为什么问题看起来像“模型只答了一半”

四个因素同时成立：

1. 请求里有一半没有对应工具 → 模型无法规划；
2. 提示词把“着色”归到 highlight → select；
3. 选中是合法工具调用 → 触发不了“未调用工具”的重试保护；
4. 响应与客户端都以 selection 为最高优先级 → 剩余结果被静默丢弃。

这四点缺任何一条，用户都会看到不同（更好的）错误：要么明确说“不支持改颜色”，要么继续把颜色做完。

---

## 6. 修复建议

### P0 — 让“改颜色”成为一等操作

1. 新增服务端工具 `set_element_style`（或给 `apply_diagram_operation` 增加 `fillColor` / `strokeColor` / `fontColor` 字段），走与其它操作相同的 revision 校验 + XML 补丁路径：
   - workspace：改 XML 后走 `proposeOperation/applyProposal`，产出版本；
   - standalone：返回类型化命令，由 Draw.io bridge 的 `style:fillColor` 执行并回执。
2. 客户端删除 `recolor` / `rename` / `move` / `resize` / `batch` 这套正则解释器（ADR-0010 明确禁止前端二次解释），复合与多步请求统一交给服务端。

### P0 — 响应改成“多个效果”而不是“一个赢家”

服务端返回 `{ selection?, application?, proposal?, commands? }`，不再互相 `return`；客户端按顺序全部应用（先渲染应用结果，再选中/聚焦）。这同时修掉 R2 的“已落库但前端 502/409 之谜”。

如果短期不想改协议，最低成本顺序修正：把 `capturedApplication` / `capturedProposal` 判断放到 `capturedSelection` 之前，并在 application 分支里附带 `selection` 字段。

### P1 — 提示词与模式对齐

- 把 `highlight` 从“选择”的触发词里移除，改成“仅当用户要求选中/定位/聚焦时使用”；
- 在工具描述里显式声明“不支持任意颜色修改”，让模型在无能力时明确拒绝，而不是降级成选中；
- standalone 模式若不允许改图，应在提示词里明确“只能选中或给布局方案”，不要给用户“能改色”的暗示。

### P1 — 修选择上下文

- 客户端上送 native `{cellId, pageId, revision}`，服务端按 ADR-0010 §4 校验新鲜度；
- 每次请求刷新 `select_diagram_element` 的目标集合：`prepare()` 结果在会话复用时被丢弃（`runtime.ts:258-264`），需把 `context` 从工具闭包改为按请求注入（例如工具 handler 从请求作用域的 holder 读取，或在复用时更新 `prepared`）。
- 候选集不要只取 `nodes.slice(0,80)`。

### P2 — 清理

- `cell:select` 不写历史快照；
- `studioSetBackground` 要么接线（并明确“画布背景”≠“元素背景”），要么删除；
- 所有格 `的` 在目标名归一化时剥离。

---

## 7. 验证清单（建议补的自动化）

1. `选择 X 然后改背景色为红色`（workspace）：断言 XML 中 `X` 的 `style` 含 `fillColor=#ff0000`，且响应同时含 `selection` 与 `application`。
2. 同上（standalone）：断言 bridge 收到 `style:fillColor` 且编辑器回执成功。
3. 同轮 `select` + `apply`：断言响应保留 `application.document`，客户端 `baseRevision` 同步更新，随后 autosave 不返回 409。
4. `把数据库背景色改为红色` / `填充色改为红色`：断言要么执行成功，要么返回明确的“不支持”而不是“已选中”。
5. 会话复用后修改图再选择：断言选择目标按最新上下文解析（覆盖 R7）。
6. 纯选中：断言不产生历史快照、不产生版本。

---

## 8. 代码位置索引

| 关注点 | 位置 |
| --- | --- |
| 客户端选择早退 | `v2/src/hooks/useCopilotIntent.ts:226-232` |
| 客户端颜色正则 | `v2/src/hooks/useCopilotIntent.ts:72`、`:188-194` |
| 客户端批量白名单 | `v2/src/hooks/useCopilotIntent.ts:111-147` |
| 选择工具定义 | `v2/server/copilot/intent-route.ts:272-297` |
| 响应优先级 | `v2/server/copilot/intent-route.ts:189-228` |
| standalone 工具裁剪 | `v2/server/copilot/intent-route.ts:123` |
| 重试保护条件 | `v2/server/copilot/intent-route.ts:168` |
| 会话复用丢弃 prepare | `v2/server/copilot/runtime.ts:258-264` |
| 语义操作参数表 | `v2/server/copilot/diagram-tools.ts:112-143` |
| `cell:select` 实现 | `v2/plugins/studio-selection-plugin.js:218-224` |
| 画布背景（无调用方） | `v2/plugins/studio-selection-plugin.js:355-367` |
| 选择也写历史快照 | `v2/src/App.tsx:665-686` |
| 保存修订校验 | `v2/server/copilot-server.ts:1014-1015` |
| 架构约束 | `docs/adr/0010-unified-server-side-copilot-intent-processing.md` |
