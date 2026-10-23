# 事故分析：C4 重标请求整回合 50 秒看门狗超时（`turn.failed`）

用户请求：「把 XXX 变成 C4 的 user，bbb 变成 C4 external，其它两个都是通常 C4 system」
结果：「Copilot could not complete this request. No edit was confirmed.」+ 服务端 50 s watchdog 告警（`Copilot turn watchdog timed out after 50000ms`，`runtime.ts:517`）+ HTTP 502。

基线：HEAD `7e60a62`（含脚本契约/AST 校验/auto-confirm 等近期演进）。日志=time真实流水，全可复算。

---

## 一句话结论

**不是卡死、也不是网络挂起——是"预算被打光"**：模型在 50 s 预算里花了 **46 s（92%）做 reasoning 流式思考**（8,813 个 reasoning delta / 32.7KB），剩下 1.35 s 刚开始写 `propose_native_edits` 的脚本参数（仅 1,263 字节，还在写 C4 person/external/system 的 stencil 与样式串），看门狗到点把整回合取消（reason=`user_initiated`）。50 s 这个固定预算（`intent-route.ts:821` 硬编码 50000）对"会思考的 BYOK 模型 + 长上下文 + 脚本类任务"太小了。

---

## 时间线（实证，`copilot-sessions.jsonl`）

| 时刻 | 事件 | 数据 |
| --- | --- | --- |
| 09:52:23.359 | request.received（sessionId 沿用自 03:05 的同一会话） | prompt 56 字；`reasoningEffort: high`；cellCount 7 |
| 09:52:23.633 | turn.model-call.started（attempt 1，timeoutMs 50000） | turn.send({prompt}, 50000) |
| 09:52:26.567 → 09:53:12.204 | **reasoning 流持续 45.6 s** | 8,813 个 `assistant.reasoning_delta`，共 **32,702 字节**（≈711 B/s，≈7–9k tokens 的思考） |
| 09:53:12.256 → 13.606 | tool-call（`propose_native_edits`, call_00_AJAlS0cy…）流仅 **1.35 s** | 466 个 `inputDelta`，共 **1,263 字节**：脚本已写到 `catch (e) {}` / `personStencil` / `personStyle='rounded=1;…fillColor=#08427B…'` / `systemStyle='…fillColor=#1168BD…'`（C4 配色 + 形状重塑计划，远未写完） |
| 09:53:13.636 | 运行时取消 | SDK 事件 `model_call_cancelled(reason user_initiated)` → `turn_failed` → `turn_ended`；stream 中止于 34,207 字节响应 |
| 09:53:13.643 | turn.failed | durationMs 50277，errorMessage watchdog；随后 HTTP 502（`intent-route.ts:983`） |

**关键量化**：reasoning 占 45.6/50.0 s（**92%**），tool-arg 生成只占 1.35 s。即便没有 watchdog，按当时 ~936 B/s 的 tool-arg 速度，把整个 C4 重塑脚本写完（估计 4–8KB+）还需 5–10 s 以上，单次模型调用总计也要 55–60 s —— **固定 50 s 预算下这次任务在数学上就不可能在一回合内完成**。

## 为什么会走到这一步（三层根因）

1. **固定预算与"会思考"的模型不匹配**。预算是 `intent-route.ts:821` 硬编码的 `50000`（attempt2 也是 `25000`，`:834`，但 attempt2 只在"模型完整返回却没调 native 工具"时触发，本例模型流被打断，直接 turn.failed，不会进 attempt2）。`runtime.ts:513-521` 的 watchdog 是**纯钟表超时**：台上每 50 ms 都有 delta 真实流过（8813 个 reasoning chunk），它无进度感知，到点即杀。有进展 ≠ 会被续期。
2. **会话上下文单调膨胀**。同一 sessionId 从 03:05 一路用到 09:53，无压缩。当天同会话完成调用的 input tokens 趋势：
   | 时刻 | input | cached | durationMs |
   |---|---|---|---|
   | 03:05 | 24,801 | 13,568 | 6,543 |
   | 03:47 | 43,847 | 23,296 | 8,867 |
   | 04:01 | 62,632 | 33,536 | 15,716 |
   | 07:25 | 83,825 | 44,160 | 17,454 |
   | 09:52（本回合，未完成） | 估计 ≥100k | — | ≥50s |
   Context 翻 4 倍 → prefill 与逐 token 解码都变慢，同样质的思考/输出花更长时间，预算被更快吃掉。
3. **C4 类任务被引导成"大脚本"**。尽管最新的二次提示词（`intent-route.ts:829`）已改为"prefer multiple typed operations … run_drawio_script only for actions that typed operations cannot express"，但从流式内容看模型仍计划用**单个脚本**同时完成"换 C4 形状 stencil + 重标 + 配色"（person/external/system 三套 `shape=…`/样式串 inline 生成）。这类任务其实完全可用 typed 组合（`set_label` ×N + 新 `set_cells_style`）表达——说明书/契约里还没有 C4 配方（语义层报告 Tier2 的缺口在"领域配方"上）。

顺带：`reasoningEffort: high`（本轮 request 自带；session 一直 high）在本任务也是预算消耗放大器——一个重命名+配色的任务用了 ~8k tokens 的思考。

