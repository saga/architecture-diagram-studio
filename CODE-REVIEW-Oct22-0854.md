# 代码复审：Draw.io XML 管线（HEAD `27040a7`）

- 复审基线：`27040a7 test(schema): preserve unusual cell geometry with a warning`
- 上一份报告：`DRAWIO-DIAGRAMS-CORPUS-COMPATIBILITY-REPORT.md`（基线 `ff0784b`）
- 本次方法：重读改动文件 + **重跑 619 个真实文件** + 跑全量测试
- 代码改动：无（仅新增本报告；探针脚本已删除）

---

## 0. 结论

**当前 HEAD 的 Studio 语义编辑能力是 0。** 不是"对外来文件保守拒绝"，是**连 Studio 自己导出的文件都拒绝**。

根因是一个正则：`drawio-xml-source.ts:29` 把整段 `<root>` 的内容合并成一个 cell，导致 `parseRootSlice()` 恒返回 `null`，进而 `canEditInStudio()` 恒 `false`、`patchDrawioXml()` 恒 `null`。

它有四个用户可见的症状，其中两个是这次复审新发现的：

| # | 症状 | 位置 |
|---|---|---|
| 1 | 水合后强制切到 Freeform，**Studio 画布不可达** | `App.tsx:243` |
| 2 | 顶栏的 Studio/Freeform 切换按钮**被禁用** | `App.tsx:1101` |
| 3 | **服务端 6 处语义门禁全部拒绝**（AI 操作、提案、模板、恢复、布局） | `copilot-server.ts:408/473/520/586/641/1166/1432/1445` |
| 4 | **主题选择器失效**——选完立刻弹回原主题 | `App.tsx:1068-1069` + `527-528` |

第 3、4 条是上次没发现的。第 4 条尤其隐蔽：它和"编辑"看起来毫无关系。

好消息是：**导入不再自动重排**了（ADR-0006 的验收项已满足），XML 也确实是唯一真相源，保存链路不依赖投影。数据是安全的，坏的是能力。

---

## 1. 相比上一份报告，已经修好的

| 项 | 上次状态 | 现在 | 证据 |
|---|---|---|---|
| 导入后强制自动布局 | 无条件 `requestServerLayout` | **已移除**，注释明确"Opening a Draw.io file must preserve its geometry" | `App.tsx:327-329` |
| 多页 cell id 合并 | `querySelectorAll` 跨页合并 | **已修复**，只投影第一页 | `import/drawio.ts:162` |
| 编辑覆盖整份 XML | `toDrawioXml` 整篇重建 | **已改为按 cell id 打补丁**，保留 `<root>` 外的字节 | `drawio-xml-source.ts:104-136` |
| `document.createElement` 依赖 | 导入器依赖浏览器 | **已移除**，改正则 + 实体解码，服务端可用 | `import/drawio.ts:22-30` |
| 几何缺失被拒收 | `f5af373` 曾硬拒 | **已改为 warning** | `bb2b5f2` |
| mxlibrary 同时含 xml+data 被拒 | XOR 校验 | **已放宽** | `eb88083` |

ADR-0006 里"导入不得自动布局""XML 为唯一真相源""补丁必须保留未知 cell"三条，代码都落实了。这次重构的方向是对的，问题出在补丁器本身的实现。

---

## 2. P0-1　`parseRootSlice()` 的正则让补丁器整体失效

**位置**：`v2/src/model/drawio-xml-source.ts:29`

```ts
const rawCells = inner.match(/<mxCell\b[^>]*(?:\/>|>[\s\S]*?<\/mxCell>)/g) || [];
```

### 为什么会坏

`[^>]*` 是贪婪的，会连自闭合标签的 `/` 一起吃掉。以 `<mxCell id="0"/><mxCell id="1" parent="0"/>` 为例：

1. `[^>]*` 吃到 ` id="0"/`，停在 `>` 前；
2. 当前位置是 `>`，`\/>` 分支不匹配，但 `>` 分支匹配成功；
3. 正则引擎**不回溯**（第一个可行分支已经成功），接着 `[\s\S]*?<\/mxCell>` 一路找到后面某个 cell 的闭合标签。

结果三个 cell 被合并成一个：

```
输入：<mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" ...>...</mxCell>
匹配：count 1
      0  "<mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/><mxCell id=\"a\" ...>..."
      id[0] = 0
```

