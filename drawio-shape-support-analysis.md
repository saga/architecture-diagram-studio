# 扩展到「Draw.io 全图形/全形状」的能力评估与改造报告

> 对象：`architecture-diagram-studio` V2（`v2/`，约 9.4k 行 TS/TSX）
> 目标：评估现状是否支持"不止数据流/时序/C4，而是 Draw.io 支持的所有图形"，列出问题并给出改造方案。
> 结论先行：**当前架构不支持，且不是"加个枚举"能解决的**——真正的阻塞在「模型层没有形状概念」+「导入导出是有损降级的」+「若干 ADR 明确把该目标排除在范围外」。
>
> 关联文档：根目录 `DRAWIO-DIAGRAM-TYPE-READINESS-REPORT.md` 是同一议题的另一份评审（并行产出）。本报告已把其中更锐利的"双轨"选型与场景推演合并进来（第 3.6 / 4 节），两文结论一致：以**双轨（语义轨 + 原生轨）**为目标形态，本报告提供更细的落地步骤与文件级证据。

---

## 0. 术语与两种解读

"Draw.io 支持的所有图形"有两种截然不同的规模，必须先分清：

| 解读 | 含义 | 规模 | 现状 |
|---|---|---|---|
| **A. 全形状** | 节点可以是 Draw.io 的任意形状（ellipse/cylinder/cloud/note/swimlane/image/mxgraph.* 等，数百种） | 中：需要 shape 抽象 + 保真导入导出 + shape-aware 渲染/碰撞 | ❌ 模型无 shape 字段，导入靠猜，导出只有 3 种 |
| **B. 全图类型** | 支持 ER / UML / Swimlane / BPMN / Org Chart / Gantt / MindMap / Fishbone / Venn / Network… 等 44 种图语法 | 大：每种图需要 grammar + 布局 + inspector + 校验 | ❌ 全部缺失，仅 3 种 |

本报告覆盖两者，给出的路线是 **B 的"通用兜底语法"优先，再做 A 的保真**。

---

## 1. 现状架构评估：骨架是对的，三处是硬阻塞

### 1.1 骨架（值得保留）

- 分层清晰：`model/` → `layout/` → `design/` → `export|import/` → `server/`，ADR 已固化职责（`docs/adr/0003:12-24`）。
- 服务端是唯一执行边界，AI 不得写坐标/XML（`AGENTS.md:12-14`、`docs/adr/0002:23`）——**这条必须保留**。
- 语义模型是唯一真值，Draw.io 是 renderer 而非 design system（`ARCHITECTURE-V2.md:1578`、`:1592-1594`）。
- 质量门 + 版本快照 + proposal/确认流程已就位（`server/copilot-server.ts:487-560`）。

### 1.2 硬阻塞一：语义模型里没有"形状"这件事

```
src/model/types.ts
  :1    DiagramKind = "c4" | "flowchart" | "sequence"      // 封闭联合
  :9    EdgeKind = "flow" | "call" | "return" | "async" | "event" | "dependency"
  :18-30 DiagramNode { id, name, role, visualRole, x, y, width, height, layoutHints }
        ↑ 没有 shape / type / style 字段
  :45-50 DiagramBoundary { id, name, members[] }           // 只是"成员名单"，不是容器
  :141-148 isDiagramDocument() 硬拒绝 kind 之外的一切 + schemaVersion 必须 === 2
```

- `role`/`visualRole` 是**语义**（actor/api/storage…），不是**形状**（rounded-rect/ellipse/cylinder…）。当前系统把"这个节点是数据库"直接等同于"画成圆角矩形"，这两件事在 Draw.io 里是解耦的。
- 规格与实现已经背离：`ARCHITECTURE-V2.md:179` 原本定义了 `type: string`（形状/类型），实现里被删掉换成了 `role`。
- 没有"通用元素"抽象：node / boundary / sequence-fragment 是三套并列类型，而 Draw.io 的 cell 类型远多于此（容器、泳道、图片、文本、图例…）。
- 没有 parent/group 概念，无法表达嵌套容器与泳道。

### 1.3 硬阻塞二：导入导出是"有损且单向降级"的

**导入 `src/import/drawio.ts`：**

