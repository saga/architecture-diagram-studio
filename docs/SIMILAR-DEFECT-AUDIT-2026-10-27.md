# 同类缺陷全量审计：还有哪些"验证层"错误需要修

- 日期：2026-10-27
- 起因：`启动` 连线编辑失败（脚本已改对并落盘，却被判为失败）
- 范围：`v2/src`、`v2/server`、`v2/plugins`、`docs/`、运行日志（3 天）、单测、56 个 drawio 样例语料
- 结论：**找到 9 处同类缺陷，其中 3 处 P0。根因不是某个 bug，而是"验证契约"没有单一真源。**

---

## 0. 一句话总结

同一份"脚本必须返回什么"的约定，在代码里存在 **4 个互不一致的版本**（工具 schema / 系统提示 / 参考文档 / 校验器）。模型按其中任一个写，都可能被另一个判死。而校验器只回一个布尔值，所以判死之后连"为什么"都拿不到——**自动修正永远修不中**。

---

## 1. 运行记录的硬数据（这是最刺眼的部分）

保留的日志里，`run_drawio_script` 总共被调用 **3 次**（`copilot-sessions.jsonl*` 中 `tool.run_drawio_script.accepted`），**3 次全部被判失败**：

| 时间 (UTC) | requestId | 报错 | 图实际状态 | 真实原因 | 现在是否已修 |
|---|---|---|---|---|---|
| 10-26 05:55 | 1 | `did not serialize XML within 30 seconds` / "Nothing was applied" | **已改并已保存**（18575 字节，含 `readResults()`） | 确认器写死根 cell id `"0"/"1"` | ✅ 已修（改为结构判定 `:343-352`） |
| 10-26 22:54:18 | 4 | `E.getSource is not a function` | 已回滚（3291 → 3291） | 模型调用了不存在的 mxCell 方法 | ❌ 未修（能力清单无签名） |
| 10-26 22:54:55 | 5 | `assertions did not match the serialized XML` | **已改并已保存**（4009 字节，含「启动」） | `xmlAssertions[].style` 传了字符串 | ❌ 未修 |

**3 次调用 / 0 次验证通过 / 2 次误报（文档其实是对的）。** 误报率 66%。

同一窗口内**类型化操作（typed ops）被调用 0 次**——也就是说，目前唯一在用的路径，是唯一 100% 失败的路径。

---

## 2. 发现清单

| # | 严重度 | 问题 | 证据 | 已验证方式 |
|---|---|---|---|---|
| A | **P0** | 脚本返回契约有 4 个版本，互不一致 | `intent-route.ts:556`、`native-diagram-instructions.ts:2`、`DRAWIO-AGENT-API-CONTRACT.md:38`、`native-edit-confirmation.ts:429/497` | 代码对照 |
| B | **P0** | 校验器只回布尔、无诊断 → 自动修正无法收敛 | `native-edit-confirmation.ts:470-533`、`useCopilotIntent.ts:293-298` | 事故复现 |
| C | **P0** | 断言强度无下限：写弱必过、写强易挂 | 实测（见 3.3） | 跑真实函数 |
| D | P1 | `changed-unverified` 是死路，且文案指错方向 | `useCopilotIntent.ts:246-258, 344-346` | 事故 + 代码 |
| E | P1 | 30 秒超时把"内容没变"误报成"没序列化" | `DrawioFrame.tsx:825-862, 899` | 事故日志 |
| F | P2 | `cell:select` 要求整份模型字节不变，含视口 `dx/dy` | `native-edit-confirmation.ts:407`、`Editor.js:1592-1596` | 代码推演（**待复现**） |
| G | P2 | palette / layout 宿主侧只验"是不是合法 XML" | `App.tsx:682, 1375` | 代码对照 |
| H | P2 | 错误分类依赖正则匹配人类可读文本 | `intent-route.ts:165-182` | 代码对照 |
| I | P2 | `isDrawioXmlDocument` 重复实现两份 | `drawio-xml-source.ts:39`、`drawio-xml-schema.ts:556` | 代码对照 |

---

## 3. P0 详解

### 3.1 A｜同一契约的四个版本

