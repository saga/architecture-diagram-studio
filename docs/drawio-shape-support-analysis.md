# 以 Draw.io XML 为唯一真源的架构改造报告

> **历史架构评估，不是当前实施清单。** 本文保留了改造前的代码路径、行号和候选方案。当前现行决策见 ADR-0011（原生 Draw.io 是唯一模型）、ADR-0012（原生能力扩展契约）和 ADR-0013（Studio-owned Dagre/ELK 自动布局是核心能力）；ADR-0006/0008 是此前的决策记录。文中有关 `DiagramCanvas`、双渲染器、待新增模块和旧 ADR 冲突的描述不应被理解为当前缺陷或现行要求。

> 对象：`architecture-diagram-studio` V2（`v2/`，约 9.4k 行 TS/TSX）
> 目标：把"支持 Draw.io 全部图形"这件事做实，并把全系统的**唯一真源**统一为 **`.drawio` XML（mxfile）**——不再有 `DiagramDocument` 与原生 XML 两套源，不再有"语义轨 / 原生轨"双轨设计。
> 状态：实施前评审基线；当前实现以原生 XML 为唯一真源。V2 不保留 `DiagramDocument` 语义投影、依赖该模型的语义布局器或双轨编辑链路；当前 Studio-owned Dagre/ELK 布局按 ADR-0013 直接针对 native mxCell 计算几何计划。本报告中的分阶段路线不表示所有阶段均已完成。

---


## 当前可复用的设计输入（ADR-0012）

本报告的代码路径、分层方案和分阶段估算是历史评估，不直接迁移到当前 V2。仍有用的是对未知 shape、嵌套 cell、多页、XML metadata 和目标操作安全性的分析。后续能力按以下边界重用这些结论：

- 形状、容器与多页兼容继续由原生 Draw.io 和开放 XML schema 负责，不要求 Studio 理解全部 shape 才能打开或编辑。
- 全页自动布局是现行核心能力：ADR-0013 规定使用 Studio 自己运行的 Dagre/ELK，从 native mxCell 派生临时输入并回写坐标/waypoints；禁止调用 Draw.io 内置布局或迁移旧 `DiagramDocument` / SVG 布局链路。超出该核心布局范围的额外 routing/风格能力，可通过 `NativeDiagramOperationProvider` 扩展。
- 几何、对比度、可访问性等检查应通过 `NativeDiagramAnalysisProvider` 返回诊断，不应默认为所有原生保存增加语义质量门。
- 当前已有 Studio-owned Dagre/ELK planner；通用 capability registry 和质量 provider 仍未安装。布局细节见 [ADR-0013](./adr/0013-studio-owned-layout-engines.md)，扩展契约见 [ADR-0012](./adr/0012-native-diagram-extension-contracts.md) 和 [当前 V2 架构](../ARCHITECTURE-V2.md)。

## 0. 决策与结论

**历史方案（不再是现行设计）**：本报告曾建议从 XML 派生只读 `DiagramDocument` 投影。该建议已被 ADR-0011 取代；现行 V2 直接对原生 mxCell 执行窄范围、类型化操作，不生成第二张图模型。

由此得到三条推论，全报告都围绕它们展开：

1. **任何"编辑"都必须表达为对 XML 的 cell 级补丁（patch）**，而不是"改模型 → 重新生成整份 XML"。否则每次编辑都会重写文件，未知 cell、未知样式、原始排版必丢。
2. **持久化只存 XML 一份**。当前 `workspaceState = { document, drawioXml }`（两份真源）与前端 `nativeXmlOverride ?? generatedDrawioXml`（`src/App.tsx:245`，两份真源的直接体现）必须消失。
3. **XML 解析必须能跑在 Node**（服务端要校验、打补丁、算版本哈希），而现在解析依赖浏览器 `DOMParser`（`src/import/drawio.ts:28`，ADR0003:23 已点明这个缺口）——这是本次改造最大的工程量。

**当前架构不支持该目标**，且不是"加个枚举"能解决的。三处硬阻塞见第 1 节；四个真实场景的数据丢失见第 4 节。

---

## 1. 现状：三处硬阻塞

### 1.1 硬阻塞一：语义模型里没有"形状"，且它被当成了真源

```
src/model/types.ts
  :1    DiagramKind = "c4" | "flowchart" | "sequence"      // 封闭联合
  :9    EdgeKind = "flow" | "call" | "return" | "async" | "event" | "dependency"
  :18-30 DiagramNode { id, name, role, visualRole, x, y, width, height, layoutHints }
        ↑ 没有 shape / type / style 字段
  :45-50 DiagramBoundary { id, name, members[] }           // 只是"成员名单"，不是容器
  :61-83 DiagramDocument { schemaVersion: 2, kind, theme, nodes, relations, boundaries, layout, flow?, sequence? }
  :141-148 isDiagramDocument() 硬拒绝 kind 之外的一切 + schemaVersion 必须 === 2
```

- `role`/`visualRole` 是**语义**（actor/api/storage…），不是**形状**（rounded-rect/ellipse/cylinder…）。当前系统把"这是数据库"直接等同于"画成圆角矩形"，而 Draw.io 里这两件事本来解耦。
- 规格与实现已背离：`ARCHITECTURE-V2.md:179` 原本定义了 `type: string`，实现里被删掉换成 `role`。
- 规格文档明确把 `DiagramDocument` 定为唯一真源（`ARCHITECTURE-V2.md:910-940`、决策 5 `:1592-1594`）——**本次决策与该规格冲突，必须以新 ADR 覆盖**。
- 没有 parent/group 概念，无法表达嵌套容器与泳道；没有"通用元素"抽象，node/boundary/fragment 是三套并列类型，而 Draw.io 的 cell 类型远多于此。

