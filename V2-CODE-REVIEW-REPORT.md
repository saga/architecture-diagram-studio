# V2 代码复审报告

> **历史复审，非当前 HEAD 的验收报告。** 本报告针对旧语义模型/布局实现，结论和测试数字不能代表当前 V2。当前架构是 ADR-0011 的原生 Draw.io XML-only 模型；当前类型检查、单元测试和 E2E 状态以最近 GitHub Actions 为准。

- 复审基线：`f4d1980`（工作区在复审开始时 clean）
- 复审日期：2026-10-22
- 范围：`v2/src` + `v2/server`（约 13,420 行），重点看数据完整性、架构、可观测性、用户体验与安全
- 验证方式：通读核心链路 + 全量测试 + 针对日志/模型能力取证
- 本次唯一代码改动：修复 Agent traces 的时间排序（`v2/src/App.tsx`，见 P1-1）

```
npm run typecheck   -> 通过
npm test            -> 19 files / 163 tests 全部通过
```

---

## 0. 结论

**没有发现会破坏 Draw.io 数据完整性的 P0 问题。** XML 单源、Zod 校验、按 cell 补丁、revision 冲突检查、原子写入这些关键约束都落实到了代码里，方向正确。

“大的问题”集中在四类：

| 级别 | 问题 | 影响 |
|---|---|---|
| P1 | Agent traces 合并后未按时间排序 | 最新日志不在最上方，用户误判当前状态 |
| P1 | 模型 `vision` 能力未暴露，图片输入错误直出 SDK 文案 | 非 vision 模型报 `Cannot read "image.png"`，用户无法理解 |
| P1 | `copilot-server.ts`（1706 行 / 35 路由）和 `App.tsx`（1498 行）过度集中 | 可维护性、并发/中间件一致性风险，难做组件级测试 |
| P2 | 日志无轮转、无脱敏；traces 刷新会全量读 JSONL | 磁盘无限增长；私有代码随 prompt/response 落盘 |
| P2 | `toDrawioXml` 写入当前时间戳 | 同一份文档导出字节不稳定 |
| P2 | 类型逃逸、standalone 历史占 localStorage、测试偏底层 | 长期维护风险 |

---

## 1. 做得好的部分（不是客套，这些是复审确认的）

- **XML 是唯一真源**：`v2/server/drawio-xml-source.ts` 只做 cell 级 patch；保存链路以 `drawioXml` 为准，`Document` 只是投影。刻意不会再整份重建。
- **共享校验**：浏览器导入与服务端持久化都走 `v2/src/model/drawio-xml-schema.ts` 的 Zod schema；`drawio-xml-dom.ts` 是唯一 XML 解析入口，拒绝 DTD/ENTITY。
- **revision 语义清晰**：`storage.ts` 的 revision 只 hash `drawioXml`，不掺入投影；`useWorkspacePersistence.ts` 的保存队列串行发送，并在发送时读取最新 `baseRevision`。
- **写入安全**：`writeTextAtomic`/`writeJsonAtomic` 用临时文件 + rename；版本数量有上限。
- **本地服务面收敛**：API 只监听 `127.0.0.1`，并对 `/api/workspace*`、`/api/copilot*` 做 origin 白名单校验。
- **测试是绿的**：127→163 个用例覆盖 schema、补丁、导入、布局、路由、storage、原生编辑操作。旧报告里的 `parseRootSlice`、边顺序、嵌套坐标、空标签、主题回弹等问题已确认修复。

---

## 2. P1-1　Agent traces 最新日志不在最上方

### 根因

服务端 `/api/workspace/logs` 返回的是**按时间升序**的数组：

```ts
// v2/server/copilot-server.ts:1188-1190
const logs = [...appLogs, ...agentLogs].sort((a, b) =>
  new Date(String(a.clientTimestamp || a.receivedAt || 0)).getTime() -
  new Date(String(b.clientTimestamp || b.receivedAt || 0)).getTime()
).slice(-limit);
```

即最新日志在数组末尾。前端合并了两个来源，但没有做全局时间排序：

```ts
// v2/src/App.tsx:395-397（修复前）
const byId = new Map<string, DiagnosticEntry>();
for (const entry of [...serverEntries, ...readDiagnosticEntries()]) byId.set(entry.id, entry);
setTraceEntries([...byId.values()].slice(-1200));
```

