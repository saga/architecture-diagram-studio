# 布局提示条 & 连线走向 分析报告

- 日期：2026-10-27
- 范围：`v2/src/App.tsx`、`v2/src/layout/native-layout.ts`、`v2/plugins/studio-selection-plugin.js`、draw.io mxGraph 源码
- 样本：`~/Downloads/drawio-diagrams-dev/examples/citrix_network2.drawio`（37 节点 / 25 连线 / 5 个区域块）
- 状态：分析与实施记录；代码修改结果见文末（2026-10-27）

---

## 0. 结论先行

| 问题 | 结论 | 一句话根因 |
|---|---|---|
| ① 图上那条长消息必须显示吗 | **不必须**。它是纯展示，且同一份信息在另外两个地方已经有了 | `layoutCoverageNotice` 是 5 段独立文案的**字符串拼接**，只增不删，没有长度预算 |
| ② 连线转换后不自然 | **可修，且不是"审美问题"**。它是可量化的几何缺陷 | 布局只写 `geometry.points`、从不碰 style；而它写进去的点本身有 **58%~100% 的段是斜线** |

两个问题都指向同一个设计习惯：**把"内部过程"直接当成"用户界面"**。
① 把内部覆盖率统计直接当提示语；② 把求解器的中间路径直接当最终几何，中间没有任何正交化/落点约束。

---

# 一、那条长消息

## 1.1 它是什么

```tsx
// App.tsx:158
const [layoutCoverageNotice, setLayoutCoverageNotice] = useState<string | null>(null);
```

```tsx
// App.tsx:1683-1704 —— 渲染位置：画布区域内、工具栏之上
{layoutCoverageNotice ? (
  <div role="status" aria-live="polite" title="Only eligible top-level cells ...">
    <div>{layoutCoverageNotice}</div>
    <Button aria-label="Close layout summary" onClick={() => setLayoutCoverageNotice(null)}>×</Button>
  </div>
) : null}
```

生命周期：`runAutoLayout()` 开始时置 `null`（`:1288`）→ 计算完成写入一次（`:1364`）→ 序列化完成覆盖写入（`:1385`）→ 失败时置 `null`（`:1395`）→ 用户点 × 关闭。

**它只在 `Auto layout` 之后出现，其他任何操作都不会触发它。**

## 1.2 必须显示吗？不必须。三条证据

**证据 A：同一句话已经写进了底部状态栏**

```tsx
// App.tsx:1365
setLastAction(coverageMessage);
// App.tsx:1384-1385
setLastAction(appliedScope + regionNotice);
setLayoutCoverageNotice(appliedScope + groupHandlingNotice + exclusionNotice + regionNotice);
```

`lastAction` 渲染在 `App.tsx:2033` 的 `.bottom-status`，`styles.css` 里是 `white-space: nowrap` + `overflow: hidden`，**天然是单行截断**。
也就是说：这条消息**本来就有位置放**，而且那个位置不占画布。横幅是同一份文案的第二个副本，而它恰好是唯一占地方的那个。

**证据 B：完整结构化数据已经进了诊断面板**

```tsx
// App.tsx:1366-1374 / 1386-1392
recordDiagnostic("drawio.layout.ui.requested", "...", { coverage, engine, algorithm, ... });
recordDiagnostic("drawio.layout.ui.serialized", "...", { xmlLength, coverage, ... });
```

`coverage` 整个对象（含 `spatialRegionCount`、`connectorsAttachedToNestedChildrenCount` 等全部字段）都在 trace 里，右侧 Copilot 面板可查。横幅里的每个数字，诊断面板都有更精确的版本。

**证据 C：它没有任何交互价值**

`role="status"` + `aria-live="polite"`，除了 × 之外不可点、不可跳转、不可复制。既不是警告（不阻止操作），也不是确认（不需要用户应答），也不含需要立即决策的信息——**"Kept 5 spatial region(s) atomic with 29 member node(s)" 之后，用户没有任何可做的事。**

## 1.3 它为什么会长成这样

