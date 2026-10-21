# 支持 draw.io 全部图形：架构可行性评审

- 评审对象：`v2/`（React 19 + Vite + antd 6 + 本地 bundled draw.io v32.0.2）
- 评审方式：改造前只读代码分析；后续实现由 ADR-0006 与本轮提交跟踪。
- 结论文件位置：仓库根目录
- 对照基线：`ARCHITECTURE-V2.md`（2026-10-20）
- 当前决策：`docs/adr/0006-drawio-xml-single-source-of-truth.md`；本文第 3 节及第 9 节的路径/行号主要用来描述改造前问题。

---

## 0. 一句话结论

**当前架构不是"兼容 draw.io 的图形编辑器"，而是"以 draw.io 为最终渲染器的 C4 / 流程图 / 时序图生成器"。**

`DiagramDocument` 是唯一真相源，draw.io XML 只是它的一次投影。因此"支持 draw.io 的所有图形"不是给 `DiagramKind` 再加几个值就能完成的增量改动，它要求推翻"语义模型是唯一真相源"这条前提。

**目标架构是单一真源：Draw.io 原生 `mxfile` XML。**

`DiagramDocument` 仅用于 Studio 的 C4 / 流程图 / 时序图语义操作，是从 XML 派生的局部投影，不是可持久化的第二真源。任意 Draw.io 文档都应由原生编辑器打开、编辑、保存；当 Studio 无法证明投影完整、无损时，不允许语义画布或自动布局改写该文档。

| 关注点 | 决策 |
|---|---|
| 真源 | 完整的 `.drawio` `mxfile` XML |
| Studio 模型 | 派生投影，仅服务于受支持的语义功能 |
| 修改 | 以 cell id 为边界，将受控变化 patch 回原 XML；保留所有未修改内容 |
| 未知形状/属性/页面 | 不要求理解，不得丢弃；仍可在原生 Draw.io 中编辑 |
| 语义布局/评分 | 仅在投影完整且安全时启用；导入不自动重排 |
| AI | 不让模型写任意 XML；使用服务器实现的受约束 cell 操作 |


---

## 1. 评审范围

已通读的核心文件：

```
v2/src/model/types.ts                 195 行   语义模型 + 运行时校验
v2/src/import/drawio.ts               206 行   mxGraph XML → 语义模型
v2/src/export/drawio.ts               157 行   语义模型 → mxGraph XML
v2/src/components/DiagramCanvas.tsx   503 行   Studio SVG 渲染器
v2/src/components/DrawioFrame.tsx     244 行   原生 draw.io iframe
v2/src/layout/*.ts                  ~1400 行   ELK / Dagre / routing / quality / sequence
v2/src/design/styles.ts                65 行   语义 role → 绘制样式 + mxGraph style
v2/src/App.tsx                       1391 行   模式切换、导入导出、提交与持久化
v2/server/diagram-domain.ts            67 行   服务端语义校验
v2/server/copilot-server.ts          1310 行   API、版本、提案、保存
v2/server/copilot/diagram-tools.ts    183 行   AI 工具契约
```

---

## 2. 设计意图与它自身的边界

`ARCHITECTURE-V2.md` §1 定下的核心原则是：

> Draw.io 负责最终的原生渲染和人工编辑；Studio 自己负责语义、设计语言、自动布局、AI 修改和"好不好看"的判断。

在"只做三类图"的前提下，这条原则是**自洽**的。§2.1 也明确写了：

> 其它图形暂时不作为独立产品类型。底层模型可以保留扩展能力，但 UI、AI prompt、布局器和测试都围绕这三类优化。

一旦要求"支持 draw.io 的所有图形"，这条原则立刻变成**自相矛盾**：

1. Studio 要做布局 / 评分 / AI 编辑，前提是**能读懂内容**；
2. draw.io 能表达的内容（stencil、自定义形状、容器嵌套、图层、多页、HTML 标签、edge-to-edge 连接）**远大于**语义模型；
3. 于是"语义模型是真相源"等价于"draw.io 的超集内容必然被丢弃"。

