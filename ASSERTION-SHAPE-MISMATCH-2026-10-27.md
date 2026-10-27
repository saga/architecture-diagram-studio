# 「把所有 title 变成中文」被判失败分析：编辑完全正确并已落盘，但被自创的断言字段名否掉

- 日期：2026-10-27（UTC 23:19，本地 2026-10-28 07:19）
- Session：`8d2d10bb-be12-43ed-88d2-9601f7f801c5`
- 文档：Business Model Canvas（单页 `07fea595-8f29-1299-0266-81d95cde20df`，41 cells）
- 最终报错：`The document changed, but native script assertions were invalid or did not match the serialized XML. Assertion diagnostics: … Unknown assertion field.`

**结论：脚本执行成功，13 个标题全部改成中文并已写入磁盘（最终快照 rev `7d7ae46f` 里 `商业模式画布`/`重要伙伴`/`动态定价` 都在，`Business Model Canvas` 已消失）。但模型在 `xmlAssertions` 里自创了 3 个字段名（`chineseTitle` / `labelContainsTitle` / `bodyTailPreserved`），校验器把"字段名不认识"当成"证据全部作废"，于是 13 条断言整体丢弃、`applicationState` 变成 `changed-unverified`、修复通道同时关闭，界面告诉用户"不要重试"。一次完美且可自证的编辑，被一个 schema 措辞问题判成了失败。**

---

## 0. 现场处置

| 项 | 状态 |
|---|---|
| 图内容 | **已改变**（13 个 cell 的 label 全部变中文） |
| 磁盘文件 | **已写入** |
| History | 已新增快照，最后一条 `6f100aab…` rev `7d7ae46f` 就是中文版 |
| 用户任务 | **实际已完成**，但界面报告失败 |
| 是否可重试 | 不需要重试；重试反而会二次翻译 |

**用户可以直接去画布上确认，不需要重发请求。** 唯一需要清理的是"失败"这条错误信息本身。

---

## 1. 时间线（UTC）

| 时刻 | 事件 | 关键数据 |
|---|---|---|
| 23:18:32.296 | `Opened file` | rev `5ceeebc9…`，7424 B（原始压缩 mxfile） |
| 23:19:03.915 | 用户请求 | prompt 257 KB，41 cells |
| 23:19:11.261 | 第 1 轮模型调用 | 43,565 in-tokens，4 × `inspect_drawio_graph`（探 724/728/744/742） |
| 23:19:39.721 | **脚本 A** `run_drawio_script` | 2905 字符，13 条 label 替换 |
| 23:19:43.264 | Autosave | rev `cc1e6c96`，68023 B —— 展开后的**英文原版**（编辑前捕获） |
| 23:19:43.x | 脚本 A 抛错 | `Title translation aborted, nothing changed: …712:missing-cell \| …713:missing-cell \| …714:missing-cell`，`rollbackConfirmed: true` |
| 23:19:45.915 | **自动修正 1/1** | 129 KB 提示词，回传 `scriptRepair.failedScript` + 完整 stack |
| 23:19:51.970 | **脚本 B** `run_drawio_script` | id 已修正为裸 `712/713/714`；断言字段仍是自创的 |
| 23:19:55.022 | Autosave | rev `5ceeebc9`，7424 B（回到原始压缩版） |
| 23:19:55.250 | **`drawio.script.postcondition.xml-mismatch`** | `assertionFailureCount: 39`，`booleanPostconditionsPassed: true`，`serializedAssertionsPassed: false`，`undeclaredChangesPassed: null`，`applicationState: changed-unverified` |
| 23:19:55.505 | Autosave | rev `7d7ae46f`，68002 B —— **中文版落盘** |

---

## 2. 两次失败，是两个完全不同的原因

### 2.1 第一次：id 前缀被"脑补"出来（模型问题，但被正确拦住）

文档里的 id 是**混合格式**的：

```
26 个  m_W9VZdlHLpNL__oonzn-722 … -746   ← 主画布
 2 个  jZ84a95Wsy1RApubU1WM-722/723      ← 底部版权文字
13 个  709 … 721, 722                   ← 裸数字，含本次要改的 712/713/714
```

模型在 `diagram.cells` 里确实看到了 `"712": "Dynamic pricing …"`，但它按**多数派前缀**补全成了 `m_W9VZdlHLpNL__oonzn-712`，于是 `model.getCell()` 返回 `undefined` → `missing-cell`。

脚本里 `if (failures.length) throw` 的设计是对的：三个 id 错，整体不动，编辑器确认回滚。这一段**没有缺陷**。

> 提示词里已有"never reuse stale IDs"，但没有一句"id 是不透明字符串，不要拼接前缀"。41 个 id 里 26 个同前缀，这个补全几乎必然发生。

