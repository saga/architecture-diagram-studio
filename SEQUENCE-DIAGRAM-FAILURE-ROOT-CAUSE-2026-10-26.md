# 序列图 Copilot 编辑失败：根因确认报告

> 时间：2026-10-26 · HEAD：`17a1b2b` · 事件：`requestId e6d20ada`（05:55:37Z）
> 方法：`application-events.jsonl` 原始诊断（含被控制台脱敏的 `xmlLengthBefore/After`）+ Copilot session `events.jsonl` 里的完整脚本 + **实际落盘文件** `~/Downloads/drawio-diagrams-dev/examples/sequence-diagram-examples.drawio` + 对 `nativeEditIsReflectedInXml` 的可复现实验。
>
> 本报告**取代** `SEQUENCE-DIAGRAM-CUSTOMER-RESULTLIST-FAILURE-ANALYSIS-2026-10-26.md`。前一份报告受限于"没有完整脚本、没有 before/after XML、日志里 xmlLength 被脱敏"，只能给出三个候选触发条件；本报告拿到了全部三样东西，候选条件已收敛为**一个确定原因**，并纠正了前报告的两处事实判断（见 §7）。

---

## 一、结论

**1. 根因是确认器的硬编码，不是 Draw.io、不是脚本、也不是序列图。**

`native-edit-confirmation.ts:351-359` 对脚本类编辑只做一件事：要求导出的 XML **每一个页面**都含有 id 字面量为 `"0"` 和 `"1"` 的 cell。

```ts
if (documentOperations.length === 1 && documentOperations[0].path === "cell:execute-script") {
  return after.length > 0 && after.every((page) =>
    page.cells.some((cell) => cell.id === "0") && page.cells.some((cell) => cell.id === "1")
  );
}
```

而这份文档的**第 2 页**（`hbYBUEr95w08JzggDiKY`，"With loop"）的根/默认层 cell id 是**带页面前缀的**：

```
page i7KtP-Vs8fw_sYRqWalm  → root cells: 0, 1, XppZFFv2hi1EjOijFOD9-1
page hbYBUEr95w08JzggDiKY  → root cells: jC507fco_XKDHWjVbaC3-0, jC507fco_XKDHWjVbaC3-1, ...
```

`every()` 在第 2 页上失败 → 返回 `false` → `save-confirmation.unmatched` → 30 秒后超时 → 整个编辑被判失败。

**这不是偶发。** 在这份文档上，`run_drawio_script` 会**永久 100% 失败**，与脚本内容无关。A/B 实验（§3.2）证明：只留第 1 页就通过，只留第 2 页就失败。

**2. 编辑实际上已经生效并写入了磁盘 —— UI 的 "Nothing was applied" 是错的。**

| 证据 | 值 |
|---|---|
| `xmlLengthBefore` → `xmlLengthAfter` | 17836 → **18575**（+739 字节） |
| 磁盘文件大小 | **18575 字节**（与 export 完全一致） |
| 磁盘文件 mtime | 2026-10-26 **13:55**（= 05:55Z，失败当分钟） |
| 文件内容 | 含 `value="2: readResults()"` 和新增的 `perimeter=orthogonalPerimeter` 激活条 |
| 写盘事件 | `drawio.standalone.autosaved {xmlLength: 18575}` @ 05:55:**39**.176 |

也就是说：**用户被告知"什么都没应用"，而改动早已在画布上、并已落盘**。如果用户按提示重试一次，图上会出现**第二条** `readResults()`。

**3. 还有三个次生缺陷把这次故障从"一个布尔判断写错"放大成"完全无法自愈"。**

- `scriptResult` 永远是 `undefined`（wrapper 用 `new Function` 包了表达式，没有 `return`），agent 拿不到任何结构化后置条件；
- 日志里出现 `copilot.native-batch.step.rolled-back`，但**根本没有回滚**（`batchRolledBack: null`、`rollbackErrors: []`），事件名是 `success ? "applied" : "rolled-back"` 硬拼出来的；
- 30 秒里宿主其实**早就**拿到了带改动的权威 XML（`drawio.document.saved` 在请求 export **之前** 27ms 就到了），那 30 秒是纯等待。

