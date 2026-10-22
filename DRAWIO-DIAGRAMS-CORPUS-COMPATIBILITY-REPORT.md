# drawio-diagrams 语料兼容性评审

- 评审对象：`jgraph/drawio-diagrams`（`dev` 分支，619 个文件） × 本项目 `v2/` 当前代码（HEAD `ff0784b`）
- 评审方式：**实跑**，不是纸面推演——把仓库里每个 `.drawio/.xml` 喂给真实的 `fromDrawioXml()` / `canEditInStudio()` / `patchDrawioXml()`
- 代码改动：无（仅新增本报告；探针脚本已删除）
- 日期：2026-10-22

---

## 0. 结论

**能解析，但解析出来的东西大部分是错的。** 语料里 615 个文件全部通过校验、全部能产出节点，但：

| 指标 | 结果 |
|---|---|
| 节点映射率 | **100%**（28,324 → 28,324） |
| 连线映射率 | **32.8%**（8,846 → 2,899） |
| 因 cell 顺序被丢弃的连线 | **4,456 条（50.4%）** |
| **全部连线丢失**的文件 | **217 个**（占 459 个含连线文件的 47%） |
| 名为 `"New node"` 的占位节点 | **14,504 个（51.2%）** |
| 角色被判定为 `domain` 的节点 | **91.9%** |
| 多页文件被静默丢弃的页 | **181 页 / 67 个文件** |
| 嵌套 cell（容器/分组/表行）坐标错误 | **10,761 个 cell / 297 个文件** |
| **能在 Studio 里编辑的文件** | **0 / 615** |

三条最要命的：

1. **`parseRootSlice()` 的正则有缺陷，导致 `canEditInStudio()` 恒为 `false`、`patchDrawioXml()` 恒为 `null`。** 不是"保守拒绝"，是**全拒**——连 Studio 自己导出的 XML 都过不了。仓库现有测试 `drawio-xml-source.test.ts` 已经因此变红。
2. **连线导入依赖 cell 出现顺序**：边比它的端点先出现就被丢弃。draw.io 自己的入门模板 `templates/basic/flowchart.xml` 因此 **5 条箭头全丢**。
3. **嵌套 cell 的 `mxGeometry` 是父级相对坐标，代码当成绝对坐标**：ER 图的行、UML 类的属性、泳道的任务，全部堆到原点。

---

## 1. 语料与方法

```
templates/        421 个（draw.io 模板库，最规范的一批）
blog/             110 个（博客示例，覆盖最杂）
examples/          84 个（官方示例：UML/BPMN/SysML/AWS/信息图…）
diagrams/          16 个
training-diagrams/ 14 个
```

- 462 个 `.xml` + 157 个 `.drawio`，共 619 个文件、796 页。
- 其中 **481 个是压缩页**（`<diagram>` 内是 base64+deflate，没有 `<root>` 文本），134 个是明文。
- 4 个不是图（3 个 `<mxlibrary>` 形状库 + 1 个 `<templates>` 索引），校验按预期拒收。

探针脚本直接 import 生产代码（`src/import/drawio.ts`、`src/model/drawio-xml-source.ts`、`src/model/drawio-xml-schema.ts`），用 `tsx` 跑真实函数，没有重写逻辑。

> 环境提示：`node_modules` 里缺 `@xmldom/xmldom`（`package.json` 已声明），不装的话 3 个测试文件连加载都失败。`npm install @xmldom/xmldom` 之后才拿到下面的数据。

---

## 2. P0：会让功能整体失效的问题

### P0-1　`parseRootSlice()` 的正则吞掉整段 XML，Studio 编辑通道全断

**位置**：`v2/src/model/drawio-xml-source.ts:29`

```ts
const rawCells = inner.match(/<mxCell\b[^>]*(?:\/>|>[\s\S]*?<\/mxCell>)/g) || [];
```

`[^>]*` 是贪婪的，会把自闭合标签里的 `/` 一起吃掉：

