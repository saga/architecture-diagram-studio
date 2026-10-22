# diagram-design 风格与布局深度分析报告

> **历史设计研究与候选规则（2026-10-22）**。本文分析了旧 SVG/Canvas 实现，保留其规则、示例和原始路径作为参考，不是当前实施说明。V2 只有原生 Draw.io 画布。可复用原则应映射到 [ADR-0012 的扩展契约](./adr/0012-native-diagram-extension-contracts.md)：布局/样式返回类型化 cell 操作，质量/对比度/可访问性返回诊断。旧 renderer、旧 layout engine 和语义模型均不直接搬回。

> 本地仓库：`/Users/saga/code-repos/diagram-design`  
> 在线 gallery：`https://cathrynlavery.github.io/diagram-design/`  
> 目标系统：`architecture-diagram-studio` V2 自动布局与 Draw.io 导出链路  
> 约束：本报告仅分析与建议，不修改任何代码。

---

## 0. 执行摘要

`diagram-design` 不是一个自动布局引擎，而是一个 **Agent Skill + 编辑风格规范 + 验证脚本** 体系。它的价值不在于“如何自动排版”，而在于：

1. **严格几何约束**：4px 网格、固定尺寸档位、固定间距档位。
2. **语义布局模式**：external 右侧、storage 底部、containment 层级、delta 对比。
3. **连接器语法**：正交 elbow、端口选择、端口分散、hop/bridge、穿越规则。
4. **质量门**：overlap、edge-through-node、label mask 裁剪、connector routing、contrast、CJK 宽度。
5. **复杂度预算**：每种图类型有明确节点/边/层级上限。
6. **视觉 token**：单一 accent、语义节点类型、无阴影、hairline、可访问性。

对 Studio 的借鉴应聚焦于：**布局后处理、质量评分、语义模式、导出渲染约束**，而不是替换 ELK/Dagre。

---

## 1. 本地仓库结构与证据来源

### 1.1 关键文件

- `skills/diagram-design/references/style-guide.md`：视觉 token 单一真源
- `skills/diagram-design/references/layout-budget.md`：4px 网格、尺寸档位、间距档位、复杂度预算、页面布局
- `skills/diagram-design/references/primitives-core.md`：SVG 原语、节点框、箭头、连接器六条硬规则
- `skills/diagram-design/references/type-architecture.md`：架构图布局、zone、containment、hop/bridge
- `skills/diagram-design/references/type-sequence.md`：时序图布局、combined fragments、activation bar
- `skills/diagram-design/references/output-spec.md`：format/size/detail/audience 四个 dial
- `skills/diagram-design/references/semantic-patterns.md`：9 个语义模式
- `scripts/verify-geometry.py`：几何与连接器验证
- `scripts/verify-architecture-containment.py`：containment 验证
- `scripts/verify-contrast.py`：对比度验证
- `scripts/verify-treemap.py`：文本宽度验证

### 1.2 Gallery 观察

在线 gallery 展示 45 种图类型，每种有三种变体：

- Minimal light
- Minimal dark
- Full editorial

图类型包括 Architecture、Architecture delta、IT current-state、Flowchart、Sequence、State、ER、Timeline、Swimlane、Quadrant、Radar、Polar、Loop、Nested、Tree、Org chart、Layers、Exploded axonometric、Axonometric plan、Venn、Pyramid、Bar、Waterfall、Treemap、Heatmap、Line、Gantt、Scatter、High-Level、Process、Medallion、Data flow、DP integration、DP security matrix、Sankey、Fishbone、Wardley map、Kanban、User journey、Deployment、Dependency graph、UML class、Story map、Database schema、Service blueprint。

这说明 diagram-design 的核心不是“自动布局算法”，而是 **类型语法 + 视觉品味 + 验证**。

---

## 2. 视觉品味深度分析

### 2.1 核心美学

