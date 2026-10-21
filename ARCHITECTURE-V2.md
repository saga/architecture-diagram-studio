# Architecture Diagram Studio V2 架构设计

- 日期：2026-10-20
- 状态：V2 技术架构方案，作为后续实现基线
- 目标：把 Studio 从“能生成 draw.io XML 的图形编辑器”升级成“有设计语言、有布局规则、有 AI 编辑闭环、以 draw.io 为最终渲染器的架构图产品”。

## 1. V2 的核心判断

V2 不应该把 draw.io 当成“自动布局引擎”，也不应该把 React Flow 当成最终渲染器。

推荐采用三层职责：

```text
                    Diagram Design System
               ┌──────────────────────────┐
               │ taste / tokens / grammar │
               │ diagram-specific rules   │
               └────────────┬─────────────┘
                            │
                            ▼
┌──────────────┐     ┌────────────────────┐     ┌──────────────────┐
│ AI / Manual  │ --> │ DiagramDocument V2 │ --> │ Layout Engine    │
│ intent/edit  │     │ semantic truth     │     │ ELK/Dagre/custom │
└──────────────┘     └────────────────────┘     └────────┬─────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────┐
                                                │ Quality / Routing│
                                                │ scorer + repair  │
                                                └────────┬─────────┘
                                                         │
                                                         ▼
                                                ┌──────────────────┐
                                                │ draw.io Adapter  │
                                                │ local bundled Web│
                                                └────────┬─────────┘
                                                         │
                                                         ▼
                                                ┌──────────────────┐
                                                │ native draw.io   │
                                                │ editable canvas  │
                                                └──────────────────┘
```

最重要的一条原则：

> **Draw.io 负责最终的原生渲染和人工编辑；Studio 自己负责语义、设计语言、自动布局、AI 修改和“好不好看”的判断。**

这样既可以得到 draw.io 的原生编辑/导出能力，又不会被 draw.io 默认的 C4、Sequence 或自动布局视觉风格绑架。

---

## 2. V2 要解决的产品问题

### 2.1 三种一级图形

V2 只把下面三类作为一级产品能力：

1. **C4**
   - Context
   - Container
   - Component
2. **Sequence**
3. **Flowchart / Process Flow**

其它图形暂时不作为独立产品类型。底层模型可以保留扩展能力，但 UI、AI prompt、布局器和测试都围绕这三类优化。

### 2.2 好看的定义

V2 的“好看”不能依赖模型随机发挥，也不能简单等于“使用某个主题颜色”。需要把视觉品味变成机器可执行的 Design System。

参考 `cathrynlavery/diagram-design` 的关键不是复制它的 SVG，而是借鉴它的设计方法：

- 少装饰
- 无意义的阴影全部删除
- 1px / hairline 风格边界
- 颜色用于表达语义，而不是给每个节点随机上色
- 一个画面只允许少量 accent
- 统一网格
- 统一间距
- 节点密度受控
- 标签长度、换行、留白和线条路径都属于设计的一部分
- 每个节点必须有存在理由

因此 V2 应定义自己的 `Studio Editorial` 视觉语言，而不是照搬 draw.io 默认主题。

参考：

- https://github.com/cathrynlavery/diagram-design
- https://github.com/cathrynlavery/diagram-design/blob/main/references/style-guide.md

---

# 3. 总体架构

## 3.1 六个核心层

```text
┌──────────────────────────────────────────────────────────────┐
│ 1. Intent Layer                                             │
│    用户 / AI / MCP：create / move / restyle / reroute       │
├──────────────────────────────────────────────────────────────┤
│ 2. Diagram Model                                            │
│    DiagramDocument V2：语义、关系、布局约束、视觉 token     │
├──────────────────────────────────────────────────────────────┤
│ 3. Layout & Routing                                         │
│    ELK Layered + Dagre + Sequence Layout + Flow Layout      │
├──────────────────────────────────────────────────────────────┤
│ 4. Design Quality                                           │
│    overlap / crossing / density / alignment / label checks   │
│    + automatic repair                                       │
├──────────────────────────────────────────────────────────────┤
│ 5. Draw.io Adapter                                          │
│    native mxGraph XML + local bundled draw.io Web           │
├──────────────────────────────────────────────────────────────┤
│ 6. Persistence / Export                                     │
│    DiagramDocument + .drawio + SVG/PNG + history            │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 为什么不让 React Flow 成为最终画布

React Flow 仍然可以保留，而且可以继续借鉴它的布局和交互实现；但 V2 不应该把 React Flow DOM/SVG 作为最终视觉结果。

原因：

- 用户明确要求最终基于 draw.io。
- `.drawio` 必须保持原生可编辑。
- draw.io 自身拥有成熟的连接线、端口、选择、撤销、XML、导出和图形能力。
- React Flow 和 draw.io 同时作为“最终真相”会导致两个 renderer 的几何和样式漂移。

因此 React Flow 在 V2 中最多承担：

- 开发期 layout prototype
- 算法实验
- 与现有代码兼容
- 未来某些非 draw.io preview

但生产画布的 authoritative renderer 是本地打包的 draw.io Web。

---

# 4. DiagramDocument V2

当前 `DiagramDocument` 已经是正确方向，但 V2 需要从“节点 + 坐标”升级成“语义 + 布局约束 + 视觉意图”。

## 4.1 顶层结构

```ts
interface DiagramDocumentV2 {
  schemaVersion: 2;
  id: string;
  title: string;