`cellMap` 里永远没有 `"1"`，于是 `:40`：

```ts
if (!cellMap.has("0") || !cellMap.has("1")) return null;
```

**恒返回 `null`。**

### 实测

```
canEditInStudio(toDrawioXml(createC4Fixture()), 同一串, doc)   → false
canEditInStudio(最小手写 mxfile（只有 0 和 1）, 同一串, doc)    → false
619 个语料文件                                                  → 0 个 true
patchDrawioXml(...)                                            → 619 个全 null
```

注意第一行：**source 和 projection 是同一个字符串**，`cellMap` 理论上必须完全相等，仍然返回 false。这足以证明问题不在"门禁太严"，而在解析器本身。

### 四个症状的传导链

```
parseRootSlice → null
  ├─ canEditInStudio → false
  │    ├─ App.tsx:243  强制 viewMode="drawio"（且 deps 含 viewMode，手动切回会被再次踢走）
  │    ├─ App.tsx:1101 切换按钮 disabled={!studioEditingSafe}
  │    ├─ App.tsx:469  commitDocument 拒绝一切语义编辑
  │    └─ App.tsx:1069 主题切换不写入 document
  │         └─ App.tsx:527-528  document.renderTheme !== uiTheme → setUiTheme(旧值) 弹回
  └─ patchDrawioXml → null
       └─ server 6 处 isStudioProjectionCurrent → 全 false → 409/throw
```

服务端那 6 处分别是：语义操作（`:1166`）、提案（`:641`）、模板（`:586`）、版本恢复（`:676`）、布局（`:520`）、AI 提案（`:1432`/`:1445`）。**整条 AI 编辑链路是死的。**

### 测试已经在报警

```
FAIL src/model/drawio-xml-source.test.ts > allows cell-level semantic updates while preserving mxfile and model metadata
     expected false to be true
FAIL src/model/drawio-xml-source.test.ts > preserves opaque cells if a caller patches an XML source conservatively
     expected null not to be null
```

同文件里两个断言"拒绝"的用例是绿的，但**绿得没有意义**——它们验证的行为是"拒绝"，而实现无差别拒绝一切。这类测试应该改成"拒绝 A、接受 B"的对照断言。

### 最小修复

不要用正则切 XML。用 20 行扫描器：

```ts
function splitCells(inner: string): string[] {
  const cells: string[] = [];
  let i = 0;
  while (i < inner.length) {
    const start = inner.indexOf("<mxCell", i);
    if (start < 0) break;
    let j = start + 7;
    let quote = "";
    for (; j < inner.length; j++) {
      const ch = inner[j];
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === ">") break;
    }
    if (j >= inner.length) break;
    if (inner[j - 1] === "/") { cells.push(inner.slice(start, j + 1)); i = j + 1; continue; }
    const close = inner.indexOf("</mxCell>", j);
    if (close < 0) break;
    cells.push(inner.slice(start, close + 9));
    i = close + 9;
  }
  return cells;
}
```

它尊重引号（属性值里的 `>` 不会误判）、按 `>` 前一个字符判断自闭合、不依赖回溯。

**验收**：`canEditInStudio(toDrawioXml(createC4Fixture()), 同一串, doc) === true`。

⚠️ 修完之后语料的 `canEditInStudio` 仍然是 **0/615** —— 这是**正确**的，因为语料里没有 Studio 生成的文件。不要拿"语料仍是 0"当回归失败。真正的验收是 fixture 自往返。

---

## 3. P0-2　连线导入依赖 cell 顺序（本次精确测量）

**位置**：`v2/src/import/drawio.ts:292-293`

```ts
if (!previousNodes.has(source) && !nodes.some((node) => node.id === source)) continue;
```

`nodes` 是边循环里**正在累积**的数组。边排在端点之前 → 直接丢弃。

### 这次换了测法

上次是"模拟"；这次直接对照两次真实调用：一次正常，一次把全部顶点预置进 `previous`（消除顺序依赖）。差值就是顺序造成的损失。

```
正常导入        2,959 条关系
消除顺序依赖    7,436 条关系
恢复            4,477 条（334 个文件）
其中 169 个文件从「0 条关系」变成「有连线」
```

也就是说：**当前丢掉的 5,887 条边里，76% 是顺序问题**，不是真的解析不了。

### 仍然是最扎眼的证据

