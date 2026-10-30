# V2 同类错误全仓复查（2026-10-27）

- **审查范围**：V2 原生编辑执行、Draw.io JS API 契约、脚本结果与 XML 断言、回滚、导出确认、保存/版本回执、自动修复和相应测试。
- **方式**：检查当前 `main` 的源码、测试、ADR，并交叉核对既有事故报告。当前会话无法运行项目本地测试或 build；GitHub combined status 未返回可用的 checks。本文不会把静态检查冒充为测试通过。
- **初次审查时的状态**：仅分析、未修改代码。随后按下方“实施记录”完成对应修改并提交到 `main`；最新实现状态以实施记录为准。

## 结论

V2 已经修复了若干之前事故中确认的问题，但同类风险仍不止一个。最先处理的应是 **一个确定的测试回归**，以及 **原生脚本可在成功回执后异步修改图** 和 **长耗时编辑的超时/迟到回执不一致**。另有一个 XML style 断言的潜在假通过边界需要测试。

> 以下 P1/P2 小节记录的是这份报告最初建立时发现的问题和证据。后续实施已修改对应代码及测试；不要把下文的历史态描述理解为当前仍未修复。当前修复范围、限制和未完成的验证见文末“实施记录”。

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

---

## 实施记录（2026-10-27）

以下代码已提交到 `main`。本节更新的是当前实现状态；上文各发现保留为审查时的历史上下文。

### P1-1：已修正提示词测试冲突

`v2/server/copilot/native-diagram-instructions.test.ts` 现在验证提示词明确说明 `model.getChildCount` 只统计直接子节点，而不是反向禁止提示词提到该 API。更新后的核心提示词运行时长度经静态解码为 2436 字符，仍小于测试的 2500 字符上限。

### P1-2：已增加原生脚本同步执行护栏

`v2/plugins/studio-selection-plugin.js` 增加了字符串、注释和模板插值感知的源码扫描，拒绝常见 async/await、Promise、timer、网络、事件回调、动态求值及 parent/global 访问。最初的全局 timer/Promise monkey-patch 已移除：它会拦截 Draw.io 自己的插入/渲染定时器并破坏正常编辑；当前边界使用源码检查及事务/序列化后检查，而不是修改宿主全局 API。新增插件测试覆盖显式和计算属性 timer/Promise 引用、template interpolation 中的 async/await，以及字符串/注释中的无害词汇；另加回归测试保证本地原生插入能调用 Draw.io 内部 timer。

这不是安全沙箱，也不能打断无限循环；报告与 API 契约明确保留这一限制。应继续验证被实际 Draw.io API 间接触发的行为，避免护栏影响合法的同步图操作。

### P1-3：已修正 watchdog 与迟到回执处理

`v2/src/App.tsx` 现在在 DrawioFrame 返回结果时先清除 App watchdog，避免 watchdog 在 workspace/standalone 持久化或服务端回执尚未结束时再次宣告超时。脚本批次的 App 等待窗口包含 DrawioFrame 的 XML 导出确认窗口和缓冲时间。

如果 App watchdog 先到：
- 不再向服务器提交一个可能与后续实际结果冲突的终态 failed acknowledgement；
- 保留 acknowledgement context，登记待对账请求，并阻止继续派发新的 Copilot 原生编辑；
- 不再自动从最后保存版本重载编辑器，因为这可能与仍在进行的操作竞争；
- 收到带序列化 XML 或明确回滚/未变更证据的迟到结果时，继续执行正常保存和回执处理，更新用户可见消息，并解除待对账状态；
- 迟到回执没有最终 XML 或明确回滚证据时，不伪装成已对账，保持锁定并提示检查当前图、History，必要时重新加载文档。

这一状态机已完成源码修改，但仍需运行真实 Draw.io iframe / workspace / standalone 的端到端测试验证超时竞态。若待对账结果永久不回来，当前设计选择要求检查并重新加载文档后再继续，而不是自动猜测结果。

### P1-4：已增加模型事务配对检查

脚本执行期间，插件会包装模型的 `beginUpdate`/`endUpdate`：不允许脚本关闭桥接层拥有的外层事务或替换事务方法；允许平衡的嵌套事务；脚本未配对时先尝试有界地回收脚本打开的嵌套层级，再将本次批次判为失败，走现有原生回滚。清理失败会保留在错误信息里。插件测试覆盖平衡、不平衡和试图关闭外层事务的行为。

### P2-1：已按最后一个重复键修正 style 验证

`native-edit-confirmation.ts` 的 style matcher 不再接受任意一个同名键值，而是比较序列化样式里最后一次出现的值。新增测试验证 `endArrow=block;endArrow=none;` 不会错误满足对 `endArrow=block` 的断言，但会匹配 `endArrow=none`。该结论基于 mxGraph 常规样式解析语义；仍应在项目的 pinned Draw.io 版本中运行该测试确认。