  kind: 'c4' | 'sequence' | 'flowchart';
  variant?: 'context' | 'container' | 'component';

  theme: ThemeId;
  design: DesignIntent;
  nodes: DiagramNodeV2[];
  relations: DiagramRelationV2[];

  boundaries?: DiagramBoundaryV2[];
  sequence?: SequenceDiagramV2;
  flow?: FlowDiagramV2;

  layout: LayoutStateV2;
  history?: DiagramRevision[];
}
```

## 4.2 节点增加语义角色

不能只知道 `type=external`，还要知道它在布局中的角色。

```ts
interface DiagramNodeV2 {
  id: string;
  type: string;
  label: string;
  description?: string;
  technology?: string;

  semanticRole?:
    | 'actor'
    | 'entry'
    | 'ui'
    | 'domain'
    | 'business'
    | 'api'
    | 'worker'
    | 'data'
    | 'storage'
    | 'external'
    | 'vendor'
    | 'infra';

  visualRole?:
    | 'primary'
    | 'secondary'
    | 'muted'
    | 'external'
    | 'highlight';

  groupId?: string;
  layoutHints?: NodeLayoutHints;
}
```

这样 AI 才能理解：

> “把所有 external 放右边”

不是简单执行 `x += 500`，而是把 `semanticRole=external` 加入布局约束，再重新计算整个图。

---

# 5. Design System：把 taste 写进代码

这是 V2 与当前版本最大的区别。

## 5.1 Design Token

建议建立：

```text
src/design/
  tokens.ts
  themes.ts
  diagram-grammar.ts
  typography.ts
  spacing.ts
  style-resolver.ts
```

### 基础 token

```ts
interface DiagramDesignTokens {
  grid: 4 | 8;

  spacing: {
    xs: number;
    sm: number;
    md: number;
    lg: number;
    xl: number;
    section: number;
  };

  node: {
    minWidth: number;
    maxWidth: number;
    minHeight: number;
    radius: number;
    borderWidth: number;
  };

  typography: {
    titleSize: number;
    nodeTitleSize: number;
    bodySize: number;
    edgeLabelSize: number;
    lineHeight: number;
  };

  edge: {
    width: number;
    dashedWidth: number;
    routing: 'orthogonal' | 'polyline' | 'curved';
    arrow: string;
    minSegment: number;
  };

  color: {
    canvas: string;
    ink: string;
    muted: string;
    border: string;
    accent: string;
    external: string;
    data: string;
    danger: string;
  };
}
```

## 5.2 不允许“彩虹节点”

默认策略：

- 80% 节点使用中性颜色。
- 10–20% 使用语义色。
- accent 默认最多突出 1–2 个关键节点/关系。
- external 不等于“红色”。
- database 不等于“绿色”。
- 每种图形类型使用自己的有限 palette。

## 5.3 C4 视觉语言

推荐不是 draw.io 默认 C4 模板，而是 editorial architecture：

```text
                    Customer
                       │
                       │ HTTPS
                       ▼
┌─────────────────────────────────────────────────┐
│ Order Platform                                  │
│                                                 │
│  ┌─────────────┐    ┌─────────────┐             │
│  │ Web App     │───▶│ Order API   │─────────┐   │
│  │ React       │    │ TypeScript  │         │   │
│  └─────────────┘    └──────┬──────┘         │   │
│                            │                │   │
│                            ▼                ▼   │
│                     ┌─────────────┐    Payment │
│                     │ PostgreSQL  │    Vendor  │
│                     └─────────────┘             │
└─────────────────────────────────────────────────┘
```

重点是：

- boundary 有明显但很轻的视觉层级。
- 内部节点不贴边。
- 数据流方向明确。
- external/vendor 有独立区域。
- 不让边从整个 boundary 中间穿过造成视觉噪音。

---

# 6. 三种 Diagram 的布局策略必须不同

不能再使用一个通用 `layout(document)` 解决所有问题。

## 6.1 C4：语义分层 + 左右数据流

C4 默认布局优先：

```text
LEFT → RIGHT

