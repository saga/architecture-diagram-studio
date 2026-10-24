import { recordDiagnostic } from "../diagnostics";
import type { DrawioRuntimeInspection } from "../model/drawio-runtime-contract";
import { parseNativeEditOperations, type ResolvedNativeEditOperation } from "../model/native-edit-operations";
import { isCopilotIntentOutcome, type CopilotIntentResponse } from "./copilot-intent-outcome";

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
  /** Live, read-only API/cell/rendered-edge snapshot tied to the same XML revision and page. */
  runtimeInspection?: DrawioRuntimeInspection;
  /** One bounded repair context after an explicitly confirmed script rollback. */
  scriptRepair?: { originalRequest: string; failedScript: string; error: string };
}

export type AIIntentResponse = CopilotIntentResponse;

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
    case "command_ready": {
      const nativeEdits = parseNativeEditsPayload(item.nativeEdits);
      if (!nativeEdits) throw new Error("The command_ready outcome requires a validated native edit command");
      return { outcome: "command_ready", reply, nativeEdits, ...(selection ? { selection } : {}), ...metadata };
    }
    case "selected":
      if (!selection) throw new Error("The selected outcome requires a resolved cell and page");
      return { outcome: "selected", reply: reply || "Selected “" + selection.label + "”.", selection, ...metadata };
    case "proposal_required": {
      const proposal = parseNativeProposal(item.proposal);
      return { outcome: "proposal_required", reply, proposal, ...metadata };
    }
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
    case "applied": {
      if (typeof item.requestId !== "string" || !item.requestId.trim() ||
          typeof item.documentRevision !== "string" || !item.documentRevision.trim() ||
          !(typeof item.versionId === "string" || item.versionId === null) ||
          item.editorAcknowledged !== true ||
          typeof item.persistenceStatus !== "string" || !item.persistenceStatus.trim() ||
          !Array.isArray(item.resolvedTargets) ||
          item.resolvedTargets.some((target) => !target || typeof target !== "object" ||
            typeof (target as { cellId?: unknown }).cellId !== "string" ||
            typeof (target as { label?: unknown }).label !== "string")) {
        throw new Error("The applied outcome requires requestId, documentRevision, versionId, editor acknowledgement, persistence status, and resolved targets");
      }
      const versionId = item.versionId as string | null;
      const persistenceStatus = item.persistenceStatus;
      const persistedRevision = typeof item.persistedRevision === "string" || item.persistedRevision === null
        ? item.persistedRevision as string | null : null;
      if (persistenceStatus === "saved" &&
          (typeof versionId !== "string" || !persistedRevision || persistedRevision !== item.documentRevision)) {
        throw new Error("A saved workspace outcome must include the matching persisted revision and immutable version ID");
      }
      if (persistenceStatus === "not_managed_by_server" && versionId !== null) {
        throw new Error("A standalone applied outcome must not claim a server-managed workspace version");
      }
      return {
        outcome: "applied", reply: reply || "The diagram change was applied.",
        requestId: item.requestId, documentRevision: item.documentRevision,
        ...(typeof item.persistedRevision === "string" || item.persistedRevision === null ? { persistedRevision: item.persistedRevision as string | null } : {}),
        versionId,
        editorAcknowledged: true,
        persistenceStatus,
        resolvedTargets: item.resolvedTargets as Array<{ cellId: string; label: string }>,
        ...metadata
      };
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

function parseResolvedNativeOperations(value: unknown): ResolvedNativeEditOperation[] {
  if (!Array.isArray(value)) throw new Error("The native edit proposal must contain an operation list");
  // Resolved-target metadata is validated separately from the strict operation contract. It is
  // intentionally not part of the model-authored operation schema or the Copilot tool schema.
  const operationInputs = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const { cellId: _cellId, targetLabel: _targetLabel, ...operation } = raw as Record<string, unknown>;
    return operation;
  });
  const parsed = parseNativeEditOperations(operationInputs);
  if (!parsed.ok) throw new Error("The agent returned an invalid native edit batch: " + parsed.error);
  return parsed.operations.map((operation, index) => {
    const source = value[index] as Record<string, unknown>;
    const cellId = typeof source.cellId === "string" ? source.cellId.trim() : "";
    const targetLabel = typeof source.targetLabel === "string" ? source.targetLabel.trim() : "";
    if (!cellId || !targetLabel) throw new Error("The agent returned an operation without a resolved cell id and target label");
    return { ...operation, cellId, targetLabel };
  });
}

