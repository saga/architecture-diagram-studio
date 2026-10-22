import { recordDiagnostic } from "../diagnostics";
import { parseNativeEditOperations, type ResolvedNativeEditOperation } from "../model/native-edit-operations";

export interface AIProviderConfig {
  /** Requests go to the same-origin Copilot SDK service. */
  baseUrl: string;
  model: string;
  reasoningEffort?: "high" | "max";
  sessionId?: string;
  apiKey?: string;
  standalone?: boolean;
}

export interface AIIntentContext {
  kind: "drawio";
  title: string;
  selectedCell?: { cellId: string; pageId: string | null; label: string } | null;
  activePageId?: string | null;
  /** Native Draw.io cells from the active page, not a parallel document model. */
  nodes: Array<{ id: string; name: string; cellType?: "vertex" | "edge" }>;
}

export interface AIIntentResponse {
  reply: string;
  selection?: { cellId: string; pageId: string | null; label: string };
  nativeEdits?: { operations: ResolvedNativeEditOperation[]; summary: string; requiresClientExecution: boolean };
  model?: string;
  provider?: string;
  durationMs?: number;
  reasoningEffort?: string;
  sessionId?: string;
}

/** Parses only the typed native-editor contract. No semantic document or layout command fallback exists. */
export function parseAIIntentResponse(raw: string): AIIntentResponse {
  const cleaned = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The agent did not return a valid native-edit response; nothing was applied");
  }
  return validateResponse(parsed);
}

function validateResponse(value: unknown): AIIntentResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Copilot SDK returned an invalid native-edit response");
  }
  const item = value as Record<string, unknown>;
  const rawSelection = item.selection && typeof item.selection === "object" ? item.selection as Record<string, unknown> : null;
  const selection = rawSelection && typeof rawSelection.cellId === "string" && rawSelection.cellId.trim() &&
    typeof rawSelection.label === "string"
    ? {
        cellId: rawSelection.cellId.trim(),
        pageId: typeof rawSelection.pageId === "string" ? rawSelection.pageId : null,
        label: rawSelection.label.slice(0, 500)
      }
    : undefined;
  const nativeEdits = parseNativeEditsPayload(item.nativeEdits);
  return {
    reply: typeof item.reply === "string" ? item.reply.trim().slice(0, 500) : "",
    ...(selection ? { selection } : {}),
    ...(nativeEdits ? { nativeEdits } : {}),
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}),
    ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {})
  };
}

/** The server resolves target IDs; this boundary validates the batch again before it reaches Draw.io. */
function parseNativeEditsPayload(value: unknown): AIIntentResponse["nativeEdits"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.operations)) return undefined;
  const parsed = parseNativeEditOperations(raw.operations);
  if (!parsed.ok) throw new Error("The agent returned an invalid native edit batch: " + parsed.error);
  const operations: ResolvedNativeEditOperation[] = parsed.operations.map((operation, index) => {
    const source = raw.operations![index] as Record<string, unknown>;
    const cellId = typeof source.cellId === "string" ? source.cellId.trim() : "";
    const label = typeof source.label === "string" ? source.label.trim() : "";
    if (!cellId || !label) throw new Error("The agent returned a native edit without a resolved cell id");
    return { ...operation, cellId, label };
  });
  return {
    operations,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : "",
    requiresClientExecution: raw.requiresClientExecution === true
  };
}

/** The browser never talks to a model provider directly; the Copilot SDK runs server-side. */
export async function requestAIIntentPlan(
  config: AIProviderConfig,
  prompt: string,
  context: AIIntentContext
): Promise<AIIntentResponse> {
  const startedAt = Date.now();
  const model = config.model.trim();
  recordDiagnostic("copilot.agent.request.started", "Sent a native Draw.io request to the same-origin Copilot SDK service", {
    model: model || "server-default",
    promptCharacters: prompt.length,
    nativeCellCount: context.nodes.length,
    selectedCellPresent: Boolean(context.selectedCell)
  });
  let response: Response;
  try {
    response = await fetch("/api/copilot/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt, context,
        ...(model ? { model } : {}),
        ...(config.sessionId ? { sessionId: config.sessionId } : {}),
        reasoningEffort: config.reasoningEffort || "max",
        standalone: config.standalone === true
      }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    recordDiagnostic("copilot.agent.request.failed", "Could not reach the Copilot SDK service", {
      durationMs: Date.now() - startedAt, timedOut,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    throw new Error(timedOut
      ? "The Copilot SDK request exceeded 90 seconds and was aborted. Check the local agent service and Copilot login state."
      : "Could not reach the local Copilot SDK service. Confirm that V2 was started with npm run dev.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : "The Copilot SDK service returned HTTP " + response.status;
    recordDiagnostic("copilot.agent.response.error", "The Copilot SDK agent request failed", {
      durationMs: Date.now() - startedAt, httpStatus: response.status, errorMessage: message.slice(0, 300)
    }, "error");
    throw new Error(message.slice(0, 400));
  }

  const plan = validateResponse(payload);
  recordDiagnostic("copilot.agent.response.validated", "The native Draw.io response passed client-side validation", {
    durationMs: Date.now() - startedAt,
    agentDurationMs: plan.durationMs,
    model: plan.model || model || "server-default",
    nativeEditCount: plan.nativeEdits?.operations.length ?? 0,
    hasSelection: Boolean(plan.selection)
  });
  return plan;
}
