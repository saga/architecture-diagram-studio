# Architecture Diagram Studio V2：架构审查与改进建议

- 审查日期：2026-10-29
- 审查对象：main 分支的 V2 活跃实现、README、架构说明、关键 ADR、CI 工作流和测试结构
- 方法：基于可读取的源文件与设计文档进行静态审查；本次未本地安装依赖、运行测试或执行动态安全测试。
- 总体结论：核心方向合理，不建议推翻重做。主要改进点是运行边界、AI 执行结果一致性、布局适配复杂度、CI 可复现性和扩展能力的真实实现状态。

## 1. 总体判断

V2 已形成清楚的主线：Draw.io 原生 XML 是唯一持久化模型，嵌入的 Draw.io 负责编辑与序列化；Studio 负责 Copilot 编排、工作区/版本持久化、布局计算和最终结果确认。删除 DiagramDocument 及第二套画布，避免了不完整投影导致的 XML 丢失和双模型同步问题。这是正确的架构取舍。

当前挑战不是“抽象不够多”，而是跨越浏览器 iframe、React UI、Copilot SDK、Node.js 文件系统、版本存储和多种布局引擎时，必须持续维护同一份文档的身份、版本、页面范围和最终结果状态。代码中已经有 revision、XML hash、页面 ID、保存回执、超时协调和恢复机制；下一阶段应减少边界间重复实现，并用端到端不变量测试证明它们。

| 领域 | 判断 | 说明 |
|---|---|---|
| 原生 XML 单一事实源 | 方向正确 | 避免双模型和有损重建，应继续坚持 |
| Copilot 原生执行 | 有价值但复杂 | 能力广，正确性与运行时隔离必须区分 |
| 版本、恢复和保存确认 | 设计较成熟 | 重点验证超时、迟到结果和部分成功 |
| 自动布局 | 产品差异化强 | 多引擎也带来适配、维护和质量评估成本 |
| 扩展接口 | 需防止空壳抽象 | 接口存在不代表功能已注册、发现和执行 |
| 本地开发网络监听 | 用户已明确接受 | Vite dev/preview 绑定所有网卡是有意选择，不作为待修复问题 |
| CI 可复现性 | 有改进空间 | 使用 npm install，且 PR 工作流会回写 lockfile |

## 2. 已确认的架构优点

### 2.1 只有一份权威图模型

AGENTS.md、ARCHITECTURE-V2.md 和 ADR-0011 一致规定：原生 Draw.io XML 是持久化和版本历史的唯一模型。短期布局投影只用于计算，不持久化。这支持未知 shape、wrapper、自定义属性、多页和任意样式，也减少模型转换导致的静默数据损失。

架构不变量应继续明确为：新功能可以读取和分析 XML，但不能引入第二份可写的权威图模型。

### 2.2 AI 能力与常见操作快捷路径分离

ADR-0018 将 run_drawio_script 作为广泛的原生编辑能力，typed operations 作为常见操作的快捷路径，而不是能力白名单。这避免每增加一个 Draw.io 功能，就要在模型提示、schema、服务端和客户端分别增加一套专用操作，符合单用户工作台的目标。

但“脚本能运行”不等于“用户意图已实现”。脚本返回、XML 改变、文件保存和版本回执是不同阶段，不能混为一谈。

### 2.3 版本与并发控制已经是正式设计的一部分

代码中可见 revision/hash 校验、工作区保存的乐观并发检查、版本快照、变更集应用与补偿回滚、Copilot 超时/迟到结果处理等机制。这比单纯依赖编辑器 Undo 更适合保障自动化操作的可恢复性。

### 2.4 布局能力由 Studio 负责计算

ADR-0013 选择由 Studio 调用多个布局引擎，生成一次性计划，再通过原生编辑器应用几何变化。这样能提供可配置的引擎、参数与路由，同时保留原生 XML 为最终结果。

## 3. 主要问题与风险

### 已确认的用户决策：Vite dev/preview 监听地址

Vite 开发与预览服务绑定 `0.0.0.0` 是用户明确接受的选择，不作为待修复问题，也不再建议改成 loopback。该决策已写入 `AGENTS.md`，后续架构审查应遵守。此项仅针对 Vite dev/preview 监听地址，不代表 API 或其他服务的访问控制问题可以一概忽略。

### P1：原生脚本执行的隔离不是强制安全沙箱

