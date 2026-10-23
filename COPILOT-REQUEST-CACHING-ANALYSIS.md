# Copilot 请求缓存与上下文优化：实现记录和剩余项

> 更新日期：2026-10-23 · 实现基线：本次优化提交后，以 main 分支实际 SHA 为准。
> 本文把性能观察与已实现的安全约束分开。没有基准测试或真实 provider usage 数据的收益，不标记为已证实。

## 结论

本轮先修正两个正确性边界，再优化重复解析和大上下文：SDK 会话复用区分工作区/主图/standalone 范围；工作区模式不再上传完整 XML，由服务端加载并核实权威快照；相同 XML revision 的验证结果和按页解析结果可在有界 LRU 中复用；工作区上下文只选取更相关的文件片段，并缓存仍匹配文件大小和修改时间的片段；模型列表刷新使用短生命周期的隔离 SDK client，不再重置运行中的 Copilot client。

## 已实施

### 1. 会话缓存必须以工作区范围隔离

会话复用不仅检查配置 revision、模型和 reasoning effort，也检查 scopeKey。此键包括运行模式及工作区 ID、根目录、主图路径。SDK session ID 的哈希包含同一范围，防止恢复到另一工作区/standalone 模式的历史会话。acquireSession 在确认需要新会话之前不再构建 system message 和工具定义。

普通编辑不会因为 XML revision 变化而重建对话；主图或工作区范围变化则不会复用原会话。

### 2. XML revision 与解析结果缓存

服务端仍对每次请求计算并核对输入 revision，并在进入模型之前读取工作区权威状态。只有验证成功的 XML 才能进入有界缓存；缓存对象不包含 XML 正文，只保存按 revision 与活动页 ID 派生的页面信息和 native edit targets。不同页面有独立索引，失败验证不会缓存。工作区权威状态不能缓存成旧值。

同时，寻找工作区当前不可变版本时改为从最新版本倒序检查，避免正常情况下为匹配一个当前版本而重新计算所有历史 XML 的哈希。

### 3. 工作区上下文缩小并可复用文件片段

每轮仍然重新扫描文件与元数据，避免使用 TTL 缓存隐藏外部文件变动；但只对当前请求选出的最多 40 个文件读取正文。内容预算从此前约 90,000 字符收紧到最多 26,000 字符，优先包含主图、少量其他图，以及按请求关键词匹配的代码和文档。README、AGENTS 和架构类文档获得优先级。

片段缓存按工作区、路径、文件大小和修改时间区分，并限制条目数及总字符量。日志增加 cacheHits、cacheMisses 和实际上下文字符数。修改外部文件后，扫描出的新大小或修改时间会导致缓存未命中。这个实现仍会扫描文件元数据；如需进一步降低扫描延迟，应基于跨平台文件监听和一致性验证独立评估，而不是仅加一个长 TTL。

### 4. 工作区请求只发送 revision

POST /api/copilot/intent 在 workspace 模式接受 documentRevision 并读取服务器保存的当前 XML；请求 revision 不匹配时返回 stale_context，不会用客户端 XML 或旧缓存绕过检查。standalone 模式仍必须发送完整 XML，因为服务器不持有该文件的权威快照。确认提案时也采用同样的模式区分。

### 5. 模型列表刷新不重启活跃运行时

常规模型列表仍使用进程内 TTL 和 in-flight 合并。用户显式刷新时，服务端用相同 Copilot 基础目录启动一个短生命周期的隔离 client 查询列表，结束后释放该 client。这样既能绕开 SDK 对空结果的内部缓存，又不会通过一次下拉列表刷新停止正在执行的会话。

运行时的 provider 配置仍在服务初始化时固定；修改环境中的 provider/host 后应显式重启服务，不能依赖模型列表缓存刷新完成 provider 热切换。

### 6. Prompt 字段顺序

首轮请求中的稳定工作区上下文与图上下文已移动到用户请求字段之前，以便支持 prefix caching 的 provider 有机会复用稳定前缀。但是否命中，以及可计费 input token 的具体降幅，取决于 SDK 最终构造的消息序列和 provider 行为，不能仅由 JSON 字段顺序推断。

## 当前明确不做

- 不缓存工作区权威状态、文件内容的失败读取或无效 XML 验证结果。
- 不缓存模型答案或任何带编辑副作用的 nativeEdits 响应。
- 不为 ETag 额外引入一次完整扫描；工作区文件列表接口仍可单独评估，但不应阻塞本轮主要优化。
- 不删除诊断价值明确的 /api/copilot/health。未使用的 /api/workspace/agent-context 可以单独清理，但不是缓存改造的前置条件。
- 暂不为聊天 PUT 加队列合并，也暂不改日志 JSONL 的读取和轮转；这两项属于后续 I/O 维护，不应与上下文/会话正确性修复混在一起。

## 仍需验证的事项

1. CI 必须验证 v2 的 typecheck、unit tests 与 native-canvas E2E。
2. 用大仓库和 5 MB 以上图文件比较优化前后 turn.workspace-context.loaded 的字符数、cache hits/misses、模型调用前墙钟时间。
3. 从 provider usage 对比 inputTokens、cachedInputTokens 与 cacheWriteTokens。未运行真实模型实验前，不声称 prefix caching 已命中或已经节省特定 token 费用。
4. 回归验证：修改文件后立即请求、切换主图/工作区、workspace↔standalone、空模型列表刷新，以及请求 revision 过期的分支。
5. turnLocks / sessionLocks 只保证同一会话请求串行，并不是请求幂等或结果缓存；若要避免重试重复执行，需要独立的 request ID 与幂等记录设计。
