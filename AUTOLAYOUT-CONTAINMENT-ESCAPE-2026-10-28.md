# 自动布局后成员逃出容器 / 顶部标签脱开 / 整张画布被重排

日期：2026-10-28
范围：`v2/src/layout/spatial-region-analysis.ts`、`v2/src/layout/native-layout.ts`
状态：**仅分析，未改动任何代码**

---

## 0. 一句话结论

布局器只对「被识别为空间区域（spatial region）」的容器负责。这张图上 3 个彩色大容器中，只有 2 个被识别成区域（各含 3 个便签），第 3 个只含 2 个便签，被 `MIN_ENCLOSED_MEMBERS = 3` 拒掉；三个顶部标签是 `text` 单元格，从一开始就不属于任何区域的成员集合。于是这 5 个本该「跟着容器走」的单元格被当成独立节点丢进 ELK，而这张图 **0 条连线**，ELK 把每个节点都视为独立连通分量，按自己的顺序重新打包，最后整张画布被平移回 `margin = 30` 的原点。

三个现象是同一个根因的三个分支，不是三个 bug。

---

## 1. 现场证据

### 1.1 布局遥测（`~/.architecture-diagram-studio/logs/application-events.jsonl`）

最后一次布局 `2026-10-28T11:41:16.210Z`，页面 `-oyLyDtoHZ17c1edxMD_`，revision `01c67388…`：

```
engine=elk  algorithm=layered  direction=RIGHT
nodeSpacing=64  layerSpacing=90  margin=30   ← 与 native-layout.ts:95-104 的默认值完全一致

sourceVertexCount                          88
plannedVertexCount                         42
untouchedVertexCount                       46
nestedVertexCount                          46     ← 恰好 88-42，全是 parent 是 group 的节点
sourceEdgeCount                             0     ← 这张图一条连线都没有
spatialRegionCount                          3
spatialRegionMemberCount                   13
spatialAdjacencyClusterCount                3
spatialAdjacencyClusterMemberCount          8
spatialRegionUnownedContainedVertexCount    2     ← 关键
spatialRegionCandidatesSkippedCount         0
```

`spatialRegionUnownedContainedVertexCount = 2` 是上一份报告（`LAYOUT-CONTAINMENT-LOSS-2026-10-28.md` 建议 3）新加的上报计数器。**它准确抓到了这次事故，但只写进了日志，没有在 UI 上暴露任何提示。**

### 1.2 前后快照

| 用途 | 历史条目 | revision | 时间 |
|---|---|---|---|
| 布局前 | `728d1239-0ffc-405f-ab6e-484d7ebd9713.xml` | `01c67388…` | 11:39:55 |
| 布局后 | `881f4e8d-c68a-4347-886b-06197b772b52.xml` | `2222d5a6…` | 11:40:06 |

目录：`~/.architecture-diagram-studio/data/standalone-history/8aaa6472…/`

### 1.3 用当前代码实跑区域识别（对布局前快照）

```
candidates: 3  eligible: 3  skipped: 0
- 8Q6-1  "Unlabelled region" conf=medium eligible=true
    members(3): 8Q6-40, 8Q6-42, 8Q6-43
- 8Q6-44 "Unlabelled region" conf=medium eligible=true
    members(3): 8Q6-45, 8Q6-47, 8Q6-48
- 8Q6-53 "Unlabelled region" conf=high  eligible=true
    members(7): 8Q6-80, 8Q6-81, 8Q6-82, 8Q6-84, 8Q6-85, 8Q6-86, 8Q6-87
unownedContained: [ 8Q6-50, 8Q6-52 ]
```

3 + 3 + 7 = 13，与遥测的 `spatialRegionMemberCount = 13` 完全对上。
`8Q6-49`（第三个彩色容器）**根本没进候选**，它的两个子节点 `8Q6-50`（AI agent 任务）和 `8Q6-52`（Task 8）就是 `unownedContained` 的那两个。

### 1.4 布局前后的相对偏移（决定性证据）