---

## 二、完整时间线（UTC，逐事件）

| 时间 | 事件 | 关键字段 | 意义 |
|---|---|---|---|
| 05:53:15 | `drawio.runtime-inspection.completed` | `cellCount 25, vertex 17, edge 8, pageId i7KtP…` | agent 拿到实时快照 |
| 05:54:26 | `copilot.agent.request.started` | `promptCharacters 54` | 用户提出"Customer 直接读 ResultList" |
| 05:55:37.657 | `copilot.agent.response.validated` | `nativeEditCount 1, durationMs 71013` | 模型 71 秒后提交 1 个脚本动作 |
| 05:55:37.748 | `copilot.standalone.history.snapshot` | **`xmlLength 17836`** | 这就是后来的 `beforeXml` |
| 05:55:37.767 | `copilot.native-edits.dispatch` | 1 edit，`cell:execute-script` | 派发到 iframe |
| 05:55:37.784 | `drawio.selection.property.requested` | `path cell:batch` | 宿主建 pending（30s 计时器起点） |
| **05:55:37.866** | `autosave` 事件首次出现 | — | 脚本改完模型，draw.io 立刻 autosave |
| **05:55:37.867** | `drawio.document.saved` | **`xmlLength 18575`** | **带改动的 XML 已被接受为权威源**（早于 ack） |
| 05:55:37.870 | `studioPropertyEditResult` | `success: true`，`scriptResult {available:false, reason:"script_returned_undefined"}` | 脚本"成功"，但无业务结果 |
| 05:55:37.894 | `drawio.selection.property.save_requested` | `action export, format xml` | 宿主请求序列化确认 |
| 05:55:37.894 | `export` 事件 | `xmlLength 18575` | 导出返回，内容正确 |
| **05:55:37.894** | **`save-confirmation.unmatched`** | `durationMs 109`，`before 17836 → after 18575` | **确认器拒绝了一份正确的快照** |
| 05:55:39.176 | `drawio.standalone.autosaved` | **`xmlLength 18575`** | **文件已写入磁盘** |
| 05:56:07.892 | `save-confirmation.timeout` | `durationMs 30089` | 30 秒内没有"通过确认"的快照 |
| 05:56:07.935 | `copilot.native-batch.step.rolled-back` | `stepSuccess: true, rollbackConfirmed: null` | **伪造的回滚事件** |
| 05:56:07.938 | `copilot.native-edit.rejected` | `"did not serialize XML within 30 seconds"` | 文案错误：XML 早就序列化了 |
| 05:56:07.939 | `copilot.native-edits.failed` | `rolledBack: false` | 与上一行的 `rolled-back` 自相矛盾 |

---

## 三、根因定位与复现

### 3.1 触发条件

`nativeEditIsReflectedInXml` 对**直接脚本**走"宽松路径"，注释写得很清楚（`native-edit-confirmation.ts:323-328`）：脚本可以改任意结构，所以只要求"导出的文档结构仍然合法"。但"合法"被实现成了**字面量 id 检查**，而不是结构检查：

```ts
page.cells.some((cell) => cell.id === "0") && page.cells.some((cell) => cell.id === "1")
```

`"0"`/`"1"` 只是 draw.io 的**默认** id 分配方案。以下情况都不成立：

- 页面是"Duplicate page"复制出来的（draw.io 会给新页重新分配 id 前缀）；
- 文档由第三方工具/模板生成；
- 从别的文档粘贴整页。

本文件的第 2 页正是这种情况（`jC507fco_XKDHWjVbaC3-0/-1`）。

### 3.2 复现（对真实文件跑真实函数）

```bash
cd v2 && ./node_modules/.bin/tsx /tmp/probe.mts
```