### 2.2 第二次：`xmlAssertions` 的字段名是自创的（系统问题，且是致命的）

脚本 B 修好了 id，改完 13 个 label，返回：

```js
return {
  ok: true,
  postconditions: {
    allTitlesReplaced: true,        // ← 全部 true，被正确识别
    bodyAndStylingPreserved: true,
    geometryUnchanged: true
  },
  xmlAssertions: pending.map(p => ({
    cellId: p.id,
    chineseTitle: p.zh,                                  // ← 非法字段
    labelContainsTitle: cur(p).indexOf(p.zh) >= 0,       // ← 非法字段
    bodyTailPreserved: …                                 // ← 非法字段
  }))
};
```

13 条 × 3 个非法字段 = **39 条诊断**，和日志 `assertionFailureCount: 39` 精确对上。

---

## 3. 校验器为什么"全盘否定"

`v2/src/model/native-edit-confirmation.ts:616`：

```ts
const allowedFields = new Set(["cellId","exists","kind","label","parentId","sourceId","targetId","style","geometry"]);
```

`:650-653`：

```ts
for (const key of Object.keys(assertion)) {
  if (!allowedFields.has(key)) {
    invalid(key, "Unknown assertion field.", [...allowedFields], key);
    shapeInvalid = true;
  }
}
```

`:749`：

```ts
if (shapeInvalid) return;   // ← 整条断言直接作废，后面的 label 比对根本不执行
```

也就是说：**`cellId` 是对的、`label` 证据本来也可以给，但多写一个键，这条断言连 `cellId` 一起被丢掉。** 13 条全中 → `validateNativeScriptResultAgainstXml` 返回 `ok: false` → `serializedAssertionsPassed = false`。

---

## 4. 连带被关掉的两件东西（比 §3 更严重）

### 4.1 最强证据被门控掉

`v2/src/components/DrawioFrame.tsx:990-994`：

```ts
const serializedAssertionsPassed = scriptChecksPassed && assertionValidation.ok;
const scriptScope = serializedAssertionsPassed
  ? findUndeclaredNativeScriptChanges(pending.beforeXml, data.xml, scriptResult, 20, pending.pageId)
  : null;
const undeclaredChangesPassed = scriptScope === null ? null : scriptScope.ok;
```

`findUndeclaredNativeScriptChanges` 是**编辑前后 XML 的差分比对**，跟模型写的断言语法毫无关系。它是这套体系里唯一不依赖模型自述的证据。但因为断言语法不合法，它被短路成 `null`（日志里 `undeclaredScopeAvailable: null`、`undeclaredChangesPassed: null` 就是这个）。

我用真实快照跑了一遍这个差分（`2a9ed56a` 英文版 vs `6f100aab` 中文版）：

| 指标 | 结果 |
|---|---|
| cells 数 | 43 → 43 |
| added / removed | **0 / 0** |
| 变更的 cell | **13 个**，且与脚本声明的 13 个 id **完全一致** |
| geometry 差异 | **0** |
| 根 `dx/dy` | 2333/1195 → 2333/1195（未平移） |

**如果这项检查跑了，它会是 `ok: true`，`applicationState` 就是 `applied-and-verified`。** 一个字段名拼错，把唯一能证明"编辑正确"的证据一起关掉了。

### 4.2 修复通道同时关闭

`v2/src/hooks/useCopilotIntent.ts:365-371`：

```ts
const shouldTryScriptRepair = Boolean(
  failedAction &&
  failedScriptOperation?.mode !== "read" &&
  hasActionableExecutionError &&
  execution.rolledBack &&
  execution.failureStage !== "persistence" &&
  execution.applicationState !== "changed-unverified" &&   // ← 这里
  execution.applicationState !== "unknown" &&
  …
);
```

`changed-unverified` 被明确排除（本意是"改动可能已落盘，别让模型乱重试"）。但对本次这种**"内容对、证据格式错"**的情况，等于判了死刑：不修复、不重试、也不告诉用户到底哪儿错了。

于是模型永远学不到"合法字段名是 `label`"，下一次同样的任务还会再自创一遍。本次两轮里它就已经换过一次名字（`tailPreserved` → `bodyTailPreserved`），说明这是**稳定复现的行为**，不是偶发。

---

## 5. 模型为什么会自创字段：schema 只说了"concrete evidence"

工具描述（`v2/server/copilot/intent-route.ts:905`）关于返回结构的全部说明是：

> Mutation scripts require ok=true, non-empty true postconditions, and xmlAssertions for every changed cell.

参数 `script` 的描述（`:906`）：