Actor / Source
      ↓
Entry / UI
      ↓
Domain / Business
      ↓
API / Worker
      ↓
Database / Storage

External / Vendor → 独立右侧 lane
Infra              → 与相关业务层平行
```

但不是机械地按 node type 排列，而是先建立 semantic rank：

```text
rank 0: actor / user / source
rank 1: ui / gateway / entry
rank 2: domain / business
rank 3: api / worker / integration
rank 4: data / storage
rank 5: infra
side: external / vendor
```

然后将真实关系作为约束修正 rank。

### C4 compound layout

ELK Layered 是主力，重点使用：

- compound nodes
- layered rank
- port constraints
- fixed order
- orthogonal/polyline routing
- group padding
- separate connected components

不要只调用 `elk.layout()` 然后接受结果；需要在 ELK 前后各有一层 Studio constraint。

```text
Semantic Graph
     ↓
Rank Assignment
     ↓
ELK Layered
     ↓
Studio Routing Repair
     ↓
Quality Score
     ↓
Accept / Repair / Retry
```

## 6.2 Flowchart：先决定主路径，再放分支

流程图最怕“蜘蛛网”。

默认：

```text
START
  │
  ▼
Step A
  │
  ▼
Decision ──────────┐
  │ yes             │ no
  ▼                 ▼
Step B            Step C
  │                 │
  └───────┬─────────┘
          ▼
        Finish
```

规则：

1. 先找 longest / primary path。
2. primary path 固定在视觉主轴。
3. decision 的 yes/no 分支尽量左右分开。
4. 分支在下游尽早 merge。
5. 不允许 edge 穿过 node。
6. 不允许 edge label 压在其它 edge 上。
7. 反向关系优先使用 routing lane，而不是穿越整个画布。

Flowchart 可以使用 ELK Layered，但要有自己的 edge ordering 和 decision routing。

## 6.3 Sequence：不要套 C4 layout

Sequence 图的核心不是二维 graph layout，而是：

```text
Participants → horizontal ordering
Messages     → strict vertical ordering
Activation   → vertical span
Fragment     → enclosing region
```

因此 sequence 使用专用布局器：

```text
participant order
       ↓
fixed x positions
       ↓
message timeline
       ↓
activation bars
       ↓
alt / opt / loop / par frames
       ↓
label collision repair
```

默认 participant order：

- actor/source
- UI/client
- API/domain
- service
- storage
- external/vendor

但 AI 可以指定 override。

---

# 7. Layout Profile：把“怎么排”变成可复用产品能力

不要让用户直接面对 ELK/Dagre 参数。

提供语义化 Profile：

```ts
type LayoutProfile =
  | 'architecture-flow'
  | 'architecture-layers'
  | 'architecture-compact'
  | 'architecture-wide'
  | 'process-main-path'
  | 'process-decision'
  | 'sequence-standard'
  | 'sequence-dense';
```

例如 `architecture-flow`：

```yaml
direction: RIGHT
primaryAxis: horizontal
externalPlacement: RIGHT
infraPlacement: PARALLEL
rankStrategy: semantic
edgeRouting: ORTHOGONAL
nodeSpacing: 48
layerSpacing: 96
boundaryPadding: 32
```

`architecture-layers`：

```yaml
direction: DOWN
layers:
  - actor
  - ui
  - domain
  - api
  - storage
externalPlacement: RIGHT
infraPlacement: PARALLEL
```

这样用户说“从上到下，用户在最上面，DB 最下面”时，AI 修改的是 profile/constraints，而不是坐标。

---

# 8. Routing：好不好看，50% 是线

V2 不应该只保存 `waypoints`，而应该有明确的 routing policy。

## 8.1 Edge routing policy

```ts
interface EdgeRoutingPolicy {
  mode: 'orthogonal' | 'polyline' | 'curved';
  avoidNodes: boolean;
  avoidEdges: boolean;
  preferSourceSide?: DiagramPortSide;
  preferTargetSide?: DiagramPortSide;
  lane?: string;
  minSegmentLength: number;
  crossingPenalty: number;
}
```

## 8.2 用户说“全部改成折线”时

不能：

```text
edge.style = polyline
```

然后结束。

正确流程：

```text
User intent
  ↓
set global routing.mode = polyline
  ↓
remove obsolete curved waypoints
  ↓
reroute all edges
  ↓
avoid nodes
  ↓