```
full document (2 pages)                    => false
page 1 only                                => true
page 2 only (prefixed root ids)            => false
typed label op on page 1 (unchanged value) => true
select-only batch                          => true
script batch                               => false
```

四组对照说明三件事：

1. 失败**完全由第 2 页的 root cell id 决定**，与脚本、与序列图、与这次编辑的内容无关；
2. **同一份文档上，类型化操作（`label` / `style` / `geometry`）和纯选择批处理都正常**——所以用户之前的编辑一直是好的，只有脚本会挂；
3. 换成"只留第 1 页"立刻通过 → 修复点明确。

### 3.3 为什么是"永久"失败

ADR-0018 把 `run_drawio_script` 定为超出类型化词汇表时的**唯一**通道。在这份文档上，这条通道 100% 被确认器拒绝，而类型化操作又能用——于是 agent 会陷入"简单改动能成、稍复杂的改动永远失败"的割裂状态。用户看到的正是这个现象。

---

## 四、次生缺陷（把单点 bug 放大成不可自愈）

### 4.1 脚本返回值被 wrapper 吞掉

`plugins/studio-selection-plugin.js:1121`：

```js
var executeNativeScript = new Function("ui","editor","graph","model","inspectRuntime", '"use strict";\n' + script);
var scriptResult = executeNativeScript(...);
```

`new Function` 的函数体**只返回显式 `return`**。本次脚本是 `(function(){ … return {ok:true, created:{…}, lifeline:{…}, …}; })();` —— 一个**表达式语句**，所以 `scriptResult` 恒为 `undefined`，`serializeScriptResult` 记成 `{available:false, reason:"script_returned_undefined"}`（`:371-372`）。

后果：agent 精心返回的 `created.edge` / `created.activation` / 生命线几何 / 边折点全部丢失。agent 因此**没有任何证据**判断"到底改没改"，只能凭 UI 的失败文案猜。这也是前一份报告误判"脚本返回了 undefined"的直接原因——**脚本没返回 undefined，是 wrapper 把返回值扔了**。

### 4.2 "Nothing was applied" 是假话

确认循环里 `unmatched` 走 `continue`（`DrawioFrame.tsx:778-785`），**不丢弃这份 XML**。流程继续往下：

```ts
lastSent.current = data.xml;              // :826
onDocumentChangeRef.current(data.xml);    // :830  → App 状态 → standalone 自动保存
```

而在这之前，autosave 已经先一步把同一份 18575 的 XML 交给了宿主（`:37.867`）。于是：

- 画布：有改动；
- 内存权威 XML：有改动；
- 磁盘文件：有改动（`:39.176`）；
- 回执：`failed` + "Nothing was applied"。

**这是最危险的一条**：它诱导用户重试，而重试会重复插入消息。

### 4.3 `rolled-back` 是拼出来的

`App.tsx:1920`：

```ts
recordDiagnostic("copilot.native-batch.step." + (finalResult.success ? "applied" : "rolled-back"), …)
```

失败 ≠ 回滚。本次 `stepSuccess: true`、`batchRolledBack: null`、`rollbackErrors: []`，却照样写了一条 `rolled-back`。同一个 payload 里 `copilot.native-edits.failed` 又写 `rolledBack: false`——两条日志互相打脸。

### 4.4 30 秒是纯等待

宿主在 `:37.867` 就已经把 18575 接受为权威 XML，`:37.894` 又向 draw.io 要了一份同样的 XML。确认器拒绝后，它继续等一份"能通过确认"的快照——而在当前规则下**永远不会有**。用户体验上就是"卡 30 秒然后告诉我没成功"。

---

## 五、影响面