当前代码正是这个推论的忠实实现。下面逐条给出证据。

---

## 3. 问题清单

按"是否会造成用户数据丢失"排序。

### P0 — 会造成不可逆的数据丢失

#### P0-1　导入是有损子集映射，且丢弃源 XML

`v2/src/import/drawio.ts:76` `fromDrawioXml()` 只产出 `nodes[]` / `relations[]` / `boundaries[]`，**不保留任何未识别的 cell**。

具体丢弃点：

| 位置 | 行为 |
|---|---|
| `import/drawio.ts:13-21` `roleFromStyle()` | 只认 `studioRole`、`rhombus`、`ellipse`、`database`，**其余全部降级为 `domain`** |
| `import/drawio.ts:96` `plainLabel()` | 标签只取**第一个 `<div>`**，多段标签（UML 类的属性区、ER 表的列）只剩标题 |
| `import/drawio.ts:124` | `if (!geometry) continue;` —— 没有 `mxGeometry` 的 cell 直接丢弃 |
| `import/drawio.ts:148-149` | 端点不在 `nodes` 里的边直接丢弃（edge-to-edge、连到 group 的边全丢） |
| `import/drawio.ts:169-178` | 边被压成 6 种 `kind` + `dashed` + `routing` 三个自由度 |
| 整个循环 | **完全不读 `parent` 属性** —— group / container / swimlane 的层级结构丢失 |
| 整个循环 | **不读 `layer`、`page`、`UserObject`、`mxCell` 的 `placeholders`、`tags`、`custom attributes`** |

#### P0-2　任何 Studio 侧编辑都会用"重生成的 XML"覆盖原生 XML

这是最危险的一条。

```ts
// v2/src/App.tsx:245
const drawioXml = nativeXmlOverride ?? generatedDrawioXml;

// v2/src/App.tsx:480-484
const commitDocument = useCallback((next, action, preservedNativeXml?) => {
  ...
  setNativeXmlOverride(preservedNativeXml ?? null);   // ← 不传第三个参数就清空
```

后果链条：

1. 用户在"Freeform"里画了一个 UML 类图 → `DrawioFrame` 回传原生 XML → `commitDocument(next, ..., nativeXml)` → `nativeXmlOverride` 被保留，磁盘上仍是原生内容；
2. 用户回到 Studio 模式，拖动了一个节点 → `commitDocument(moved, "Node moved manually…")`（`App.tsx:1127`，**没有第三个参数**）→ `nativeXmlOverride = null`；
3. `drawioXml` 退化为 `toDrawioXml(document)`，`v2/src/export/drawio.ts:131` 用语义模型**从零重建**整个 mxfile；
4. `PUT /api/workspace/document`（`server/copilot-server.ts:726`）把这份重建的 XML 写入 `workspace.primaryDiagram` 原文件（`:756-759`）。

**一次拖动 = 原生文件被永久降级。** 版本历史里有旧 XML，但用户不会知道需要回滚。

#### P0-3　导入后强制重排，抹掉原始布局

```ts
// v2/src/App.tsx:756-771
const parsed = fromDrawioXml(xml, empty);
const next = await requestServerLayout(parsed);   // ← 无条件跑 ELK/Dagre
commitDocument(next, "Imported " + file.name + " …");
```

对 C4 / 流程图这是特性；对手绘拓扑图、思维导图、组织架构图，这是**毁灭性**的：ELK layered 会把原本的放射状、泳道状、自由布局重排成一张从左到右的层级图，且原坐标不可恢复。

#### P0-4　切换"图形类型"等于清空文档

```ts
// v2/src/App.tsx:596-609
function changeKind(kind: DiagramKind) {
  ...
  const next = await layoutSample(FIXTURES[kind]());   // ← 整篇替换为示例
  commitDocument(next, label);
}
```

`document.kind` 实际上**不是文档属性，而是"重置为某个示例"按钮**。这在三种图时勉强能用；扩到 N 种图之后，这个交互本身就不成立——用户需要的是"新建一个 X 类型的图"，不是"把当前内容换成 X 的示例"。