- **无阴影、无立体、无过度圆角**
- **1px hairline** 作为主要边界
- **单一 accent**，仅用于 1–2 个 focal 节点
- **4px 硬网格**：所有坐标、尺寸、间距必须是 4 的倍数
- **密度目标 4/10**：优先删除冗余节点，而不是堆叠
- **纸面优先**：默认干净背景，不默认容器边框/背景
- **可访问性**：SVG `role="img"`、`<title>/<desc>`、ID 前缀

### 2.2 Token 体系

语义角色而非颜色值：

- `paper` / `paper-2`
- `ink` / `ink-strong`
- `muted` / `soft`
- `rule` / `rule-solid`
- `accent` / `accent-tint`
- `link`

节点类型映射：

- `focal`：accent-tint + accent
- `backend`：白底 + ink
- `store`：ink @ 0.05 + muted
- `external`：ink @ 0.03 + ink @ 0.30
- `input`：muted @ 0.10 + soft
- `optional`：ink @ 0.02 + ink @ 0.20 dashed
- `security`：accent @ 0.05 + accent @ 0.50 dashed

### 2.3 对比度与字体

- 文本最低 4.5:1
- 非文本标记最低 3:1
- 三字体家族：Instrument Serif / Geist / Geist Mono
- CJK/Hangul/Cyrillic 有专门字体 fallback 与宽度预算
- 宽字符按 1em 计算，拉丁字符按 0.60/0.62em 计算

---

## 3. 布局与几何深度分析

### 3.1 4px 网格

**Structural geometry, divisible by 4：**

- node origins
- widths
- heights
- gaps
- padding

**Off-grid by design：**

- type sizes
- radii
- data-derived positions
- text baselines
- arrow markers
- `.5` offsets
- stroke widths
- opacity
- 22×22 dot-pattern

**Allowed values：**

| Category | Allowed values |
|---|---|
| Node width / height | 80, 96, 112, 120, 128, 140, 144, 160, 180, 200, 240, 320 |
| Gap between nodes | 20, 24, 32, 40, 48 |
| Padding inside boxes | 8, 12, 16 |
| Border radius | 4, 6, 8 |

### 3.2 复杂度预算

Universal rows：

- 9 nodes
- 12 arrows or transitions
- 2 coral elements
- 2 annotation callouts

Per-type limits：

- Architecture components/relationships/ledger entries：8 / 10 / 8
- Architecture containment：admin bands 2 / traffic scopes 4 / nodes 8
- Sequence lifelines：5
- Sequence combined fragments：1 default, 2 only if each is single-region opt/loop
- Sequence alt regions：2
- Sequence fragment nesting：1
- Swimlane lanes：5
- Quadrant items：12
- ER entities：8
- Nested levels：6
- Tree depth：4
- Org chart depth：4, nodes 12
- Layers：6
- Exploded axonometric：parts 5 / levels 5 / focal parts 1
- Axonometric plan：tagged rooms/buildings 8 / boxes 40 / focal 1
- Venn circles：3
- Pyramid layers：6
- Radar axes：5, series 5, focal series 1
- Polar categories：8, series 1, focal categories 1
- Bars：8
- Waterfall：8 incl. totals, 1 subtotal
- Treemap cells：8
- Line series：5
- Gantt tasks：12
- Scatter points：30
- Sankey stages/nodes/flows：3 / 8 / 12
- Fishbone categories：6 bones, 3 sub-causes each
- Wardley components/links：9 / 12, 2 movement arrows
- Kanban columns/cards：5 / 12 total, 4 per column
- User journey stages/rows：6 / 3, 2 pain markers
- Service blueprint stages/layers：6 stages; required customer/frontstage/backstage; optional evidence/support; 1 focal cell
- Deployment zones/nodes/paths：3 / 6 / 8, 9 artifacts
- Dependency nodes/edges：9 / 14, 4 ranks, 1 cycle
- UML class classes/relationships：7 / 8, 5 members per compartment
- Story map activities/slices/cards：5 / 3 / 12
- DB schema tables/columns/FKs：5 / 8 shown / 6

### 3.3 连接器六条硬规则