minimize crossings
  ↓
repair labels
  ↓
quality score
  ↓
commit
```

如果只改 style，不重新 route，极容易出现折线穿节点、交叉堆叠的问题。

---

# 9. Quality Engine：V2 的关键护栏

自动布局不能只返回 `DiagramDocument`，必须返回质量报告。

```ts
interface LayoutQualityReport {
  score: number;
  errors: QualityIssue[];
  warnings: QualityIssue[];
  metrics: {
    nodeOverlaps: number;
    edgeNodeIntersections: number;
    edgeCrossings: number;
    labelCollisions: number;
    disconnectedComponents: number;
    alignmentScore: number;
    whitespaceScore: number;
    densityScore: number;
  };
}
```

## 9.1 Hard constraints

以下情况直接失败：

- node-node overlap
- edge 穿过 node
- label 完全不可读
- sequence message 顺序错误
- boundary 包不住成员
- relation 指向不存在节点
- 节点超出画布边界

## 9.2 Soft score

```text
score =
  - 100 * edgeNodeIntersections
  - 80  * nodeOverlaps
  - 35  * edgeCrossings
  - 20  * labelCollisions
  + 10  * alignmentScore
  + 10  * whitespaceScore
  +  8  * directionalConsistency
  +  5  * semanticGrouping
```

权重不是永久 API，先用来建立 regression baseline。

## 9.3 Density

参考 Diagram Design 的“删除无意义元素”理念：

如果一个图超过合理密度，不应该继续缩小字体。

优先顺序：

1. 删除冗余 label。
2. 合并重复关系。
3. 合并过细节点。
4. 使用 boundary/group。
5. 增加画布空间。
6. 最后才降低字体。

---

# 10. Automatic Repair：布局失败后自动修复，而不是直接输出丑图

布局流程应为：

```text
                    ┌───────────────┐
                    │ semantic graph │
                    └───────┬───────┘
                            ▼
                    ┌───────────────┐
                    │ initial layout│
                    └───────┬───────┘
                            ▼
                    ┌───────────────┐
                    │ route edges   │
                    └───────┬───────┘
                            ▼
                    ┌───────────────┐
                    │ quality check │
                    └───────┬───────┘
                       pass │ fail
                            │
                            ▼
                    ┌───────────────┐
                    │ repair pass   │
                    └───────┬───────┘
                            ▼
                    ┌───────────────┐
                    │ score again   │
                    └───────┬───────┘
                            ▼
                     best valid result
```

最多 2–3 个 deterministic repair pass，不要让 AI 在每次 layout 后自由“凭感觉”改坐标。

Repair 优先级：

1. overlap repair
2. edge-node collision
3. edge crossing reduction
4. label collision
5. alignment
6. whitespace balance

---

# 11. AI 架构：AI 不直接改坐标

这是 V2 最重要的 AI 约束。

错误设计：

```text
AI → x/y/waypoint/style 字段 → 直接写 Document
```

正确设计：

```text
AI
 ↓
Intent / Operations
 ↓
Semantic mutation
 ↓
Constraint solver / Layout
 ↓
Quality engine
 ↓
Preview
 ↓
Commit
```

## 11.1 AI Tool 分类

### 创建

```text
create_diagram
```

输入：

- diagram type
- business description
- preferred layout profile
- theme

### 语义编辑

```text
add_node
remove_node
rename_node
connect_nodes
move_group
set_semantic_role
```

### 视觉编辑

```text
set_theme
set_node_style
set_edge_style
set_edge_routing
set_layout_profile
```

### 结构编辑

```text
create_boundary
move_to_boundary
change_layer
reorder_sequence_participants
```

### 全局智能操作

```text
apply_diagram_intent
```

例如：

> “把所有 external 放到右边，所有 DB 放最下面，保持主数据流从左到右。”

AI 应输出：

```json
{
  "intent": "reorganize_layout",
  "constraints": [
    {"role": "external", "placement": "RIGHT"},
    {"role": "storage", "placement": "BOTTOM"},
    {"flow": "primary", "direction": "RIGHT"}
  ]
}
```

然后 Layout Engine 执行。

---

# 12. AI 修改的 Preview / Commit 模型

借鉴 `next-ai-draw-io` 的思路：AI 操作不要直接不可逆地落到画布。

```text
AI stream
   ↓
temporary DiagramDocument
   ↓
validate
   ↓
layout
   ↓
quality check
   ↓
render preview
   ↓
user sees result
   ↓