draw.io 自己的入门模板：

| 文件 | 顶点 | 边 | 实际导入 |
|---|---|---|---|
| `templates/basic/flowchart.xml` | 6 | 5 | **0** |
| `templates/basic/erd.xml` | 27 | 2 | **0** |
| `templates/basic/swimlanes.xml` | 12 | 8 | **0** |
| `templates/basic/orgchart.xml` | 5 | 3 | **0** |

`flowchart.xml` 的 cell 排列：

```
-  -  E  V  E  E  V  V  E  E  V  V  V
0  1  2  3  4  5  6  7  8  9  10 11 12
```

第一条边（index 2）在第一个顶点（index 3）之前。

### 最小修复

循环前先算顶点集合，别用累积数组：

```ts
const importedVertexIds = new Set(
  cells.filter((cell) => cell.getAttribute("vertex") === "1").map(cellId)
);
// 边分支
if (!previousNodes.has(source) && !importedVertexIds.has(source)) continue;
```

不要图省事用现成的 `currentCellIds`（`:219`）——它含边，会让"边连边"通过校验，导出时变成悬空 source。

**验收**：`flowchart.xml` 恢复 5 条边；语料关系总数 2,959 → 约 7,400。

---

## 4. P0-3　嵌套 cell 用父级相对坐标当绝对坐标

**位置**：`import/drawio.ts:262-268`

```ts
const x = Number(geometry.getAttribute("x") || 0);
const y = Number(geometry.getAttribute("y") || 0);
```

mxGraph 里子 cell 的 `mxGeometry` 是相对父级的。代码完全不累加父偏移。

**实测**：

```
templates/basic/erd.xml
  Orders @(450,120)
  ├─ 行 @(0,30)  ├─ 单元格 @(0,0)  ├─ 单元格 @(30,0)
  → 导入后全部落在 (0,~0)，27 个节点里 24 个堆在原点

examples/uml-class-example.drawio
  Person @(200,20)
  ├─ +name: str @(0,26)  ├─ +phoneNumber: str @(0,52)
  → 所有属性 x=0，竖着叠在左边缘

templates/basic/swimlanes.xml
  Pool @(120,120) → Lane @(20,0) → Task @(40,40)
  → 泳道和任务全在左上角
```

**语料规模**：10,761 个嵌套 cell，297 个文件（48%）。

**修复**：先建 `byId`，再累加祖先偏移：

```ts
function absoluteOrigin(cell, byId) {
  let x = 0, y = 0, cur = cell;
  while (cur && cur.parent !== "1" && cur.parent !== "0") {
    const p = byId.get(cur.parent);
    if (!p) break;
    x += p.x; y += p.y; cur = p;
  }
  return { x, y };
}
```

只做"视觉正确"就够了；要支持 ER 表/泳道/分组，还得给 `DiagramNode` 加 `parentId`，并把 `export/drawio.ts:29` 的硬编码 `parent="1"` 换成真实父级。

---

## 5. P0-4　空 `value` 的 cell 变成 `"New node"` 占位框

**位置**：`import/drawio.ts:274-275`

```ts
name: value || "New node",
```

ER 表的分隔行、UML 的分隔线、`edgeLabel` 锚点、`group` 容器——`value` 都是空的，全部变成有名字的可见节点。

```
节点总数        28,324
"New node"      14,504  (51.2%)
涉及文件        471 个
```

**修复**：结构性 cell 不进 `nodes`（XML 里照旧保留）：

```ts
const structural = /(?:^|;)(?:text|edgeLabel|group|swimlane)\b/.test(style)
  || /shape=partialRectangle/.test(style)
  || (!value && !old);
```

---

## 6. P1　这次新发现的问题

### P1-1　schema 算了 1,142 条 warning，没人消费

`validateDrawioXmlDocument()` 返回 `warnings`（最近三个提交还在往里加：缺 geometry、悬空边、`relative=1`、parent 缺失）。实测：

```
warning 总数      1,142
涉及文件           80 个
生产代码读取次数    0
```

全仓库只有测试和我的探针读 `.warnings`。`isDrawioXmlDocument()` 只取 `.success`，App 从不调用 `validateDrawioXmlDocument`。

这等于白算。建议至少在打开文件时把前 3 条塞进 `setLastAction`，或做一个"文件诊断"面板。

### P1-2　主题选择器被 P0-1 连带打死

