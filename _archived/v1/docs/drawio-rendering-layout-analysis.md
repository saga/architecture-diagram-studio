# draw.io 渲染、自动布局与 Desktop CLI 集成分析

- 日期：2026-10-20
- 适用项目：Architecture Diagram Studio
- 状态：技术方案分析，尚未实施本报告中的迁移建议

## 结论摘要

**建议优先验证本地打包 draw.io Web 编辑器：保留现有 React Flow 布局算法与六种主题作为几何和样式适配层，使用 draw.io Web 作为原生渲染/交互画布。用户无需安装 Desktop；CLI 只作为可选测试工具。**

draw.io 本身提供 Web 编辑器资源。上游仓库将生产模式使用的 minified bundles 直接提交在 src/main/webapp 中；VS Code Draw.io Integration 扩展通过 Git submodule 固定 draw.io 版本，把这一目录随扩展发布，并在 Webview 中加载。Studio 可以借鉴这种做法，随应用发布固定版本的 draw.io Web 静态资源，在同源 iframe 中运行它，不依赖公共 Embed 服务或本机 Desktop。官方 Getting Started 与 FAQ 说明如何运行和自托管该目录。

Desktop CLI 仍然只是文件任务接口，不是嵌入式交互画布。采用本地打包的 draw.io Web 编辑器后，正常编辑、自动布局和 XML 保存都应通过 Web 编辑器及消息协议完成，不需要启动本机应用。Desktop CLI 仅保留为开发/测试期可选的 SVG 导出和视觉回归工具。

如果需求是“Studio 内部的可编辑画布必须直接使用 draw.io 原生渲染”，优先评估本地打包的 Web 编辑器，而不是默认走公共在线 Embed。它通过浏览器 iframe 加载项目随附的静态资源并使用消息协议通信；在线/自托管 Embed 与本地打包是两种不同的资源分发方式。

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

## 5. 推荐方案：现有布局算法 + 原生 XML 样式映射 + 本地 draw.io Web 验证

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

## 9. VS Code Draw.io Integration 扩展的渲染实现

本节分析 [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio)（VS Code 扩展名为 **Draw.io Integration**）的当前公开实现。它提供了一个对本项目很有参考价值的模式：**将 draw.io Web 应用本身打包到宿主应用中，在宿主的 Webview 里运行，而不是用 React Flow 仿制 draw.io 的图形。**

截至 2026-10-20 检查当前 main 分支时，package.json 的版本字段为 1.17.0，扩展声明为非官方集成。版本字段可能继续变化，具体行为以目标 commit 的源代码和用户设置为准。

### 9.1 核心结论：它运行的是 draw.io 自己的 Web 编辑器

这个扩展没有用 React Flow、X6 或截图去重新绘制图形。离线模式直接加载随扩展打包的 draw.io Web 应用，包括 drawio/src/main/webapp 下的编辑器页面、styles/grapheditor.css、js/app.min.js 和初始化脚本，由 draw.io 自己的 EditorUi、图形模型和渲染逻辑负责显示和编辑。

关键实现：

