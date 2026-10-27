# 「把桌子改成胡桃木色」失败分析：只读脚本被判成"改了但没验证"

- 日期：2026-10-27
- 事故请求：`91f113e5-cf97-4040-98fc-08f80704e3a7` / session `3034cfbf-c13c-4dde-8574-ee693d2e964a`
- 文档：`~/Downloads/drawio-diagrams-dev/examples/Floorplan.xml`（156 cells / 147 vertices / 8 edges）
- 结论：**图上的内容一个字节都没变，但宿主报"文档已改变且未通过验证"。两个独立缺陷叠加，且都不在模型身上。**

---

## 0. 现场处置（先看这段）

| 项 | 实际状态 |
|---|---|
| 图的内容 | **未改变**。156 个 cell 的增删改计数全部为 0（实测，见 §3） |
| 磁盘文件 | **被重写了**：5283 字节 → 43422 字节（压缩页被展开成明文），内容等价 |
| History | **多了一条无意义的 "Autosave" 快照**（43422 字节，revision `b0a5526a…`） |
| 用户的"桌子" | **没有被改成胡桃木色**，一次都没试成 |

所以：**不要回滚 History**（那条快照和"打开文件"快照内容等价，回滚只会把文件重新压回 5283 字节），**直接重新下指令即可**。

---

## 1. 时间线（从三处日志对齐还原）

| 时刻 (UTC) | 事件 | 关键数据 |
|---|---|---|
| 12:02:37.153 | `drawio.runtime-inspection.completed` | `cellCount:156 / vertex:147 / edge:8`，但 `returnedCells:60`、`truncated:true` |
| 12:02:37.153 | `copilot.agent.request.started` | prompt 12 字符，`nativeCellCount: 155` |
| 12:02:44 | 模型调 `search_drawio_elements {query:"table"}` | 返回 `found:false, matchCount:0` |
| 12:02:44 | 模型调 `search_drawio_elements {query:"桌"}` | **工具直接失败**：`Tool execution failed` |
| 12:02:57 | 模型改调 `run_drawio_script` | summary 自述：`Read-only inspection: list all vertex cells with shape, geometry and rotation to identify the table` |
| 12:03:00.092 | `copilot.standalone.history.snapshot` | before XML = 5283 字节（压缩页，draw.io 7.7.1 导出） |
| 12:03:00.225 | `studioPropertyEditResult` | `success:true`，`scriptResult = {ok:true, count:147, rows}` |
| 12:03:00.248 | **`drawio.script.postcondition.xml-mismatch`** | `applicationState: changed-unverified`，`xmlLengthBefore: 5283`，`xmlLengthAfter: 43422` |
| 12:03:00.251 | `drawio.document.saved` | 43422 字节被接受为权威 XML |
| 12:03:00.856 | `drawio.standalone.autosaved` | 写盘 43422 字节 |
| 12:03:00.914 | `copilot.native-edit.rejected` | 用户看到的那条报错 |

---

## 2. 根因 A：只读脚本没有验证通道（契约与校验器互相矛盾）

### 2.1 脚本本身确实只读

模型提交的脚本只有 6 个调用，**没有一个写操作**：

```js
model.getRoot() · model.getChildCount(parent) · model.getChildAt(parent, i)
c.vertex / c.edge · c.getGeometry() · model.getStyle(c) · c.getId()
```

`summary` 字段也明说 `Read-only inspection`。它的返回值是 `{ ok:true, count:147, rows:[…] }`——一份测绘结果。

### 2.2 但宿主对**所有**脚本一律要求 `postconditions`

`src/components/DrawioFrame.tsx:107-111`：

```ts
function hasVerifiedScriptPostconditions(scriptResult: unknown): boolean {
  if (!isRecord(scriptResult) || scriptResult.available !== true || !isRecord(scriptResult.value)) return false;
  const value = scriptResult.value;
  return value.ok === true && allPostconditionsTrue(value.postconditions);   // ← postconditions 缺失 = false
}
```

`DrawioFrame.tsx:886-893` 把这个布尔值当作**总开关**：

```ts
const scriptChecksPassed = hasVerifiedScriptPostconditions(scriptResult);
const assertionValidation = scriptChecksPassed
  ? validateNativeScriptResultAgainstXml(...)          // 只读脚本根本走不到这里
  : { ok: false, failures: [{ kind:"invalid-result", field:"postconditions", … }] };
```

所以一条只读测绘脚本，在"能不能通过验证"这件事上**必然为 false**，与它做了什么无关。

### 2.3 而契约只对"修改类脚本"规定了返回值

同一份契约在两处的措辞都是条件式的：

- 工具描述 `server/copilot/intent-route.ts:628` / `:633`：
  > "For every **modifying** script, return `{ ok:true, postconditions:{…}, xmlAssertions:[…] }`"
