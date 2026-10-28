# 「把所有 Task 7 变成 AI agent 任务」分析：这次不是误报——5 处只改了 3 处，但系统把原因说错了

- 日期：2026-10-27（UTC 23:45，本地 2026-10-28 07:45）
- Request：`931bfc98-f524-4d59-a53e-30d4cf404f55` / Session `9ebf0da3-9d62-4ce0-abe3-0f44518e3c20`
- 文档：`Page-1`，88 cells，pageId `-oyLyDtoHZ17c1edxMD_`，rev `52e8674f…` → `66bb5169…`
- 报错：`The document changed, but native script assertions were invalid or did not match the serialized XML. Assertion diagnostics: [invalid-result] postconditions: The script did not return passing, verifiable postconditions.`

**结论：脚本真的漏改了 2 个 cell，`postconditions: false` 是正确的报警——但报错文案、以及模型那句"已将全部 5 处改名"，都指向了错误的原因。**

**三个独立缺陷叠在一起：**

1. `search_drawio_elements` 的**精确匹配短路**让模型只看到 3 个目标（实际 5 个）；
2. `model.getValue(cell)` 对 `<object>` 包装的 cell 返回 **DOM 元素**，`String(v)` 变成 `[object Element]`，脚本静默跳过那 2 个——而系统的 editing guidance **明确教模型这么写**；
3. 校验器在 `postconditions` 为 false 时**完全不跑 XML 断言**，把唯一能指出"63/66 没改"的证据丢掉，只留下一句"assertions were invalid or did not match"——而 assertions 根本没执行。

---

## 0. 现场处置

| 项 | 状态 |
|---|---|
| 5 个目标 cell | **3 个已改**（11 / 36 / 50），**2 个未改**（63 / 66） |
| 磁盘文件 | 已写入（rev `66bb5169`，44559 B） |
| History | 已新增 Autosave 快照 |
| 用户任务 | **未完成**，需要补改 2 处 |
| 界面报告 | 报"失败"，但没说哪两处 |

**这是真失败，不是误报。** 截图里能看到的 3 处（便签、list 容器 Done 行、表格 Done 行）确实改了；`%status%` 那两张卡片没改——它们不在截图裁剪范围内，所以"看起来没问题"。

---

## 1. 硬证据：改前 5 处，改后 3 处

解压 `Opened file` 快照（`f7b2e650…`，4884 B 压缩）后逐 cell 核对：

| cell id | 原始形态 | 包装 | 改前 label | 改后 |
|---|---|---|---|---|
| `…-11` | `mxCell value="Task 7"` | 无 | `Task 7` | ✅ `AI agent 任务` |
| `…-36` | `mxCell value="Task 7"` | 无 | `Task 7` | ✅ `AI agent 任务` |
| `…-50` | `mxCell value="<div>Task 7</div>"` | 无 | `<div>Task 7</div>` | ✅ `<div>AI agent 任务</div>` |
| `…-63` | **`<object label="…" placeholders="1">`** | **UserObject** | `Task 7<br …><span …>%status%</span>` | ❌ 未改 |
| `…-66` | **`<object label="…" placeholders="1">`** | **UserObject** | 同上 | ❌ 未改 |

原始 XML 里 `Task 7` 出现 **5 次**、`AI agent` **0 次**；保存后 `Task 7` **2 次**、`AI agent` **3 次**。

**分界线极其干净：3 个是 `mxCell.value` 字符串，2 个是 `<object>` 包装。**

---

## 2. 为什么脚本漏掉那 2 个：`model.getValue()` 对 UserObject 返回 DOM 元素

脚本核心：

```js
function renameAll(cell) {
  var n = model.getChildCount(cell);
  for (var i = 0; i < n; i++) {
    var c = model.getChildAt(cell, i);
    var v = model.getValue(c);
    if (v != null && String(v).indexOf('Task 7') >= 0) {   // ← 这里
      model.setValue(c, String(v).split('Task 7').join('AI agent 任务'));
      changed.push(c.getId());
    }
    renameAll(c);
  }
}
```

`mxGraphModel.getValue(cell)` 返回的是 `cell.value`。对普通 cell 它是 label 字符串；对 `<object>`/`<UserObject>` 包装的 cell，`cell.value` 是**那个 DOM 元素本身**。于是：