`serverEntries` 是升序，localStorage 也是升序；`byId` 保留首次插入顺序。于是：

- 已在服务端落盘的条目按服务端顺序排列；
- 只存在浏览器本地的条目被追加到末尾。

渲染层再整体 `reverse()`（`v2/src/components/WorkspacePages.tsx:306`），反转的只是这个**非全局有序**的数组。结果就是截图里的现象：`2026-10-21 18:05` 的旧记录排在 `2026-10-22 20:19` 的新记录上面。最新一条不是数组最后一个元素，反转后自然不在顶部。

### 本次修复

在合并后、截断前显式按时间升序排序（`v2/src/App.tsx:397-402`）：

```ts
const chronological = [...byId.values()].sort((left, right) => {
  const leftTime = Date.parse(left.timestamp);
  const rightTime = Date.parse(right.timestamp);
  return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
});
setTraceEntries(chronological.slice(-1200));
```

`reverse()` 保持不变，因此最新条目现在稳定出现在最上方；`.slice(-1200)` 也变成“保留最新的 1200 条”，而不是“保留最后插入的 1200 条”。

### 仍建议

- 给这个合并/排序逻辑补一个纯函数单测（当前 163 个测试里没有组件级 traces 测试），覆盖“server 条目 + 仅本地条目 + 非法时间戳”三种情况。
- 更好的做法是抽成 `mergeTraceEntries(server, local, limit)`，App.tsx 只负责取数。

---

## 3. P1-2　`Cannot read "image.png"` 与模型 vision 能力

### 现象

Agent traces 里的错误条目实际是：

```
event:    copilot.agent.response.error（前端）
message:  The Copilot SDK agent request failed
details:  { errorMessage: 'Cannot read "image.png" (this model does not support image input). Inform the user.' }
```

它来自 `/api/copilot/intent` 的非 2xx 响应，由 `aiProvider.ts:191-197` 原样记录并抛给 UI。**不是 Studio 崩溃，也不是 XML 或保存链路的问题。**

### 原因

最近一轮会话使用的模型是 `deepseek-flash`。SDK 在 `model.turn_ended` 事件里明确给出了能力：

```json
"modelInfo": {
  "id": "deepseek-flash",
  "capabilities": { "supports": { "vision": false } }
}
```

同一轮日志还有 `Model does not support vision, skipping image processing`。也就是说，该轮 turn 里有图片输入（`image.png`），而当前模型不支持 vision，SDK 拒绝处理并返回了这句提示。截图里 20:19 那一轮实际是成功的（`turn.completed`），报错的 18:05 属于更早的一轮。

### 代码缺口

1. `/api/copilot/models` 只返回 `id/name/label/reasoningEfforts`，没有 `capabilities`（`v2/server/copilot-server.ts:1283-1297`），设置页无法提示“该模型不支持图片”。
2. `v2/src`、`v2/server` 中没有任何 `vision` / `image` 处理逻辑——应用既不校验输入，也不把 SDK 的错误翻译成可操作的中文提示。
3. 错误最终以英文 SDK 文案直接出现在 traces 和聊天错误里。

### 建议

- 在模型列表响应中透出 `capabilities.supports.vision`；Settings 页对非 vision 模型标注“纯文本模型”。
- 如果将来支持图片输入，发送前按模型能力拦截并给出明确提示；如果暂不支持，至少把 SDK 文案映射成“当前模型不支持图片输入，请切换到支持 vision 的模型”。
- 这条不是数据安全问题，但属于用户会直接撞上的体验缺陷。

---

## 4. P1-3　两个“上帝文件”

| 文件 | 行数 | 负担 |
|---|---:|---|
| `v2/server/copilot-server.ts` | 1706 | 35 个路由（workspace、diagram、version、settings、logs、copilot、sessions…）+ 启动逻辑 |
| `v2/src/App.tsx` | 1498 | 79 个 hooks/状态，画布、保存、Copilot、主题、面板、快捷键全在一起 |
| `v2/server/copilot/runtime.ts` | 648 | SDK 会话、恢复、超时、工具桥 |
| `v2/src/model/drawio-xml-schema.ts` | 521 | schema + 解码 + 校验入口 |

风险不在“行数”本身，而在：

