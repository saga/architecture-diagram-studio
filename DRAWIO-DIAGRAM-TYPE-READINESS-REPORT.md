# 支持 draw.io 全部图形：架构可行性评审

- 评审对象：`v2/`（React 19 + Vite + antd 6 + 本地 bundled draw.io v32.0.2）
- 评审方式：只读代码分析，**未修改任何源码**
- 结论文件位置：仓库根目录
- 对照基线：`ARCHITECTURE-V2.md`（2026-10-20）

---

## 0. 一句话结论

**当前架构不是"兼容 draw.io 的图形编辑器"，而是"以 draw.io 为最终渲染器的 C4 / 流程图 / 时序图生成器"。**

`DiagramDocument` 是唯一真相源，draw.io XML 只是它的一次投影。因此"支持 draw.io 的所有图形"不是给 `DiagramKind` 再加几个值就能完成的增量改动，它要求推翻"语义模型是唯一真相源"这条前提。

建议的目标形态是**双轨**：

| 轨道 | 真相源 | 适用 | Studio 提供什么 |
|---|---|---|---|
| 语义轨（现有） | `DiagramDocument` | C4 / 流程图 / 时序图，以及未来可控的 UML 类图、ER 图 | 自动布局、质量评分、AI 语义编辑、设计语言 |
| 原生轨（新增） | `.drawio` 的 mxfile 原文 | draw.io 其余全部图形、手绘、stencil、自定义形状 | 设计语言叠加、质量提示、原生编辑器、版本与工作区集成 |

**语义轨不做通用化，原生轨不做语义化。** 试图让 `DiagramDocument` 描述 draw.io 的全部形状，等于重写一遍 mxGraph 的图形模型——那是 draw.io 团队做了十几年的东西，不是这个项目该做的事。

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

## 5. 目标架构：双轨

### 5.1 文档类型判别

```ts
export type DiagramRepresentation = "semantic" | "native";

export interface SemanticDocument {
  schemaVersion: 3;
  representation: "semantic";
  profile: string;                  // "c4" | "flowchart" | "sequence" | "uml-class" | "er" …
  id: string; title: string;
  nodes: DiagramNode[]; relations: DiagramRelation[]; boundaries: DiagramBoundary[];
  layout: LayoutSettings;
  passthrough?: PassthroughPayload; // ← 关键：无损往返
}

export interface NativeDocument {
  schemaVersion: 3;
  representation: "native";
  profile: string;                  // "drawio"
  id: string; title: string;
  mxfile: string;                   // ← 唯一真相源，Studio 永不重建
  pageId: string;
  designOverlay?: { tokenVersion: string; appliedAt: string };
}

export type StudioDocument = SemanticDocument | NativeDocument;
```

### 5.2 语义轨的无损往返

这是**不改架构也能立刻止血**的部分：

```ts
interface PassthroughPayload {
  pageId: string;
  pageName: string;
  pageAttributes: Record<string, string>;   // gridSize / pageWidth / background …
  unknownCells: string;                      // 未被映射的 <mxCell> 原始 XML 片段
}
```

- **导入**：映射已知 cell，其余原样塞进 `unknownCells`；`parent` 链如果指向未映射的 cell，也一并保留。
- **导出**：`toDrawioXml()` 先输出生成 cell，再原样拼回 `unknownCells`。
- **效果**：UML 类图里 Studio 不认识的那部分**不会被销毁**，只是 Studio 不能编辑它。

### 5.3 形状注册表（语义轨）

把"语义"和"画法"解耦：

```ts
// 语义：role 保持不变（C4 词汇）
// 画法：可替换、可扩展
export interface ShapeDefinition {
  id: string;                       // "rect" | "pill" | "diamond" | "parallelogram" | "hexagon" | …
  mxStyle: string;                  // mxGraph style 前缀
  svgPath: (node: DiagramNode) => string;   // Studio SVG 渲染
  labelInset: { top: number; right: number; bottom: number; left: number };
}

export interface DiagramProfile {
  id: string;
  representation: DiagramRepresentation;
  layout: "auto" | "manual";
  editableInStudio: boolean;
  shapeFor: (node: DiagramNode) => string;  // 默认 "rect"
  qualityMetrics: Array<keyof LayoutQualityReport["metrics"]>;
  aiGuidance: string;
}
```