- 系统提示 `native-diagram-instructions.ts`：
  > "For every **modifying** script, return `{ok:true,postconditions:{...},xmlAssertions:[...]}`"

**没有任何一句话说明只读脚本该返回什么。** 模型按字面理解（不改 → 不需要 postconditions）→ 返回测绘结果 → 被校验器判为 `invalid-result`。

这是**契约的空集**，不是模型的幻觉。`run_drawio_script` 是唯一的原生图访问通道，而它是 `terminal` 的（`:668` "This is the terminal editing action for this turn"），所以"先看一眼再改"在架构上根本不存在——模型只能把测绘伪装成一次编辑。

### 2.4 插件侧也不区分

`plugins/studio-selection-plugin.js:849-864` 无论脚本是否产生变更，都返回 `success:true`（日志里 `batchResults[0].success: true` 印证）。整条链路上**没有任何一处**知道"这是一次只读调用"。

---

## 3. 根因 B：`dx` / `dy` 让"没变"变成"变了"

### 3.1 实测：唯一差异是视口偏移

我从 History 里取到了事故前后的**两份原始 XML**（`data/standalone-history/19587ec1…/`），直接调用仓库里的真实函数：

```
before 5283 → after 43422
changed: true
pagesChanged: [ '7a0a32d0-640e-6264-4223-eceff380f243' ]
pagesRenamed: []   pagesAdded: []   pagesRemoved: []   pageOrderChanged: false
cellsAdded: 0      cellsRemoved: 0    cellsChanged: 0      truncated: false
```

**cell 层面 0 增 0 删 0 改**，唯一的"变化"落在页级签名上。把两份 `<mxGraphModel>` 的属性逐一对比：

```
--- differing / missing attributes ---
  dx: before="1086" after="2566"
  dy: before="613"  after="1314"
```

其余 15 个属性（`grid / gridSize / guides / page / pageScale / pageWidth / pageHeight / background / math / shadow / arrows / connect / fold / tooltips`）**完全一致**。

### 3.2 缺陷在哪

`src/model/native-edit-confirmation.ts:872-874`：

```ts
const beforeSignature = semanticDiagramSignature(beforeXml, page.id);
const afterSignature  = semanticDiagramSignature(afterXml,  page.id);
if (beforeSignature !== afterSignature) changedPageIdsAll.push(key);
```

而 `semanticDiagramSignature`（`:77-99`）对整棵 `<mxGraphModel>` 做 `elementSignature`（`:66-75`，**全部属性 + 全部子元素**）。`dx/dy` 是 draw.io 序列化时写进去的**当前视口平移量**（`export` 消息里本来就带 `translate` 字段），它属于"用户正看到哪儿"，不属于"文档内容"。

于是：**只要用户在打开文档后平移或缩放过画布，任何脚本的 after XML 就必然和 before 不同**。截图里画布是 50% 缩放且已滚到房子下半部——这正是最常见的状态。

### 3.3 后果链

```
dx/dy 变了
  → diff.changed = true
  → classifyUnverifiedSnapshot() 返回 "changed-unverified"   (DrawioFrame.tsx:113-117)
  → 用户看到 "The diagram has changed, but the requested edit was not verified"
  → 文案追加 "Do not retry this edit yet; inspect the current diagram and History first"
```

正确的状态应该是 `not-applied`（`:436-437` 有现成文案 "No document change was detected for this edit"）。

顺带说明：这也解释了为什么 `xmlLengthBefore/After` 差 8 倍（5283 → 43422）看起来像"改了巨多"。那只是**压缩页被展开**。我做过对照实验：把当前明文 XML 按 draw.io 格式重新压缩后再 diff，`changed: false` —— **压缩/明文本身不会误报，只有 dx/dy 会**。

---

## 4. 为什么模型会走到这条路上（三个上游缺陷，都能修）

### 4.1 `search_drawio_elements` 对中文单字直接报错

`intent-route.ts:543` / `:550`：

```ts
query: { type: "string", minLength: 2, … }
if (typeof args.query !== "string" || args.query.trim().length < 2 || …) throw new Error("Element search requires a query from 2 to 120 characters.");
```

`"桌"` 长度 1 → 抛错。会话日志里这次调用是 `success:false, error:"Tool execution failed"`——**模型拿到的只是一个笼统失败**，不知道是长度问题。用户说的"桌子"如果被拆成单字检索，就必然失败。

### 4.2 检索只匹配 label，而这张图 147 个顶点 **0 个有 label**

送给模型的 `projectWorkspace.diagram.cells` 实测：

```
cells provided: 155
labels non-empty: 0
sample: {"id":"50","label":"","cellType":"vertex"}
```

