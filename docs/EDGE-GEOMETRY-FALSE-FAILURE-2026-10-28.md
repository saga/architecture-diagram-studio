# 「把所有的线变成曲线」：假失败 + 强制确认 + 代码泄露

日期：2026-10-28
Session：`9106e5f4-1acf-4bce-a1b6-3e7ace1d9e88`
请求：`把所有的线变成曲线`（promptLength 29）
文档：`srzabb6JrwGZ0LaROR4p`，revision `35dfaf37…`

---

## 0. 三条结论

| 问题 | 结论 | 性质 |
|---|---|---|
| terminal 为什么报错 | **编辑成功了，报错是假的**。39 条断言失败里，40 条候选中有 39 条来自"边几何属性在 XML 中被省略（null）vs 上下文报 0"，另外 11 条来自"唯一真正变了的 `geometry.points` 没被声明" | 契约结构性缺陷，不可能通过 |
| 为什么还要 confirm | `requiresExplicitConfirmation()` **硬编码**：任何 `run_drawio_script` 一律返回 true。没有 env、没有设置项、没有 UI 开关 | 设计决策，非 bug |
| 为什么还显示一大堆代码 | 写消息时用**中文 header + 裸脚本**，渲染时 `hideNativeScriptDetails` 只认**英文 header + ``` 围栏**，两者不匹配 → 原样输出 | 两套模式不一致 |

---

## 1. 现场事实（可复现）

时间线（本地时间）：

```
18:13:40  打开文件快照 fec2e5a0   xmlLength 9957   revision 35dfaf37
18:15:44  run_drawio_script 执行（terminal，turn 结束后跑）
18:15:45  drawio.script.postcondition.xml-mismatch   assertionFailureCount 39
18:15:46  Autosave e4da249a      xmlLength 11144  revision ae9b8623
```

对改前/改后 XML 做逐 cell 语义比对：

- 文档 27 个 cell，**只有 11 条 edge 变化**，没有任何 vertex 变化
- **11/11 条边在改之前就已经有 `curved=1`**，改后 style **一字未变**（11/11 完全相同）
- 唯一真实变化：**每条边新增 1 个 waypoint**（`<Array as="points"><mxPoint x=… y=…/></Array>`）

也就是说：这次"把线变成曲线"的物理动作只有 `geometry.points` 一处，脚本自己的 3 条 postcondition 全部为 `true`（`changed=11/11`、`onlyEdges=true`、`curved=true`、`waypoint=true`）——**脚本自检是对的**，是宿主侧的证据校验判死的。

日志：

```json
{"applicationState":"changed-unverified",
 "booleanPostconditionsPassed":true,
 "serializedAssertionsPassed":false,
 "undeclaredChangesPassed":false,
 "assertionFailureCount":39,
 "undeclaredViolations":[11 条 edge],
 "uniqueAssertionFailureFields":["geometry.x","geometry.y","geometry.width","geometry.height"]}
