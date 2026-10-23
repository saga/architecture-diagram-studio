# 为什么 C4 改写没生效（2026-10-23 20:49–20:51）

分析对象：本机 `~/.architecture-diagram-studio/data/application-events.jsonl`、`diagram-versions.json`、`workspace.json`，以及仓库当前代码（`4db538d`）。
复现环境：`http://127.0.0.1:5174/drawio/index.html?...&sidebar=0&ui=min`（与 Studio 内嵌 iframe 完全相同的 URL）。

## 结论

**不是渲染问题，也不是回滚问题。两次脚本都执行成功了，但执行的是"用内置形状近似 C4"的错误降级路径。**

直接原因：模型用 `mxStencilRegistry.getStencil('mxgraph.c4.person2')` 判断 C4 形状是否存在。这个 API 对 C4 **永远返回 undefined**——C4 在本 bundle 里是 `mxCellRenderer.registerShape` 注册的 mxShape，不是 mxStencil。于是脚本判定"C4 模具不可用"，第二次干脆用 `umlActor`（火柴人）和 `swimlane`（带标题栏的容器）来"近似"，正好就是截图里的样子。

更关键的是：脚本自己**在返回值里写明了** `usedPersonShape: "umlActor (fallback)"`、`usedSystemShape: "swimlane (fallback)"`，宿主收到后照样显示 "Applied 1 native change: 把 xxx 改为 C4 person…"。

---

## 一、时间线（日志原文）

| 本地时间 | 事件 | 关键字段 |
| --- | --- | --- |
| 20:49:02 | `copilot.agent.response` | `outcome=proposal_required`，`durationMs=56378` |
| 20:49:17 | `copilot.native-edits.dispatch` | `requestId=1`，`cell:execute-script`，脚本被日志截断到 500 字符 |
| 20:49:17 | `diagram.version.created` | `v-1792759757900-722d3da2`，`xmlLength=2724` |
| 20:49:17 | `copilot.native-edit.acknowledged` | `scriptResult={"personStencilFound":false,"systemStencilFound":false,…}` |
| 20:50:15 | `drawio.runtime-inspection.completed` | `cellCount=7`，`graphMethodCount=13`（模型主动查了运行时） |
| 20:50:54 | `copilot.agent.response` | 再次 `proposal_required` |
| 20:51:09 | `copilot.native-edits.dispatch` | `requestId=2` |
| 20:51:09 | `diagram.version.created` | `v-1792759869186-8a75cbd9`，`xmlLength=3234` |
| 20:51:09 | `copilot.native-edit.acknowledged` | `scriptResult={"usedPersonShape":"umlActor (fallback)","usedSystemShape":"swimlane (fallback)",…}` |

两次都走了 proposal → 用户确认 → 执行 → XML 确认 → 落盘 → ack `applied`。**链路上没有任何一环失败**，失败的是"做的事本身"。

## 二、三次版本的样式与几何（证据核心）

| 元素 | 改前（18:37 Autosave） | 第一次（20:49） | 第二次（20:51，当前） |
| --- | --- | --- | --- |
| **xxx** | `whiteSpace=wrap;html=1;fillColor=#ff0000;` 120×60 | `…fillColor=#08427B;rounded=1;` 160×170 | `shape=umlActor;…fillColor=#08427B;fontColor=#08427B;` 160×170 |
| **bbb** | `rounded=0;whiteSpace=wrap;html=1;` 120×60 | `rounded=1;whiteSpace=wrap;html=1;` 160×100 | `shape=swimlane;startSize=28;…fillColor=#999999;` 160×100 |
| **ddd** | `rounded=0;…` 120×60 | `rounded=1;…` 160×100 | `shape=swimlane;startSize=28;…fillColor=#1168BD;` 160×100 |
| **eee** | `rounded=0;…` 120×60 | `rounded=1;…` 160×100 | `shape=swimlane;startSize=28;…fillColor=#1168BD;` 160×100 |

读出来的三件事：