| 问题 | 位置 | 后果 |
|---|---|---|
| 形状靠正则猜 | `:13-21` `roleFromStyle` 只认 rhombus/ellipse/database，其余一律 `domain` | 圆柱/云/便签/泳道全部退化为圆角矩形 |
| **忽略 parent 层级** | `:79` 取 `root mxCell`，`:125-128` 直接读 `mxGeometry@x/y` | 子图元坐标是**相对父级**的 → 嵌套图形位置全部错位 |
| 丢弃容器语义 | 无 `parent` 处理 | swimlane / lane / group 变成"节点"，分组丢失 |
| 丢弃非节点 cell | `:93-95`、`:99-120` 只处理 node/boundary/fragment | 图片、文字、图例、独立标签 cell 消失 |
| 丢弃视觉属性 | `:130-138` 只保留 role/visualRole/几何 | **fill/stroke/字号/圆角全部不导入** → Studio 重新上色，Freeform 与 Studio 必然不同（这正是上一轮截图差异的根因） |
| 端点不在模型里就丢边 | `:148-149` | 连到泳道/容器的边直接消失 |
| 私有 style key 依赖 | `:99`、`:106` 依赖 `studioBoundary=1` / `studioSequenceFragment=1` | 只有 Studio 自己导出的文件才认得；外部 draw.io 文件的分组信息不可恢复 |

**导出 `src/export/drawio.ts`：**

| 问题 | 位置 | 后果 |
|---|---|---|
| 只生成 3 种形状 | `src/design/styles.ts:48`（`arcSize=8` / `arcSize=50` / `rhombus`） | 其余形状无法产出 |
| 所有 cell `parent="1"` | `export/drawio.ts:21,44,61,65,77,96,106` | 无法表达嵌套；boundary 只是"一个矩形 + 成员名单" |
| 主题不参与导出 | 导出用固定 `tokens` | 换主题后 Studio 变了、文件没变 |
| 无 image/icon/lane/table | 全文 | — |
| 边路由依赖 mxGraph router | `styles.ts:60` 无显式 waypoints 时用 `orthogonalEdgeStyle` | Freeform 与 Studio 的连线路径必然不同 |

**结论：任何"外部 draw.io 文件 → Studio → 再导出"的过程都会降级成 3 种形状 + 扁平层级 + 重上色。** 这不是 bug，是当前数据模型的必然结果。

### 1.4 硬阻塞三：既有 ADR 明确把该目标排除在范围外

| 文档 | 原文要点 |
|---|---|
| `ARCHITECTURE-V2.md:57-66` | "V2 只把下面三类作为一级产品能力…其它图形暂时不作为独立产品类型" |
| `ARCHITECTURE-V2.md:1608` | "V2 不以'支持更多图形'作为成功标准" |
| `docs/adr/0005:37` | 拒绝"复制第三方形状索引：外来形状标识不一定映射到 Studio 渲染器" |
| `docs/adr/0005:11` | "约定的范围是 F1–F11" |
| `src/App.test.ts:13` | 测试直接断言"一等图类型仅限 C4/flowchart/sequence" |
| `AGENTS.md:12-14` | 禁止让模型直接写 Draw.io XML（这条要保留，但也要允许模型描述"要一个泳道"） |

**所以第一件事不是写代码，是补一份 ADR**（见第 4 节 Phase 0）：目标变更与 `ARCHITECTURE-V2.md:57-66`、ADR0005 直接冲突，没有新 ADR 的话任何实现都会被判定为越界。

---

## 2. 逐层问题清单（按改造难度排序）

### 2.1 模型层 `src/model/types.ts`

1. `DiagramKind` 封闭联合（`:1`）+ 校验器硬拒绝（`:148`）→ 新图类型必须改前端、校验器、fixtures、UI。
2. `DiagramNode` 无 `shape` 字段（`:18-30`）→ 形状信息在模型里不存在。
3. `role`/`visualRole` 必填（`:23-24`），17/5 个封闭枚举 → 服务端三处重复白名单（`server/diagram-domain.ts:9-11`、`server/copilot-server.ts:1002-1004`、前端 `types.ts:4-8`）。
4. `schemaVersion` 必须 `=== 2`（`:142`）→ 没有任何 schema 迁移器，将来升版本会读不了旧文件。
5. 无 `parentId` / 容器 / 泳道 / 图片 / 文本元素。
6. `theme: "studio-editorial"` 是单值（`:67`）→ 主题无法进模型，也就无法进导出。