1. **Orthogonal connectors mandatory**：rounded right-angle，quarter-arc `r=8`，plain straight line 仅当 endpoints 共享 x 或 y。Diagonal 是硬 fail。
2. **Label-to-connector margin 6–10px**：label 必须不覆盖 arrow。
3. **No overlapping connectors**：两 connectors 不能共享路径、平行重叠；交叉时 apply hop/bridge；自然重叠时 offset ≥12px。
4. **Shared edge → fan attach points**：同一 edge 上多个 connectors 必须有 distinct attach points，≥12px 间距（小 box ≥8px），公式 `L * k / (N + 1)`。
5. **Connector must not pass behind non-source/target box**，除非几何上不可避免；此时 dashed + label at visible end + no marker on intervening box。
6. **Label mask must not overlap a node painted after it**：mask 与 node bounds 比较，完全包含在 node 内的 badge chip 合法。

### 3.4 端口选择与 hop/bridge

- 目标明显上下时，从 side edge 离开，水平运行，单弯进入 top/bottom edge。
- 目标左右时，从 side edge 离开，水平运行，进入 side edge。
- 交叉时：less important arrow 添加 hop/bridge arc，radius 8，semicircular bump。
- dashed path 与 solid path 交叉时，bridge dashed one。

### 3.5 Zone grouping

- 2+ nodes 同 tier/trust boundary 时使用 zone rect
- z-order：bg → zones → arrows → nodes
- zone fill：ink @ 0.02
- zone label：soft，never ink opacity
- max 3 flat zones per diagram
- dark mode：roles invert with skin

### 3.6 Containment

- admin band：horizontal full-width containment rect with 24px header
- traffic box：zone rect rx=8
- PaaS placement：managed service never inside traffic scope；only private endpoint inside
- sibling axis：wider than tall → row；taller than wide → column
- metadata：`data-grammar="architecture-containment"`、`data-scope-id`、`data-scope-kind`、`data-parent`
- budget：≤2 admin bands, ≤4 traffic scopes, ≤8 nodes, 2 accent elements

---

## 4. Size / Detail / Audience 深度分析

### 4.1 Size presets

| Preset | viewBox | Aspect | PNG @2 | Type ramp | Use |
|---|---|---|---|---|---|
| doc-inline | 0 0 960 600 | 8:5 | 1920×1200 | standard | Body-width diagram |
| doc-wide | 0 0 1280 720 | 16:9 | 2560×1440 | standard | Full-width docs |
| slide-16x9 | 0 0 1280 720 | 16:9 | 2560×1440 | presentation | Deck slide |
| slide-4x3 | 0 0 1024 768 | 4:3 | 2048×1536 | presentation | Legacy deck |
| social-og | 0 0 1200 632 | ~1.9:1 | 2400×1264 | presentation | Link preview |
| social-square | 0 0 1080 1080 | 1:1 | 2160×2160 | presentation | Feed post |
| print-a4-landscape | 0 0 1120 792 | ~1.41:1 | @3 → 3360×2376 | print | A4 landscape |
| print-a3-landscape | 0 0 1584 1120 | ~1.41:1 | @3 → 4752×3360 | print | A3 landscape |
| print-letter-landscape | 0 0 1056 816 | ~1.29:1 | @3 → 3168×2448 | print | US Letter |
| fit | derived | any | @2 | standard | Vector hand-off |

### 4.2 Type ramp

| Role | standard | presentation | print |
|---|---|---|---|
| Title | 28 | 40 | 32 |
| Node name | 12 | 16 | 12 |
| Sublabel | 9 | 12 | 9 |
| Arrow label | 8 | 12 | 8 |
| Eyebrow/tag | 8 | 8 | 8 |
| Node box min height | 48 | 64 | 48 |
| Min gap | 24 | 40 | 24 |

### 4.3 Detail levels

| Level | Nodes | Edges | Sublabels | What survives |
|---|---|---|---|---|
| faithful | ≤24, zoned | ≤32 | every port/protocol/version | Every distinct component |
| balanced | ≤12 | ≤16 | technical sublabel on ≤4 nodes | Components that carry story |
| simplified | ≤7 | ≤9 | none | Capabilities and sequence |