- 匹配 `<mxCell id="0"/>` 时，`[^>]*` 先吃到 ` id="0"/`，停在 `>` 前；
- 此时 `\/>` 分支不匹配（位置已经在 `>` 上），但 `>` 分支匹配成功；
- 于是引擎不回溯，接着用 `[\s\S]*?<\/mxCell>` 一路找到**后面某个 cell 的 `</mxCell>`**。

实测（`<root>` 内是 `0`、`1`、一个带 geometry 的 `a`）：

```
count 1
0  "<mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"a\" ...>...</mxCell>"
id[0] = 0
```

**三个 cell 被合并成一个**，`cellMap` 里永远没有 `"1"`，于是第 40 行：

```ts
if (!cellMap.has("0") || !cellMap.has("1")) return null;
```

**永远返回 `null`。**

连锁后果：

| 函数 | 行为 | 位置 |
|---|---|---|
| `parseRootSlice()` | 恒 `null` | `drawio-xml-source.ts:18` |
| `canEditInStudio()` | 恒 `false` | `:80` |
| `patchDrawioXml()` | 恒 `null` | `:104` |
| `App` 的 `studioEditingSafe` | 恒 `false` | `App.tsx:234` |
| 视图模式 | 水合后**强制切到 drawio** | `App.tsx:243` |
| `commitDocument()` | 无原生 XML 时**拒绝一切 Studio 编辑** | `App.tsx:469-475` |

**实测**：

```
canEditInStudio(toDrawioXml(createC4Fixture()), 同一串, doc)  → false
canEditInStudio(最小手写 mxfile（只有 0 和 1）, 同一串, doc)   → false
语料 615 个文件                                                  → 0 个 true
patchDrawioXml(...)                                              → 615 个全 null
```

**这不是"保守的门禁"，是坏掉的门禁。** 设计意图（`drawio-xml-source.ts:75-79` 的注释）是"外来文件宁可退回 Draw.io 也不冒险做有损编辑"，但现在是"连自家文件也退回"。

**仓库已经红了**：

```
FAIL  src/model/drawio-xml-source.test.ts > allows cell-level semantic updates while preserving mxfile and model metadata
      expected false to be true
FAIL  src/model/drawio-xml-source.test.ts > preserves opaque cells if a caller patches an XML source conservatively
      expected null not to be null
```

顺带一提：同文件里 "refuses Studio edits when the source contains an opaque cell" 和 "refuses semantic editing of multi-page files" 两个测试**现在是绿的，但绿得毫无意义**——它们断言"拒绝"，而实现无差别拒绝一切。

**修法**：不要用正则切 XML。写一个 20 行的标签扫描器——从 `<mxCell` 开始，逐字符前进，遇到引号就跳到配对引号，遇到 `>` 就停；若停前的最后一个非空白字符是 `/` 则为自闭合，否则向后找 `</mxCell>`。确定性、可测、不受属性值里的 `>` 影响。修完必须补一条"只有 `<mxCell id="0"/><mxCell id="1" parent="0"/>` 的最小文件也能通过"的用例。

---

### P0-2　连线导入依赖 cell 顺序，一半的边被丢弃

**位置**：`v2/src/import/drawio.ts:292-293`

```ts
if (!previousNodes.has(source) && !nodes.some((node) => node.id === source)) continue;
if (!previousNodes.has(target) && !nodes.some((node) => node.id === target)) continue;
```

`nodes` 是**边循环里正在累积的数组**。如果一条边在 root 里排在它的端点**之前**，`nodes` 里还没有那个节点 → 直接 `continue`。

draw.io 的 root cell 顺序是**插入顺序**，不是"先顶点后边"。模板、脚本生成、`bring to front`、复制粘贴都会打乱它。所以这不是边角情况。

**语料实测**：

```
总边数          8,846
保留            2,899  (32.8%)
因顺序丢弃      4,456  (50.4%)
因端点确实不存在  1,491  (16.8%，多为连到嵌套 cell，见 P0-3)
```

- **217 个文件一条边都没剩下**（占含边文件的 47%）。
- **406 / 459 个含边文件至少丢一条边**。

**最刺眼的例子——draw.io 自己的入门模板**：