| 位置 | 它说脚本要返回什么 |
|---|---|
| `intent-route.ts:556`（**工具参数说明，模型每次都读**） | `{ ok: true, postconditions: { checkName: true, ... }, ... }` —— **完全没提 `xmlAssertions`** |
| `native-diagram-instructions.ts:2`（系统提示） | 要求 `xmlAssertions`，列了字段名 `(cellId, exists, kind, label, parentId, sourceId, targetId, style, geometry)` —— **没写 `style` 的形状** |
| `DRAWIO-AGENT-API-CONTRACT.md:38`（参考文档） | "`style` key/value expectations" —— 歧义，读成"整条 style 字符串"完全成立 |
| `native-edit-confirmation.ts:429/497`（**唯一有执行权的**） | `style?: Record<string, string \| null>`；`typeof !== "object"` → `false` |

**最讽刺的是第一行**：工具 schema 是模型每次调用都会读的、最权威的一处，却**连 `xmlAssertions` 都不要求**。模型按 schema 写 `{ok, postconditions}`，宿主却因为"没有 `xmlAssertions`"直接拒绝（`native-edit-confirmation.ts:448`）。

> 这不只是文档问题：`xmlAssertions` 是**必需的**（非空数组，否则 `return false`），但它从未进入任何结构化 schema，只活在自然语言里。

### 3.2 B｜布尔校验器让修复循环必然失败

```ts
// native-edit-confirmation.ts:470-533
for (const raw of value.xmlAssertions) {
  ...
  if (!assertion.style || typeof assertion.style !== "object" ...) return false;   // :497
  ...
}
return true;
} catch { return false; }   // :531-533  连解析异常也变成同一个 false
```

三种完全不同的情况共享一个返回值：

1. 断言**形状非法**（本次事故）
2. 断言与文档**内容矛盾**（真正的 mismatch）
3. 文档**解析失败**（异常）

上层只能输出一句话（`DrawioFrame.tsx:899`）：

> "The document changed, but the script's declared native-cell assertions did not match the serialized XML."

而自动修正拿到的只有（`useCopilotIntent.ts:293-298`）：

```ts
scriptRepair: { originalRequest, failedScript, error, stack }
```

**没有断言级信息，预算只有 1 次**（`:246-258`）。所以修正轮只能瞎猜。本次事故就是活证据：修正脚本把两个真 bug 都修了（`getSource` → `getTerminal`、`getChildCount(root)===14` → `countNodes===15`），唯独不可能猜到 `style` 要改写法。

### 3.3 C｜断言强度反向激励（实测）

用磁盘上那份真实 XML（4009 字节）跑真实函数：

```
true    只声明 cellId + exists（最弱）
true    只声明 exists:true 指向一个无关 cell（cellId:"2"）
true    只声明 kind
true    空 style 对象 {}
false   style 写成字符串            ← 本次事故
false   style 全对但 label 写错
```

含义很直接：

- **写一个无关 cell 的 `{exists:true}` 就能通过全部校验**；
- **越诚实地把 style 写全，越容易被判失败**（只要类型写错）；
- `style: {}` 是零成本白嫖。

也就是说，这套机制既**拦不住偷懒**，又**惩罚认真**。而模型并不知道边界在哪——因为边界只存在于一个 `typeof` 判断里。

---

## 4. P1 详解

### 4.1 D｜`changed-unverified` 是死路，且文案会害人

```ts
// useCopilotIntent.ts:246-258
const shouldTryScriptRepair = Boolean(
  failedScriptOperation && scriptRuntimeError && execution.rolledBack && ...
);
```

`changed-unverified` 时 `scriptRuntimeError` 为假、`rolledBack` 为假 → **不会进入修复**。这是对的（不能盲目重跑），但结果是没有出路：

- 没有"重新验证一次"的通道（其实 XML 已经在手上，只需要重跑一次断言）；
- 文案还指错方向（`:344-346`）：
  ```ts
  "自动修正未成功：" + repairReason + (repairedExecution.rolledBack
    ? "（编辑器已确认回滚）"
    : "（回滚状态未知，请从 History 检查或恢复版本）")
  ```
  这里**忽略了已经拿到的 `applicationState`**（同一个对象在 `:393` 就在用）。实际是 `changed-unverified` = 已应用 + 已保存，用户照提示去 History 恢复，会**把改对的图退回去**。