`App.tsx:1068-1069`：

```ts
setUiTheme(nextTheme);
if (studioEditingSafe) replaceDocument({ ...document, renderTheme: nextTheme });
```

`studioEditingSafe` 恒 false → `document.renderTheme` 不变 → 同文件 `:527-528`：

```ts
} else if (document.renderTheme !== uiTheme) {
  setUiTheme(document.renderTheme);   // 弹回
}
```

用户选 "Midnight"，下一次渲染就被改回文档里的旧主题。**这个 bug 和"编辑"没有任何表面关系**，是 P0-1 最容易被漏掉的副作用。

### P1-3　Studio 布局设置不持久化

保存时服务端**忽略客户端 `document`**，用 `projectDocumentFromXml(drawioXml)` 从 XML 重新推导（`copilot-server.ts:910`）。而 `projectDocumentFromXml` 从 `FIXTURES.c4()` 起步（`:131-134`），`fromDrawioXml` 又直接沿用 `previous.layout`。

所以 `layout.profile / direction / routing / nodeSpacing / layerSpacing / boundaryPadding / externalSide / storageSide` 全部在保存后回到 fixture 默认值。用户选的 "Dagre · Layered"、"ELK · Radial" 下次打开就没了。

这些是纯 Studio 设置，XML 里没有承载位。要么写进 `<mxGraphModel>` 的自定义属性，要么写进 cell 0 的 `studioLayout=`，要么单独存一份 workspace 级设置。

### P1-4　多页文件静默丢页

`import/drawio.ts:162` 只取第一页。67 个多页文件、796 页里 **181 页被丢弃**，且没有任何提示（`warnings` 里其实有信息，但没人读，见 P1-1）。

### P1-5　形状语义丢失（未变）

```
domain   26,026  (91.9%)
service   2,018  ( 7.1%)
decision    204  ( 0.7%)
storage      76  ( 0.3%)
```

12,887 个带 `shape=` 的顶点（447 个文件，73%）全部落到 `domain`。`shape=table`、`swimlane`、`shape=umlLifeline`、`shape=actor`、`shape=cloud` 都没有映射。

后果不只是配色：`domain` 在 C4 布局里被排到第 3 列（`layout/elk.ts:10-16`），ER 图会被当容器图重排。

### P1-6　draw.io 原生时序图不被识别

`import/drawio.ts:337-340` 只认 Studio 自己的 `__lifelineEnd` / `__messageSourceAnchor` 标记。draw.io 原生时序图用 `shape=umlLifeline`，实测 `templates/basic/sequence.xml` 导入后 `kind` 仍是 `c4`，走 C4 布局。

---

## 7. P2　小问题

| 问题 | 位置 | 说明 |
|---|---|---|
| 非图形文件报 `Invalid input` | `drawio-xml-schema.ts:428` | zod union 把 3 个 `<mxlibrary>` + 1 个 `<templates>` 的原因折叠成一句 `Invalid input`；`fromDrawioXml` 在 `:199` 又把它吞成 `return previous` |
| 全页校验全或无 | `drawio-xml-schema.ts:430-440` | 任一页损坏 → 整份文件拒收。语料 0 例，但结构上存在 |
| 每页解码两次 | `:448` 再解一次做 inventory | 15 页文件实测 27ms，暂时无感，页数线性放大 |
| 20 MB 预分配 | `:391` `new Uint8Array(20MB+1)` | 每页一次；fflate 会返回实际长度，功能正确，只是分配浪费 |
| `document` 客户端字段已废弃 | `copilot-server.ts:910` | 保存只认 XML，客户端传的 `document` 被忽略；接口签名还留着，容易误用 |

---

## 8. 测试状态

```
Test Files  4 failed | 10 passed (14)
Tests       6 failed | 89 passed (95)
```

| 失败 | 是否本次引入 | 处理 |
|---|---|---|
| `drawio-xml-source.test.ts` ×2 | **是**（P0-1） | 必须修 |
| `layout.test.ts` sequence fragment 样式断言 | 是（导出改成 `fillColor=#EDF1F9;fillOpacity=0`，断言还写着 `fillColor=none`） | 改断言或改实现，二选一 |
| `workspace-files.test.ts` ×2 | 否（macOS `realpath` `/private/var` vs `/var`） | 用 `fs.realpath` 归一化 |
| `App.test.ts` `parseAIIntentPlan` | 否 | 补 `application` 解析 |