1. **第一次只改了 xxx 的颜色**（红 → `#08427B`），bbb/ddd/eee 连 `fillColor` 都没有；但 summary 写的是"把 xxx 改为 C4 person、bbb 改为 C4 external、ddd/eee 改为 C4 system，并调整为合适尺寸"。尺寸确实改了，颜色只改了一个。
2. **两次都没有出现 `shape=mxgraph.c4.*`**。第一次连 `shape` 都没有；第二次换成了 `umlActor` / `swimlane`。
3. 截图里的"彩色标题栏 + 白底"就是 `shape=swimlane;startSize=28` 的渲染结果（header 用 `fillColor`，body 用 `swimlaneFillColor` 默认白）；火柴人是 `umlActor`。与 XML 完全对应，说明问题不在渲染。

## 三、根因

### R1 · 形状探测用错了注册表（直接原因）

第一次脚本开头（日志保留的前 500 字符）：

```js
var reg = mxStencilRegistry;
var personStencil = reg.getStencil('mxgraph.c4.person2');   // false
var systemStencil = reg.getStencil('mxgraph.c4.system');     // false
```

在本 bundle 里，`getStencil` 的实现（`public/drawio/js/app.min.js`，偏移 1618835）是：

```js
getStencil(a) {
  var b = stencils[a];
  if (b == null && mxCellRenderer.defaultShapes[a] == null && dynamicLoading) { /* 懒加载库 */ }
  return b;            // 仍然是 stencils[a]
}
```

关键点：判断条件里**专门排除了 `mxCellRenderer.defaultShapes[a]`**，而函数在所有分支最后都回到 `b = stencils[a]` 再 `return b`。C4 是 `shapes/mxC4.js` 用 `mxCellRenderer.registerShape(...)` 注册的（`:66/:130/:242/:365/:470`），从来不在 `stencils` 里——所以**无论库有没有加载，`getStencil('mxgraph.c4.person2')` 恒为 `undefined`**：
- 库已加载：进不去懒加载分支，直接返回 `stencils[a]`；
- 库未加载：懒加载执行 `mxC4.js`（把 shape 注册进 `defaultShapes`），然后仍把 `b` 重置为 `stencils[a]` 再返回。

实测时 `shapes/mxC4.js` 已经在这个 iframe 的网络请求里，`getStencil` 依然报告 false，`defaultShapes` 里却有这个键。这个 API 的返回值语义本来就不是布尔，"拿它判 shape 是否存在"从原理上就不成立。

**实测**（同一个 iframe URL，Playwright）：

```
getStencil('mxgraph.c4.person2')            → false
mxCellRenderer.defaultShapes['mxgraph.c4.person2'] → true
mxCellRenderer.defaultShapes['mxgraph.c4.system']  → false
```

也就是说：`person2` **本来可用**，是探测方式把它判死了；`system` 确实不存在（见 R2）。

### R2 · C4 System 本来就不是一个 shape

`shapes/mxC4.js` 只注册了 5 个 C4 形状：`person`、`person2`、`webBrowserContainer`、`webBrowserContainer2`、`mobileDeviceContainer`。

draw.io 的 C4 "Software System" 是**普通圆角矩形**（`js/diagramly/sidebar/Sidebar-C4.js`）：

```
rounded=1;whiteSpace=wrap;html=1;labelBackgroundColor=none;
fillColor=#1061B0;fontColor=#ffffff;align=center;arcSize=10;strokeColor=#0D5091;
```

**External Software System** 同结构，`fillColor=#8C8496;strokeColor=#736782`。
**Person** 才是 shape：

```
html=1;fontSize=11;dashed=0;whiteSpace=wrap;fillColor=#083F75;strokeColor=#06315C;
fontColor=#ffffff;shape=mxgraph.c4.person2;align=center;
```

所以模型"`mxgraph.c4.system` 不存在 → C4 不可用"的推论是错的：system 的正确做法是**去掉 swimlane、改圆角矩形 + 指定色值**，根本不需要 shape。

