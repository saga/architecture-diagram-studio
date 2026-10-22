# Copilot 改进意图：根因与方案

## 根因

“理解意图”与“执行编辑”是两套互不相通的实现。前端正则（`useCopilotIntent.ts`，v2/src/hooks/useCopilotIntent.ts）能改色但句式固定写死；Agent（`intent-route.ts`，v2/server/copilot/intent-route.ts）只有选中和布局工具，改不了样式；选中的是单值返回（服务端 L189 v2/server/copilot/intent-route.ts、前端 L226 v2/src/hooks/useCopilotIntent.ts），又丢掉同轮解析结果，部分失败显示成“已完成”。

## 典型例子

“选中 Fidelity Insight 并改成红色背景”：正则因颜色在前、缺“背景色”关键词而不匹配，落到 Agent 后只能选中，用户却只看到“已选中”；同一正则还会把“Fidelity Insight 的”整体当成目标名而找不到元素。

## 为什么不能继续补正则

中文说法变化无穷，每补一条句式只修一个症状；正则与 Agent 各有一份能力清单，必然持续分叉；复合请求（选中 + 改色）在正则里更无法表达，而模型本来就擅长理解自然语言，缺的只是一个能表达“改样式”的可调用工具。

## 方案

1. 定义共享的原生编辑操作 schema（`select`、`set_label`、`set_style`、`move`、`resize`、`delete` 等），放在 `v2/src/model/`，客户端与服务端共用；`set_style` 只允许 `fillColor`、`strokeColor`、`fontColor` 等白名单键，颜色（含中文“红色”、“#f00”）统一归一化为 hex。
2. 给 Agent 一个 `propose_native_edits` 工具，一次提交多个操作（如“选中并改色”）；服务端只做授权校验、不改 XML，浏览器端用现有 `cell:batch` 执行（原子、失败回滚）。
3. 去掉选中早退逻辑，改为返回逐条执行结果加模型回复，未完成的部分明确说明。
4. 删除大部分前端正则，只留 `delete`、`rename` 等无歧义单指令，避免两套词汇表再次分叉。

## 约束

遵守 AGENTS.md，模型不得直写 XML，只能提交白名单操作；执行层（`studio-selection-plugin.js`）对 `style:<key>` 不做键限制，所以白名单必须在授权校验时拦住。

## 落地顺序

先写 schema 与单测，再加服务端工具并校验签名唯一、键名白名单、批量上限，然后改前端展示，最后收尾正则；用“选中并改成红色背景”做 e2e，验证变色且可回溯。

## 风险

Agent 调用约 20 秒，比正则慢，可保留极少数精确句式做快速通道，并在等待时展示进度。

## 验证

schema 单测覆盖语法与非法输入、颜色归一化（“红色背景色”、red、#f00）；服务端测试覆盖签名歧义、未找到、批量上限；前端测试覆盖部分失败时的提示文案，保证不再出现“看起来成功”的消息。