```
String(<object label="Task 7<br…">)  ===  "[object Element]"
"[object Element]".indexOf('Task 7')  ===  -1
```

`-1` → 条件不成立 → **不报错、不记录、静默跳过**。遍历是完整的（`getChildCount`/`getChildAt` 递归覆盖了全部 88 个 cell），只是这两个 cell 的"标签"读不出来。

### 2.1 这个写法是系统教的

`v2/server/copilot/intent-route.ts:1492` 的 `editingGuidance` 原文：

> Resolve edit targets by **comparing `model.getValue(cell)` with the requested label**, rejecting zero or ambiguous matches.

平台的指导语直接把错误 accessor 写成了标准做法。模型完全照做。

### 2.2 插件自己知道正确写法，但没教给模型

`v2/plugins/studio-selection-plugin.js:214-229` 的 `runtimeCellLabel()` 三种情况都处理了：

```js
if (activeGraph.convertValueToString) { … }        // ① 首选
if (typeof value === "string") return value;        // ② 普通 cell
if (value && value.nodeType === 1) {                // ③ UserObject
  var label = value.getAttribute("label"); …
}
```

宿主侧（selection publish、context 构建）用的就是它，所以 `diagram.cells` 里 63/66 的 label 是正确的 `Task 7 %status%`。**只有模型脚本这一侧被交给了裸 `model.getValue`。**

---

## 3. 为什么模型一开始只找到 3 个：search 精确匹配短路

`v2/server/copilot/intent-route.ts:694-700`：

```ts
const exactId    = cells.filter(cell => cell.id === query);
const exactLabel = cells.filter(cell => cell.name.trim().toLowerCase() === normalized);
const matches = exactId.length ? exactId
              : exactLabel.length ? exactLabel      // ← 有精确命中就完全不看子串
              : cells.filter(cell => { … index.includes(normalized) … });
```

查询 `"Task 7"` 时，11/36/50 的 label **恰好等于** `Task 7` → `exactLabel.length = 3` → 直接返回这 3 个，**跳过** `Task 7 %status%` 的 63/66。

返回体还是 `matchCount: 3, truncated: false` —— 明确告诉模型"一共就 3 个"。

模型的推理记录里写得很清楚：

> Search returns 3 matches for "Task 7". The %status% cells "Task 7 %status%" presumably also match… but search returned 3. **Odd.**

它因此多花了一轮去搜 `%status%`，才发现还有 63/66。**这轮往返是 search 语义造成的，不是模型乱试。**

---

## 4. 为什么错误信息让人困惑：三重短路

### 4.1 `postconditions` 一失败，XML 断言压根不跑

`v2/src/components/DrawioFrame.tsx:983-989`：

```ts
const scriptChecksPassed = hasVerifiedScriptPostconditions(scriptResult);
const assertionValidation = scriptChecksPassed
  ? validateNativeScriptResultAgainstXml(scriptResult, data.xml, pending.pageId)
  : { ok: false, failures: [{ kind:"invalid-result", field:"postconditions",
      reason: "The script did not return passing, verifiable postconditions." }] };
```

模型这次写了 5 条 `xmlAssertions`，其中：

```js
{ cellId: '…-63', label: 'AI agent 任务 %status%' },
{ cellId: '…-66', label: 'AI agent 任务 %status%' },
```

**这两条本来会精确报出 `mismatch: expected "AI agent 任务 %status%", actual "Task 7<br…>"`——即"这两个 cell 没改"。** 但因为 `scriptChecksPassed === false`，`validateNativeScriptResultAgainstXml` 一次都没被调用，这 5 条证据全部作废。

日志里 `assertionFailureCount: 1`、`uniqueAssertionFailureFields: ["postconditions"]` 就是这个：**只有一条 postconditions 失败，5 条断言一条都没校验。**

### 4.2 差分证据同样被 `postconditions` 门控

`DrawioFrame.tsx:991-995`：

```ts
// Scope comparison is independent evidence: run it even when assertion shape
// validation fails, so schema mistakes cannot hide undeclared document changes.
const scriptScope = scriptChecksPassed
  ? findUndeclaredNativeScriptChanges(…)
  : null;
```