| 文件 | 顶点 | 边 | 保留 | 原因 |
|---|---|---|---|---|
| `templates/basic/flowchart.xml` | 6 | 5 | **0** | 5/5 顺序丢失 |
| `templates/basic/erd.xml` | 27 | 2 | **0** | 2/2 顺序丢失 |
| `templates/basic/swimlanes.xml` | 12 | 8 | **0** | 8/8 顺序丢失 |
| `templates/basic/orgchart.xml` | 5 | 3 | **0** | 3/3 顺序丢失 |
| `templates/basic/classes.xml` | 27 | 3 | 3 | 顺序恰好正确 |

`flowchart.xml` 里 13 个 cell 的排列是边和顶点交错的：

```
-  -  E  V  E  E  V  V  E  E  V  V  V
0  1  2  3  4  5  6  7  8  9  10 11 12
```

第一条边（index 2）出现在第一个顶点（index 3）之前，结果 5 条边一条都没留下。

于是"流程图"导进来是一堆没有箭头的方框。

**修法**：循环前先算一次顶点集合，用它判存在性，不再依赖累积顺序。

```ts
const importedVertexIds = new Set(
  cells.filter((c) => c.getAttribute("vertex") === "1" && !isStructuralCell(c)).map(cellId)
);
// 边分支里
if (!previousNodes.has(source) && !importedVertexIds.has(source)) continue;
```

注意别图省事用现成的 `currentCellIds`（`drawio.ts:219`）——那里面含边，会让"边连边"通过校验，导出时变成悬空 source。建议顺便把边放进**第二遍循环**，语义更清楚。

---

### P0-3　嵌套 cell 用父级相对坐标当绝对坐标

**位置**：`v2/src/import/drawio.ts:262-268`

```ts
const geometry = directChild(cell, "mxGeometry");
...
const x = Number(geometry.getAttribute("x") || 0);
const y = Number(geometry.getAttribute("y") || 0);
```

mxGraph 里，子 cell 的 `mxGeometry` 是**相对父 cell 原点**的。代码只看 `parent` 是否为 `"1"` 就一律当绝对坐标用，也完全不累加父级偏移。

**实测三个典型文件**：

`templates/basic/swimlanes.xml`
```
child  ...-20  style=swimlane;...  geom=(20,0)   | parent ...-19 geom=(120,120)
child  ...-23  style=ellipse;...   geom=(40,40)  | parent ...-20 geom=(20,0)
→ 导入后 ...-20@(20,0)  ...-23@(40,40)
```
泳道和池子全叠在左上角。

`templates/basic/erd.xml`（27 个节点，24 个嵌套）
```
parent Orders @(450,120)
child  @(0,30)  child @(0,0)  child @(30,0) ...
→ 导入后 Orders@(450,120)，所有表行 @(0,~0)
```
一张 ER 图 = 1 个表 + 一堆挤在原点的碎片。

`examples/uml-class-example.drawio`（32 个节点，32 个嵌套）
```
Person @(200,20)
+name: str @(0,26)   +phoneNumber: str @(0,52)   +emailAddress: str @(0,78)
→ 导入后所有属性 @x=0
```

**语料规模**：**10,761 个嵌套 cell，分布在 297 个文件**（48% 的文件）。另有 285 个 cell 的 parent 根本不在 root 层，无法解析。

**修法**：累加祖先偏移。

```ts
function absoluteOrigin(cell, byId) {
  let x = 0, y = 0, cur = cell;
  while (cur && cur.parent !== "1" && cur.parent !== "0") {
    const p = byId.get(cur.parent);
    if (!p) break;
    x += p.x; y += p.y;
    cur = p;
  }
  return { x, y };
}
```

先建 `byId`（root 全部 cell），再算绝对坐标。同时要决定**是否保留层级**：只求"看起来对"，累加即可；要支持 ER 表/泳道/分组，得给 `DiagramNode` 加 `parentId`，并且导出时把 `parent="1"` 换成真实父级（`export/drawio.ts:29` 现在硬编码 `parent="1"`）。

---