commit one revision
```

如果 AI 输出一半、请求失败或用户 Stop：

```text
preview → discard
```

不能污染 undo history。

---

# 13. AI 的“智能程度”来自约束，不来自 prompt

Prompt 可以告诉模型设计原则，但不能承担几何正确性。

系统 prompt 应强调：

- 不直接修改 x/y。
- 不自行计算 edge waypoint，除非是局部精确操作。
- 优先修改语义和 layout intent。
- 全局视觉修改必须触发重新布局/route。
- 结果必须通过 quality check。
- 不通过就继续修复。

因此：

```text
LLM = 理解用户意图
Layout Engine = 计算几何
Quality Engine = 判断结果
Draw.io = 最终渲染
```

这四个职责不能混。

---

# 14. Draw.io 集成：本地打包，固定版本

## 14.1 推荐方式

采用 `next-ai-draw-io` 已验证的模式：

```text
draw.war
  ↓
version + SHA256 pinned
  ↓
extract selected web assets
  ↓
public/drawio/
  ↓
same-origin iframe
  ↓
DrawioAdapter
```

不要依赖：

```text
https://embed.diagrams.net
```

作为生产默认路径。

## 14.2 DrawioAdapter

建议新增：

```text
src/drawio/
  drawio-adapter.ts
  drawio-loader.ts
  drawio-bridge.ts
  drawio-style.ts
  drawio-xml.ts
  drawio-import.ts
  drawio-export.ts
```

Adapter 负责：

- load XML
- save XML
- export SVG/PNG
- selection
- undo/redo
- screenshot
- current document readback
- AI changed-cell highlight

不要让业务代码直接调用 `EditorUi` / `mxGraph`。

如果必须访问 draw.io internal API，全部隔离在 Adapter 内，并针对固定 draw.io 版本建立 integration test。

## 14.3 一个 authoritative source

推荐：

```text
DiagramDocument V2
       │
       ├── Layout
       ├── AI operations
       ├── persistence
       └── draw.io XML
                 │
                 ▼
           draw.io canvas
```

draw.io iframe 不是第二个独立业务数据库。

用户手动修改 draw.io 后：

```text
draw.io XML
   ↓
parse / diff
   ↓
DiagramDocument V2
   ↓
new revision
```

必须有明确的 commit/sync 边界。

---

# 15. Draw.io Style Adapter：不要使用默认 C4 / Sequence 样式

所有视觉结果由 Studio Style Resolver 产生。

```ts
resolveNodeStyle({
  diagramKind,
  node,
  theme,
  density,
  state,
})

resolveEdgeStyle({
  relation,
  theme,
  routing,
})
```

输出 draw.io mxGraph style。

## 15.1 C4

建议：

- 轻边框
- 低饱和 fill
- 小圆角
- label hierarchy
- technology 使用 secondary text
- description 使用 muted text
- boundary 使用低对比虚线/细实线
- external 使用轻微区别，不使用夸张颜色

## 15.2 Sequence

建议：

- participant header 简洁
- lifeline 使用 hairline dashed
- message label 使用较小字号
- activation bar 极窄
- fragment 使用低对比 frame
- call / return / async 使用统一箭头语言

## 15.3 Flowchart

建议：

- process：轻边框圆角矩形
- decision：克制的 diamond
- start/end：pill
- connector：统一折线
- yes/no 只保留必要 label
- 不给每个步骤加不同颜色

---

# 16. “External 全部放右边”的实现

这是一个典型的 V2 AI command，应当有确定性实现。

```text
User:
  把所有 external 放到右边

AI:
  semantic constraint:
    role=external → side=RIGHT

Layout:
  reserve right-side lane
  ↓
  place external nodes
  ↓
  layout internal graph
  ↓
  connect internal → external from RIGHT ports
  ↓
  route edges around internal graph
  ↓
  score
```

如果 external 数量太多导致右侧拥挤：

1. 增加 lane 高度。
2. 对 external 做 vertical packing。
3. 将关系集中到最接近 source 的侧面。
4. 必要时使用 edge bundling/lane。
5. 仍然失败才建议拆图。

绝不能简单把所有 external 的 x 坐标设置成同一个值。

---

# 17. “所有线变虚线 / curve → polyline”的实现

## 全局边样式

```text
set_edge_style
  ↓
update design token / relation style override
  ↓
rerender
```

如果只有视觉变化，不必重新布局。

## routing 变化

```text
curve → polyline
  ↓
clear incompatible bend points
  ↓
re-route
  ↓