**事实：** Draw.io 在独立 origin 的 sandboxed iframe 中运行；README 与 ADR-0023 明确指出这不是 OS 级沙箱。ADR-0023 也承认源码检查只能尽力防止常见异步/迟到修改，不能证明任意脚本同步，也不能在同一线程硬中断无限循环。

**风险：** origin 隔离能限制父子页面直接访问，但不等于可以限制脚本消耗 CPU、导航浏览器或绕过静态检查。版本历史和 Undo 能帮助恢复文档，却不能撤销浏览器卡死或其他外部副作用。

**建议：**
1. 保持脚本只在 Draw.io iframe 中运行，Node.js 文件系统能力仍由服务端明确提供；不要把 shell 或任意文件读写加入脚本上下文。
2. 为每次执行记录 request ID、文档 revision、页面 ID、脚本 hash、XML 前后 hash、结果分类、保存回执及迟到结果状态。
3. 明确区分浏览器 origin 隔离、执行正确性检查和进程级隔离/硬取消。
4. 只有未来确实需要不可信脚本或远程多用户时，再评估独立浏览器进程/容器；当前不必为了理论多租户而过度设计。

### P1：执行、导出、持久化与最终结果需要统一状态协议

**事实：** 操作横跨 Copilot 服务、Draw.io iframe、XML 导出、文件写入和服务端回执。ADR-0020/0023 已记录异步迟到修改、模型事务不平衡、watchdog 超时被误认为最终失败等问题。

**风险：** 可能出现“报告失败但实际已保存”或“报告成功但版本/文件未确认”。若 UI、iframe 和服务端分别维护状态机，后续修复容易再次引入竞态。

**建议：**
1. 明确统一状态机，例如 requested → executing → exported → persistence-pending → committed，并支持 failed、timed-out-pending-reconciliation、partial 等状态。
2. 全链路携带同一个 requestId、documentRevision 和 pageId；最终回执包含 before/after hash、version ID、操作摘要和确认来源。
3. watchdog 只负责标记等待超时/待协调，不独立决定文档失败；迟到结果由同一请求的协调器归并。
4. UI 文案从统一 outcome 类型派生，避免不同组件各自推断成功/失败。
5. 分开报告编辑器导出失败、源文件写入失败、版本记录失败，避免压成一个笼统的“AI 失败”。

这与现有 ADR-0020/0023 一致；建议收敛实现，不另起一套事务系统。

### P1：布局引擎数量较多，适配层可能成为维护热点

**事实：** 当前包含 ELK、Dagre、Graphviz WASM、MSAGL.js、Cytoscape.js 和 D3。不同引擎对图模型、方向参数、边路由、随机性、分组/容器语义和算法参数的假设不同。仓库已有多份布局故障分析，涉及分组、容器、parent/layer 解析、边几何与布局后连接线。

**风险：**
- 共享参数对某些引擎无意义，造成“看似可配置，实际被忽略”。
- 结果受随机种子、节点排序或运行时版本影响，难以比较和回归。
- 计算布局与应用布局边界不清，可能改动未选图层、嵌套组或容器内部结构。
- 引擎数量不等于实际价值；若缺少基准语料和质量指标，维护成本可能超过收益。

**建议：**
1. 定义统一的临时布局输入/输出契约，但不要把它变成第二个持久化模型。明确节点、边、父子关系、容器、锁定节点、相对锚点、waypoints、适用参数和不支持特性。
2. 适配器明确报告哪些选项已应用、哪些不支持/被忽略；禁止静默忽略用户设置。
3. 建立固定语料：简单有向图、循环图、无边图、分组/嵌套容器、非标准 root/layer ID、多页、多图层、相对几何、缺失边几何、长标签和大图。
4. 评估节点重叠、边交叉、边长、图面积、方向一致性、布局位移、非目标变化数和运行耗时；指标用于诊断，不用单一分数决定全部质量。
5. 优先保证 ELK/Dagre 的兼容性和可解释性；其他引擎按场景和测试覆盖决定产品承诺，不为算法数量继续扩张。

### P2：扩展接口定义与实际能力注册/发现存在概念落差

**事实：** v2/src/model/native-diagram-capabilities.ts 定义 operation provider、analysis provider 和 registry 等接口；README 同时说明当前没有通用能力注册表或 quality-analysis provider，布局是具体的 Studio-owned 功能。