`nodePaint()` 拆成 `paintFor(profile, node)` + `shapeFor(profile, node)`，两者互不依赖。加一种图 = 注册一个 profile + 若干 shape，**不再修改 40 个 `if`**。

### 5.4 原生轨的设计语言叠加

一个纯函数，幂等、可重入、带版本戳：

```ts
export function applyDesignLanguage(mxfile: string, tokens: DesignTokens): string;
```

只重写这些 style key：`fillColor` `strokeColor` `fontColor` `fontSize` `fontFamily` `strokeWidth` `rounded` `arcSize` `dashPattern`。

**其余一律不动**：shape id、stencil 名、`parent`、`geometry`、`page`、`layer`、`UserObject` 属性、自定义 key。

实现路径有两条，建议都留：

1. **离线重写**：保存/导出时改写 XML（可控、可测试、不依赖 iframe 时序）；
2. **运行时注入**：复用 `DrawioFrame.hideSaveAndExitControls()` 已有的 `<style>` 注入机制（`DrawioFrame.tsx:172-194`），用于即时预览。

版本戳的意义：用户手动改过的颜色不会被下次打开时再刷回去。

### 5.5 布局与质量按 profile 分派

```ts
// 现在
const laidOut = document.kind === "sequence" ? normalize(doc) : await layoutDiagram(doc);

// 目标
const profile = resolveProfile(document.profile);
const laidOut = profile.layout === "manual" ? document : await layoutDiagram(document);
```

同理 `evaluateLayout(doc)` 改成 `evaluateLayout(doc, profile.qualityMetrics)`；`apply-proposal` 的质量门禁只对 `representation === "semantic"` 生效。

### 5.6 AI 能力声明

```ts
// 现在：15 个固定 operation，枚举里写死 17 个 role
// 目标：工具描述由 profile 生成
{
  operation: profile.editableInStudio
    ? "add_node" | "update_node" | …      // 语义轨
    : "set_cell_text" | "set_cell_style" | "move_cell" | "add_edge" | "add_page"  // 原生轨（cell 级）
}
```

原生轨的 AI 不做语义理解，只做**受约束的 cell 操作**，仍然走"提案 → 用户确认 → 版本快照"这条既有链路（`diagram-tools.ts:141-145`），安全模型不变。

---

## 6. 改造路线图

工作量按"熟悉代码库的一名工程师"估算，仅作量级参考。

### 阶段 0：止血（3–5 人日）— 不改模型

| # | 动作 | 文件 |
|---|---|---|
| 0.1 | 导入时把源 XML 存进 `passthrough.unknownCells`，导出时拼回 | `import/drawio.ts`、`export/drawio.ts` |
| 0.2 | 导入**不再**无条件 `requestServerLayout`；改成"保留原坐标 + 提供一键自动排版" | `App.tsx:768` |
| 0.3 | Studio 编辑若检测到 `passthrough` 非空，先用源 XML 做一次三向合并，冲突时**拒绝保存并提示**，而不是静默覆盖 | `App.tsx:480` |
| 0.4 | `changeKind` 改为"新建文档"，不再原地替换 | `App.tsx:596` |
| 0.5 | 多页导入显式报错（"仅支持单页文件"），而不是静默合并/丢弃 | `import/drawio.ts:79` |

**验收**：导入一张 UML 类图 → 拖动一个节点 → 保存 → 用 draw.io 打开，属性区、继承箭头、原始坐标全部还在。

### 阶段 1：双轨骨架（2–3 周）