| 场景 | 是否受影响 |
|---|---|
| 单页文档的脚本编辑 | ✅ 正常（`id === "0"/"1"` 成立） |
| **多页文档中任一页使用非 `0`/`1` 根 id** | ❌ **该文档所有脚本编辑永久失败** |
| 类型化操作（label/style/geometry/attr） | ✅ 正常（按 cellId 定位，不受根 id 影响） |
| 选择类批处理 | ✅ 正常 |
| 自动布局 | ✅ 正常（走独立通道，不经过此分支） |
| 单页文档 + 复制页/第三方生成的页 | ❌ 同上 |

仓库里已有的测试**恰好把错误规则固化成了期望行为**：`native-edit-confirmation.test.ts:125-129` 用 `withoutDefaultLayer` 断言"缺少 `id="1"` 必须失败"。所以这条规则不会被现有测试发现，反而会被保护。

---

## 六、修复建议

### P0-1 · 把"字面量 id 检查"改成"结构检查 + 作用域限定"

确认器的语义应该是"**活动页**的导出文档结构仍然合法"，而不是"全文档每一页都有 `0`/`1`"：

```ts
if (documentOperations.length === 1 && documentOperations[0].path === "cell:execute-script") {
  // 脚本只能改活动页；不要用其他页面的 id 方案否决它。
  const scoped = input.pageId == null
    ? after
    : after.filter((page) => page.pageId === null || page.pageId === input.pageId);
  const pages = scoped.length ? scoped : after;
  return pages.length > 0 && pages.every((page) => {
    const rootless = page.cells.filter((cell) => !cell.cell.getAttribute("parent"));
    if (rootless.length !== 1) return false;
    const rootId = rootless[0].id;
    return page.cells.some((cell) => cell.cell.getAttribute("parent") === rootId);
  });
}
```

要点：
- **不假设 `"0"`/`"1"`**，用"恰好一个无 parent 的根 cell + 至少一个挂在它下面的层"这个真实结构约束（`drawio-xml-schema.ts` 的 `addCellInventoryWarnings` 已经在用同样的判定，可直接复用）；
- **只看活动页**（`input.pageId`），因为脚本的 `cellId === "__active_page__"` 就决定了它的作用域是单页；
- 顺带修掉 `findCell` 里同样的隐式假设带来的边界问题。

### P0-2 · 让脚本返回值真的能回来

```js
// 先按"表达式"求值（能拿到 IIFE / 字面量的返回值），语法不合法再退回"语句体"执行
var result;
try {
  result = new Function("ui","editor","graph","model","inspectRuntime",
    '"use strict";\nreturn (' + script + '\n);')(ui, ui.editor, activeGraph, activeModel, inspect);
} catch (error) {
  if (!(error instanceof SyntaxError)) throw error;
  result = new Function("ui","editor","graph","model","inspectRuntime",
    '"use strict";\n' + script)(ui, ui.editor, activeGraph, activeModel, inspect);
}
```

同时在 agent 契约里明确：脚本**必须**返回 `{ok, created:{…}, postconditions:{…}}`，宿主把它原样透传给 agent 和诊断。

### P0-3 · 区分"执行 / 序列化 / 验证 / 持久化"四种结果

现在的 `unmatched` 分支同时做了两件互斥的事：判定"没通过确认"，又把这份 XML 当成权威源保存。必须选一边：

- **方案 A（推荐）**：`unmatched` 时不拒绝、不丢弃，而是把结果标为 **`unverified`**，仍按权威 XML 保存，回执写"改动已应用，但未能按请求验证"；
- **方案 B**：`unmatched` 时真的不采用这份 XML（回滚到 `beforeXml`），但必须同时撤销画布上的改动，否则内存/磁盘/画布三者不一致。

无论哪种，都不要再输出 "Nothing was applied"；文案应区分 `not_applied` / `applied_unverified` / `applied_and_verified`。

### P1 · 去掉伪造事件

`App.tsx:1920` 的事件名改为按事实生成：`applied` / `failed` / `failed_after_partial_apply`，只有 `batchRolledBack === true` 才允许出现 `rolled-back`。

### P1 · 缩短失败路径

