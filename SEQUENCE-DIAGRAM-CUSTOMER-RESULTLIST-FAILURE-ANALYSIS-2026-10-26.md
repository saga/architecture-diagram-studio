# Sequence Diagram 编辑失败分析：Customer → :ResultList

- 日期：2026-10-26
- 严重程度：P1（编辑结果状态不确定；需先核实当前文件/恢复点）
- 范围：仅分析本次失败和相关确认/序列化链路，不在本报告中修改业务代码。
- 结论类型：基于用户提供的日志与当前 `main` 代码；由于没有本次编辑前后的完整 XML、完整脚本和最终持久化回执，无法断言新增消息是否实际留在画布或文件中。

## 1. 摘要结论

这不是一条简单的“Draw.io 没有导出 XML”故障。日志明确记录到 Draw.io 返回了一个显式 XML export，但该快照被 Studio 的确认逻辑判定为不匹配并忽略；30 秒内没有后续快照通过确认，最终 host 才把操作报告为失败。

因此，界面里的 **“Nothing was applied”不能理解为“确定没有任何修改”**。能够确定的是：Studio 没有拿到被它接受为本次请求结果的序列化快照，没有完成成功回执。不能据此证明画布从未变动，也不能证明本次编辑一定没有落盘。

另外，插件侧报告脚本执行成功且没有抛异常，但脚本返回了 `undefined`，没有结构化结果来报告新增消息、生命线几何和销毁符号位置等后置条件。日志也显示 `batchRolledBack: null`；这次不是插件执行失败后进入回滚分支，而是宿主在成功执行回执后等待 XML 确认超时。没有证据证明发生过回滚。

**最明确的代码级问题是确认协议把“执行完毕”“XML 已导出”和“请求结果已被验证”混成了相近的失败文案；并且脚本确认检查的是整个文档的结构条件，而不是本次活动页上的实际变化。** 还需要实际 XML 来确认本次 unmatched 的具体触发条件。

## 2. 用户请求与日志事实

请求目标是：在 Customer 和 :ResultList 之间新增一条直接读取消息，标签为 `readResults()`，并相应延长 ResultList 生命线、下移销毁符号，以及新增激活条和消息连线。

日志按发生顺序（原始时间为 UTC，`Z`）：

| 时间 | 日志证据 | 能确认什么 |
| --- | --- | --- |
| 05:55:26.665 | `turn.streaming.progress`，模型处于 reasoning；约 60 秒无输出 delta | 模型推理耗时较长，但这不是后续 30 秒 XML 确认超时的直接原因。 |
| 05:55:37.617 | `turn.model-call.completed`，耗时约 70.95 秒；`turn.completed.with-native-edits` 随后记录 `operationCount: 1` | 模型最终提交了一个原生脚本编辑动作。 |
| 05:55:37.894 | `drawio.selection.property.save-confirmation.unmatched`，`saveEvent: "export"`、`serializedByExport: true`，持续时间 109 ms | **确实收到过 XML export**，但该份 XML 没有通过请求结果确认器的判定。 |
| 05:56:07.892 | `drawio.selection.property.save-confirmation.timeout`，`timeoutMs: 30000`、实际约 30089 ms | 30 秒窗口内没有符合确认条件的快照。它不等于 30 秒内完全没有 XML 导出。 |
| 05:56:07.938–.939 | `copilot.native-edit.rejected`、`copilot.native-edits.failed` | 最终编辑结果被记为 failed，`failureStage: "editor"`；`batchRolledBack: null)，`rollbackErrors: [])。 |

本次脚本结果为：

```json
{
  "available": false,
  "reason": "script_returned_undefined"
}
```

这说明脚本正常返回了 JavaScript 的 `undefined`，桥接层没有拿到结构化业务结果。它本身**不是脚本抛错的证据**，也不能证明目标修改已完成。

日志中脚本正文被截断，仅能看到脚本引用了 ResultList 生命线、销毁符号和 Customer 激活条等 cell ID。没有完整脚本，也没有 before/after XML，无法进一步判定哪一个 cell、几何或连线操作是否实际生效。

## 3. 最可能的故障链

### 3.1 Native 脚本执行成功，但没有业务后置条件

插件的 `cell:execute-script` 分支使用 `new Function(...)` 执行脚本。只要脚本同步运行且没有抛异常，分支就返回 `executed: true`，再序列化脚本返回值。