**风险：** 维护者可能误以为质量分析、风格/结构插件已经能动态发现和执行；也可能促使简单功能过早进入通用抽象。

**建议：**
1. 对能力状态明确区分 implemented、contract-only、planned，文档与 UI 不要仅凭接口存在声称能力可用。
2. 只有至少两个真实实现共享相同生命周期时才引入动态 registry；当前布局可继续使用明确的 engine adapter registry，质量分析接口先作为未来契约。
3. provider 明确 API 版本、适用页面范围、参数 schema、诊断和失败行为；计划携带原始 revision 并由共同执行边界复核。

### P2：大型服务入口增加理解与修改成本

**事实：** v2/server/copilot-server.ts 约 94 KB，集中 Express 服务、环境配置、工作区/本地文件、版本、日志、变更集和 Copilot 路由等职责。App.tsx 也是活跃主 UI 的集中入口。

**风险：** 跨功能修改更难定位副作用；路由可能重复处理验证、日志和错误格式；测试可能依赖模块内部实现。

**建议：**
1. 不为追求文件小而机械拆分，按稳定领域边界渐进抽取：HTTP route registration、workspace/file services、revision/version services、Copilot orchestration、observability。
2. copilot-server.ts 逐步收敛为依赖装配、路由注册和服务启动；领域逻辑通过类型化服务接口注入。
3. App.tsx 按可独立测试的用户流程拆分，如编辑器生命周期、Copilot 执行状态、工作区/文件操作和布局设置；不重建第二画布或影子模型。
4. 每次只抽取一个有测试边界的职责，避免大重构和功能修复混在一个提交中。

### P2：CI 的依赖解析方式降低可复现性

**事实：** v2/package.json 定义测试、typecheck、build 和 E2E。当前 .github/workflows/v2.yml 使用 npm install，并在 PR CI 中把解析后的 package-lock.json 回写到 PR 分支。

**风险：** 依赖解析结果可能随时间变化；CI 在验证期间修改被测分支，使提交内容和实际测试的依赖图不完全一致；回写步骤增加权限、竞态和工作流副作用。

**建议：**
1. 将 v2/package-lock.json 作为受版本控制的源文件，由依赖更新者显式提交。
2. CI 使用 npm ci，不在验证过程中自动重写 lockfile；缺失或不匹配时让 CI 失败。
3. 若目前缺少稳定 lockfile，先单独提交锁定依赖的变更，再改 CI。
4. 保持 Draw.io bundle 的版本固定与 SHA-256 校验；可把下载、校验、解包和构建封装为可复用脚本，减少 workflow 重复。

### P2：测试应覆盖真实 Draw.io 文档不变量，而不只是功能路径

**事实：** 仓库已有 Vitest、Playwright E2E、XML schema/操作/持久化测试；CI 执行 typecheck、unit tests、build 与 native-canvas E2E。仓库也积累了工业 IoT、分组/容器、边几何、序列图等故障分析。

**风险：** 难点不在简单添加节点，而在任意合法 XML 经修改、布局、撤销/重做、导入导出后仍保留非目标内容。只覆盖常见形状会漏掉 wrapper、压缩 page、未知样式和非标准层级。

**建议：**
1. 建立真实 Draw.io fixture corpus，为每类操作断言未目标页面/图层、未知属性、wrapper、shape/style、HTML label、边端点、折叠组和页面元数据保持不变。
2. 增加不变量测试：XML 可解析、ID 不冲突、边端点有效、页面集合不变、未授权对象几何不变、revision 不匹配时零写入。
3. 对迟到脚本和 watchdog 做确定性模拟测试，验证 UI outcome、最终 XML 和版本历史一致。
4. 布局测试同时检查节点与边，不能只断言坐标存在或函数未抛错。
5. 每份历史故障分析最终对应可运行的回归用例；否则文档只能记录经验，不能阻止复发。

### P3：Agent 轨迹可从日志升级为可复现的执行记录

当前 Agent Traces 展示浏览器事件与服务端模型调用记录；token/cost 只在 SDK/provider 实际提供时显示，这种不臆测 usage 的原则正确。

建议给一次操作定义稳定 trace envelope：conversationId、requestId、workspaceId、documentRevision、pageId、模型/SDK 版本、脚本 hash、XML 前后 hash、布局引擎及参数、持久化 version ID 和最终 outcome。日志只保存必要字段并最小化 XML/提示词/用户数据，避免默认复制整份图文件。