不是写错，是**拼接式生长**。五段文案分别由五个不同用途的变量拼出来：

```tsx
// App.tsx:1359-1363
const coverageMessage =
  "Layout scope: rearrange " + planned + "/" + source + " nodes and " + ... +          // ① 覆盖率
  groupHandlingNotice +                                                                // ② 分组/区域记账
  exclusionNotice +                                                                    // ③ 排除原因
  regionNotice;                                                                        // ④ 区域分析发现
```

实测这五段拼起来是：

| 段 | 字符数 | 内容 |
|---|---|---|
| `appliedScope` | 168 | 37/37 节点、16/25 连线、9 未动、保存状态 |
| `groupHandlingNotice` | 192 | 15 条走 group 边界的连线、5 个区域 29 个成员 |
| `exclusionNotice` | 0 | （本次为空） |
| `regionNotice` | 264 | 5 个候选区域 + **把 5 个区域名全列出来** + 一句策略声明 |
| **合计** | **624 字符 / 83 词 / 5 句** | 渲染成 4 行，约占 72px 画布高度 |

其中 `regionNotice` 里的 `regionLabels.join(", ")`（`App.tsx:1314`）是纯内部调试信息——"Outside Networks, Enterprise Cloud, Citrix XenApp Server Farm with firewalls, Residential Private Networks, Enterprise Networks" 这一串名字，对"我点了自动布局，它做了没有"这个问题的答案是 **0**。

**结构性问题：这段文本没有长度预算。** 每新增一个 coverage 字段，就往里追加一句；`regionNotice` 就是后来加的（`git log -S layoutCoverageNotice` → `3a88e7f6 Fix native canvas and atomic group layout`，2026-10-26）。下次再加一个"边界节点计数"，它还会更长。**没有任何测试或断言约束它的长度。**

## 1.4 附带缺陷：它会串台

`layoutCoverageNotice` 只在 `runAutoLayout` 内部被重置。切换文档、切换页面、打开另一个文件时**都不会清空**。

于是：在 A 图上跑一次布局（37/37 节点），切到 B 图，横幅仍然写着 A 图的 "37/37 nodes and 16/25 connectors"——用户会以为 B 图刚被改过。这比"消息太长"更严重，因为它说的是**错的事实**。

## 1.5 建议（三选一，按推荐度排序）

**方案 1（推荐）：一行摘要 + 可展开详情**

```
Auto layout · 37/37 nodes, 16/25 connectors moved · 9 connectors untouched   [Details ▾]  ×
```

- 默认只显示这一行（约 60 字符，1 行，24px 高）
- `Details` 展开后才是现在这 624 字符
- 关闭后**不再重新出现**（存 `localStorage`），因为它是重复信息
- 顺带修 1.4：`useEffect` 监听 `selectedNativePageId` / `drawioXml` 变化时清空

**方案 2：迁到诊断面板，画布上只留一个 toast**
布局完成 → toast "Layout applied: 37/37 nodes, 16/25 connectors" 3 秒自动消失；完整明细进 Diagnostics。适合"信息量天然很大"的场景。

**方案 3（最小改动）：只保留第一句**
把 `setLayoutCoverageNotice(appliedScope)` 的入参从四段拼接收窄成 `appliedScope`，其余三段只进 `recordDiagnostic`。改动 1 行，立刻从 624 字符降到 168 字符（1~2 行）。`exclusionNotice` 非空时（真的有东西没被布局）再追加一句——那才是用户需要知道的。

> 补充：不管选哪个方案，`aria-live="polite"` 都建议从整段文本上摘掉。屏幕阅读器现在会把 83 个词完整念一遍。

---

# 二、连线不自然

## 2.1 现象

布局之后，连线出现了三类肉眼可见的缺陷：

1. **斜着进/出方框**——本该垂直撞在方框边上，实际是一条斜线，有的直接切到角上
2. **绕远路的折线**——中间多出没必要的拐点，且拐点间距很短（"小台阶"）
3. **穿框**——连线从别的节点方块中间穿过去