### 1.2 硬阻塞二：导入导出是"有损且单向降级"的

**导入 `src/import/drawio.ts`：**

| 问题 | 位置 | 后果 |
|---|---|---|
| 形状靠正则猜 | `:13-21` `roleFromStyle` 只认 rhombus/ellipse/database，其余一律 `domain` | 圆柱/云/便签/泳道全部退化为圆角矩形 |
| **忽略 parent 层级** | `:79` 取 `root mxCell`，`:125-128` 直接读 `mxGeometry@x/y` | 子图元坐标是**相对父级**的 → 嵌套图形位置全错 |
| 丢弃容器语义 | 无 `parent` 处理 | swimlane / lane / group 变成"节点"，分组丢失 |
| 丢弃非节点 cell | `:93-95`、`:99-120` 只处理 node/boundary/fragment | 图片、文字、图例、独立标签 cell 消失 |
| 丢弃视觉属性 | `:130-138` 只保留 role/visualRole/几何 | **fill/stroke/字号/圆角全部不导入** |
| 端点不在模型里就丢边 | `:148-149` | 连到泳道/容器的边直接消失 |
| 私有 style key 依赖 | `:99`、`:106` 依赖 `studioBoundary=1` / `studioSequenceFragment=1` | 只有 Studio 自己导出的文件才认得 |
| 只取第一页 | `:40` `mxfile diagram` | 多页文件其余页无声消失 |

**导出 `src/export/drawio.ts`：**

| 问题 | 位置 | 后果 |
|---|---|---|
| 只生成 3 种形状 | `src/design/styles.ts:48`（`arcSize=8` / `arcSize=50` / `rhombus`） | 其余形状无法产出 |
| 所有 cell `parent="1"` | `export/drawio.ts:21,44,61,65,77,96,106` | 无法表达嵌套；boundary 只是"一个矩形 + 成员名单" |
| 主题不参与导出 | 导出用固定 `tokens` | 换主题后 Studio 变了、文件没变 |
| 整份重写 | `toDrawioXml` 从模型重建全部 cell | 任何一次编辑都会抹掉未知 cell / 未知样式 / 原始排版 |
| **非确定性** | `:123` 写入 `modified="<now>"` | 任何基于 XML 的哈希/相等判断都会永远"不相等" |
| 边路由依赖 mxGraph router | `styles.ts:60` 无显式 waypoints 时用 `orthogonalEdgeStyle` | Freeform 与 Studio 的连线路径必然不同 |

**结论**：当前是"模型 → 重新生成文件"的一单向管道，而用户的需求是"文件 → 文件"。两者方向相反，这是本次改造的根本矛盾点。

### 1.3 硬阻塞三：既有 ADR 明确把该目标排除在范围外

| 文档 | 原文要点 |
|---|---|
| `ARCHITECTURE-V2.md:57-66` | "V2 只把下面三类作为一级产品能力…其它图形暂时不作为独立产品类型" |
| `ARCHITECTURE-V2.md:1608` | "V2 不以'支持更多图形'作为成功标准" |
| `ARCHITECTURE-V2.md:910-940,1592-1594` | `DiagramDocument` 是唯一 authoritative source，draw.io iframe"不是第二个独立业务数据库" |
| `docs/adr/0005:37` | 拒绝"复制第三方形状索引：外来形状标识不一定映射到 Studio 渲染器" |
| `docs/adr/0005:11` | "约定的范围是 F1–F11" |
| `src/App.test.ts:13` | 测试直接断言"一等图类型仅限 C4/flowchart/sequence" |
| `AGENTS.md:12-14` | 禁止让模型直接写 Draw.io XML（**这条要保留**，但要改写为"AI 不得直接产出 XML 文本，只能产出受控 cell 操作"） |

**所以第一件事不是写代码，是用 ADR-0007 覆盖上面这几条。**

---

## 2. 逐层问题清单（改造时按此顺序处理）

### 2.1 真源与状态层（最高优先级）

1. `src/App.tsx:245` `const drawioXml = nativeXmlOverride ?? generatedDrawioXml;` —— **两套真源在同一个变量里的直接体现**。Freeform 编辑后走 native，Studio 编辑后走重新生成，两条路径互不知情。
2. `src/App.tsx:242-247` 每次 `document` 变化就 POST `/api/workspace/diagram/export-drawio` 重新生成整份 XML —— 在"XML 为真源"下这一步应当被删除，改为**只做投影与补丁**。
3. `server/copilot-server.ts` `workspaceState = { workspaceId, document, drawioXml, copilotSessionId, chatMessages, updatedAt }` —— 存了两份；版本快照 `DiagramVersion = { document, drawioXml }` 同样两份。
4. `server/diagram-domain.ts` / `server/copilot-server.ts:376` `documentRevision(document)` —— 基于**模型**算 revision；改为基于**规范化 XML**算哈希。
5. `server/copilot-server.ts:512` 的提案门禁 `quality.score < baseQuality.score - 10` 以模型评分为准。
6. `src/App.tsx` 的 autosave（PUT `/api/workspace/document`）提交 `{document, drawioXml}`。