---

### P1 — 模型与渲染器的封闭性

#### P1-1　`DiagramKind` 是封闭联合，且散落在 20+ 处

```ts
// v2/src/model/types.ts:1
export type DiagramKind = "c4" | "flowchart" | "sequence";
```

`isDiagramDocument()` 用白名单硬卡（`types.ts:148`）：

```ts
!["c4", "flowchart", "sequence"].includes(String(valueRecord.kind)) || … return false;
```

任何 `kind` 不在三者之内的文档**无法通过运行时校验**，因此无法持久化、无法被服务端接受、无法被 AI 工具读取。

`kind` 的分支出现在 `App.tsx`（10 处）、`DiagramCanvas.tsx`（7 处）、`layout/*`（8 处）、`server/copilot-server.ts`（12 处）、`server/diagram-domain.ts`、`useDiagramEditing.ts`（8 处）等地。**加第 4 种图 = 修改 40+ 个 `if`**，且每处都要判断"新类型是否适用"。

#### P1-2　形状只有 3 种

```ts
// v2/src/design/styles.ts:10
shape: "rect" | "pill" | "diamond";
```

```ts
// v2/src/components/DiagramCanvas.tsx:105-113
function nodePath(node, shape) {
  if (shape === "pill") { … }
  if (shape === "diamond") { … }
  return /* 圆角矩形 */;
}
```

`mxNodeStyle()`（`styles.ts:46-53`）也只产出三种 mxGraph style 前缀：`rounded=1;arcSize=8`、`rounded=1;arcSize=50`、`rhombus`。

draw.io 常用形状里，平行四边形（I/O）、六边形（准备）、文档、云、圆柱、参与者/泳道、UML 类框、ER 实体、BPMN 事件圆——**一个都画不出来**。

#### P1-3　17 个 `role` 是 C4 语义，不是图形语义

```ts
// v2/src/model/types.ts:4-7
export type NodeRole = "actor" | "source" | "entry" | "ui" | "domain" | "business"
  | "api" | "worker" | "data" | "storage" | "external" | "vendor"
  | "infra" | "decision" | "start" | "end" | "service";
```

这套词汇是为"C4 + 数据流"设计的。UML 需要的是 `class / interface / abstract / enumeration / package / component / actor / note`；ER 需要的是 `entity / weak-entity / relationship / attribute / key`；BPMN 需要的是 `start-event / intermediate-event / end-event / gateway / task / subprocess / pool / lane`。三者与现有 17 个值**几乎零交集**。

更糟的是 `role` 同时承担了三件事：语义分类、配色、形状。三者耦合在 `nodePaint()`（`styles.ts:13-33`）一个函数里，任何扩展都要同时改语义、改配色、改形状。

#### P1-4　没有 group / container / layer / page

导出时每个 cell 的父节点是硬编码的：

```ts
// v2/src/export/drawio.ts:21
vertex="1" parent="1"
// v2/src/export/drawio.ts:44
edge="1" parent="1"
```

`parent="1"` 是 mxGraph 的根层。**结构上不可能表达嵌套**：泳道里的任务、UML 类里的属性行、ER 表里的列、容器里的子节点，导出后全部变成根层平铺。

`DiagramBoundary`（`types.ts:45`）是**算出来的矩形**（`export/drawio.ts:48-63` 按成员节点包围盒计算），不是真正的容器——移动边界不会带动成员，成员进出边界也不会更新。

多页同样不支持：`toDrawioXml()` 只产出一个 `<diagram>`（`export/drawio.ts:142-144`）。

多页导入则是两种错误行为之一：
- **未压缩**的多页文件：`parsed.querySelectorAll("mxGraphModel root mxCell")`（`import/drawio.ts:79`）会匹配**所有页**的 cell → 多页被合并成一张图；
- **压缩**的多页文件：`parseDrawioXml` 只解码**第一个** `<diagram>`（`import/drawio.ts:40-69`）→ 其余页静默丢失。