### 2.2 布局层 `src/layout/`

1. `elk.ts:9` `applyC4SemanticRanks` 只处理 `kind==="c4"`；`elk.ts:164-173` 的 `else` 分支**默认按 C4 处理** → 任何新 kind 会被强行套 C4 语义（external/storage 自动分区），是"未定义行为"。
2. `dagre.ts:11` 只排除 sequence；`layout.ts:86,118` sequence 特判；`sequence.ts` 全部只服务时序。
3. `routing.ts:22-30` 端口/几何全部基于**矩形包围盒**（`pointAtPort` 沿包围盒边均匀分布）→ 对椭圆/菱形/圆柱的连线锚点不成立。
4. `routing.ts` / `quality.ts:33-45` 碰撞检测用 `segmentIntersectsRect` → 形状感知的相交判断缺失，菱形/椭圆会误报。
5. ELK 只收到 `width/height`（`elk.ts:126-129`）→ 没有端口约束、没有 shape、没有"容器"概念。
6. `profiles.ts:11-18` 只有 6 个引擎 profile；`model/fixtures.ts:27` 却用 `"sequence-standard"`（不在列表内）→ `resolveLayoutProfile` 静默降级为 `elk-layered`（`profiles.ts:30-33`），而服务端 `layoutProfileEnabled` 对 sequence 直接返回 true（`copilot-server.ts:244-247`）→ **配置面板显示的"算法"与实际执行引擎不一致**（隐性 bug）。
7. 尺寸写死在 fixtures/styles（206×90 等），没有尺寸档位体系（对照 `diagram-design` 的 12 档）。
8. 时序几何常量 `148 / 72` 硬编码在 4 处（`export/drawio.ts:69`、`DiagramCanvas.tsx:379`、`quality.ts:141`、`sequence.ts`）→ 改一次要改四处。

### 2.3 渲染层 `src/components/DiagramCanvas.tsx` + `src/design/`

1. `nodePath` 只有 rect / pill / diamond 三种（`:105-111`）→ 画布渲染不了其它形状。
2. 主题只作用于 `.diagram-svg`（`src/styles.css:467-468, 645-675`）→ 导出永远用基础色，**主题与文件永久不一致**。
3. Studio 画布与 Draw.io 是两套渲染器，视觉常量各写一份（详见上一份报告：`diagram-design-style-report.md`）→ 双渲染器漂移。
4. `styles.ts` 的 `mxNodeStyle` 写死 `fontFamily=Arial`、`fontSize=13`，与 Studio 的 `tokens.font`（Inter）不一致。

### 2.4 质量层 `src/layout/quality.ts` / `complexity.ts`

1. 全部按包围盒计算（`:33-45`），无 shape-aware 碰撞/连线。
2. `complexity.ts:11,22-23` 按 kind 写死预算，新 kind 无预算 → 只能落到默认 32/40。
3. 无 "未知形状/未知 cell" 的质量语义。

### 2.5 服务端 `server/`

1. `diagram-domain.ts:9-11` 与 `copilot-server.ts:1002-1004` **重复两份**白名单（外加前端第三份）→ 改一处漏两处的典型来源。
2. 语义校验不包含"该 kind 是否有对应布局语法"、"shape 是否被支持"、"层级是否合法"。
3. 模板只有 3 个（`diagram-domain.ts:33-36`、`copilot-server.ts` templates 列表）。
4. 版本快照 = document + drawioXml（fidelity 靠 XML，这部分是对的），但 document 侧对非 3 类图形是空的。

### 2.6 AI / 工具层

1. `server/copilot/diagram-tools.ts:66-71` 参考资料 topic 枚举写死 `c4|flowchart|sequence|drawio|layout|validation`。
2. `apply_diagram_operation` 的操作种类写死（node/relation/layout/boundary/sequence-fragment）。
3. 前端 `src/intent/aiProvider.ts` 的 `ALLOWED_COMMANDS` 是**精确字符串匹配** → 无法表达"新建一个泳道/云/数据库圆柱"这类结构化意图。
4. `src/intent/applyIntent.ts` 的正则同样只覆盖节点/关系/样式/方向。