另外：`drawio-xml-source.test.ts` 里两个"拒绝"用例在 P0-1 下**恒绿**，属于假阳性，建议改成对照断言（同一文件里既断言接受 A，又断言拒绝 B）。

---

## 9. 建议的处理顺序

| 顺序 | 动作 | 改动量 | 验收 |
|---|---|---|---|
| 1 | 修 `parseRootSlice` 的 cell 切分 | ~30 行 | `canEditInStudio(xml, xml, doc) === true`；2 个红测试转绿；Studio 按钮可用；主题能切换 |
| 2 | 边端点改用预扫顶点集 | ~6 行 | `flowchart.xml` 5/5；语料 2,959 → ~7,400 |
| 3 | 嵌套 cell 累加父偏移 | ~20 行 | ER/UML/泳道元素不再堆原点 |
| 4 | 结构性 cell 不进 `nodes` | ~10 行 | `"New node"` 51.2% → <5% |
| 5 | 透出 schema warnings | 前端小改 | 打开文件能看到"仅显示第 1 页"等提示 |
| 6 | 布局设置持久化 | ~30 行 | 换 profile 后重开仍在 |
| 7 | `shape=` 映射表 | ~40 行 | `domain` 占比降到 60% 以下 |

第 1 项应该**单独一个提交**，它和图形覆盖度完全无关，是纯功能性回归，而且现有测试已经能证明它。

---

## 10. 复现

```bash
cd v2
npm install @xmldom/xmldom     # package.json 已声明，当前 node_modules 缺失
npx vitest run                 # 6 失败，其中 2 个是 P0-1

git clone --depth 1 -b dev https://github.com/jgraph/drawio-diagrams /tmp/dd
# 对每个文件跑：
#   fromDrawioXml(xml, empty)  → 关系数
#   toDrawioXml(doc)           → 投影
#   canEditInStudio(xml, proj, doc)   → 全 false
#   patchDrawioXml(xml, proj, doc)    → 全 null
```

---

## 11. 与历史报告的关系

- `DRAWIO-DIAGRAM-TYPE-READINESS-REPORT.md`（07:54）：**已完全过期**。它主张"双轨 / NativeDocument"，而 ADR-0006 明确否决了这个方案，并选择了"XML 唯一真相源 + 语义投影"。不要按它改。
- `DRAWIO-DIAGRAMS-CORPUS-COMPATIBILITY-REPORT.md`（08:30）：P0-2/3/4 仍然有效，P0-1 的影响面被低估了（当时只看到"强制切 Freeform"，没看到服务端门禁和主题选择器）。以本报告为准。


---

## 12. 2026-10-22 后续处置更新

本报告基于旧 HEAD `27040a7`，其中的测试计数和“当前编辑能力为 0”的结论只描述当时状态，**不能直接当成当前主分支的状态**。随后已将发现逐项对照当前代码并实施以下修改：

| 原报告发现 | 后续处置 |
|---|---|
| P0-1：`parseRootSlice()` 合并多个 cell | 已换成带引号状态的标签扫描；补最小自闭合 cell 测试，并增加旧版 Studio 默认 layer cell 的兼容迁移。 |
| P0-2：边依赖 XML 顺序 | 已拆分顶点与边的导入阶段，边使用完整顶点索引解析。 |
| P0-3：嵌套坐标错误 | 已累加祖先坐标，并在语义投影中记录 `parentId`，导出时恢复父级相对坐标。 |
| P0-4：空文本生成 `New node` | 无文本且没有既有语义的 cell 不再生成语义节点，原生 XML 内容仍保留。 |
| P1-1：schema warnings 未消费、多页静默丢弃 | 已在 workspace hydration、打开文件和工具栏导入时显示诊断并记录到 Agent traces；多页会明确提示“Studio 仅投影第一页”，完整 XML 仍作为唯一事实源保留。多页完整页选择器尚未实现，Studio 语义编辑仍应被安全门禁拒绝。 |
| P1-2：主题选择被弹回 | 已调整同步 effect，UI 主题单独变化时不再触发文档主题的反向同步。 |
| P1-3：布局配置保存后丢失 | Studio 的布局配置现在写入默认 layer cell（`mxCell id="1"`）的 `studioLayout*` style 元数据，并从同一 XML 读取；没有引入第二份持久化 source。对默认 layer cell 完全符合旧版 Studio 格式的文件提供有限迁移。 |
| P1-5：形状语义大面积落入 `domain` | 已补 actor/UML lifeline、cloud、table、database/cylinder、decision、document 等常见形状映射。映射是语义近似，不能替代原生 shape 的无损编辑。 |
| P1-6：原生时序图不识别 | 已识别原生 UML lifeline/actor 结构，并补测试。 |
| P2：形状库/模板索引错误信息不清楚 | 导入诊断会明确区分 `<mxlibrary>` 形状库和 `<templates>` 索引文件。 |
| 复审提到的测试问题 | 已修正 sequence fragment 的过期断言、macOS canonical realpath 断言；`parseAIIntentPlan()` 改为复用完整计划验证逻辑，避免丢弃直接应用回执。 |