注释写的是"断言形状失败也要跑"，但代码门控的是 `scriptChecksPassed`（postconditions），不是 `assertionValidation.ok`。上一轮修的只是"字段名非法"那一支，**postconditions 这一支仍然短路**。所以 `undeclaredChangesPassed: null`、`undeclaredScopeAvailable: null`。

### 4.3 文案与实际不符

`DrawioFrame.tsx:1058` 拼出来的句子是：

> The document changed, but **native script assertions were invalid or did not match** the serialized XML. Assertion diagnostics: [invalid-result] **postconditions**: The script did not return passing, verifiable postconditions.

实际情况是：**assertions 合法、也从未被校验**；唯一的问题是 postconditions 未通过。用户读到"assertions 有问题"，会去找断言写错了——而断言写得对，写错的是遍历逻辑。

### 4.4 三条 postcondition：一真两假，其中一条是假阳性

| postcondition | 值 | 判定 | 说明 |
|---|---|---|---|
| `renamedExactlyFiveExpectedCells` | **false** | ✅ 真阴性 | `changed.length === 3` ≠ 5，**正确报警** |
| `noTask7LabelRemains` | **true** | ❌ **假阳性** | `hasTask7()` 用了同一个坏 accessor，看不见 63/66，于是"没有残留" |
| `statusPlaceholderAndRichWrapperPreserved` | **false** | ✅ 真阴性 | `col63` 是 `"[object Element]"`，`indexOf('%status%') = -1` |

第二条最危险：一个叫 `noTask7LabelRemains` 的断言在还有 2 处残留时返回了 `true`。**用编辑同一套 accessor 写 postcondition，等于让 bug 自己给自己作证。**

---

## 5. 为什么模型说"已将全部 5 处改名"

模型最终消息：

> 已将全部 5 处 "Task 7" 改名为 "AI agent 任务"：… 两处带 `%status%` 占位符的卡片（占位符保留）

它点名的"两处 `%status%` 卡片"**正是唯一没改的两处**。

原因不是模型撒谎，是时序：

| 时刻 | 事件 |
|---|---|
| 23:45:50.976 | `turn.model-call.completed`（模型写完这句总结） |
| 23:45:50.978 | `turn.completed.with-native-edits` |
| 23:45:51.231 | 脚本才执行完，`xml-mismatch` |

`run_drawio_script` 是 **terminal action，在本轮结束后才执行**。模型必须在拿到结果之前给出最终答复，所以这段"成功"prose 只能是预测。工具返回里的 `instructions` 写着 "do not claim success before serialization and persistence are confirmed"——**但协议不允许它等**，这条指令在结构上无法遵守。

结果就是：界面同时出现"已将全部 5 处改名"和"changes may already be present, do not retry"，自相矛盾。

---

## 6. 修复建议

### P0-1 无条件跑 XML 断言，让错误指名到 cell

`DrawioFrame.tsx:984`：把 `validateNativeScriptResultAgainstXml` 改成**总是执行**，postconditions 失败只是追加一条 failure，不再替换整个校验结果。

收益：本次报错会变成

> cell `…-63` label mismatch: expected `AI agent 任务 %status%`, actual `Task 7<br…>`
> cell `…-66` label mismatch: 同上
> postconditions: `renamedExactlyFiveExpectedCells` was false (3 of 5)

——从"让人疑惑"变成"要补改哪两处，一眼可见"。这也顺带修掉 §4.2（`scriptScope` 的门控应改为 `assertionValidation` 无关地恒为真）。

### P0-2 修正 editingGuidance 的 label 读取方式

`intent-route.ts:1492` 把

> Resolve edit targets by comparing `model.getValue(cell)` with the requested label

改成：

> Resolve edit targets with `graph.convertValueToString(cell)`. `model.getValue(cell)` returns a **DOM element** for `<object>`/`<UserObject>`-wrapped cells (cells with custom properties), so `String(model.getValue(cell))` is `"[object Element]"` and silently never matches. When iterating, guard with `typeof v === "string"` and fall back to `v.getAttribute("label")`.

这是**唯一能真正修掉本次 bug** 的改动。P0-1 只让错误信息变准，不会让脚本变对。