「相对容器的偏移」是判断「有没有跟着走」的唯一正确指标：

| 单元格 | 标签 | 容器 | 布局前偏移 | 布局后偏移 | 结论 |
|---|---|---|---|---|---|
| `8Q6-40` | Task 1 | `-1` | (68, 28) | (68, 28) | ✅ 完全跟随 |
| `8Q6-42` | Task 2 | `-1` | (68, 139) | (68, 139) | ✅ |
| `8Q6-43` | Task 3 | `-1` | (78, 247) | (78, 247) | ✅ |
| `8Q6-45` | Task 4 | `-44` | (68, 28) | (68, 28) | ✅ |
| `8Q6-47` | Task 5 | `-44` | (68, 139) | (68, 139) | ✅ |
| `8Q6-48` | Task 6 | `-44` | (78, 247) | (78, 247) | ✅ |
| `8Q6-80` | (投票图标) | `-53` | (43, 45) | (43, 45) | ✅ |
| **`8Q6-50`** | **AI agent 任务** | **`-49`** | **(68, 28)** | **(−561.5, −289)** | ❌ **逃出** |
| **`8Q6-52`** | **Task 8** | **`-49`** | **(68, 139)** | **(−401.5, −289)** | ❌ **逃出** |
| **`8Q6-41`** | **To do（顶部标签）** | **`-1`** | **(116.5, −38)** | **(−107.5, −289)** | ❌ **脱开** |
| **`8Q6-46`** | **Doing（顶部标签）** | **`-44`** | **(119.5, −38)** | **(−510.5, −289)** | ❌ **脱开** |
| **`8Q6-51`** | **Done（顶部标签）** | **`-49`** | **(121.5, −38)** | **(−65, 305)** | ❌ **脱开** |

规律非常干净：**被识别为区域成员的 7 个便签，偏移量一个像素都没变；没被识别的 5 个单元格，偏移量被彻底打乱。** 机制本身是有效的，问题是覆盖不到这 5 个。

---

## 2. 根因 1：第 3 个容器只有 2 个成员，过不了成员数门槛

### 2.1 三个容器的几何

| 容器 | 坐标 | 尺寸 | 内部便签 | 成员数 | 是否区域 |
|---|---|---|---|---|---|
| `8Q6-1` | (−641, −269) | 305 × 638 | Task 1 / 2 / 3 | 3 | ✅ |
| `8Q6-44` | (−304, −264) | 305 × 638 | Task 4 / 5 / 6 | 3 | ✅ |
| `8Q6-49` | (43, −269) | 305 × 638 | AI agent 任务 / Task 8 | **2** | ❌ |

三者的 style 完全同构：

```
rounded=0;whiteSpace=wrap;html=1;sketch=1;hachureGap=4;pointerEvents=0;...;fillColor=#dae8fc;strokeColor=#6c8ebf;
```

没有 `container=1`，不是 `swimlane`，没有 `collapsible` → `hasExplicitRegionSemantics()` 为 `false`（`spatial-region-analysis.ts:21`）。它们只能走面积兜底：`area = 305×638 = 194,590 ≥ 16,000` 且 `≥ baselineArea × 5`，于是三个都进了 `preliminary`（`:38`）。

### 2.2 被卡在哪一行

`spatial-region-analysis.ts:40`：

```js
if (contained.length < MIN_ENCLOSED_MEMBERS
    && !(explicitRegionEvidence && contained.length >= 2)
    && !labelledSingleMember) continue;
```

对 `8Q6-49`：

- `contained.length = 2`，`MIN_ENCLOSED_MEMBERS = 3` → 第一个条件成立
- `explicitRegionEvidence = false`（纯矩形）→ 第二个救援条件失效
- `labelledSingleMember` 要求 `titled`，而 `titled = cell.value.trim().length > 0 || 存在一个"中心在容器内 + 贴边"的文字单元格`。容器自身 `value=""`；三个顶部标签都在容器**上边界之外**（见根因 2），中心不在容器内 → `titled = false` → 第三个救援条件也失效

