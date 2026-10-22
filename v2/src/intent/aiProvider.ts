import { recordDiagnostic } from "../diagnostics";
import { isDiagramDocument, type DiagramDocument, type LayoutQualityReport } from "../model/types";
import { parseNativeEditOperations, type ResolvedNativeEditOperation } from "../model/native-edit-operations";

export interface AIProviderConfig {
  /** Retained for persisted-settings compatibility; requests go to the same-origin Copilot SDK service. */
  baseUrl: string;
  model: string;
  reasoningEffort?: "high" | "max";
  sessionId?: string;
  apiKey?: string;
  standalone?: boolean;
}

export interface AIIntentContext {
  kind: string;
  title: string;
  selectedCell?: { cellId: string; pageId: string | null; label: string } | null;
  /** Native Draw.io cells from the active page, not a semantic projection. */
  nodes: Array<{ id: string; name: string; cellType?: "vertex" | "edge" }>;
}

export interface AppliedDiagramEdit {
  applied: true;
  versionId: string;
  baseRevision: string;
  workspaceRevision: string;
  document: DiagramDocument;
  summary: string;
  quality: LayoutQualityReport;
}

export interface AIIntentPlan {
  commands: string[];
  reply: string;
  proposal?: { proposalId: string; baseRevision: string; document: DiagramDocument; summary: string; baseQuality: LayoutQualityReport; quality: LayoutQualityReport };
  application?: AppliedDiagramEdit;
  selection?: { cellId: string; pageId: string | null; label: string };
  /** Typed native edits the browser must execute; the server never writes XML for these. */
  nativeEdits?: { operations: ResolvedNativeEditOperation[]; summary: string; requiresClientExecution: boolean };
  model?: string;
  provider?: string;
  durationMs?: number;
  reasoningEffort?: string;
  sessionId?: string;
}

const ALLOWED_COMMANDS = new Set([
  // English phrasing is what the UI offers; the Chinese forms stay accepted for existing sessions.
  "Make all relations dashed",
  "Make all relations solid",
  "Change curves to orthogonal routing",
  "Change curves to polylines",
  "Put all external systems on the right",
  "Move databases and storage to the bottom",
  "Layout direction left-to-right",
  "Layout direction top-to-bottom",
  "Re-run auto layout",
  "Clear manual locks",
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
    throw new Error("The model did not return valid JSON; nothing was applied");
  }
  // Keep model text parsing aligned with the validated SDK response path, including
  // server-applied operation receipts; a receipt must not be silently dropped.
  return validatePlan(parsed);
}

function validatePlan(value: unknown): AIIntentPlan {
  if (!value || typeof value !== "object") throw new Error("The Copilot SDK returned a plan with an invalid shape");
  const item = value as Record<string, unknown>;
  const rawCommands = Array.isArray(item.commands)
    ? item.commands.filter((command): command is string => typeof command === "string").map((command) => command.trim())
    : [];
  if (rawCommands.length > 6) throw new Error("The agent plan exceeds 6 commands; nothing was applied");
  if (rawCommands.some((command) => !ALLOWED_COMMANDS.has(command))) {
    throw new Error("The agent plan contains a command outside the whitelist; nothing was applied");
  }
  const rawProposal = item.proposal && typeof item.proposal === "object" ? item.proposal as Record<string, unknown> : null;
  const proposal = rawProposal && typeof rawProposal.proposalId === "string" && typeof rawProposal.baseRevision === "string" && isDiagramDocument(rawProposal.document) && typeof rawProposal.summary === "string" && rawProposal.baseQuality && typeof rawProposal.baseQuality === "object" && rawProposal.quality && typeof rawProposal.quality === "object"
    ? { proposalId: rawProposal.proposalId, baseRevision: rawProposal.baseRevision, document: rawProposal.document, summary: rawProposal.summary.slice(0, 500), baseQuality: rawProposal.baseQuality as LayoutQualityReport, quality: rawProposal.quality as LayoutQualityReport }
    : undefined;
  const rawSelection = item.selection && typeof item.selection === "object" ? item.selection as Record<string, unknown> : null;
  const selection = rawSelection && typeof rawSelection.cellId === "string" && typeof rawSelection.label === "string"
    ? { cellId: rawSelection.cellId, pageId: typeof rawSelection.pageId === "string" ? rawSelection.pageId : null, label: rawSelection.label }
    : undefined;
  const nativeEdits = parseNativeEditsPayload(item.nativeEdits);
  const rawApplication = item.application && typeof item.application === "object" ? item.application as Record<string, unknown> : null;
  const application = rawApplication?.applied === true && typeof rawApplication.versionId === "string" &&
    typeof rawApplication.baseRevision === "string" && typeof rawApplication.workspaceRevision === "string" &&
    isDiagramDocument(rawApplication.document) && typeof rawApplication.summary === "string" &&
    rawApplication.quality && typeof rawApplication.quality === "object"
    ? { applied: true as const, versionId: rawApplication.versionId, baseRevision: rawApplication.baseRevision,
        workspaceRevision: rawApplication.workspaceRevision, document: rawApplication.document,
        summary: rawApplication.summary.slice(0, 500), quality: rawApplication.quality as LayoutQualityReport }
    : undefined;
  return {
    commands: rawCommands,
    ...(proposal ? { proposal } : {}),
    ...(application ? { application } : {}),
    ...(selection ? { selection } : {}),
    ...(nativeEdits ? { nativeEdits } : {}),
    reply: typeof item.reply === "string" ? item.reply.trim().slice(0, 500) : "",
    ...(typeof item.model === "string" ? { model: item.model } : {}),
    ...(typeof item.provider === "string" ? { provider: item.provider } : {}),
    ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
    ...(typeof item.reasoningEffort === "string" ? { reasoningEffort: item.reasoningEffort } : {}),
    ...(typeof item.sessionId === "string" ? { sessionId: item.sessionId } : {})
  };
}

