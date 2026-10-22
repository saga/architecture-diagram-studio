# Copilot SDK 上下文窗口（context window）配置能力分析

- 分析对象：`v2/server/copilot/` 与 `@github/copilot-sdk`
- 代码基线：`410cd78`
- 依赖版本：`v2/package.json` 声明 `^1.0.17`，`package-lock.json` 实装 **1.0.24**
- 分析方法：读本地 SDK 类型定义 + 追运行时调用链 + 官方文档核对；未改动产品代码
- 结论文件位置：仓库根目录

---

## 0. 一句话结论

**能配，但没有打开。** SDK 会话配置里有 `contextTier`，取值 `"default"` / `"long_context"` —— 就是模型选择器里 Sonnet 5.5 那两个档位。当前 `openSession()` 一行都没传，所以始终跑默认档。

---

## 1. SDK 暴露了什么

| 位置 | 形态 | 说明 |
|---|---|---|
| `dist/types.d.ts:1773` | `type ContextTier = "default" \| "long_context"` | 只有两个值，没有数值型 token 上限可调 |
| `dist/types.d.ts:2105` | `SessionConfigBase.contextTier?: ContextTier` | 定义在基类上，因此 `SessionConfig`（2724）与 `ResumeSessionConfig`（2761）都继承 |
| `dist/session.d.ts:331` | `setModel(model, { contextTier })` | 会话中途换档，下一次消息生效，历史保留 |
| `dist/client.js:1304` / `1578` | `session.create` / `session.resume` 请求体字段 | 确实透传到 CLI 引擎，不是纯类型摆设 |

```ts
// 创建
const session = await client.createSession({ model: "claude-sonnet-5.5", contextTier: "long_context" });
// 恢复
await client.resumeSession(id, { ...base, contextTier: "long_context" });
// 运行中切换
await session.setModel("claude-sonnet-5.5", { contextTier: "long_context" });
```

两个实现细节：

1. **`ContextTier` 不在 `dist/index.d.ts` 的导出清单里**。写 `import type { ContextTier } from "@github/copilot-sdk"` 会编译失败；直接在配置对象里写字面量即可，或本地定义别名。
2. SDK 没有“设置具体 token 数”的入口。窗口大小由模型 × 档位决定，SDK 只能选档。真正能调的相邻旋钮是 `infiniteSessions.backgroundCompactionThreshold`（默认 0.80）与 `bufferExhaustionThreshold`（默认 0.95），那是压缩时机，不是窗口大小。

---

## 2. 当前代码的接入点

`v2/server/copilot/runtime.ts`：

| 行号 | 现有代码 | 需要做什么 |
|---|---|---|
| 372 | `openSession()` | 从请求或配置里取到档位 |
| 374-379 | `const base: ResumeSessionConfig = { streaming, availableTools, tools, systemMessage }` | 加 `contextTier`，`resumeSession` 与 `createSession` 都会带上 |
| 383 | `revisionKey = hash([configRevisionId, model, effort])` | 把档位折进会话 id，否则换档后仍指向旧的 SDK 历史 |
| 276 | `matches()` 比较 `configRevisionId` / `model` / `requestedEffort` | 加上档位，否则复用条件不含它 |
| 23 / 42 | `RuntimeSession` / `SessionRequest` | 增加 `contextTier` 字段，与 `requestedEffort` 并列 |

**这是整件事唯一的坑**：只加 `base.contextTier` 而不动 383 与 276，表现是“配置改了、提示词也重建了，但回复的上下文还是 200K”。因为 `matches()` 认为会话仍然匹配、直接复用，`resumeSession` 根本不会被调用。

---

## 3. 不走代码的路径（CLI 侧）

| 途径 | 写法 | 限制 |
|---|---|---|
| 仓库设置 | `.github/copilot/settings.json` → `{"contextTier": "long_context"}` | 仅在工作目录被信任时生效；本项目 SDK 未传 `workingDirectory`，这条路径目前不可靠 |
| 启动参数 | `copilot --context long_context` | 只对新的交互式会话生效，覆盖持久化设置 |
| 子代理 | `subagents.agents.<name>.contextTier` | 取值多了 `"inherit"`；只影响子代理 |
| MDM 托管 | 与 `model` 并列下发 | 且“仅当托管模型支持显式 context 选项时”才应用 |
| `~/.copilot/settings.json` 用户设置 | **不存在这个键** | 官方用户设置表里没有，不能全局固定 |

结论：想让 Studio 稳定按档位跑，只能走 SDK 会话配置，配置文件的路径都绕不开工作目录信任问题。

