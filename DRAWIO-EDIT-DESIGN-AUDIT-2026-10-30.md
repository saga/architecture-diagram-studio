# Draw.io 编辑链路设计审计（2026-10-30）

范围：从用户一句话到磁盘文件落地，所有会改 XML 的代码路径。
方法：读代码 + 用 2026-10-29T22:53 那次真实失败（`c5790cac`）和 10-24~10-29 的日志做交叉验证。
结论：**核心补丁器（228 行）设计良好；问题都在它外面。**

---

## 1. 一条编辑要过多少道关

`edit_drawio_xml`（服务端 XML 补丁，ADR-0026）成功路径上的强制校验：

| 侧 | 校验 |
|---|---|
| 服务端 | 参数 schema；持久化能力存在；`snapshot.revision === context.documentRevision`；terminal intent 未注册；输入 XML 合法；页解析/解压；cell ID 唯一；逐操作校验（cell 存在、属性名合法、geometry 字段合法）；输出 XML 合法；standalone 源 hash 复检 |
| 客户端 | workspace 就绪；`persistWorkspaceDocument` revision 相等；before-agent-request 陈旧检查；runtime inspection revision+page；activePageId 非空；inspection.pageId === activePageId；afterInspection page 一致；during-runtime-inspection 陈旧检查；cell 索引解析；during-agent-response 陈旧检查；3 条 revision 断言；before-standalone-xml-apply 陈旧检查；文件句柄存在；保存回执；句柄 token+revision 复核 |

**约 28 道，针对 2 个操作的补丁。**

对照「Copilot CLI 直接改 XML」：读文件 → 改 → 写文件。**0 道。**

---

## 2. 差异的本质：一份文档同时有三个所有者

| 维度 | CLI 直改 | 当前设计 | 由此产生的机制 |
|---|---|---|---|
| 文档在哪 | 一个文件 | 服务端快照 + 浏览器里的编辑器内存模型 + 磁盘文件 | revision、语义 diff、陈旧检查、保存回执 |
| 谁写 | 一个进程 | 服务端算、浏览器写（File System Access API）、编辑器再序列化 | `xml_patch_ready` 往返、`setNativeXmlOverride` 重载 |
| 页标识 | 无 | `declaredPageId` / `runtimePageId` / `selectedNativePageId` | 9 处 `resolveNativePageIdentity`，11 处页比较 |
| 谁改了 | 只有 agent | 用户拖拽、autosave、调色板、布局、typed ops、XML 补丁 | 5 条写入通道，13 个落盘调用点 |
| 校验 | 无 | 模型不可信 → 断言/后置条件/证据链 | `native-edit-confirmation.ts` 513 行 |

三个所有者不是凭空加的：文件句柄在浏览器里，Node 写不了；编辑器是用户画布，用户随时在拖；服务端要做 revision 事务。**但下面这些是在这个前提下多长出来的枝。**

---

## 3. 节外生枝清单

### P0-1 双编辑通道，两套验证规则

- `propose_native_edits`（typed ops → 编辑器脚本执行 → 序列化 → `native-edit-confirmation` 断言链）
- `edit_drawio_xml`（服务端 DOM 补丁 → 浏览器落盘）

两条路并存于 `useCopilotIntent.ts`（594 行，两个分支各 100+ 行），页 ID 处理、陈旧检查、错误文案都不同。
后果：`native-edit-confirmation.ts` 的 513 行断言/证据链**只服务旧路**——全仓库只剩两个引用（`DrawioFrame` 的 `nativeEditIsReflectedInXml`、`copilot-stale-context` 的 `summarizeNativeDiagramXmlDiff`）。10-27/10-28 的 `[invalid-result] postconditions`、`unowned-change`、edge geometry 39 连败全部出在这条路上，而新路根本不用它。

### P0-2 页标识三种表示，null 语义不一致 ← 昨晚失败的直接原因

`copilot-stale-context.ts:44` 是全仓库唯一一处**不带 null 保护**的页比较：

```ts
const pageChanged = source.selectedNativePageId !== current.selectedNativePageId;
```

其余 8 处都写 `selectedNativePageId !== null && ...`（`App.tsx:820/841/1487/1517` 等）。
`useCopilotIntent.ts` 里 6 个检查点，只有 2 个（`:222`、`:320`）用 `getStateForResolvedPage()` 把 null 回填成运行时页 ID，另 4 个（`:286`、`:492`、`:503`、`:528`）用裸状态。

结果：同一轮里 `during-agent-response` 通过，30 ms 后 `before-standalone-xml-apply` 判 stale，`before=n4RG28…`、`after=null`、`xmlChanged=false`，已算好并校验过的补丁被丢弃。

### P0-3 三条 revision 断言里有两条是空转

`useCopilotIntent.ts:281-285`：

```ts
if (plan.documentRevision !== documentRevision ||
    await calculateDrawioXmlRevision(sourceXml) !== plan.documentRevision ||   // 恒等
    await calculateDrawioXmlRevision(plan.drawioXml) !== plan.patchedRevision)
```

