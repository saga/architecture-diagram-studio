# draw.io 渲染、自动布局与 Desktop CLI 集成分析

- 日期：2026-10-20
- 适用项目：Architecture Diagram Studio
- 状态：技术方案分析，尚未实施本报告中的迁移建议

## 结论摘要

**建议先保留现有 React Flow 画布、布局算法和六种主题，并将 draw.io Desktop CLI 纳入本地处理与验证流程；不要仅为获得自动布局而立即替换画布。**

本次分析确认，draw.io Desktop 不只是一个桌面 GUI。当前上游仓库的命令行实现支持输入文件、输出文件、XML/SVG/PNG/JPEG/PDF/HTML 导出、布局参数，以及导出前的模型规范化。因此，在用户已经安装 Desktop 的前提下，Studio 可以从本地 Express 服务通过子进程调用 CLI 来处理文件，而不需要先部署在线 Embed Editor。

但 Desktop CLI 不是长期运行的交互式编辑 API，也不是可嵌入 React 组件中的原生画布。它执行的是文件任务：读入文件，按参数处理或布局，再将结果写入文件。用户在 Desktop GUI 中编辑后，Studio 需要通过显式重新导入、文件监控或刷新流程取得变更。

如果需求升级为“Studio 内部的可编辑画布必须直接使用 draw.io 的原生渲染”，那么应单独评估 Web Embed Editor。它通过浏览器 iframe 加载 Web 编辑器并使用消息协议通信；它和本机 Desktop CLI 是两种不同集成方式。

## 1. 本次要解决的产品问题

Architecture Diagram Studio 不是单纯的 draw.io 文件生成器。项目当前目标包括：

- 使用 Copilot SDK / MCP 依据业务上下文创建和修改架构图。
- 用版本化 Diagram Document 保存节点、关系、业务含义、几何和其他元数据。
- 提供适合架构图的多种自动布局以及可重复使用的布局预设。
- 为画布提供可辨识的视觉主题，而不是接受单一的默认外观。
- 导出可在 diagrams.net / draw.io 中继续编辑的原生文件。
- 减少 React Flow 浏览器渲染与 draw.io 原生渲染之间的外观差异，并建立真实的视觉验证。

严格的像素一致性不是“导出 XML 成功”就能保证的。字体度量、自动换行、图形原语、边框位置、形状实现、容器、端口锚点、连线路径以及不同操作系统的字体都会影响最终输出。需要先定义权威结果由谁渲染，再设计架构。

## 2. 已核对的现有项目基础

截至报告日期，当前 main 分支具备以下基础：

- React + TypeScript + React Flow 编辑器。
- 版本化 Diagram Document，业务语义与画布状态已有初步分离。
- 四类布局引擎：ELK、Dagre、D3 Hierarchy、D3 Force；ELK 包括 Layered、Mr. Tree、Radial、Stress 和 Force 算法。
- 可配置方向、间距、部分边路由选项、端口/连接点，以及保存到关系模型中的路径点。
- 六种编辑器主题：Studio、Editorial、Midnight、Blueprint、Minimal Mono、Vibrant。
- 原生 draw.io XML 导出器，将节点位置、尺寸、标签、关系、端口锚点和可选路径点映射成 mxGraph XML。
- 本地 Express 服务、图形持久化、Copilot SDK 与 stdio MCP 入口。
- 现有导出器有单元测试，但 README 仍指出：尚未在 diagrams.net 中自动进行完整打开/渲染往返验证，不能保证浏览器与 draw.io 像素一致。

相关代码与设计文件：

- [README](../README.md)
- [现有布局引擎](../src/layout/layout.ts)
- [现有 draw.io XML 导出器](../src/export/drawio.ts)
- [Diagram Document](../src/model/diagram.ts)
- [导出保真和验证计划](export-fidelity.md)
- [编辑器无关 IR 的 ADR](adr/0001-editor-independent-ir.md)
- [图形类型与布局策略的 ADR](adr/0002-diagram-specific-layout.md)
- [原生优先导出的 ADR](adr/0003-native-first-export.md)

## 3. draw.io Desktop CLI：确认的能力与边界