新增了相关回归用例，但本次没有重新运行全量 Vitest 或 619 个 Draw.io 语料文件。因此，不能据此声称全量测试已通过，也不能声称新的语料映射率已经达到原报告提出的目标。剩余验证重点是实跑语料、检查 XML 往返保真度及验证多页文件的原生编辑链路。


---

## 13. 复审补充（2026-10-22，面向 LeanIX 的范围校准）

本次按 LeanIX 的实际消费约束重新审视本报告。**只投影第一页是预期行为，不是缺陷**；LeanIX 集成只消费第一页，因此不应把“没有 Studio 多页选择器”列为待修 P1，也不应仅因文件包含多页就生成兼容性 warning。校验结果仍保留 `pageCount`，供需要显示信息的调用方使用；真正的 schema warnings 仍正常报告。原生 XML 的单一事实源原则不变。

复审同时发现一项独立的导入状态错误：`fromDrawioXml()` 在当前 XML 没有 edge cell 时，会回退到 `previous.relations` 中端点仍存在的关系。这可能把上一份图的关系带进新导入的无边图。已修改为关系集合完全由当前 XML 投影，并移除“节点为空就返回 previous”的短路，使合法空页也能被导入为空文档。新增回归用例覆盖空页和第一页范围不再作为兼容性 warning。

其余已记录的 P0/P1 修复仍需要实际运行测试和 corpus probe 才能确认；本次源码复审不把“已增加测试”误报为“测试已通过”。当前没有重新运行全量测试或 619 文件语料。

## 14. 复审继续（2026-10-22）：边端点不得从旧文档补齐

继续检查导入阶段时发现，上一节的“关系完全来自当前 XML”修复仍不充分：边解析阶段允许端点存在于 `previous.nodes` 即通过校验，即使该节点已不在当前 XML 页面。这会生成引用缺失节点的关系，语义投影不再严格来自当前页面。

已将边端点条件收紧为：source 和 target 都必须存在于当前 XML 页面实际投影出的节点集合。新增回归测试：旧文档中的 source 节点不在新 XML 中，而新 XML 仍包含一条指向该旧节点的边时，该边必须被丢弃。

本次只完成源码和回归用例修改；尚未执行 Vitest 或语料探针，因此不声称该测试已运行通过。

## 15. 复审继续：当前 XML 的显式语义元数据优先

又发现一处旧状态污染：当当前 XML cell 的 ID 与上一份语义投影相同，导入器此前优先沿用 `previous.role` / `previous.visualRole`，即使 XML 已明确写入新的 `studioRole` 或 `studioVisualRole`。这会导致 Draw.io XML 中的显式语义变更被旧缓存覆盖。

已调整为：当前 XML 明确包含 Studio 语义标记时，以该标记为准；只有原生 cell 缺少这些标记时，才使用旧投影作为兼容性回退。新增同 ID 节点从 service 改为 storage/highlight 的回归用例。测试尚未实际执行。

## 16. 复审继续：切换导入文件时清除旧时序图分类

发现 `fromDrawioXml()` 会把 `previous.kind === "sequence"` 当作当前页面的时序图证据，并在非时序页面导入后继续保留旧的 `sequence` 数据。这是另一个跨文档状态泄漏。现在只依据当前 XML 页中的原生时序结构/Studio 时序标记识别 sequence；如果上一份投影是 sequence、当前页没有时序标记，则回退到 C4 分类并清除旧 sequence 数据。新增对应回归用例。尚未执行测试。