`documentRevision` 就是第 119 行 `calculateDrawioXmlRevision(sourceXml)` 的值，前两条永远相等。
真正拦住并发修改的只有第三行和 `assertCopilotRequestContextFresh`——而后者正是 P0-2 坏掉的那个。
**看起来三重保险，实际只有一道，且这道有 bug。**

### P0-4 重试提示不认识 `edit_drawio_xml`，每次编辑白跑一轮模型

`intent-route.ts:1483`：

```ts
if (!capturedSelection && !capturedNativeEdits && !capturedReportedOutcome) { /* 发第二次提示 */ }
```

`edit_drawio_xml` 的结果存在 `pendingXmlPatches`，**不在这三个变量里**。所以补丁已接受后仍会触发 "Finish with exactly one terminal tool call"，模型再调一次被 `terminal_action_already_registered` 拒掉，只好用文字解释。

实测（唯一一次 `edit_drawio_xml` 调用）：

```
durationMs 71761 · modelCalls 2 · inputTokens 137228
attempt 2 回复："上一条原生编辑仍在待派发队列中，系统不再接受重复派发，因此本轮不再追加操作"
```

首轮 8.8 s 就已完成，多花的 14.5 s / 67k input token 完全是这条老条件造成的。

### P1-1 服务端整篇重排文件

`applyDrawioXmlPatch` 走 `parseDrawioXml` → 改 → `serializeDrawioXml`，压缩页还要 deflate 回去。
语义上只改 2 个 cell，字节上整篇属性顺序/自闭合/空白都可能变；写盘后编辑器再序列化一次。用户看到的 diff 远大于实际改动，也解释了为什么陈旧检查必须做语义 diff 而不能比字符串。

### P1-2 默认不执行的 proposal/confirm 层仍在控制流里

`edit-confirmation-policy.ts`（19 行）默认返回 false，但 `confirmProposal`（154 行）、服务端 `/intent/confirm`（98 行）、`/intent/ack`（59 行）、`pendingNativeProposals`、`acknowledgements` 全部保留，`requiresExplicitConfirmation` 还在决定分支。
**约 310 行默认走不到的代码**，每读一次链路都要先判断它是否生效。

### P1-3 13 个落盘调用点

`enqueueStandaloneSave` 8 处 + `persistDocumentNow` 5 处，覆盖手动编辑 autosave、typed ops、调色板、自动布局、XML 补丁。
任何一个新增写路径都必须自己重做「token 校验 + revision 复核 + 冲突清理」，没有单一出口。

---

## 4. 哪些层是必要的，不要一起砍

| 层 | 必要性 |
|---|---|
| 输入/输出 XML 校验 | 必须。防止把文件写坏 |
| cell 级补丁（不重建文档） | 必须。保住 UserObject、未知属性、多页 |
| workspace revision 事务 | 必须。服务端是唯一写者时它替代了文件锁 |
| 页标识 | 多页文档必须；**但只需要一个真值来源** |
| 语义 diff | 因为编辑器会重排，才需要。属于 P1-1 的连带成本 |
| 断言/证据链 | **不再需要**。XML 补丁本身可验证，模型声明的 postcondition 是旧路的遗留 |

---

## 5. 建议

**第一步（止血，不动架构）**
1. `copilot-stale-context.ts:44` 改为「双方都非 null 且不等才算变化」。
2. 4 个裸 `getCurrentDiagramState()` 换成 `getStateForResolvedPage()`。
3. `intent-route.ts:1483` 加上 `&& !pendingXmlPatches.has(sessionId)`。
4. 删掉 `:282-283` 两条恒等断言，换成「当前 XML 的 hash === plan.documentRevision」——现在这道真正的检查是缺的。

**第二步（收敛通道）**
5. 删除 typed ops 编辑路径，只保留 XML 补丁；随之删掉 `native-edit-confirmation` 的断言部分、proposal/confirm、ack 回执。预计净减 800~1000 行。
6. 页标识收敛为「文档声明 ID，缺失时由运行时补」，只留一个 `resolvePageTarget()`，所有比较走它。

**第三步（可选，单写者）**
7. 若接受「编辑器只读、每次编辑后从磁盘重载」，standalone 可以改成 Node 直接写文件，删掉 `xml_patch_ready` 整条往返。代价是每次编辑丢视口、丢未保存的拖拽；收益是 P0-2/P0-3/P1-3 全部消失。
   不建议现在做——先看第一步之后还剩多少失败。

---

## 6. 数据附录

- `applyDrawioXmlPatch` 228 行；`useCopilotIntent` 594；`intent-route` 1810；`native-edit-confirmation` 513；`native-edit-operations` 541；`DrawioFrame` 895；`App.tsx` 2347。
- 页比较 11 处，9 处带 null 保护，1 处（`copilot-stale-context.ts:44`）不带。
- `resolveNativePageIdentity` 调用 7 处（定义 1），分布在 3 个模块。
- 落盘调用点 13 处。
- 唯一一次 `edit_drawio_xml` 调用：2 次模型调用、71.7 s、137k input token、2 个操作、最终被丢弃。
