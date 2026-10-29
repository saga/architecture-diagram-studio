# 架构与代码审查（代码级）

- 审查日期：2026-10-29
- 审查对象：`main` @ `9beb8685`，`v2/` 活跃实现（`src` + `server` 共 94 个 TS/TSX 文件、27.6k 行，含测试）
- 审查方式：逐文件静态阅读 + 复用最小探针复现（未修改任何代码）
- 本轮已执行：`npx tsc --noEmit` 通过；`npx vitest run` 38 文件 / 490 用例全绿
- 与同日 `ARCHITECTURE-REVIEW-2026-10-29.md` 的关系：那份偏架构判断，本份只写**能在代码里指出行号或实测复现**的问题，不重复其结论

## 0. 后续复核状态（2026-10-29）

本报告的发现已针对当前 `main` 复核，以下确认的问题已修复：

- **C1（缺失页面错误分类）**：快照缓存现在区分 `invalid-xml` 与 `page-not-found`；合法多页文档中请求不存在的页面返回 409 `stale_context`，真正的非法 XML 仍返回 400，并新增缓存回归测试。
- **CI lockfile**：两个 CI job 改用 `npm ci`，缓存键依赖 `v2/package-lock.json`，删除 PR 自动回写 lockfile 的步骤，权限收紧为 `contents: read`。
- **C5（变更集 apply 死代码）**：删除永不成立的 Map/null 检查和恒等三元表达式。其余未确认影响的导出暂时保留。

其他条目仍是本次静态审查记录的风险或建议，不能视为已修复；特别是 C3 仍需动态验证，A1/A3/A4/A5、C2/C4 以及测试覆盖缺口仍需分别评估。

## 1. 结论摘要

| 维度 | 判断 | 证据强度 |
|---|---|---|
| 单一事实源（原生 XML） | 成立，无第二可写模型 | 代码 + ADR 一致 |
| 页身份语义 | 本周已收敛到 `resolveNativePageIdentity`，但页面枚举仍有 3 份实现 | 代码可查 |
| 结果可信度 | 服务端只验回执"形状 + 持久化版本"，语义验证全在浏览器 | 代码可查 |
| 错误分类 | 多页文档缺页被报成"XML 非法"（400），409 分支不可达 | 探针实测 |
| 大文件性能 | 单次缓存未命中解析同一份 XML 3 次，主线程同步 | 代码可查 |
| 工程护栏 | 无 lint、CI 回写 lockfile、E2E 只跑 4/6、无组件级单测 | 配置可查 |
| 文档治理 | ADR 编号 0017/0020/0023 各有一对，索引只收录其中一个 | 文件可查 |

同日那份架构审查的总体判断（方向正确、风险集中在边界上的重复实现）在本轮代码级检查中继续成立，并且能落到具体位置：本周的 stale_context 复发就是这个模式的样本——同一个根因在四个不同层各修一次，直到把身份解析收口才停止。

## 2. 架构层面

### A1. 页身份收口了，页面"容器解析"还没收口（P2）

新入口 `resolveNativePageIdentity` 只解决了"哪一层该用哪个 ID"。但"从 XML 里找出某一页并解出模型"这件事仍有独立实现：

| 位置 | 实现 |
|---|---|
| `v2/src/model/native-edit-operations.ts:126` | `readPageInfo`（canonical） |
| `v2/src/model/drawio-theme.ts:245` | `parseNativePageModel`：自己找 `<diagram>`、自己 `decodeCompressedPage` |
| `v2/src/model/native-edit-confirmation.ts:1203` | diff 内部再写一遍页枚举（`pageInfo(xml)`） |
| `v2/plugins/studio-selection-plugin.js` | 运行时 `currentPageId()`（这一份合理，属于编辑器侧） |

三份 TS 实现里，只有 canonical 那份认识 `NativePageIdentity`。本周的 bug 正是"同一概念多处推导"造成的；身份维度修好了，容器维度还留着同样的结构风险。建议把"页枚举 + 解码"一并放进 `drawio-xml-dom` 或身份模块，主题与 diff 只消费结果。

