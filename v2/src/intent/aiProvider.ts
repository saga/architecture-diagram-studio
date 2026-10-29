import { recordDiagnostic } from "../diagnostics";
import type { DrawioRuntimeInspection } from "../model/drawio-runtime-contract";
import { isCopilotIntentOutcome, type CopilotIntentResponse } from "./copilot-intent-outcome";

export interface AIProviderConfig {
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "max";
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
  /** Live, read-only API/cell/rendered-edge snapshot tied to the same XML revision and page. */
  runtimeInspection?: DrawioRuntimeInspection;
}

export type AIIntentResponse = CopilotIntentResponse;

/** Parses the server-owned Draw.io XML edit outcome. */
export function parseAIIntentResponse(raw: string): AIIntentResponse {
  const cleaned = raw.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("The agent did not return a valid Copilot intent response; nothing was applied");
  }
  return validateResponse(parsed);
}

function validateResponse(value: unknown): AIIntentResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Copilot SDK returned an invalid intent response");
  }
  const item = value as Record<string, unknown>;
  if (!isCopilotIntentOutcome(item.outcome)) {
    throw new Error("The Copilot SDK response is missing a supported discriminated outcome");
  }
  const reply = typeof item.reply === "string" ? item.reply.trim().slice(0, 2000) : "";
  const metadata = {
    ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {}),
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}),
    ...(Array.isArray(item.toolsUsed) && item.toolsUsed.every((entry) => typeof entry === "string") ? { toolsUsed: item.toolsUsed as string[] } : {}),
    ...(item.usage !== undefined ? { usage: item.usage } : {}),
    ...(Array.isArray(item.modelCallUsages) ? { modelCallUsages: item.modelCallUsages } : {}),
    ...(item.contextUsage !== undefined ? { contextUsage: item.contextUsage } : {})
  };
  const selection = parseSelection(item.selection);

  switch (item.outcome) {
    case "selected":
      if (!selection) throw new Error("The selected outcome requires a resolved cell and page");
      return { outcome: "selected", reply: reply || "Selected “" + selection.label + "”.", selection, ...metadata };
    case "stale_context":
    case "failed": {
      const error = typeof item.error === "string" ? item.error.trim().slice(0, 1000) : reply;
      if (!error) throw new Error("The " + item.outcome + " outcome requires a safe error message");
      if (item.outcome === "stale_context") return {
        outcome: "stale_context", reply: reply || error, error,
        ...(typeof item.documentRevision === "string" || item.documentRevision === null ? { documentRevision: item.documentRevision as string | null } : {}),
        ...metadata
      };
      return { outcome: "failed", reply: reply || error, error, ...(typeof item.requestId === "string" ? { requestId: item.requestId } : {}), ...metadata };
    }
    case "needs_clarification":
      return { outcome: "needs_clarification", reply: reply || "I need more information before changing the diagram.", ...(typeof item.question === "string" ? { question: item.question.slice(0, 1000) } : {}), ...metadata };
    case "unsupported":
      return { outcome: "unsupported", reply: reply || "This operation is not supported by the current native-edit allowlist.", ...(typeof item.reason === "string" ? { reason: item.reason.slice(0, 1000) } : {}), ...metadata };
    case "answered":
      return { outcome: "answered", reply: reply || "No diagram change was requested.", ...metadata };
    case "xml_committed": {
      if (typeof item.requestId !== "string" || !item.requestId.trim() ||
          !item.persistence || typeof item.persistence !== "object" || Array.isArray(item.persistence)) {
        throw new Error("The xml_committed outcome requires a request ID and persistence receipt");
      }
      const persistence = item.persistence as Record<string, unknown>;
      if (typeof persistence.workspaceRevision !== "string" || !persistence.workspaceRevision.trim()) {
        throw new Error("The XML persistence receipt is missing the committed workspace revision");
      }
      return {
        outcome: "xml_committed",
        reply: reply || "The server committed the native Draw.io XML edit.",
        requestId: item.requestId,
        persistence: persistence as { workspaceRevision: string; [key: string]: unknown },
        ...metadata
      };
    }
    case "xml_patch_ready": {
      if (typeof item.requestId !== "string" || !item.requestId.trim() ||
          typeof item.drawioXml !== "string" || !item.drawioXml.trim() ||
          typeof item.documentRevision !== "string" || !item.documentRevision.trim() ||
          typeof item.patchedRevision !== "string" || !item.patchedRevision.trim() ||
          !Array.isArray(item.changedCellIds) || !item.changedCellIds.every((id) => typeof id === "string")) {
        throw new Error("The xml_patch_ready outcome requires validated XML, source/result revisions and changed cell IDs");
      }
      return {
        outcome: "xml_patch_ready", reply: reply || "The server prepared the native XML edit for browser-owned persistence.",
        requestId: item.requestId, drawioXml: item.drawioXml, documentRevision: item.documentRevision,
        patchedRevision: item.patchedRevision, changedCellIds: item.changedCellIds as string[], ...metadata
      };
    }
    }
  }
}

function parseSelection(value: unknown): { cellId: string; pageId: string | null; label: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.cellId !== "string" || !item.cellId.trim() || typeof item.label !== "string" || !item.label.trim()) return null;
  if (item.pageId !== null && item.pageId !== undefined && typeof item.pageId !== "string") return null;
  return { cellId: item.cellId.trim(), pageId: typeof item.pageId === "string" ? item.pageId : null, label: item.label.trim().slice(0, 500) };
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
        prompt, context, documentRevision: config.documentRevision,
        ...(config.standalone === true ? { diagramXml: config.diagramXml } : {}),
        ...(model ? { model } : {}),
        ...(config.sessionId ? { sessionId: config.sessionId } : {}),
        reasoningEffort: config.reasoningEffort || "medium",
        standalone: config.standalone === true
      }),
      signal: AbortSignal.timeout(300_000)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    recordDiagnostic(timedOut ? "copilot.agent.request.timeout" : "copilot.agent.request.unreachable", timedOut ? "The Copilot intent request exceeded its 300-second client deadline" : "The local Copilot HTTP endpoint could not be reached", {
      durationMs: Date.now() - startedAt, timedOut,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    throw new Error(timedOut
      ? "The Copilot SDK request exceeded 300 seconds and was aborted. Check the local agent service and Copilot login state."
      : "Could not reach the local Copilot HTTP endpoint. Confirm that V2 was started with npm run dev.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (payload && typeof payload === "object" && isCopilotIntentOutcome((payload as { outcome?: unknown }).outcome)) {
      const outcome = validateResponse(payload);
      recordDiagnostic("copilot.agent.response.outcome", "The Copilot service returned a non-success intent outcome", {
        durationMs: Date.now() - startedAt, httpStatus: response.status, outcome: outcome.outcome
      }, outcome.outcome === "failed" ? "error" : "warn");
      return outcome;
    }
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
    hasSelection: plan.outcome === "selected"
  });
  return plan;
}