位置：[studio-selection-plugin.js](v2/plugins/studio-selection-plugin.js#L1118-L1136)

这一级的 success 表示“执行没有抛异常”，不是“新增消息的源/目标、标签、生命线长度和销毁位置都正确”。本次返回 `undefined`，因此没有脚本级的业务验收记录。

### 3.2 XML export 确实返回，但快照未通过确认

宿主在收到原生编辑成功事件后，启动 30 秒计时器并请求 `{ action: "export", format: "xml" }`。收到 export 后，先验证 XML 格式，再调用 `nativeEditIsReflectedInXml`。若返回 false，就记下 `save-confirmation.unmatched` 并保留待确认项，等后续导出或超时。

位置：[DrawioFrame.tsx](v2/src/components/DrawioFrame.tsx#L550-L610)、[DrawioFrame.tsx](v2/src/components/DrawioFrame.tsx#L765-L805)

日志恰好符合这个分支：export 到达、确认失败、计时器继续运行、30 秒后超时。

### 3.3 当前脚本确认条件没有验证本次 Sequence Diagram 语义变化

当前仓库中的 [native-edit-confirmation.ts](v2/src/model/native-edit-confirmation.ts#L329-L362) 对直接脚本走宽松路径：不验证具体消息 cell 是否新增或连接到 Customer 与 ResultList，也不检查生命线和销毁符号的几何变化；它只要求导出的 XML 能解析出页面，而且 **每一个页面** 都包含 ID 为 `0` 和 `1` 的根/默认层 cell。

对应测试也明确允许脚本在没有任何 XML 变化时被确认，只要导出结构满足该条件；若结构缺失默认层，则会判为不匹配。见 [native-edit-confirmation.test.ts](v2/src/model/native-edit-confirmation.test.ts#L83-L129)。

因此，本次 unmatched 的代码级触发条件可能是以下之一：

1. 导出 XML 中至少一个被解析页面未通过根/默认层 ID `0`/`1` 的结构检查；
2. 页面解析或压缩页展开过程中未得到预期的页面/单元格集合；
3. 实际运行的宿主/插件代码与当前仓库的确认逻辑不一致。

由于日志没有包含完整 XML 和对应本地代码版本，本报告不能确定这三种情况中的哪一种。但它们比“没有发起 export”更符合现有证据。

更重要的是，即便这一结构检查通过，它也不保证 `readResults()` 消息真的连接在目标 lifeline 上。因此，该确认器目前既可能把结构有效但无变化的脚本当作成功，也可能把有意义但未符合全文件结构假设的修改判为失败。

### 3.4 失败文案不准确，且“失败”之后的真实文档状态未确定

当前超时文案是：

> Draw.io acknowledged the native edit but did not serialize XML within 30 seconds.

但日志已经记录 `saveEvent: "export"` 和 `serializedByExport: true`。本次实际情况更接近“导出了 XML，但该快照没有通过编辑结果确认，之后也没有匹配的快照”。

此外，当前 `DrawioFrame.tsx` 的 unmatched 分支使用 `continue` 跳过这条成功确认，而不是丢弃整个 XML export。只要该 export 是有效 XML 且内容不等于 `lastSent.current`，后续代码仍会把它设置为新的 XML 并调用 `onDocumentChange`。在 standalone 模式下，这可能进入普通的文件自动保存链。

因此，有两种风险需要区别对待：

- 该 export 与原 XML 相同：可能没有可见的文档变更，最终因为未确认而报告失败；
- 该 export 与原 XML 不同：画布或文件可能已经包含部分/全部修改，但该动作仍然报告失败。

用户提供的日志没有展示 `xmlLengthBefore`、`xmlLengthAfter` 的具体值，也没有给出随后 `drawio.document.saved` 或最终文件 revision，因此目前无法确认本次是否已自动保存。不要把 UI 的失败提示当作“文件绝对未变”的证据。

## 4. 根因分层

| 分类 | 判断 | 依据 |
| --- | --- | --- |
| 直接触发原因 | XML export 被确认器拒绝，后续 30 秒没有通过确认的快照 | `save-confirmation.unmatched` → `save-confirmation.timeout` 的连续日志 |
| 主要设计缺陷 | 直接脚本确认条件与目标操作语义无关，检查全文档结构而非活动页结果 | `nativeEditIsReflectedInXml` 的脚本分支及其测试 |
| 可观测性缺陷 | “did not serialize XML”掩盖了“已导出但不匹配”；`undefined` 没提供业务结果 | export 日志已到达、`script_returned_undefined` |
| 状态一致性风险 | 失败回执不代表编辑一定没发生；unmatched 的有效 XML 仍可能进入普通文档更新/自动保存链 | `DrawioFrame.tsx` 在确认循环之后继续处理有效 XML |
| 当前无法确认 | 本次新增消息、激活条、生命线和销毁符号是否已实际改动/保存 | 缺少 before/after XML、完整脚本和保存 revision |

模型 70 秒的 reasoning 过程是另一项延迟问题，不能解释后续 export 为什么 unmatched。它不是本次错误的主要根因。

## 5. 建议修复顺序

### P0：区分执行、序列化、验证和持久化四种结果

不要再用同一个超时消息覆盖“没收到 export”和“收到了 export 但 verifier 不接受”两种情况。至少需要不同的结果状态：

- `script_execution_succeeded`
- `xml_export_received`
- `postcondition_verified`
- `document_persisted`

若 export 已到但验证失败，用户消息应明确表示“编辑状态未确认，实际画布/文件可能已有变化”，而不是断言什么都没应用。

### P0：修正脚本确认器的范围与含义

- 不应因为非活动页没有固定 ID `0`/`1` 而阻止活动页编辑被确认；应验证原请求指定的活动页，明确允许何种多页面结构。
- 结构合法性检查不能取代目标后置条件检查。对于 Sequence Diagram 操作，应验证目标消息确实存在、Customer 为 source、ResultList 为 target、标签为 `readResults()`，并确认生命线长度、激活条和销毁符号几何满足要求。
- 不能只依赖“XML 是否有变化”作为所有脚本的通用后置条件；也不应把一个无返回值、无变化的脚本自动当成业务成功。

### P1：让脚本返回可审计的 JSON 结果，再用 XML 作最终事实来源

建议每次结构化编辑都返回类似以下信息（示意，不是本次实际返回值）：

```json
{
  "operation": "add_sequence_message",
  "messageId": "new-message-id",
  "sourceId": "customer-lifeline-id",
  "targetId": "result-list-lifeline-id",
  "label": "readResults()",
  "postconditionsChecked": true
}
```

宿主仍要在 XML 中核对这些条件；脚本返回值只是定位和诊断证据，不能替代 XML 与保存 revision 的验证。

### P1：确认不匹配时保留可恢复状态，不要制造“确定未应用”的错觉

当导出的有效 XML 与请求不匹配时，应计算并记录 before/after diff，保留恢复版本，并把状态明确显示为“结果未确认”。在完成保存策略设计前，不应悄悄把这类状态等同于成功，也不能误报为完全未修改。

### P1：增加真实 Draw.io Sequence Diagram 回归测试

用原生 Sequence Diagram fixture 覆盖以下条件：

1. 新增 Customer → :ResultList 的 `readResults()` 消息；
2. 消息 source/target 与 lifeline 绑定正确；
3. ResultList lifeline 延长、销毁符号下移、激活条及消息几何关系正确；
4. 保存后重新解析 XML，确认修改确实存在；
5. 脚本返回 `undefined`、导出 XML 结构未通过确认、导出 XML 已变但业务后置条件缺失等情况；
6. 多页面文档中只有目标活动页改变时仍可正常确认；
7. 超时后 UI 报告与真实 XML/文件 revision 一致，且不虚构 rollback 成功。

必须在 pinned Draw.io 实际画布上运行 E2E；单纯测量 helper 函数不足以证明原生编辑器已提交、序列化和保存成功。

## 6. 本次故障的处理建议

在核实实际文件前，不要直接重试同一操作，以免重复添加消息或再次改变生命线几何。应先导出或备份当前文件，再与最近的保存版本比较，检查是否已存在 `readResults()` 消息，以及 ResultList 的销毁符号和激活条是否已经变化。

若原生画布与文件内容一致且没有目标变更，再重新执行；若已部分或全部变更，应先基于当前 XML 修正，而不是重复添加。

## 7. 相关代码与证据

- [DrawioFrame.tsx：原生编辑回执、export 与 unmatched/timeout 处理](v2/src/components/DrawioFrame.tsx)
- [native-edit-confirmation.ts：脚本结果的 XML 确认条件](v2/src/model/native-edit-confirmation.ts)
- [native-edit-confirmation.test.ts：脚本无变化可通过、缺少默认层会失败的测试](v2/src/model/native-edit-confirmation.test.ts)
- [studio-selection-plugin.js：脚本执行、批事务、回滚和脚本结果序列化](v2/plugins/studio-selection-plugin.js)
- [Draw.io Agent API Contract：脚本需返回结果，且仍以 XML/持久化回执为准](docs/DRAWIO-AGENT-API-CONTRACT.md)

