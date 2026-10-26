# 「启动」连线编辑失败分析：两次失败、两个独立原因

- 日期：2026-10-27
- 对象：`~/Downloads/drawio-diagrams-dev/diagrams/sequence.xml`（Page-1，pageId `0`，11 cells）
- 请求：在时序图下面加一条 a → b 的调用，label 为「启动」
- 结论：**图已经改对了，也已经存盘了。两次报错都不是编辑失败，是验证层的两个 bug。**

---

## 1. 一句话结论

| 轮次 | 报错 | 真实原因 | 图有没有变 |
|---|---|---|---|
| 第 1 次脚本 | `TypeError: E.getSource is not a function` | 脚本调用了 **mxGraph 里不存在的方法**。`mxCell` 只有 `getTerminal(true/false)`，没有 `getSource/getTarget` | 改了，但**回滚成功**（XML 3291 → 3291 字节，逐字节一致） |
| 自动修正脚本 | `script's declared native-cell assertions did not match the serialized XML` | 断言里 `style` 传了**整条 style 字符串**，而校验器要求的是**key/value 对象**。`typeof "..." !== "object"` → 直接 `false` | 改了，**且已保存**（3291 → 4009 字节，磁盘 4013 字节） |

所以用户看到的「自动修正未成功 / 回滚状态未知」是错的：**磁盘上就是改好的图，只有一条「启动」连线**。

---

## 2. 现场事实（可复核）

时间线（`~/.architecture-diagram-studio/logs/application-events.jsonl`）：

| 时间 (UTC) | 事件 | 关键字段 |
|---|---|---|
| 22:54:18.764 | `copilot.native-edits.dispatch` | `requestId: 4`, `pageId: "0"`, `xmlLengthBefore: 3291` |
| 22:54:18.865 | `drawio.script-failure-serialization.requested` | `"Batch rolled back after operation 1 failed: E.getSource is not a function"`, `rollbackConfirmed: true` |
| 22:54:18.866 | `drawio.script-failure.serialization.captured` | `xmlLengthBefore: 3291`, `xmlLengthAfter: 3291`, `nativeDiff.changed: false` |
| 22:54:55.705 | `drawio.document.saved` | `xmlLength: 4009` |
| 22:54:55.741 | `drawio.script.postcondition.xml-mismatch` | `booleanPostconditionsPassed: true`, `serializedAssertionsPassed: false`, `applicationState: "changed-unverified"` |
| 22:54:55.929 | `drawio.standalone.autosaved` | `xmlLength: 4009` |

磁盘侧：

```
sequence.xml  4013 bytes  mtime 2026-10-27 06:54
cells: 0,1,2,3,4,5,20,6,7,21,8,9,10,11,22   (15 个，其中 20/21 是新激活条，22 是「启动」边)
<mxCell id="22" edge="1" parent="1" source="20" target="21" ... value="启动">
```

**没有重复元素**：`启动` 只出现 1 次，`20/21/22` 各 1 个。第 1 次失败的回滚是真的回滚了，修正脚本是从干净状态重新画的。

---

## 3. 失败一：`getSource()` 这个 API 不存在

```
TypeError: E.getSource is not a function
  at eval (eval at editCell (.../studio-selection-plugin.js:850:132), <anonymous>:47:42)
```

第 47 行（函数体坐标，脚本坐标是第 44 行，因为插件在脚本前拼了 `"use strict";\nreturn (\n` 两行）是：

```js
edgeConnectsNewActivations: !!E && !!E.getSource() && !!E.getTarget() && ...
```

而 mxGraph 的 `mxCell` 根本没有 `getSource`：

```
public/drawio/mxgraph/src/model/mxCell.js:444   mxCell.prototype.getTerminal = function(source) {
public/drawio/mxgraph/src/model/mxCell.js        getSource 命中数 = 0
```

正确写法是 `E.getTerminal(true)` / `E.getTerminal(false)`。

**加重问题的两点：**