---

## 4. 怎么判断某个模型有没有 1M 档

`listModels()` 返回的 `ModelInfo` 没有专门的布尔字段，两处相关信息容易看错：

| 字段 | 能不能用 |
|---|---|
| `capabilities.limits.max_context_window_tokens` | **不能**。它反映的是默认档，Sonnet 5.5 这里也是默认值，照它判断会把所有模型判成“无长上下文” |
| `billing.tokenPrices.longContext` | **可以**。该对象定义在 `generated/rpc.d.ts:18858`，注释为 “for models with extended context windows”，只有支持扩展上下文的模型才带 |
| `billing.tokenPrices.maxPromptTokens` | 参考值：默认档的 prompt 预算，总窗口 = 它 + `max_output_tokens` |

官方文档的 1M 名单里包含 **Claude Sonnet 5.5 / Sonnet 5 / Opus 5.5 / Opus 5 / Opus 4.8** 等；CLI 的 `/model` 里对支持的模型按 `Tab` 即可在 Context 列切换两档。

---

## 5. 计费与可用面

- 长上下文按**分层计费**（tiered pricing），同样对话消耗更多 AI credits。官方明确建议默认用标准档，只在复杂任务时切 1M。
- 官方口径：1M 窗口**只在 VS Code 与 Copilot CLI 提供**。SDK 复用 CLI 引擎，`contextTier` 会原样透传到 CLI，所以技术上可用；但 GitHub 没有为 SDK 单独承诺这一条，属于“能跑、未背书”。

---

## 6. 本机验证记录

```bash
npx tsx server/copilot-server.ts          # 127.0.0.1:4175
curl -s "http://127.0.0.1:4175/api/copilot/models?refresh=1"
# {"defaultModel":"claude-sonnet-5.5","models":[]}
```

服务日志对应 `models.empty`：`the account or runtime has not returned a model list yet`。即当前环境下 entitlement 没解析出来，模型列表为空，**无法自动判断 Sonnet 5.5 的两个档位**，也无法就地验证 `long_context` 是否被接受。要做 UI 就必须处理这个空列表分支。

---

## 7. 如果要接，按这个顺序改

1. **配置层**：`StudioConfig`（`server/copilot-server.ts:37`）加 `contextTier`，`isValidConfigHistoryRecord`（`:77`）与提交校验（`:367`）放行该字段并兜底成 `"default"`；`DEFAULT_STUDIO_CONFIG`（`:39`）设为 `"default"`。
2. **运行时**：按第 2 节改 `runtime.ts` 五处，缺一不可。
3. **模型列表**：`/api/copilot/models`（`copilot-server.ts:1099`）额外返回 `supportsLongContext: Boolean(model.billing?.tokenPrices?.longContext)`，让前端能禁用选项而不是事后报错。
4. **UI**：`WorkspacePages.tsx:294` 推理强度下面加一项，文案对齐现有风格（“only applies when the selected model supports that tier”）；`App.tsx:143/213-225` 的本地设置与迁移同步加字段。

不建议默认开 `long_context`：新会话一建立就是 1M 计费，用户无感知地多花钱。

---

## 8. 风险清单

| 风险 | 表现 | 规避 |
|---|---|---|
| 缓存键漏了档位 | 切档后回复上下文不变，像“配置不生效” | 383 与 276 一起改 |
| 模型列表为空 | 无法判断支持性，选项全禁用 | 空列表时保留选择但提示“未确认”，失败回退 `default` |
| 恢复旧会话跨档 | 旧 transcript 按新档续跑，token 预估失真 | 档位进 `revisionKey`，等价于换会话 |
| 长上下文不可用 | SDK 或账号不支持，`createSession` 报错 | 捕获后重试一次 `default`，并记录 `session.contextTier.fallback` |
| 成本 | 1M 档 credits 上升 | 默认 `default`，显式切换才生效 |

---

## 9. 参考资料

- `v2/node_modules/@github/copilot-sdk/dist/types.d.ts`（1773 / 2073-2105 / 2724 / 2761 / 3284-3287 / 3320）
- `v2/node_modules/@github/copilot-sdk/dist/session.d.ts:331`
- `v2/node_modules/@github/copilot-sdk/dist/client.js:1304,1578`
- `v2/node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:18810,18858`
- https://docs.github.com/en/copilot/reference/ai-models/supported-models —— 1M 窗口与可配置推理的模型名单
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference —— `--context TIER`，取值 `default` / `long_context`
- https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference —— 仓库设置 `contextTier`、子代理 `contextTier`（含 `inherit`）