### P0-4　空 `value` 的 cell 变成 `"New node"` 占位框

**位置**：`v2/src/import/drawio.ts:274-275`

```ts
...(old || { id, name: value || "New node", ... }),
name: value || (old ? old.name : "New node"),
```

draw.io 里大量 cell 是**结构性的**：ER 表的分隔行、UML 类的分隔线、`edgeLabel` 锚点、`group` 容器、透明布局辅助块。它们的 `value` 是空的。代码把它们全部变成有名字的可见节点。

**语料实测**：

```
节点总数            28,324
名为 "New node"     14,504  (51.2%)
涉及文件            471 个
```

ER 模板里直接能看到：

```
C-vyLk0tnHw3VtMMgP7b-2  name="Orders"                 role=domain
C-vyLk0tnHw3VtMMgP7b-3  name="New node"   geom=(0,30)  ← 表体分隔
C-vyLk0tnHw3VtMMgP7b-4  name="PK"         geom=(0,0)
C-vyLk0tnHw3VtMMgP7b-6  name="New node"   geom=(0,60)  ← 下一行分隔
```

导入一张 3 张表的 ER 图，画布上会出现几十个写着 "New node" 的灰框。

**修法**：把"无语义文本 + 结构性样式"的 cell 归为装饰，不进 `nodes`（它们仍在原生 XML 里，不影响保存）。判据可以很保守：

```ts
const structural = /(?:^|;)(?:text|edgeLabel|group|swimlane)\b/.test(style)
  || /shape=partialRectangle/.test(style)
  || (!value && !old);
```
或者退一步：`name: value` 允许为空，渲染层跳过空标签节点。前者更干净。

---

## 3. P1：语义与覆盖问题

### P1-1　多页文件只取第一页，且没有任何提示

`import/drawio.ts:162`：

```ts
const diagram = directChildren(parsed.documentElement, "diagram")[0];
```

只投影第一页。**67 个多页文件、796 页中 181 页被静默丢弃**。

对比：这条注释说得没错——"不要跨页合并 cell ID"。合并确实是更糟的 bug，已经被修掉了。但现在走向另一个极端：打开 15 页的文件，用户只看到 1 页，且没有任何"还有 14 页"的提示。

典型：`blog/connector-style-reference.drawio` 15 页 → 只导入第 1 页的 6 个节点。这是它在"节点映射率"榜上垫底（6/200）的唯一原因。

**修法**：把 `validateDrawioXmlDocument()` 已经算出来的 `warnings` 透出到 UI（现在完全没人用），至少提示"本文件有 N 页，仅显示第 1 页"。完整方案是页选择器 + 每页一份投影。

### P1-2　形状语义几乎全部丢失，92% 变 `domain`

`roleFromStyle()`（`import/drawio.ts:46-54`）只认四种：

```ts
if (style.includes("rhombus")) return "decision";
if (style.includes("ellipse") || style.includes("arcSize=50")) return "service";
if (style.includes("database") || style.includes("cylinder")) return "storage";
return "domain";
```

**语料角色分布**：

```
domain     26,026  (91.9%)
service     2,018  ( 7.1%)
decision      204  ( 0.7%)
storage        76  ( 0.3%)
```

`shape=table`（ER）、`swimlane`（泳道）、`shape=umlLifeline`、`shape=actor`、`shape=cloud`、`shape=hexagon`、`shape=document`、`shape=datastore` —— 全部落到 `domain`。

**语料规模**：**12,887 个带 `shape=` 的顶点，分布在 447 个文件（73%）**。

后果不只是"颜色不对"：`domain` 在 C4 布局里被排到第 3 列（`layout/elk.ts:10-16`），于是 ER 图会被当成 C4 容器图重排。

### P1-3　连到嵌套 cell 的边永远解析不出来

P0-3 的连带伤害。`cells` 只含 root 直接子节点，嵌套 cell 不在集合里，所以以它们为端点的边在 `:292-293` 被丢弃。

**语料**：1,491 条边（16.8%）属于这一类。P0-2 和 P0-3 一起修就能顺带解决。