### 2.7 持久化与工作区

1. 一个 workspace 只有一张"主图"（`workspaceState.document`），没有"多图/多页"概念 → Draw.io 的多 page（`<mxfile>` 多 `<diagram>`）完全不支持。
2. `import/drawio.ts:40` 只取 `mxfile diagram` 的**第一个** diagram → 多页文件其余页丢失。

### 2.8 测试与护栏

1. `src/App.test.ts:13` 断言"一等类型仅 3 种"→ 扩展前必须改。
2. **没有 XML round-trip 回归测试**，而 `docs/adr/0003:24` 明确要求 → 形状扩展没有安全网。
3. 没有 parity 测试（Studio SVG vs Draw.io 渲染），双渲染器漂移无人看守。

### 2.9 文档一致性

1. `.github/copilot-instructions.md:4` 仍要求保留 VS Code MCP 配置，与 `docs/adr/0002:13,27`、`AGENTS.md:13` 冲突（陈旧指令）。
2. `ARCHITECTURE-V2.md:179` 的 `type` 与实现不符。

---

## 3. 目标架构：把「形状」从「图类型」里解耦

现有模型把两件事压在一起：**"这张图是什么"（kind/grammar）** 和 **"这个图元长什么样"（shape）**。Draw.io 里它们本来就解耦。解耦后扩展成本从 O(新图类型 × 全栈) 降到 O(新形状 × 1 个注册表)。

```
┌─ Layer 7  服务器治理 ── 共享注册表(前后端一份) / 语义校验 / 质量门 / 版本快照
┌─ Layer 6  质量与指标 ── shape-aware 碰撞、端口间距、label 溢出、复杂度预算
┌─ Layer 5  互操作层 ── 保真导入(absolute 坐标 / parent 树 / 未知 cell 原样保留) + 导出回写
┌─ Layer 4  渲染层   ── Studio 画布 shape 渲染注册表 + 未知 shape fallback
┌─ Layer 3  语法层   ── grammar 插件(c4 / flow / sequence / swimlane / er / …) + generic 兜底
┌─ Layer 2  布局层   ── 引擎(ELK/Dagre) + grammar 提供的语义后处理插件
┌─ Layer 1  元素层   ── 统一 Element(node/relation/container/lane/image/text/annotation)
┌─ Layer 0  形状层   ── 开放注册表：shape id / 几何 / 锚点规则 / 最小尺寸 / 渲染器 / 原生 style
```

### 3.1 Layer 0：形状注册表（核心新增物）

```ts
interface DrawioShape {
  id: string;                 // "rounded-rect" | "ellipse" | "cylinder" | "swimlane" | "note" | ...
  geometry: "box" | "ellipse" | "polygon" | "free" | "container";
  anchors: ("TOP"|"RIGHT"|"BOTTOM"|"LEFT")[];  // 允许连线的边
  minSize?: { w: number; h: number };
  canNest?: boolean;          // 能否作为容器
  studioRenderer?: "rect" | "pill" | "diamond" | "ellipse" | "cylinder" | "fallback";
  mxStyle?: (paint) => string; // 生成 Draw.io style
  nativeStyle?: string;        // 未知形状：原样保留
}
```

关键设计点：

- **未知形状不降级**：导入时遇到未注册的 shape → 存 `nativeStyle` 原文 + `geometry:"free"`，画布用 fallback（包围盒 + 标签）显示，导出时**原样回写**。这解决 ADR0005:37 的顾虑（不复制第三方形状索引），同时不丢用户数据。
- **锚点规则由形状声明** → routing/quality 不再假设矩形。
- **角色与形状解耦**：`role:"storage"` + `shape:"cylinder"` 才是完整描述。

### 3.2 Layer 1-2：元素与语法

- 元素统一为 `Element`（带 `kind: node|relation|container|lane|image|text|annotation`），容器/泳道用 `parentId` 表达嵌套。
- `DiagramKind` 从封闭联合改为**注册表 + 兜底**：
  - 没有任何语法匹配时 → `generic` 语法（纯图布局 + 通用连线 + 无语义后处理）。
  - 这条兜底保证"任何 draw.io 文件都能打开、编辑、保存而不降级"，是本次扩展的**核心价值**。