### 2.2 模型层 `src/model/types.ts`

1. `DiagramKind` 封闭联合（`:1`）+ 校验器硬拒绝（`:148`）→ 换图类型要改前端、校验器、fixtures、UI。
2. `DiagramNode` 无 `shape` 字段（`:18-30`）→ 形状信息不存在于任何地方。
3. `role`/`visualRole` 必填（`:23-24`），17/5 封闭枚举；白名单**三处重复**：`types.ts:4-9`、`server/diagram-domain.ts:9-11`、`server/copilot-server.ts:1002-1004`。
4. `schemaVersion` 必须 `=== 2`（`:142`）且**没有任何迁移器**。
5. `theme: "studio-editorial"` 是单值（`:67`）→ 主题无法进文件，也就无法进导出。
6. 无 `parentId` / 容器 / 泳道 / 图片 / 文本元素 / 多页。

### 2.3 布局层 `src/layout/`

1. `elk.ts:9` `applyC4SemanticRanks` 只处理 `kind==="c4"`；`elk.ts:164-173` 的 `else` 分支**默认按 C4 处理** → 任何新 kind 会被强行套 C4 语义（未定义行为）。
2. `dagre.ts:11` 只排除 sequence；`layout.ts:86,118` sequence 特判；`sequence.ts` 全部只服务时序。
3. `routing.ts:22-30` 端口沿**矩形包围盒**均匀分布 → 对椭圆/菱形/圆柱不成立。
4. `quality.ts:33-45` 碰撞检测用 `segmentIntersectsRect` → 形状感知缺失。
5. `elk.ts:126-129` 只把 `width/height` 交给 ELK → 没有端口约束、没有 shape、没有容器。
6. `profiles.ts:11-18` 只有 6 个引擎 profile；`model/fixtures.ts:27` 却用 `"sequence-standard"`（不在列表内）→ `resolveLayoutProfile` 静默降级为 `elk-layered`（`profiles.ts:30-33`），而服务端 `layoutProfileEnabled` 对 sequence 直接 true（`copilot-server.ts:244-247`）→ **配置面板显示的算法与实际执行引擎不一致（隐性 bug）**。
7. 时序几何常量 `148 / 72` 硬编码在 4 处（`export/drawio.ts:69`、`DiagramCanvas.tsx:379`、`quality.ts:141`、`sequence.ts`）。
8. **布局的输出是"新的 Document"**（`layout.ts:50-78`）——在 XML 真源下必须改为**几何补丁列表**。

### 2.4 渲染层

1. `DiagramCanvas.tsx:105-111` `nodePath` 只有 rect / pill / diamond → 画布渲染不了其它形状。
2. 主题只作用于 `.diagram-svg`（`src/styles.css:467-468, 645-675`）→ 导出永远基础色。
3. Studio 画布与 Draw.io 是两套渲染器，视觉常量各写一份（详见 `diagram-design-style-report.md`）→ 双渲染器漂移。
4. `styles.ts:51` 写死 `fontFamily=Arial`，与 Studio 的 `tokens.font`（Inter）不一致。
5. **Studio 画布与 Draw.io 渲染的是不同输入**（模型 vs XML）→ 在 XML 真源下，这个差异可以结构性消除（两边读同一份 XML）。

### 2.5 服务端与工具层

1. 白名单三处重复（见 2.2.3）。
2. 语义校验不检查"形状是否支持 / 层级是否合法 / 是否有对应语法"。
3. 模板只有 3 个（`diagram-domain.ts:33-36`、`copilot-server.ts` templates 列表）。
4. `server/copilot/diagram-tools.ts:66-71` 参考资料 topic 枚举写死 `c4|flowchart|sequence|drawio|layout|validation`；`apply_diagram_operation` 的操作种类写死。
5. `src/intent/aiProvider.ts:29-51` 的 `ALLOWED_COMMANDS` 是**精确字符串匹配** → 无法表达"创建一个圆柱/泳道"。
6. `src/intent/applyIntent.ts:14-193` 的正则只覆盖节点/关系/样式/方向。

### 2.6 持久化与工作区

1. 一个 workspace 一张"主图"（`workspaceState.document`）→ 多页（`<mxfile>` 多 `<diagram>`）不支持。
2. 导出/保存的 `.drawio` 与 `workspaceState.drawioXml` 是两份，可能不同步（`App.tsx:246` 那个 `??` 的另一面）。

### 2.7 测试与护栏

1. `src/App.test.ts:13` 断言"一等类型仅 3 种" → 扩展前必须改。
2. **没有 XML round-trip 回归测试**，而 `docs/adr/0003:24` 明确要求 → 形状扩展没有安全网。
3. 没有 parity 测试（Studio SVG vs Draw.io 渲染）。

### 2.8 文档一致性

1. `.github/copilot-instructions.md:4` 仍要求保留 VS Code MCP 配置，与 `docs/adr/0002:13,27`、`AGENTS.md:13` 冲突。
2. `ARCHITECTURE-V2.md:179` 的 `type` 与实现不符。
3. `ARCHITECTURE-V2.md:910-940`、决策 5（`:1592-1594`）把 `DiagramDocument` 定为唯一真源 → **必须由 ADR-0007 覆盖**。