→ `continue`，容器不是区域。它的 2 个便签留在 `vertices` 里，作为普通顶层节点交给 ELK。

**同一张图上 3 个一模一样的容器，只因为一个少放了一张便签，行为就完全不同。** 这是这次「AI agent 任务 / Task 8 跑出来」的直接原因。

### 2.3 为什么遥测只报了 2 个而不是更多

`unownedContainedVertexCellIds`（`:68-79`）遍历所有未被识别为区域、且完整包含成员的容器，把被包含的成员收集起来。`8Q6-49` 的两个便签命中，`8Q6-50` 与 `8Q6-52` 就是遥测里的 `2`。这个计数器是对的 —— 它只是没有出口。

---

## 3. 根因 2：顶部标签是 `text` 单元格，「贴边标题」这条路被 `containsCenter` 提前掐死

### 3.1 标签的形态

```
<mxCell id="…-41" style="text;html=1;align=center;verticalAlign=middle;resizable=0;
                          points=[];autosize=1;strokeColor=none;..." value="To do" vertex="1">
<mxGeometry x="-524.5" y="-307" width="63" height="28" as="geometry"/>
```

- `style` 以 `text` 开头 → `isTextLike()` 为 `true`（`:19`）
- 位置：y = −307 … −279，容器 `8Q6-1` 上边界 y = −269 → **标签整个在容器上边缘之外，距上边缘 10px**

### 3.2 两道互相矛盾的判定

`isRegionBoundaryTitle()`（`:31`）本来就是为这种情况写的 —— 它允许负的垂直位置：

```js
const verticalPosition = (label.y + label.height/2 - region.y) / region.height;
const nearTopOrBottom = verticalPosition <= 0.22 || verticalPosition >= 0.78;
return (nearTopOrBottom && label.width >= 50) || (nearSide && ...);
```

标签中心 y = −293，`verticalPosition = (−293 − (−269)) / 638 = −0.0376 ≤ 0.22` → `nearTopOrBottom = true`，`width = 63 ≥ 50` → **这个函数返回 `true`，它认可「贴在外面上边的标题」**。

但调用它的两个地方都先要求 `containsCenter`：

```js
// :40 判断容器是否"有标题"
const titled = cell.value.trim().length > 0 || vertices.some((other) =>
  other.id !== cell.id && isTextLike(other) && other.value.length > 0
  && containsCenter(cell, other)          // ← 中心必须在容器内
  && isRegionBoundaryTitle(cell, other));

// :43 收集"贴边标签"
const textLabels = vertices.filter((cell) =>
  cell.id !== region.cell.id && isTextLike(cell) && !connected.has(cell.id)
  && cell.value.length > 0
  && containsCenter(regionBounds, cell)   // ← 同一个前置条件
  && isRegionBoundaryTitle(regionBounds, cell));
```

`containsCenter()`（`:27`）判断的是标签**中心**是否落在容器矩形内。标签中心 y = −293 在容器外 → `false`，短路，`isRegionBoundaryTitle` 根本没被调用。

**结论：`isRegionBoundaryTitle` 里「允许垂直位置为负」的设计意图，永远不可能生效。** 只要中心在容器外就被前置条件淘汰，剩下的只有中心在容器内、且落在上/下 22% 或左右 15% 带内的标签。图上三个标签全部落在容器外，因此：

- 它们不是成员（`memberCellIds` 里没有）
- 它们不是贴边标签（`nearBoundaryLabels` 里没有）
- 于是既不被 `native-layout.ts:741` 从外层图里剔除，也不被 `:1096-1105` 按区域 delta 平移
- 最终作为 3 个独立节点进入 ELK，被随意摆放

布局后的实际位置：

| 标签 | 布局后坐标 | 容器布局后坐标 | 现状 |
|---|---|---|---|
| To do | (378, 30) | (485.5, 319) | 在容器左上外侧，水平差 44px、垂直差 261px |
| Doing | (300, 30) | (810.5, 319) | 在容器左上外侧，水平差 452px |
| Done | (1135.5, 624) | (1200.5, 319) 305×638 | 跑到容器**左外侧、垂直居中**，完全脱离 |