> return { ok:true, postconditions:{checkName:true}, xmlAssertions:[...] }; each assertion must contain **cellId and concrete evidence**. style must be a non-empty key/value object; geometry must contain at least one explicit field.

三个问题：

1. **`postconditions` 是自由命名的 `{name: true}` 映射，`xmlAssertions` 是固定 9 键的记录 —— 但两者在同一个返回对象里，措辞上没有任何区分。** 模型自然认为它们都是"断言"，只是粒度不同。
2. **合法字段名一个都没列**（`label`/`kind`/`parentId`/`sourceId`/`targetId`/`exists` 全无）。对 label 改写这种任务，唯一合法证据就是 `label: <完整最终值>`，而描述里从没出现过 `label` 这个词。
3. **断言只支持"等值"，不支持"谓词"。** 模型想表达的是「label 里包含中文标题」「正文尾部保留」这类**谓词**，系统只接受「label 等于这个完整字符串」。模型的意图没错——它想要宿主帮它验证谓词——但唯一的谓词入口 `postconditions` 是**在 iframe 内自评的**，不做 XML 交叉验证。于是它把谓词塞进了唯一声称"宿主会验证"的 `xmlAssertions`。

> 补充：合法的写法其实唾手可得——脚本里已经有 `cur(p)`，只要 `{ cellId: p.id, label: cur(p) }` 就能过（`findText` + `normalizeLabel` 会剥标签、归一空白，HTML label 也能匹配）。**模型不是做不到，是不知道字段名。**

---

## 6. 连"合法字段清单"都被抹掉了

`:651` 里 `expected` 传的是 `[...allowedFields]`（9 元素数组）。但：

- 客户端诊断序列化把嵌套值抹成字符串 → 日志里是 `"expected": "[nested value omitted]"`；
- 服务端 sanitizer（`intent-route.ts:1241-1250`）只保留 `kind / index / cellId / field / reason` 五个键，`expected` 和 `actual` **直接被丢弃**。

结果：模型和日志都只能看到 `Unknown assertion field.`，看不到"合法的是哪 9 个"。**唯一能让模型自我修正的信息，被两级脱敏各删了一半。**

另外用户看到的只是 `slice(0, 8)`，落库是 `slice(0, 25)`，实际 39 条 —— 剩下 14 条既不到界面也不到日志。

---

## 7. 修复建议

按性价比排序，均为分析结论，未改动代码。

### P0-1 未知字段不应作废整条断言

`native-edit-confirmation.ts:650-653`：把"未知键"降级为一条 `warn` 诊断，**继续用 `cellId` + 合法键做校验**；或至少把 `shapeInvalid` 的影响范围限制在"该键被忽略"，而不是 `:749` 的整条 `return`。

同时把 `NativeScriptXmlAssertionFailureKind` 增加一档 `invalid-shape`，与 `mismatch` 分开——**"证据格式不对"和"文档内容不符"是完全不同的两件事，现在被合并成同一个 `changed-unverified`。**

### P0-2 差分证据不应被断言语法门控

`DrawioFrame.tsx:991-994`：`findUndeclaredNativeScriptChanges` 改为**无条件执行**（它只需要 `beforeXml`/`xml`/`scriptResult.xmlAssertions` 里的 `cellId` 集合，后者即使字段非法也拿得到）。

判定改为：

- scope `ok` 且变更集 == 声明的 cellId 集合 → `applied-unverified-shape`（新状态），**允许修复**，错误信息改成"编辑已应用，证据格式不合规"；
- scope `ok` 但变更集超出声明 → 才是真正的 `changed-unverified`。

本次实测变更集 13 == 声明 13，会直接落到第一种。

### P0-3 放行"格式错"的修复重试

`useCopilotIntent.ts:370`：`applicationState !== "changed-unverified"` 保留，但对 P0-2 新增的 `applied-unverified-shape` 放行一次 repair。让模型在**能看到合法字段清单**（见 P1-2）的前提下重发一条只带 `{cellId, label}` 的断言即可。

### P1-1 把合法字段名写进工具描述

`intent-route.ts:906` 的 `script` 描述改成显式枚举，并给出 label 改写的最小可用样例：

```
xmlAssertions: [{ cellId, label }]   // label = 改写后的完整值（model.getValue(cell)）
合法键：cellId | exists | kind | label | parentId | sourceId | targetId | style | geometry
断言是等值断言，不是谓词；"包含/以…结尾"这类判断请放 postconditions。
```

### P1-2 合法字段清单写进 `reason` 字符串

把 `"Unknown assertion field."` 改成 `"Unknown assertion field 'chineseTitle'. Allowed: cellId, exists, kind, label, parentId, sourceId, targetId, style, geometry."`。`reason` 是**唯一**能穿过两级脱敏到达模型和日志的字段（`slice(0,400)`），数组型 `expected` 不能。