所以 `search_drawio_elements {query:"table"}` 返回 `matchCount:0` 是必然的——**不是没有桌子，是桌子没有名字**。而该工具的描述（`:539`）声称 "Search every native cell…use before editing when the requested target is not visible"，却只按 id/label 匹配，**不看 shape、不看 geometry**。对平面图这种"纯图形无文字"的文档，它等于不可用。

### 4.3 上下文里的 cell 只有 id / label / cellType

没有 `shape`、没有 `x/y/w/h`、没有 `rotation`。用户要改"桌子"，模型唯一能拿到的定位信息是**几何 + 形状类**——而这恰恰是 prompt 里没有的。于是它做了唯一正确的工程选择：跑一个测绘脚本。

### 4.4 `runtimeInspection` 还被截断

`returnedCells: 60` / `truncated: true`（共 156 cells）。即使模型想从 inspection 里找，也只能看到 38%。

---

## 5. 连带副作用（都不致命，但都会误导）

| # | 现象 | 依据 |
|---|---|---|
| 1 | **只读调用仍然重写了用户文件**：5283 → 43422 字节，并写入 `dx=2566 dy=1314` | `drawio.document.saved` + `drawio.standalone.autosaved`；磁盘 mtime 20:03 |
| 2 | **History 多一条 no-op 快照**，label 是 "Autosave" | `index.json` 两条记录，revision 不同但语义等价 |
| 3 | **文案自相矛盾**：说 "The diagram has changed"，实际 0 cell 变化；又让用户去查 History，而 History 里只有一条等价快照 | `useCopilotIntent.ts:426-429` |
| 4 | **遥测字段撒谎**：`undeclaredChangesPassed: true`，但同一行 `undeclaredScopeAvailable: null` —— 这个检查根本没执行 | `DrawioFrame.tsx:894-897`（`scriptScope` 为 null 时直接算 pass） |
| 5 | **报错归因指向"断言"，实际是"postconditions 缺失"** | `DrawioFrame.tsx:924-926` 用 `undeclaredChangesPassed` 决定措辞，而它恒为 true |

---

## 6. 影响面

- **触发条件**：任何 `run_drawio_script` 调用 + 用户在此之前平移/缩放过画布。这是**默认情形**，不是边缘情况。
- **必然失败的两类脚本**：① 只读测绘脚本（缺 postconditions）；② 任何脚本，只要宿主认为"文档变了"而验证没过——都会被标成 `changed-unverified`。
- **历史数据印证**：`run_drawio_script` 至今被调用 4 次，**0 次通过验证**，其中 3 次是误报（本次 + 10-26 两次）。而 `propose_native_edits` 的 typed 路径调用 0 次——唯一在用的路径，正好是唯一 100% 失败的路径。
- **不受影响**：typed 操作（`set_label` / `set_style` / 布局）不经过 `hasVerifiedScriptPostconditions`，`dx/dy` 也不会让它们失败（它们走 `nativeEditIsReflectedInXml`，只比 cell 属性）。

---

## 7. 修复建议

### P0-1｜给只读脚本一条合法通道（二选一，建议都做）

**(a) 工具契约补齐**：`run_drawio_script` 增加 `mode: "mutate" | "read"`（默认 `mutate`）。
- `mode:"read"` 时：宿主跳过 `postconditions` / `xmlAssertions` 两道门；改为**必须**满足 `diff.cellsAdded/Removed/Changed` 全空（证明脚本确实没动东西），否则报 `read-script-mutated`。
- 同时把返回值在同一轮内回传给模型（见 P0-3）。

**(b) 更根本**：新增非 terminal 的 `inspect_drawio_graph` 工具（按形状类 / 几何区间 / 无 label 条件过滤），把"先看再改"变成架构内的一等公民。当前 `run_drawio_script` 是 terminal，测绘结果永远无法喂给同轮的修改——这是设计死路。

### P0-2｜`dx` / `dy` 不能算文档变化

`native-edit-confirmation.ts:77-99` 的 `semanticDiagramSignature` 在比较 `<mxGraphModel>` 时应剔除 `dx` / `dy`（视口状态）。改动面很小，且 `elementSignature` 只在这一处承担"页级签名"职责，cell 级比较走的是 `:879` 的 `elementSignature(wrapper)`，不受影响。

修好后本案例的 `applicationState` 会变成 `not-applied`，文案变成 "No document change was detected for this edit" —— 与事实一致。

### P1-1｜`search_drawio_elements` 支持单字 + 形状/几何匹配

- `minLength: 2` → `1`（CJK 单字是合法查询），错误信息带上实际长度。
- 匹配维度加入 `shape`（`style` 里的 `shape=`）与几何包含关系（"point in box"），让"平面图里的桌子"可被找到。
- 把 `Tool execution failed` 换成真实原因（现在是 `success:false` 且无 message）。