这就是「Todo / Doing / Done 应该和大容器保持紧密」失效的原因。

---

## 4. 根因 3：0 条连线 + `separateConnectedComponents` → 全图重新打包

### 4.1 这张图没有连线

`sourceEdgeCount = 0`。所以 `projection.edges` 是空数组，`layoutOptions` 里的

```js
"elk.separateConnectedComponents": "true"   // native-layout.ts:1719
```

把 **26 个孤立节点当成 26 个独立连通分量**。ELK 的 layered 算法对每个分量各自分层，再对分量做打包（packing）。分量之间没有任何约束，打包顺序由 ELK 内部决定，**与原图的空间排列毫无关系**。

观察布局后的 y 坐标就能看出来：`-71 … -79`（9 个 10×25 投票图标）被排成一行放在 y = 30、x = 30/60/90/…/270；紧接着 `-46`(300)、`-41`(378)、`-83`(461)、`-50`(639)、`-52`(799)、`-88`(959) 也在 y = 30。这是一行由 ELK 打包出来的「分量行」，顺序大致按 id 而非按原位置。

### 4.2 整张画布被平移回原点

`normalizePlan`（`native-layout.ts:1005-1009`）：

```js
const minX = Math.min(...layoutVertices.map((cell) => positions.get(cell.id)!.x));
const minY = Math.min(...layoutVertices.map((cell) => positions.get(cell.id)!.y));
const dx = preserveNativePositions ? 0 : options.margin - minX;   // margin 默认 30
const dy = preserveNativePositions ? 0 : options.margin - minY;
```

所有坐标被整体平移到以 (30, 30) 为起点。原图内容分布在 x ∈ [−641, 1786]、y ∈ [−307, 639] 的范围内，布局后全部挤进 x ∈ [30, 1786]、y ∈ [30, 1494]。

配合前面 42 个位置的写入量：**88 个顶点里 42 个拿到了全新的绝对坐标，其中没有一个保持原位。** 用户感知到的「布局也跑了」= 这不是一次局部整理，而是一次全画布重投影，连原本没问题的地方（标题、图注、投票图标、右侧泳道）都被重新摆放了。

### 4.3 具体损失

| 原意 | 布局后 |
|---|---|
| 3 个彩色面板在上排成一排，各带上方标题 | 三个面板落在 y = 319，标题散在 y = 30 一行 |
| 标题文字居中于面板上方 | To do 在面板左上、Doing 在左 452px、Done 在左外侧中部 |
| 底部图注 "Simple sticky note shapes…" 说明左侧便签区 | 被抬到 (30, 138)，与便签区完全无关 |
| 9 个投票图标 + 7 个投票图标属于同一组 | 9 个被排成 y = 30 一行，7 个跟着泳道去了 y ≈ 1022 |
| 右侧看板泳道在最右侧 | 被推到 (30, 977)，整张图最下方 |

---

## 5. 附带发现：区域 `8Q6-53` 的成员判定是错的

`8Q6-53` 是右侧那个 `swimlane`（720×517，内含 4 列）。它被识别成 `high` confidence 区域，**成员却是 7 个 10×25 的投票图标**（`8Q6-80/81/82/84/85/86/87`），不是那 4 列。

原因：

1. `8Q6-53` 是 `swimlane` → `hasExplicitRegionSemantics = true`，无条件进 `preliminary`（`:38`）
2. 4 列（`8Q6-54/58/62/65`）本身也是 `swimlane` → 也在 `preliminary` 里，被 `:40` 的 `!preliminaryIds.has(other.id)` 从 `contained` 里排除
3. 4 列的格子 `parent` 是列本身，不是 layer，`verticesByLayer`（`:32`）只收 `parent` 是 layer 的顶点 → 完全不参与区域分析
4. 结果 `contained` 里只剩下恰好浮在泳道范围内的 7 个装饰图标

