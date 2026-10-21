import { recordDiagnostic } from "../diagnostics";

export interface AIProviderConfig {
  /** Retained for persisted-settings compatibility; requests go to the same-origin Copilot SDK service. */
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface AIIntentContext {
  kind: "c4" | "flowchart" | "sequence";
  title: string;
  selectedNode?: { id: string; name: string; role: string } | null;
  nodes: Array<{ id: string; name: string; role: string }>;
}

export interface AIIntentPlan {
  commands: string[];
  reply: string;
  model?: string;
  provider?: string;
  durationMs?: number;
}

const ALLOWED_COMMANDS = new Set([
  "所有关系线改成虚线",
  "所有关系线改成实线",
  "把曲线改成直角折线",
  "把曲线改成折线",
  "把所有 external 放到右侧",
  "把数据库和存储放到底部",
  "布局方向从左到右",
  "布局方向从上到下",
  "重新自动排版",
  "解除手动锁定"
]);

export function parseAIIntentPlan(raw: string): AIIntentPlan {
  const cleaned = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("模型返回的不是有效 JSON；未执行任何修改");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("模型计划格式无效");
  const value = parsed as { commands?: unknown; reply?: unknown };
  const rawCommands = Array.isArray(value.commands)
    ? value.commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0).map((command) => command.trim())
    : [];
  if (rawCommands.length > 6) throw new Error("模型计划包含超过 6 条命令；未执行任何修改");
  if (rawCommands.some((command) => !ALLOWED_COMMANDS.has(command))) {
    throw new Error("模型计划包含不在白名单中的操作；未执行任何修改");
  }
  return {
    commands: rawCommands,
    reply: typeof value.reply === "string" ? value.reply.trim().slice(0, 500) : ""
  };
}

function validatePlan(value: unknown): AIIntentPlan {
  if (!value || typeof value !== "object") throw new Error("Copilot SDK 返回的计划格式无效");
  const item = value as Record<string, unknown>;
  const rawCommands = Array.isArray(item.commands)
    ? item.commands.filter((command): command is string => typeof command === "string").map((command) => command.trim())
    : [];
  if (rawCommands.length > 6) throw new Error("Agent 计划超过 6 条命令；未执行任何修改");
  if (rawCommands.some((command) => !ALLOWED_COMMANDS.has(command))) {
    throw new Error("Agent 计划包含不在白名单中的操作；未执行任何修改");
  }
  return {
    commands: rawCommands,
    reply: typeof item.reply === "string" ? item.reply.trim().slice(0, 500) : "",
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {})
  };
}

/** The browser never talks to a model provider directly; the Copilot SDK runs server-side. */
export async function requestAIIntentPlan(
  config: AIProviderConfig,
  prompt: string,
  context: AIIntentContext
): Promise<AIIntentPlan> {
  const startedAt = Date.now();
  const model = config.model.trim();
  recordDiagnostic("copilot.agent.request.started", "向同源 Copilot SDK 服务发送 Agent 请求", {
    model: model || "server-default",
    promptCharacters: prompt.length,
    contextNodeCount: context.nodes.length,
    selectedNodePresent: Boolean(context.selectedNode)
  });
  let response: Response;
  try {
    response = await fetch("/api/copilot/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, context, ...(model ? { model } : {}) }),
      signal: AbortSignal.timeout(70_000)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    recordDiagnostic("copilot.agent.request.failed", "无法连接 Copilot SDK 服务", {
      durationMs: Date.now() - startedAt,
      timedOut,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    throw new Error(timedOut
      ? "Copilot SDK 请求超过 70 秒，已中止；请检查本地 Agent 服务和 Copilot 登录状态。"
      : "无法连接本地 Copilot SDK 服务；请确认通过 npm run dev 启动 V2。");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : "Copilot SDK 服务返回 HTTP " + response.status;
    recordDiagnostic("copilot.agent.response.error", "Copilot SDK Agent 请求失败", {
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
      errorMessage: message.slice(0, 300)
    }, "error");
    throw new Error(message.slice(0, 400));
  }

  const plan = validatePlan(payload);
  recordDiagnostic("copilot.agent.plan.validated", "Agent 计划通过前端命令白名单校验", {
    durationMs: Date.now() - startedAt,
    agentDurationMs: plan.durationMs,
    model: plan.model || model || "server-default",
    commandCount: plan.commands.length,
    toolUsed: "propose_layout_plan"
  });
  return plan;
}