### P0-3 postcondition 必须用独立读取路径

在 guidance 里加一条硬约束：**postcondition 不得复用编辑时的 accessor**——要么用 `graph.convertValueToString`，要么用 `model.getValue(cell)` 的三种分支封装。否则 `noTask7LabelRemains` 这类"自证式"断言会产生假阳性（本次已发生）。

### P1-1 search 不应让精确匹配吃掉子串匹配

`intent-route.ts:696-700`：把 `exactLabel` 作为**排序优先**而不是**结果过滤**——精确命中的排前面，子串命中继续追加，`matchCount` 报真实总数。

本次 `matchCount: 3` 直接导致模型第一轮少算 2 个目标；`truncated: false` 还额外给了"结果完整"的错误保证。

### P1-2 报错文案按失败来源分支

`DrawioFrame.tsx:1058` 现在三种失败共用一句话。应拆成：

- postconditions 失败 → `The script's own postconditions failed: <names>.`
- 断言不匹配 → `Serialized XML did not match N assertions: <cellId list>.`
- 断言形状非法 → `Assertion shape invalid: <field>.`

### P1-3 terminal action 的"成功"prose 应被拦截或标注

模型在结果出来前就写"已完成"。两个选项：

- 客户端在 `changed-unverified` / `failed` 时**丢弃模型那句成功 prose**，只显示编辑器结论；
- 或把模型最终消息降级为"拟执行"，实际结果出来后由宿主追加一条状态行。

现在用户同时看到两句话，无法判断该信哪句。

### P2-1 `%status%` 这类占位符 cell 值得单独提示

`placeholders="1"` 的 cell 在 draw.io 里 label 是 HTML + 占位符混排，字符串替换容易只改一半。guidance 可加一句：label 含 `%…%` 或 `html=1` 时，先 `convertValueToString` 看真实值再决定替换策略。

---

## 7. 与上一份报告的关系

`ASSERTION-SHAPE-MISMATCH-2026-10-27.md` 里提的"未知断言字段"问题**已经修好了**：本次 `unknownAssertionWarningCount: 0`，`allowedFields` 已扩到 12 个（含 `labelContains`），`uniqueAssertionFailureFields` 去重也上了。

但同一类结构性缺陷（**一条证据失败 → 其他证据全部不跑 → 报错只说"失败"不说"哪里"**）只是从断言侧转移到了 postconditions 侧。§4.1 和 §4.2 是同一个模式在另一个分支上的复现。

---

## 8. 证据位置

| 内容 | 位置 |
|---|---|
| 脚本全文 + 模型推理 | `~/.architecture-diagram-studio/copilot/session-state/9ebf0da3-…/events.jsonl` 事件 26 / 25 |
| 两次 search 结果 | 同上，事件 11 / 21 |
| 模型最终答复 | 同上，事件 35 |
| `xml-mismatch` 诊断 | `~/.architecture-diagram-studio/logs/application-events.jsonl` @ `2026-10-27T23:45:51.231Z` |
| 改前 XML（压缩） | `~/.architecture-diagram-studio/data/standalone-history/8aaa6472…/f7b2e650….xml` |
| 改后 XML | 同目录 `36e327b4….xml`（`Task 7` ×2，`AI agent 任务` ×3） |


---

## 9. 修复实施记录（2026-10-28）

已在 `main` 直接修复本报告中的根因：

1. **元素搜索不再漏掉部分匹配。** `search_drawio_elements("Task 7")` 现在返回所有 ID/标签文本匹配项，把完整标签的精确命中排在前面，但不会因此排除 `Task 7 %status%` 这样的富标签。新增回归覆盖 3 个精确命中 + 2 个 UserObject 子串命中。
2. **统一 UserObject 标签读取/修改契约。** 常驻指令、脚本工具描述和 `docs/DRAWIO-AGENT-API-CONTRACT.md` 不再教模型把 `model.getValue(cell)` 直接转成字符串。显示标签通过 `graph.convertValueToString(cell)` 读取；修改包装值时克隆 DOM 元素，只改 `label` 属性，再交给 `model.setValue`，避免丢弃占位符或自定义属性。后置条件必须独立重新扫描标签，不能复用 mutation 的 changed-count。
3. **后置条件失败不再遮住序列化 XML 证据。** `DrawioFrame.tsx` 无条件运行 `validateNativeScriptResultAgainstXml` 和 before/after scope audit。失败结果现在可同时包含 postcondition 名称、XML 不匹配的 cell ID/字段和未声明变更，而不是只给出泛化的 assertions 错误。
4. **补充回归测试并更新契约文档。** 覆盖精确+子串搜索合并、postconditions 失败时仍检查 XML、UserObject 包装标签的序列化验证；更新 ADR-0020 与 API 合约文档。