另外注意色值：模型用的是 `#08427B / #999999 / #1168BD`（c4model.com 官网配色），draw.io 内置 C4 是 `#083F75 / #8C8496 / #1061B0`。即使形状对了，颜色也不是这套 bundle 的 C4 配色——说明它是凭记忆写的，没有从运行时取事实。

### R3 · 降级选型把语义弄反了

探测失败后，第二次脚本明确选择了 `umlActor`（代表"人"的 UML 用例角色）和 `swimlane`（带独立标题栏的容器）。这两个选择在"图形类别"上沾边，在"C4"上完全不沾边：

- C4 Person 是"圆头 + 身体 + 名字/角色两行文字"的专用形状，`person2` 就在手边；
- C4 System 是一个纯色圆角卡片，标题就是卡片本身；`swimlane` 反而多出一条彩色标题栏，看起来像 UML 类图。

截图里"彩色横条 + 白底"正是这个 fallback 的直接产物。

### R4 · 成功判定不看脚本返回值

`scriptResult` 已经完整回到宿主并写进日志：

```
{"usedPersonShape":"umlActor (fallback)","usedSystemShape":"swimlane (fallback)", ...}
```

但成功判定依旧是"编辑器 ack + 序列化 XML 与 before 不同 + 落盘成功"（`native-edit-confirmation.ts` 的脚本分支 + `App.tsx` 的持久化确认）。**"XML 变了"和"用户要的效果达成了"被当成同一件事**。于是：

- UI 显示：`Applied 1 native change: 把 xxx 改为 C4 person（user）…`
- 第一次实际：只有 xxx 的颜色变了，bbb/ddd/eee 只改了尺寸与圆角；
- 第二次实际：四个节点全部换成 `umlActor` / `swimlane`，色值是另一套 C4 配色。

第一次更明显：summary 说四个都改成了 C4，XML 里只有 xxx 的颜色变了。

### R5 · `scriptResult` 不回灌模型，所以"重试"只能靠猜

修复轮只在脚本**抛异常**且回滚成功时触发（`useCopilotIntent.ts:226-240`，判 `TypeError|ReferenceError`）。这次脚本没抛错，返回值里的 fallback 标记也没进入下一轮上下文，于是用户说"没有改成功，重试"，模型只能重新猜一遍——它甚至又用同一个错误 API 探测了一次。

### R6 · 证据留存不足，事后无法复盘

- `src/diagnostics.ts:18` 把所有字符串截到 **500 字符**：两次脚本正文（估计 1–2 KB）都只剩开头。
- 日志里的 `scriptResult` 出现 `"[nested value omitted]"`：`vertices` / `edges` / `stencilsFound` 这些嵌套结构被压缩掉了。
- 服务端 `turn.native-edit.final-outcome` 只记 `summary` + `scriptLength`，没有脚本正文与返回值。

结果：只能靠"版本 XML diff + scriptResult 的一层标量"倒推，脚本里到底怎么写的无从查证。

## 四、正确的做法（同一份 bundle 里的权威样式）

在 `sidebar=0&ui=min` 的 embed 模式下，下面这套是可直接生效的（`person2` 已实测注册）：

| 角色 | style |
| --- | --- |
| C4 Person | `html=1;whiteSpace=wrap;fillColor=#083F75;strokeColor=#06315C;fontColor=#ffffff;shape=mxgraph.c4.person2;align=center;` |
| C4 System | `rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#1061B0;strokeColor=#0D5091;fontColor=#ffffff;align=center;` |
| C4 External | `rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#8C8496;strokeColor=#736782;fontColor=#ffffff;align=center;` |

若还要更接近官方观感，Person 的 label 需要用 `<object placeholders=1 c4Name c4Type c4Description>` + 占位符模板（`Sidebar-C4.js` 里就是这么做），否则只显示一行纯文本。

## 五、建议的修法（按投入排序）