| # | 动作 | 影响面 |
|---|---|---|
| 1.1 | `schemaVersion: 3` + `representation` 判别 + `StudioDocument` 联合类型 | `model/types.ts`、全部持久化路径 |
| 1.2 | `DiagramProfile` 注册表，`kind: DiagramKind` → `profile: string` | 40+ 处 `kind` 分支收敛到 1 个 `resolveProfile()` |
| 1.3 | `NativeDocument` 的存储、版本、打开、导出（不经过语义模型） | `copilot-server.ts`、`useWorkspacePersistence` |
| 1.4 | `applyDesignLanguage()` + 版本戳 | 新增 `src/design/overlay.ts` |
| 1.5 | 服务端校验按 representation 分派（原生轨只校验 XML 可解析 + 体积） | `server/diagram-domain.ts` |
| 1.6 | 前端模式切换改为"文档类型"而非"渲染器" | `App.tsx` |

**验收**：新建一张"原生 draw.io 文档"→ 画任意图形 → 保存 → 重新打开 → 内容与样式零差异；同时界面配色仍是 Studio Editorial。

### 阶段 2：形状与容器（3–4 周）

| # | 动作 |
|---|---|
| 2.1 | `ShapeDefinition` 注册表，语义轨支持 12–15 种常用形状 |
| 2.2 | `DiagramNode.parentId?` + `DiagramDocument.groups[]`，导出 `parent` 不再硬编码 |
| 2.3 | `DiagramBoundary` 升级为真容器（移动边界带动成员） |
| 2.4 | 多页 / 图层：`pages: Page[]`，`toDrawioXml` 产出多个 `<diagram>` |
| 2.5 | 质量指标按 profile 分派；原生轨只保留"标签溢出 / 越界"两项提示性检查 |

### 阶段 3：AI 与体验（2–3 周）

| # | 动作 |
|---|---|
| 3.1 | 工具契约由 profile 生成，原生轨提供 cell 级操作 |
| 3.2 | Copilot 提示词按 profile 注入 guidance（替换 `diagram-tools.ts:70-77` 的 5 条硬编码） |
| 3.3 | 模板库从 3 个扩到"每种 profile 至少 1 个" |
| 3.4 | 质量面板对原生轨降级为"提示"，不参与保存门禁 |

**总计约 8–11 周。** 其中阶段 0 是**无论走不走双轨都必须做的**——它修的是正在发生的数据丢失。

---

## 7. 迁移与兼容

- **读写兼容**：`schemaVersion: 2` 的文档在加载时按 `kind` 推断 `profile`，`representation` 默认 `"semantic"`，`passthrough` 为空。读取路径加分支即可，无需批量迁移脚本。
- **磁盘格式**：`.drawio` 文件始终是合法 mxfile，draw.io 本体永远能打开。这是现有设计的最大优势，必须保住。
- **版本历史**：`DiagramVersion` 已同时存 `document` 和 `drawioXml`（`copilot-server.ts:746-755`），天然兼容双轨——原生轨只写 `drawioXml`，`document` 为 `null` 或轻量元数据。
- **回滚**：`restore-version` 只需按 `representation` 选择恢复哪一份，逻辑不变。

---

## 8. 明确不建议做的事

1. **不要试图让 `DiagramDocument` 描述 draw.io 的全部形状。** 这是无界建模问题（stencil 数千个，且用户可自定义）。语义模型的价值恰恰在于它"少"。
2. **不要为原生轨实现 SVG 渲染器。** `DiagramCanvas` 已经证明自绘的成本（503 行只换来 3 种形状）。原生轨就该用 draw.io 渲染。
3. **不要让质量评分成为原生轨的保存门禁。** `apply-proposal` 现在的 `score < base - 10` 拒绝逻辑（`copilot-server.ts:512`）在 ER / 思维导图上会误杀大量合法改动。
4. **不要保留"切换图形类型 = 换示例"这个交互。** 它在多类型世界里没有语义。
5. **不要让 AI 直接写 XML。** 现有约束（`diagram-tools.ts:74`、`AGENTS.md`）是对的，原生轨也应该走"cell 级受控操作 + 提案确认"。

---

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