### 决策和文档同步

- 新增 [ADR-0029 — Native Script Runtime Boundaries and Late Outcomes](./docs/adr/0029-native-script-runtime-boundaries-and-late-outcomes.md)。
- 更新 [Draw.io Agent API Contract](./docs/DRAWIO-AGENT-API-CONTRACT.md) 说明同步执行护栏与其限制。
- 更新 [ARCHITECTURE-V2.md](./ARCHITECTURE-V2.md) 的 ADR 索引。
- 本次对原生脚本失败报告的此前实现记录仍有效；本报告记录更广泛 V2 复查项的完成情况。

### 验证状态

此环境仍无法解析 `github.com`，因此不能克隆仓库执行 `npm test`、`npm run typecheck`、`npm run build` 或 Playwright。GitHub combined commit status 查询也没有返回检查项。所有新增测试是已提交的回归用例，不应报告为已运行或通过。合并前必须在仓库可执行环境中运行完整 V2 测试、类型检查、构建和相关 Playwright 场景。

## 2026-10-28：全 V2 终局、执行回执与校验链路复查

本轮按用户事故路径复查了 Copilot 工具注册和 dispatch、原生脚本执行、DrawioFrame XML 确认、App 持久化/迟到回执、修订号与形状搜索，以及相关 ADR / API 契约。已落地的新增修改如下。

### 已修复

1. **终局工具冲突不再丢弃合法编辑。** `registerTerminalIntent` 改为结构化接受/拒绝。已排队的原生编辑优先；后续终局工具返回明确拒绝，不再通过异常让整个 SDK turn 失败。较弱的 selection/no-mutation 结果可被后续确定的 native edit 提升。
2. **终局动作已接受、SDK 后续流失败时继续对账。** 记录模型流错误，但只要浏览器请求未取消且终局动作已被接受，服务端仍返回已排队动作；不会把“SDK 文本失败”误当成“编辑没有发生”。
3. **只读脚本不再假装能返回同轮结果。** `run_drawio_script(mode:"read")` 在 dispatch 前明确拒绝、不执行、不占用终局名额，并引导使用同轮可用的 `inspect_drawio_graph` / `search_drawio_elements`。
4. **工具拒绝原因可被模型理解。** 编辑操作解析失败、目标不存在或标签歧义、无效搜索参数、无效引用主题等常见输入错误改为结构化结果；原生参考文档读取失败会区分为 reference unavailable，而非误报为 Draw.io 运行时失败。
5. **形状检索与上下文约束一致。** curated/runtime shape search 接受单字符中文；普通元素搜索返回 active page 与 `documentRevision`，模型可以使用同一修订号的真实 cell ID，而不能拿旧上下文 ID 继续操作。
6. **选择结果与实际执行对齐。** selection 工具结果说明其仅已排队；前端等待 Draw.io bridge 回执后再完成操作。选择请求超时后保留有界的迟到回执标记，迟到的成功/失败会更新用户可见结果，而不是永久留下过时的失败提示。
7. **移除会破坏合法图操作的全局同步护栏。** 不再 monkey-patch `window` timer 或 `Promise.prototype`，因为 Draw.io 自身的插入/渲染路径可能调用这些 API。继续通过脚本源码检查和事务/XML 后置验证约束用户脚本；新增回归用例覆盖内部 timer 调用。
8. **加强脚本变更范围验证。** `xmlAssertions` 对已有 cell 不能再仅声明 `exists:true`；必须提供标签、类型、关系、style 或 geometry 等具体证据。未声明的新建、修改、删除图元都会进入范围检查，且检查按预期 active page 绑定，防止另一页的同 ID cell 掩盖未声明修改。
9. **修正视口签名的无 ID 回退分支。** 所有 `mxGraphModel` 语义签名统一忽略 `dx/dy`；增加没有 diagram ID 的 viewport-only 测试。
10. **约束长生命周期状态。** 空搜索 streak map 增加 TTL 和最大 key 数，避免无界增长。修订了独立文件待对账的恢复说明，明确等待超时不等于回滚。

### 本轮新增的重点回归场景

- read → 中文标签编辑 → 误调用 report，仍应派发原生编辑；
- report → 真实编辑时提升为 native edit；
- 两个终局编辑只保留第一条合法编辑，不让第二条覆盖；
- 已接受编辑后 SDK 流抛错，服务端仍返回 pending edit；
- 选择工具返回 queued，而不是提前声称 canvas 已完成选择；
- 搜索结果带 active page 与 document revision；
- 新建图元未声明、跨页面同 ID、仅存在性断言、无 diagram ID 的纯 viewport 变化；
- Draw.io 内部 timer 在原生插入期间仍可正常调用。