### A2. 语义验证的权威在浏览器，服务端只验回执（架构事实，非缺陷）

- `applied-and-verified` 由 `DrawioFrame` 计算（断言校验 + 前后 XML 范围 diff + 持久化），
- 服务端 `/api/copilot/intent/ack`（`intent-route.ts:409`）校验的是：outcome 合法、`applicationState` 必须是 `applied-and-verified`、非 standalone 时 `versionId` 对应的不可变版本 revision 必须等于 `serializedXmlRevision`。

也就是说：**服务端能证明"这份 XML 确实被保存成了这个版本"，但不能证明"这份 XML 确实是脚本声明的那些改动"**。standalone 模式下连版本校验都没有（文件归浏览器所有）。

对单用户本地工具这是合理取舍，但应当在文档里写清信任边界，避免后续把 `applicationState` 当成服务端可验证的事实。

### A3. 两条编辑路径的验证强度不对称（P2）

| 路径 | 声明范围校验 |
|---|---|
| `run_drawio_script` | 有：`xmlAssertions` + `findUndeclaredNativeScriptChanges` 前后 diff |
| typed batch（`cell:batch`） | 无范围 diff，只有逐操作目标/取值校验 |

typed 操作是确定性的，被改范围天然受操作列表约束，风险低于脚本。但 `add_node_after` 这类会新增 cell 的操作，其"新增了什么"没有同等证据链。若后续出现"typed 操作改坏了别的元素"，排查手段会比脚本路径弱一档。建议在 typed batch 落地时复用同一份 diff（成本很低，函数已经存在）。

### A4. 变更集 prepare/apply 已接线但无调用方（P2）

`server/copilot-server.ts:984`、`:1010` 注册了 `/api/workspace/diagram-change-set/prepare|apply`，`apply` 接受**完整替换 XML**并做页级不变量校验。全仓 `src/` 无任何调用：

```
grep -rn "diagram-change-set" src → 只有 src/model/workspace-diagram-change-set.test.ts
```

`docs/adr/0017-workspace-multi-file-multi-page-copilot-changes.md` 自己写明 "backend prepare/apply foundation implemented; Copilot and UI integration pending"，所以这是**分阶段能力的半成品，不是死代码**。但它在待接线的这段时间里，是一个"能被本机任意页面 POST、且能整份覆盖工作区文件"的写入面。建议要么在路由层加显式开关（如 `STUDIO_ENABLE_CHANGE_SET=1`），要么在文档写明"当前无 UI/Copilot 入口，仅供后续集成"。

### A5. 布局与 XML 库的加载策略（P2）

`src/layout/native-layout.ts` 顶部**静态**引入 `@dagrejs/dagre` 和 `elkjs/lib/elk.bundled.js`，而 `native-layout` 被 `App.tsx:19` 静态引入 → ELK 进首屏主包（产物中主包内可检出 381 处 `elk` 标识，两个懒加载 chunk 均为 0）。实测产物：

| chunk | 大小 |
|---|---|
| `index-*.js` | 2.7 MB（gzip 882 kB） |
| `dist-*.js`（懒加载） | 754/799 kB |
| `cytoscape*.js`（懒加载） | 425/119 kB |

另外 4 个引擎（graphviz/msagl/cytoscape/d3）已经是 `await import()`，这个方向是对的；**只剩 ELK 和 Dagre 在关键路径上**。同时主包还包含 `@xmldom/xmldom`（探针：bundle 内可见 `HierarchyRequestError`、`InvalidCharacterError`、`xmldom` 字样），因为 `src/model` 同时被浏览器和 Node 复用，浏览器本可以用原生 `DOMParser`。

建议：`auto_layout` 首次调用时再 `import()` 布局模块，或至少把 ELK 拆成独立 chunk；主包目标压到 1 MB 以内。对一个本地工具不是致命问题，但它直接决定首屏等待时间。

## 3. 代码级问题

### C1. 多页文档缺页 → 报成"XML 非法"（P2，已实测）

`getCachedNativeDiagramSnapshot`（`server/copilot/diagram-snapshot-cache.ts:62`）先算 identity，再用 `identity.documentPageId` 提取 targets：