1. **把"形状是否可用"变成可查询能力**：`capabilityManifest` 增加 `shapes` 段（从 `mxCellRenderer.defaultShapes` 取键），`inspectRuntime({ shapeNames: ['mxgraph.c4.person2'] })` 返回布尔；prompt 里明确"不要用 `mxStencilRegistry.getStencil` 判断 shape 是否存在"。
2. **内置一张形状目录**（服务端常量，随 prompt 下发）：C4 的 person/system/external 三套 style 模板 + 色值，和"system 不是 shape"这一条。这张表比让模型自由发挥可靠得多，也顺带解决配色偏差。
3. **成功判定纳入 `scriptResult`**：约定脚本必须返回 `{ changedCells, fallbacks }`；`fallbacks` 非空时 UI 不得显示 "Applied"，改为"已应用，但 C4 形状不可用，已按 X 近似——是否保留？"。至少要把 fallback 写进那条 assistant 消息。
4. **`scriptResult` 回灌模型**：把它作为下一轮的上下文（或触发一次自动修复轮），而不是只写日志。现在的"用户手动重试"等于让模型在无反馈下重掷骰子。
5. **审计**：脚本正文单独落盘（`native-scripts.log` + hash），diagnostics 里不要 500 字符一刀切；`scriptResult` 用摘要而不是 `[nested value omitted]`。

## 六、这次暴露的产品问题

`Applied` 目前的含义是：**编辑器接受了这批操作 + 序列化 XML 变了 + 工作区落盘成功**。

对 typed operation 来说这几乎等价于"用户要的改了"；但对 `run_drawio_script` 这种不透明操作，三者经常不是一回事。这次的两次执行都是"链路全绿、结果全错"，而 UI 用的还是模型自己写的那句 summary（`native-edit-operations.ts` 的 `describeNativeEditOperation` 对脚本直接返回 `summary`）——**用户看到的成功文案，正是把错误结果描述成正确结果的那句话**。

如果只修一处，优先修 R4：让 `scriptResult` 里的 fallback / assertion 决定回执措辞。它不依赖模型变聪明，也不依赖形状目录是否完整。

## 修复状态（2026-10-23）

上述根因已按代码修复，而不是继续要求模型试写脚本：

1. 新增 typed native operation `set_c4_type`，只接受 `person`、`system`、`external` 三种类型，且只允许目标为现有顶点。
2. 桥接层使用 pinned Draw.io C4 palette 的真实样式、尺寸及 `object placeholders` 标签元数据。Person 从 `mxCellRenderer.defaultShapes["mxgraph.c4.person2"]` 检查注册；Software System / External Software System 使用标准圆角卡片。
3. C4 转换不再允许通过 `run_drawio_script` 自由模拟；缺少 Person shape 时明确失败，不降级为 `umlActor`、`swimlane` 或其他近似形状。
4. 桥接执行后会校验样式、C4 标签元数据和尺寸；宿主收到序列化 XML 后再次验证结果。只有 XML 改变但实际不是要求的 C4 形状，不再算成功。
5. 补充了 operation/parser、目标解析、原生桥接和序列化后置条件测试。架构约束记录在 [ADR-0014 — Typed Native Draw.io C4 Conversion](docs/adr/0014-typed-native-drawio-c4-conversion.md)。
6. 通用运行时能力清单新增 `capabilityManifest.shapes`：调用方可传入一组 shape ID，桥接直接读取 `mxCellRenderer.defaultShapes` 并逐个返回注册结果，不再把 stencil registry 与原生 shape registry 混为一谈。查询结果经过名称校验与数量限制，并有独立回归测试。Agent prompt 明确禁止将 `mxStencilRegistry.getStencil` 当作 shape 存在性探测，也禁止因查询失败而猜测替代图形。
7. runtime bridge 协议升为 `studio-native-runtime/2`，配置偏好版本也升级，确保既有浏览器配置重新读取默认 C4 图形库列表。

本次新增的 type/contract/plugin 测试已写入仓库，但当前执行环境无法运行 TypeScript、Vitest 或生产构建；不能据此宣称已通过这些验证。