## 这次守住了什么（都验证过）

- **fail-closed 干净**：模型流在 tool-args 中途被取消 → tool call 从未完整提交 → 服务器无 dispatched 批次 → 插件无参与、XML 未动、无落盘。比上一起事故更早被拦（在离编辑器更远的地方）。
- **watchdog 目的成立**：注释写明它是防"stuck external-tool dispatch / tool loop"的兜底（`runtime.ts:510-511`）；`abortAfterWatchdog` 有界清理（`:540,:554+`），HTTP 立刻 502 而非挂死。本次证明该路径工作正常。
- **观测链完整**：终端里 `[studio:ERROR] turn.failed`、`[studio:WARN] copilot.intent.outcome` 与客户端 `[studio:v2]` 事件都对上了（前一轮报告 D1 修复已在生效）。当日全天 turn.failed 仅此 1 例，非系统性雪崩。

## 修复建议（优先级 + 锚点）

| 级别 | 建议 | 位置 | 说明 |
| --- | --- | --- | --- |
| P0-1 | **预算分级 + 进度感知**：把 50000 提为具名配置（如 `COPILOT_TURN_TIMEOUT_MS`，默认仍 50s），按模型/effort 放大（会推理的 BYOK 模型 high 建议 ≥120s）；watchdog 结构改成"斜杠"双闸：**总上限**（放宽后的整回合上限）+ **空闲上限**（超过 N 秒无任何 delta 才判死）。这样"在正常流式"不会被冤杀，而真挂死仍被兜住 | `intent-route.ts:821,834`；`runtime.ts:512-521`（race 改造为 idle-reset 定时器） | 候选最小改动：仅做常量化 + 按模型放大，不做 idle 感知 |
| P0-2 | **会话压缩/轮换**：同 session 持续 5h+、context 4×增长。设阈值（如 input≈80k 或 turns≈N）自动开新会话并注入上一段摘要；或利用 SDK 的 compaction 机制。注意保留 History/版本回放不受影响 | runtime 会话管理（`createSession`/`resumeSession` 路径） | 这是"为什么回合普遍变慢"的全局性收益，不止救本例 |
| P1-3 | **effort 校准**：默认值与任务复杂度解耦；重命名/配色类默认 low/medium。`copilot-server.ts:53` 类型里只有 high/max，扩 low/medium 并在 UI 说明 | runtime `resolveEffort` + 客户端设置 |  |
| P1-4 | **C4 配方 + typed 化**：契约文档（0188dcd 已引入 runtime contract）补"领域配方"：C4 user/external/system = `set_label` + `set_cells_style`（改 fillColor/strokeColor/fontColor，如 #08427B/#999999/#1168BD）；若需换形状，走已就位的 insert-only AST 校验路径按 cell 提交 `set_style`。让这类请求从"写 8KB 脚本"变成"3–6 个 typed op" | `docs` 契约文档与 schema description（`native-edit-tool-schema.ts:53` 已有骨架） | 同时服务语义层报告 Tier1/Tier2 |
| P1-5 | **文案准确化**：`runtime.ts:982` 的 "Shorten the instruction" 对本例是误导（不是指令太长，是预算/上下文问题）。区分两类超时："模型在思考/流式中被预算终止"vs"完全无响应"，分别给"重试/降低推理强度"与"缩短指令/检查网络" | `runtime.ts:982`、`intent-route.ts:983` |  |
| P2-6 | **流式打点**：`writeLog` 增加 `turn.streaming.progress`（每 ~5s：已收 delta 字节数、model-call phase=reasoning/tool-args），把"reasoning 吞预算"从后验诊断变成实时可观测指标（同时也为 P0-1 的预算参数提供量化依据） | runtime `sendWithRecovery`（已有 on() 事件挂点，`:493-502`） |  |

## 与既有报告的衔接

- `V2-CODE-REVIEW-2026-10-23.md` P0「回合无取消、队列无上限」：本次证明 watchdog 单回合兜底有效，但队列/取消语义与预算治理仍是缺口（50s 队首阻塞 + 长会话无压缩）。
- `V2-SEMANTIC-LAYER-ASSESSMENT-2026-10-23.md`：runtime contract/schema 速查/AST 校验/auto-confirm 已快速落地（`0188dcd`/`7c6afac`/`c28a114`/`01bbd39`…），本报告的 P1-4 是其"领域配方"第一步的自然后续；P0-1/P0-2 与上述 Tier 治理互补（契约解决"写对"，预算治理解决"来得及写"）。
- `V2-CURVED-SCRIPT-INCIDENT` D5（模型抢跑成功散文）：本例相反方向——流未完成即被杀，没有任何散文/UI 别名，最终文案 accurate。D5 风险未触发。

## 附：复现路径（同环境想要排查）

```bash
# 1. 看本回合全量流
grep '52de4f13' ~/.architecture-diagram-studio/logs/copilot-sessions.jsonl
# 2. 会话输入膨胀曲线
grep 'turn.model-call.completed' ~/.architecture-diagram-studio/logs/copilot-sessions.jsonl \
  | grep 2026-10-23 | python3 -c '…'  # 见正文表格
# 3. 处理：P0-1 常量化后 50000→120000 于 intent-route.ts:821（或环境变量）
```