上游仓库：

- [drawio-desktop](https://github.com/jgraph/drawio-desktop)
- [CLI 参数定义](https://github.com/jgraph/drawio-desktop/blob/dev/src/main/args.js)
- [CLI 导出执行流程](https://github.com/jgraph/drawio-desktop/blob/dev/src/main/electron.js)
- [draw.io FAQ：命令行导出](https://github.com/jgraph/drawio/wiki/FAQ)
- [Desktop 发布版本](https://github.com/jgraph/drawio-desktop/releases)

当前上游开发分支的 CLI 参数定义包含以下能力：

| 能力 | 参数或方式 | 含义与限制 |
|---|---|---|
| 文件输入 | 位置参数传入文件/目录 | 是文件路径输入，不是通用 stdin 流式 API |
| 文件输出 | --output / -o | 结果写入指定文件或目录，不是通用 stdout 数据接口 |
| 批量转换 | --export / -x | 可处理输入文件，也支持文件夹扫描 |
| 指定格式 | --format / -f | 当前实现列出 pdf、svg、png、jpeg/jpg、xml、html |
| 导出前布局 | --layout | 支持预设名称或布局 JSON 配置数组；布局在打开/导出处理阶段执行 |
| 模型规范化 | --normalize | 修复部分生成模型的结构问题，例如边的父级和缺少几何；容器可能扩展以容纳子节点 |
| 图像输出参数 | --scale、--width、--height、--border、--transparent、--size 等 | 用于控制图像尺寸、边框、背景和页面范围 |
| 自动化错误处理 | --timeout 等 | 可限制单个文件的处理时间；调用方仍需处理退出码和缺失输出 |

示例：把现有图形渲染成 SVG 预览。

    drawio --export --format svg --output ./preview.svg ./architecture.drawio

示例：按自定义 ELK Layered 参数重新布局，然后输出可编辑的 XML 文件。

    drawio --export --format xml --layout '[{"layout":"elkLayered","config":{"elk.direction":"RIGHT","elk.spacing.nodeNode":"64","elk.layered.spacing.nodeNodeBetweenLayers":"90"}}]' --output ./relayout.drawio ./architecture.drawio

示例：使用预设布局。

    drawio --export --format xml --layout horizontalFlow --output ./relayout.drawio ./architecture.drawio

以上是示例命令。实际可用参数以用户机器上安装的 Desktop 版本执行 --help 的输出为准。上游 dev 分支不应自动视作所有用户已安装版本；应明确支持版本范围，并对实际安装版本做能力检测。

### Desktop CLI 的核心限制

1. 它是一次性文件任务流程，不是常驻 RPC/HTTP 服务，也不直接向 React 提供一个可编辑的图形画布。
2. 本报告核对的 CLI 输入/输出接口以文件路径和文件落盘为中心；不要假设它支持通用 stdin/stdout 流式传递 XML。
3. --layout 是 draw.io 自己的布局流程。它会改变图形几何，不应在每次普通导出时隐式执行。
4. CLI 进程完成后不会持续同步 Desktop GUI 后续的手工编辑。Studio 必须实现用户可理解的重新导入/刷新流程。
5. macOS、Windows 与 Linux 均有 Desktop 构建，但可执行文件位置、安装方式、权限、PATH 和参数转义有所不同。
6. CLI 与文件往返仍需要在支持的 Desktop 版本上做集成测试；不能仅凭参数解析单元测试宣称图形往返无损。

建议由本地 Express 服务使用 Node 的 spawn/execFile 以参数数组调用 CLI，避免把用户路径和 JSON 拼成一整条 shell 命令。实现可配置的可执行文件路径，例如 DRAWIO_EXECUTABLE，并提供 macOS / Windows 的默认路径探测、超时、退出码、stderr、结果文件存在性和尺寸检查。无法探测到 Desktop 时，清楚提示用户配置路径，而不是静默回退成不同的渲染器。

## 4. 不要混淆三种集成方案

| 方案 | 渲染/交互归属 | 自动布局 | 能否在 Studio 内编辑 | 是否依赖本机 Desktop | 适合场景 |
|---|---|---|---|---|---|
| React Flow + Studio 自有布局 | React Flow / React 组件 | 现有 ELK、Dagre、D3 | 可以 | 否 | Studio 内完整业务交互、多种自定义布局和主题 |
| draw.io Desktop CLI + 文件往返 | CLI 处理文件；GUI 单独打开 | 支持 --layout，也可不调用 | 不能直接在 Studio 画布内编辑；需另开 Desktop 并再导入 | 是 | 本地处理、离线渲染、导出、验证和人工原生编辑 |
| draw.io Web Embed Editor | iframe 内的 draw.io Web 编辑器 | 支持通过 Embed 协议触发布局 | 可以 | 否 | 需要在 Studio 内直接使用 draw.io 原生编辑器和渲染结果 |

Web Embed 的官方资料：

- [draw.io Embed mode](https://www.drawio.com/doc/faq/embed-mode)
- [draw.io Wiki FAQ](https://github.com/jgraph/drawio/wiki/FAQ)

Embed Editor 与 Desktop CLI 不可互换。前者是浏览器内的交互式编辑器；后者是本机文件处理程序。不要期待只安装 Desktop，就能把 Desktop 的图形编辑画布直接嵌到普通 React 页面中。

## 5. 推荐方案：现有布局算法 + 原生 XML 样式映射 + Desktop CLI 验证

当前阶段不建议因自动布局的外观问题立即迁移整个编辑器。先用最小改动验证是否能达到目标。

### 5.1 各模块职责

1. **Diagram Document（语义与几何模型）**  
   继续保存稳定 ID、图形类型、业务标签、关系、证据、节点尺寸/位置、端口和路径点。业务语义不能只存在于 React Flow 的 nodes/edges 中。

2. **Layout Service（布局引擎）**  
   继续让用户选择 ELK Layered、Mr. Tree、Radial、Stress/Force、Dagre、D3 Hierarchy、D3 Force 等策略。计算结果是逻辑画布坐标和连接线几何。现有布局与 draw.io 的布局算法并非一一对应，不应把它们静默替换成名字相近的 draw.io 预设。

3. **Theme / Style Adapter（样式映射）**  
   把 Studio 的视觉主题转换为 mxGraph 原生样式字符串，覆盖标准节点与边的形状、填充色、边框色、字体色、字体大小、圆角、线宽、虚线、箭头和端口锚点。六种主题的语义可保留，但它们需要重新定义为可导出的原生样式 token，而不能只依赖 React CSS。

4. **draw.io XML Exporter**  
   输出原生可编辑节点和边，使用 IR 中已经保存的几何；导出本身不应触发布局。应把 parentId 映射为正确的容器父子关系，并验证嵌套 C4 boundary、容器尺寸与内部节点的行为。目前导出器把节点放在统一 parent 下，因此嵌套容器需要单独补齐。

5. **Desktop CLI Adapter（可选本地工具）**  
   调用已安装的 Desktop 执行 SVG/PNG 导出、可选原生布局、规范化和视觉回归。它是辅助处理与验证工具，不是首要的应用画布。

6. **Desktop 打开/重新导入流程**  
   提供“用 draw.io Desktop 打开文件”和“从已编辑文件重新导入”的明确操作。不要在后台默默覆盖用户手工编辑的文件；需检测文件变更、保留备份并提示冲突。

### 5.2 六种主题如何保留

| Studio 主题 | 建议的原生样式方向 |
|---|---|
| Studio | 清楚的层级、克制的底色、圆角和清晰连接线 |
| Editorial | 低饱和配色、细边框、较弱装饰 |
| Midnight | 深色填充、对比明确的字体与边框 |
| Blueprint | 工程图配色和一致的线条语言 |
| Minimal Mono | 黑白灰、细线、减少额外装饰 |
| Vibrant | 更明显的节点分类色与强调色 |

应将每种主题作为显式样式 token 集合保存，而不是只保存一个 UI theme 名称。原生图形能够表达的标准样式优先使用原生 mxGraph 属性；复杂自定义图形可以评估 SVG，但 SVG 作为图形时的可编辑性弱于原生节点，不能为了外观而把整张图无差别扁平化。

### 5.3 Layout 与 Style 必须分开

- Layout 决定位置、节点尺寸约束、分层方向、节点间距、层间距、端口和边路径。
- Style 决定填充、边框、字体、圆角、箭头和主题色。
- 只切换主题时，不应自动执行全图布局。
- 只切换布局时，应尽量保留当前主题。
- 普通导出时，应使用已保存几何；不能暗中调用布局。
- 只有用户明确请求“使用 draw.io 原生布局”时，才用 CLI 的 --layout 修改几何。

这样既能保留你偏好的 React Flow 布局审美与主题，也能让最终输出使用 draw.io 原生图形和样式。它不会自动保证浏览器画布与 draw.io 每个像素一致，但能减少结构和样式差异，并为差异建立可复现的验证机制。

## 6. 像素保真：目标需要分级

“像素级”至少有三个不同等级，需要在产品中明确区分：

### A. 结构和几何一致

节点位置、尺寸、关系、标签、端口锚点和手工路径点在导出的 XML 中保持一致。这是当前原生 XML 导出器可以继续强化的目标，也最适合作为自动化单元测试的基础。

### B. 视觉接近

React Flow 的主题和节点外观被系统性映射到 draw.io 原生样式，使用 Desktop CLI 输出 SVG 对照并修复可控差异。字体、HTML/文本布局以及不同形状实现仍可能产生差异。

### C. 由 draw.io 自己渲染，追求同一渲染器的结果

如果 Studio 需要显示结果本身就由 draw.io 渲染，CLI 可以生成只读 SVG 预览；但它不是可编辑画布。若需要在 Studio 页面中直接拖拽、连接、编辑并保持 draw.io 原生渲染，则应进一步评估 Embed Editor。若图形数据不能交给公共在线服务，还需评估自托管 Web 部署，并验证所选版本的 Embed 协议和部署方式。

即便使用同一套 draw.io 渲染器，跨操作系统的字体与系统渲染环境仍可能不同，因此不能不经验证就承诺 macOS 和 Windows 的截图逐像素相同。需要固定字体、固定版本、明确截图环境并设定可解释的视觉回归容差。

## 7. 推荐的实现与验证步骤

### 阶段 1：验证 Desktop CLI，而不迁移画布

- 在 macOS 和 Windows 测试机器安装受支持的 draw.io Desktop 版本。
- 对安装程序、MSI/便携版本以及 PATH 场景做探测测试。
- 运行 --help，记录实际版本和支持的参数。
- 准备含长标签、Unicode、数据库形状、外部系统、并行边、自环、多条路径、分组和嵌套容器的 fixture。
- 测试输入 .drawio，导出 .drawio XML 和 SVG；分别测试不布局、--normalize、--layout 的输出。
- 记录 exit code、stderr、耗时、输出文件和 XML/图像大小。

### 阶段 2：强化现有原生导出器

- 补足 parentId 与嵌套容器映射。
- 增加可版本化的主题 token，并将六种主题映射到原生图形样式。
- 对端口锚点、手工 waypoints、关系标签、重叠边与环路增加 fixtures。
- 确认普通导出是纯函数，不会重算布局或丢掉手工几何。

### 阶段 3：自动化真实渲染验证

- 用 Studio 导出 XML。
- 用固定版本的 Desktop CLI 生成 SVG 或 PNG。
- 将生成结果与人工审核过的基准图做视觉回归。
- 同时对 XML 做语义检查，避免图像差异测试无法发现隐藏关系丢失。
- 对不同系统分别维护基准，或固定字体与运行环境；不要使用一个未经校准的全局像素阈值。
- 测试 XML 在 Desktop 中打开、编辑、保存后重新导入 Studio 的往返流程。

### 阶段 4：按需要决定是否更换画布

只有当“Studio 内必须用 draw.io 原生渲染和直接交互编辑”成为硬性需求时，才以 Embed Editor 做独立原型，与 CLI 方案比较保真度、隐私、可操作性和维护成本。不要把 Desktop CLI 误当作可嵌入画布。

## 8. 本地服务调用规范建议

通过现有 Express 服务统一封装一个 Desktop CLI adapter：

- 可通过配置覆盖 draw.io 可执行文件路径；自动探测失败时给出清楚的修复提示。
- 使用 spawn/execFile 参数数组调用，避免 shell 注入以及路径/JSON 引号问题。
- 在应用设置中显示检测到的可执行路径、Desktop 版本、CLI 可用性。
- 每次任务使用独立临时目录和输出路径，完成后检查退出码、stderr、文件存在性和文件大小。
- 配置超时与取消策略；清理临时文件。
- 对同一个输入文件避免并发覆盖；使用原子替换或独立版本文件。
- 不在每次普通保存/导出时自动执行 --layout。
- 明确告知用户哪些操作会改变节点位置，以及布局后如何撤销/恢复。

Desktop 仓库描述其应用以本地为主要运行方式，不向外部发送图形数据；但图形仍可能引用外部图片或字体 URL。对于企业内部图形，应避免在没有安全评估的情况下将敏感内容发送给公共在线 Embed 服务。

## 9. 最终决策

当前建议顺序如下：

1. **短期：保留 React Flow 与现有布局算法，完成主题到原生 draw.io 样式的映射，并把 Desktop CLI 用于 SVG 渲染、原生文件检查及视觉回归。**
2. **中期：补足嵌套容器与文件往返，把“用 Desktop 打开”和“重新导入修改后的 XML”做成明确、无静默覆盖的工作流。**
3. **长期：如果产品确认必须在 Studio 内直接编辑且同时保持 draw.io 原生渲染，再评估 Embed Editor；不要仅因为原生布局好看与否而迁移画布。**

如果最优先的是“Studio 内好用的多种自动布局和视觉主题”，React Flow 仍然有价值。如果最优先的是“Studio 内的画布本身必须由 draw.io 原生渲染”，Embed Editor 更贴近目标。如果最优先的是“本机处理、原生 XML、离线 SVG 导出与自动化验证”，Desktop CLI 是现在就可用的补充能力。

## 10. 参考资料

### 本项目

- [Architecture Diagram Studio README](../README.md)
- [Layout implementation](../src/layout/layout.ts)
- [draw.io XML exporter](../src/export/drawio.ts)
- [Diagram model](../src/model/diagram.ts)
- [Export fidelity and verification plan](export-fidelity.md)
- [ADR 0001: Editor-independent IR](adr/0001-editor-independent-ir.md)
- [ADR 0002: Diagram-specific layout](adr/0002-diagram-specific-layout.md)
- [ADR 0003: Native-first export](adr/0003-native-first-export.md)

### draw.io / diagrams.net 官方与上游项目

- [drawio-desktop repository](https://github.com/jgraph/drawio-desktop)
- [Desktop CLI argument definitions](https://github.com/jgraph/drawio-desktop/blob/dev/src/main/args.js)
- [Desktop CLI export execution](https://github.com/jgraph/drawio-desktop/blob/dev/src/main/electron.js)
- [Desktop README: platforms and security model](https://github.com/jgraph/drawio-desktop/blob/dev/README.md)
- [Desktop releases and release verification notes](https://github.com/jgraph/drawio-desktop/releases)
- [draw.io Wiki FAQ: command-line export and programmatic diagram generation](https://github.com/jgraph/drawio/wiki/FAQ)
- [draw.io Embed mode](https://www.drawio.com/doc/faq/embed-mode)
- [draw.io file format](https://www.drawio.com/doc/faq/diagram-source-edit)
- [draw.io style reference](https://www.drawio.com/doc/faq/diagram-styles)

### 证据边界

本报告核对了项目当前 main 分支的 README、布局和 XML 导出实现，以及 drawio-desktop 上游开发分支中的 CLI 参数定义与导出流程。它是一份技术方案分析，不代表已在 macOS/Windows 机器上执行了所有 CLI 命令，也不代表已经完成 Desktop XML 往返或像素级视觉验证。实施前必须对计划支持的 Desktop 发布版本进行真实集成测试。