---

## 3. 目标架构：XML 为真源，模型为投影

### 3.1 分层

```
┌─ L6 治理 ────── 服务端唯一写入者：校验 / 质量门 / 版本快照 / 提案确认
┌─ L5 互操作 ──── drawio/ 模块：解析(无损 AST) · 规范化序列化 · 投影 · 补丁 · 哈希
┌─ L4 渲染 ────── ① Draw.io 编辑器（原生渲染） ② Studio 画布（投影渲染，同一解释器）
┌─ L3 语义 ────── grammar 插件(c4/flow/sequence/generic) + 形状注册表 + 语义元数据
┌─ L2 布局 ────── ELK/Dagre 作用于投影，产出**几何补丁**而非新文档
┌─ L1 投影 ────── DiagramProjection（只读派生视图：nodes/relations/bounds/semantics）
┌─ L0 真源 ────── mxfile XML 文本（唯一被持久化、被 diff、被版本化的东西）
```

### 3.2 L0/L5：新的 drawio 模块（本项目的核心资产）

```ts
// src/drawio/parse.ts —— 无损解析
export interface DrawioCell {
  id: string;
  parent: string | null;
  value: string;          // 原样（HTML 标签不解析，只保留原文）
  style: string;          // 原样
  vertex: boolean; edge: boolean;
  geometry?: { x?: number; y?: number; w?: number; h?: number; relative?: boolean; points?: Point[]; source?: Point; target?: Point };
  data: Record<string, string>;  // data-* 语义元数据
  raw: string;            // 原始 XML 片段（未知属性/子节点都不丢）
}
export interface DrawioFile {
  pages: Array<{ id: string; name: string; cells: DrawioCell[]; raw: string }>;
  raw: string;
}
```

要点：

- **无损**：不认识的 style key、不认识的 cell、不认识的属性全部进 `raw`，导出时原样回写。这是"支持全部 Draw.io 图形"的地基——不需要认识所有形状，只需要不破坏它们。
- **父子树保留**：`parent` 是绝对坐标计算的前提（`import/drawio.ts` 现在忽略它 → ER 表炸成 9 个便签）。
- **解析要能跑在 Node**：服务端必须能解析、校验、打补丁、算哈希。现在依赖浏览器 `DOMParser`（`import/drawio.ts:28`；ADR0003:23 已点明"需要一个可移植解析抽象"）→ 需要一个不依赖 DOM 的轻量 XML 解析器，或在 Node 侧引入同类库（前端服务端共享同一份实现，避免两套解析结果不一致）。
- **规范化序列化**：固定属性顺序、固定缩进、**去掉时间戳类属性**（`export/drawio.ts:123` 的 `modified`）→ 保证"内容没变 → 字节相同"，否则版本哈希与 diff 都不可用。

### 3.3 L1：DiagramDocument 降级为只读投影

```ts
export interface DiagramProjection {
  pages: Array<{ id: string; cells: DrawioCell[] }>;
  nodes: Array<{ id: string; cellId: string; name: string; role?: NodeRole; shape: ShapeId; bounds: Rect; parentId?: string }>;
  relations: Array<{ id: string; cellId: string; source: string; target: string; label: string; kind?: EdgeKind; points: Point[]; ports?: { source?: Point; target?: Point } }>;
  boundaries: Array<{ id: string; cellId: string; name: string; memberIds: string[] }>;
  semantics: { roles: Record<string, NodeRole>; grammar?: string };  // 来自 data-* 元数据
}
```

- 投影**每次从 XML 派生**，不缓存为真源（可按 XML 哈希做记忆化缓存以保性能）。
- 投影**不参与相等性/持久化/版本比较**。
- `kind`/`grammar` 不再是文档类型，而是**投影上的一个属性**：由文件里的 `data-studio-grammar` 决定；没有就是 `generic`。

### 3.4 语义如何存进 XML

`mxCell` 是任意 XML，Draw.io 会原样保留未知属性 → Studio 的语义可以直接写在 cell 上：

```xml
<mxCell id="db" value="Orders" style="shape=cylinder3;" vertex="1" parent="1"
        data-studio-role="storage" data-studio-grammar="c4" data-studio-uid="...">
  <mxGeometry x="80" y="120" width="190" height="82" as="geometry"/>
</mxCell>
```

- `data-studio-role` → 语义角色（决定配色/排名）；`data-studio-grammar` → 该页的语法；`data-studio-uid` → 稳定 ID（避免重排时 id 漂移）。
- 外部文件没有这些属性 → 语义为空 → **Studio 的语义能力（自动 C4 布局、AI 语义编辑）对外部文件自然降级**，而不是错误猜测。这点必须写进 ADR，是 XML 真源最大的代价（见第 6 节）。

### 3.5 编辑 = cell 级补丁（不是重新生成）

引入一个小的操作代数（服务端唯一执行，AI 只能产出受限子集）：

```ts
type XmlOp =
  | { op: "setGeometry"; cellId: string; x?: number; y?: number; w?: number; h?: number; points?: Point[] }
  | { op: "setValue"; cellId: string; value: string }
  | { op: "setStyle"; cellId: string; patch: Record<string, string | null> }   // null = 删除该 key
  | { op: "setData"; cellId: string; key: string; value: string | null }
  | { op: "addCell"; cell: DrawioCell }
  | { op: "removeCell"; cellId: string }
  | { op: "reparent"; cellId: string; parent: string | null };
```