- 35 个路由共享同一个 `projectWorkspace` 全局变量和中间件顺序，新增路由很容易漏掉 revision/origin/大小校验；
- `App.tsx` 的任何状态变化都可能触发全量重渲染；保存、Copilot、原生编辑器消息处理互相耦合；
- `App.test.ts` 实际测试的是语义 intent/fixtures，并没有 mount `App`，所以 1498 行 UI 逻辑基本没有组件级回归保护。

建议按“行为不变”拆分：

- 服务端：`routes/workspace.ts`、`routes/diagram.ts`、`routes/versions.ts`、`routes/copilot.ts`、`routes/logs.ts`，共享 `deps`（workspace、revision、writeLog）。
- 前端：把 traces 合并/排序、standalone 历史、Copilot 应用回执分别抽成纯函数或 hook；`App.tsx` 只保留装配。
- 先加一个 traces 合并测试和一个最小 App 渲染测试，再拆。

---

## 5. P2-1　`toDrawioXml` 的时间戳让导出不确定

```ts
// v2/src/export/drawio.ts:190
"<mxfile host=\"app.diagrams.net\" modified=\"" + new Date().toISOString() + "\" ...
```

同一份 `DiagramDocument` 连续调用两次会得到不同字节。当前 `canApplySemanticEdits`/`patchDrawioXml` 只比较 `<root>` 内部，所以**语义门禁没有被破坏**；但任何基于整串 XML 的 hash、diff、幂等比较、快照去重都会被这个属性污染。

建议：

- 用文档自身的更新时间（已有字段）或固定值；
- 或在投影/导出两条路径里明确区分“用于 patch 的投影”和“用于下载的完整文件”，不要把带时间戳的投影当稳定值。

---

## 6. P2-2　日志：无轮转、无脱敏、全量读取

- `LOG_FILE`（`copilot-server.ts:54`）和 `APP_LOG_FILE`（`:59`）都是 append-only JSONL，没有轮转、保留期或大小上限；当前已 3,805 / 3,804 行。
- `GET /api/workspace/logs` 每次请求都把整个文件读入内存、逐行 `JSON.parse`，排序后再 `slice(-limit)`（`:1164-1190`）。traces 每次收到 `studio:diagnostic` 都会刷新（`App.tsx:413`），所以“每产生一条前端诊断 → 全量读两份 JSONL”。
- 日志里包含完整 prompt 和模型回复：
  - `request.received` 写入 `prompt`（`v2/server/copilot/intent-route.ts:185`）；
  - `turn.completed` 写入完整 `response`（同文件 `:338`）；
  - `sdk.event` 持久化大量 `model.response` / `messages_snapshot`。
- `/api/copilot/sessions/:id/logs` 原样返回这些记录（`copilot-server.ts:1673`）。
- 前端 localStorage 诊断每次 `recordDiagnostic` 都要 `JSON.parse` 最多 1200 条再整体 `JSON.stringify` 写回（`v2/src/diagnostics.ts:74-76`），是 O(n) 同步写。

这不是“日志能看”的问题，而是**私有仓库内容会被复制到 `~/.architecture-diagram-studio` 且永久保留**。建议：

1. 对 `prompt`/`response`/`details` 做与 `diagnostics.ts` 一致的敏感字段截断或摘要化；
2. 按大小/天数轮转，并给 `GET /logs` 用增量读取（记录 offset）或先过滤再解析；
3. `sdk.event` 的 ephemeral 事件默认不落盘，或单独放到 debug 文件；
4. 把前端 traces 的 localStorage 写入改成批量/节流。

---

## 7. P2-3　类型逃逸集中在边界

```
v2/src/App.tsx:75,80,81,85,93          UI 包装组件 (Button/Input/Select) 的 props as any
v2/src/components/WorkspacePages.tsx:156
v2/server/copilot/intent-route.ts:31   deps/工具参数边界
v2/server/copilot/diagram-tools.ts:54,56,60
```

UI 包装层的 `as any` 属于 antd 版本适配的权宜之计，风险可控；真正值得收紧的是 Copilot 工具参数边界：模型输出是不可信输入，`any` 会掩盖 schema 之外的字段和类型错误。建议在工具入口统一 `unknown` + Zod 解析，UI 包装层再用泛型或 `ComponentProps` 消除。

---

## 8. P2-4　语义投影的边界（设计如此，但要在 UI 说清）