- 把 `elk.ts:164-173` 里"默认套 C4 语义"改为**按 grammar 选择**，未匹配 → 无语义后处理（消除现在的未定义行为）。

### 3.3 Layer 5：保真互操作（最高杠杆）

- 导入：解析 `parent` 树 → 坐标绝对化；保留未知 cell 的原始 XML（opaque cell store）；保留 fill/stroke/font/radius 到 `node.style`。
- 导出：先回写 opaque cells，再叠加 Studio 语义 cell（boundary/fragment/activation）→ 真正的 round-trip。
- `node.style` 进模型后，Studio 画布按它渲染，Freeform 按它渲染 → **上一轮的双渲染器漂移同时被解决**。

### 3.4 Layer 4/6：渲染与质量

- 画布 `nodePath` 改为 shape 注册表驱动（rect/pill/diamond/ellipse/cylinder/note/fallback）。
- 碰撞/连线改为 shape-aware（用 `geometry` 计算相交，而非包围盒）。
- 复杂度预算从"按 kind 写死"改为"按 grammar 声明 + 通用兜底"。

### 3.5 Layer 7：服务器治理

- 把三份重复的白名单（前端 `types.ts:4-9`、服务端 `diagram-domain.ts:9-11`、`copilot-server.ts:1002-1004`）合并为 `src/shared/registry.ts`，前后端共用同一份。
- 语义校验增加：shape 是否注册/是否可降级、parent 链是否成环、grammar 是否存在、尺寸是否满足 shape 最小值。

### 3.6 架构选型：单轨扩展 vs **双轨**（建议采纳双轨）

上面的分层是"把形状吃进语义模型"的**单轨**路线。另一条更稳的路线是**双轨**：

| 轨道 | 真相源 | 适用 | Studio 提供什么 |
|---|---|---|---|
| **语义轨**（现有） | `DiagramDocument` | C4 / 流程图 / 时序图，以及未来可控的 UML 类图、ER 图 | 自动布局、质量评分、AI 语义编辑、设计语言 |
| **原生轨**（新增） | `.drawio` mxfile 原文 | draw.io 其余全部图形、手绘、stencil、自定义形状 | 设计语言叠加、质量提示、原生编辑器、版本与工作区集成 |

**判别方式**（建议加一个文档级字段）：

```ts
export type DiagramRepresentation = "semantic" | "native";
```

- `native` 轨：**不解析、不重排、不评分**。Studio 只做三件事：① 打开原生编辑器；② 叠加设计语言（一个幂等纯函数 `applyDesignLanguage(mxfile, tokens)`，只重写 `fillColor/strokeColor/fontColor/fontSize/fontFamily/strokeWidth/rounded/arcSize/dashPattern`，**其余一律不动**：shape id、stencil 名、`parent`、`geometry`、`page`、`layer`、`UserObject`、自定义 key 全部原样保留）；③ 版本快照与工作区集成照旧。
- `semantic` 轨：维持现有能力，**并按第 3.1–3.5 节逐步接入形状注册表**（只做受控的一小组：rounded-rect / pill / diamond / ellipse / cylinder / note / container / swimlane），其余一律走 native 轨。
- 质量门与 proposal 的"分数不下降"拒绝逻辑（`copilot-server.ts:512`）**只对 semantic 轨生效**——在 ER / 思维导图上它会误杀合法改动。

**为什么不建议单轨（把全部 draw.io 形状塞进 DiagramDocument）**：

- stencil 数量无界（用户可自定义），"描述全部形状"等于重写 mxGraph 的图形模型；
- 语义模型的价值恰恰在于它**少**——`DiagramNode` 只表达 17 个 role + 5 个 visualRole 是有意为之（`ARCHITECTURE-V2.md:288-297` 的"80% 中性 + 10–20% 语义 + accent ≤2"）；
- `DiagramCanvas` 已用 503 行只换来 3 种形状（`nodePath` 三个分支），继续自绘会重蹈覆辙；
- 因此 native 轨**不应**再写一套 SVG 渲染器——原生轨就用 draw.io 渲染。