#### P1-5　服务端校验白名单 + 硬上限

```ts
// v2/server/diagram-domain.ts:7
if (document.nodes.length > 500 || document.relations.length > 2000 || document.boundaries.length > 300)
  errors.push("Diagram exceeds the server-side size limits");

// v2/server/diagram-domain.ts:9-11
const nodeRoles = new Set([...17 个值...]);
const visualRoles = new Set([...5 个值...]);
const relationKinds = new Set([...6 个值...]);
```

任何扩展了 role / kind 的文档在 `PUT /api/workspace/document`（`copilot-server.ts:740`）会被 422 拒绝。**模型和校验器必须同步演进，否则新类型根本存不下去。**

#### P1-6　主题字面量被写进校验

```ts
// v2/src/model/types.ts:67
theme: "studio-editorial";
// v2/src/model/types.ts:149
valueRecord.theme !== "studio-editorial" || … return false;
```

单一主题写死在类型里。若将来要为原生轨引入"用户自带样式"，这个字段必须先放开。

---

### P2 — 布局 / 质量 / AI 的语义耦合

#### P2-1　自动布局对任意图都是破坏性的

`layoutDiagram()`（`v2/src/layout/layout.ts:84-121`）无条件执行：ELK/Dagre 排版 → 网格吸附 → 重叠修复 → 7 种路由变体打分选优。

`applyC4SemanticRanks()`（`v2/src/layout/elk.ts:8-41`）还按 role 硬编码了列号：

```ts
const defaultRank = { actor: 0, source: 0, ui: 1, entry: 2, domain: 3, business: 3,
                      service: 3, api: 4, worker: 4 };
```

对思维导图、网络拓扑、组织架构图，这套规则产出的结果和用户意图无关。

更关键的是 **AI 每次编辑都会触发全量重排**：

```ts
// v2/server/copilot-server.ts:1033 / 1087 / 1102 / 1134 / 1156
requiresLayout = next.kind !== "sequence";
```

即"只要不是时序图，改任何东西都重排全图"。这在 C4/流程图里是设计意图；在原生轨里是灾难。

#### P2-2　质量评分假设了语义图

`evaluateLayout()`（`v2/src/layout/quality.ts`，405 行）的 16 项指标全部建立在"节点是矩形、边是语义关系、标签是单行"之上：`labelOverflowCount` 用 `measureTextWidth` 对比节点宽度、`edgeNodeIntersections` 做线段-矩形相交、`c4WidthViolations`、`complexityWarnings`（`complexity.ts:22-23` 按 c4=24 节点 / 其它=32 节点给预算）。

对一张 ER 图，"标签溢出"和"边穿节点"可能完全是设计意图（表格行本来就要贴边）。**用同一把尺子量所有图，只会产出噪声，并进一步污染 `apply-proposal` 的质量门禁**（`copilot-server.ts:513`：分数下降超过 10 分就拒绝保存）。

#### P2-3　AI 工具枚举被 role / edge kind 锁死

```ts
// v2/server/copilot/diagram-tools.ts:23-25
operation: "add_node" | "update_node" | … | "delete_sequence_fragment";   // 15 个操作
// :117
role: { enum: [...17 个 role...] }
// :120
kind: { enum: ["flow","call","return","async","event","dependency"] }
```

而且明确禁止模型触碰原生 XML（`diagram-tools.ts:74`）：

> Draw.io XML is an editable output format; DiagramDocument is the semantic source of truth. … **Never synthesize raw XML or invent unsupported mxGraph style IDs.**

这条约束本身是对的（安全），但它同时意味着：**AI 在原生轨上完全无能为力**。要支持"帮我把这个类图的继承关系补全"，必须先给 AI 一套能操作 cell 的抽象。

#### P2-4　设计语言只覆盖 Studio 的 SVG，原生轨是裸的

`styles.css` 的主题变量作用在 `.app-shell[data-theme=…]` 上；`tokens.ts` 的调色板只在 `DiagramCanvas` 和 `toDrawioXml` 里用。用户在 Freeform 里看到的仍是 draw.io 默认主题。