- 拖动节点 = `setGeometry`（只改一个 cell 的 x/y）→ **其余一切保持原样**。
- 加关系 = `addCell`（一个 `mxCell edge=1`）+ 可选 `setGeometry` 摆 waypoints。
- 布局 = 一批 `setGeometry`（只改几何，不重建文件）。
- 改标签 = `setValue`；改样式 = `setStyle`（只改白名单 key，其余保留）。
- 删除节点 = `removeCell` + 清理指向它的边（服务端规则）。

**这一条是"不再丢东西"的关键**：从"模型 → 重新生成 XML"改成"对 XML 打补丁"。

### 3.6 L2：布局产出补丁而非文档

```
现在：layoutDiagram(doc) -> new Document -> toDrawioXml(doc)  // 整份重写
目标：layoutDiagram(projection) -> XmlOp[]  // 只改几何
```

- ELK/Dagre 仍然作用于投影（`elk.ts:126-129` 目前只传 width/height，后续可补端口约束与容器分组）。
- `repairOverlaps`（`layout.ts:30-48`）与 `routeRelations`（`routing.ts`）产出 waypoints → 写回 `setGeometry(points)`。
- **约束不变**：节点锁定（`layoutHints.locked`）在 XML 里如何表达？→ 同样进 `data-studio-locked="1"`，锁住时布局跳过该 cell 的 geometry。
- 语义后处理（`elk.ts:164-173`）按 grammar 选择；**grammar=generic 时不做任何语义重排**（消除现在的"默认套 C4"未定义行为）。

### 3.7 L3：形状注册表 = mxGraph style 的解释器

```ts
interface ShapeSpec {
  id: string;                                  // "rounded-rect" | "ellipse" | "cylinder" | "swimlane" | ...
  match: (style: string) => boolean;           // 从 style 识别
  bounds: (cell) => Rect;                      // 几何包围盒
  anchors: (cell) => Port[];                   // 可连线锚点
  minSize?: { w: number; h: number };
  studioFallback: "rect" | "pill" | "diamond" | "ellipse" | "cylinder" | "note" | "none";
}
```

- 识别优先级：显式 `data-studio-shape` > style 匹配（`shape=`、`ellipse`、`rhombus`、`shape=cylinder3`…）> 未知。
- **未知形状**：保留原 style，不解释、不改写；Studio 画布用 `studioFallback:"none"`（只画一个虚线包围盒 + 标签，标注"原生形状，仅在 Draw.io 中可编辑"），导出原样回写。→ 满足 ADR0005:37 的"不复制第三方形状索引"，同时不丢数据。
- 画布渲染（`DiagramCanvas.tsx:105-111`）改为查注册表，而不是三个 if。

### 3.8 L4：渲染一致性从此是结构性的

- Draw.io 渲染的是 XML；Studio 画布渲染的是**同一份 XML 的投影** → 两边输入一致。
- 样式解释（颜色/字号/圆角/线型）由**同一份 style 解释器**产出：一份读 style → 结构化 paint（`src/design/styles.ts` 升级为 `styleInterpreter`），画布用它画 SVG，导出/叠加设计语言用它改 style。
- 主题不再靠 CSS 覆盖（`styles.css:467-468,645-675`）→ 变成"写进 XML 的 style"（`applyDesignLanguage(xml, tokens)`，幂等、带版本戳写在 `data-studio-style-version`），于是**文件与画布永远同色**。
- 产品决策点：是否干脆**只保留 Draw.io 渲染**、删掉自研 SVG 画布？XML 真源下这变成一个真实选项（见第 6 节"取舍"）。

### 3.9 L6：服务端与 AI 的角色重定义

- 服务端仍是唯一写入者（`docs/adr/0003`）——不变。
- 校验对象从"模型"变成"**XML + 投影**"：先做 XML 结构校验（cell id 唯一、parent 存在、无环、几何有限且有界、style 长度上限、页面数上限），再做投影语义校验（关系端点存在、边界成员存在）。
- 版本快照 = **XML 原文 + 派生元数据**（节点数、投影哈希、语义标签），不再存模型副本。
- revision = **规范化 XML 的哈希**。
- AI：仍然**不得直接产出 XML 文本**（`AGENTS.md:12-14` 保留），但改为"产出受限 `XmlOp` 集合 + 理由"，由服务端编译成补丁 → 校验 → 质量门 → 提案/确认 → 版本快照。这比现在"AI 产出命令字符串 → 前端匹配 → 服务端正则解释"更短、更可审计。

### 3.10 状态收敛（消除双源）

```
现在：App.tsx:209  nativeXmlOverride      ← 第一份真源
     App.tsx:242  POST /export-drawio     ← 由模型重新生成第二份
     App.tsx:245  nativeXmlOverride ?? generatedDrawioXml
     server      workspaceState { document, drawioXml }   ← 又两份

目标：唯一状态 = mxfile XML 字符串
     App       useState<XmlFile>            // 唯一真源
     投影      useMemo(() => project(file))  // 派生，只读
     提交      send(Op[]) → 服务端应用 → 返回新 XML → setFile
     持久化    PUT /api/workspace/diagram  { xml, label }
     版本      DiagramVersion { xml, meta }
```

---