quality check
```

这里必须区分：

- **style change**：不改变 geometry
- **routing change**：改变 geometry
- **layout change**：重新计算 node geometry

AI Tool 必须知道三者区别。

---

# 18. 手动调整与 AI 调整共存

用户拖动节点后，不应该马上被下一次 AI layout 覆盖。

每个节点增加：

```ts
layoutHints: {
  locked?: boolean;
  preferredRank?: number;
  preferredSide?: 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';
  preferredLane?: string;
}
```

例如用户手动拖动 `Payment Provider` 到右侧后：

```text
locked = true
```

AI 再执行“重新布局”：

- locked nodes 保持位置。
- 其它节点围绕 locked node 重排。
- 如果用户明确说“全部重新排”，才清除 lock。

这样 AI 不会和用户抢画布控制权。

---

# 19. AI 与手工编辑的并发保护

借鉴 `next-ai-draw-io` 的 stale-edit gate 思路。

每个 revision 保存：

```ts
revisionId
parentRevisionId
documentHash
createdBy: 'user' | 'ai' | 'layout'
```

AI 操作开始时记录：

```text
baseRevision = 42
```

如果用户期间手动编辑产生：

```text
revision 43
```

AI 不能直接覆盖 43。

必须：

```text
rebase operation onto 43
```

或者提示冲突。

---

# 20. Layout Engine 的 V2 结构

现有 `src/layout/layout.ts` 需要逐渐拆分。

建议：

```text
src/layout/
  core/
    graph.ts
    constraints.ts
    ranks.ts
    geometry.ts

  c4/
    c4-layout.ts
    c4-rank.ts
    c4-boundary.ts
    c4-routing.ts

  flow/
    flow-layout.ts
    flow-main-path.ts
    flow-decision.ts
    flow-routing.ts

  sequence/
    sequence-layout.ts
    sequence-fragments.ts
    sequence-routing.ts

  engines/
    elk.ts
    dagre.ts
    d3.ts

  quality/
    quality-score.ts
    overlap.ts
    crossings.ts
    labels.ts
    density.ts

  repair/
    repair-overlap.ts
    repair-crossing.ts
    repair-labels.ts
```

现有 ELK/Dagre/D3 不需要立即删除；它们变成底层 engine，而不是产品层 API。

---

# 21. React Flow 的布局经验怎么借鉴

React Flow example 看起来好看的部分，真正值得借鉴的是：

1. 节点尺寸明确。
2. 连接点稳定。
3. edge routing 和 node placement 是一起考虑的。
4. 节点之间有明显 whitespace。
5. graph direction 明确。
6. group/parent layout 不只是画一个背景框。
7. 用户手工移动后，局部 layout 可以保持稳定。

V2 不应该“换成 React Flow 自动布局”，而应该把这些原则提炼成 Layout Contract。

```text
Layout Contract

1. no overlap
2. no edge through node
3. stable direction
4. stable semantic ranks
5. bounded crossing count
6. readable labels
7. predictable spacing
8. locked nodes respected
9. groups contain members
10. result deterministic
```

这样 ELK、Dagre 或未来其它 engine 都必须满足同一 contract。

---

# 22. Layout Determinism

同一个 Document + 同一个 Profile 必须尽量产生同一个 layout。

保存：

```ts
layoutProfile
layoutVersion
randomSeed
engineVersion
```

例如：

```json
{
  "profile": "architecture-flow",
  "engine": "elk",
  "engineVersion": "0.x",
  "layoutVersion": 2,
  "seed": 1
}
```

AI 每次重新生成不应该导致节点随机漂移。

---

# 23. “漂亮”必须进入测试

新增视觉 regression fixtures：

```text
tests/diagrams/
  c4/
    small.json
    ecommerce.json
    enterprise.json
    external-heavy.json

  flow/
    simple.json
    decision.json
    branching.json

  sequence/
    simple.json
    auth-refresh.json
    payment.json
```

每个 fixture：

```text
Document
 → layout
 → quality report
 → draw.io render
 → SVG/PNG snapshot
```

测试至少检查：

- 0 overlaps
- 0 edge-node intersections
- crossing 数量 <= threshold
- labels readable
- expected direction
- external placement
- boundary containment
- snapshot diff

真正达到 V2 目标之前，必须有一批人工认可的 golden diagrams。

---

# 24. Golden Diagram / Taste Corpus

这是实现“像 designer 做的”最重要的长期资产。

建立：

```text
tests/golden/
  c4/
  flow/
  sequence/
```

每张 golden diagram 保存：

- semantic source
- expected layout profile
- theme
- expected draw.io XML
- expected SVG/PNG
- quality metrics
- 人工评分

AI、layout engine、style resolver 每次升级都跑这套 corpus。

如果新算法虽然数学上更优，但视觉评分下降，就不能直接上线。

---

# 25. AI Prompt / Design Guide

AI 不应该知道几百个 draw.io style 字符串。

应该给 AI 一个高层 Design Guide：

```text
Architecture:
- use semantic layers
- primary flow left → right
- external/vendor on right
- storage low in the composition
- keep internal boundaries spacious
- avoid edge crossings
- use one accent for emphasis