> 这一类错误已经是第二次出现了：上一份报告里是 "Nothing was applied"，这次是"回滚状态未知"。共同点：**文案从 `rolledBack` 这一个布尔推出来，而真实状态是四态的**（`applied-and-verified` / `changed-unverified` / `not-applied` / `unknown`）。

### 4.2 E｜30 秒超时的语义是错的

`DrawioFrame.tsx:825-862`：断言不通过 → 记 `unmatched` → 对非脚本操作 `continue`，继续等下一份 export；等不到就 30 秒超时，报

> "Draw.io acknowledged the native edit but did not serialize XML within 30 seconds."

但 05:55 那次事故里，XML 在请求 export 后 **27ms** 就回来了、而且被当作权威快照接受了（`xmlLengthAfter: 18575`），只是没过断言。**"没序列化"和"序列化了但内容没变"是两件事**，前者是编辑器故障，后者是断言失败，处置方式完全不同（重连 vs 检查断言）。

---

## 5. P2 详解

### 5.1 F｜`cell:select` 的确认规则包含视口位移（待复现）

```ts
// native-edit-confirmation.ts:405-408
const documentOperations = operations.filter((op) => op.path !== "cell:select");
if (documentOperations.length === 0) {
  return semanticDiagramSignature(beforeXml, pageId) === semanticDiagramSignature(xml, pageId);
}
```

`semanticDiagramSignature`（`:77-99`）比较整棵 `<mxGraphModel>` 的**全部属性**。而 draw.io 序列化时会写：

```js
// Editor.js:1592-1596
else if (this.graph.view.translate.x != 0 || this.graph.view.translate.y != 0) {
  node.setAttribute('dx', Math.round(this.graph.view.translate.x * 100) / 100);
  node.setAttribute('dy', Math.round(this.graph.view.translate.y * 100) / 100);
}
```

而 `cell:select` 的插件实现里有 `scrollCellToVisible`（`studio-selection-plugin.js`）。**只要目标 cell 在视口外被滚动进来，`dx/dy` 就变了 → 签名不等 → 纯选择操作被判"未生效"。**

日志里 `cell:select` 出现 **0 次**，所以这是潜在缺陷而非已发生故障。需要一次手工复现确认（选中一个屏幕外的 cell，看是否报 "Nothing was applied"）。

### 5.2 G｜palette / layout 的成功结论来自编辑器自报

`App.tsx:682`、`:1375` 在拿到序列化 XML 后只做了一件事：

```ts
if (!isDrawioXmlDocument(serializedXml)) throw ...
```

即"这是不是合法 XML"，**不检查颜色/坐标是否真的变了**。然后 `:726` 记录 `changedCells: plan.changes.length`（**计划数**，不是实际变更数）。

缓解因素：插件侧事务很严（palette 在 `:605-620` 逐 cell 校验 `expectedStyle` 与当前值相等、且只允许改颜色键；layout 在 `:439-464` 校验全部 geometry/端点/覆盖率）。所以这是**方向相反的弱验证**（false positive 风险），比本次的 false negative 温和，但一旦插件侧逻辑退化，宿主不会察觉。

### 5.3 H｜错误分类靠正则匹配人话

```ts
// intent-route.ts:165-182
if (/ambiguous|was not found|not found among|missing required|.../i.test(safeMessage)) {
  return { outcome: "needs_clarification", reply: "No diagram changes were applied. " + safeMessage };
}
```

任何内部异常只要措辞里带 "not found" / "not supported"，就会被包装成"没有改动，需要澄清"，把真实故障降级成一次澄清请求。当前它只作用于 `/api/copilot/intent` 的 catch 分支（模型/SDK 异常），影响面有限，但**新增一条错误文案就可能改变分类结果**。

### 5.4 I｜重复实现

`drawio-xml-source.ts:39` 与 `drawio-xml-schema.ts:556` 各有一个 `isDrawioXmlDocument`，实现完全相同（前者还 re-export 了后者）。目前不会出错，但改一处会漏另一处。

---

## 6. 检查过、确认没问题的（避免重复劳动）