值得注意：**注入 iframe 样式在技术上已经做到了**——`DrawioFrame.hideSaveAndExitControls()`（`DrawioFrame.tsx:172-194`）已经在往 iframe 的 `<head>` 里插 `<style>` 并挂 `MutationObserver`。所以"给原生轨套设计语言"不是做不到，是**没做**。

---

## 4. 四个真实场景的推演

### 4.1 UML 类图（draw.io 内置 `uml` 形状集）

| 环节 | 结果 |
|---|---|
| 导入 | 每个类框 → 一个 `domain` 节点；属性/方法区在 `<div>` 第二段之后 → 被 `plainLabel` 丢弃；继承箭头 → `kind: "flow"`，箭头变成实心三角 |
| 布局 | `requestServerLayout` 把类框重排成从左到右的层级 |
| 保存 | `toDrawioXml` 重建为 `rounded=1;arcSize=8` 圆角矩形 |
| 净效果 | **类图退化成"一堆带类名的圆角矩形 + 无方向语义的箭头"** |

### 4.2 ER 图

draw.io 的实体表是"父 cell + 每行一个子 cell（`parent=<表 id>`）"。

| 环节 | 结果 |
|---|---|
| 导入 | `parent` 被完全忽略 → 表头 + 8 个列 cell 变成 **9 个互不相关的节点** |
| 布局 | 9 个节点被当成 9 个独立实体排版 |
| 导出 | 全部 `parent="1"` → 列永远回不到表里 |
| 净效果 | **一张 ER 图变成 9 张散落的便签** |

### 4.3 泳道图 / BPMN

泳道是带 `swimlane` style 的容器 cell。导入后泳道与其中的任务变成同级节点；导出后没有容器概念。BPMN 的事件圆、网关菱形、子流程折叠框在 Studio 里没有对应形状。

### 4.4 多页 `.drawio` 文件

- 未压缩：所有页的 cell 被合并进一张图，节点 id 可能撞车（`validateDiagramSemantics` 会因重复 id 直接 422）。
- 压缩：只解第一页，其余页无声消失。

---

## 5. 目标架构：Draw.io XML 单一真源

### 5.1 唯一权威模型

完整 `mxfile` 是所有文档的持久化真源。它保留 `diagram` 页面、`mxGraphModel`、`root` cell、父子关系、geometry、style、HTML label、自定义 shape/stencil、UserObject、图层和自定义属性。

`DiagramDocument` 只作为可丢弃的语义投影存在。它可从当前页面的部分 cell 派生，供现有 C4 / Flowchart / Sequence 功能使用；它不能代表完整原生文档，也不能在保存时反向覆盖整个 XML。

### 5.2 修改路径

- **原生编辑**：Draw.io iframe 返回完整 XML，Studio 直接把该 XML 作为当前权威版本存储、版本化并写回工作区文件。
- **Studio 语义编辑**：先验证当前 XML 与语义投影逐 cell 对应，且没有未知 cell、未知结构、未表达的 style key 或 HTML label 信息；确认安全后，依据 cell id 将新投影产生的受支持 cell patch 回当前 XML。保留原 `mxfile`、页面/model 元数据以及其他未改变的 cell。
- **安全检查失败**：不允许语义编辑提交，也不自动重建 XML；界面切换/保留在原生 Draw.io 编辑模式，并解释原因。
- **布局**：打开/import/bootstrap 时不运行布局。只有用户显式选择 Studio 自动布局，且文档通过完整性门禁后才允许执行。
- **服务端**：XML 持久化校验与语义布局校验分开。文档保存要验证 XML 体积、基本 envelope、工作区路径和 revision；只有 semantic operations 才使用现有角色/关系/布局规则。

### 5.3 多页和未知结构

多页 `mxfile` 的语义投影可以临时只读第一页，但原始 XML 始终保留所有页。重复 cell id 在不同页面是允许的，不得把多页 root cells 合并到一张语义图里。任何未知 cell、形状、wrapper、stencil 或自定义属性一律保留在 XML；“不理解”不等于“删除”。