这不是"风格不同"，是**几何上就不对**，可以测量。

## 2.2 实测一：磁盘上的文件

对 `citrix_network2.drawio` 逐条解析 25 条连线的 `mxGeometry`：

| 指标 | 数值 |
|---|---|
| 连线总数 | 25（**全部** `edgeStyle=none`，`rounded=0`，`jettySize=auto`） |
| 拐点数量分布 | 0 个：8 条 / 1 个：1 条 / 3 个：8 条 / 4 个：6 条 / 5 个：1 条 / 6 个：1 条 |
| 线段总数（含两端引线） | 77 |
| **斜线段** | **20（26%）** |
| **含至少一条斜线的连线** | **16 / 25（64%）** |
| 穿过无关节点方框的连线 | 2 |

一条典型的：

```
id ...G-6  style="edgeStyle=none;rounded=0;...;jettySize=auto;orthogonalLoop=1;endArrow=none;strokeWidth=2;"
points = [(515.2,452) (615.8,418.4) (969.0,418.4) (1064.0,351.0)]
```

从 (515,452) 到 (615,418) 是**斜的**（dx=100, dy=-34）；从 (969,418) 到 (1064,351) 也是**斜的**。

## 2.3 实测二：直接跑真实布局引擎

为了排除"是旧数据残留"，用仓库里真实的 `calculateNativeAutoLayout()` 对同一个文件重新计算，检查它**即将写进 XML 的点**：

```
[elk/layered]  routes=16  segments=31  diagonal=18 (58%)  edgesWithDiagonal=13
[elk/stress]   routes=16  segments= 6  diagonal= 6 (100%) edgesWithDiagonal= 6
[dagre/layered]routes=16  segments=21  diagonal=21 (100%) edgesWithDiagonal=15
```

**默认配置（ELK layered + `edgeRouting=ORTHOGONAL`）自己就产出 58% 的斜线段。**

再看这 18 条斜线在路径里的位置：

```
diagonal segment position: first=11  middle=0  last=7
```

**中间段 0 条，全部出现在首段和末段。** 这是一个非常明确的指向：求解器本身没算错，是**拼接阶段**接错了。

## 2.4 根因

### 根因 1：只写拐点，从不写样式（决定性）

`studio-selection-plugin.js:478-481`：

```js
plan.positions.forEach(function (item) { ... activeModel.setGeometry(cell, geometry); changedVertices++; });
plan.edgeRoutes.forEach(function (route) {
  var geometry = cell.geometry.clone();
  geometry.points = route.points.length ? route.points.map(...) : null;
  activeModel.setGeometry(cell, geometry);   // ← 只有几何
});
```

整个 `applyNativeLayoutPlan` 从头到尾**没有一处修改 `style`**。`NativeLayoutEdgePlan` 的结构里也没有 style 字段（`native-layout.ts:111` 只有 `{ cellId, points }`）。

后果：所有连线保持原始样式 `edgeStyle=none`。而 `edgeStyle=none` 在 draw.io 里的语义是**"照着我给的拐点画折线，不要再算"**——不重路由、不吸附、不圆角、不垂直约束。

也就是说：**求解器给什么形状，用户就看见什么形状，中间没有任何兜底。**

### 根因 2：`groupBoundaryPoint` 插入了不在求解器轴线上的点

15/16 条被布局的连线，端点挂在**分组（区域块）内部的子节点**上（`coverage.connectorsAttachedToNestedChildrenCount = 15`）。求解器只认识"分组"这个代理节点，所以它算出的路径是**分组边框 → 分组边框**。真正要连的是分组里的小方块，于是代码用 `native-layout.ts:707-730` 补一个"穿墙点"：

```ts
const groupBoundaryPoint = (nestedTerminalId, ownerId, oppositeTerminalId) => {
  ...
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: dx >= 0 ? owner.x + owner.width : owner.x,
             y: clamp(nestedCenter.y, ...) };   // ← y 取子节点中心
  }
  ...
};
```

然后直接 `unshift` / `push` 到求解器路径的两端（`:741-747`）：