Degrade ladder：

1. Decorative cells
2. Exact duplicates → `Worker ×N`
3. Leaf clusters → container
4. Degree-1 sinks
5. Cross-cutting infrastructure
6. Split into overview + detail

### 4.4 Audience levels

| Audience | Node names | Sublabels | Edge labels |
|---|---|---|---|
| engineer | exact service/component | protocol, port, version | `POST /v2/orders`, `SQL`, `gRPC` |
| mixed | component names, expanded acronyms | technology only | plain verbs |
| executive | capabilities/outcomes | none | business verbs |

---

## 5. Sequence 图深度分析

### 5.1 布局约定

- Actors as boxes in horizontal row at top
- Lifelines：dashed vertical lines
- Messages：horizontal arrows; time flows top→down
- Activation bar：narrow rect `w=8`, muted fill, 0.8 hairline stroke
- Self-messages：short U-shaped loop; label right of loop
- Return messages：dashed + filled marker
- Coral on primary success response — one, maybe two

### 5.2 Combined fragments

- Frame spans only participating lifelines
- Operator label uses eyebrow role, uppercase, tab at top-left
- Time flows top→down inside frame
- Frame left/right inset ≥12px from outermost participating lifeline centers
- ≥24px between consecutive message y-levels
- Guard sits in first ~20px under tab; first message ≥24px below guard baseline
- Divider y on 4px grid; ≥16px clear of messages above/below
- Nested fragments：max 1 level
- Default：one fragment per diagram

### 5.3 Complexity budget

- Max lifelines：5
- Max messages：12
- Max combined fragments：1 (hard default); 2 only if each single-region opt/loop
- Max alt regions：2
- Max fragment nesting depth：1
- Max coral elements：2 (prefer 1)

---

## 6. 验证脚本深度分析

### 6.1 verify-geometry.py

检查：

- label mask 被后续 node 裁剪
- connector routing：
  - straight segment neither horizontal nor vertical
  - horizontal/vertical segment lying on node border
  - connector endpoint within 8px of node corner
  - two connectors on same edge closer than 12px (8px on edge <48px)
  - two connectors drawn within 1px along continuous stretch >4px
- unparseable arrowed path

Heuristics：

- node：stroked rect ≥60×40
- label mask：rect 20–200 wide, 8–14 tall
- mask fully contained in node = badge chip, legal

### 6.2 verify-architecture-containment.py

检查：

- unique IDs
- resolving innermost parents
- geometric containment
- `<rect>` bounds
- admin-band vs traffic-box shapes
- PaaS placement
- endpoint targets
- sibling axes
- declared peerings
- moved-geometry rule

### 6.3 verify-contrast.py

检查 WCAG 2.x ratio for every token row against paper of its skin.

### 6.4 verify-treemap.py

使用 1em per wide/full-width character 的保守契约。

---

## 7. 与 architecture-diagram-studio 的映射建议

### 7.1 直接可映射到现有代码

| diagram-design 概念 | Studio 现有位置 | 建议 |
|---|---|---|
| 4px grid | `move.ts` 8px 取整 | 改为 4px |
| node width/height allowed values | `model/types.ts` 无限制 | 增加 allowed sizes |
| gap allowed values | `layout/*.ts` | 限制为 20/24/32/40/48 |
| padding | `export/drawio.ts` | 8/12/16 |
| radius | `design/styles.ts` | 4/6/8 |
| complexity budget | 无 | 增加 per-type limits |
| connector orthogonal | `routing.ts` 已有 | 增加 hop/bridge |
| port fanning | 无 | 增加 attach point 计算 |
| hop/bridge | 无 | 增加 crossing detection |
| zone grouping | `boundaries` 已有 | 增加 zone rect 渲染 |
| containment | 无 | 新增 containment layout |
| sequence fragments | 已有 | 增加 combined fragment 渲染 |
| label mask | `DiagramCanvas.tsx` | 增加 mask rect |
| contrast | 无 | 增加 contrast check |
| CJK width | 无 | 增加 per-char width budget |