### 5.4 AI 与安全

AI 不生成原始 XML，也不能执行未经校验的 style id。未来原生图的 AI 能力通过受约束的 cell 操作实现，例如改文本、移动/调整尺寸、修改允许的 style key、创建或删除连线、添加页面。服务器校验操作输入、当前 source revision 和变更范围，并在应用前创建不可变版本。Studio 语义布局的质量门不应用于普通原生 cell 编辑。

### 5.5 设计语言和渲染

Draw.io 继续作为唯一最终图形渲染器。共享 render spec 只指导 Studio 生成/修改的语义 cell；它不能强制覆盖原生 XML 中用户明确设置的样式。原生图形的设计语言叠加应作为显式的、可撤销操作，不能默认为保存时重写所有样式。

## 6. 改造路线图

### 阶段 0：止血与单源决策

1. 接受 ADR-0006，更新架构文档和 Agent 规则，明确 XML 是唯一真源。
2. 导入和 workspace bootstrap 保留完整源 XML，取消自动布局；多页仅生成第一页投影，绝不合并页面 cell。
3. 原生 XML 在保存、版本历史、导出和工作区写入中优先且完整；持久化 endpoint 不再用语义角色/关系/复杂度限制拒绝合法 Draw.io 文件。
4. 为 Studio 语义画布建立完整性门禁：未知 cell / 标签 / style / page / nesting 不能被表达时，禁用语义写操作与自动布局。
5. 为安全可编辑的 Studio 文档增加 XML cell patch，按 id 合并新旧 cell，禁止 whole-document regeneration 覆盖源文件。

**验收**：任意合法 Draw.io 文件打开后不自动布局；保存未修改文档不降级；多页、未知 cell 和自定义 shape 在 round-trip 后仍保留；安全门禁失败时 Studio 语义修改不会提交。

### 阶段 1：XML patch 与回归测试

- 覆盖 XML envelope、multi-page preservation、opaque cells、unknown styles/custom attributes、geometry and labels、cell add/update/delete 的测试。
- 对任意不能验证无损的 XML 明确返回“不支持 Studio 语义编辑”而不是静默 fallback。
- 测试版本恢复和并发保存时，revision 对应的是完整 XML，而非只对应语义投影。

### 阶段 2：原生 cell 操作与 AI

- 服务端提供 typed cell operations；操作输入为 ID + 允许的字段，不接受模型直接提供 arbitrary XML。
- 操作须检查 cell 存在、类型、字段白名单、坐标/尺寸范围和 source revision；通过后写入完整 XML并创建版本快照。
- 首批支持改文本、移动/改尺寸、编辑允许的视觉属性、连接关系、创建/删除 cell；保留 Draw.io 未知属性并拒绝存在歧义的修改。
- 语义 C4 / Flowchart / Sequence 工具是其上的专项能力，不作为所有图形都必须具备的前置条件。

### 阶段 3：可选语义扩展

只有当 UML / ER / BPMN 等需要比原生 cell 操作更高层的语义工作流时，才新增对应的局部投影、布局和质量规则。它们仍然读取并写回唯一 XML 真源，不能创建第二份持久化真源。

## 7. 迁移与兼容

- **老工作区**：现有 `document` 字段作为迁移期派生缓存读取；`drawioXml` 是唯一保存与版本化真源。若 XML 缺失，只允许对确认为旧版 Studio 自建的文档执行一次性生成迁移，并创建显式版本；不得对外部 Draw.io 文档静默生成替代 XML。
- **版本历史**：每个版本保存完整 XML 和可选的语义缓存。回滚时恢复 XML 原文；缓存可从 XML 重新派生。
- **页面**：完整多页文件在版本中整体保存。Studio 的局部投影与当前页面绑定，不能把其他页中的 cell 混入当前页面。
- **Revision**：并发冲突和版本哈希以 XML 为核心，语义缓存不独立产生 revision。
- **错误处理**：无法解析或 patch XML 时拒绝这次修改并保持此前 source 不变；不能悄悄切换到 `toDrawioXml(document)` 作为 fallback。