/**
 * Native edits arrive already resolved to cell ids. The operations are re-validated here so a
 * malformed or over-broad plan can never reach the bridge, whatever the server returned.
 */
function parseNativeEditsPayload(value: unknown): AIIntentPlan["nativeEdits"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const rawOperations = raw.operations;
  if (!Array.isArray(rawOperations)) return undefined;
  const parsed = parseNativeEditOperations(rawOperations);
  if (!parsed.ok) throw new Error("The agent returned an invalid native edit plan: " + parsed.error);
  const operations: ResolvedNativeEditOperation[] = parsed.operations.map((operation, index) => {
    const source = rawOperations[index] as Record<string, unknown>;
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
): Promise<AIIntentPlan> {
  const startedAt = Date.now();
  const model = config.model.trim();
  recordDiagnostic("copilot.agent.request.started", "Sent an agent request to the same-origin Copilot SDK service", {
    model: model || "server-default",
    promptCharacters: prompt.length,
    contextNodeCount: context.nodes.length,
    selectedCellPresent: Boolean(context.selectedCell)
  });
  let response: Response;
  try {
    response = await fetch("/api/copilot/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, context, ...(model ? { model } : {}), ...(config.sessionId ? { sessionId: config.sessionId } : {}), reasoningEffort: config.reasoningEffort || "max", standalone: config.standalone === true }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    recordDiagnostic("copilot.agent.request.failed", "Could not reach the Copilot SDK service", {
      durationMs: Date.now() - startedAt,
      timedOut,
      errorName: error instanceof Error ? error.name : typeof error
    }, "error");
    throw new Error(timedOut
      ? "The Copilot SDK request exceeded 90 seconds and was aborted. Check the local agent service and the Copilot login state."
      : "Could not reach the local Copilot SDK service. Confirm that V2 was started with npm run dev.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
      ? (payload as { error: string }).error
      : "The Copilot SDK service returned HTTP " + response.status;
    recordDiagnostic("copilot.agent.response.error", "The Copilot SDK agent request failed", {
      durationMs: Date.now() - startedAt,
      httpStatus: response.status,
      errorMessage: message.slice(0, 300)
    }, "error");
    throw new Error(message.slice(0, 400));
  }

  const plan = validatePlan(payload);
  recordDiagnostic("copilot.agent.plan.validated", "The agent plan passed the front-end command whitelist", {
    durationMs: Date.now() - startedAt,
    agentDurationMs: plan.durationMs,
    model: plan.model || model || "server-default",
    commandCount: plan.commands.length,
    toolUsed: "propose_layout_plan"
  });
  return plan;
}