```

`rolledBack: false` → 没有回滚，改动已序列化并 autosave（revision `ae9b8623`）。截图里的曲线是真的。

---

## 2. Q1：为什么 terminal 报错

### 2.1 39 条 mismatch 是算术上的必然

`xmlAssertions` 是 `edges.map(e => ({cellId, kind:'edge', style:{curved:'1'}, geometry:{x,y,width,height}}))`，共 11 条 × 4 字段 = 44 个待验值。实测对照（改后 XML）：

| cell | 序列化 `<mxGeometry>` | 活模型/上下文报的值 | 结果 |
|---|---|---|---|
| 71,72,70,69,76,75,78（7 条） | `relative="1" as="geometry"`，**x/y/width/height 全缺** | `{0,0,0,0}` | 4 条失败 × 7 = **28** |
| 68 | `x="-0.1434" y="-8"` | 活模型 `x=-0.1434, y=-8, w=0, h=0` | x/y 命中，width/height 失败 = **2** |
| 11,12,13（3 条） | `width="160"`，其余缺 | `{0,0,160,0}` | width 命中，x/y/height 失败 = 3 × 3 = **9** |

**28 + 2 + 9 = 39**，与 `assertionFailureCount: 39` 精确一致。

根因是两个函数对"属性缺失"的处理相反：

```ts
// v2/src/model/native-edit-confirmation.ts:517-520  —— 校验器：缺失 = null
function numericXmlAttribute(element, name) {
  if (!element || !element.hasAttribute(name)) return null;
  ...
}
// :547-551
function numericEvidenceMatches(expected, actual) {
  if (expected === null) return actual === null;
  return typeof expected === "number" && typeof actual === "number" && … Math.abs(expected-actual) <= 0.01;
}
```

```ts
// v2/src/model/native-edit-operations.ts:193-207  —— 上下文构造：缺失 = 0，并且取整
const geometryValue = (key) => {
  const raw = geometryElement?.getAttribute(key);
  const value = raw === null || raw === undefined || raw.trim() === "" ? 0 : Number(raw);
  return Number.isFinite(value) ? value : 0;
};
const geometry = { x: Math.round(geometryValue("x")), y: …, width: …, height: … };
```

draw.io 序列化器对 edge 的 `mxGeometry` **只在非默认值时才写属性**（边没有盒子，x/y/w/h 默认 0）。于是：

- 模型拿到的 `diagram.cells[].geometry` 和 `inspect_drawio_graph` 的返回都是 `{"x":0,"y":0,"width":0,"height":0}`
- 校验器读到的 `actual` 是 `null`
- `numericEvidenceMatches(0, null)` → `false`

**结论：对任何 edge，`geometry:{x|y|width|height}` 断言在结构上不可能通过**，除非该属性恰好被显式序列化（如 68 的 `y="-8"`、11/12/13 的 `width="160"`）。工具描述还在鼓励这个写法：`"geometry must contain explicit expected fields"`。

顺带一个副作用：`Math.round` 让上下文与活模型也不一致（68 的 `x=-0.1434`，上下文报 0，活模型报 -0.1434）。这次恰好是活模型的值命中了序列化值，否则 68 还会再多一条失败。

### 2.2 唯一变了的字段，恰恰没声明

```ts
// native-edit-confirmation.ts:1005-1017
if (changedFields.includes("geometry")) {
  const changedGeometry = nativeGeometryChangedFields(oldRecord.geometry, nextRecord.geometry);
  for (const field of changedGeometry) {
    const key = field.slice("geometry.".length);           // "points"
    if (!Object.prototype.hasOwnProperty.call(assertionGeometry, key)) missing.push(field);
  }
}
```

实际变更集 = `geometry.points`（11 条边）。声明集 = `style.curved` + `geometry.x/y/width/height`。

- `style:{curved:'1'}` → 声明了，但它**没变**（11 条边本来就有）
- `geometry.points` → 变了，但**没声明** → 11 条 `unproven-change`

这是这次失败里最有教育意义的一点：模型把"我要让线变弯"翻译成了"声明 curved 和几何框"，而系统的语义是"**逐字段证明你改动过的每一个字节**"。两者恰好错位。

### 2.3 于是 UI 说了两句互相矛盾的话

```
The confirmed proposal was not applied: Serialized XML did not match declared assertions for …
The document changed beyond the declared assertions. Assertion diagnostics: …
```

- 前半句来自 `useCopilotIntent.ts:748-753`：`execution.ok === false` → 固定文案 `"The confirmed proposal was not applied: " + reason + (rolledBack ? " The batch was rolled back." : " Reload the diagram before continuing.")`
- 后半句来自 `DrawioFrame.tsx:1140-1148` 的 `failureHeadlines`，其中明确包含 `"The document changed beyond the declared assertions"`

同一个 `applicationState: "changed-unverified"` 在 `DrawioFrame.tsx:1165-1170` 已经被正确翻译成 `auditWarning = "Changes may already be present and saved…"`，但**确认路径从来不读 `auditWarning`**（只有非确认路径的成功分支会拼它）。用户看到的是"没应用 + 文档已改变 + 去重新加载"，而事实是"已应用、已保存、别重试"。

### 2.4 诊断信息被截断两次，量级消失

| 位置 | 行为 |
|---|---|
| `DrawioFrame.tsx:1088` | `deduplicatedAssertionFailures.slice(0, 8)` → 用户只看到 8 条，**没有"共 39 条"** |
| `src/diagnostics.ts:30` | `Array.isArray(value) ? value.slice(0, 20)` → 日志里 20/39 |
| `uniqueAssertionFailureFields` | 只有 4 个字段名（`geometry.x/y/width/height`），看不出是 11 条边 × 4 |

截图里那 8 条一模一样的 `geometry.x/y/width/height`，看起来像"一大堆噪声"，实际是同一个缺陷重复 39 次。

---

## 3. Q2：为什么还需要 confirm

### 3.1 是硬编码策略，不是配置

```ts
// v2/server/copilot/intent-route.ts:245-251
export function requiresExplicitConfirmation(operations, forceScriptReview = false): boolean {
  // Scripts execute arbitrary Draw.io JavaScript in the editor runtime. Until execution is
  // capability-restricted, they must always be reviewed explicitly, including repair attempts.
  if (forceScriptReview || operations.some((op) => op.op === "run_drawio_script")) return true;
  return operations.some((op) => op.op === "delete" || op.op === "auto_layout");
}
```

- 命中 → `intent-route.ts:1596-1616` 生成 `pendingNativeProposals` 并返回 `outcome:"proposal_required"`，**一次都不执行**
- 不命中（普通 typed edit：rename / move / style）→ 走 `command_ready` 快路径，**直接应用，无需确认**
- 全仓库 `requiresExplicitConfirmation` 只有一处调用、一处测试；**没有 `process.env` 开关、没有设置项、没有 UI 开关**（`v2/src/components` 只有 3 个组件，无 settings 页）

### 3.2 SDK 的权限层不是原因

`runtime.ts:715-745` 的 `onPermissionRequest` 直接 `return { kind: "approve-once" }`。会话事件里 7→8、17→18 的 `permission.requested → permission.completed` 时间差为 0ms，`result: {kind:"approved"}`。所以那个 Confirm 按钮**只可能**来自 Studio 自己的 proposal 门。

### 3.3 想自动批准，只有三条路

| 方案 | 代价 | 建议 |
|---|---|---|
| (a) 加 `allowUnreviewedScripts` 设置，脚本也直接跑 | 等于把"任意 JS 执行权"交给模型，一次幻觉即可改坏整页 | ✗ 不建议 |
| (b) 把高频需求做成 typed op / 受限 DSL（改样式、加控制点、改 label），走 fast path | 要写能力层，但这是唯一"既自动又安全"的路 | ✓ 推荐 |
| (c) 脚本指纹缓存：同一份脚本（hash + 目标 revision 范围）验证过一次后，重复执行免确认 | 实现小，只覆盖重试场景 | ✓ 推荐 |

注意 (b) 的现实性：本次需求（"给每条边加中点控制点"）完全可以用一个 `add_edge_waypoints` typed op 表达，且天然免确认。而现在的实现逼着模型写 3KB 脚本，于是必然触发确认 + 断言契约 + 39 条噪声。

---

## 4. Q3：为什么还显示一大堆代码

### 4.1 写入端和渲染端用了两套互不认识的模式

**写入**（`v2/src/hooks/useCopilotIntent.ts:262-268`）：

```ts
const safeReply = hideNativeScriptDetails(plan.reply);      // 把模型自己的回复洗干净
…
text: safeReply + "\n\n**Proposed changes:** " + safeSummary +
      (reviewScript ? "\n\n原生 Draw.io 脚本（完整内容）：\n" + reviewScript +
        "\n\n只有实际结果检查全部通过并且序列化 XML 符合预期，才会确认成功。" : "") +
      "\n\nNothing has been changed yet. Confirm to apply this proposal to the current diagram."