```
const identity = resolveNativePageIdentity(xml, requestedPageId);
targets: extractNativeEditTargets(xml, identity.documentPageId, …)
```

当请求的 page 不存在于一个**多页** mxfile 时，`identity.documentPageId` 为 `null`，`parseNativeGraphModel` 抛 "The Draw.io document has multiple pages but no active page ID"，被 cache 吞成 `{ok:false}`，路由返回 **400 "The Copilot request contains invalid Draw.io XML"**。

探针结果：

```
missing page on 2-page doc → false     （→ 路由 400 invalid XML）
missing page on 1-page doc → true      （→ 走到 nativePageAccepts，409 stale_context）
```

同一类错误在两页文档上得到两种状态码，且 409 那条分支在多页场景下**永远不可达**。这正是"页面被删了"最常见的情形，用户看到的是"XML 非法"。

修法很小：cache 返回带原因的失败（`invalid-xml` / `page-not-found`），路由据此分别给 400/409。

### C2. 同一份 XML 被解析 3 次，且是同步阻塞（P2）

缓存未命中时的调用链（`diagram-snapshot-cache.ts` + `drawio-xml-schema.ts:547`）：

1. `validateDrawioXmlDocument(xml)` — 解析 #1
2. `resolveNativePageIdentity(xml, …)` — 解析 #2
3. `extractNativeEditTargets(xml, …)` — 解析 #3

上限 20 MB（路由侧还有 25 MB body 限制）。`@xmldom/xmldom` 是纯 JS 解析器，20 MB 量级的单次解析在 Node 主线程是百毫秒级，三次叠加会阻塞其他请求与日志写入。客户端侧同一 turn 内也有多次全量解析（`calculateDrawioXmlRevision` + 两次 identity + targets）。

建议：解析一次得到 DOM，后续函数接受 `Document` 重载；或把解析结果按 `revision` 缓存（服务端已有 revision 概念，天然可做 key）。这一条不改正确性，只改响应时间。

### C3. 脚本范围校验依赖组件状态里的 `beforeXml`（需动态验证）

`DrawioFrame.tsx:579` 在发送 `studioPropertyEditRequest` 时把 `beforeXml: xml` 存为快照，范围校验用它和导出结果做 diff。`xml` 是 React 状态里"最后一次收到的 XML"，只在 Draw.io 抛出 `save`/`autosave` 时回灌（`DrawioFrame.tsx:908`、`:1235` → `onDocumentChange` → `setNativeXmlOverride`）。Draw.io 的 autosave 与编辑不是同步的，所以存在一个窗口：用户在 iframe 里改了图、autosave 尚未到达，紧接着让 Copilot 改另一处，于是：

- 脚本只改了 A；
- 前后 diff 里还带着用户刚改的 B；
- `findUndeclaredNativeScriptChanges` 会把 B 判成"未声明的既有单元格改动" → `changed-unverified` + 明确报"改动超出脚本声明范围"。

这属于**误报方向**的失败（不会掩盖真问题），但会直接毁掉一次本已成功的编辑。是否可复现取决于 Draw.io autosave 的触发间隔：间隔越大，窗口越大。建议：执行脚本前先向 iframe 要一次当前 XML 作为基线，而不是信任 React 状态；或在 diff 里排除"与脚本目标无关且差异时间早于请求"的单元格。**这一条我没有动态验证，标记为待确认。**

### C4. 变更集用"重序列化字节比较"判定哪些页改了（P2，接入 UI 前需定论）

`workspace-diagram-change-set-apply.ts:142`：

```
const actuallyChangedPages = [...beforePages].filter((id) => beforePageXml.get(id) !== afterPageXml.get(id));
```

`beforePageXml` 来自磁盘文件解析后重新序列化，`afterPageXml` 来自客户端提交的 `resultXml`。Draw.io 在保存/导出时可能规范化未触碰页面的属性顺序、空白或自闭合写法。一旦发生，未改动的页会被算作"实际改动"，与客户端声明的 `changedPageIds` 不一致 → 整个变更集被拒。