本轮已提交的主要代码提交：`91b238cabd773bf32b3d445332d1d1639255507a`（搜索完整性）、`d5f64da3806b263efea23fea8caf9b2b15c4b603`（独立验证与诊断）、`fed40fbf571c6d1eb7e65b83fecbb8573fff78a4`（验证回归测试）、`0362b3c25f1cc39fb3fdb9c22a25ed800b719c9f`（恢复常驻提示词契约并保留 2800 字符上下文预算）。

验证记录：首次质量任务执行了 409 个测试，其中 406 个通过、3 个失败；失败项是压缩常驻提示词时移除了旧测试要求的契约短语，并非新搜索/XML 回归测试失败。恢复这些契约短语后，[V2 CI run 40606566296](https://github.com/saga/architecture-diagram-studio/actions/runs/40606566296) 的 `Type check`、`Test native XML, cell operations and persistence` 和 `Build app with verified local Draw.io bundle` 均已成功。该 run 的 `e2e-native-canvas` 在本记录更新时仍处于运行中；因此确认类型检查、质量测试和构建已通过，但不声称 E2E 已通过。


### Follow-up：断言字段命名与富标签保护（2026-10-28）

后续全仓检查还发现一个同类契约隐患：`chineseTitle` 并非 Draw.io 原生属性，而是 Studio 校验器自定义的断言键；命名容易让模型误以为它是原生 XML 属性或只能处理中文。当前运行时类型、验证器、工具描述、常驻提示词和 ADR 已统一改用 **`expectedTitle`**，并明确 `xmlAssertions` 的键属于 Studio 的验证契约，而不是 Draw.io 属性。进一步检查后移除了冗余的 `labelContainsTitle` 布尔字段：宿主直接用 `expectedTitle` 对序列化标签做子串校验，不需要模型再重复报告一个布尔值。

同时发现 typed `set_label` 对包含嵌套 HTML 格式、换行或占位符的标签可能把内部结构压成纯文本。插件现在对此类 plain-text 全量替换 fail closed，明确提示使用原生脚本做保留 markup 的局部更新；新增测试确认失败时原始标签和 `placeholders` 属性不变。普通的简单 HTML 外层包装标签仍可正常更新。

另外，普通元素搜索的默认返回上限从 5 提高到 10；当返回结果被截断时，工具明确禁止把子集当作“全部目标”，并引导通过 `inspect_drawio_graph` 按同一页和同一 `documentRevision` 分页，直到 `truncated:false`。另一个同类缺陷是精确 ID 命中会直接覆盖其余子串匹配；现在精确 ID 只提升排序，不会压掉其他含该查询文本的 cell。新增测试覆盖 12 个同名目标的截断、完整枚举，以及 `task-1` 不吞掉 `task-10` / `task-11`。

补充修改已提交到 `main`；类型契约现在覆盖运行时支持的 `expectedTitle` 和完整几何断言字段。相关回归测试已增加，但本轮最终提交对应的 CI 尚未完成，不据此声称这些新增测试已经通过。


### Follow-up：curated shape catalogue 的静默截断（2026-10-28）

同类完整性问题也出现在 `search_drawio_shapes`：catalogue 搜索原先仅返回 limit 条，未告知总命中数或 `truncated`。模型容易把宽泛 query 的前几项当作完整候选集。现在底层新增 `searchDrawioShapeCatalogDetailed`，保留兼容的数组 API，同时返回 `matchCount`、`returnedCount`、`truncated`；Copilot 工具把这些字段显式传给模型，截断时指导缩小 query 或改用 live Draw.io 发现流程。C4 directory 的四个 bundle recipe 明确要求完整返回，并有测试验证 `truncated:false`。