### 7.2 质量评分映射

`quality.ts` 现有 metrics：

- nodeOverlaps
- edgeNodeIntersections
- edgeCrossings
- labelCollisions
- disconnectedComponents
- alignmentScore
- whitespaceScore
- densityScore

建议新增：

- gridAlignmentScore
- labelOverflowCount
- edgeLabelOutOfBoundsCount
- connectorRoutingViolations
- portSpacingViolations
- hopBridgeMissingCount
- contrastViolations
- cjkWidthViolations

---

## 8. 具体落地方案（不改代码）

### P0：几何与网格

1. 所有布局输出坐标 snap to 4px
2. `nodeSpacing / layerSpacing / boundaryPadding` 设为 4 的倍数
3. `moveNode` 取整从 8 改为 4
4. 冲突搜索步长改为 4 或 8
5. 节点尺寸限制为 allowed values

### P1：质量门强化

1. `quality.ts` 增加 grid alignment score
2. 增加 label overflow 检查
3. 增加 edge label 超出画布检查
4. `layoutDiagram` variant 搜索目标：
   - 0 overlap
   - 0 edge-through-node
   - 0 label collision
   - grid score 最高
   - density 接近 0.18

### P2：语义布局

1. 扩展 `preferredSide` 使用
2. 新增 containment bands
3. 新增 architecture delta 模式
4. 新增 fan-in queue 模式

### P3：视觉 token 与对比度

1. 将 diagram-design 语义角色映射到 `design/tokens.ts`
2. accent 最多 1–2 个节点
3. 导出/渲染时做 contrast check
4. 增加 CJK 字体 fallback

### P4：CJK 与可访问性

1. 节点宽度按字符宽度估算
2. 最小字号 12px
3. 导出 SVG 时保留 accessible name/desc
4. 增加 CJK width budget 验证

---

## 9. 风险与边界

1. **风格是“品味”**：自动布局只能保证几何，不能保证编辑感
2. **对比度/CJK 宽度预算**：会增加计算成本
3. **不复制实现**：不应把 diagram-design 的 HTML 输出直接作为 Studio 的 Draw.io 模型
4. **复杂度预算**：需要 per-type limits，否则自动布局可能生成过密的图
5. **连接器规则**：hop/bridge/port fanning 需要额外的几何计算

---

## 10. 优先级建议

1. **P0 + P1**：网格与质量门，收益最大、风险最低
2. **P2**：语义布局，提升架构图可读性
3. **P3**：视觉 token，提升一致性
4. **P4**：CJK 与可访问性，长期质量

---

## 11. 结论

`diagram-design` 最有价值的部分不是布局算法，而是：

- **编辑品味**：无阴影、hairline、单一 accent、纸面优先
- **4px 网格**：严格几何约束
- **语义模式**：external 右侧、storage 底部、containment、delta
- **连接器语法**：orthogonal、port fanning、hop/bridge
- **质量门**：overlap、edge-through、label mask、contrast、CJK width
- **复杂度预算**：per-type limits

这些仍是有价值的规则输入，但不是当前 V2 已实现的自动布局能力。未来若有明确用例，应分别接入原生操作 provider（几何/路由/样式变更）或只读 analysis provider（重叠、穿线、contrast、CJK 与可访问性诊断）；不得恢复第二套 SVG renderer，也不得直接搬入原来的语义布局链路。

---

## 12. 附录：关键文件引用

- `skills/diagram-design/references/style-guide.md`
- `skills/diagram-design/references/layout-budget.md`
- `skills/diagram-design/references/primitives-core.md`
- `skills/diagram-design/references/type-architecture.md`
- `skills/diagram-design/references/type-sequence.md`
- `skills/diagram-design/references/output-spec.md`
- `skills/diagram-design/references/semantic-patterns.md`
- `scripts/verify-geometry.py`
- `scripts/verify-architecture-containment.py`
- `scripts/verify-contrast.py`
- `scripts/verify-treemap.py`