**代价**：两条轨需要一次"文档判别"（导入时如何判断这是 semantic 还是 native？）——建议规则：文件里有 `studio*` 私有 style key 或能被 `fromDrawioXml` 完整映射 → semantic；否则 → native（保留原文，不解析）。这与本报告 Phase 2 的 opaque cell store 是同一套机制的两个入口。

---

## 4. 四个真实场景的推演（现状实测路径）

这些不是假设，是照着现有代码走一遍的结果，用来判断"离目标有多远"。

### 4.1 UML 类图（draw.io 内置 `uml` 形状集）

| 环节 | 现状结果 | 依据 |
|---|---|---|
| 导入 | 每个类框 → 一个 `domain` 节点；属性/方法分区（HTML label 第二段之后）被 `plainLabel` 丢弃 | `import/drawio.ts:4-12,13-21` |
| 布局 | `requestServerLayout` 把类框重排成从左到右的层级 | `elk.ts:9,164-173` |
| 保存 | `toDrawioXml` 重建为 `rounded=1;arcSize=8` 圆角矩形 | `styles.ts:48` |
| 净效果 | **类图退化为"一堆带类名的圆角矩形 + 无方向语义的箭头"** | — |

### 4.2 ER 图

draw.io 的实体表是"父 cell + 每行一个子 cell（`parent=<表 id>`）"。

| 环节 | 现状结果 | 依据 |
|---|---|---|
| 导入 | `parent` 被完全忽略 → 表头 + 8 个列 cell 变成 **9 个互不相关的节点** | `import/drawio.ts:79,125-128` |
| 布局 | 9 个节点被当成 9 个独立实体排版 | `layout.ts:50-78` |
| 导出 | 全部 `parent="1"` → 列永远回不到表里 | `export/drawio.ts:21` |
| 净效果 | **一张 ER 图变成 9 张散落的便签** | — |

### 4.3 泳道图 / BPMN

泳道是带 `swimlane` style 的容器 cell。导入后泳道与其中的任务变成同级节点；导出后没有容器概念。BPMN 的事件圆、网关菱形、子流程折叠框在 Studio 里没有对应形状（`nodePath` 只有 3 种）。参照 `types-architecture.md` 的 containment 语法（admin band / traffic box 两类 scope，2+4+8 预算），当前 `DiagramBoundary.members` 只是一个扁平成员名单，无法表达层级。

### 4.4 多页 `.drawio` 文件

- 未压缩：`import/drawio.ts:40` 只取 `mxfile diagram` 的第一个 → 其余页无声消失；
- 若未来改成合并所有页，节点 id 可能撞车，而 `validateDiagramSemantics`（`server/diagram-domain.ts:13`）对重复 id 直接判错。

**这四个场景共同说明**：当前系统是"以 draw.io 为最终渲染器的 C4/流程/时序生成器"，而不是"兼容 draw.io 的图形编辑器"。

---

## 5. 改造路线（5 期，每期可独立发布、可回滚）

### Phase 0 · 决策与护栏（0.5–1 天，先做）

- 新增 ADR-0007「扩展目标：从 3 类图到通用图元 + 保真互操作」，明确：非目标（不复制全部 300+ 形状库）、兼容策略、generic 兜底语义。
- 同步修订 `ARCHITECTURE-V2.md:57-66`、`:1608`，解除与新目标的冲突。
- 补 **XML round-trip 回归测试**（ADR0003:24 要求）：现有 3 类图的 `import → export → import` 幂等（几何/样式/层级 diff = 0）。
- 改 `src/App.test.ts:13` 的硬断言为"至少支持 3 类"（护栏从"禁止扩展"改为"扩展不回归"）。
- 清理 `.github/copilot-instructions.md:4` 的陈旧 MCP 指令。

**验收**：3 类图 round-trip 幂等测试通过；ADR 落地。

### Phase 1 · 文档判别 + 原生轨骨架（3–5 天，双轨的最小可运行形态）

- 文档级加 `representation: "semantic" | "native"`（见 3.6）。
- 导入判别：文件含 `studio*` 私有 style key 且能被完整映射 → semantic；否则 → **native，保留 mxfile 原文不解析**。
- native 轨只做三件事：打开原生编辑器（复用 `DrawioFrame`）、设计语言叠加（`applyDesignLanguage(mxfile, tokens)`，幂等、带版本戳）、版本快照/工作区集成。
- 服务端：`apply-proposal` 的质量门（`copilot-server.ts:512`）与"分数不下降"拒绝逻辑**只对 semantic 轨生效**；native 轨跳过语义校验。
- 存储：`WorkspaceState` 增加 `nativeMxfile?: string`（与 `drawioXml` 并存），native 文档不做 XML→模型→XML 往返。