### 验证边界

以上代码与测试已直接提交到 `main`。按用户要求，本轮没有等待最新 CI 完成；因此新增与修改的回归用例是已提交、尚未由本轮最新 CI 证明通过的测试，不能表述为“全部测试通过”。最终合并/发布前仍需在本地或 CI 环境运行 V2 的 typecheck、unit tests、build 及 native-canvas Playwright E2E。

### Follow-up: page-level changes fail closed

The most recent completed quality run exposed a stale test expectation: removing an entire page was expected to ignore every cell in that page. The current scope validator deliberately rejects page additions, removals, renames and reordering as unproven changes because there is no page-level assertion contract. The removed-page test now expects that rejection, and a new test covers page addition. The native-canvas E2E job in that earlier run succeeded. Per the user's instruction, this audit does not wait for another CI run; the latest test result is therefore unverified.


## 2026-10-28：Task 7 后续相似缺陷复查

复查范围扩展到 Studio assertion schema、富标签 typed-edit、检索截断语义和 TypeScript 导出类型。确认并修复了以下问题：

1. **应用自定义断言字段伪装成原生属性，并重复定义同一语义。** `chineseTitle` 不是 Draw.io XML 属性；`expectedTitle` 又与已有的 `labelContains` 完全重复。当前运行时类型、验证器、工具描述和提示词已统一使用 `labelContains` 作为唯一的子串断言，并移除 `chineseTitle`、`expectedTitle` 和冗余布尔 `labelContainsTitle`。文档明确所有 `xmlAssertions` 键都是 Studio 的宿主验证契约。
2. **typed 全量重命名会静默丢掉富标签结构。** 包装值的 setter 会保留最外层 UserObject，但对嵌套 HTML 标记使用 `textContent` 会抹掉内部格式、换行或 placeholder span。插件已增加 fail-closed 判断：plain-text `set_label` 若会扁平化嵌套 markup 就拒绝执行，提示走保留 markup 的脚本路径。回归测试验证失败后标签与 `placeholders` 属性不变。
3. **截断搜索容易被误认成完整目标集合。** `search_drawio_elements` 默认 limit 提高到 10；截断返回明确告诉模型不可将子集作为“全部目标”，应使用同页、同 revision 的 `inspect_drawio_graph` 分页直到 `truncated:false`。新增测试包含 12 个同标签目标，分别检查截断结果和完整分页枚举。
4. **类型契约落后于实际验证器。** `NativeScriptXmlCellAssertion` 原先未表达子串断言和 connector geometry 的 points/offset/sourcePoint/targetPoint。导出类型已补齐 `labelContains` 及完整几何字段，另加编译期类型回归测试。

本次最新代码更改已提交到 `main`。最后提交对应的 V2 CI 尚在运行中；在得到结果前，不宣称新加的单元测试、构建和原生画布 E2E 全部通过。已知的另一个限制仍然存在：原生脚本运行在浏览器主线程，源码护栏并不是真正的安全沙箱，也不能终止无限循环；本轮没有声称解决这一结构限制。


## 2026-10-28：形状目录检索的截断完整性

同类静默漏项还存在于 curated shape catalogue。普通 `search_drawio_shapes` 在结果超过 limit 时原先没有总命中数或 `truncated` 字段，模型可能把前几条 recipe 当成完整结果。现已新增 `searchDrawioShapeCatalogDetailed`，返回完整的 `matchCount` / `returnedCount` / `truncated` 元数据，并在工具描述中明确要求截断时缩小查询或使用 live Draw.io UI/runtime 发现流程。C4 directory alias 有单独回归，验证 Person、Software System、Container、Relationship 四项完整返回，不能被默认 limit 截断。新增 catalog 与 route 测试已提交；本轮最终 CI 尚未通过，因此测试结果仍待 CI 证明。


### 2026-10-28：runtime shape registry 的源数据截断

search_drawio_runtime_shapes 曾只报告查询是否超过 limit，没有报告源 registry 本身是否被 iframe 截断到 2000 项。因此即使查询返回 0，也不能证明完整的运行时 shape class 集合中不存在候选。现已在 iframe inspection 中加入 liveShapeClassesTruncated，由 normalizer 识别源集合超限，并由查询工具分别返回源截断和结果截断状态；只有源集合完整且查询未截断时，匹配数量才可视为完整。回归测试覆盖源快照标记、normalizer 超限推断和查询 0 命中时的提示。最新提交的 CI 仍需确认后，才可报告测试通过。