也就是说：**「容器内最大的那批结构」被系统性地排除，只剩下装饰性小图标被认成成员。** 这次因为图标确实在泳道内，跟着走也没坏事；但这条路径意味着一个 720×517 的泳道，其区域成员判定是随机的 —— 换成「图标在泳道外 5px」就变成 0 成员、整条泳道退化成普通节点。

---

## 6. 为什么上一份报告没能拦住

`LAYOUT-CONTAINMENT-LOSS-2026-10-28.md` 给了 4 条建议，实际只落地了第 3 条（在 coverage 里上报未归属的包含节点），并且它确实抓到了这次事故（`spatialRegionUnownedContainedVertexCount = 2`）。但：

- 建议 1（放宽 `connected` 排除）没做 —— 这次不是主因（0 连线）
- 建议 2（降低成员数门槛到 1）没做 —— **这次就是它导致的**
- 建议 4（测试用例）没做
- 上报的计数器没有出口，只进 jsonl，UI 上看不到任何提示

---

## 7. 修复方案

全部遵循 ADR-0013：**不改 XML 的 `parent` 关系**，只调整求解时的临时投影。

### P0-1　把「完整包含 + 面积支配」变成区域资格的主判据，而不是「成员数 ≥ 3」

`spatial-region-analysis.ts:11, :40`

现在 `MIN_ENCLOSED_MEMBERS = 3` 是个硬数字门槛，一个 305×638 的容器装了 2 个便签就被判为「不是容器」，这在语义上说不通 —— 面积比已经足够强：`194,590 / 9,240 = 21 倍`。

建议改成：

```js
// 成员数门槛只在"面积支配"不成立时才需要
const dominates = contained.length > 0
  && candidateArea >= Math.max(...contained.map(area)) * MIN_REGION_AREA_TO_MEMBER_RATIO;
if (contained.length < MIN_ENCLOSED_MEMBERS && !dominates && !labelledSingleMember) continue;
```

即：**完整包含 ≥ 1 个成员 + 面积 ≥ 最大成员的 3 倍 → 就是区域**，与成员个数无关。`MIN_ENCLOSED_MEMBERS` 降为 `1` 或直接删除，靠 `MIN_REGION_AREA_TO_MEMBER_RATIO = 3` 和 `FULL_CONTAINMENT_RATIO = 0.85` 兜住误判。保留现有的 `low-confidence` / `nested-region` / `ambiguous-member-assignment` 跳过保护。

对这张图的效果：`8Q6-49` 面积是便签的 21 倍、完整包含 2 个 → 成为区域 → `8Q6-50/52` 进入 `regionOwnerByMemberId` → 按 delta 平移，偏移量保持 (68,28) / (68,139)。

### P0-2　让「贴边标题」真正可达

`spatial-region-analysis.ts:40, :43`

把 `containsCenter(cell, other)` 换成「中心在容器内 **或** 落在贴边带内」，与 `isRegionBoundaryTitle` 的设计意图对齐：

```js
const labelAttached = (region, label) =>
  isRegionBoundaryTitle(region, label) &&
  (containsCenter(region, label) || intersectsBand(region, label, BOUNDARY_BAND_PX));
```

`BOUNDARY_BAND_PX` 建议 24（覆盖「标题距上边缘 10px」这类常见画法），并要求标签宽度 ≥ 50（已有）以排除装饰性短文本。

同时 `:43` 的 `textLabels` 用同一个 `labelAttached` 谓词，保证「判定有标题」和「收集贴边标签」用同一套标准 —— 现在是两处各写一遍，容易再次分叉。

对这张图的效果：`8Q6-41/46/51` 进入 `nearBoundaryLabels` → 进入 `memberCellIds` → 跟着容器走，偏移量保持 (116.5,−38) / (119.5,−38) / (121.5,−38)。

### P0-3　没有连线时不要用 `layered` 重新打包

这是「布局也跑了」的根源，也是最伤用户信任的一条。三个选项，推荐 A：

