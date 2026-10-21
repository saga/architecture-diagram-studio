import { recordDiagnostic } from "../diagnostics";

export interface AIProviderConfig {
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
}

const SYSTEM_PROMPT = [
  "You translate natural-language diagram editing requests into a small, safe set of layout commands.",
  "You do not design new geometry and must never output coordinates, code, XML, or arbitrary operations.",
  "Return only a JSON object with keys commands (an array of at most 6 short Chinese command strings) and reply (a short Chinese sentence).",
  "",
  "Supported commands only:",
  "1. Set every relation to dashed: 所有关系线改成虚线",
  "2. Set every relation to solid: 所有关系线改成实线",
  "3. Change curve routing to orthogonal right-angle routing: 把曲线改成直角折线",
  "4. Change curve routing to ordinary polyline routing: 把曲线改成折线",
  "5. Put all external/vendor nodes on the right: 把所有 external 放到右侧",
  "6. Put data/storage nodes at the bottom: 把数据库和存储放到底部",
  "7. Set the main layout left-to-right: 布局方向从左到右",
  "8. Set the main layout top-to-bottom: 布局方向从上到下",
  "9. Recompute layout: 重新自动排版",
  "10. Clear all manual position locks: 解除手动锁定",
  "",
  "You may emit multiple commands when the request clearly asks for multiple supported changes.",
  "Do not invent commands outside this list. For unsupported editing (for example, changing business logic or renaming one node), return an empty commands array and explain the limitation in reply.",
  "Use the diagram context to resolve terms like vendor, external, storage, and direction."
].join("\n");
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

function extractAssistantContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("模型响应不是 JSON 对象");
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error("模型响应中没有 choices");
  const first = choices[0] as { message?: { content?: unknown } };
  const value = first.message?.content;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    }).join("");
  }
  throw new Error("模型没有返回文本内容");
}

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
  const unsupported = rawCommands.filter((command) => !ALLOWED_COMMANDS.has(command));
  if (unsupported.length) throw new Error("模型计划包含不在白名单中的操作；未执行任何修改");
  const commands = rawCommands.map((command) => command.slice(0, 240));
  const reply = typeof value.reply === "string" ? value.reply.trim().slice(0, 500) : "";
  return { commands, reply };
}

export async function requestAIIntentPlan(
  config: AIProviderConfig,
  prompt: string,
  context: AIIntentContext
): Promise<AIIntentPlan> {
  const startedAt = Date.now();
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const model = config.model.trim();
  if (!baseUrl || !model) {
    recordDiagnostic("copilot.http.configuration.invalid", "模型请求未发送：接口地址或模型名为空", {
      baseUrlPresent: Boolean(baseUrl), modelPresent: Boolean(model)
    }, "error");
    throw new Error("请先配置模型接口地址和模型名");
  }

  const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : baseUrl + "/chat/completions";
  let endpointHostname = "unknown";
  let endpointPath = "invalid-url";
  try {
    const parsedEndpoint = new URL(endpoint);
    endpointHostname = parsedEndpoint.hostname || "unknown";
    endpointPath = parsedEndpoint.pathname;
  } catch { /* fetch will report malformed URLs */ }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const hasApiKey = Boolean(config.apiKey && config.apiKey.trim());
  if (hasApiKey) headers.Authorization = "Bearer " + config.apiKey!.trim();

  const requestBody = JSON.stringify({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ request: prompt, diagram: context }) }
    ]
  });
  recordDiagnostic("copilot.http.request.started", "发送 OpenAI-compatible Chat Completions 请求", {
    endpointHostname, endpointPath, model,
    requestBytes: new TextEncoder().encode(requestBody).length,
    promptCharacters: prompt.length, contextNodeCount: context.nodes.length,
    selectedNodePresent: Boolean(context.selectedNode), apiKeyPresent: hasApiKey, timeoutMs: 60000
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    recordDiagnostic("copilot.http.request.failed", timedOut ? "模型请求超时" : "模型请求未收到 HTTP 响应", {
      durationMs: Date.now() - startedAt,
      endpointHostname, model, timedOut,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    if (timedOut) throw new Error("模型接口请求超过 60 秒，已中止；请检查接口地址、模型服务及终端日志。");
    throw error;
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    recordDiagnostic("copilot.http.response.read_failed", "读取模型响应正文失败", {
      durationMs: Date.now() - startedAt, httpStatus: response.status,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    throw new Error("无法读取模型接口响应正文；请检查网络连接和模型服务日志。");
  }
  recordDiagnostic("copilot.http.response.received", response.ok ? "模型接口返回 HTTP 响应" : "模型接口返回非成功 HTTP 状态", {
    durationMs: Date.now() - startedAt, endpointHostname, model,
    httpStatus: response.status, ok: response.ok, responseCharacters: responseText.length,
    contentType: response.headers.get("content-type") || "unknown",
    requestId: (response.headers.get("x-request-id") || response.headers.get("request-id") || "").slice(0, 100) || null
  }, response.ok ? "info" : "error");

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    recordDiagnostic("copilot.http.response.invalid_json", "模型接口响应不是可解析的 JSON", {
      httpStatus: response.status, responseCharacters: responseText.length, durationMs: Date.now() - startedAt
    }, "error");
    if (!response.ok) throw new Error("模型接口返回 HTTP " + response.status + "，且响应不是 JSON");
    throw new Error("模型接口返回了无法解析的响应");
  }
  if (!response.ok) {
    const providerError: { code?: unknown; type?: unknown; message?: unknown } | undefined =
      payload !== null && typeof payload === "object"
        ? (payload as { error?: { code?: unknown; type?: unknown; message?: unknown } }).error
        : undefined;
    const providerErrorCode = typeof providerError?.code === "string" ? providerError.code.slice(0, 100) : null;
    const providerErrorType = typeof providerError?.type === "string" ? providerError.type.slice(0, 100) : null;
    recordDiagnostic("copilot.http.response.error", "模型接口返回错误状态；响应正文未写入轨迹", {
      httpStatus: response.status, durationMs: Date.now() - startedAt,
      providerErrorPresent: Boolean(providerError),
      providerErrorCode, providerErrorType
    }, "error");
    const message = providerError?.message;
    throw new Error("模型接口 HTTP " + response.status + (typeof message === "string" ? "：" + message.slice(0, 300) : ""));
  }

  let assistantContent: string;
  try {
    assistantContent = extractAssistantContent(payload);
  } catch (error) {
    recordDiagnostic("copilot.response.content.invalid", "成功响应中没有可用的 assistant 文本内容", {
      durationMs: Date.now() - startedAt, responseCharacters: responseText.length,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    throw error;
  }

  try {
    const plan = parseAIIntentPlan(assistantContent);
    recordDiagnostic("copilot.plan.validated", "模型输出通过 JSON 解析和命令白名单校验", {
      durationMs: Date.now() - startedAt, commandCount: plan.commands.length,
      replyCharacters: plan.reply.length, model, commandWhitelistEnforced: true
    }, "info");
    return plan;
  } catch (error) {
    recordDiagnostic("copilot.plan.validation.failed", "模型输出未通过计划校验；未执行任何修改", {
      durationMs: Date.now() - startedAt, assistantContentCharacters: assistantContent.length,
      errorMessage: error instanceof Error ? error.message : "plan-validation-error"
    }, "error");
    throw error;
  }
}