```

**渲染**（`v2/src/components/WorkspacePages.tsx:280`）：

```tsx
<Bubble content={hideNativeScriptDetails(message.text) || …} />
```

**清洗规则**（`v2/src/intent/hide-native-script-details.ts:6-13`）只匹配两种形状：

```ts
/\n{0,2}\*{0,2}Exact native script for review:\*{0,2}[\s\S]*$/i   // 英文 header
/\x60{3}(?:javascript|js|typescript|ts)\s*[\s\S]*?\x60{3}/gi      // ```js 围栏
```

写入端用的是**中文 header + 裸文本（无围栏）**，两条规则都不匹配 → 整段原样渲染。这就是"以前要求隐藏、现在又出来"的直接原因。

### 4.2 这是一次有意的回归，不是漏改

```
b3caa6be  2026-10-23 16:56  Hide native scripts and auto-confirm verified insert-only edits
027ff3ee  2026-10-24 09:51  Require verified script outcomes and expose proposal code for review
```

`027ff3ee` 的提交标题就写着 "expose proposal code for review" —— 为了让用户在确认前看到要执行的脚本，**主动**把代码加回了消息体。当时没同步更新清洗规则，也没加折叠。

`hide-native-script-details.test.ts` 三个用例全部基于英文 header + 围栏，所以 CI 一直绿。

### 4.3 正确做法

- 删掉 `useCopilotIntent.ts:266-267` 这段拼接。脚本已经在 `proposal.script` 里（`:269`），需要时用折叠面板展示，不必进消息正文。
- 如果一定要在正文里留，就**用同一个函数生成和清洗**（`formatScriptReview(script)` / `hideNativeScriptDetails` 成对），别让两边各写一套模式。

---

## 5. 修复优先级

### P0（这次事故的直接原因）

1. **边的几何断言按"无盒子"语义处理**：`nativeGeometryAssertionValue` 对 `kind==="edge"` 的 `x/y/width/height`，把"属性缺失"视为 `0`（与 `mxGeometry` 的默认值一致），或干脆禁止 edge 断言这四个字段、只允许 `relative / points / offset / sourcePoint / targetPoint`。后者更干净。
2. **上下文与校验器共用同一个几何读取函数**。`extractNativeEditTargets` 的"缺失→0 + 取整"和 `numericXmlAttribute` 的"缺失→null + 不取整"必须收敛成一个，否则任何几何断言都在赌运气。
3. **诊断要指出"该声明什么"**：`unproven-change` 里已经算出 `changedFields: ["geometry.points"]`，直接拼成 `declare {cellId, geometry:{points:[…]}}` 的建议。当前只说"没声明"，模型下一轮仍然不知道写什么。
4. **文案修正**：`changed-unverified` 时禁止输出 "was not applied"。应改为"已写入并保存，但未通过验证"，并把 `auditWarning` 拼进去。

### P1

5. 删除/折叠消息正文里的脚本（见 4.3），并把清洗规则与写入端统一。
6. 诊断显示"前 8 条，共 39 条"（`DrawioFrame.tsx:1088` 加总数后缀）。
7. 声明了未变更的字段 → 降级为 warning（本次 `style:{curved:'1'}` 就属于这种，白白占了 11 条断言的注意力）。
8. 确认策略：用 typed op 覆盖"加控制点/改样式"，或对脚本做指纹免确认（见 3.3）。

### P2

9. 工具描述补一句："edge 的 `geometry` 只有 `points` / `relative` / `offset` / `sourcePoint` / `targetPoint` 有意义；x/y/width/height 对边无意义且会被序列化省略。"

---

## 6. 复现数据

改前：`~/.architecture-diagram-studio/data/standalone-history/8bc868ff…/fec2e5a0-…xml`
改后：`~/.architecture-diagram-studio/data/standalone-history/8bc868ff…/e4da249a-…xml`

11 条边的 `mxGeometry` 属性（改后）：

```
71  {relative:1}                    72  {relative:1}                    70  {relative:1}
69  {relative:1}                    76  {relative:1}                    75  {relative:1}
78  {relative:1}                    68  {relative:1, x:-0.1434, y:-8}
11  {relative:1, width:160}         12  {relative:1, width:160}         13  {relative:1, width:160}
```

11 条边的 style 改前改后 **完全一致**（全部已含 `curved=1`）；每条边新增 1 个 `Array as="points"` 子节点。
