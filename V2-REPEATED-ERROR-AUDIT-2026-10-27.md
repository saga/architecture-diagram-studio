# V2 同类错误全仓复查（2026-10-27）

- **审查范围**：V2 原生编辑执行、Draw.io JS API 契约、脚本结果与 XML 断言、回滚、导出确认、保存/版本回执、自动修复和相应测试。
- **方式**：检查当前 `main` 的源码、测试、ADR，并交叉核对既有事故报告。当前会话无法运行项目本地测试或 build；GitHub combined status 未返回可用的 checks。本文不会把静态检查冒充为测试通过。
- **本轮代码变更**：无；仅新增本报告。

## 结论

V2 已经修复了若干之前事故中确认的问题，但同类风险仍不止一个。最先处理的应是 **一个确定的测试回归**，以及 **原生脚本可在成功回执后异步修改图** 和 **长耗时编辑的超时/迟到回执不一致**。另有一个 XML style 断言的潜在假通过边界需要测试。

## P1-1：常驻提示词测试与当前提示词互相矛盾（静态确认）

**位置**
- `v2/server/copilot/native-diagram-instructions.ts`
- `v2/server/copilot/native-diagram-instructions.test.ts`

提示词为了避免总数断言错误，已经包含：

```text
model.getChildCount(parent) counts direct children only; recurse for totals ...
```

但同一文件的测试仍要求：

```ts
expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("model.getChildCount(parent)");
```

该负向断言与新提示词逐字冲突，按当前源码，相关 Vitest 用例应当失败。提示词长度仍低于 2500 字符限制；失败点是陈旧的负向断言，不是长度。

**处理方向**：测试应该验证模型被告知该 API 只数直接子节点，而不是禁止提示词出现该 API 名。运行 `npm test` 前应先消除这条相互矛盾的断言。

## P1-2：脚本只拒绝“返回 Promise”，没有阻止异步续体

**位置**：`v2/plugins/studio-selection-plugin.js` 的 `cell:execute-script` 分支。

当前包装器直接执行：

```js
var scriptResult = executeNativeScript(...);
if (scriptResult && typeof scriptResult.then === "function") {
  throw new Error("Native Draw.io scripts must be synchronous; promise-returning scripts are not supported");
}
```

这只能拒绝脚本**返回** Promise/thenable，不能阻止脚本安排延迟副作用。例如，脚本可以通过 `setTimeout(() => graph.insertEdge(...), 1000)` 安排一个回调，同时立即返回普通结果；普通结果不会触发 thenable 检查。

延迟回调发生在原子批次已结束之后，届时用于记录新建 cell 的 `activeBatchCreatedCells` 已被清空，原执行的回滚与后置条件验证也已结束。延迟修改可能独立触发 autosave，形成“原操作已经确认，随后又有未经该请求验证的修改”的状态。

**处理方向**：不要只依赖 prompt 说“必须同步”。需要定义可执行的边界或能检测并拒绝/隔离这类异步续体的机制，并加一个真实插件桥的回归测试。不要简单认定检查 `scriptResult.then` 已经满足同步约束。

## P1-3：App watchdog 与 XML 确认窗口仍有不同起点，迟到成功可能只落盘、不纠正用户结论

**位置**
- `v2/src/App.tsx`：`applyNativeCellEdits` 的 watchdog 和 `nativeEditResolversRef`
- `v2/src/components/DrawioFrame.tsx`：`NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS` 和导出确认
- `docs/V2-CODE-REVIEW-2026-10-23.md`：既有 P1-8 事故分析

当前脚本批次 watchdog 默认为 75 秒，而 DrawioFrame 的 XML 导出确认窗口为 30 秒；前者从派发开始计时，后者要等 Draw.io 执行回执后才开始计时。这两个期限不是一条共享的截止时间。

如果脚本执行/编辑器回执较慢，宿主 watchdog 可能先删除 resolver 并向调用方返回失败；随后 DrawioFrame 仍可能接收到 XML、将变更传入文档状态并触发持久化。App 的迟到结果分支在完成 revision / persistence / server ack 处理后，才发现 batch 已经没有 resolver，于是仅记录 `copilot.native-edit.acknowledgement.unobserved` 并返回，没有给用户补发“迟到成功且已保存”的可见结果。