### P1-4　draw.io 的时序图不会被识别成 `sequence`

`import/drawio.ts:337-340`：

```ts
const isSequenceDiagram = previous.kind === "sequence" || cells.some((cell) => {
  const cellId = ...;
  return cellId.endsWith("__lifelineEnd") || cellId.endsWith("__messageSourceAnchor");
});
```

只认 Studio 自己导出的标记。draw.io 原生时序图用的是 `shape=umlLifeline` + `shape=umlActor` + 普通边。

**实测**：`templates/basic/sequence.xml` → `kind` 保持传入值 `c4`，`sequence` 字段不存在，5 个参与者被当普通节点。后续 `layoutDiagram()` 会按 C4 语义排序，而不是走 `layoutSequence()`。

### P1-5　非图形文件报 `Invalid input`，用户拿不到任何线索

3 个 `<mxlibrary>` + 1 个 `<templates>` 被拒是对的，但错误信息是 zod union 折叠后的字面量：

```
blog/custom-templates.xml       :: validation: Invalid input
blog/freehand-rockpool-shapes.xml :: validation: Invalid input
blog/home-lab-custom-shapes.xml  :: validation: Invalid input
blog/template-index.xml          :: validation: Invalid input
```

而 `fromDrawioXml()` 在 `:199` 直接 `return previous`，把原因彻底吞掉；`App.tsx` 最终提示"没有可导入的节点"。

**修法**：`DrawioXmlRootSchema` 用 `z.discriminatedUnion` 或在失败时挑第一个分支的 issues；`fromDrawioXml` 返回 `{ document, issues }` 而不是裸 `previous`。至少要说清"这是形状库文件（mxlibrary），不是图"。

### P1-6　校验对整份文件全页生效，一页坏则整份拒收

`drawio-xml-schema.ts:430-440` 会遍历**每一页**解压并校验；任一页失败 → 整个文件 `success: false` → 导入直接放弃。

语料里 0 例（文件都合法），但这是"打开一个大文件，因为第 7 页某个压缩块坏了，前 6 页也看不了"的结构性风险。

顺带：`:448` 又把每页**再解压一次**做 inventory 警告，等于每页解码两遍。988 KB 的文件实测 38 ms 校验 + 39 ms 导入，暂时可接受，但页数一多会线性放大。

---

## 4. 影响面：这批文件进 Studio 之后会怎样

| 文件类型 | 解析结果 | 用户看到 |
|---|---|---|
| `templates/basic/flowchart.xml` | 6 节点 / 0 边 | 6 个方框，没有箭头 |
| `templates/basic/erd.xml` | 27 节点 / 0 边 | 1 个表名 + 26 个原点附近的碎片，一半叫 "New node" |
| `templates/basic/swimlanes.xml` | 12 节点 / 0 边 | 泳道和任务全叠在左上角 |
| `examples/uml-class-example.drawio` | 32 节点 / 4 边 | 类名 + 属性各成一个节点，属性全在 x=0 |
| `examples/uml-timing-example.drawio` | 131 节点 / 1 边 | 38 条时间线的消息只剩 1 条 |
| `blog/concept-maps.drawio` | 35 节点 / 0 边 | 6 页里的第 1 页，59 条关系全丢 |
| 任意文件 | — | **水合后被强制切到 Freeform，Studio 画布不可用** |

最后一行是当前最严重的问题：即使前四个 P0 全修好，只要 P0-1 不修，Studio 依然是只读的旁观者。

---

## 5. 建议的修复顺序