1. **它自己的 prompt 里就有答案。** 这次请求注入的 `runtimeInspection.capabilities` 明确列了：
   ```
   "edgeCell": ["getId", "getGeometry", "getStyle", "getValue", "getTerminal"]
   ```
   有 `getTerminal`、没有 `getSource`。模型还是照着 `getSource` 写了。
2. **这个脚本还有第二个 bug，只是没轮到它抛。** 同一个对象里最后一条：
   ```js
   totalCells: m.getChildCount(m.getRoot()) === 14
   ```
   `getChildCount(getRoot())` 返回的是**层数（1）**，不是 cell 总数。即使 `getSource` 写对了，下一行也会抛 `Failed: totalCells`。修正脚本改成了 `countNodes(m.getRoot()) === 15`（15 是对的），说明模型确实在拿"猜"的不变量做断言。

**性质**：这是 agent 侧的 API 幻觉，产品侧没有拦截，但因为抛在 `beginUpdate/endUpdate` 事务里，插件的回滚兜住了（`plugins/studio-selection-plugin.js:776`）。**这一轮没有数据损失。**

---

## 4. 失败二：`xmlAssertions[].style` 的类型契约与校验器不一致（本次真正卡死的地方）

### 4.1 代码事实

```ts
// src/model/native-edit-confirmation.ts:429
style?: Record<string, string | null>;      // ← 契约：key/value 映射

// src/model/native-edit-confirmation.ts:496-502
if (assertion.style !== undefined) {
  if (!assertion.style || typeof assertion.style !== "object" || Array.isArray(assertion.style)) return false;   // :497
  const style = record.cell.getAttribute("style") || "";
  for (const [key, expected] of Object.entries(assertion.style)) { ... }
}
```

修正脚本传的是 `style: styleOf(A)`，也就是 `"points=[];perimeter=orthogonalPerimeter;rounded=0;shadow=0;strokeWidth=1;"` —— **字符串**。`typeof "..." === "string"`，在 `:497` 直接 `return false`，**一个 key 都没比对**。

### 4.2 用真实文件跑真实函数（不是推测）

拿磁盘上那份 4009 字节的 XML + 脚本实际返回的断言列表，直接调 `nativeScriptResultMatchesXml`：

```
full list, style as string      => false      ← 当时的真实结果
--- 单条隔离 ---
only cell 20  (带 style)        => false
only cell 21  (带 style)        => false
only cell 22  (带 style)        => false
only cell 2   (无 style)        => true
only cell 6   (无 style)        => true
only cell 9   (无 style)        => true
only cell 8   (无 style)        => true
--- 只把 style 换成 key/value 对象 ---
full list, style as object      => true       ← 全部 7 条通过
--- 直接删掉 style ---
full list, no style             => true
```

**只有带 `style` 的 3 条失败，且把 style 改成对象后整份断言全通过。**

这意味着：
- `label: ""`（空值）匹配、`parentId`、`sourceId/targetId`、`geometry`（含 `x/y/width/height` 浮点比较）**全部正确**；
- 图的最终状态和脚本声明的**完全一致**；
- 唯一的错，是**证据的写法**，不是编辑的内容。

### 4.3 为什么这条错误能一路走到用户面前

四个环节同时缺位：

1. **契约文本只写了字段名，没写形状。**
   - `server/copilot/native-diagram-instructions.ts:2`：`xmlAssertions ... (cellId, exists, kind, label, parentId, sourceId, targetId, style, geometry as relevant)`
   - `docs/DRAWIO-AGENT-API-CONTRACT.md:38`：`... style key/value expectations and geometry coordinates/dimensions`

   "style key/value expectations" 这句话，读成"整条 style 字符串"完全说得通。**能正确写出对象形式的样例只存在于单元测试和 e2e 里**（`native-edit-confirmation.test.ts:172`、`e2e/02-canvas.spec.ts:663`），agent 看不到。