目标是让“为什么操作没有生效 / 为什么 UI 说失败但文件变了”能够通过一个关联 ID 还原，而不是让日志变得更复杂。

## 4. 值得投入的创新方向

### 4.1 原生 XML 变更影响解释器（优先级最高）

比较操作前后的页面、cell、属性、style、geometry、edge terminals 与 wrapper，生成结构化 diff。对 AI 操作展示“实际变化”，不只展示模型自述的摘要。

价值：识别目标之外的变化；为用户解释结果；支持 Undo/恢复、Agent Trace 和自动回归；不需要恢复第二个图模型，只需针对原生 XML 做差异分析。

第一阶段只做 diff 和诊断，不拦截所有非预期变化；后续再按操作类型定义预期变化范围。

### 4.2 布局质量基准与稳定布局模式

多引擎本身不是最难复制的优势。更有价值的是面向架构图建立布局约束与质量评估：固定重要节点、保留局部区域、稳定相对锚点、限制跨容器连线、避免非目标区域移动，并展示质量变化。

可逐步增加节点重叠/边交叉/总面积指标、“仅整理当前区域”与“保持主干节点位置”约束、固定 seed 的可复现模式、引擎推荐依据及未满足约束报告。

### 4.3 基于运行时能力清单的自适应 Agent

项目已有 Draw.io runtime inspection、能力清单和参考资料路径。可以让 Agent 执行前确认 iframe 版本、API、shape class 和目标 cell 结构；失败后根据结构化错误修正脚本，而不是仅依赖越来越长的静态提示词。

能力清单是帮助模型理解运行时的事实数据，不是安全策略；inspection 结果也不能跨 revision/page 无限复用。

### 4.4 把历史故障分析转为自动化缺陷回归库

将已有故障报告转成 fixture、操作输入、预期不变量和失败分类，按序列图、C4、容器/分组、布局、撤销重做、文件 IO、超时/迟到结果分类。它能把已积累的工程经验变成持续保护，而不是继续堆积只供阅读的 Markdown。

### 4.5 做只读架构图诊断，不重建语义模型

直接检查原生 cell 并输出 findings，例如无效边端点、节点重叠、对比度不足、越界、容器布局冲突、重复标签和过多连线交叉。结果引用原生 page/cell ID，不持久化另一套图模型。这样可以逐步恢复质量检查价值，而不重建 ADR-0011 删除的双模型。

## 5. 建议的目标结构

```text
React UI
  ├─ Editor lifecycle / selection / feedback
  ├─ Copilot turn state + unified outcome
  └─ Workspace / file / layout controls
          │ typed requests + requestId + revision
          ▼
Local Node.js service
  ├─ HTTP routes + local-origin policy
  ├─ Copilot orchestration / model routing
  ├─ Workspace & file services
  ├─ Revision / version / recovery services
  └─ Trace correlation + final receipt
          │
          ├──────────────► Local XML/version storage
          ▼
Separate-origin Draw.io iframe
  ├─ Native editor and native XML serialization
  ├─ Typed shortcuts for common operations
  └─ run_drawio_script for broad native capability

Studio-owned layout adapters
  └─ disposable native-cell facts → layout plan → revision-bound native edit
```

关键约束：
- 原生 XML 仍是唯一持久化图模型。
- 异步操作绑定 request ID、文档 revision 和页面 ID。
- 只有持久化回执完成后才报告 committed。
- 布局只改计划允许的几何/路由，不重建整份 XML。
- 能力状态区分“接口存在”和“功能已实现”。
- 日志记录关联信息和 hash，不默认保存整份敏感图文件。

## 6. 建议实施顺序

### 第一阶段：降低高风险边界的不确定性
1. 遵守已记录的用户决策：Vite dev/preview 绑定 0.0.0.0 不作为待办；本阶段聚焦其他具体风险。
2. 复核 Copilot API、Draw.io 静态服务、文件接口与浏览器 Origin/Host 校验。
3. 以 requestId 为中心梳理 outcome 状态机，确保 timeout、late result、export、persist、version receipt 不产生矛盾状态。
4. 将 CI 改为 lockfile 驱动的可复现安装，移除 CI 自动回写 lockfile 的副作用。