## 4. 四个真实场景的推演（现状实测路径）

### 4.1 UML 类图（draw.io 内置 `uml` 形状集）

| 环节 | 现状结果 | 依据 |
|---|---|---|
| 导入 | 每个类框 → 一个 `domain` 节点；属性/方法分区被 `plainLabel` 丢弃 | `import/drawio.ts:4-12,13-21` |
| 布局 | `requestServerLayout` 把类框重排成从左到右的层级 | `elk.ts:9,164-173` |
| 保存 | `toDrawioXml` 重建为 `rounded=1;arcSize=8` 圆角矩形 | `styles.ts:48` |
| 净效果 | **类图退化为"一堆带类名的圆角矩形 + 无方向语义的箭头"** | — |

XML 真源下：类框是 `shape=uml` 的未知形状 → 原样保留；属性分区作为子 cell 保留；类之间的继承边是普通 edge，原样保留；Studio 画布显示为"原生形状占位"。**不丢**。

### 4.2 ER 图

draw.io 的实体表是"父 cell + 每行一个子 cell（`parent=<表 id>`）"。

| 环节 | 现状结果 | 依据 |
|---|---|---|
| 导入 | `parent` 被完全忽略 → 表头 + 8 个列 cell 变成 **9 个互不相关的节点** | `import/drawio.ts:79,125-128` |
| 布局 | 9 个节点被当成 9 个独立实体排版 | `layout.ts:50-78` |
| 导出 | 全部 `parent="1"` → 列永远回不到表里 | `export/drawio.ts:21` |
| 净效果 | **一张 ER 图变成 9 张散落的便签** | — |

XML 真源下：parent 树保留 → 子 cell 坐标相对父级 → 投影时按父链累加成绝对坐标；导出原样回写。**不丢、不炸**。

### 4.3 泳道图 / BPMN

泳道是带 `swimlane` style 的容器 cell。现状：泳道与其中的任务变成同级节点，导出后没有容器概念；BPMN 事件圆/网关菱形/子流程折叠框没有对应形状（`nodePath` 只有 3 种）。
XML 真源下：swimlane 是未知形状 → 原样保留；Studio 画布可用 `studioFallback` 画一个"泳道带"占位。语义增强（真正的泳道支持）可作为后续 grammar 插件。

### 4.4 多页 `.drawio` 文件

- 现状：未压缩时 `import/drawio.ts:40` 只取第一页，其余页无声消失；若改成合并所有页，节点 id 可能撞车，而 `validateDiagramSemantics`（`server/diagram-domain.ts:13`）对重复 id 直接判错。
- XML 真源下：页是 `<mxfile>` 的一等结构，天然支持多页；投影按页组织；每页独立 grammar。

---

## 5. 改造路线（分阶段，每阶段可独立发布、可回滚）

### Phase 0 · 决策与护栏（1 天，必须先做）

- 新增 **ADR-0007「唯一真源 = draw.io XML」**，明确：
  - `DiagramDocument` 降级为只读投影，不持久化、不做 diff 基准；
  - 编辑 = cell 级补丁，不是重新生成；
  - 未知形状/未知 cell 一律原样保留（覆盖 ADR0005:37 的替代方案）；
  - AI 仍不得直接产出 XML 文本（改写 `AGENTS.md:12-14` 的措辞）；
  - 外部文件没有语义元数据 → 语义能力降级而非猜测。
- 修订 `ARCHITECTURE-V2.md:57-66`、`:910-940`、`:1592-1594`、`:1608` 与 `docs/adr/0005`，解除冲突。
- 补 **XML round-trip 回归测试**（ADR0003:24 早已要求但缺失）：`parse → canonical serialize → parse` 字节级幂等。
- 改 `src/App.test.ts:13` 的硬断言为"至少支持 3 类"。
- 清理 `.github/copilot-instructions.md:4` 陈旧 MCP 指令。

**验收**：ADR 落地；规范化序列化幂等测试通过。

### Phase 1 · drawio 模块（无损解析 + 规范化序列化）（5–8 天）

- `src/drawio/parse.ts`：无损解析（cells / parent 树 / style 原文 / data-* / raw 片段 / 多页）。
- `src/drawio/serialize.ts`：规范化序列化（稳定属性顺序、稳定缩进、**去时间戳**）。
- `src/drawio/portable-xml.ts`：**不依赖 DOM** 的解析（Node + 浏览器共用同一份），替换 `import/drawio.ts:28` 的 `DOMParser`。
- `src/drawio/hash.ts`：规范化 XML 哈希（revision 基准）。
- 保留 `import/drawio.ts` 作为**投影层**（在 parse 之上），但不再承担"重建文件"的职责。

**验收**：任意外部 draw.io 文件 parse → serialize 后**语义等价**（cell 数、parent 关系、几何、style 原文一致）；同一文件两次序列化字节相同。

### Phase 2 · 状态收敛为单一 XML（3–4 天）

- `App.tsx`：删除 `nativeXmlOverride` 与 `generatedDrawioXml` 两套路径（`:209,242-247,245`），改为单一 `useState<XmlFile>` + `useMemo(project)`。
- 服务端：`workspaceState` 去掉 `document`，只留 `mxfile`；`DiagramVersion` 只存 `xml + meta`；`documentRevision` 改为 XML 哈希。
- 删除 `POST /api/workspace/diagram/export-drawio` 的"重新生成"语义，改为"返回当前 XML 的规范化版本"。
- 投影只读：所有 `setDocument(...)` 改为"生成 Op → 服务端应用 → 返回新 XML"。

