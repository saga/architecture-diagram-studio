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
  const commands = Array.isArray(value.commands)
    ? value.commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0).slice(0, 6).map((command) => command.trim().slice(0, 240))
    : [];
  const reply = typeof value.reply === "string" ? value.reply.trim().slice(0, 500) : "";
  return { commands, reply };
}

export async function requestAIIntentPlan(
  config: AIProviderConfig,
  prompt: string,
  context: AIIntentContext
): Promise<AIIntentPlan> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
  const model = config.model.trim();
  if (!baseUrl || !model) throw new Error("请先配置模型接口地址和模型名");
  const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : baseUrl + "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey && config.apiKey.trim()) headers.Authorization = "Bearer " + config.apiKey.trim();

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ request: prompt, diagram: context }) }
      ]
    })
  });
  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    if (!response.ok) throw new Error("模型接口返回 HTTP " + response.status + "，且响应不是 JSON");
    throw new Error("模型接口返回了无法解析的响应");
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && (payload as { error?: { message?: unknown } }).error?.message;
    throw new Error("模型接口 HTTP " + response.status + (typeof message === "string" ? "：" + message : ""));
  }
  return parseAIIntentPlan(extractAssistantContent(payload));
}