### 第二阶段：提高布局与原生 XML 回归质量
1. 形成固定真实 Draw.io fixture corpus。
2. 把已记录的布局、序列图、容器、边几何故障转成自动化测试。
3. 给布局输出增加统一 diagnostics 与质量指标，标记不支持或被忽略的参数。
4. 实现 XML 前后差异解释器，供 Agent Trace 和质量诊断共用。

### 第三阶段：按真实收益演进
1. 按领域边界渐进拆分大型服务入口，不做一次性大重构。
2. 先实现只读质量分析 providers，再根据真实实现决定是否需要通用 registry。
3. 通过基准语料决定各布局引擎的产品承诺、默认选择与维护标准。
4. 只有出现明确的不可信代码执行需求时，才投资更强的进程级隔离。

## 7. 本轮修复记录（2026-10-29）

本轮已在代码中落地以下改动；CI 结果以对应 PR 的检查结果为准。

| 原问题 | 本轮改动 | 边界与后续验证 |
|---|---|---|
| 执行、导出、持久化与最终结果状态分散 | 新增 native-execution-protocol.ts 的统一回执/状态转换；Copilot trace、App 派发/超时/最终编辑器回执共享 operation request ID，并区分内部 editor request ID。超时记录为待协调，不等同于失败；只读脚本有独立完成状态。 | 当前 DrawioFrame → App 的桥接 API 仍以最终结果回执为主，尚未向 UI 暴露每个中间阶段的独立时间戳；不能据此声称已实现分布式事务。 |
| 布局引擎适配维护成本高 | 新增共享 adapter capability contract，并从当前引擎注册信息生成算法/方向/路由/参数诊断；每次 AI 布局请求记录已应用和不支持的参数。 | 没有继续增加引擎；六种引擎的维护成本仍然存在，后续应以固定 fixture 基准决定各引擎的支持范围，而不是只追求数量。 |
| 服务入口过大 | 将 Studio 配置历史解析、校验、配置加载、迁移与写入移至 v2/server/studio-config-history.ts；copilot-server.ts 负责装配该服务。 | 这是按稳定职责拆分的第一刀，不是声称服务入口已完全模块化；路由和工作区/版本服务仍需逐组迁移并保持测试边界。 |
| Agent 轨迹难以复现 | 增加 request/revision/page、脚本 hash、布局选项、编辑器最终状态、XML 前后 hash 的关联执行记录；新增原生 XML 变更影响解释器，按页面/cell 比较新增、删除、标签、属性、样式、几何与边端点变化。Trace 只记录有限的变更摘要，不复制整份 XML 或完整 cell 属性。 | App 现在会用同一 operation request ID 另记持久化回执事件，包含 serializedXmlRevision、persistedRevision、versionId 与服务端 acknowledgement；它还没有被合并成单个跨层 receipt 对象。后续应将两者收敛为同一 envelope，并把历史故障 fixture 转为回归测试。 |

## 8. 审查范围与限制

- 本报告基于 main 分支可读取的 README、AGENTS、架构说明、ADR、主要服务/模型接口、package scripts 和 CI 工作流。
- 本次没有逐行审查所有业务函数，也没有本地运行 npm test、npm run build、Playwright E2E 或进行网络安全测试。
- 模块化建议是可维护性判断，不等于已证明其中存在某个具体功能缺陷。
- 报告区分可从配置/ADR 确认的事实和需要动态验证的风险，不把风险描述成已复现漏洞。

## 9. 参考文件

- README.md
- AGENTS.md
- ARCHITECTURE-V2.md
- v2/README.md
- v2/package.json
- .github/workflows/v2.yml
- v2/server/copilot-server.ts
- v2/server/studio-config-history.ts
- v2/src/model/native-execution-protocol.ts
- v2/src/model/drawio-xml-diff.ts
- v2/src/layout/native-layout-adapter-contract.ts
- v2/server/copilot/runtime.ts
- v2/server/storage-layout.ts
- v2/server/workspace-diagram-change-set-apply.ts
- v2/src/model/native-diagram-capabilities.ts
- v2/src/model/drawio-runtime-contract.ts
- v2/src/model/drawio-xml-schema.ts
- docs/adr/0011-native-drawio-only-model.md
- docs/adr/0012-native-diagram-extension-contracts.md
- docs/adr/0013-studio-owned-layout-engines.md
- docs/adr/0018-ai-first-native-drawio-execution.md
- docs/adr/0023-native-script-runtime-boundaries-and-late-outcomes.md