**验收**：不存在第二份真源；`grep -rn "nativeXmlOverride" src/` 为空；保存后 XML 字节幂等（无改动时不再产生新版本）。

### Phase 3 · 编辑改为 cell 级补丁（4–6 天）

- 实现 `XmlOp` 代数与执行器（服务端）：`setGeometry / setValue / setStyle / setData / addCell / removeCell / reparent`。
- 前端交互改写：`useDiagramEditing.ts` 的 addNode / addRelation / changeRelationEndpoints / reverseRelation / removeRelation / changeNode / 移动节点 → 产出 Op。
- `src/intent/applyIntent.ts`：意图解释在投影上做，产出 Op 列表而不是新 Document。
- 服务端校验 Op：白名单 key、id 唯一、parent 合法、无环、几何有界；`setStyle` 只允许白名单 key（`fillColor/strokeColor/fontColor/fontSize/fontFamily/strokeWidth/rounded/arcSize/dashPattern/…`），其余原样保留。

**验收**：一次编辑只改动预期 cell（diff 只含目标 cell）；被编辑文件的其它 cell 字节不变。

### Phase 4 · 布局产出几何补丁（3–5 天）

- `layoutDiagram` 返回 `XmlOp[]`（几何 + waypoints），不再返回 Document。
- 锁定语义搬进 XML：`data-studio-locked="1"`。
- grammar 化：`elk.ts:164-173` 的默认 C4 分支改为按 `data-studio-grammar` 选择；generic → 无语义后处理。
- 修 `profiles.ts` / fixtures 的 profile 不一致（`fixtures.ts:27` 的 `sequence-standard` 不在 `LAYOUT_PROFILES` 内 → 静默降级为 `elk-layered`，而 UI 显示别的值）。

**验收**：点"自动布局"后，除几何外的 cell 全部不变；同一输入两次布局结果一致（确定性）。

### Phase 5 · 形状注册表 + 画布解释器（4–6 天）

- `src/design/shapes.ts`：形状注册表（识别、包围盒、锚点、最小尺寸、fallback）。
- `DiagramCanvas.tsx:105-111` 改为查注册表；未知形状走 fallback 占位（虚线包围盒 + 标签 + "仅 Draw.io 可编辑"提示）。
- `src/design/styles.ts` 升级为 **style 解释器**（style → 结构化 paint），画布与导出共用。
- 主题从 CSS 覆盖改为写进 XML（`applyDesignLanguage(xml, tokens)`，幂等 + `data-studio-style-version`）。

**验收**：外部文件的椭圆/圆柱/便签/泳道在画布上可见且**不改变原文件**；换主题后文件与画布同色。

### Phase 6 · 服务端治理与 AI（4–6 天）

- 校验对象改为 XML + 投影；白名单三处合并为 `src/shared/registry.ts`（前端/服务端共用）。
- revision = 规范化 XML 哈希；提案 = Op 集合 + 补丁后 XML 预览；质量门在补丁后投影上评估。
- AI 工具（`server/copilot/diagram-tools.ts`）：从"命令字符串 + 正则解释"改为"结构化 Op 提案"（仍禁止直接写 XML 文本）；参考资料 topic 改为按 grammar 动态生成。
- 版本快照 = XML + 派生 meta；restore = 写回 XML 原文。

**验收**：AI 一次操作 = 一组可审计的 Op；stale revision 被拒；快照可完整还原文件。

### Phase 7 · 扩展能力（容器/泳道/多页/图片）（4–6 天）

- 容器：`parent` 语义进投影（boundary = 有 `data-studio-boundary` 的容器 cell，成员由 `data-studio-members` 指明）。
- 泳道：真正的 lane 语法（页面级 swimlane 容器 + 任务 cell）。
- 多页：投影按页组织，每页独立 grammar；UI 支持页切换。
- 图片/图标：`shape=image` 的 data URI 保留（体积上限、base64 规范化）。

**验收**：ER/泳道/多页文件打开→编辑→保存，几何与结构零损失（cell 数量与 parent 关系守恒）。

### Phase 8 · 质量、parity 与回归网（3–4 天）

- shape-aware 碰撞/端口/label 溢出（`quality.ts` 改用形状几何而非包围盒）。
- 复杂度预算按 grammar 声明（`complexity.ts:11,22-23` 去 kind 硬编码）。
- **parity 测试**：同一 XML → Draw.io 渲染 vs Studio SVG 渲染，元素清单 diff = 0（配合 `diagram-design-style-report.md` 的方案）。
- 快照回归：fixtures 的 XML → PNG/SVG 快照比对（`ARCHITECTURE-V2.md:1260-1304` 早已要求）。

### 总量估算

Phase 0–2 约 2 周（**最小可运行形态**：单一真源、状态收敛、往返无损）；Phase 3–4 约 2 周（编辑与布局都变成补丁）；Phase 5–8 约 3 周（形状/治理/AI/扩展/回归）。
若目标只是"任意 draw.io 文件打开、编辑、保存不丢不降级"，**Phase 0–2 即可交付**。

---

## 6. 取舍、代价与风险（诚实版）