2. **校验器只有布尔返回值，没有诊断。**
   `nativeScriptResultMatchesXml` 全程 `return false`，不区分"断言形状非法"和"断言与文档矛盾"。上层 `DrawioFrame.tsx:899` 只能拼出一句
   > The document changed, but the script's declared native-cell assertions did not match the serialized XML.

   —— 而**没有任何一条断言"不匹配"**。这句话把修复方向指反了。

3. **自动修正因此是盲修。** 修正轮只拿到 `E.getSource is not a function`（那是第一轮的错误），它把两个真 bug 都修了，唯独不可能知道 `style` 的写法要改。预算只有 1 次（`copilot.native-script-repair.started` → `apply-failed`），一次不中就直接终止。

4. **`style: {}` 能白嫖通过。** 空对象没有任何 key 可比对，`for` 循环零次迭代 → 通过。也就是说这个字段既**容易被写错**，又**容易被写成空壳绕过**，两个方向都不安全。

### 4.4 次生问题：用户看到的文案有两处与事实相反

`src/hooks/useCopilotIntent.ts:344-346`：

```ts
"自动修正未成功：" + repairReason + (repairedExecution.rolledBack
  ? "（编辑器已确认回滚）"
  : "（回滚状态未知，请从 History 检查或恢复版本）")
```

- `repairedExecution.rolledBack` 为 `false`（因为 `changed-unverified` 不走回滚路径），于是落到"回滚状态未知"。**但实际是"已应用且已保存"**，日志里 `drawio.selection.property.save_confirmed` + `drawio.standalone.autosaved` 都有。
- 后果是真实的：用户按提示去 History 恢复，会**把刚改对的图退回去**。这和上一次 `Nothing was applied` 是同一类错误——回执文案与文档真实状态相反。

---

## 5. 影响面

| 场景 | 是否受影响 |
|---|---|
| 脚本返回 `xmlAssertions` 里带 `style`（且写成字符串） | **必然失败**，无论图改得多对 |
| 脚本断言不带 `style` | 不受影响（本次 cell 2/6/9/8 全部通过） |
| 脚本把 `style` 写成 `{key: value}` 对象 | 通过 |
| 脚本把 `style` 写成 `{}` | 通过（假通过） |
| 类型化操作（label/style/geometry 等） | 不受影响，走 `operationIsReflected` 另一条路径 |
| 上一次的 P0（写死根 id `"0"/"1"`） | **已不再触发**：`native-edit-confirmation.ts:343-352` 已改为结构判定；本次单页、根 `0`/层 `1`，`hasValidScriptScope` 正常通过 |

---

## 6. 修复方向（本次未改任何代码）

按收益/风险排序：

**P0-1｜校验器区分"形状非法"与"内容不匹配"**
把 `nativeScriptResultMatchesXml` 从 `boolean` 改成返回 `{ ok, failures: [{cellId, field, expected, actual, reason}] }`。形状非法直接标 `invalid-assertion`，不再伪装成 mismatch。这是让自动修正能收敛的唯一前提。

**P0-2｜契约把 `style` 的形状写死，并给一条正面样例**
`docs/DRAWIO-AGENT-API-CONTRACT.md:38` 和 `native-diagram-instructions.ts:2` 都补上：
```
style: { rounded: "0", endArrow: "block" }   // key → value；不要传整条 style 字符串
```
同时补一条：空对象 `{}` 不接受（否则等于没断言）。

**P0-3｜失败文案与文档真实状态对齐**
`changed-unverified` 时禁止输出"回滚状态未知"，应输出"已应用并已保存，未通过校验"，并**去掉"从 History 恢复"的引导**（那会毁掉正确的改动）。文案应该改成"从 History 查看并确认"。

**P1-1｜给 agent 一份 cell API 速查**
`mxCell` 的 `getTerminal(source)` / `isVertex()` / `isEdge()` 目前不在 API ownership 表里，只有 `capabilities.edgeCell` 的裸方法名（没有签名）。补一行签名，能直接消灭 `getSource` 这类幻觉。