既然 autosave 已经把 XML 交上来了，脚本类编辑的确认可以直接用 **autosave/export 的 before≠after** 作为"已序列化"证据，把 export 往返降级为可选校验。本次故障的 30 秒等待就是可以省掉的。

### P1 · 回归测试（这是最便宜的一步）

用本次的真实文件做 fixture（可裁剪到 2 页、每页 2~3 个 cell），断言：

1. 第 2 页根 id 带前缀时，脚本批处理**必须**确认成功；
2. 活动页之外的页面缺 `0`/`1` **不得**影响确认；
3. 缺少根 cell / 缺少层的文档**必须**失败（保持现有安全语义）；
4. 脚本返回 `{ok:true,...}` 时 `scriptResult.available === true`；
5. `unmatched` 后若文档已落盘，回执状态不得为 `not_applied`。

现有 `native-edit-confirmation.test.ts:125-129` 的断言需要同步改写——它保护的是错误的规则。

---

## 七、对前一份报告的更正

| 前报告结论 | 实际情况 |
|---|---|
| "脚本正常返回了 JavaScript 的 `undefined`" | **错**。脚本返回了完整对象；是 `new Function` wrapper 丢了返回值（§4.1）。 |
| "无法确认本次 unmatched 的具体触发条件，有三个候选" | **已确认**：第 2 页根 id 前缀化导致 `every()` 失败（§3.2），另两个候选排除。 |
| "没有 before/after XML，无法确认是否已自动保存" | **已确认**：before 17836 / after 18575，`:39.176` 已写盘，文件大小与 export 完全一致（§2）。 |
| "不应把 UI 失败提示当作文件未变的证据" | **成立且更严重**：文件确实变了，提示确实是错的。 |

前报告对"确认器范围不当""文案不准""状态一致性风险"的定性判断都正确，本次只是把它们从推断变成了实证。

---

## 八、现场处置

1. **不要重试这次编辑。** `~/Downloads/drawio-diagrams-dev/examples/sequence-diagram-examples.drawio` 已经是 18575 字节、已含 `2: readResults()` 与激活条；重试会插入第二条。
2. 需要恢复的话，用 `copilot.standalone.history.snapshot`（17836，label 为本次编辑前）对应的快照回滚，而不是"再执行一次"。
3. 修完 P0-1 之前，这份文档上**只走类型化操作**，不要用 `run_drawio_script`。

---

## 九、证据索引

| 结论 | 证据 |
|---|---|
| 确认器硬编码 `0`/`1` | `v2/src/model/native-edit-confirmation.ts:351-359` |
| 规则被测试固化 | `v2/src/model/native-edit-confirmation.test.ts:103-130` |
| 第 2 页根 id 前缀化 | `sequence-diagram-examples.drawio`：`<diagram id="hbYBUEr95w08JzggDiKY">` → `jC507fco_XKDHWjVbaC3-0/-1` |
| before/after 长度 | `logs/application-events.jsonl` @05:55:37.894 `xmlLengthBefore 17836 / xmlLengthAfter 18575` |
| 改动已落盘 | 同文件 @05:55:39.176 `drawio.standalone.autosaved {xmlLength:18575}`；磁盘文件 18575 字节 @13:55 |
| 脚本完整内容 | `~/.architecture-diagram-studio/copilot/session-state/a8562d93…/events.jsonl`（`run_drawio_script.arguments.script`） |
| wrapper 丢返回值 | `v2/plugins/studio-selection-plugin.js:1121-1132`、`:371-372` |
| unmatched 仍保存 | `v2/src/components/DrawioFrame.tsx:778-785`、`:820-830` |
| 伪造 rolled-back | `v2/src/App.tsx:1919-1925` |
| 错误失败文案 | `v2/src/App.tsx:1916` |
| 复现脚本 | `/tmp/probe-confirm2.mts`（A/B 三组）、`/tmp/probe-confirm3.mts`（类型化 vs 脚本） |