```ts
const exit = groupBoundaryPoint(edge.sourceId, edge.layoutSourceId, edge.targetId);
if (exit) translated.unshift(exit);
```

问题就在这里：这个点的 **y 由"子节点中心"决定**，而求解器路径的第一个拐点 **y 由求解器决定**。两者没有任何约束关系，连起来就是一条斜线。

用实测数据验证——`G-6` 的完整路径是：

```
[[240,408], [350,302], [350,464], [513,175]]
   ↑穿墙点      ↑求解器拐点  ↑求解器拐点   ↑穿墙点
   └── 斜 ─────┘            └──── 斜 ────┘
```

`(240,408)→(350,302)` 是首段斜线，`(350,464)→(513,175)` 是末段斜线，中间那一段 `(350,302)→(350,464)` 是垂直的、完全正确。

**所以：中间 0 条斜线 + 首末 18 条斜线 = 100% 是这两个"穿墙点"造成的。** 这也解释了为什么"中间很规整，两端很别扭"。

### 根因 3：`edgeRouting` 选项只对 ELK 生效

```ts
// native-layout.ts:926
"elk.edgeRouting": options.edgeRouting,
```

这个字符串只进了 ELK 的 `layoutOptions`。dagre 分支（`:905-918`）、graphviz、msagl、cytoscape、d3 分支**完全不读它**——它们按自己的算法输出点，然后被原样写进 XML。

更麻烦的是：因为 `edgeStyle=none` 只画直线段，UI 上那个 **`Connector routing: ORTHOGONAL / POLYLINE / SPLINES` 下拉框在视觉上几乎没有区别，而 `SPLINES` 会让情况更糟**：

```
ORTHOGONAL  16 条连线  47 个拐点
POLYLINE    16 条连线  21 个拐点
SPLINES     16 条连线  53 个拐点   ← 用户以为"曲线更柔和"，实际得到更多折角
```

选 `SPLINES` 得到的是"点更多、折角更多、仍然是直线段"——**这是选项语义与渲染能力不匹配的陷阱**（要真曲线需要 `curved=1`，而代码从不写）。

### 根因 4：没有落点约束，端点由"斜线方向"反推

`edgeStyle=none` 时 draw.io 如何决定线撞在方框的哪个位置？两条源码：

```js
// mxGraph.js:8939-8949
mxGraph.prototype.isOrthogonal = function(edge) {
  var orthogonal = edge.style[mxConstants.STYLE_ORTHOGONAL];
  if (orthogonal != null) return orthogonal;
  return this.isOrthogonalEdgeStyle(this.view.getEdgeStyle(edge));
};
```

```js
// mxGraphView.js:1852
var pt = this.getPerimeterPoint(start, next, alpha == 0 && orth, border);
```

`edgeStyle=none` → `getEdgeStyle()` 返回 null → `isOrthogonal` 为 false → `getPerimeterPoint(..., orthogonal=false)` → 取"**中心点与下一拐点连线**和方框的交点"（`mxPerimeter.js:97-120`）。这条连线是斜的，交点自然落在斜边上，甚至落在角上。

而如果 `orthogonal=true`，同一个函数会走另一条分支（`mxPerimeter.js:122-133`）：把点吸附到方框的某一条边上，并把另一个坐标对齐到拐点——**端点就变成垂直撞边**。

代码从来没有设置过 `orthogonal`，也从来没有设置过 `exitX/exitY/entryX/entryY`（draw.io 的落点约束，由 `mxGraph.getConnectionConstraint` 读取，`mxGraph.js:7221-7234`）。等于把这个决定权完全交给了"斜线的角度"。

### 根因 5：区域内部的拐点是"刚性平移"，不是"重算"

```ts
// native-layout.ts:756-766
for (const edge of projection.regionInternalEdges) {
  const delta = regionDeltaById.get(regionId);
  const translated = edge.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
```