| 优先级 | 动作 | 改动量 | 验收 |
|---|---|---|---|
| **P0-1** | 用扫描器替换 `parseRootSlice` 的 cell 正则 | ~30 行 + 2 个测试 | `drawio-xml-source.test.ts` 转绿；语料 `canEditInStudio` 从 0/615 变为 >0 |
| **P0-2** | 边端点判存在性改用预扫的顶点集合 | ~6 行 | `flowchart.xml` 5/5 边；语料边映射率 32.8% → >80% |
| **P0-3** | 累加祖先偏移算绝对坐标 | ~20 行 | `erd.xml` / `swimlanes.xml` 元素不再堆在原点 |
| **P0-4** | 结构性 cell 不进 `nodes` | ~10 行 | `"New node"` 占比 51.2% → <5% |
| P1-1 | 透出 `warnings`，提示"仅显示第 1 页" | 前端小改 | 多页文件有明确提示 |
| P1-2 | `roleFromStyle` 补 `shape=` 映射表 | ~40 行 | `domain` 占比 91.9% → <60% |
| P1-3 | 随 P0-3 自动解决 | — | 1,491 条边恢复 |
| P1-4 | 识别 `shape=umlLifeline` | ~15 行 | `sequence.xml` → `kind: "sequence"` |
| P1-5 | 区分 `mxlibrary`，错误信息带原因 | ~20 行 | 4 个非图文件报"这是形状库" |
| P1-6 | 按页惰性校验 | ~30 行 | 单页损坏不影响其它页 |

**P0-1 应该单独发一个修复提交**，它和图形覆盖度无关，是纯粹的功能性回归，而且现有测试已经能证明。

---

## 6. 建议补的测试

现在 `src/import/` 下只有 `drawio-style-import.test.ts`，没有覆盖本次发现的任何一类问题。建议加一组"语料回归"用例，用最小手工构造的 XML 表达每种失败模式，避免依赖外部仓库：

1. **顺序**：边写在两个顶点之前 → 断言 `relations.length === 1`。
2. **嵌套**：父 `@(400,300)`、子 `@(10,20)` → 断言子节点绝对坐标 `(410,320)`。
3. **占位**：`value=""` + `style="text"` → 断言不产生节点。
4. **多页**：两页 → 断言只取第一页且 `warnings` 里有提示。
5. **形状**：`shape=table` → 断言不是 `domain`。
6. **最小文件**：只有 `<mxCell id="0"/><mxCell id="1" parent="0"/>` → `canEditInStudio` 必须为 `true`（当前为 `false`，正好锁住 P0-1）。

如果想做更强的回归，可以把 `jgraph/drawio-diagrams` 的一个小子集（比如 `templates/basic/*`，8 个文件，约 40 KB）作为测试夹具提交进仓库，跑"节点数/边数/角色分布"快照断言。

---

## 7. 附：复现方式

```bash
git clone --depth 1 -b dev https://github.com/jgraph/drawio-diagrams /tmp/dd
cd v2 && npm install @xmldom/xmldom   # 当前 node_modules 缺这个声明过的依赖
npx vitest run                        # 6 个失败，其中 2 个是 P0-1
```

探针脚本（评审时临时创建，已删除）的核心逻辑就是：

```ts
const doc = fromDrawioXml(xml, emptyDoc());
const projection = toDrawioXml(doc);
canEditInStudio(xml, projection, doc);   // → 全部 false
patchDrawioXml(xml, projection, doc);    // → 全部 null
```

---

## 8. 与既有结论的关系

仓库根目录已有一份 `DRAWIO-DIAGRAM-TYPE-READINESS-REPORT.md`（07:54 写的，基于更早的代码）。今天 08:23 的重构（`ff0784b` 及之前几个提交）已经**实质性解决了那份报告里的 P0-2/P0-3**：

- 原生 XML 成为唯一真相源（`types.ts` 里 `DiagramDocument` 的注释已改）；
- `patchDrawioXml()` 改为按 cell id 打补丁，不再整篇重建；
- 多页不再跨页合并 cell id。

但也正因为这次重构引入了 `drawio-xml-source.ts`，才带来了 P0-1 这个新回归。**那份报告里"任何 Studio 编辑都会覆盖原生 XML"的结论已经过期**，不要按它去改；本报告第 2 节才是当前代码的实际状态。


---

## 9. 后续修改状态（2026-10-22）

本报告的原始测量基于旧 HEAD `ff0784b`。后续已按 P0/P1 发现修改主分支代码；原有的 619 文件映射数值仍可用于描述旧版本问题，但**不能当作当前版本的实测指标**。