**验收**：任意外部 draw.io 文件（UML/ER/泳道/思维导图/多页）能打开、编辑、保存，**cell 数量与几何零损失**；semantic 轨行为不变。

### Phase 2 · 形状注册表 + `node.shape`（2–3 天，semantic 轨内）

- 新增 `src/design/shapes.ts` 注册表（先收录 rounded-rect / pill / diamond / ellipse / cylinder / note / cloud / image / container / swimlane / fallback）。
- `DiagramNode` 增 `shape?: string`、`style?: { fill?, stroke?, strokeWidth?, fontSize?, fontFamily?, radius? }`（**可选**，旧文档行为不变）。
- 服务端白名单改为读共享注册表（消除三处重复）。
- 导出：注册表生成 mx style；未注册 shape 回写 `nativeStyle`。
- 导入：按 style 解析 shape（不再只猜 role），保留 fill/stroke。

**验收**：外部 draw.io 文件（含椭圆/圆柱/便签）导入后画布可见、导出后形状不降级；旧文档零行为变化。

### Phase 3 · 保真互操作（3–5 天，最大杠杆）

- 导入支持 `parent` 树 + 绝对坐标；识别 swimlane/lane/group 为容器。
- 保留未知 cell 的原始 XML（opaque store），导出原样回写。
- 多 `<diagram>` 页：至少"不丢页"（可先只保第一页但要显式提示）。
- 修正 `import/drawio.ts:148-149` 丢边问题（端点为容器时保留为"容器端"）。

**验收**：任意外部 draw.io 文件 cell 数量守恒（导入前后对比），几何零错位。

### Phase 4 · 容器与泳道（3–4 天）

- `DiagramBoundary` 升级为真容器（`parentId`、可嵌套、内边距），与 `boundaries` 向后兼容。
- 新增 `lane`（泳道）元素与渲染；`DiagramDocument.lanes`。
- 布局：容器内成员作为 group 交给 ELK（`elk.layered` 的 compound graph），边界随成员包围盒自适应。

**验收**：泳道图打开/编辑/保存不降级；边界始终包含成员（现有 hard constraint 保持）。

### Phase 5 · 语法插件化 + 质量/AI/parity（5–7 天）

- `DiagramKind` 改为注册表 + `generic` 兜底；`isDiagramDocument`（`types.ts:141`）接受未知 kind 并降级为 generic（不再硬拒绝）。
- 布局按 grammar 选择语义后处理；消除 `elk.ts:164-173` 的 C4 默认分支。
- 新增 grammar：`swimlane`、`er`、`org-chart`（最小可用即可，通用布局兜底）。
- 补 schema 迁移器（`schemaVersion` 2 → 3，写入 `src/model/migrations.ts`）。
- shape-aware 碰撞/端口/label 溢出；复杂度预算按 grammar 声明（`complexity.ts` 去 kind 硬编码）。
- AI 工具扩展：`apply_diagram_operation` 支持"创建某形状节点/容器"；把 `aiProvider.ts` 的字符串白名单换成**结构化命令**（`{op:"addShape", shape:"cylinder", role:"storage", ...}`）——遵守 `AGENTS.md:12-14`（AI 不写坐标）；native 轨的 AI 走"cell 级受控操作 + 提案确认"。
- parity 测试：Studio SVG vs Draw.io 渲染的元素清单 diff = 0（配合 `diagram-design-style-report.md` 的双渲染器方案）。

**验收**：形状化图元的质量分与矩形一致（误差 < 5%）；AI 能创建圆柱/泳道。

### 总量估算

Phase 0–3 约 2.5 周（**拿到 80% 价值的最小集**：任意 draw.io 文件不丢、不降级、可编辑保存 + 受控形状扩展）；Phase 4–5 约 2 周（容器/泳道/语法/AI/质量）。若目标只是"能打开所有 draw.io 文件且不降级"，**Phase 0–1 即可**（native 轨）。