Flow:
- preserve one primary path
- branches should diverge clearly
- merge quickly
- decision labels stay near branch origin

Sequence:
- actor/client first
- infrastructure/storage last
- keep message labels short
- avoid unnecessary fragments
```

然后由代码把这些规则转换成 constraints。

---

# 26. Internal Copilot SDK Tool API V2

Diagram intelligence is implemented as internal Studio capabilities registered through the local GitHub Copilot SDK. It is not exposed through a standalone MCP server or an external MCP tool surface.

Internal tools provide design references, active-diagram inspection, authoritative quality evaluation, workspace-example retrieval, revision-bound edit proposals, built-in template previews, version listing, semantic diffs and restore proposals. Tool handlers call shared domain services rather than reimplementing layout, quality or validation.

Proposal tools are non-persistent. Every proposal is bound to the current semantic document and native XML revision. The Studio UI displays the proposed result and requires user confirmation. On confirmation, the server rechecks the current revision, semantic invariants, enabled layout profile and quality regression, then creates an immutable version snapshot before reporting success.

Supported tool outputs and context are bounded. Retrieved project contents are untrusted evidence, not instructions. Mermaid import/conversion remains outside the V2 scope.

# 27. Draw.io 与 AI 的实际交互闭环

最终应该是：

```text
                 User
                  │
                  ▼
             Chat / Canvas
                  │
        ┌─────────┴─────────┐
        │                   │
     Manual             AI Intent
        │                   │
        ▼                   ▼
   DrawioAdapter       Intent Parser
        │                   │
        │             Diagram Ops
        │                   │
        └─────────┬─────────┘
                  ▼
          DiagramDocument V2
                  │
                  ▼
           Layout / Routing
                  │
                  ▼
            Quality Engine
                  │
          ┌───────┴───────┐
          │               │
        fail              pass
          │               │
          ▼               ▼
       Repair          Preview
          │               │
          └───────┬───────┘
                  ▼
             Draw.io Web
                  │
                  ▼
           native rendering
                  │
                  ▼
          SVG / PNG / .drawio