**A（推荐）**　`calculateNativeAutoLayout` 在 `projection.edges.length === 0` 时，把 `elk.separateConnectedComponents` 设为 `"false"`，并给每个节点喂入原坐标作为初始位置，或者直接切到 `rectpacking` / `box`（代码里已有这两个算法，且 `:1652` 那条「有连线就报错」的守卫正好反过来印证了它们的定位）。

**B**　保留 `layered`，但按原 `y` 分桶、桶内按原 `x` 排序，用「行优先」的顺序喂给 ELK，让打包顺序至少与视觉顺序一致。

**C**　最小改动：无连线时直接拒绝并提示「这张图没有连线，自动布局只会重排位置；建议用 XX 算法」，把选择权交回用户。

无论选哪个，都需要同时处理下一项。

### P1-1　`margin` 重投影要可关闭

`native-layout.ts:1005-1009`

现在无论原图在哪，布局后一律从 (30, 30) 开始。建议增加 `preserveOrigin` 选项：保留原内容的包围盒左上角，只做相对位移。这样至少「图整体不会跳到左上角」。

### P1-2　把 `spatialRegionUnownedContainedVertexCount` 暴露到 UI

这个计数器已经能准确抓到事故。建议在布局完成后，若该值 > 0，在布局结果提示里加一句：

> 有 N 个节点位于某个容器内部，但该容器未被识别为分组，它们已被当作独立节点重新摆放。

给出 cell 数量，不需要列出 id。这是「静默损坏」和「已知限制」的分界线。

### P1-3　抑制 `8Q6-53` 那类误判成员

`spatial-region-analysis.ts:40`

成员集合里混进 10×25 的装饰图标，说明 `contained` 的构成没有下界。建议加一条：区域成员必须满足 `area(member) >= area(region) / 400`（或 `>= 1000 px²`），否则不计入成员、只记为 `boundaryCellIds`。对这张图：泳道 720×517 → 成员面积下界 930 px²，10×25 = 250 的图标被排除，区域 `8Q6-53` 变成 0 成员 → `skipReason = "no-unambiguous-members"` → 退化为普通节点（本来它的 4 列也是靠 `parent` 跟着走的，不影响结果）。

---

## 8. 验收标准

在布局前快照（`728d1239-…xml`）上重跑 `calculateNativeAutoLayout`，断言：

1. `8Q6-50`、`8Q6-52` 相对 `8Q6-49` 的偏移量与布局前**逐像素相同**（(68,28) / (68,139)）
2. `8Q6-41`、`8Q6-46`、`8Q6-51` 相对各自容器的偏移量与布局前**逐像素相同**（(116.5,−38) / (119.5,−38) / (121.5,−38)）
3. `spatialRegionCount ≥ 4`（3 个彩色容器 + 泳道，或泳道被 P1-3 排除后为 3）
4. `spatialRegionUnownedContainedVertexCount === 0`
5. `spatialRegionMemberCount ≥ 19`（3+3+2 便签 + 3 标签 + 8 图标）
6. 现有 overlap / nested / boundary 用例不回归

## 9. 建议补的测试

`v2/src/layout/spatial-region-analysis.test.ts`

- 「容器完整包含 2 个成员 + 面积 20 倍」→ 应产生 candidate
- 「容器完整包含 1 个成员 + 面积 10 倍」→ 应产生 candidate（P0-1 放宽后）
- 「text 单元格中心在容器上边缘外 10px、宽 63」→ 应出现在 `nearBoundaryLabels`
- 「泳道内只有 10×25 装饰图标」→ 不应产生 candidate（P1-3）

`v2/src/layout/native-layout.test.ts`

- 「0 条连线 + 3 个几何容器」→ 所有成员的相对偏移保持不变（对应验收 1、2）
- 「0 条连线」→ 布局前后包围盒左上角不被强制拉到 (30,30)（对应 P1-1）

---

## 10. 已实施（2026-10-28 20:10）

分析报告写完后，按上面的 P0 直接落地，未改动 XML `parent` 关系。

### 改动