| 检查项 | 方法 | 结果 |
|---|---|---|
| 56 个官方 drawio 样例的页面解码 | 逐个 `parseDrawioXml` + `decodeDrawioPageXml`，统计空页/异常 | **0 个失败**，不存在"压缩页解不开导致全盘确认失败"的风险 |
| bridge 协议字段漂移 | 对比插件 `publish({event})` 的字段 vs 宿主 `data.X` 读取 | **无漂移**，宿主读的字段插件都发 |
| 单测 | `vitest run` | **339/339 通过**（此前记录的 8 个失败已不存在） |
| `labelMatches` 的 HTML 实体顺序 | 读 `:142-155` | 正确：先剥标签、再解 `&lt;/&gt;`，不会把 `<init>` 当标签吃掉 |
| 上一份报告指出的"伪造 rolled-back 日志" | `App.tsx:1950-1958` | **已修**（`8924dfa`），现在按 `batchRolledBack` / `applicationState` 分派 |

---

## 7. 建议的修复顺序

**第一步（能立刻止血，改动最小）**
1. `intent-route.ts:556` 的 `script` 描述补上 `xmlAssertions`，并给一条**可直接抄的**正例：
   ```js
   xmlAssertions: [{ cellId: "22", exists: true, kind: "edge", label: "启动",
                     parentId: "1", sourceId: "20", targetId: "21",
                     style: { endArrow: "block", strokeWidth: "1" },   // key→value 对象，不是整条字符串
                     geometry: { x: 50, y: 300, width: 10, height: 80 } }]
   ```
2. `useCopilotIntent.ts:344-346` 改用 `applicationState`，删掉"从 History 恢复"的引导。

**第二步（让修复循环能收敛）**
3. `nativeScriptResultMatchesXml` 返回 `{ ok, failures: [{cellId, field, expected, actual, reason}] }`，把 `invalid-assertion` 与 `mismatch` 分开；
4. `scriptRepair` payload 带上 `failures`；
5. 对 `changed-unverified` 增加一条"**只重新验证、不重跑脚本**"的通道（XML 就在手上，断言是纯函数）。

**第三步（把契约变成可执行的）**
6. 把 `xmlAssertions` 从自然语言搬进工具 schema，用 zod 定义（`style` 用 `z.record(z.string(), z.string().nullable())`），让 schema、文档、校验器共用一份定义；
7. 加最低强度要求：断言必须覆盖本次操作涉及的所有 cell（脚本可以返回 `affectedCellIds`），禁止只有 `{exists:true}` 的空壳通过；
8. `style` 同时接受字符串与对象（宽进），但**规范化后再比对**——这样既不会因写法判死，又保留验证力。

**第四步（收尾）**
9. `cell:select` 的签名比较排除 `dx/dy` 等视口属性（只比 `<root>` 子树）；
10. `unmatched` 的文案区分"内容未变"与"未收到序列化"；
11. 合并两份 `isDrawioXmlDocument`。

---

## 8. 回归清单

- `src/model/native-edit-confirmation.test.ts`
  - 新增：`style` 为字符串 → 期望 `invalid-assertion`（当前是 `false`，会把 bug 固化成期望）
  - 新增：`style: {}` → 拒绝
  - 新增：只有 `{cellId, exists:true}` 且 cellId 与操作无关 → 拒绝
  - 新增：单页 + `pageId "0"` + 根 `0`/层 `1`（本次事故的真实形状）
- `src/hooks/useCopilotIntent` 相关测试：`changed-unverified` 的文案必须包含"已应用/已保存"且**不包含**"恢复版本"
- `server/copilot/drawio-agent-reference.test.ts`：参考文档里必须出现 `style: {` 的示例
- e2e `05-copilot-native-edits.spec.ts:311`：脚本样例目前不带 `style`，补一条带对象 style 的正例
- 新增 e2e：脚本返回**字符串 style** 时，UI 必须提示"证据格式错误"，而不是"文档未匹配"

---

## 9. 一句话给决策

这三次事故的共同点不是"模型写错了代码"，而是**模型和校验器对"证据长什么样"没有共识，且校验器拒绝解释**。修 3 个具体 bug 只能让下次换个地方栽；把 `xmlAssertions` 变成 zod schema + 结构化失败原因，才是把这整类问题一次性关掉。