/** The server resolves target IDs; this boundary validates the batch again before it reaches Draw.io. */
function parseNativeEditsPayload(value: unknown): Extract<AIIntentResponse, { outcome: "command_ready" }>["nativeEdits"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.pageId !== null && typeof raw.pageId !== "string") throw new Error("The native edit response is missing its resolved page ID");
  if (typeof raw.documentRevision !== "string" || !raw.documentRevision.trim()) throw new Error("The native edit response is missing its document revision");
  if (typeof raw.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.requestId)) throw new Error("The native edit response is missing its server request ID");
  return {
    operations: parseResolvedNativeOperations(raw.operations),
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : "",
    pageId: typeof raw.pageId === "string" ? raw.pageId : null,
    documentRevision: raw.documentRevision,
    requestId: raw.requestId
  };
}

function parseNativeProposal(value: unknown): Extract<AIIntentResponse, { outcome: "proposal_required" }>["proposal"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The proposal_required outcome requires a reviewable proposal");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !/^[0-9a-f-]{36}$/i.test(raw.id)) throw new Error("The proposal is missing its ID");
  if (raw.pageId !== null && typeof raw.pageId !== "string") throw new Error("The proposal is missing its page ID");
  if (typeof raw.documentRevision !== "string" || !raw.documentRevision.trim()) throw new Error("The proposal is missing its base revision");
  return {
    id: raw.id,
    summary: typeof raw.summary === "string" ? raw.summary.slice(0, 1000) : "",
    operations: parseResolvedNativeOperations(raw.operations),
    pageId: typeof raw.pageId === "string" ? raw.pageId : null,
    documentRevision: raw.documentRevision
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
        prompt, context, documentRevision: config.documentRevision,
        ...(config.standalone === true ? { diagramXml: config.diagramXml } : {}),
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
  if (plan.outcome === "command_ready" &&
      (plan.nativeEdits.documentRevision !== config.documentRevision ||
       plan.nativeEdits.pageId !== (context.activePageId ?? null))) {
    throw new Error("The native edit plan belongs to a different diagram revision or page; nothing was applied.");
  }
  if (plan.outcome === "proposal_required" &&
      (plan.proposal.documentRevision !== config.documentRevision ||
       plan.proposal.pageId !== (context.activePageId ?? null))) {
    throw new Error("The review proposal belongs to a different diagram revision or page; nothing was applied.");
  }
  recordDiagnostic("copilot.agent.response.validated", "The native Draw.io response passed client-side validation", {
    durationMs: Date.now() - startedAt,
    agentDurationMs: plan.durationMs,
    model: plan.model || model || "server-default",
    nativeEditCount: plan.outcome === "command_ready" ? plan.nativeEdits.operations.length : 0,
    hasSelection: plan.outcome === "selected" || (plan.outcome === "command_ready" && Boolean(plan.selection))
  });
  return plan;
}

/** Confirms a server-held review proposal against the current XML snapshot; the server revalidates it. */
export async function confirmAIIntentProposal(
  config: AIProviderConfig,
  proposalId: string,
  context: AIIntentContext
): Promise<AIIntentResponse> {
  let response: Response;
  try {
    response = await fetch("/api/copilot/intent/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposalId, sessionId: config.sessionId, standalone: config.standalone === true,
        ...(config.standalone === true ? { diagramXml: config.diagramXml } : {}),
        documentRevision: config.documentRevision, context
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch (error) {
    throw new Error("Could not send the proposal confirmation to the local Copilot service: " + (error instanceof Error ? error.message : String(error)));
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !isCopilotIntentOutcome((payload as { outcome?: unknown }).outcome)) {
    throw new Error("The Copilot service returned an invalid proposal-confirmation response.");
  }
  const result = validateResponse(payload);
  if (!response.ok) return result;
  if (result.outcome !== "command_ready") throw new Error("The server did not return a validated command after confirmation.");
  if (result.nativeEdits.documentRevision !== config.documentRevision || result.nativeEdits.pageId !== (context.activePageId ?? null)) {
    throw new Error("The confirmed command belongs to a different diagram revision or page.");
  }
  return result;
}