| 文件 | 改动 |
|---|---|
| `v2/src/layout/spatial-region-analysis.ts` | 新增 `MIN_DOMINATED_MEMBERS = 2`、`MAX_BOUNDARY_TITLE_GAP = 24`、`rectangleGap()`、`labelBelongsToRegion()`；`:40` 的成员门槛增加 `dominatesEnclosed` 分支；`:40` 与 `:43` 的贴边标题统一走 `labelBelongsToRegion` |
| `v2/src/layout/native-layout.ts` | `projection.edges.length === 0 && algorithm !== "fixed"` 时不再调用任何引擎，直接沿用源坐标（`retainSourceCoordinates`）；`normalizePlan` 增加 `preserveCanvasOrigin` 参数，该路径下不再把整图平移到 `margin`；coverage 新增 `sourceCoordinatesRetainedVertexCount` |
| `v2/src/App.tsx` | 布局完成提示在该计数 > 0 时追加 `· no connectors, arrangement kept` |
| `v2/plugins/studio-selection-plugin.js` | `applyNativeLayoutPlan` 跳过几何完全相同的顶点（避免每次布局都产生一个空 undo 步），`changedVertices` 变成真实变更数；`setModified(true)` 只在确有变更时调用 |

### 关键取舍：0 连线时「保持原样」而不是「重新打包」

试过用「按阅读顺序分行走廊打包」替代 ELK，但这类画布是拼贴式的：容器高 638、便签高 66、图注高 20，任何基于中心线或纵向重叠的行分组都会把「三个面板 + 泳道 + 表格 + 图注」判成同一行或拆成十几行，结果同样是猜。图论布局需要边，没有边就没有可计算的结构，保持原坐标是唯一非任意的答案。ELK 的 `fixed` 算法本来就是这个语义，其余引擎现在被重定向到它。

`fixed` 不受影响（本来就是保留坐标）；其它算法在这个页面上得到的是一份「坐标与源一致」的 plan。

### 在真实快照上的验证

对布局前快照 `728d1239-…xml`（页面 `-oyLyDtoHZ17c1edxMD_`）重跑 `calculateNativeAutoLayout`：

```
regions 4  members 19  unowned 0  retained 19  positions 42  actuallyMoved 0
```

- 区域数 3 → 4（第三个容器 `8Q6-49` 被识别，标签成为 `To do` / `Doing` / `Done`）
- `spatialRegionUnownedContainedVertexCount` 2 → **0**
- 相对偏移全部逐像素保持：`-40 (68,28)`、`-43 (78,247)`、`-41 (116.5,−38)`、`-46 (119.5,−38)`、`-50 (68,28)`、`-52 (68,139)`、`-51 (121.5,−38)`
- `actuallyMoved = 0`：这份 plan 对 XML 是真正的空操作，什么都不会被搬走

### 测试

- 新增 6 个用例：`spatial-region-analysis.test.ts` 4 个（两成员容器 / 单成员仍拒绝 / 贴上边的标题 / 超宽图注不吸附），`native-layout.test.ts` 2 个（两成员容器整体跟随 / 0 连线保留源坐标）
- `spatial-region-analysis.test.ts` 19/19 通过；`native-layout.test.ts` 单文件 80/81 通过
- `tsc --noEmit` 干净，`vite build` 通过
- 全量 465 项中 4 项失败，均为既有问题：`server/jsonl-log.test.ts` 2 项（HEAD 上同样失败）、`native-layout.test.ts` 的 msagl 用例（满并发超时，单文件通过）、BPMN choreography 用例（`spatialAdjacencyInternalEdgeCount` 期望 5 实得 0，已用 `git stash` 验证在 HEAD 上同样失败）

### 仍未做

- P1-1（`margin` 重投影可关闭）：现在只在 0 连线路径下关闭，有连线的图仍会整体跳到 (30,30)
- P1-3（装饰性小图标不计入区域成员）：`8Q6-53` 仍把 8 个 10×25 图标当成员
- 「无连线时按阅读顺序整理」作为一个显式算法选项