| 原报告发现 | 当前处置 |
|---|---|
| P0-1：XML cell 扫描导致 Studio 编辑全拒 | 已换成带引号状态的标签扫描器；补了最小 XML 编辑校验，并为旧 Studio 默认 layer cell 增加有限迁移。 |
| P0-2：边端点检查依赖 cell 顺序 | 已改为先导入所有顶点、再用完整索引解析边。 |
| P0-3：嵌套坐标被当成绝对坐标 | 已累加父级坐标，投影记录父级 ID，导出时恢复父级相对几何和可表示的层级。 |
| P0-4：无文本 cell 变成 `New node` | 无文本且没有既有语义的 cell 不再生成可见语义节点，原生 XML 仍保留。 |
| P1-1：多页文件静默丢页、schema warnings 没人消费 | 已在文件导入、工作区打开和 hydration 路径显示兼容诊断，并将 warnings 记录到 Agent traces。当前仍只将第一页投影为 Studio 语义模型；多页文件不会通过安全编辑门禁，完整 XML 保留并由原生 Draw.io 视图处理。 |
| P1-2：主题选择被弹回 | 已修正 effect 的触发依赖，单独改变 UI 主题不再被旧文档主题反向覆盖。 |
| P1-3：布局选项保存后回退 | `profile`、方向、路由、间距、边界 padding 和左右/上下语义放置设置已写入默认 layer cell 的 `studioLayout*` 元数据，并从 XML 恢复。 |
| P1-5：大量 shape 落入 `domain` | 已增加常见 actor/UML、cloud、swimlane、table、database、decision、document 等样式映射。 |
| P1-6：原生时序图未识别 | 已识别包含 UML lifeline/actor 样式的原生时序图。 |
| P2：形状库或模板索引的错误不清楚 | 诊断会明确说明 `<mxlibrary>` 是自定义形状库、`<templates>` 是模板索引，不是图表文件。 |

保真原则未改变：Draw.io XML 仍是唯一事实源；Studio 语义模型只是派生投影。对无法完整表示或无法安全 patch 的原生结构，仍然拒绝 Studio 语义编辑，而不是冒险重建整份 XML。

当前没有重新运行完整的 619 文件 corpus 探针或全量测试。因此还不能给出修复后的节点/连线映射率、`domain` 占比或测试通过率。后续验收应重跑旧探针并验证实际 XML 往返保真度。


## 10. LeanIX 范围校准（2026-10-22）

多页文件只投影第一页是本项目面向 LeanIX 的既定范围，不应作为兼容性缺陷或待实现的页选择器需求。诊断 API 保留 `pageCount`，但不再仅因页数大于 1 生成 warning；真实的 schema warnings 仍会呈现。完整 Draw.io XML 继续作为唯一事实源保存。

后续源码复审另修正了一个导入状态问题：当当前 XML 没有 edge cell 时，不再从前一个文档复用关系；合法空页也不再退回旧文档。新增了对应回归测试。修复后的测试和语料指标仍需实际运行后才能确认。

## 11. 复审继续：禁止旧文档端点污染当前页面（2026-10-22）

继续审查发现，导入器虽然不再复用整组旧关系，但此前仍允许当前 XML 的边引用只存在于旧语义文档中的节点。已收紧为 source/target 必须同时存在于当前 XML 页面投影出的节点集合，并添加对应回归测试。该变更不影响“只投影第一页”的 LeanIX 目标；它确保第一页内部的关系不会借用旧页面或旧文档状态。

回归测试和语料探针尚未实际运行，当前没有新的映射率或通过率数据。

## 12. 复审继续：显式语义标记必须来自当前 XML（2026-10-22）

发现导入器在同 ID cell 存在于上一份投影时，会优先复用旧的 `role` / `visualRole`，从而忽略当前 XML 中显式写入的 `studioRole` / `studioVisualRole`。已修改为显式标记优先、旧投影仅作缺少标记时的回退，并新增回归测试。该原则与 XML 唯一事实源一致。

测试与语料探针尚未实际运行，不报告新的通过率或映射指标。