| 项 | 说明 |
|---|---|
| **语义能力会退化** | XML 真源下，外部文件没有 `data-studio-role/grammar` → C4 自动语义布局、角色配色、AI 语义编辑**对这些文件不可用**。这是本决策最大的代价：换来"通用图形"，失去"跨文件的语义智能"。缓解：导入时做一次**显式的语义标注流程**（用户确认角色），把标注写回 `data-*`；而不是自动猜。 |
| **解析器要自建或引入** | 不能依赖浏览器 `DOMParser`（ADR0003:23 已指出）。要么引入一个 Node 可用的 XML 解析库，要么写一个受限实现（只处理 `mxfile/mxGraphModel/mxCell/mxGeometry` 子集）。 |
| **规范化是硬要求** | 不去时间戳、不稳定属性顺序 → 否则哈希/diff/幂等全失效（现有 `export/drawio.ts:123` 就是一个反例）。 |
| **diff 粒度变粗** | 版本比较从"模型字段"变成"XML 文本"；需要好的 canonical serializer + 行级 diff 工具，否则 review 体验差。 |
| **性能** | 每次编辑都要 parse + project + serialize；需要按 XML 哈希记忆化投影，增量解析。 |
| **不再有"整份重写"的能力** | 任何"换图类型 = 换示例"的交互（`App.tsx:601` `changeKind`）都要重做：它本质是"用新模型重生成文件"，在 XML 真源下应改为"构造新页的 XML"。 |
| **自研 SVG 画布是否保留** | 保留 → 需要持续追平 Draw.io 的渲染（503 行只换来 3 种形状是前车之鉴）；不保留 → Studio 变成"draw.io + 智能层"，编辑体验全交给 Draw.io。**这是必须由产品拍板的一刀**，建议在 Phase 2 之后、Phase 5 之前决定。 |
| **AI 边界不变** | `AGENTS.md:12-14` 保留：AI 不得直接产出 XML 文本；改为产出受限 Op，由服务端编译。 |
| **不要做的事** | ① 不要让 `DiagramDocument` 继续被持久化（否则双源回归）；② 不要为"支持全部形状"去复制 Draw.io 的形状库（ADR0005:37）；③ 不要让质量评分对无语义文件成为保存门禁（`copilot-server.ts:512` 的分数门会误杀）；④ 不要保留"切换图形类型 = 换示例"的交互语义。 |

---

## 7. 立即可做的三件事（不动架构也能先拿收益）

1. **修 profile 不一致**：`model/fixtures.ts:27` 与 `server/diagram-domain.ts` 用的 `"sequence-standard"` 不在 `LAYOUT_PROFILES`（`profiles.ts:11-18`）内 → 被静默降级为 `elk-layered`，而 UI 面板显示的是别的值 → **配置面板与真实引擎不一致**（1 行修复 + 1 条测试）。
2. **把三份白名单合并成一份共享注册表**（`types.ts:4-9` / `diagram-domain.ts:9-11` / `copilot-server.ts:1002-1004`）→ 消除"改一处漏两处"。
3. **补 XML 往返回归测试 + 规范化序列化**（ADR0003:24 要求却缺失）→ 在任何大改之前先铺好安全网，并顺带发现 `modified` 时间戳导致的不可比问题。

---

## 附录 A · 证据索引

**真源与状态**：`src/App.tsx:209,242-247,245,601`；`server/copilot-server.ts`（`workspaceState`、`DiagramVersion`、`documentRevision` `:376`、提案门禁 `:487-560`、`:512`、`:637-639`、`:733-739`）
**模型**：`src/model/types.ts:1,4-9,18-30,45-50,61-83,141-148,182-193`
**导入**：`src/import/drawio.ts:4-12,13-21,28-31,40,79,93-95,99-120,125-128,148-149,169-178`
**导出**：`src/export/drawio.ts:9-13,19-22,44,61,65,77,96,106,122,123,133`；`src/design/styles.ts:13-33,46-53,55-65`
**布局**：`src/layout/elk.ts:9,43-57,118-180,182-294`；`src/layout/dagre.ts:11`；`src/layout/layout.ts:30-48,50-78,86,118`；`src/layout/routing.ts:13-30,31-79,84`；`src/layout/sequence.ts:12,35,84`；`src/layout/profiles.ts:11-18,30-33`；`src/layout/quality.ts:33-45,141`；`src/layout/complexity.ts:11,22-23`
**渲染**：`src/components/DiagramCanvas.tsx:105-111,135-136,379,380-388`；`src/styles.css:467-468,645-675`
**服务端/工具**：`server/diagram-domain.ts:9-11,13,33-36`；`server/copilot-server.ts:244-247,376,487-560,512,1002-1004`；`server/copilot/diagram-tools.ts:49-51,66-71`
**AI**：`src/intent/aiProvider.ts:29-51,76-95`；`src/intent/applyIntent.ts:14-193`
**测试**：`src/App.test.ts:13`
**规格/ADR**：`ARCHITECTURE-V2.md:57-66,139,150-207,333,475-521,602-628,884-940,1213-1256,1260-1304,1578-1598,1608-1640`；`docs/adr/0001:13-19`；`docs/adr/0002:13,23,27`；`docs/adr/0003:12-24`；`docs/adr/0004:12-22`；`docs/adr/0005:11,18-37,40,47`；`AGENTS.md:12-16`；`.github/copilot-instructions.md:4-5`