ADR-0017 的 UI 尚未实现，现在正是定义契约的时机：要么要求客户端**只拼接被改页面**、其余页保持原始字节（当前注释暗示了这一点），要么把比较降级为"页内含 cell/几何语义差异"，而不是字符串相等。

### C5. 重构遗留的死代码（P3）

| 位置 | 问题 |
|---|---|
| `workspace-diagram-change-set-apply.ts:131` | `const normalizedId = cond ? id : id;` —— 三元两个分支返回值相同，纯常量 |
| `workspace-diagram-change-set-apply.ts:127` | `if (beforePages === null \|\| afterPages === null)` —— `pageXmlById` 永远返回 `Map`，分支不可达 |
| `native-edit-operations.ts:90` / `:140` | `isBareNativeGraphModel`、`getNativeDiagramPageInfo` 在生产代码中已无调用（仅测试引用）——我上一轮收口时留下的空壳导出 |

前两条是接入时就有的；第三条是本次重构的直接后果，建议删掉导出或改由 `resolveNativePageIdentity` 暴露等价能力，避免下一个人以为"还有两个入口"。

### C6. 主题模块的可读性（P3）

`drawio-theme.ts` 247 行，但 `parseNativePageModel`、`calculateNativePalettePlan`、`detectDrawioDiagramTheme` 都是单行上千字符的实现（例如 `:245` 的 `parseNativePageModel` 一行内含解码、页选择、错误文案）。逻辑本身正确（也复用了 canonical 解析器），但它同时承载了"页选择 + 压缩页解码 + 颜色角色 + 对比度回归"四件事，任何一处改动都要在长行里做字符串级定位。建议按页解析 / 角色分配 / 样式应用拆三段，纯格式整理，不改行为。

### C7. 没有 React 错误边界（P3）

`App.tsx:519` 只装了 `window.addEventListener("error"/"unhandledrejection")` 记录诊断。一旦某个 render 抛错（例如 inspector 遇到非预期 cell 结构），React 18 会卸载整棵树——白屏，只剩 console。诊断日志能事后查，但用户当场无法操作。加一个顶层 `ErrorBoundary`（展示"重载/导出诊断"两个动作）成本很低。

## 4. 工程与测试

| 项 | 现状 | 影响 |
|---|---|---|
| Lint | 无 eslint 配置，无 `lint` script | 27.6k 行只靠 `strict` + `noUnusedLocals`；`no-floating-promises`、`no-misused-promises` 这类真会抓 bug 的规则缺席 |
| CI 安装 | `npm install --no-audit --no-fund`，`cache-dependency-path: v2/package.json` | 解析结果随上游漂移；cache key 也没落在 lockfile 上 |
| CI 回写 lockfile | PR 阶段 `createOrUpdateFileContents` 直接改被测分支，`permissions: contents: write` | 测的不是评审时的提交；fork PR 会失败；权限面过大 |
| E2E 覆盖 | CI 只跑 `02/04/05/06`；`01-workspace.spec.ts`、`03-navigation.spec.ts` 不在 CI | 工作区与导航链路的回归无人守 |
| 组件测试 | `src/components/` 4 个组件（`DrawioFrame` 1312 行、`WorkspacePages` 451 行）+ `App.tsx` 2344 行，只有 `drawio-frame-config.test.ts` | 脚本确认、范围校验、持久化确认这些最易出错的逻辑几乎没有单测，只有 E2E |
| 类型边界 | 单个 `tsconfig.json`，`lib` 含 `DOM`，`include` 同时覆盖 `src` 与 `server` | 服务端代码可以用 `document`/`window` 而通过类型检查，只在运行时炸 |
| 覆盖率 | 无 coverage script / 无阈值 | 490 个用例，但"哪些路径没测"不可见 |
| 仓库体量 | `v1/` 45 个文件仍在版本库 | 已声明"只读参考"，但会进入 grep/搜索干扰 |

关于测试策略，有一点值得强调：本周四个 bug（stale_context 复发、裸模型布局回滚、未声明改动、页身份不一致）有同一个特征——**都是"两处实现对同一个概念的约定不同"，而单测都在各自一侧断言自己的约定**。这类缺陷用"某某函数返回什么"的测试抓不住，只能靠跨层不变量（例如"同一份 XML 在客户端与服务端解析出的页身份必须相等"）。建议补一组这样的对偶断言。