- 只投影第一个 `<diagram>` 页（`v2/src/import/drawio.ts:167-169`）；多页文件的原生编辑不受影响，但语义布局只针对第一页。这与 ADR-0006/LeanIX 的“第一页消费”约束一致，**不是缺陷**。
- layer cell（无 vertex/edge）不进入投影；`plainLabel` 只取第一个 `<div>` 的文本（`import/drawio.ts:23-27`）；`math`/`shadow`/`pageWidth` 等模型属性不投影。
- 因此当 `projectionComplete=false` 时，语义操作必须继续拒绝。最近一轮 Copilot 回复正确识别了这一点并拒绝自动布局，说明门禁在生效。

建议：在画布/属性面板明确显示“当前页可安全语义编辑 / 仅原生编辑”，不要让用户从一次拒绝里自己推断。

---

## 9. P2-5　standalone 历史存整份 XML 于 localStorage

`App.tsx:672-675`（归档）和 `:1040-1067`（读取/恢复）为每个 standalone 文件保留最多 100 份完整 XML 快照。大图（原生 XML 可达 20MB）很容易超过 localStorage 配额；代码在写入失败时会取消 Copilot 编辑（fail-closed，方向正确），但用户会看到一个无法解释的失败。

建议：降到 5–10 份、只存压缩后的 XML，或改用 IndexedDB；错误提示里直接说明“本地历史空间不足，已取消编辑”。

---

## 10. P2-6　测试结构偏底层

- 163 个用例覆盖的是 schema、导入、布局、路由、storage、工具参数，质量不错；
- 但没有覆盖：traces 合并排序、日志脱敏、`/api/workspace/logs` 的分页/顺序、Copilot 错误文案映射、App 组件渲染；
- `App.test.ts` 名字叫 App，实际是语义 intent 测试。

建议优先补三个小而硬的用例：

1. `mergeTraceEntries`：server + local + 乱序 + 非法时间戳 → 最新在最后（渲染前）且截断正确；
2. `logs` 端点：超过 limit 时只返回最新 N 条且升序；
3. `describeCopilotFailure`/`aiProvider`：vision=false 的错误被翻译成可读提示（如果实现该 UX）。

---

## 11. 建议的优先级

| 顺序 | 事项 | 工作量 | 验收 |
|---|---|---|---|
| 1 | traces 排序（已完成）+ 单测 | 小 | 最新日志稳定在顶部 |
| 2 | 模型 vision 能力透出 + 友好错误 | 中 | 非 vision 模型不再直出英文 SDK 文案 |
| 3 | 日志轮转 + 脱敏 + 增量读取 | 中 | 日志有上限；prompt/response 不落明文 |
| 4 | 拆 `copilot-server.ts` / `App.tsx` | 中大 | 行为不变，路由/hook 可单测 |
| 5 | 固定 `toDrawioXml` 时间戳 | 小 | 同文档两次导出字节一致 |
| 6 | 收紧 Copilot 工具边界类型 | 中 | 去掉 `any`，工具参数统一 Zod |
| 7 | standalone 历史降配额/换存储 | 小 | 大图不再因 quota 取消编辑 |

---

## 12. 附：关键证据位置

| 主题 | 位置 |
|---|---|
| XML 单源 / 补丁 | `v2/src/model/drawio-xml-source.ts`、`v2/server/drawio-xml-source.ts` |
| 共享 schema / 解析边界 | `v2/src/model/drawio-xml-schema.ts`、`v2/src/model/drawio-xml-dom.ts` |
| revision / 原子写 | `v2/server/storage.ts`、`v2/src/hooks/useWorkspacePersistence.ts` |
| 日志端点与排序 | `v2/server/copilot-server.ts:1135-1190` |
| traces 合并（已修） | `v2/src/App.tsx:376-402`、`v2/src/components/WorkspacePages.tsx:306` |
| vision 能力 | `~/.architecture-diagram-studio/logs/copilot-sessions.jsonl` 的 `model.turn_ended` |
| 图片错误传播 | `v2/src/intent/aiProvider.ts:191-197` |
| 模型列表 | `v2/server/copilot-server.ts:1283-1297` |
| 非确定性导出 | `v2/src/export/drawio.ts:190` |
| 第一页投影 | `v2/src/import/drawio.ts:167-169` |
| 用户 prompt 落盘 | `v2/server/copilot/intent-route.ts:185`、`:338` |
| localStorage 诊断写入 | `v2/src/diagnostics.ts:74-76` |
| standalone 历史 | `v2/src/App.tsx:672-675`、`:1040-1067` |