## 8. 明确不建议做的事

1. **不要再以 `DiagramDocument` 为 golden source。** 完整 Draw.io XML 是所有文档的唯一真源。
2. **不要引入 semantic/native 双真源。** 语义模型只是派生投影与一组可选的编辑能力。
3. **不要把整个 XML 从语义模型重新生成并覆盖原文件。** 所有局部编辑必须以 cell identity 为边界 patch 回源 XML。
4. **不要导入即自动布局。** 原生文件打开应保持几何和连线不变，布局是用户显式选择的能力。
5. **不要为支持所有 shape 复制一份 mxGraph 模型或 SVG renderer。** 非法/未知内容应保存在 XML 中，由 Draw.io 原生引擎渲染。
6. **不要把语义质量分用于拒绝所有原生 XML 编辑。** 对不经过语义布局的操作只执行 XML 结构、字段白名单、revision 和版本护栏。
7. **不要让 AI 直接生成原始 XML。** 通过 server-owned typed cell operations 操作 XML。

## 9. 证据索引

| 结论 | 证据位置 |
|---|---|
| 图类型封闭 | `v2/src/model/types.ts:1`、`:148` |
| 形状仅 3 种 | `v2/src/design/styles.ts:10`、`:46-53`；`DiagramCanvas.tsx:105-113` |
| 语义 role 封闭 | `v2/src/model/types.ts:4-9` |
| 导入有损 | `v2/src/import/drawio.ts:13-21`、`:96`、`:124`、`:148-149`、`:169-178` |
| 导入忽略 parent / layer / page | `v2/src/import/drawio.ts:91-180`（循环体内无 parent 读取） |
| 多页处理错误 | `v2/src/import/drawio.ts:40-69`（压缩仅首屏）、`:79`（未压缩全合并） |
| 导出硬编码根层 | `v2/src/export/drawio.ts:21`、`:44` |
| 导出单页 | `v2/src/export/drawio.ts:142-144` |
| 编辑清空原生 XML | `v2/src/App.tsx:480-484`、`:1127` |
| 导入强制重排 | `v2/src/App.tsx:756-771` |
| 切换类型清空文档 | `v2/src/App.tsx:596-609` |
| 服务端白名单与上限 | `v2/server/diagram-domain.ts:7`、`:9-11`、`:33` |
| 保存写入重建 XML | `v2/server/copilot-server.ts:726`、`:756-759` |
| AI 编辑必然重排 | `v2/server/copilot-server.ts:1033`、`:1087`、`:1102`、`:1134`、`:1156` |
| AI 工具枚举封闭 | `v2/server/copilot/diagram-tools.ts:23-25`、`:117`、`:120` |
| 禁止 AI 写 XML | `v2/server/copilot/diagram-tools.ts:74`；`AGENTS.md` |
| 布局按 role 硬编码列 | `v2/src/layout/elk.ts:8-41` |
| 质量指标语义耦合 | `v2/src/layout/quality.ts`（全篇）、`complexity.ts:22-23` |
| iframe 可注入样式（已有先例） | `v2/src/components/DrawioFrame.tsx:172-194` |
| 设计原则原文 | `ARCHITECTURE-V2.md:45-49`、`:55-66` |

---

## 10. 附：验证基线

改动前的测试状态（`npm test`，67 项）：

- `server/workspace-files.test.ts` ×2 —— macOS `realpath` 返回 `/private/var/…`，断言写的是 `/var/…`；
- `src/App.test.ts` "parses a server-validated direct operation receipt separately from a preview" —— `parseAIIntentPlan()` 只返回 `{commands, reply}`，`application` 解析只存在于 `validatePlan()`。

这 3 项是**本次评审之前就存在的失败**，与图形类型扩展无关，但阶段 0 的改动落地前应先修好，否则无法区分新引入的回归。