因此，75 秒 watchdog 降低了先前两个 30 秒窗口的冲突频率，但**并没有消除时限不一致和迟到成功缺少用户可见纠正**。这不是说每次超时都会发生，而是当前执行顺序仍允许这种竞争条件。

**处理方向**：统一用一份请求级 deadline/状态机管理执行、XML 序列化和持久化；超时后明确进入“仍在对账/不可重试”或取消状态；迟到完成必须更新用户可见结果。不能在图已保存的情况下只丢弃界面回执。

## P1-4：嵌套 native transaction 仍是约定，而不是强制校验

**位置**：`v2/plugins/studio-selection-plugin.js` 的脚本外层 `model.beginUpdate()/endUpdate()` 事务，以及 `docs/DRAWIO-AGENT-API-CONTRACT.md` 的事务说明。

桥接层自己开启一个外层事务，并在 `finally` 调用一次 `endUpdate()`。脚本仍可以再调用 `model.beginUpdate()`，却遗漏相应的 `endUpdate()`。在 mxGraph 的嵌套更新计数语义下，外层的一次 `endUpdate()` 不会抵消脚本遗漏的额外深度；可能造成 change 事件/Undo 分组迟迟不提交，后续保存和编辑行为异常。

契约要求 begin/end 配对是必要的文档约束，但它不是运行时保证。当前未找到能证明该路径已被拒绝或被回归测试覆盖的证据。

**处理方向**：加入明确的脚本事务策略和测试，至少在脚本结束时检测更新深度是否恢复到桥接前的水平；深度异常时不能将操作标记为正常成功。

## P2-1：style 断言遇到重复键时可能发生假通过（待复现）

**位置**：`v2/src/model/native-edit-confirmation.ts` 中的 `nativeAssertionStyleValue()` / `styleMatches()`。

`nativeAssertionStyleValue` 返回某个 style key 的全部匹配项，而 `styleMatches` 对预期字符串使用 `actual.some(entry => entry === expected)`。如果序列化 style 字符串中同一个 key 出现多次，例如先有 `endArrow=block`，后又有 `endArrow=none`，只要旧的匹配项还在，针对 `block` 的断言就可能通过，即使实际解析后的有效值是最后一个。

这条结论是从当前比较逻辑得出的风险，不是已经用真实 Draw.io bundle 复现的事故。应先核对 pinned v32.0.2 对重复 style key 的解析语义，再补测试；若有效语义是后值覆盖前值，验证器应比较最终生效值，而不是任意一次出现值。

## 本轮复核确认已改正的旧问题

以下在当前源码中看起来已经处理，不应重复报成当前缺陷：

1. **`getSource()/getTarget()`**：当前指令与工具描述明确要求 `getTerminal(true/false)`；全仓代码搜索未发现新的生产脚本调用这两个不存在的方法（事故报告中的样例属于历史文档）。
2. **`model.getDefaultParent()/model.refresh()` 归属错误**：当前 API 契约写明它们属于 `graph`，并有相应测试检查 API ownership。
3. **回滚 connectable 使用了错误对象**：当前插件通过 `setCellConnectable()` 兼容 `activeModel.setConnectable` 与 `cell.setConnectable`，相应测试已存在。
4. **丢失 `batchRolledBack`**：当前 DrawioFrame 失败回执包含 `batchRolledBack`，App 只把显式 `=== true` 视作已确认回滚。
5. **根/图层硬编码 ID**：当前脚本 XML 验证以原生结构和页面作用域为准，不再依赖根 cell 固定为 `0`、图层固定为 `1`。
6. **非法 XML 污染 `lastSent` 基线**：当前 DrawioFrame 在 XML 格式检查和确认处理后才更新 `lastSent.current`。
7. **Standalone 导入误标已保存**：当前导入路径将 `standaloneLastSavedXmlRef.current` 设为 `null`（文件已打开时），会触发后续文件句柄保存；不是旧报告中直接把导入 XML 标为已保存的代码。

## 运行验证状态

当前没有执行 `npm test`、`npm run typecheck`、`npm run build` 或 Playwright；GitHub combined status 查询未返回 checks。因此：

- P1-1 是源码与测试之间可以静态确定的冲突。
- P1-2、P1-3、P1-4 是从当前执行顺序推导出的未封闭边界，需要新增针对真实插件/超时路径的回归测试。
- P2-1 是待使用 pinned Draw.io bundle 复现的验证器风险。
- 本报告不声称 V2 已通过构建或测试。