区域被当成整体搬走时，内部连线的拐点只是**平移同一个 delta**。如果区域内部的节点间距同时被压缩/展开了（rectpacking、overlap 消除等），平移后的拐点就和节点新位置对不上了——**原来的直角会变成小斜角或小台阶**。

---

## 2.5 修复方案对照

| # | 方案 | 改哪里 | 能修什么 | 风险 |
|---|---|---|---|---|
| **A** | 出计划前**强制正交化**：遍历每条 route，凡相邻两点 dx、dy 都非 0，就按主轴插一个直角拐点 | `native-layout.ts`（新增一个纯函数，约 15 行） | 所有引擎、所有情况，保证 0 斜线段 | 极低（纯函数，可单测；只加点不动拓扑） |
| **B** | `groupBoundaryPoint` 返回**两个点**：先 (边界X, 子节点Y)，再 (边界X, 求解器Y)，形成直角台阶 | `native-layout.ts:707-730` + `:741-747` | 首末段斜线（18/18） | 低（但需要拿到求解器首末拐点的坐标） |
| **C** | 写几何时给 style 补 `orthogonal=1` | `studio-selection-plugin.js:481` | 端点垂直撞边（不再切角） | 低，但**只修端点，不修中段**；且会改用户 style，需回滚快照一并覆盖 |
| **D** | 写几何时补 `exitX/exitY/entryX/entryY`（按首末段方向推导） | plugin + plan 结构加字段 | 落点稳定，之后手动拖动节点也不会乱跳 | 中（要动 plan schema 与快照） |
| **E** | 改 `edgeStyle=orthogonalEdgeStyle;rounded=1;jettySize=auto`，让 draw.io 重路由 | plugin:481 | 视觉立刻变"自然"（正交 + 圆角） | **高**：等于放弃 Studio 的通道决策，两套路由打架，且现有 waypoint 会变成强约束导致更怪 |
| **F** | `SPLINES` 时补 `curved=1`，或干脆去掉该选项 | plugin:481 / UI | 让选项名副其实 | 低 |

**推荐组合：A + B（治本，在 planner 内解决）→ C（治渲染，让端点垂直）→ F（修选项）**。E 不作为默认，可作为用户手动开关。

其中 A 的关键是**加断言**：在 `applyNativeLayoutPlan` 已有的 plan 校验里（`plugin:465-471`）加一条"不允许斜线段"，这样以后任何引擎/参数组合出问题都会在应用前失败，而不是变成用户屏幕上的怪线。

## 2.6 建议的回归用例

| 用例 | 断言 |
|---|---|
| `citrix_network2.drawio` + ELK layered | plan 内斜线段数 == 0 |
| 同上 + ELK stress | 同上 |
| 同上 + dagre | 同上 |
| 同上 + SPLINES | 斜线段 == 0，且（若实现 F）style 含 `curved=1` |
| 纯平铺图（无分组，20 节点 30 边） | 斜线段 == 0，拐点数不高于修复前 |
| 区域整体搬迁 | 区域内连线端点的两端线段仍然正交 |
| 回归：节点位置/尺寸 | 与修复前**逐字节相同**（A/B 只应影响 points） |

---

## 三、两个问题的共同点

| | 问题 ① | 问题 ② |
|---|---|---|
| 内部产物 | `coverage` 对象（十几个计数字段） | 求解器的中间路径（bend points） |
| 直接暴露成 | 用户可见的 4 行文案 | 用户可见的最终几何 |
| 缺的那一层 | **摘要 / 详情分层 + 长度预算** | **正交化 + 落点约束** |
| 后果 | 画布被占、信息串台 | 连线斜切、穿框、绕路 |

两边都是"内部数据 → 界面"之间少了一次**针对性转换**。修法也一样：不是在末端删减，而是在中间加一道转换层（①摘要器；②正交化器），并给它配一条**可断言的约束**（①长度上限；②零斜线段）。

---

## 附录：复现方式