- [package.json](https://github.com/hediet/vscode-drawio/blob/main/package.json)：定义自定义编辑器、文件类型、设置与 Webview 入口。
- [DrawioClientFactory.ts](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/DrawioClientFactory.ts)：选择离线/在线模式，构造 Webview 内容、注入主题和配置。
- [webview-content.html](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/webview-content.html)：离线编辑器的启动页面、样式/脚本加载、宿主消息桥接。
- [DrawioClient.ts](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/DrawioClient.ts)：将宿主消息封装成 draw.io action/event 客户端，并处理加载、自动保存、保存和导出事件。

它的图形仍由标准 draw.io XML / mxGraph 模型描述。因此节点形状、边、箭头、文字、图形属性和相应的原生渲染规则来自 draw.io 本身，而不是从 React Flow 节点转换成近似的 CSS/SVG 组件。

### 9.2 两种运行模式：默认本地打包，也可以使用在线 Embed

扩展并不是只能连接公共 draw.io 服务器。当前 Config.ts 中 hediet.vscode-drawio.offline 默认值为 true，DrawioClientFactory 根据该设置选择加载方式。

| 模式 | 实际实现 | 网络/版本依赖 | 对本项目的启示 |
|---|---|---|---|
| Offline（默认） | 从扩展包内的 drawio/src/main/webapp 加载本地 draw.io Web 应用，资源通过 VS Code webview.asWebviewUri(...) 转为 Webview URI | 不依赖公共在线编辑器来加载主应用；渲染版本跟随扩展包中固定的 draw.io 代码 | 可借鉴为本地托管的原生编辑器方案 |
| Online | 在 Webview 中创建 iframe，默认 URL 为 https://embed.diagrams.net/，通过 embed=1、proto=json 等参数启动 Embed 协议 | 依赖配置的在线或自托管服务和相应版本 | 适合希望使用在线/自托管 Embed 服务的场景 |

Offline 模式下，webview-content.html 把 drawio/src/main/webapp 的 index.html 设为 base URL，再由该页面加载 draw.io 编辑器资源。它不是启动本机 Desktop，也不是通过本地 HTTP 服务把文件交给 Desktop CLI。实际渲染发生在 VS Code 内嵌的 Webview 浏览器环境中。

Online 模式则确实使用 iframe 加载配置的 Embed URL，并在宿主 Webview 与 iframe 之间中转消息。扩展对可确定的 HTTP(S) 源设置消息来源检查，避免任意页面借桥接层传递图形数据。

### 9.3 文件类型与保存机制：图形 XML 是核心数据，不是截图

扩展使用两个 VS Code 自定义编辑器 Provider，分别处理文本类文件和二进制图像类文件。

| 文件类型 | VS Code 文档模型 | 编辑与保存方式 |
|---|---|---|
| .drawio、.dio | CustomTextEditorProvider + TextDocument | 图形编辑产生 XML 变化后，扩展通过 WorkspaceEdit 将格式化后的 XML 写回文本文档；文本端的外部变化也会合并回图形编辑器 |
| .drawio.svg、.dio.svg | 文本文档 | 保存 SVG 时导出带有嵌入式 draw.io XML 的 SVG，既能作为 SVG 查看，也可由兼容编辑器恢复图形数据 |
| .drawio.png、.dio.png | CustomEditorProvider + 自定义二进制文档 | 图形 XML 在内存中维护；保存时根据目标扩展名通过 draw.io 导出动作生成 PNG 等文件，并可保留可恢复的图形数据 |

关键实现：

- [DrawioEditorProviderText.ts](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioEditorProviderText.ts)
- [DrawioEditorProviderBinary.ts](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioEditorProviderBinary.ts)
- [DrawioEditorService.ts](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioEditorService.ts)

DrawioClient 接收 draw.io 的 init、autosave、save、export 等事件。文本编辑器将更新后的 XML 同步回 VS Code 的文本文档；PNG 等二进制文档则保存 draw.io 导出得到的字节。这种方式让 Git diff、文本编辑器和图形编辑器能够共享同一个图形源文件。

对 Architecture Diagram Studio 的直接借鉴是：如果引入原生 draw.io 编辑器，最好将 XML 当作完整的图形文档保存，而不是每次保存都重新从简化的业务 IR 重建一份 XML；否则用户在 draw.io 中添加的样式、图形属性、层级或边路径容易丢失。

### 9.4 宿主与 draw.io 如何通信

扩展用一个 DrawioClient 抽象封装消息通信：

- 扩展端使用 VS Code Webview 的 postMessage / onDidReceiveMessage。
- draw.io 端使用 Embed 风格的 JSON action/event 协议，例如加载图形、请求导出、自动保存、保存和导出结果。
- 离线编辑器页面通过 acquireVsCodeApi() 与宿主通信，并建立兼容 draw.io Embed 消息模式的桥接对象。
- 图形变化被映射为 XML 更新，宿主负责修改 TextDocument、设置 dirty 状态和执行保存。
- 设置变化可以重新生成 Webview HTML；主题/外观、语言、默认节点/边样式、字体、颜色、形状库和其他选项会传给 draw.io。

离线页面还对 Webview 的宿主环境做了兼容处理，例如代理 localStorage 到扩展设置、提供 window.opener 消息桥接以及拦截部分 VS Code 快捷键。这些是 VS Code Webview 特有的适配，并不能不加修改地复制到普通浏览器的 Studio 页面。

### 9.5 主题与自定义能力从哪里来

扩展将主题和外观作为 draw.io 自身的设置，而不是用宿主 CSS 重画图形。当前配置包含主题、亮/暗外观、自定义字体、预设颜色、自定义配色、节点与边的默认样式、形状库及其他编辑器选项；部分配置改变后会重新生成 Webview 页面。扩展也支持加载自定义插件，但会对插件代码做 SHA-256 指纹校验，并要求用户明确允许未知插件。

这与 Studio 当前的六种主题有一个区别：

- VS Code 扩展的主题主要控制 draw.io 编辑器外观、调色板、默认样式和使用体验。
- Studio 的 Studio、Editorial、Midnight、Blueprint、Minimal Mono、Vibrant 是自定义画布的视觉主题，需要由项目自己映射为 draw.io 节点/边样式。
- 如果 Studio 嵌入 draw.io，不能期待 React Flow 的 CSS 主题自动应用到 draw.io 画布。要建立一个显式的 Theme -> mxGraph style 适配器，或在生成/更新 XML 时写入节点和边的原生样式。
- 更换 draw.io 编辑器主题与改变图中每个节点的 style 并不是同一件事，二者需要分开建模。

### 9.6 Markdown 预览是另一条渲染路径，不要混淆

扩展还包含 Markdown 中的 draw.io 图形支持。其只读/预览相关代码引用打包的 viewer-static.min.js，将 XML 放入带 data-mxgraph 配置的 DOM 容器，再由 draw.io 的 Viewer 渲染。这与完整可编辑的 EditorUi 不是同一个工作模式。

相关实现：

- [package.json](https://github.com/hediet/vscode-drawio/blob/main/package.json)：引用打包的 viewer-static.min.js。
- [previewInit.js](https://github.com/hediet/vscode-drawio/blob/main/src/inline-editor/webview/previewInit.js)：把 Markdown fenced block 或注释块中的 XML 转换为 Viewer 容器。
- [editor.html](https://github.com/hediet/vscode-drawio/blob/main/src/inline-editor/webview/editor.html)：Markdown 实验性内联编辑器。

因此，“使用 VS Code draw.io 扩展的渲染方式”有两层含义：需要只读展示时，可以借鉴 Viewer；需要拖动节点、编辑连接线、修改属性和保存 XML 时，应使用完整编辑器，而不是 Viewer。

### 9.7 对 Architecture Diagram Studio 的启示

如果产品目标仍是“Studio 中的可编辑图形必须由 draw.io 原生渲染，同时支持本机/私有部署”，VS Code 扩展提供了一个比公共 Embed 更贴近需求的方向：

1. 将官方 draw.io Web 应用以固定版本的源码子模块或受控构建产物的形式纳入本地部署，主应用在本地静态服务中提供这些资源。
2. 在 Studio 中使用 iframe 嵌入该本地版本的 draw.io Web 编辑器，采用官方 Embed JSON 协议或一个受约束的等价消息桥。不要将 Webview 专属的 acquireVsCodeApi()、asWebviewUri() 等代码原样搬进普通 React 应用。
3. 继续让 Copilot/MCP 操作版本化 Diagram Document 的业务语义；通过适配层将模型转换为 draw.io XML，并用节点/关系的稳定 ID 建立 XML 与 IR 的对应关系。
4. 把布局引擎与渲染引擎分离。可以先用现有 ELK、Dagre 或 D3 算出节点坐标和路径，再生成/更新 XML，加载到 draw.io 原生编辑器渲染。这样可以保留现有布局选择，不必接受 draw.io 默认布局的视觉风格。
5. 当用户在 draw.io 中手工编辑后，接收保存事件和 XML，再将受支持的语义、节点位置、尺寸和路径同步回 IR。未识别的 mxCell 属性、图形样式和结构应原样保留或通过原始 XML/扩展字段维护，不能被简化 IR 静默删掉。
6. 保留 Desktop CLI 作为本地 SVG/PNG 导出、文件批处理和视觉回归工具；CLI 与浏览器内画布分别承担处理和交互职责。
7. 若只需要只读预览，Viewer 可以作为更轻的独立模式；不要为了预览就加载整个编辑器。

### 9.8 安全、许可与版本维护

这种模式不要求用户安装 Desktop；本地 Web 资源在浏览器/应用 Webview 内运行。但它也不是“复制一个 HTML 文件”那么简单：需要跟踪 draw.io 的资源、构建方式、路由、Embed 参数和消息协议，并对主应用的 CSP、iframe 源、消息校验及本地资源访问做安全设计。

hediet/vscode-drawio 的 package.json 声明 GPL-3.0；它包含的 draw.io 子模块也有自己的源代码和许可文件。**可以参考其架构，不代表可以不审查许可证就复制扩展源文件或把整个扩展的代码直接打包进本项目。** 若决定分发 draw.io Web 应用或改动其源码，应分别核对 draw.io 上游对应版本的许可条款、依赖和分发义务；必要时进行法律/开源合规审查。

还需要固定 draw.io 的版本并建立升级回归测试。每次升级至少验证：初始化、加载和保存 XML、主题与默认样式、形状库、图片资源、自动布局消息、导出 SVG、字体、CSP 和安全隔离。不能因为扩展实现存在，就推断它的全部 Webview 补丁可以无修改用于 Studio。

### 9.9 实际打包怎么做：上游资源、构建步骤与官方文档

先说结论：draw.io Web 应用不需要作为 npm 依赖安装。上游仓库的 Getting Started 说明，生产模式使用已提交到仓库的 minified bundles；只运行应用时，无需执行 npm build。只有修改 draw.io 自身源码并要重建压缩 bundle / WAR 时，才需要上游文档描述的 JDK、Apache Ant 等构建工具。

权威文档：

- [draw.io Wiki：Getting Started](https://github.com/jgraph/drawio/wiki/Getting-Started) —— 如何克隆仓库、运行 src/main/webapp，以及 production/dev 模式的区别。
- [draw.io Wiki：FAQ](https://github.com/jgraph/drawio/wiki/FAQ) —— 自托管、静态文件托管、离线运行与为什么 minified bundles 直接提交在仓库中。
- [draw.io Wiki：Building](https://github.com/jgraph/drawio/wiki/Building) —— 修改 draw.io 核心代码后如何重新生成 bundle；只有真正修改 draw.io 本身才需要走此流程。
- [jgraph/drawio 源码仓库](https://github.com/jgraph/drawio) —— 可复用的 Web 应用源和已经构建好的浏览器资源。
- [hediet/vscode-drawio 的 .gitmodules](https://github.com/hediet/vscode-drawio/blob/main/.gitmodules) —— 它把 jgraph/drawio 作为 drawio 子模块。
- [hediet/vscode-drawio 的 package.json](https://github.com/hediet/vscode-drawio/blob/main/package.json) —— package scripts 和发布文件白名单；其中把 drawio/src/main/webapp 下的 JS、连接器、图片、字体/资源、形状库、样式、模板和 index.html 纳入扩展包。
- [hediet/vscode-drawio 的 DrawioClientFactory.ts](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/DrawioClientFactory.ts) —— 离线模式把扩展内 drawio/src/main/webapp 映射成 Webview URI，再加载本地 editor 页面。

### 9.9.1 推荐的 Studio 资源组织

建议固定一个经过验证的 draw.io 版本/commit，不要每次构建都跟随上游 dev 最新提交。资源可以通过 Git submodule、受控镜像或版本化下载步骤取得。Studio 不需要把 VS Code 扩展本身作为依赖；只借鉴它的资源组织和宿主通信模式。

推荐的发布目录形态：

    public/
      drawio/
        index.html
        js/
        styles/
        mxgraph/
        images/
        img/
        resources/
        plugins/
        templates/
        ...其他上游 webapp 文件

最安全的初始策略是完整保留上游 src/main/webapp 目录结构，不要一开始就尝试只挑选部分文件。draw.io 会按需加载其他脚本、shape 库、语言、插件和资源，手工裁剪容易出现功能只在某些图形或语言下失效的问题。

可以用下面的过程准备一个固定版本的资源包：

    git clone --depth 1 https://github.com/jgraph/drawio.git vendor-drawio
    mkdir -p public/drawio
    cp -R vendor-drawio/src/main/webapp/. public/drawio/

上面是验证/原型用的简化命令；生产构建应在 CI 中取得并固定指定的 release/commit，记录版本号和上游许可文件，而不是无条件追踪移动的 dev 分支。如果使用 Git submodule，也应把 submodule commit 固定到仓库历史，并在资源准备脚本中复制该 commit 的 webapp 内容。

draw.io 上游的生产 bundle 已经在源码仓库中提交，因此仅使用现成 Web 应用时通常不需要先跑 npm install 或 Webpack 来编译 draw.io。若要修改 draw.io 自身源码，则按上游 Building 文档走 JDK / Ant 构建；Studio 自己的 React / TypeScript 代码仍然照常使用本项目的 Vite build。

### 9.9.2 Studio 如何加载本地编辑器

Vite 默认会把 public 目录中的静态文件复制到生产产物中。因此资源准备步骤完成后，Studio 可以让 iframe 加载本地路径，而不是公共服务，例如：

    /drawio/index.html?embed=1&proto=json&offline=1&configure=1

应用通过 iframe 的 postMessage 协议发送加载图形请求，并接收保存、自动保存和导出等消息。需要明确校验消息来源，只接受本地 draw.io iframe 的消息；发送消息时使用准确的 target origin，不要不加区分地使用通配符。宿主应该负责把接收到的 XML 写回项目的图形文档存储。

要特别注意，offline=1 与“所有内容在本机”的产品目标相符：draw.io 官方 FAQ 说明它会关闭云存储集成，并跳过插件加载。但应以固定版本的真实网络抓包为准，确认没有意外请求公共服务。图形 XML 若引用外部图片或字体，也可能产生单独的网络请求，需要在安全策略中明确处理。

### 9.9.3 什么时候需要重建或重新打包

| 场景 | 需要做什么 |
|---|---|
| 只想在 Studio 内显示和编辑 draw.io 文件 | 固定上游版本，复制/发布上游现成 webapp 静态资源；不需要构建 Desktop |
| 更新 draw.io 版本 | 更新固定的上游 commit/release，复制资源，跑加载/编辑/保存/导出与视觉回归 |
| 只改 Studio 的主题、布局和 Agent | 改 Studio 的 Theme / Geometry / XML 适配层，不要直接改 draw.io core |
| 想改 draw.io 自身内部行为 | 阅读上游 Building 文档，按上游要求重建 bundle；评估补丁维护成本 |
| 只读预览 | 可单独使用 draw.io Viewer 静态资源；不需要加载完整编辑器 UI |
| 使用 Desktop CLI 批量导出或做辅助测试 | CLI 是开发/测试工具的可选项，不是 Web 编辑器运行依赖 |

### 9.9.4 是否还需要用户安装 Desktop？

不需要。若 Studio 已经随应用发布 draw.io Web 静态资源，并通过 iframe 在 Studio 内运行：

- macOS 和 Windows 用户都不需要安装 draw.io Desktop。
- 不需要调用本机 draw.io CLI 来完成正常编辑、自动布局、保存或导出 XML。
- React Flow 当前的 ELK/Dagre/D3 布局算法仍可先算出节点几何，再把结果写进原生 draw.io XML，由 draw.io Web 编辑器负责渲染和后续交互。
- Desktop CLI 仅作为可选的本地测试/视觉回归辅助工具；即使用户没有安装它，Studio 的核心编辑流程也应完整可用。

真正的运行依赖是你随 Studio 部署的本地静态 draw.io Web 资源和嵌入消息桥接，而不是 Desktop App。

### 9.9.5 许可证与供应链注意事项

优先从 jgraph/drawio 上游取得固定版本的 Web 应用资源，并保留相应许可证与版本来源记录。draw.io 上游 README 声明其代码使用 Apache 2.0，但图标、形状库和模板有额外条款，商标也有使用约束。应按实际打包资源核对许可范围。

hediet/vscode-drawio 扩展自身声明 GPL-3.0。本项目应参考其架构和资源加载方式，但不应在未审查许可证的情况下直接复制扩展源文件。上游 draw.io Web 应用与 VS Code 扩展包装层的许可证不能混为一谈。

## 10. 最终决策

建议将方案选择按目标拆开，而不是把所有问题压在 React Flow、Desktop CLI 或在线 Embed 的单一选择上。

1. **当前优先方案：本地打包 draw.io Web。** 用户不需要安装 Desktop；将固定版本的 draw.io Web 静态资源发布在 Studio 同源路径，使用 iframe + 受校验的消息协议完成加载、保存和导出。
2. **布局与样式仍由 Studio 控制。** 保留现有 ELK/Dagre/D3 布局服务，把坐标、端口和边路径写入原生 XML；将六种 Studio 主题转换为 draw.io 原生节点/边样式，不接受 draw.io 默认布局作为唯一布局选项。
3. **Desktop CLI 是可选开发/测试工具。** 可用于离线 SVG/PNG 输出、批量转换和视觉回归，不是用户运行 Studio 的依赖。
4. **在线或自托管 Embed 是替代分发方式。** 如果不想随 Studio 发布 draw.io 静态资源，可以考虑在线/自托管服务，但必须评估图形数据的流向和版本管理。

无论选择哪条路线，布局与样式必须是两套独立职责：现有 ELK/Dagre/D3 负责或参与节点位置与连线路径，主题适配器将 Studio 的六种主题转换成 draw.io 原生样式。**不应仅为了原生渲染而接受 draw.io 默认布局的审美，也不应仅为了多布局而放弃原生 XML 与渲染验证。**

下一步最有价值的验证是固定一个 draw.io 上游 commit，把 src/main/webapp 完整复制到 Studio 的 public/drawio 路径；用 iframe 加载本地编辑器，连接现有 Diagram IR、布局服务和主题适配器。使用包含长标签、中文字体、数据库/外部系统形状、嵌套边界、多条连接线和自环的固定图，验证离线网络行为、XML 加载/保存往返、主题、布局与视觉回归。


## 11. 官方 drawio-mcp：本地 MCP Tool Server 的能力与边界

本节分析的是 [jgraph/drawio-mcp](https://github.com/jgraph/drawio-mcp) 中的 **MCP Tool Server**，不是托管在 \`https://mcp.draw.io/mcp\` 的 MCP App Server。目标运行方式是本地 STDIO 进程，由 Studio 的 Agent/MCP 客户端启动和通过 stdin/stdout 通信；不采用 remote MCP URL。

### 11.1 它提供什么

官方 Tool Server 发布为 npm 包 [\`@drawio/mcp\`](https://www.npmjs.com/package/@drawio/mcp)，源码目录为 \`mcp-tool-server/\`。按当前仓库 README，它提供：

- \`open_drawio_xml\`：将原生 draw.io XML 修复/规范化后，生成 URL 并在系统默认浏览器中打开 draw.io 编辑器。
- \`open_drawio_csv\`、\`open_drawio_mermaid\`：将 CSV 或 Mermaid 内容交给 draw.io 网页端转换并打开。
- \`search_shapes\`：搜索内置图形库，并可补充外部图标服务结果，返回可用于 XML 的原生 style 字符串。
- \`get_drawio_reference\`：提供 XML / Mermaid 生成规则。
- \`list_pages\`、\`get_page\`、\`set_page\`：对本地多页 \`.drawio/.xml\` 文件进行页面级查询和更新，不必把整个多页文件交给模型重写。

它还有模型规范化和可选的 ELK / libavoid 处理：规范化 XML 的父子层级、边的 parent 与 geometry，ELK 可重新安排节点并路由连线，libavoid 则在保留节点位置的前提下绕开形状重新路由。注意这两种布局策略的语义不同，不应无条件同时执行。

### 11.2 本地 STDIO 不代表本地渲染

\`npx @drawio/mcp\` 启动的是本地 MCP 进程，但 \`open_drawio_xml\` 默认仍会生成指向 \`https://app.diagrams.net/\` 的链接，并打开外部浏览器标签页。图表 XML 压缩后放在 URL 的 fragment（\`#\`）中；fragment 不会作为 HTTP 请求路径发送给 Web 服务器，但浏览器会加载公共 draw.io 网页代码，并由该网页中的 JavaScript 读取图表。因此，这不是严格离线或 air-gapped 方案，也不是一个能嵌入 Studio React 页面内的画布组件。

可以通过 \`DRAWIO_BASE_URL\` 指向自托管的 draw.io 实例，但这要求另有可访问的 draw.io Web 服务；它不会把 Web 编辑器本身打包进 MCP npm 包。MCP server 返回的是“打开编辑器的动作/URL”，不是嵌入式编辑器会话，也没有与 Studio 画布进行双向同步的宿主协议。

### 11.3 还存在的外部资源依赖

根据上游 README 和源码：

- \`search_shapes\` 的完整形状索引在默认 npm 安装中会从 CDN 获取并按用户缓存；可配置本地索引或其他 URL。
- 未命中内置形状时，搜索默认还可能请求 draw.io 图标服务；可以用 \`DRAWIO_ICON_SERVICE_URL=off\` 禁用该补充来源。
- \`postLayout: "elk"\` 第一次使用时会获取 draw.io 的 ELK 布局 bundle；\`routing: "libavoid"\` 也会使用可缓存的路由代码。
- \`open_drawio_xml\` 的主职责仍是打开网页编辑器。页面级文件工具会访问 MCP 进程有权读写的本地文件。

如果采用它，应固定 npm 版本，并明确 MCP 进程可以访问哪些文件。不要让模型借助 \`set_page\` 对任意路径写文件；在 Studio 内包装文件工具时，应将路径限制在当前项目/工作区允许范围内。若要求无外网运行，还要禁用或自托管上述外部资源，并自托管 draw.io Web 编辑器。

### 11.4 对 Studio 的价值

值得复用的部分是工具语义和 draw.io 专用逻辑，而不是把它误当成画布实现：

1. \`search_shapes\` 与 XML reference 能改善 Agent 对原生 shape/style 的选择。
2. XML repair / normalization 能作为导入、生成后的校验阶段，减少容器边、缺失 geometry、非法 parent 等常见问题。
3. ELK 与 libavoid 可作为布局/路由适配器的候选实现，但要先验证对现有 \`DiagramDocument\`、C4 嵌套边界和主题的影响。
4. \`open_drawio_xml\` 适合“在外部浏览器打开预览/继续编辑”的动作，不适合替代 Studio 内部的画布。

另外，官方仓库的 MCP App Server（\`https://mcp.draw.io/mcp\`）与这里的 Tool Server 是两种不同产品。用户明确要求本地 STDIO 时，不应把 MCP App Server 的远程 endpoint 混进运行依赖。

参考源码：[Tool Server README](https://github.com/jgraph/drawio-mcp/blob/main/mcp-tool-server/README.md)、[Tool Server package.json](https://github.com/jgraph/drawio-mcp/blob/main/mcp-tool-server/package.json)、[Tool Server implementation](https://github.com/jgraph/drawio-mcp/blob/main/mcp-tool-server/src/index.js)。

## 12. smart-drawio-next 的 draw.io 渲染实现

仓库：[yunshenwuchuxun/smart-drawio-next](https://github.com/yunshenwuchuxun/smart-drawio-next)。

### 12.1 结论：网页使用的是公共 Embed Editor，不是离线打包

当前 main 分支的 \`components/DrawioCanvas.jsx\` 明确写有：

\`\`\`js
const DEFAULT_DRAWIO_ORIGIN = 'https://embed.diagrams.net';
const DRAWIO_ORIGIN = process.env.NEXT_PUBLIC_DRAWIO_ORIGIN || DEFAULT_DRAWIO_ORIGIN;
\`\`\`

组件最终创建的 iframe 则直接加载：

\`\`\`jsx
<iframe
  src="https://embed.diagrams.net/?embed=1&proto=json&ui=min&modified=0&noSaveBtn=1&noExitBtn=1&saveAndExit=0"
/>
\`\`\`

仓库的 package/build 结构没有将 draw.io 的完整 \`src/main/webapp\` 资源随应用打包；真正的绘图编辑器是从 \`embed.diagrams.net\` 加载。因此，**它省掉的是自行维护 draw.io Web 静态资源的工作，不是消除了对 draw.io Web 编辑器的依赖**。这符合官方 Embed 模式的工作方式：使用 iframe 和 \`postMessage\` 与编辑器通信；官方文档将该模式限定为 \`https://embed.diagrams.net\`。

### 12.2 组件如何工作

\`components/DrawioCanvas.jsx\` 负责宿主和 iframe 的桥接：

1. **把 XML 载入编辑器。** 编辑器收到 \`init\` 或 \`ready\` 后，宿主发送 \`{ action: "load", xml, autosave: 1 }\`。
2. **接收用户修改。** 宿主监听 \`save\` / \`autosave\` 事件，取回 XML 并经 \`onXmlChange\` 同步给 React 状态。
3. **应用 UI 配置。** \`lib/drawio-styles.js\` 生成 CSS，再经 \`{ action: "configure", config: { css } }\` 消息调整 draw.io 编辑器的菜单栏、工具栏、侧边栏及格式面板外观。
4. **校验和避免重复加载。** 送入 iframe 前先检查 XML 是否可解析，并记住最近一次载入内容；后续变更可通过 debounce 减少重复加载。
5. **消息安全检查。** 代码检查 message 的 \`source\` 与允许的 \`origin\`，向 iframe 发送消息时使用具体的 target origin，而不是 \`*\`。

从页面结构看，它是典型的三栏工作流：左侧输入/历史/工具，中央 Monaco XML 编辑器，右侧或主区域 draw.io iframe。生成与样式工具以 XML 为中间格式，应用后的 XML 再交给 iframe 渲染和编辑。

### 12.3 Embed URL 可配置性需要特别核对

当前源码存在一个可疑的不一致：\`NEXT_PUBLIC_DRAWIO_ORIGIN\` 被用于 \`postMessage\` 的 target origin 与消息来源允许列表，但 iframe 的 \`src\` 仍是硬编码的 \`https://embed.diagrams.net/...\`。如果只设置环境变量为自托管地址，iframe 未必会跟着切换，甚至可能因为 target origin 与实际 iframe origin 不一致而导致消息发送失败。不能仅凭环境变量名就认定自托管 Web 编辑器已完整支持；应检查目标 commit 的实现或修正 iframe URL，再做端到端验证。

### 12.4 它的 MCP 与网页画布是分开的

这个项目还发布独立 npm 包 [\`@yunshenwuchuxun/smart-drawio-mcp\`](https://www.npmjs.com/package/@yunshenwuchuxun/smart-drawio-mcp)，以本地 STDIO 运行，提供五个工具：

- \`generate_drawio\`：调用进程环境配置的模型 API，生成并校验 draw.io XML。
- \`validate_drawio\`：检查 XML 语法、ID、parent 结构及引用。
- \`repair_drawio\`：修复受支持的缺失闭合标签。
- \`style_drawio\`：对 XML 应用主题、style pack、预设和绘图技巧。
- \`list_drawio_options\`：返回支持的类型、主题和选项。

MCP 的结果是未压缩 XML，由调用端决定如何保存或应用；它不启动网页 iframe、不控制活动编辑器会话，也不负责 PNG/SVG/PDF 渲染。除 \`generate_drawio\` 需要配置 provider 外，校验、修复、样式与选项查询可在没有模型 API 密钥的情况下运行。这个 MCP 包和 Next.js 网站是同一绘图核心的两个入口，不能把它与公共在线画布混为一谈。

### 12.5 隐私、离线与测试证据

- 如果使用公共 Embed URL，draw.io Web 编辑器代码来自公共站点；图表 XML 会通过跨源 \`postMessage\` 传给该 iframe。不能视为“数据从未接触第三方代码”的完全离线边界。
- 网站本身可以通过 Next.js 自托管，但这不等于 draw.io 编辑器本身也被自托管。需要单独处理 iframe 的来源、CSP、静态资源与版本。
- 仓库的 [升级路线文档](https://github.com/yunshenwuchuxun/smart-drawio-next/blob/main/docs/upgrade-roadmap.md) 明确记录：浏览器测试使用消息协议替身；一次远程编辑器冒烟在等待窗口内没有收到初始化消息，因此未验证真实远程编辑器的完整渲染/编辑流程。README 中展示的图表经官方 viewer 渲染，不能替代对 iframe 编辑交互的端到端验证。

因此，它是一个很有参考价值的“LLM + XML 工具链 + Embed iframe”实现案例，但不能据此推断它已经解决了离线打包或离线运行。

## 13. 综合判断：对 Architecture Diagram Studio 的影响

这次对比把三个不同问题分开了：

| 目标 | 更合适的方案 | 仍需注意 |
|---|---|---|
| 让 Agent 更可靠地生成、修复、规范化及美化原生 XML | 集成本地 STDIO MCP 工具或复用其核心逻辑 | MCP 不提供 Studio 内画布；限制文件路径、外部资源和模型 API 边界 |
| 尽快实现 draw.io 原生渲染，并接受公共 Web 编辑器 | 参考 smart-drawio-next 的 Embed iframe 模式 | 图表会交给公共 iframe 处理；需处理跨源消息、外部依赖和实际端到端测试 |
| 在 Studio 页面内直接编辑，并且不依赖公共 draw.io 域名 | 自托管/打包 draw.io Web 编辑器 | 需要管理版本、资源、许可证、CSP 和消息桥；不是一个 MCP 包可以替代的 |
| 只需要让 Agent 生成一个可编辑 \`.drawio\` 文件，由用户稍后打开 | 本地 MCP + XML 文件工作流 | 不必嵌入画布；独立打开公共编辑器时仍有外部服务依赖 |

**建议的实现顺序：**

1. 先让本地 MCP 成为 Agent 可选的图形能力层，或者把 shape search、XML normalization、样式工具以受控方式复用进 Studio；不应将它作为渲染层。
2. 建立最小 iframe 原型，按 smart-drawio-next 的方式验证 XML 的加载、保存回传和主题配置。先用公共 Embed URL 完成协议验证，但把服务边界明确标注出来。
3. 若产品要求离线或限制数据进入公共 Web 编辑器，则将 iframe 的资源来源切换为固定版本的本地/自托管 draw.io Web，再验证同一消息协议。官方 Embed 文档对 \`embed=1\` 的支持范围有约束，所以本地 Web 资源的集成不能只改 URL 就宣称完成。
4. 无论画布由谁渲染，继续保留 Studio 的 ELK/Dagre/D3 几何与主题转换能力。让 MCP/LLM 负责语义及图形 XML，不要把 DiagramDocument 的唯一真相交给 MCP 进程或浏览器 URL。

本报告的核心决定不变：**本地 MCP 能省掉一部分 Agent/图形 XML 工具开发；smart-drawio-next 证明公共 Embed iframe 可以省掉自行打包 Web 资源的初始工作；但若 Studio 必须保留离线数据边界并提供原生嵌入式编辑器，仍要自托管或打包 draw.io Web。**

## 14. lgazo/drawio-mcp-server：本地托管 draw.io Web 应用与实时 MCP 桥接

仓库：[lgazo/drawio-mcp-server](https://github.com/lgazo/drawio-mcp-server)。

### 14.1 结论：本地自托管，但默认不是预先打包的离线安装包

这是值得研究的另一种路线：**MCP Server 在本机 HTTP 服务上托管 draw.io Web 应用，并通过注入的 draw.io 插件和本地 WebSocket，让 Agent 实时操作已打开的画布。** 内置编辑器不使用 \`embed.diagrams.net\` 作为画布页面，也不要求用户安装 draw.io Desktop。

但需要区分“本地托管”和“随 npm 包预先打包”：

- npm 包默认只发布编译后的 MCP Server；draw.io 的完整 Web 资源不是固定版本地全部包含在 npm 包内。
- 首次启用内置编辑器且缓存不存在时，Server 会向 GitHub 的 \`jgraph/drawio\` releases API 查询最新发布版，下载其中的 \`draw.war\` 并解压到本机用户缓存目录中的 \`webapp/\`。
- Server 删除 \`WEB-INF\` 和 \`META-INF\` 等不需要的 Java Web 后端内容，保留浏览器端静态应用资源，然后从本机 HTTP 地址提供这些文件。
- 如果缓存资源存在且版本满足兼容矩阵，正常启动会复用缓存；资源缺失或版本超出支持范围时才重新下载。

因此它采用的是 **运行时获取资源 + 本机持久缓存 + 本地 Web 托管**，而不是默认交付一个已经固定版本且可从零开始断网安装的离线包。首次初始化和触发版本更新时需要网络。缓存准备好后可以尝试离线运行；严格离线部署应预置受控版本的资源，并在禁网条件下验证。

源码证据：

- [Server package.json](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/package.json)：发布文件清单只有 \`build\`。
- [资源下载与 WAR 解压](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/assets/downloader.ts)：查询最新 Release、下载 \`draw.war\`、解压并清理。
- [资源缓存路径](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/assets/manager.ts)：默认缓存目录名为 \`drawio-mcp-server\`，资源位于 \`webapp/\`，可用 \`--asset-path\` 指定目录。
- [缓存与版本兼容检查](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/assets/auto-refresh.ts)：缓存缺失或版本不兼容时重新下载；支持范围见 [matrix.ts](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/drawio-compat/matrix.ts)。

### 14.2 怎么启动：本地 STDIO MCP + 本地编辑器 HTTP 服务

最小 MCP Host 配置如下，MCP 通过本地 STDIO 启动，不需要配置远程 MCP URL：

\`\`\`json
{
  "mcpServers": {
    "drawio": {
      "command": "npx",
      "args": ["-y", "drawio-mcp-server", "--editor"]
    }
  }
}
\`\`\`

重启 MCP Host 后打开 \`http://localhost:3000/\`。

这会启动三个本机通道：

1. **MCP Host → Node Server：STDIO。** Agent 通过本地 MCP 连接调用工具。
2. **浏览器 → 内置编辑器：HTTP。** 默认 3000 端口提供 draw.io Web 页面和静态资源。
3. **浏览器中的 draw.io 插件 → Node Server：WebSocket。** 默认 3333 端口传递实时工具请求、结果与文档状态。

注意：\`--editor\` 会启用本地编辑器 HTTP endpoint，也会启用相应的 HTTP 服务。因此它不是 remote MCP，但也不只是单纯的 STDIO 进程。默认绑定地址由操作系统选择；若只允许本机连接，建议检查并显式设置 \`--host 127.0.0.1\`，不要意外暴露到局域网。配置细节见 [CONFIG.md — Built-in Editor](https://github.com/lgazo/drawio-mcp-server/blob/main/CONFIG.md#built-in-editor)。

### 14.3 怎么渲染：浏览器运行 draw.io 原生 Web 前端

它用的是 draw.io 官方浏览器端编辑器本身，不是 MCP Server 自己绘图，也不是服务端重新实现 SVG/Canvas 渲染。

内置编辑器的请求路径如下：

1. 浏览器访问本地 Server 的 \`/\`。
2. Server 将根路径重定向到 \`/index.html?offline=1&local=1\`。
3. Server 把请求映射到缓存的 draw.io \`webapp/\`，返回原生 \`index.html\`、\`js/app.min.js\`、样式、图形库、图片和其他静态资源。
4. 返回 HTML 时，Server 会注入 \`/js/mcp-plugin.js\`。这个插件随 Server 的构建产物发布，无需另外安装浏览器扩展。
5. 浏览器执行 draw.io 官方前端代码，由它管理图形模型并完成真实画布渲染。

关键源码：

- [本地编辑器路由与静态文件服务](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/index.ts)：编辑器入口、缓存资源映射、插件注入与 \`offline=1&local=1\`。
- [MCP 插件入口](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-plugin/src/plugin.ts)：等待 \`window.Draw\`，再通过 \`window.Draw.loadPlugin(...)\` 安装插件、菜单和 WebSocket 通信。
- [WebSocket 管理器](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-plugin/src/websocketManager.ts)：连接、消息收发、心跳和重连。

\`offline=1&local=1\` 表明该项目以 draw.io 的本地/离线模式启动，但**不能仅凭 URL 参数就声称所有功能已通过完全断网验证**。严格离线场景仍应检查浏览器 Network 请求，并在禁网后测试首次加载、刷新、图形库、导入和导出。

### 14.4 MCP 如何操作实际打开的画布

这不是单纯生成 XML 并把它塞进浏览器 URL 的工具。核心是通过插件对已连接的 draw.io document 进行实时操作：

1. Agent 调用 \`add-cell-of-shape\`、\`edit-cell\`、\`add-edge\`、\`set-cell-parent\`、\`create-page\` 等工具。
2. Node Server 将带请求 ID 的工具消息发到内部事件总线，再路由到目标 draw.io document 的 WebSocket 连接。
3. 注入插件在 draw.io 页面内接收命令，调用编辑器内部 API 修改图形模型、节点、边、页面或图层。
4. 插件将结果经 WebSocket 按请求 ID 回传，Server 再将其作为 MCP 工具结果返回。
5. 多标签页时可以先调用 \`list-documents\`，再用 \`target_document\` 指定目标；页面工具通过 \`target_page\` 选择页面。同一文档上的实时操作有 FIFO 排队，避免并发 Agent 在同一标签页里交错切换页面和修改图形。

工具还支持页面/图层管理、图形库发现、导入导出和文档保存。导出通过当前 draw.io 实例的原生导出逻辑返回 SVG、PNG 或 XML，可选保存到本机文件。也就是说，图表由真正的 draw.io 编辑器管理与渲染。

参考：[Tools Reference](https://github.com/lgazo/drawio-mcp-server/blob/main/TOOLS.md)、[MCP 工具事件桥](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/tool.ts)、[Server/WebSocket 桥接](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/index.ts)。

### 14.5 另一个模式：连接用户已打开的 draw.io 浏览器标签页

项目也可以不开内置编辑器，而是：

1. 用户打开公共或其他可用的 draw.io Web 页面。
2. 安装项目提供的浏览器扩展。
3. 扩展连接本机 Server 的 WebSocket。
4. MCP 工具直接操作这个已打开的文档。

此模式不是本地自托管渲染：编辑器页面仍由对应网站提供，且需要浏览器扩展。项目的 draw.io Desktop/Electron 插件则仍属实验性实现，README 记录了上游 CSP 限制，不能把它视为已可靠可用的 Desktop 集成。

### 14.6 对 Architecture Diagram Studio 的价值与限制

这个仓库比 XML 生成器 MCP 更贴近 Studio 的交互式编辑目标：它示范了如何在本地托管 draw.io Web、注入插件，并让 MCP 直接操作这一个编辑器实例。它是很有价值的技术参考，也值得做一个最小集成原型。

但不应不加区分地把整个项目塞进 Studio：

- 当前 Studio 的版本化 \`DiagramDocument\` 更适合作为业务语义与持久化权威模型。若 live draw.io 成为编辑器状态持有者，必须把保存后的 XML、几何和关系回传，避免数据库、IR 与画布内容不一致。
- 可先复用其本机静态托管、插件注入与消息桥接模式，同时保留 Studio 的业务模型、布局算法、主题与持久化。
- 它默认从 GitHub Release 下载动态的“最新版本” WAR。可复现和企业离线部署应将资源改为固定 release/commit 的内部镜像或预置缓存，避免在部署过程中无意升级编辑器版本。
- WebSocket 是可操作真实图表的控制通道。应限制监听范围，检查连接来源和可访问的文档；不要把服务暴露给不受信任的网络客户端。

### 14.7 小结

| 问题 | 结论 |
|---|---|
| 是否使用 \`embed.diagrams.net\` 作为内置画布？ | 否；内置模式从本机 HTTP 服务加载 Web 资源。 |
| 是否自托管？ | 是，缓存中的 draw.io Web 应用由本机 Server 提供。 |
| 完整 draw.io Web 是否默认预装在 npm 包里？ | 否；资源在首次/需要更新时从官方 \`draw.war\` 下载并缓存。 |
| 是否能从零开始完全断网安装？ | 默认不能；干净缓存需要下载。 |
| 缓存后能否断网运行？ | 设计上复用本地资源，但仍应禁网测试确认完整边界。 |
| 是否需要 Desktop？ | 内置 Web 模式不需要，渲染由浏览器中的 draw.io 前端完成。 |
| MCP 是否只能生成 XML？ | 否，可实时操作已连接的 draw.io 页面，并使用其原生导出功能。 |
| 是否应直接替换 Studio 的 DiagramDocument？ | 不建议；需先解决持久化权威源、双向同步、资源版本和路径安全。 |

建议把它作为本报告中最值得原型验证的“本地 draw.io Web + MCP live-control bridge”方案。它更接近 Studio 内的原生交互式编辑，同时免于在 Studio 前端复刻 draw.io 的形状和渲染逻辑；但默认的运行时下载方式仍不等于固定版本的离线分发包。

## 15. DayuanJiang/next-ai-draw-io：固定版本的 draw.io 打包、同源渲染与 AI 协作式绘图

仓库：[DayuanJiang/next-ai-draw-io](https://github.com/DayuanJiang/next-ai-draw-io)。

### 15.1 结论：是，而且比“首次运行时下载并缓存”更接近可复现的离线分发

这个项目的主 Web 应用和独立 MCP Server 都会把 draw.io Web 前端的静态资源放进自己的发布产物中。默认不使用 embed.diagrams.net；浏览器从应用自身的 origin 加载 draw.io，因此可以在同源条件下访问编辑器内部对象，做到超出标准 Embed postMessage 协议的交互。

需要区分两个包的资源准备位置：

- **Next.js Web 应用：** npm run dev 和 npm run build 前分别通过 predev / prebuild 运行 scripts/fetch-drawio.mjs，将选定版本的资源准备到 public/drawio/。Next.js 随后从同源的 /drawio/ 提供这些静态文件。
- **MCP npm 包：** packages/mcp-server 的 build 流程把 draw.io 静态资源写入 packages/mcp-server/dist/drawio/；发布包的 files: ["dist"] 会把编辑器资源与服务代码一起打进 npm 包。所以消费者安装 MCP npm 包后，运行时不需要再下载 draw.io Web 资源。
- **资源不是整个 WAR 原样塞进网页。** 项目固定 draw.io release 和 WAR 的 SHA-256，只抽取 drawio-files.txt 清单里的浏览器资源，排除 WEB-INF/ 和 META-INF/；同时带上相关许可证与版本标记。
- 当前 main 分支在 packages/mcp-server/src/drawio-version.json 固定的是 draw.io v32.0.2，并校验对应 WAR 的 SHA-256。此版本是本次源码检查时看到的仓库配置，不代表未来 main 分支永远不变。

相关源码：[Web 应用打包脚本](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/scripts/fetch-drawio.mjs)、[MCP 包打包脚本](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/scripts/fetch-drawio.mjs)、[固定版本与校验和](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/drawio-version.json)、[资源 allowlist](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/drawio-files.txt)。

### 15.2 它怎么做到离线构建和运行

正常联网构建时，脚本下载固定版本的 draw.war，校验 SHA-256，再解压所需文件。若文件已处于目标版本，脚本会跳过重复下载。Web 应用支持通过 NEXT_PUBLIC_DRAWIO_BASE_URL 改用外部 draw.io，但这会走跨域模式并关闭一部分高级功能。

官方文档也说明了不能访问 GitHub 的构建机如何准备资源：

1. 在可联网的机器上下载 drawio-version.json 对应版本的 draw.war。
2. 按离线部署文档放到 public/drawio/，删除 WEB-INF / META-INF，写入匹配的 .version 标记后再 build；或者在联网环境构建完整镜像，再传进内网。
3. MCP 包构建脚本支持 DRAWIO_WAR=/path/to/draw.war，也会校验其是否为预期版本；可以预先把 WAR 送到隔离构建机。

这比启动后自行下载“最新版本”更适合企业的固定版本策略。但“draw.io 编辑器前端可离线”不代表 AI 也自动离线：Web 应用若仍使用云端模型，聊天请求仍会访问模型 API。要做完全离线的 AI 绘图，还需使用可达的本地模型或内网推理服务，并检查字体、图形库、图片、遥测等其他资源的网络访问。

文档：[Offline deployment](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/docs/en/offline-deployment.md)，其中还说明精简后的静态 draw.io 不包含图片代理，按外部 URL 插入的图片可能无法出现在导出 PNG/SVG 或版本缩略图中。MCP README 同样指出打包版本省略了少数按需加载的功能，例如组织结构图布局；需要完整 draw.io 服务器功能时可以配置外部 DRAWIO_BASE_URL，但会失去同源专属能力。

### 15.3 怎么渲染：浏览器运行 draw.io 原生前端，应用不自己画一套

画布仍是 draw.io 自己的 index.html、js/app.min.js、图形库、CSS、stencils 和 shapes；Next AI Draw.io 只是把这份 Web 应用作为本地静态资源提供，然后放进 iframe。

默认编辑器地址由 lib/drawio/drawio-config.ts 生成：

- /drawio/index.html（同源的本地副本，考虑 base path）；
- embed=1、proto=json、configure=1；
- 配置 ui=simple、语言、主题、工具栏按钮、是否启用自定义 libraries；在特定桌面上下文且使用本地包时加上 offline=1。

components/canvas/drawio-frame.tsx 负责 iframe 生命周期和标准 Embed 消息协议：初始化后发送 load，接收 autosave / export，把主题 CSS 和暗色模式同步到编辑器。同源情况下，它还会主动等待 draw.io 内部的 EditorUi 对象出现，并交给 lib/drawio/editor-bridge.ts。

这个直接桥接是关键区别。由于 iframe 和宿主同源，editor-bridge.ts 可以访问 draw.io 的 EditorUi、mxGraph、编辑器 undo manager、所选 cell、当前 XML 和页面信息，直接做：

- 读取当前真实画布的 XML 和用户手工修改；
- 读取用户所选的 cell，交给 AI 针对选中内容编辑；
- 将 AI 改过的 cell 高亮显示；
- 让一次 AI 修改成为一次可撤销的 canvas change；
- 替换图形、调整主题及部分 UI 行为，而不需要每次都整页 reload。

如果通过 NEXT_PUBLIC_DRAWIO_BASE_URL 指向另一个 origin，浏览器同源策略不允许读取这些内部对象，系统只能使用 postMessage。项目文档明确说明这种模式会失去修改高亮、选区问答、应用自定义工具栏和用 Ctrl+Z 撤回 AI 修改等功能。

要注意，EditorUi、mxGraph 等属于 draw.io 内部实现，并不是可保证长期兼容的公共 embed API。该项目通过 feature detection 尝试获取内部对象，获取失败时降级到普通工具栏；但要升级 draw.io，仍必须运行集成回归测试。

源码：[drawio-config.ts](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/drawio/drawio-config.ts)、[DrawioFrame](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/components/canvas/drawio-frame.tsx)、[editor-bridge.ts](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/drawio/editor-bridge.ts)。

### 15.4 AI 不是“一次性生成 XML”：新建、局部编辑、流式预览和回滚是分开的

网页应用的 AI 请求在 app/api/chat/route.ts 中通过 Vercel AI SDK 的 streamText 完成，工具定义来自 lib/chat-tools.ts，系统提示词来自 lib/system-prompts.ts。模型 provider 由配置决定；README 列出多个云端和本地 provider，包括 Ollama 与 OpenAI-compatible endpoint。

它把任务分成几种明确的模型工具：

- **display_diagram：** 新建图或重大结构调整，模型输出当前页面所需的原生 mxCell 与可选命名样式，外围 mxfile / mxGraphModel / root 由应用补齐。
- **edit_diagram：** 对已有图按 cell ID 执行 add / update / delete，适合改标签、移动节点、加关系或调整局部。这样不会因一次小改动就把整张图重新生成，能减少布局漂移。
- **append_diagram：** 只在新图输出因 token 限制而截断时续写 XML。
- **get_shape_library：** 按需给模型提供 AWS、Azure、GCP、Kubernetes 等图形库的确切 shape 名和 style 语法，要求模型先查询，不凭名字猜图标写法。

System prompt 把 XML 规则写得很具体：唯一 ID、父子关系、特殊字符转义、容器与坐标、连线出口/入口、避免多条边重合、必要时使用 waypoints、边不能穿过不相关节点、页面范围和标签大小。它要求模型先说简短布局计划，再生成工具调用；编辑时只说明要改什么，不用把整张图重新描述给用户。

网页端的 display_diagram 和 edit_diagram 是 UI 工具，不是在 API route 中直接写文件。它们的参数可以随模型流式响应到达，components/chat/use-diagram-streaming.ts 会抽取已完整生成的 cell / operation，先作为临时预览加载到画布；最终工具处理再进行完整 XML 校验和提交。若模型停止、输出不合法或操作失败，临时预览会回滚。最终提交会记录成一个可撤销版本，而不是让每个流式片段都生成一条历史记录。

每轮对话还会把发送时的画布状态和选区上下文交给模型；用户手工改过图后，模型下一轮会收到新的画布快照，而不是继续按很久以前生成的 XML 猜 cell ID。系统提示词也明确指出当前画布为准，模型在不确定或多轮修改之后可以重新读取图形状态。

源码：[chat route](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/app/api/chat/route.ts)、[工具定义](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/chat-tools.ts)、[系统提示词](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/system-prompts.ts)、[流式预览处理](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/components/chat/use-diagram-streaming.ts)。

### 15.5 MCP 模式：AI 模型在 MCP Host，MCP 负责把工具执行到本地 live canvas

MCP npm 包是 @next-ai-drawio/mcp-server，不是依赖远程 MCP endpoint。客户端通过本地 STDIO 启动它。MCP server 提供本机 HTTP 服务，浏览器打开预览页面；同源的 draw.io iframe 使用已打包的 draw.io 资源。Server 和预览页面同步 XML、选区、版本、截图与导出结果。

它与一般只接受 XML 并返回 URL 的 MCP 不同，工具操作的是同一个可见画布：

1. start_session 打开或恢复会话，返回 drawing guide（绘图规则、XML 结构、图标选择及连线路由）。
2. AI Host 的模型读取代码/文档，随后调用 create_new_diagram 或 edit_diagram。MCP 本身不需要再配置第二个 LLM 来生成图：执行绘图的模型是 MCP Host 正在使用的 Agent 模型。
3. get_diagram 读取包含用户手工改动的最新 XML；get_selection 取得用户当前选择的 cell；页面、图形库、文件加载、导出和版本恢复都有对应的工具。
4. screenshot_diagram 可以把真实渲染结果作为图像返回给模型。对于复杂图，guide 建议在创建或修改后检查截图，再用 edit_diagram 修正重叠和交叉连线。
5. 新建与局部编辑都有 XML 预处理、验证与图结构检查；edit_diagram 是 all-or-nothing，避免部分操作失败后模型继续建立在半成品状态上。
6. 服务器跟踪模型最后看到的 XML 与浏览器实时状态。如果用户在中间手工改动了图，内容指纹不再一致，编辑请求会被拒绝并要求先重新读取当前图，避免根据旧 cell ID 覆盖人的修改。

MCP 的工具说明把持久化、版本和回滚也作为工作流的一部分：默认在 ~/.next-ai-drawio/ 保存会话 .drawio 文件及历史记录，保留最近若干版本；用户可以在后续对话中找回旧图并继续编辑。

参考：[MCP README](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/README.md)、[MCP 服务入口/工具定义](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/index.ts)、[绘图指南](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/drawing-guide.ts)、[XML 编辑防陈旧检查](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/edit-gate.ts)、[MCP 历史](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/history.ts)、[会话自动保存](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/persistence.ts)。

### 15.6 值得借鉴到 Architecture Diagram Studio 的设计

这个项目最值得借鉴的不是单独一段提示词，而是让模型以受控方式修改真实的 draw.io 文档，并用实时画布状态形成反馈闭环。

1. **复用固定版本的 Web 资源打包流程。** 用 release + SHA-256 固定版本、allowlist 复制、保留许可证、CI 检查资源清单。Web 应用和 MCP 发布物都可以带上同一套资源，运行时不再去公网下载，也不需要用户安装 Desktop。
2. **将 draw.io 内部 API 封装成一个明确的 adapter。** 同源 iframe 允许高级功能，但 EditorUi / mxGraph 是内部 API。把直接访问、选区、XML 取回、变更高亮、撤销和版本适配集中在 DrawioAdapter 中，检查可用能力并按版本做真实浏览器回归；不要让业务组件到处直接读写 draw.io 内部字段。
3. **AI 的工具应有清楚的粒度。** 重大结构调整用“创建/替换”工具；日常修改用按 cell ID 的 add/update/delete 操作；大图支持多页和按需返回 shape catalog。不要每次改一个标签就重新生成全图，也不要要求模型不断发送完整 wrapper XML。
4. **为流式生成设计临时预览与提交边界。** 可以逐个显示完整 cell 或完整 operation，但临时结果不能写入正式历史；只有整个输出通过校验后才提交为一个版本。失败和用户取消时必须回滚未提交预览。
5. **把用户手工编辑纳入 Agent 的状态模型。** 在每个 user turn 附上最新的 XML / 页面 / 选区；编辑前检查模型看到的版本是否仍是画布当前版本。若过期，就拒绝修改并要求重读，而不是静默覆盖用户操作。
6. **构建图形能力的可发现性。** 为 AWS 等复杂 shape 提供可以被 MCP/Agent 调用的 shape library 工具，返回准确 style 语法，并把常见布局及连线规约做成 drawing guide；把“猜图标样式”变为查询工具。
7. **让模型看结果，而非只相信 XML 校验。** XML 合法不等于图形好看。提供 screenshot 工具和有限的修复回合，让模型检查节点重叠、连线穿过节点、标签过长与布局范围。要同时保留程序化检查，不能将视觉审核完全交给 LLM。
8. **版本与持久化进入核心流程。** AI 每次成功修改对应一个可撤销版本；保存 XML 和版本元数据时需明确唯一权威状态。画布、Agent 上下文、DiagramDocument/业务语义和文件存储之间应通过一条提交路径保持一致。

对现有 Studio，建议不直接照搬它“draw.io 内部模型就是画布权威”的全部做法：如果项目继续采用版本化 DiagramDocument 作为业务语义与持久化的权威模型，就让 DrawioAdapter 负责把用户/AI 在 draw.io 上的操作转成可校验、可提交的文档更新，并在一次事务中同步 XML、几何和语义关系。**不能让 draw.io iframe、DiagramDocument 和数据库成为三个各自可写、互相猜测的真相来源。**

### 15.7 边界与风险

- 直接访问 EditorUi / mxGraph 带来原生编辑能力，但也会依赖 draw.io 内部实现；升级 draw.io 前必须运行新建、加载、局部编辑、选区、撤销、导入/导出、嵌套容器和中文标签等集成测试。
- 预先打包的静态 Web 资源让运行时更容易离线，但每次升级需重新审核资源清单、许可证、SHA、体积及缺失的按需功能。
- 精简版本无通用图片代理。对于依赖外部 URL 的图片，画布、截图与导出可能不一致；优先内嵌图片或在受控源内托管。
- 公网 AI provider 仍然会接收 prompt、选区及当前图表上下文；若是金融或其他敏感架构图，应评估使用本地模型/内部 Gateway，并避免将敏感内容放入遥测、日志或外部图像服务。
- 本报告基于对当前 main 分支关键实现和文档的源代码检查，并未在本次任务中独立运行其 Web 应用或 MCP npm 包。源码描述的能力应视为实现分析，而不是本次环境里的端到端测试结果。

### 15.8 小结

| 问题 | 结论 |
|---|---|
| 是否自己 host draw.io Web？ | 是，默认从应用同源的静态资源目录提供 draw.io。 |
| 是否预先离线打包？ | Web build 会准备固定版本资源；MCP npm 包把所选资源发布到 dist/drawio。 |
| 是否在运行时调用公共 Embed？ | 默认不是；只有配置外部 DRAWIO_BASE_URL / NEXT_PUBLIC_DRAWIO_BASE_URL 才切换到外部服务。 |
| 怎么渲染？ | 浏览器执行 draw.io 原生 Web 前端；同源时另用内部 editor bridge 控制画布。 |
| AI 怎么修改图？ | 网页版通过流式工具调用创建/局部编辑；MCP 版本让 Host Agent 使用本地工具实时操作同一个画布。 |
| 如何确保修改不覆盖用户编辑？ | 传入最新画布与选区，并通过版本/内容指纹检查过期修改。 |
| 最值得 Studio 借鉴什么？ | 固定版本资源打包、同源 adapter、按 cell 增量修改、流式预览后原子提交、截图自检、版本历史及 stale-edit gate。 |

## 16. 参考资料

### 本项目

- [Architecture Diagram Studio README](../README.md)
- [Layout implementation](../src/layout/layout.ts)
- [draw.io XML exporter](../src/export/drawio.ts)
- [Diagram model](../src/model/diagram.ts)
- [Export fidelity and verification plan](export-fidelity.md)
- [ADR 0001: Editor-independent IR](adr/0001-editor-independent-ir.md)
- [ADR 0002: Diagram-specific layout](adr/0002-diagram-specific-layout.md)
- [ADR 0003: Native-first export](adr/0003-native-first-export.md)

### VS Code Draw.io Integration 扩展

- [hediet/vscode-drawio README](https://github.com/hediet/vscode-drawio/blob/main/README.md)
- [Extension package.json: editor providers, bundled assets and settings](https://github.com/hediet/vscode-drawio/blob/main/package.json)
- [DrawioClientFactory: offline/online mode and Webview construction](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/DrawioClientFactory.ts)
- [webview-content.html: local draw.io editor startup and message bridge](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/webview-content.html)
- [DrawioClient: action/event protocol and XML synchronization](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioClient/DrawioClient.ts)
- [Text custom editor provider](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioEditorProviderText.ts)
- [Binary custom editor provider](https://github.com/hediet/vscode-drawio/blob/main/src/DrawioEditorProviderBinary.ts)
- [Markdown Viewer integration](https://github.com/hediet/vscode-drawio/blob/main/src/inline-editor/webview/previewInit.js)

### 新增研究：DayuanJiang/next-ai-draw-io

- [Next AI Draw.io README](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/README.md)
- [Offline deployment guide](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/docs/en/offline-deployment.md)
- [Web app draw.io fetch script](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/scripts/fetch-drawio.mjs)
- [MCP package metadata](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/package.json)
- [MCP package draw.io bundling script](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/scripts/fetch-drawio.mjs)
- [Pinned draw.io release and SHA-256](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/drawio-version.json)
- [Bundled draw.io file allowlist](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/drawio-files.txt)
- [DrawioFrame embed host](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/components/canvas/drawio-frame.tsx)
- [Same-origin editor bridge](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/drawio/editor-bridge.ts)
- [Draw.io source/config URL builder](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/drawio/drawio-config.ts)
- [AI chat API route](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/app/api/chat/route.ts)
- [AI tools](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/chat-tools.ts)
- [System prompt](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/lib/system-prompts.ts)
- [Streaming diagram preview](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/components/chat/use-diagram-streaming.ts)
- [MCP drawing guide](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/drawing-guide.ts)
- [MCP stale-edit protection](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/edit-gate.ts)
- [MCP persistence and version history](https://github.com/DayuanJiang/next-ai-draw-io/blob/main/packages/mcp-server/src/persistence.ts)

### 新增研究：lgazo/drawio-mcp-server

- [lgazo/drawio-mcp-server README](https://github.com/lgazo/drawio-mcp-server/blob/main/README.md)
- [Server configuration: built-in editor](https://github.com/lgazo/drawio-mcp-server/blob/main/CONFIG.md#built-in-editor)
- [Server package metadata](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/package.json)
- [Asset downloader and WAR extraction](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/assets/downloader.ts)
- [Asset cache manager](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/assets/manager.ts)
- [Asset compatibility refresh logic](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/assets/auto-refresh.ts)
- [Editor routes, local static assets and WebSocket bridge](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/index.ts)
- [Draw.io plugin entry](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-plugin/src/plugin.ts)
- [WebSocket manager](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-plugin/src/websocketManager.ts)
- [Tools Reference](https://github.com/lgazo/drawio-mcp-server/blob/main/TOOLS.md)
- [Tool event bridge](https://github.com/lgazo/drawio-mcp-server/blob/main/packages/drawio-mcp-server/src/tool.ts)

### 新增研究：官方 MCP 与 Smart Drawio Next

- [jgraph/drawio-mcp repository](https://github.com/jgraph/drawio-mcp)
- [MCP Tool Server README](https://github.com/jgraph/drawio-mcp/blob/main/mcp-tool-server/README.md)
- [MCP Tool Server implementation](https://github.com/jgraph/drawio-mcp/blob/main/mcp-tool-server/src/index.js)
- [Smart Drawio Next README](https://github.com/yunshenwuchuxun/smart-drawio-next/blob/main/README.md)
- [Smart Drawio Next DrawioCanvas](https://github.com/yunshenwuchuxun/smart-drawio-next/blob/main/components/DrawioCanvas.jsx)
- [Smart Drawio Next draw.io styles/configure message](https://github.com/yunshenwuchuxun/smart-drawio-next/blob/main/lib/drawio-styles.js)
- [Smart Drawio Next local MCP server](https://github.com/yunshenwuchuxun/smart-drawio-next/blob/main/packages/mcp/src/server.js)
- [Smart Drawio Next upgrade roadmap and test evidence](https://github.com/yunshenwuchuxun/smart-drawio-next/blob/main/docs/upgrade-roadmap.md)
- [draw.io official Embed mode documentation](https://www.drawio.com/docs/reference/embed-mode/)

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

本报告还检查了 DayuanJiang/next-ai-draw-io 当前 main 分支的 Web 资源打包脚本、固定版本/SHA、同源 iframe 及 editor bridge、AI chat route/tool definitions/streaming preview，以及 MCP 包的资源 allowlist、工具与持久化逻辑。结论基于源码与项目文档，不表示本次执行了其完整 Web/MCP 集成测试。实施前仍应固定目标版本，执行真实工具请求/画布响应往返测试、网络出口检查、资源完整性及许可证审查。