**P1-2｜断言在脚本返回后立刻做形状预检**
在 `DrawioFrame.tsx:886` 之前先跑一次 `validateAssertionShape(scriptResult)`，形状非法就不必等 export、不必进入"文档已变"的模糊状态，直接回一个"证据格式错误，请按 {key:value} 重写"给修正轮。

**回归清单**
- `src/model/native-edit-confirmation.test.ts:164-200`：补 `style: "<字符串>"` → 应为 `invalid-assertion`（当前是 `false`，会把这个 bug 固化成期望行为）
- 补 `style: {}` → 应拒绝
- 补"单页 pageId `0` + 根 cell `0`/层 `1`"的用例（本次文件就是这个形状）
- e2e `05-copilot-native-edits.spec.ts:311` 的脚本样例目前不带 `style`，加一条带对象 style 的正例

---

## 7. 复现脚本

```bash
cd /Users/saga/code-repos/architecture-diagram-studio/v2
# 用磁盘上的真实文件 + 修正脚本真实返回的断言列表，直接调校验器
./node_modules/.bin/tsx /tmp/probe-xmlassert.mts
```

关键对照：`style` 为字符串 → `false`；同一个 payload 把 `style` 换成对象 → `true`。

---

## 8. 现场处置建议

1. **不要重试，也不要从 History 恢复。** 图已经是正确状态（15 cells，一条「启动」）。
2. 如果确实要再跑一次脚本，先把 `22/20/21` 删掉或改用新的 id，否则会出现重复 id。

---

## 9. 后续实现记录（2026-10-27）

本报告中的根因已落实为代码与契约调整；新增决策记录为 [ADR-0020: Native Script Assertion Contracts and Accurate Edit Outcomes](./docs/adr/0020-native-script-assertion-contract-and-outcome-reporting.md)。

### 已实施的代码调整

1. **断言验证从单一布尔值扩展为结构化诊断。** 新增 `validateNativeScriptResultAgainstXml()`，保留 `nativeScriptResultMatchesXml()` 作为兼容的布尔包装。失败记录包括断言序号、cell ID、字段、原因、预期值和实际值（可取得时）。
2. **验证器严格检查断言形状。** 拒绝把完整 style 字符串当作 `style` 断言，拒绝空 `style: {}` 和 `geometry: {}`，检查未知字段和错误类型，并对页面范围和 cell ID 歧义作显式判断。
3. **编辑器诊断包含具名失败项。** `DrawioFrame` 的 `drawio.script.postcondition.xml-mismatch` 事件现在记录验证失败详情，不再只有 `serializedAssertionsPassed: false`。
4. **修正模型可见的 API 契约。** 常驻指令、脚本工具描述和 `docs/DRAWIO-AGENT-API-CONTRACT.md` 明确规定 `getTerminal(true/false)`、递归计数要求，以及 style/geometry 断言的对象格式。
5. **修正自动修复失败的用户反馈。** `changed-unverified` 明确显示“文档已发生变化但未通过验证”，不会将它直接描述为“回滚状态未知”，也不再建议用户不加检查地恢复旧版本。
6. **增加回归测试。** 覆盖 style 字符串、空 style/geometry 断言、字段级起终点不匹配诊断，以及常驻指令中的 API 规则。

### 验证状态与剩余工作

本次通过仓库文件接口完成源码和文档提交，但当前执行环境没有可运行的本地仓库副本，因此**尚未实际运行 Vitest、TypeScript build 或 Playwright**。以上测试目前是新增的回归用例，不应误报为已通过。接下来仍需在项目运行环境执行 `npm test` / 对应 Vitest 测试与 `npm run build`，确认类型推断、断言诊断和脚本回执链路完整。

重要操作约束未改变：如果序列化结果为 `changed-unverified`，先检查当前画布、实际文件和 History，再决定如何修正；不要盲目重放插入操作。