### P1-2｜prompt 里的 cell 补 `shape` / `geometry`

`projectWorkspace.diagram.cells` 当前只有 `{id,label,cellType}`。至少补 `shape`（一两个 token）和 `x/y/w/h` 取整值——否则"按形状找目标"在上下文层面无解。同时 `runtimeInspection` 的 60 条截断需要有分页/过滤入口。

### P2｜只读且无变化时不落盘、不进 History

`drawio.document.saved` + `standalone.autosaved` 现在对任何脚本都无条件执行。若脚本只读且 `diff.changed === false`，应跳过持久化与快照创建，避免用户文件被重写、History 被污染。

### P2｜修遥测

`undeclaredChangesPassed` 在 `scriptScope === null` 时不应报 `true`，应报 `null`（未执行）。当前值会让所有排查者误判"范围检查通过了"。

---

## 8. 回归清单

| 测试 | 断言 |
|---|---|
| 只读脚本（不改 model） | 不报 `changed-unverified`；`applicationState === "not-applied"`；脚本返回值回传给模型 |
| 只读脚本 + 仅 `dx/dy` 变化 | 同上（这是本次事故的最小复现） |
| 修改脚本 + 断言全对 + 用户平移过画布 | `applied-and-verified`（不能被 dx/dy 打挂） |
| 修改脚本 + 只改 dx/dy 不改 cell | 报 `read-script-mutated` 或 `not-applied`，不能报 `changed-unverified` |
| `search_drawio_elements {query:"桌"}` | 不抛错，返回 `matchCount`（可为 0） |
| 现有 `native-edit-confirmation.test.ts` | 新增"仅视口变化不算 changed"用例；注意别把当前错误行为固化成期望值 |

---

## 9. 证据位置

| 内容 | 路径 |
|---|---|
| 事故前后两份原始 XML | `~/.architecture-diagram-studio/data/standalone-history/19587ec19912679943c4f29851f391c847bf6616519255b2312f54b016b7934d/{2d7e1c08…,ec061208…}.xml` + `index.json` |
| 完整事件流（27 条） | `~/.architecture-diagram-studio/logs/application-events.jsonl`（`2026-10-27T12:0*`） |
| 模型原始工具参数（含脚本全文） | `~/.architecture-diagram-studio/copilot/session-state/3034cfbf-…/events.jsonl` 第 22 行 |
| 用户磁盘文件现状 | `~/Downloads/drawio-diagrams-dev/examples/Floorplan.xml`（43422 字节，mtime 20:03） |

复现脚本（本次实际使用）：`/tmp/probe-diff.mts`、`/tmp/probe-modelattrs.mts`、`/tmp/probe-floorplan.mts`。

---

**实施记录（2026-10-27）**

已按上述根因直接修改 `main`：

- **P0-2**：页面语义签名在比较 `mxGraphModel` 时忽略 `dx/dy`，cell、style、geometry 和其余模型属性仍参与比较；新增压缩/展开 XML 的视口平移回归测试。
- **P0-1**：`run_drawio_script` 增加 `mode: read | mutate`，默认仍为 mutate。只读脚本有独立的模型/编辑器快照检测和一组只读 API 防护；若改动内容则拒绝结果。读取结果不再要求伪造 edit postconditions。
- **P0-1(b)**：新增非终结式 `inspect_drawio_graph`，按 shape、无标签、cell 类型、点/矩形范围过滤，并支持分页，返回当前页面的真实 native cell ID、shape、geometry、rotation、parent ID。它的结果可以继续供当前 Agent turn 规划修改，不需要把测绘伪装成一次编辑。
- **P1-1 / P1-2**：普通元素搜索支持单字中文，并检索 shape、geometry、rotation、parent ID；prompt 的私有目标索引与工具返回值提供几何信息，但前 80 个 prompt target 的输出仍然受控，完整索引留给检索工具。
- **P2**：当只读脚本未改变语义 XML 时，Studio 不调用文件/工作区持久化，不新建 History 版本，也不会将视口平移产生的临时序列化 XML覆盖用户文件。最终确认仍记录只读结果，但不声称图已修改。
- **诊断准确性**：未运行的 undeclared-change 范围校验会记为 `null`，不会误报为通过；失败文案区分脚本断言失败与范围校验未执行。

新增/更新的测试覆盖视口变化、只读脚本 dispatch/ack、形状/几何上下文、单字中文检索、无标签图元过滤和分页。Playwright E2E 另覆盖 workspace 只读检查不改变 XML/版本数、只读模式拦截 model 写操作，以及 standalone 模式下文件内容和本地 History 条目不变。最终构建与原生画布 E2E 状态以最近一次 V2 CI 结果为准。