## 5. 安全与运行边界（事实陈述）

| 边界 | 现状 | 判断 |
|---|---|---|
| Studio API | `app.listen(PORT, "127.0.0.1")`（`copilot-server.ts:1716`），不受 Vite `0.0.0.0` 决策影响 | 正确 |
| API 来源校验 | 仅对 `/api/workspace`、`/api/copilot`、`/api/local` 检查 `origin/referer` 的 **hostname** 是否属于 localhost 白名单；**没有 origin/referer 的请求直接放行**（`:422-433`） | localhost 上任意端口的页面、以及本机任意进程（curl）都可通过；对单用户工具可接受，但它不是 CSRF 防护 |
| Draw.io 静态服务 | 独立端口 127.0.0.1:4176，`frame-ancestors` 限定 Studio 端口，`connect-src 'self'`，`object-src 'none'` | 结构正确。注意启动日志写的是 "connect-src 'none'"，与策略实际值（`'self'`）不一致，属文案漂移 |
| 脚本执行 | `new Function(...)`（plugin `:1330`），前置正则拦截 async/timer/fetch/parent 访问（`:852-862`） | 正则挡不住拼接字符串构造，ADR-0023 已明确这不是安全边界；与实现一致，无需改，但不要在文档上弱化 |
| 跨源消息 | 双向都校验 `event.origin` / `event.source`；握手阶段 hello 用 `"*"` 发送（不含敏感数据） | 可接受；握手可进一步限定为目标 origin |
| XML 输入 | DTD/ENTITY 正则预检 + xmldom 错误收集；20 MB XML / 25 MB JSON body | 预检是字符串级，属于"拒绝明显攻击"而非"证明安全"；JSON 转义会让 20 MB XML 有概率撞上 25 MB body 上限，建议两者取同一基数 |

## 6. 建议优先级

| 优先级 | 动作 | 改动面 | 收益 |
|---|---|---|---|
| P1 | 修 C1：cache 返回失败原因，多页缺页给 409 | `diagram-snapshot-cache.ts` + 一处路由判断 | 最常遇到的"页没了"不再被报成 XML 非法 |
| P1 | CI 改 `npm ci`、删掉 lockfile 回写、`cache-dependency-path` 指向 lockfile | workflow | 评审对象与测试对象一致 |
| P2 | C2 解析一次复用；C3 脚本基线向 iframe 现取 | model 层重载 + `DrawioFrame` | 大文档响应时间、消除范围校验误报 |
| P2 | A1 页枚举/解码收进一个模块 | `drawio-theme` / `native-edit-confirmation` | 消掉最后一类"同一概念多处推导" |
| P2 | A4 给 change-set 路由加开关或写清"未接线" | 路由 / ADR-0017 | 缩小未使用写入面 |
| P2 | A5 布局模块按需加载 | `App.tsx` / `native-layout` | 首屏从 2.7 MB 降下来 |
| P3 | C5 删死代码、C7 错误边界、C6 主题模块分段 | 局部 | 可维护性 |
| P3 | ADR 重新编号（0017/0020/0023 各有一对），更新 `ARCHITECTURE-V2.md` 状态与代码地图 | docs | 引用不再跳错文档 |

## 7. 本轮验证与限制

- 已执行：`npx tsc --noEmit`（通过）、`npx vitest run`（38 文件 / 490 用例通过）；本节结论均基于该提交。
- 已用探针复现：多页 mxfile + 不存在的 pageId → `getCachedNativeDiagramSnapshot` 返回 `ok:false`；单页同条件返回 `ok:true` 且 `pageExists:false`。
- 构建产物大小取自本地 `dist/`（同提交构建），未在 CI 环境复测。
- C3（范围校验误报）为代码路径推断，未做动态复现；C4 依赖尚未实现的客户端契约，属设计风险而非现存缺陷。
- 未做：Playwright E2E、依赖漏洞扫描、Node 侧并发压测。
