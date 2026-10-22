import { recordDiagnostic } from "../diagnostics";
import { parseNativeEditOperations, type ResolvedNativeEditOperation } from "../model/native-edit-operations";

export interface AIProviderConfig {
  model: string;
  reasoningEffort?: "high" | "max";
  sessionId?: string;
  standalone?: boolean;
  /** Exact XML snapshot the user asked Copilot to edit. Never interpolated as executable instructions. */
  diagramXml: string;
  /** SHA-256 of diagramXml; workspace mode also matches the server-issued revision. */
  documentRevision: string;
}

export interface AIIntentContext {
  kind: "drawio";
  title: string;
  selectedCell?: { cellId: string; pageId: string | null; label: string } | null;
  activePageId?: string | null;
  /** Native Draw.io cells from the active page, not a parallel document model. */
  cells: Array<{ id: string; name: string; cellType?: "vertex" | "edge" }>;
}

export interface AIIntentResponse {
  /** command_ready is not an execution success; it must be followed by the native bridge acknowledgement. */
  outcome?: "command_ready";
  reply: string;
  selection?: { cellId: string; pageId: string | null; label: string };
  nativeEdits?: { operations: ResolvedNativeEditOperation[]; summary: string; pageId: string | null; documentRevision: string; requestId: string };
  model?: string;
  provider?: string;
  durationMs?: number;
  reasoningEffort?: string;
  sessionId?: string;
}

/** Parses only the typed native Draw.io cell-operation contract. */
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
    ...(item.outcome === "command_ready" ? { outcome: "command_ready" as const } : {}),
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
  const rawOperations = raw.operations;
  if (!Array.isArray(rawOperations)) return undefined;
  const parsed = parseNativeEditOperations(rawOperations);
  if (!parsed.ok) throw new Error("The agent returned an invalid native edit batch: " + parsed.error);
  const operations: ResolvedNativeEditOperation[] = parsed.operations.map((operation, index) => {
    const source = rawOperations[index] as Record<string, unknown>;
    const cellId = typeof source.cellId === "string" ? source.cellId.trim() : "";
    const targetLabel = typeof source.targetLabel === "string" ? source.targetLabel.trim() : "";
    if (!cellId || !targetLabel) throw new Error("The agent returned a native edit without a resolved cell id and target label");
    return { ...operation, cellId, targetLabel };
  });
  if (raw.pageId !== null && typeof raw.pageId !== "string") throw new Error("The native edit response is missing its resolved page ID");
  if (typeof raw.documentRevision !== "string" || !raw.documentRevision.trim()) throw new Error("The native edit response is missing its document revision");
  if (typeof raw.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.requestId)) throw new Error("The native edit response is missing its server request ID");
  return {
    operations,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : "",
    pageId: typeof raw.pageId === "string" ? raw.pageId : null,
    documentRevision: raw.documentRevision,
    requestId: raw.requestId
  };
}

/** SHA-256 over the exact UTF-8 XML string; matches the server's workspace revision algorithm. */
export async function calculateDrawioXmlRevision(xml: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(xml));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    nativeCellCount: context.cells.length,
    selectedCellPresent: Boolean(context.selectedCell)
  });
  let response: Response;
  try {
    response = await fetch("/api/copilot/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt, context, diagramXml: config.diagramXml, documentRevision: config.documentRevision,
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
  if (plan.nativeEdits && plan.nativeEdits.documentRevision !== config.documentRevision) {
    throw new Error("The native edit plan belongs to a different diagram revision; nothing was applied.");
  }
  if (plan.nativeEdits && plan.nativeEdits.pageId !== (context.activePageId ?? null)) {
    throw new Error("The native edit plan belongs to a different Draw.io page; nothing was applied.");
  }
  recordDiagnostic("copilot.agent.response.validated", "The native Draw.io response passed client-side validation", {
    durationMs: Date.now() - startedAt,
    agentDurationMs: plan.durationMs,
    model: plan.model || model || "server-default",
    nativeEditCount: plan.nativeEdits?.operations.length ?? 0,
    hasSelection: Boolean(plan.selection)
  });
  return plan;
}