### P1-3 id 不可拼接

`editingGuidance` 补一句："Cell IDs are opaque strings; copy them verbatim from `diagram.cells` / `selectedCell` / inspection results — never add or remove an id prefix." 本次 26/41 个 id 带 `m_W9VZdlHLpNL__oonzn-` 前缀、15 个是裸数字，前缀补全几乎是必然失误。

### P2 诊断数量裁剪

`slice(0, 8)`（界面）/ `slice(0, 25)`（落库）在 39 条时丢掉一半。同类诊断应**按 `field` 去重后**再截断（本次 3 种字段 × 13 条，去重后 3 条就够说清问题），而不是按条目截断。

---

## 8. 附：本次证据在哪里

| 内容 | 位置 |
|---|---|
| 脚本 A / B 全文 | `~/.architecture-diagram-studio/copilot/session-state/8d2d10bb-…/events.jsonl` 事件 34 / 50 |
| 首次失败（missing-cell） | 同上，`scriptRepair.toolResult.error` + stack（`studio-selection-plugin.js:1255`） |
| 39 条断言诊断 | `~/.architecture-diagram-studio/logs/application-events.jsonl`，`drawio.script.postcondition.xml-mismatch` @ `2026-10-27T23:19:55.250Z` |
| 编辑前后 XML | `~/.architecture-diagram-studio/data/standalone-history/5f3441c1…/2a9ed56a….xml`（英文）→ `6f100aab….xml`（中文） |

---

## 9. 同类问题回顾

这已经是**第三次**因为"证据/意图的表达形式"而非"编辑内容"导致正确编辑被判失败：

| 报告 | 形式问题 | 结果 |
|---|---|---|
| `SEQUENCE-QIDONG-SCRIPT-FAILURE-2026-10-27.md` | `style` 传成样式字符串而非 key/value 对象 | 断言全 false |
| `WALNUT-TABLE-READONLY-SCRIPT-FAILURE-2026-10-27.md` | 只读脚本 + `postconditions` 树不完整 | `invalid-result` |
| **本次** | `xmlAssertions` 用了自创字段名 | 39 条 `invalid-assertion` |

共同点：**校验器只认唯一一种字面形状，出错时不告诉调用方正确形状，且失败即终局。** 修 P1-2（`reason` 里带形状说明）单这一条，就能把这三类事故的修复率从 0 提到接近 100%。

---

## 10. 修复实施记录（2026-10-28）

已按本报告的核心建议修改：

1. **增加标题谓词断言兼容性。** `validateNativeScriptResultAgainstXml` 现在支持 `labelContains`、`chineseTitle` 和 `labelContainsTitle`。标题文本会直接在序列化 XML 的实际 label 中校验；`labelContainsTitle` 会重新计算，不会直接信任脚本返回的布尔值。
2. **未知附加字段不再使整条断言失效。** 例如 `bodyTailPreserved` 会作为诊断 warning 记录并被忽略，不会覆盖 `chineseTitle` 的有效 XML 证据。未知字段本身不算证据；如果断言只有 `cellId` 和未知字段，仍然 fail-closed。
3. **差分范围审计与断言语法验证解耦。** `DrawioFrame.tsx` 在脚本后置条件通过后，总会运行 before/after XML scope audit，即使断言结构存在错误也一样。这样不会因为字段格式错误就丢弃独立的越界变更检查。scope audit 仍检查每个实际变化字段是否有对应证据，未声明或无证据的样式、几何等修改仍会被拒绝。
4. **减少重复诊断并改善模型指引。** 重复断言失败按 cell/field/kind 去重；无法识别的字段会提示实际支持字段。工具描述明确列出可验证字段、标题包含关系的写法，并强调 cell ID 是不透明字符串，不能擅自拼接前缀。
5. **新增回归测试。** 覆盖标题谓词与实际 XML 匹配、未知 metadata 不掩盖有效证据、纯未知字段不能充当证据、标题不匹配必须失败，以及同一目标 cell 发生未声明样式变化时仍 fail-closed。

此次修复旨在避免“标题已经成功修改，但断言中附带的自定义元数据触发错误报警”。它不会把未知字段当作验证依据：成功仍要求标题内容与序列化 XML 一致、脚本后置条件为真、before/after 的变更范围审计通过。

**验证说明：** 已增加针对性回归测试，但当前未执行 `npm test` / `npm run typecheck`；本轮没有可用的本地仓库 checkout，GitHub 提交状态接口也未返回可查看的 CI checks。因此代码已写入，但测试结果不应标记为通过。