---

## 6. 明确的非目标与风险

| 项 | 说明 |
|---|---|
| 不复制 Draw.io 全部 300+ 形状库 | 沿用 `docs/adr/0005:37` 的拒绝理由；semantic 轨只做受控小组，native 轨用"原样保留 + 不解析"替代"猜测映射" |
| 不为 native 轨再写 SVG 渲染器 | `DiagramCanvas` 503 行只换来 3 种形状；native 轨就用 draw.io 渲染 |
| 不让质量评分成为 native 轨的保存门禁 | `copilot-server.ts:512` 的"分数下降 10 分即拒绝"在 ER/思维导图上会误杀合法改动 |
| 不让 AI 生成 mxGraph style id | `AGENTS.md:12-14`、`docs/adr/0002:23`；AI 只能选注册表里的 shape id，native 轨走"cell 级受控操作 + 提案确认" |
| 不改服务端权威边界 | 扩展后仍由 server 做语义校验/质量门/版本快照（`docs/adr/0003`） |
| schema 升级需迁移器 | 当前 `types.ts:142` 严格 `=== 2`，无迁移代码，直接升版本会读不了旧文件 |
| 性能 | ELK + 数百 cell 会慢；需要分批布局与"大图降级到 generic"的策略 |
| 双渲染器漂移 | 上一份报告的 P0/P1 建议（抽 spec + parity 测试）应在 Phase 1 之前或同期完成，否则形状扩展会放大漂移 |
| 多页文件 | Draw.io `<mxfile>` 支持多 `<diagram>`；当前只取第一页（`import/drawio.ts:40`），是否支持需产品决策 |

---

## 7. 立即可做的三件事（不改架构也能先拿收益）

1. **修 `profiles.ts` / fixtures 的 profile 不一致**：`model/fixtures.ts:27` 与 `diagram-domain.ts` 用的 `"sequence-standard"` 不在 `LAYOUT_PROFILES` 内，被静默降级为 `elk-layered`，而 UI 面板显示的是别的值 → 配置面板与真实引擎不一致（1 行修复 + 1 条测试）。
2. **把三份白名单合并成一份共享注册表**（前端 / `diagram-domain.ts` / `copilot-server.ts`）→ 消除"改一处漏两处"。
3. **补 XML round-trip 回归测试**（ADR0003:24 已要求但缺失）→ 在任何形状扩展之前先把安全网铺好。

---

## 附录 A · 证据索引

**模型**：`src/model/types.ts:1,4-9,18-30,45-50,61-83,141-148,182-193`
**导入**：`src/import/drawio.ts:13-21,40,79,93-95,99-120,125-128,148-149,169-178`
**导出**：`src/export/drawio.ts:9-13,19-22,44,61,65,77,96,106,122,133`；`src/design/styles.ts:13-33,46-53,55-65`
**布局**：`src/layout/elk.ts:9,43-57,118-180,182-294`；`src/layout/dagre.ts:11`；`src/layout/layout.ts:86,118`；`src/layout/routing.ts:13-30,31-79,84`；`src/layout/sequence.ts:12,35,84`；`src/layout/profiles.ts:11-18,30-33`；`src/layout/quality.ts:33-45,141`；`src/layout/complexity.ts:11,22-23`
**渲染**：`src/components/DiagramCanvas.tsx:105-111,135-136,379,380-388`；`src/styles.css:467-468,645-675`
**服务端**：`server/diagram-domain.ts:9-11,33-36`；`server/copilot-server.ts:244-247,487-560,1002-1004`；`server/copilot/diagram-tools.ts:49-51,66-71`
**AI**：`src/intent/aiProvider.ts:29-51,76-95`；`src/intent/applyIntent.ts:14-193`
**测试**：`src/App.test.ts:13`
**规格/ADR**：`ARCHITECTURE-V2.md:57-66,139,150-207,333,475-521,602-628,884-940,1213-1256,1578-1598,1608-1640`；`docs/adr/0001:13-19`；`docs/adr/0002:13,23,27`；`docs/adr/0003:12-24`；`docs/adr/0004:12-22`；`docs/adr/0005:11,18-37,40,47`；`AGENTS.md:12-16`；`.github/copilot-instructions.md:4-5`