```bash
cd v2

# ① 文件级几何体检（拐点/斜线段/穿框）
#    脚本见本报告 2.2 节思路，直接解析 <mxCell edge="1"> 的 <Array as="points">

# ② 引擎级体检：直接调用真实 planner，检查它写出的点
cat > /tmp/probe.mts <<'EOF'
import { readFileSync } from "node:fs";
import { calculateNativeAutoLayout, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS } from "<repo>/v2/src/layout/native-layout.ts";
import { calculateDrawioXmlRevision } from "<repo>/v2/src/intent/aiProvider.ts";
import { parseDrawioXml } from "<repo>/v2/src/model/drawio-xml-dom.ts";
const xml = readFileSync("<file>.drawio", "utf8");
const pageId = Array.from(parseDrawioXml(xml).getElementsByTagName("diagram"))[0].getAttribute("id")!;
const rev = await calculateDrawioXmlRevision(xml);
const plan = await calculateNativeAutoLayout(xml, pageId, rev, { ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS } as any);
// 统计 route.points 中相邻点 dx、dy 均非 0 的段数
EOF
./node_modules/.bin/tsx /tmp/probe.mts
```

本次实测原始输出：

```
pages: Nd0P9UUaNDj2tyyKrKiw / page 1
defaults: {"engine":"elk","algorithm":"layered","direction":"RIGHT","nodeSpacing":64,
           "layerSpacing":90,"edgeRouting":"ORTHOGONAL","iterations":300,"randomSeed":1,"margin":30}

[elk/layered]  routes=16 segments=31 diagonal=18 (58%)  edgesWithDiagonal=13
[elk/stress]   routes=16 segments= 6 diagonal= 6 (100%) edgesWithDiagonal= 6
[dagre/layered]routes=16 segments=21 diagonal=21 (100%) edgesWithDiagonal=15

diagonal segment position: first=11  middle=0  last=7

routing option comparison:
ORTHOGONAL  totalWaypoints=47
POLYLINE    totalWaypoints=21
SPLINES     totalWaypoints=53
```


---

# 四、实施结果（2026-10-27）

## 4.1 画布提示消息

已移除画布顶部的持久化布局横幅，不再把覆盖率、分组策略、区域名称和排除统计拼成多行消息。布局成功后，底部状态栏只保留一行结果摘要，例如：

`Auto layout · 37/37 nodes, 16/25 connectors · 9 connectors untouched`

完整的 `coverage`、布局引擎/算法、参数和区域分析计数继续写入 Diagnostics trace，不丢失排障信息。失败时仍在底部状态显示失败原因。由于横幅状态已删除，也不存在切换文档后把上一张图的横幅带到下一张图的问题。

## 4.2 连线路由与渲染

已在 `normalizePlan()` 的公共路径中增加正交路由归一化，覆盖 ELK、Dagre、Graphviz、MSAGL、Cytoscape、D3 及区域内部的显式 waypoints。归一化会吸附近似共轴点、为斜段插入一个直角拐点，并合并重复点和连续共线的小台阶；节点坐标和尺寸不由该步骤改写。

分组/空间区域代理边界点现在与求解器首尾拐点显式对齐：源端先沿边界方向形成直角过渡，目标端先对齐至边界再进入分组。规划器对输出再次断言不存在斜向 waypoint 段；Draw.io 插件应用前也执行同一约束校验，防止不合格路由直接写入画布。

应用布局时只更新被布局连线的 `orthogonal=1` 和 `curved` 样式键，保留现有 `edgeStyle`、颜色、箭头等其他键。选择 `SPLINES` 时写入 `curved=1`，其他模式写入 `curved=0`。样式与几何一并进入回滚快照；应用失败时恢复原始样式和几何。

## 4.3 回归覆盖

新增布局引擎矩阵测试，覆盖不含分组的普通连线，以及含空间区域/跨边界连线的六种引擎输出；断言每相邻两个 waypoint 至少有一个坐标轴对齐。双区域连接也增加了正交路由断言。

此次没有切换到全局 `orthogonalEdgeStyle`，也没有让 Draw.io 在应用后重新求解全部通道，因此保留 Studio 求解器已决定的路径和用户现有边样式。圆角外观不在本次强制覆盖范围内。