```

---

# 28. V2 与当前架构的关系

不要推翻现有代码。

| 当前能力 | V2 处理方式 |
|---|---|
| `DiagramDocument` | 升级 schema v2，继续作为 semantic source of truth |
| ELK | 保留，升级成 C4/Flow 的底层 engine |
| Dagre | 保留，作为轻量 fallback / prototype engine |
| D3 hierarchy/force | 保留为实验能力，默认 UI 不暴露 |
| draw.io exporter | 保留，升级为 Style Adapter + XML Adapter |
| React Flow | 保留用于现有编辑器/算法实验，逐步减少其作为最终 renderer 的职责 |
| 六种 theme | 收敛成 Design Token + Style Resolver |
| MCP/Copilot | 保留，升级为 intent-oriented tools |
| layout config | 从 engine 参数升级为 semantic Layout Profile |
| waypoints | 保留，但由 routing engine 生成，而不是 AI 任意写 |

---

# 29. 分阶段实施计划

## Phase 1：Design System + V2 model

目标：先解决“丑”。

1. 新建 `src/design/`。
2. 定义 `Studio Editorial` 默认 theme。
3. 定义 C4 / Flow / Sequence 的 style grammar。
4. DiagramDocument 增加 `semanticRole`、`visualRole`、`layoutHints`、`theme`、`layoutProfile`。
5. 建立 10–15 张 golden diagrams。

验收：

- 不再出现默认 draw.io C4 样式。
- 节点、边、字体、spacing 统一。
- 主题能生成 native draw.io style。

## Phase 2：C4 Layout V2

1. ELK Layered 作为主引擎。
2. semantic rank。
3. external/vendor lane。
4. storage bottom。
5. compound boundary。
6. orthogonal routing。
7. quality scorer。
8. repair pass。

验收：

- 典型企业架构图无需人工拖线即可达到可发布水平。

## Phase 3：Flow Layout

1. main path detection。
2. decision branching。
3. merge strategy。
4. crossing reduction。
5. label placement。

验收：

- 常见业务流程图不出现蜘蛛网。

## Phase 4：Sequence Layout

1. participant ordering。
2. message timeline。
3. activation。
4. fragments。
5. label collision repair。

验收：

- Sequence 不再依赖 draw.io 默认自动布局。

## Phase 5：Local draw.io Web

1. 固定 draw.io version + SHA。
2. build-time fetch/extract。
3. `public/drawio/`。
4. same-origin iframe。
5. DrawioAdapter。
6. XML readback。
7. screenshot/export。

验收：

- 无公网也可以打开编辑器。
- `.drawio` 可直接继续在 diagrams.net / draw.io 中编辑。

## Phase 6：AI Intent Engine

1. `apply_diagram_intent`。
2. semantic operations。
3. layout/re-route trigger。
4. preview/commit。
5. stale-edit gate。
6. revision history。

验收：

```text
“所有线改成虚线”
“curve 改成折线”
“所有 external 放右边”
“DB 放最下面”
“保持用户手动放的 API 不动，重新排其它节点”
```

都能产生可读结果，而不是简单修改 style 或坐标。

## Phase 7：视觉回归

1. SVG/PNG snapshots。
2. golden corpus。
3. quality thresholds。
4. draw.io version upgrade test。
5. AI regression prompts。

---

# 30. V2 的最终技术选型

| 领域 | V2 推荐 |
|---|---|
| Semantic model | `DiagramDocument V2` |
| C4 layout | ELK Layered + Studio constraints |
| Flow layout | ELK Layered + main-path/decision constraints |
| Sequence layout | Studio 专用 deterministic layout |
| Lightweight fallback | Dagre |
| Rendering | 本地打包 draw.io Web |
| Draw.io integration | same-origin iframe + Adapter |
| Native format | mxGraph XML / `.drawio` |
| Theme | Studio Design Tokens |
| AI | intent → semantic ops → layout → quality → preview |
| Routing | orthogonal / polyline first，curve 为受控选项 |
| Quality | deterministic geometry + visual metrics |
| Persistence | DiagramDocument revisions |
| Manual edit | draw.io → XML diff → DiagramDocument sync |
| Offline | draw.io Web assets build-time bundled；AI 是否 offline 单独配置 |
| Visual regression | golden SVG/PNG + quality metrics |

---

# 31. 最重要的设计决策

## 决策 1：不要追求“draw.io 默认长什么样”

draw.io 是 renderer，不是 design system。

## 决策 2：不要让 AI 直接画坐标

AI 表达 intent；layout engine 负责 geometry。

## 决策 3：不要把一个通用 layout 算法用于三种图

C4、Flow、Sequence 是三种不同的视觉语法。

## 决策 4：不要把“布局成功”定义为算法没有报错

必须经过 quality engine。

## 决策 5：不要把 React Flow 或 draw.io 当成 semantic source of truth

`DiagramDocument V2` 才是唯一业务真相。

## 决策 6：不要用公网 Embed 作为生产默认

固定版本、本地打包、同源 iframe 是 V2 默认路径。

## 决策 7：不要复制 Diagram Design 的具体视觉资产

借鉴其“把 taste 写成规则”的方法，建立 Studio 自己的 editorial design system。

---

# 32. V2 成功标准

V2 不以“支持更多图形”作为成功标准，而以以下结果作为成功标准：

### C4

> 输入一个中等复杂度企业架构，默认生成的图已经接近可以放进 architecture review 文档，不需要用户先手工整理一遍。

### Flowchart

> 主路径一眼可读，分支清晰，线不穿节点，不出现蜘蛛网。

### Sequence

> participant、message、activation、fragment 层次清楚，读者能沿时间轴自然阅读。

### AI

> 用户说“把 external 放右边”时，系统重新理解布局，而不是把所有节点机械地移动到右边。

### 手工编辑

> 用户拖过的节点可以锁定；AI 重排时不会破坏用户意图。

### Draw.io

> 用户最终看到的是原生 draw.io canvas，并且导出的 `.drawio` 可以继续在标准 draw.io 中编辑。

### Offline

> draw.io Web renderer 不依赖公共在线 Embed；资源随应用固定版本发布。AI 模型是否离线是独立部署问题。

### Visual quality

> 每个版本都有 golden diagrams 和 SVG/PNG regression，不允许“功能正确但视觉退化”悄悄进入 main。

---

# 33. 一句话架构

**V2 = Studio Design System + Semantic Diagram IR + Diagram-specific Layout + Routing/Quality Engine + Local Bundled draw.io Renderer + Intent-based AI。**

其中最关键的产品差异不是“用了 draw.io”，而是：

> **Studio 自己决定什么是一个好看的 C4 / Flow / Sequence；ELK/自研布局负责把它排好；Quality Engine 负责拒绝丑结果；draw.io 负责把最终结果高保真地渲染成用户可以继续编辑的原生图。**
