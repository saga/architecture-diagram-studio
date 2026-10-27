import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import { CopilotRuntime, CopilotSessionBusyError, describeCopilotFailure } from "./runtime";
import type { ContextUsage, ModelCallUsage, TurnUsageMetrics } from "./runtime";
import {
  describeNativeEditOperation,
  MAX_NATIVE_EDIT_OPERATIONS, parseNativeEditOperations, type ResolvedNativeEditOperation
} from "../../src/model/native-edit-operations";
import { getCachedNativeDiagramSnapshot } from "./diagram-snapshot-cache";
import { workspaceRevision } from "../storage";
import { resolveNativeEditTargets } from "./native-edit-tool";
import { NATIVE_EDIT_OPERATION_ITEM_SCHEMA } from "./native-edit-tool-schema";
import { normalizeDrawioRuntimeInspection, PINNED_DRAWIO_VERSION } from "../../src/model/drawio-runtime-contract";
import { resolveCopilotTurnTimeoutMs, resolveCopilotTurnIdleTimeoutMs } from "./turn-timeout";
import { NATIVE_DIAGRAM_CORE_INSTRUCTIONS } from "./native-diagram-instructions";
import { readDrawioAgentReference, isDrawioReferenceTopic } from "./drawio-agent-reference";
import { searchDrawioShapeCatalog, C4_DIRECTORY_SCRIPT_TEMPLATE, DRAWIO_SHAPE_CATALOG_VERSION, isC4DirectoryQuery } from "../../src/model/drawio-shape-catalog";

interface AgentPromptConfig {
  revisionId: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
}
interface ProjectWorkspace { id: string; name: string; rootPath: string; primaryDiagram: string | null; }
export interface PendingNativeExecutionAck {
  requestId: string;
  sessionId: string;
  standalone: boolean;
  documentRevision: string;
  operationCount: number;
  summary: string;
  operations: ResolvedNativeEditOperation[];
  createdAt: number;
}

interface PendingNativeProposal {
  id: string;
  sessionId: string;
  standalone: boolean;
  documentRevision: string;
  pageId: string | null;
  operations: ResolvedNativeEditOperation[];
  summary: string;
  createdAt: number;
}

export interface NativeExecutionAckReceipt {
  fingerprint: string;
  status: number;
  body: Record<string, unknown>;
  completedAt: number;
}

/** Injectable store makes retries, expiry and acknowledgement handling testable without a model call. */
export class NativeExecutionAcknowledgements {
  readonly pending = new Map<string, PendingNativeExecutionAck>();
  readonly completed = new Map<string, NativeExecutionAckReceipt>();

  register(entry: PendingNativeExecutionAck): void {
    this.pending.set(entry.requestId, entry);
  }

  getPending(requestId: string): PendingNativeExecutionAck | undefined {
    return this.pending.get(requestId);
  }

  getReceipt(requestId: string): NativeExecutionAckReceipt | undefined {
    return this.completed.get(requestId);
  }

  complete(requestId: string, receipt: NativeExecutionAckReceipt): void {
    this.pending.delete(requestId);
    this.completed.set(requestId, receipt);
  }

  expire(now: number, ttlMs: number): string[] {
    const expired: string[] = [];
    for (const [id, entry] of this.pending) {
      if (now - entry.createdAt >= ttlMs) {
        this.pending.delete(id);
        expired.push(id);
      }
    }
    for (const [id, entry] of this.completed) {
      if (now - entry.completedAt >= ttlMs) this.completed.delete(id);
    }
    return expired;
  }
}

interface IntentDependencies {
  copilot: CopilotRuntime;
  defaultModel: string;
  writeLog(event: string, fields?: Record<string, unknown>): Promise<void>;
  getStudioConfig(): Promise<AgentPromptConfig>;
  getProjectWorkspace(): Promise<ProjectWorkspace | null>;
  getWorkspaceDiagramSnapshot(): Promise<{ drawioXml: string; revision: string; versionId?: string | null } | null>;
  getWorkspaceVersionSnapshot(versionId: string): Promise<{ drawioXml: string; revision: string; versionId: string } | null>;
  collectAgentWorkspaceContext(prompt?: string): Promise<unknown>;
  persistSessionId(sessionId: string): Promise<void>;
  acknowledgements?: NativeExecutionAcknowledgements;
}

type ReportedNoEditOutcome =
  | { outcome: "answered"; reply: string }
  | { outcome: "needs_clarification"; reply: string; question?: string }
  | { outcome: "unsupported"; reply: string; reason?: string };

const pendingAgentSelections = new Map<string, { cellId: string; pageId: string | null; label: string }>();
const pendingNativeEdits = new Map<string, { operations: ResolvedNativeEditOperation[]; summary: string }>();
const pendingReportedOutcomes = new Map<string, ReportedNoEditOutcome>();
const pendingNativeProposals = new Map<string, PendingNativeProposal>();
type TerminalIntentKind = "native_edit" | "selection" | "no_mutation";
const pendingTerminalIntents = new Map<string, TerminalIntentKind>();
const conflictingTerminalIntents = new Set<string>();

function registerTerminalIntent(sessionId: string, kind: TerminalIntentKind): void {
  if (pendingTerminalIntents.has(sessionId)) {
    conflictingTerminalIntents.add(sessionId);
    throw new Error("The model called more than one final intent tool in a turn. No operation will be dispatched.");
  }
  pendingTerminalIntents.set(sessionId, kind);
}

/**
 * The select and native-edit tools must see the elements of the *current* request.
 * The SDK session survives across turns and its tool closures are created once, so the
 * per-request context is read from here instead of being captured at session build time.
 */
const contextBySession = new Map<string, unknown>();

const ACK_TTL_MS = 10 * 60_000;
const EMPTY_QUERY_WARNING_THRESHOLD = 3;
const emptyQueryStreaks = new Map<string, { count: number; query: string; tool: string }>();
const acknowledgementsDefault = new NativeExecutionAcknowledgements();

async function logQueryResult(
  sessionId: string,
  tool: string,
  query: string,
  resultCount: number,
  writeLog: IntentDependencies["writeLog"]
): Promise<{ warning?: string }> {
  const key = sessionId + ":" + tool;
  if (resultCount > 0) {
    emptyQueryStreaks.delete(key);
    return {};
  }
  const previous = emptyQueryStreaks.get(key);
  const count = previous ? previous.count + 1 : 1;
  emptyQueryStreaks.set(key, { count, query, tool });
  if (count < EMPTY_QUERY_WARNING_THRESHOLD) return {};
  const warning = `The ${tool} query has returned no results ${count} consecutive times. Stop repeating near-identical searches; broaden or change the query, inspect the live Draw.io runtime, or explain the limitation.`;
  if (count === EMPTY_QUERY_WARNING_THRESHOLD || count % EMPTY_QUERY_WARNING_THRESHOLD === 0) {
    await writeLog("tool.query.empty-streak-warning", {
      sessionId, tool, consecutiveEmptyResults: count, threshold: EMPTY_QUERY_WARNING_THRESHOLD,
      query: query.slice(0, 120), warning
    });
  }
  return { warning };
}

function acknowledgementFingerprint(body: Record<string, unknown>): string {
  return JSON.stringify({
    requestId: body.requestId, sessionId: body.sessionId, standalone: body.standalone,
    documentRevision: body.documentRevision, outcome: body.outcome, editorAcknowledged: body.editorAcknowledged,
    serializedXmlRevision: body.serializedXmlRevision, persistenceStatus: body.persistenceStatus,
    persistedRevision: body.persistedRevision, versionId: body.versionId, applicationState: body.applicationState,
    failureStage: body.failureStage, error: body.error
  });
}

function requiresExplicitConfirmation(_operations: ResolvedNativeEditOperation[], _forceScriptReview = false): boolean {
  // Local single-user mode: no edit-size, script, or delete-based approval gate.
  // Native XML snapshots and version history are the recovery mechanism.
  return false;
}

function confirmationReviewMessage(operations: ResolvedNativeEditOperation[]): string {
  if (operations.some((operation) => operation.op === "run_drawio_script")) {
    return "Review the native Draw.io script and expected postcondition checks before applying it. Studio only confirms success if the serialized XML and script verification results pass.";
  }
  if (operations.some((operation) => operation.op === "auto_layout")) {
    return "Review this whole-page layout change before applying it. Studio will calculate positions with its configured layout engine, then update only native cell geometry and connector waypoints.";
  }
  if (operations.some((operation) => operation.op === "delete")) {
    return "This change deletes existing diagram elements. Confirm before applying it.";
  }
  return "This batch is broad and requires review before it can be applied.";
}

function classifyNoMutationFailure(message: string): ReportedNoEditOutcome | null {
  const safeMessage = message.trim().slice(0, 1500);
  if (/ambiguous|was not found|not found among|missing required|target.*required|no native draw\.io cells to target/i.test(safeMessage)) {
    return {
      outcome: "needs_clarification",
      reply: "No diagram changes were applied. " + safeMessage,
      question: safeMessage
    };
  }
  if (/unsupported operation|not supported|requires a vertex|not a vertex|unsupported color|outside the supported native-edit/i.test(safeMessage)) {
    return {
      outcome: "unsupported",
      reply: "No diagram changes were applied. " + safeMessage,
      reason: safeMessage
    } as ReportedNoEditOutcome;
  }
  return null;
}

export function registerCopilotIntentRoute(app: Express, deps: IntentDependencies): void {
  const acknowledgements = deps.acknowledgements ?? acknowledgementsDefault;
  app.post("/api/copilot/intent/confirm", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const proposal = pendingNativeProposals.get(proposalId);
    if (!proposal || Date.now() - proposal.createdAt >= ACK_TTL_MS) {
      pendingNativeProposals.delete(proposalId);
      res.status(404).json({ outcome: "stale_context", reply: "This proposal is unknown or expired.", error: "The proposal is unknown or expired." });
      return;
    }
    if (proposal.sessionId !== sessionId || body.standalone !== proposal.standalone) {
      res.status(409).json({ outcome: "stale_context", reply: "This proposal does not belong to the current session.", error: "The proposal session or mode does not match." });
      return;
    }
    let diagramXml = typeof body.diagramXml === "string" ? body.diagramXml : "";
    const documentRevision = typeof body.documentRevision === "string" ? body.documentRevision : "";
    if (!documentRevision || documentRevision !== proposal.documentRevision) {
      pendingNativeProposals.delete(proposalId);
      res.status(409).json({ outcome: "stale_context", reply: "The diagram changed after this proposal was prepared. Ask Copilot to create a fresh proposal.", error: "The proposal's base revision no longer matches the current revision.", documentRevision });
      return;
    }
    if (!proposal.standalone) {
      try {
        const authoritative = await deps.getWorkspaceDiagramSnapshot();
        if (!authoritative || authoritative.revision !== documentRevision) {
          pendingNativeProposals.delete(proposalId);
          res.status(409).json({ outcome: "stale_context", reply: "The workspace changed after this proposal was prepared.", error: "The proposal is stale; reload and create a new proposal.", documentRevision: authoritative?.revision ?? null });
          return;
        }
        diagramXml = authoritative.drawioXml;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(502).json({ outcome: "failed", reply: "The server could not verify the workspace before confirming this proposal.", error: message.slice(0, 1000) });
        return;
      }
    } else if (!diagramXml || Buffer.byteLength(diagramXml, "utf8") > 20_000_000 ||
        workspaceRevision(diagramXml) !== documentRevision) {
      pendingNativeProposals.delete(proposalId);
      res.status(409).json({ outcome: "stale_context", reply: "The diagram changed after this proposal was prepared. Ask Copilot to create a fresh proposal.", error: "The proposal's base revision no longer matches the standalone XML.", documentRevision });
      return;
    }
    if (!diagramXml || Buffer.byteLength(diagramXml, "utf8") > 20_000_000) {
      pendingNativeProposals.delete(proposalId);
      res.status(409).json({ outcome: "stale_context", reply: "The proposal's XML snapshot is missing or oversized.", error: "The proposal XML is unavailable.", documentRevision });
      return;
    }
    const activePageId = typeof (body.context as { activePageId?: unknown } | undefined)?.activePageId === "string"
      ? (body.context as { activePageId: string }).activePageId || null : null;
    const parsedSnapshot = getCachedNativeDiagramSnapshot(diagramXml, documentRevision, activePageId);
    if (!parsedSnapshot.ok) {
      pendingNativeProposals.delete(proposalId);
      res.status(409).json({ outcome: "stale_context", reply: "The proposal XML is no longer a valid Draw.io document.", error: "The proposal XML could not be validated.", documentRevision });
      return;
    }
    const pageInfo = parsedSnapshot.snapshot.pageInfo;
    if (pageInfo.id !== proposal.pageId) {
      pendingNativeProposals.delete(proposalId);
      res.status(409).json({ outcome: "stale_context", reply: "The active Draw.io page changed after this proposal was prepared.", error: "The proposal targets a different page.", documentRevision });
      return;
    }
    if (!proposal.standalone) {
      let authoritative: { drawioXml: string; revision: string } | null;
      try {
        authoritative = await deps.getWorkspaceDiagramSnapshot();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(502).json({ outcome: "failed", reply: "The server could not verify the workspace before confirming this proposal.", error: message.slice(0, 1000) });
        return;
      }
      if (!authoritative || authoritative.revision !== documentRevision || authoritative.drawioXml !== diagramXml) {
        pendingNativeProposals.delete(proposalId);
        res.status(409).json({ outcome: "stale_context", reply: "The workspace changed after this proposal was prepared.", error: "The proposal is stale; reload and create a new proposal.", documentRevision: authoritative?.revision ?? null });
        return;
      }
    }
    const allNativeCells = parsedSnapshot.snapshot.targets;
    const revalidated = resolveNativeEditTargets({ cells: allNativeCells }, proposal.operations);
    if (!revalidated.ok) {
      pendingNativeProposals.delete(proposalId);
      res.status(409).json({ outcome: "stale_context", reply: "The proposal's target could not be revalidated.", error: revalidated.error, documentRevision });
      return;
    }
    pendingNativeProposals.delete(proposalId);
    const requestId = randomUUID();
    acknowledgements.register({
      requestId, sessionId, standalone: proposal.standalone, documentRevision,
      operationCount: revalidated.operations.length, summary: proposal.summary,
      operations: revalidated.operations, createdAt: Date.now()
    });
    await deps.writeLog("turn.native-edit.proposal-confirmed", { proposalId, requestId, sessionId, standalone: proposal.standalone, documentRevision, operationCount: revalidated.operations.length, summary: proposal.summary });
    res.json({
      outcome: "command_ready",
      reply: "The reviewed proposal was confirmed. Applying the validated native edit batch.",
      sessionId,
      nativeEdits: { operations: revalidated.operations, summary: proposal.summary, pageId: pageInfo.id, documentRevision, requestId }
    });
  });

  app.post("/api/copilot/intent/ack", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body as Record<string, unknown> : {};
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const fingerprint = acknowledgementFingerprint(body);
    const expired = acknowledgements.expire(Date.now(), ACK_TTL_MS);
    for (const id of expired) await deps.writeLog("turn.native-edit.ack-expired", { requestId: id });
    const priorReceipt = acknowledgements.getReceipt(requestId);
    if (priorReceipt) {
      if (priorReceipt.fingerprint !== fingerprint) {
        res.status(409).json({ outcome: "stale_context", reply: "This request already has a different final acknowledgement.", error: "The execution acknowledgement was already completed with different data." });
        return;
      }
      res.status(priorReceipt.status).json(priorReceipt.body);
      return;
    }
    const pending = acknowledgements.getPending(requestId);
    if (!pending) {
      res.status(404).json({ outcome: "stale_context", reply: "This edit request is unknown or expired.", error: "The execution acknowledgement is unknown or expired." });
      return;
    }
    if (pending.sessionId !== sessionId || body.standalone !== pending.standalone ||
        body.documentRevision !== pending.documentRevision) {
      await deps.writeLog("turn.native-edit.ack-rejected", { requestId, sessionId, reason: "request_context_mismatch" });
      res.status(409).json({ outcome: "stale_context", reply: "The edit request no longer matches the current session or document.", error: "The acknowledgement does not match the original Copilot request." });
      return;
    }
    const outcome = body.outcome === "applied" ? "applied" : body.outcome === "failed" ? "failed" : null;
    const editorAcknowledged = body.editorAcknowledged === true;
    const serializedXmlRevision = typeof body.serializedXmlRevision === "string" ? body.serializedXmlRevision : null;
    const persistenceStatus = typeof body.persistenceStatus === "string" ? body.persistenceStatus : "not_attempted";
    const persistedRevision = typeof body.persistedRevision === "string" ? body.persistedRevision : null;
    const versionId = typeof body.versionId === "string" ? body.versionId : null;
    const failureStage = body.failureStage === "editor" || body.failureStage === "persistence" ? body.failureStage : null;
    const applicationState = body.applicationState === "applied-and-verified" ||
      body.applicationState === "changed-unverified" || body.applicationState === "not-applied" ||
      body.applicationState === "unknown" ? body.applicationState : null;
    const errorMessage = typeof body.error === "string" ? body.error.slice(0, 1000) : null;
    if (!outcome || (outcome === "applied" && (!editorAcknowledged || !serializedXmlRevision)) ||
        (outcome === "failed" && !errorMessage && !failureStage)) {
      res.status(400).json({ outcome: "failed", reply: "The final edit result was incomplete.", error: "A final outcome must include a valid status, and failures must include a failure stage or error." });
      return;
    }
    if (outcome === "applied" && pending.standalone && persistenceStatus !== "not_managed_by_server") {
      res.status(400).json({ outcome: "failed", reply: "Standalone file persistence is owned by the browser.", error: "Standalone acknowledgements must not claim a server-managed workspace save." });
      return;
    }
    if (outcome === "applied" && !pending.standalone) {
      let savedVersion: { drawioXml: string; revision: string; versionId: string } | null;
      try {
        savedVersion = versionId ? await deps.getWorkspaceVersionSnapshot(versionId) : null;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.writeLog("turn.native-edit.ack-verification-failed", { requestId, sessionId, versionId, errorMessage: message });
        res.status(502).json({ outcome: "failed", reply: "The edit result was received, but the server could not verify its immutable version. Retry the acknowledgement.", error: message.slice(0, 1000), requestId });
        return;
      }
      if (persistenceStatus !== "saved" || !persistedRevision || !versionId ||
          persistedRevision !== serializedXmlRevision || !savedVersion ||
          savedVersion.versionId !== versionId || savedVersion.revision !== serializedXmlRevision) {
        const responseBody = { outcome: "stale_context", reply: "The saved XML revision does not match its immutable version.", error: "The claimed immutable workspace version does not contain the acknowledged XML revision.", documentRevision: savedVersion?.revision ?? null, versionId: savedVersion?.versionId ?? null };
        await deps.writeLog("turn.native-edit.ack-rejected", {
          requestId, sessionId, reason: "workspace_version_revision_mismatch",
          serializedXmlRevision, persistedRevision, claimedVersionId: versionId,
          savedVersionRevision: savedVersion?.revision ?? null, savedVersionId: savedVersion?.versionId ?? null
        });
        acknowledgements.complete(requestId, { fingerprint, status: 409, body: responseBody, completedAt: Date.now() });
        res.status(409).json(responseBody);
        return;
      }
    }
    const resolvedTargets = pending.operations.map((operation) => ({
      cellId: operation.cellId,
      label: operation.targetLabel || "unnamed element"
    }));
    const recordedOperations = pending.operations.map((operation) => ({
      op: operation.op,
      cellId: operation.cellId,
      targetLabel: operation.targetLabel,
      ...(operation.op === "set_label" ? { newLabel: operation.label } : {}),
      ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}),
      ...(operation.op === "run_drawio_script" ? { summary: operation.summary, scriptLength: operation.script.length } : {}),
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        nodeSpacing: operation.nodeSpacing, layerSpacing: operation.layerSpacing, edgeRouting: operation.edgeRouting,
        iterations: operation.iterations, randomSeed: operation.randomSeed, margin: operation.margin } : {})
    }));
    const responseBody = {
      outcome, reply: outcome === "applied" ? pending.summary : (errorMessage || "The native edit failed."),
      requestId, documentRevision: serializedXmlRevision, persistedRevision, versionId,
      resolvedTargets, editorAcknowledged, persistenceStatus, applicationState, failureStage,
      ...(errorMessage ? { error: errorMessage } : {})
    };
    await deps.writeLog("turn.native-edit.final-outcome", {
      requestId, sessionId, standalone: pending.standalone,
      baseDocumentRevision: pending.documentRevision,
      operationCount: pending.operationCount, summary: pending.summary,
      operations: recordedOperations, resolvedTargets,
      outcome, editorAcknowledged, serializedXmlRevision, persistenceStatus, persistedRevision, versionId,
      applicationState, failureStage, error: errorMessage
    });
    acknowledgements.complete(requestId, { fingerprint, status: outcome === "applied" ? 200 : 200, body: responseBody, completedAt: Date.now() });
    res.json(responseBody);
  });
  async function buildSystemMessage(standalone = false): Promise<string> {
    const workspace = standalone ? null : await deps.getProjectWorkspace();
    const workspaceContext = standalone
      ? "Standalone Draw.io mode: only the supplied native diagram may be targeted. No workspace files are available."
      : "Workspace: " + (workspace?.name || "not configured") + "; primary diagram: " + (workspace?.primaryDiagram || "not selected") + ". Use only this active diagram for edits.";
    return [workspaceContext, NATIVE_DIAGRAM_CORE_INSTRUCTIONS].join("\n\n");
  }

  function createReportIntentOutcomeTool(sessionId: string) {
    return defineTool("report_intent_outcome", {
      description: "Report a validated no-mutation result when no native edit or selection should be dispatched. Use answered for information/questions, needs_clarification for ambiguous requests or missing details, and unsupported only when the desired outcome cannot be achieved through the native Draw.io runtime. This tool never changes the diagram.",
      parameters: {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["answered", "needs_clarification", "unsupported"] },
          reply: { type: "string", minLength: 1, maxLength: 2000 },
          question: { type: "string", maxLength: 1000 },
          reason: { type: "string", maxLength: 1000 }
        },
        required: ["outcome", "reply"],
        additionalProperties: false
      },
      handler: async (args: { outcome?: unknown; reply?: unknown; question?: unknown; reason?: unknown }) => {
        if (args.outcome !== "answered" && args.outcome !== "needs_clarification" && args.outcome !== "unsupported") {
          throw new Error("The no-mutation outcome must be answered, needs_clarification, or unsupported");
        }
        if (typeof args.reply !== "string" || !args.reply.trim() || args.reply.length > 2000) {
          throw new Error("A no-mutation outcome requires a user-facing reply of 1–2000 characters");
        }
        const report: ReportedNoEditOutcome = {
          outcome: args.outcome,
          reply: args.reply.trim(),
          ...(typeof args.question === "string" && args.question.trim() ? { question: args.question.trim().slice(0, 1000) } : {}),
          ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim().slice(0, 1000) } : {})
        } as ReportedNoEditOutcome;
        registerTerminalIntent(sessionId, "no_mutation");
        pendingReportedOutcomes.set(sessionId, report);
        await deps.writeLog("tool.report_intent_outcome", { sessionId, outcome: report.outcome, replyLength: report.reply.length });
        return { recorded: true, outcome: report.outcome };
      }
    });
  }

  function createDrawioShapeSearchTool(sessionId: string) {
    return defineTool("search_drawio_shapes", {
      description: "Search the curated local Draw.io shape catalogue for exact vetted styles and dimensions. Includes a C4 directory alias: query `C4 directory` once to return Person (person2), Software System and Container recipes, the relationship edge recipe, and a minimal script skeleton; use those exact styles and dimensions directly in one native script. A C4 creation turn allows this single catalogue query and no get_drawio_reference call. Query an individual type only when you need that specific recipe. Read-only and non-exhaustive: a miss does not prove a shape is unavailable.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: 120, description: "Shape name or concept, in English or Chinese." },
          limit: { type: "integer", minimum: 1, maximum: 8, default: 5 }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args: { query?: unknown; limit?: unknown }) => {
        if (typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 120) {
          throw new Error("Shape search requires a query from 2 to 120 characters.");
        }
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 5;
        const c4Directory = isC4DirectoryQuery(args.query);
        // The C4 alias is a bundle: never truncate the relationship recipe out of it.
        const results = searchDrawioShapeCatalog(args.query, c4Directory ? Math.max(limit, 4) : limit);
        const queryStatus = await logQueryResult(sessionId, "search_drawio_shapes", args.query.trim(), results.length, deps.writeLog);
        return {
          found: results.length > 0,
          catalogueVersion: DRAWIO_SHAPE_CATALOG_VERSION,
          exhaustive: false,
          results,
          ...(c4Directory ? {
            scriptTemplate: C4_DIRECTORY_SCRIPT_TEMPLATE,
            guidance: "These recipes answer the whole C4 creation turn: build the script now. Replace the *_STYLE placeholders with the exact style strings above and keep their width/height; assert only the cells you create (one xmlAssertion each, at most 3 postconditions). Do not call get_drawio_reference or repeat this search in this turn."
          } : {}),
          ...(results.length ? {} : {
            guidance: "No match exists in the curated local catalogue. This is inconclusive: do not invent an ID or style. Probe the live Draw.io UI/runtime for matching native entries (for example, inspect ui.sidebar.searchEntries if available); do not treat the curated catalogue as exhaustive. Use a typed operation for a supported concept or report the limitation if no native definition can be verified.",
            ...(queryStatus.warning ? { warning: queryStatus.warning } : {})
          })
        };
      }
    });
  }

  function createDrawioRuntimeShapeSearchTool(sessionId: string) {
  return defineTool("search_drawio_runtime_shapes", {
    description: "Search the live shape-class registry reported by the active Draw.io iframe, not only the curated server catalogue. Read-only. Results are JavaScript renderer registrations, not proof of sidebar visibility or stencil compatibility; verify a representative native cell before relying on one.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2, maxLength: 120, description: "Shape class, library or concept keyword, e.g. c4, person, uml." },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 15 }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args: { query?: unknown; limit?: unknown }) => {
      if (typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 120) {
        throw new Error("Live Draw.io shape search requires a query from 2 to 120 characters.");
      }
      const current = contextBySession.get(sessionId);
      const context = current && typeof current === "object" ? current as { runtimeInspection?: { liveShapeClasses?: unknown; drawioVersion?: unknown; documentRevision?: unknown } } : {};
      const inspection = context.runtimeInspection;
      const classes = Array.isArray(inspection?.liveShapeClasses) ? inspection.liveShapeClasses.filter((name): name is string => typeof name === "string") : [];
      const query = args.query.trim().toLocaleLowerCase();
      const matches = classes.filter((name) => name.toLocaleLowerCase().includes(query));
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(30, Math.floor(args.limit))) : 15;
      const results = matches.slice(0, limit);
      await deps.writeLog("tool.search_drawio_runtime_shapes.completed", { sessionId, query: args.query.trim(), registryCount: classes.length, matchCount: matches.length, returnedCount: results.length, truncated: matches.length > results.length, drawioVersion: inspection?.drawioVersion ?? null, documentRevision: inspection?.documentRevision ?? null });
      return {
        source: "live-mxCellRenderer.defaultShapes",
        liveSnapshotAvailable: classes.length > 0,
        drawioVersion: inspection?.drawioVersion ?? null,
        matchCount: matches.length,
        truncated: matches.length > results.length,
        results,
        ...(classes.length ? {} : { guidance: "No live shape registry snapshot is available for this turn. Refresh the active editor runtime inspection before concluding that a shape is unavailable." }),
        ...(classes.length && matches.length === 0 ? { guidance: "No registered JavaScript shape class matched this query. This does not exclude built-in mxGraph shapes, stencil libraries, sidebar search entries, or lazily loaded libraries; inspect live sidebar/library APIs and verify a native cell before falling back." } : {})
      };
    }
  });
}

function createDrawioElementSearchTool(sessionId: string) {
    return defineTool("search_drawio_elements", {
      description: "Search every native cell on the active Draw.io page, including cells omitted from the compact prompt context. Read-only. Use before editing when the requested target is not visible or the diagram is large; resolve ambiguous labels by exact ID.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: 120, description: "Exact cell ID, exact label, or distinctive part of a label." },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 5 }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args: { query?: unknown; limit?: unknown }) => {
        if (typeof args.query !== "string" || args.query.trim().length < 2 || args.query.length > 120) {
          throw new Error("Element search requires a query from 2 to 120 characters.");
        }
        const current = contextBySession.get(sessionId);
        const context = current && typeof current === "object"
          ? current as { cells?: unknown }
          : {};
        const cells = Array.isArray(context.cells)
          ? context.cells as Array<{ id?: unknown; name?: unknown; cellType?: unknown }>
          : [];
        const query = args.query.trim();
        const normalized = query.toLocaleLowerCase();
        const exactId = cells.filter((cell) => typeof cell.id === "string" && cell.id === query);
        const exactLabel = cells.filter((cell) =>
          typeof cell.name === "string" && cell.name.trim().toLocaleLowerCase() === normalized
        );
        const matches = exactId.length ? exactId : exactLabel.length ? exactLabel : cells.filter((cell) => {
          const id = typeof cell.id === "string" ? cell.id.toLocaleLowerCase() : "";
          const label = typeof cell.name === "string" ? cell.name.trim().toLocaleLowerCase() : "";
          if (label.includes(normalized) || id.includes(normalized)) return true;
          const tokens = normalized.split(/\s+/u).filter(Boolean);
          return tokens.length > 1 && tokens.every((token) => label.includes(token));
        });
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(10, Math.floor(args.limit)))
          : 5;
        const queryStatus = await logQueryResult(sessionId, "search_drawio_elements", query, matches.length, deps.writeLog);
        const results = matches.slice(0, limit).flatMap((cell) =>
          typeof cell.id === "string" ? [{
            id: cell.id,
            label: typeof cell.name === "string" && cell.name.trim() ? cell.name.trim() : cell.id,
            cellType: typeof cell.cellType === "string" ? cell.cellType : "unknown"
          }] : []
        );
        await deps.writeLog("tool.search_drawio_elements.completed", {
          sessionId, matchCount: matches.length, returnedCount: results.length,
          truncated: matches.length > results.length
        });
        return {
          found: matches.length > 0,
          query,
          matchCount: matches.length,
          truncated: matches.length > results.length,
          results,
          ...(matches.length > results.length ? {
            guidance: "More matches exist than are shown. Narrow the query or use an exact cell ID; do not choose between ambiguous labels arbitrarily."
          } : {}),
          ...(queryStatus.warning ? { warning: queryStatus.warning } : {})
        };
      }
    });
  }

  function createDrawioReferenceTool() {
    return defineTool("get_drawio_reference", {
      description: "Read the local Draw.io Agent API reference on demand. Read-only; does not change the diagram.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["overview", "api_ownership", "shape_discovery", "script_execution", "postconditions", "recipes", "all"],
            description: "Choose the smallest relevant reference section."
          }
        },
        required: ["topic"],
        additionalProperties: false
      },
      handler: async (args: { topic?: unknown }) => {
        const topic = args.topic;
        if (!isDrawioReferenceTopic(topic)) throw new Error("Select a valid Draw.io reference topic.");
        return { topic, reference: await readDrawioAgentReference(topic) };
      }
    });
  }

  function createRunDrawioScriptTool(sessionId: string) {
    return defineTool("run_drawio_script", {
      description: "Execute JavaScript directly against the live local Draw.io editor runtime. This is the primary full-capability path for native graph operations. Use the actual runtime objects and APIs; inspect the runtime or get_drawio_reference when useful, execute without a confirmation step, and let Studio persist the resulting native XML/version. You may create/reconnect edges, alter geometry and routing, choose shapes/styles, group/reparent cells, manage pages/layers, and use other available native editor capabilities without requesting new typed operations. The iframe is on a separate sandboxed origin: do not access the Studio parent DOM, call Studio local APIs, or use network requests for side effects. CSP permits requests to the local Draw.io origin for bundled resources but blocks cross-origin network requests and remote image loads. This is a terminal action for the current model turn: after calling it, do not call another terminal or mutating tool. The actual editor action happens after this model call ends; do not claim success in the tool-call turn. The script executes in the editor frame, not in Node.js. Resolve edit targets inside the script by label (model.getValue(cell)) and trust a cell ID only from selectedCell or diagram.cells. For mutations, use graph.insertVertex/insertEdge and verify postconditions through model/cell properties only; assert only the cells you created or changed — one xmlAssertion each, at most 3 postconditions, no assertions for untouched cells; any existing cell that changes without an assertion fails verification. Never call graph.refresh(), graph.view.validate(), or graph.view.getState() after a mutation or model.endUpdate(); let the editor/bridge own rendering.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 1000, description: "Brief description of the requested change." },
          script: { type: "string", minLength: 1, maxLength: 50000, description: "JavaScript source executed against the live native Draw.io runtime. Available arguments: ui, editor, graph, model, inspectRuntime. For every modifying script, return { ok: true, postconditions: { checkName: true }, xmlAssertions: [...] } after checking the result in the live model. Keep the evidence minimal: one xmlAssertion per cell you created or changed, at most 3 postconditions, and no assertions for untouched cells; Studio compares the before/after XML and fails the edit when an undeclared existing cell changed. Each xmlAssertions item must include cellId and concrete evidence; style must be a non-empty key/value object (never a full style string or {}), and geometry must contain at least one explicit field. Use cell.getTerminal(true/false) or model.getTerminal(edge, true/false); mxCell has no getSource/getTarget. model.getChildCount(parent) counts direct children only; recurse for totals and never guess whole-diagram cell counts. All postcondition values must be true booleans. Use native APIs rather than replacing the saved mxfile XML. For mutation scripts, do not call graph.refresh(), graph.view.validate(), or graph.view.getState() after mutation/endUpdate; check existence, value, style, geometry and terminals through the model/cells and use xmlAssertions for host verification." }
        },
        required: ["summary", "script"],
        additionalProperties: false
      },
      handler: async (args: { summary?: unknown; script?: unknown }) => {
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 1000) {
          throw new Error("run_drawio_script requires a summary from 1 to 1000 characters");
        }
        if (typeof args.script !== "string" || !args.script.trim() || args.script.length > 50000) {
          throw new Error("run_drawio_script requires a non-empty JavaScript program no longer than 50000 characters");
        }
        const parsed = parseNativeEditOperations([{
          op: "run_drawio_script", target: "active_page", summary: args.summary, script: args.script
        }]);
        if (!parsed.ok) throw new Error(parsed.error);
        const resolved = resolveNativeEditTargets(contextBySession.get(sessionId) ?? null, parsed.operations);
        if (!resolved.ok) throw new Error(resolved.error);
        const summary = resolved.operations.map(describeNativeEditOperation).join("; ");
        registerTerminalIntent(sessionId, "native_edit");
        pendingNativeEdits.set(sessionId, { operations: resolved.operations, summary });
        const activeContext = contextBySession.get(sessionId);
        const context = activeContext && typeof activeContext === "object"
          ? activeContext as { documentRevision?: string; activePageId?: string | null; runtimeInspection?: { drawioVersion?: string } }
          : {};
        await deps.writeLog("tool.run_drawio_script.accepted", {
          sessionId, summary, script: args.script, scriptLength: args.script.length,
          documentRevision: context.documentRevision ?? null, pageId: context.activePageId ?? null,
          drawioVersion: context.runtimeInspection?.drawioVersion ?? PINNED_DRAWIO_VERSION
        });
        return {
          accepted: true,
          execution: "after_model_turn",
          summary,
          scriptLength: args.script.length,
          terminal: true,
          instructions: "This is the terminal editing action for this turn. The editor will execute the script after this model call ends. Do not claim success in this turn; Studio will report the acknowledged result, and may ask for one corrected script if execution fails and rollback is confirmed."
        };
      }
    });
  }

  function createProposeNativeEditsTool(sessionId: string) {
    return defineTool("propose_native_edits", {
      description: "Submit a batch of common, typed native Draw.io edits such as rename, styling, move, resize, delete, simple connected-node insertion and Studio-owned automatic layout. This is a convenience fast path, not a limit on Draw.io capability. For notation changes or other graph operations, use run_drawio_script against the live editor and preserve existing cells unless the user explicitly requests their removal. No confirmation is required in local single-user mode. Never fabricate cell IDs; use exact IDs or uniquely resolved labels.",
      parameters: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            maxItems: MAX_NATIVE_EDIT_OPERATIONS,
            items: NATIVE_EDIT_OPERATION_ITEM_SCHEMA,
          }
        },
        required: ["operations"],
        additionalProperties: false
      },
      handler: async (args: { operations?: unknown }) => {
        const parsed = parseNativeEditOperations(args?.operations);
        if (!parsed.ok) {
          await deps.writeLog("tool.propose_native_edits.rejected", { sessionId, error: parsed.error });
          throw new Error(parsed.error);
        }
        const resolved = resolveNativeEditTargets(contextBySession.get(sessionId) ?? null, parsed.operations);
        if (!resolved.ok) {
          await deps.writeLog("tool.propose_native_edits.unresolved", { sessionId, operations: parsed.operations, error: resolved.error });
          throw new Error(resolved.error);
        }
        const summary = resolved.operations.map(describeNativeEditOperation).join("; ");
        registerTerminalIntent(sessionId, "native_edit");
        pendingNativeEdits.set(sessionId, { operations: resolved.operations, summary });
        await deps.writeLog("tool.propose_native_edits.accepted", {
          sessionId, operationCount: resolved.operations.length,
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}), ...(operation.op === "run_drawio_script" ? { summary: operation.summary, scriptLength: operation.script.length } : {}),
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        nodeSpacing: operation.nodeSpacing, layerSpacing: operation.layerSpacing, edgeRouting: operation.edgeRouting,
        iterations: operation.iterations, randomSeed: operation.randomSeed, margin: operation.margin } : {}) }))
        });
        return {
          // This is tool feedback for the model, not the browser protocol response. Do not expose requiresClientExecution here; it is easy to misread as a user-confirmation requirement.
          accepted: true, operationCount: resolved.operations.length,
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}), ...(operation.op === "run_drawio_script" ? { summary: operation.summary, scriptLength: operation.script.length } : {}),
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        nodeSpacing: operation.nodeSpacing, layerSpacing: operation.layerSpacing, edgeRouting: operation.edgeRouting,
        iterations: operation.iterations, randomSeed: operation.randomSeed, margin: operation.margin } : {}) })),
          summary
        };
      }
    });
  }

  app.post("/api/copilot/intent", async (req, res) => {
    let requestCancelled = false;
    let abortActiveTurn: (() => Promise<unknown>) | null = null;
    res.once("close", () => {
      if (res.writableEnded) return;
      requestCancelled = true;
      if (abortActiveTurn) void abortActiveTurn().catch(() => undefined);
    });
    const requestId = randomUUID();
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const requestedContext = req.body?.context;
    let diagramXml = typeof req.body?.diagramXml === "string" ? req.body.diagramXml : "";
    const documentRevision = typeof req.body?.documentRevision === "string" ? req.body.documentRevision : "";
    const sessionId = typeof req.body?.sessionId === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(req.body.sessionId)
      ? req.body.sessionId
      : randomUUID();
    let config: AgentPromptConfig;
    try {
      config = await deps.getStudioConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "configuration_unavailable", errorMessage: message });
      res.status(502).json({ outcome: "failed", reply: "Copilot configuration could not be loaded. No diagram changes were made.", error: message.slice(0, 1000), requestId, sessionId });
      return;
    }
    const requestedModel = typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim().slice(0, 100)
      : (config.model || deps.defaultModel);
    const requestedEffort = ["low", "medium", "high", "max"].includes(String(req.body?.reasoningEffort))
      ? req.body.reasoningEffort as "low" | "medium" | "high" | "max"
      : config.reasoningEffort;
    const standalone = req.body?.standalone === true;
    if (!prompt || prompt.length > 4000) {
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "invalid_prompt", promptLength: prompt.length });
      res.status(400).json({ outcome: "failed", reply: "The Copilot request could not be validated.", error: "prompt must be 1–4000 characters", requestId, sessionId });
      return;
    }
    if (!requestedContext || typeof requestedContext !== "object" || Array.isArray(requestedContext)) {
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "invalid_context" });
      res.status(400).json({ outcome: "failed", reply: "The Copilot request could not be validated.", error: "Invalid native Draw.io request context", requestId, sessionId });
      return;
    }
    if (!documentRevision) {
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "missing_document_revision" });
      res.status(400).json({ outcome: "failed", reply: "The Copilot request could not be validated.", error: "A document revision is required", requestId, sessionId });
      return;
    }
    const requestedPageId = typeof (requestedContext as { activePageId?: unknown }).activePageId === "string"
      ? ((requestedContext as { activePageId: string }).activePageId || null) : null;
    if (standalone) {
      if (!diagramXml || Buffer.byteLength(diagramXml, "utf8") > 20_000_000) {
        await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "missing_or_oversized_xml_snapshot", xmlLength: diagramXml.length, standalone });
        res.status(400).json({ outcome: "failed", reply: "The Copilot request could not be validated.", error: "A standalone Draw.io XML snapshot up to 20 MB and its revision are required", requestId, sessionId });
        return;
      }
    } else {
      // Older clients may still send XML. Validate that redundant snapshot before touching
      // workspace state, so malformed/stale requests fail fast. Current clients send only revision.
      if (diagramXml) {
        if (Buffer.byteLength(diagramXml, "utf8") > 20_000_000) {
          res.status(400).json({ outcome: "failed", reply: "The Copilot request could not be validated.", error: "The optional XML snapshot exceeds 20 MB", requestId, sessionId });
          return;
        }
        const suppliedRevision = workspaceRevision(diagramXml);
        if (suppliedRevision !== documentRevision) {
          await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "revision_hash_mismatch", documentRevision, computedRevision: suppliedRevision });
          res.status(409).json({ outcome: "stale_context", reply: "The diagram changed before Copilot could process the request. Reload and retry.", error: "The supplied document revision does not match its XML snapshot.", documentRevision: suppliedRevision, requestId, sessionId });
          return;
        }
        const suppliedSnapshot = getCachedNativeDiagramSnapshot(diagramXml, suppliedRevision, requestedPageId);
        if (!suppliedSnapshot.ok) {
          await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "invalid_xml_snapshot", xmlLength: diagramXml.length });
          res.status(400).json({ outcome: "failed", reply: "The Copilot request contains invalid Draw.io XML.", error: "The Copilot request contains invalid Draw.io XML", requestId, sessionId });
          return;
        }
        if (requestedPageId && suppliedSnapshot.snapshot.pageInfo.id !== requestedPageId) {
          res.status(409).json({ outcome: "stale_context", reply: "The active Draw.io page is no longer present in this document revision.", error: "The requested page is not present in this XML revision.", documentRevision, requestId, sessionId });
          return;
        }
      }
      // The server's persisted snapshot remains authoritative.
      try {
        const authoritative = await deps.getWorkspaceDiagramSnapshot();
        if (!authoritative || authoritative.revision !== documentRevision) {
          await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "stale_workspace_revision", requestedRevision: documentRevision, currentRevision: authoritative?.revision ?? null });
          res.status(409).json({ outcome: "stale_context", reply: "The workspace diagram is not saved at the revision shown in the editor. Save or reload, then retry.", error: "The workspace diagram changed or has not been saved to this revision.", documentRevision: authoritative?.revision ?? null, requestId, sessionId });
          return;
        }
        diagramXml = authoritative.drawioXml;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "workspace_snapshot_unavailable", errorMessage: message });
        res.status(502).json({ outcome: "failed", reply: "The server could not verify the workspace revision. No edit was dispatched.", error: message.slice(0, 1000), requestId, sessionId });
        return;
      }
    }
    if (!diagramXml || Buffer.byteLength(diagramXml, "utf8") > 20_000_000) {
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "missing_or_oversized_xml_snapshot", xmlLength: diagramXml.length, standalone });
      res.status(400).json({ outcome: "failed", reply: "The Copilot request could not be validated.", error: "The Draw.io XML snapshot must be available and no larger than 20 MB", requestId, sessionId });
      return;
    }
    // Workspace XML came from the authoritative snapshot whose revision was checked above.
    // Its hash must not be recomputed here; standalone XML still requires a client hash check.
    const computedRevision = standalone ? workspaceRevision(diagramXml) : documentRevision;
    if (computedRevision !== documentRevision) {
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "revision_hash_mismatch", documentRevision, computedRevision });
      res.status(409).json({ outcome: "stale_context", reply: "The diagram changed before Copilot could process the request. Reload and retry.", error: "The supplied document revision does not match its XML snapshot.", documentRevision: computedRevision, requestId, sessionId });
      return;
    }
    const parsedSnapshot = getCachedNativeDiagramSnapshot(diagramXml, computedRevision, requestedPageId);
    if (!parsedSnapshot.ok) {
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "invalid_xml_snapshot", xmlLength: diagramXml.length });
      res.status(400).json({ outcome: "failed", reply: "The Copilot request contains invalid Draw.io XML.", error: "The Copilot request contains invalid Draw.io XML", requestId, sessionId });
      return;
    }
    const pageInfo = parsedSnapshot.snapshot.pageInfo;
    await deps.writeLog("diagram.snapshot.cache", {
      requestId, revision: computedRevision, activePageId: pageInfo.id,
      cacheHit: parsedSnapshot.cacheHit, targetCount: parsedSnapshot.snapshot.targets.length
    });
    if (requestedPageId && pageInfo.id !== requestedPageId) {
      res.status(409).json({ outcome: "stale_context", reply: "The active Draw.io page is no longer present in this document revision.", error: "The requested page is not present in this XML revision.", documentRevision, requestId, sessionId });
      return;
    }
    const allNativeCells = parsedSnapshot.snapshot.targets;
    const requestedSelection = (requestedContext as { selectedCell?: unknown }).selectedCell;
    let selectedCell: { cellId: string; pageId: string | null; label: string } | null = null;
    if (requestedSelection && typeof requestedSelection === "object" && !Array.isArray(requestedSelection)) {
      const selection = requestedSelection as { cellId?: unknown; pageId?: unknown };
      if (typeof selection.cellId === "string" && selection.cellId.trim()) {
        if (typeof selection.pageId === "string" && pageInfo.id && selection.pageId !== pageInfo.id) {
          res.status(409).json({ outcome: "stale_context", reply: "The selected element belongs to another page. Select it again and retry.", error: "The selected cell belongs to a different Draw.io page.", documentRevision, requestId, sessionId });
          return;
        }
        const target = allNativeCells.find((cell) => cell.id === selection.cellId);
        if (!target) {
          res.status(409).json({ outcome: "stale_context", reply: "The selected element changed or was removed. Select it again and retry.", error: "The selected cell is not present on the active Draw.io page in this revision.", documentRevision, requestId, sessionId });
          return;
        }
        selectedCell = { cellId: target.id, pageId: pageInfo.id, label: target.name };
      }
    }
    let visibleCells = allNativeCells.slice(0, 200);
    if (selectedCell && !visibleCells.some((cell) => cell.id === selectedCell!.cellId)) {
      visibleCells = [...visibleCells.slice(0, 199), allNativeCells.find((cell) => cell.id === selectedCell!.cellId)!];
    }
    const suppliedRepair = (requestedContext as { scriptRepair?: unknown }).scriptRepair;
    let scriptRepair: {
      originalRequest: string; failedScript: string; error: string; stack?: string;
      toolResult: { toolName: "run_drawio_script" | "propose_native_edits"; success: false; error: string; stack?: string; rollbackConfirmed: boolean; failedPath: string };
    } | undefined;
    if (suppliedRepair !== undefined) {
      if (!suppliedRepair || typeof suppliedRepair !== "object" || Array.isArray(suppliedRepair)) {
        res.status(400).json({ outcome: "failed", reply: "The native edit repair context could not be validated.", error: "scriptRepair must be an object", documentRevision, requestId, sessionId });
        return;
      }
      const repair = suppliedRepair as Record<string, unknown>;
      const toolResult = repair.toolResult && typeof repair.toolResult === "object" && !Array.isArray(repair.toolResult)
        ? repair.toolResult as Record<string, unknown>
        : null;
      if (typeof repair.originalRequest !== "string" || !repair.originalRequest.trim() || repair.originalRequest.length > 1500 ||
          typeof repair.failedScript !== "string" || !repair.failedScript.trim() || repair.failedScript.length > 12_000 ||
          typeof repair.error !== "string" || !repair.error.trim() || repair.error.length > 1200 ||
          (repair.stack !== undefined && (typeof repair.stack !== "string" || repair.stack.length > 8000)) ||
          !toolResult ||
          (toolResult.toolName !== "run_drawio_script" && toolResult.toolName !== "propose_native_edits") || toolResult.success !== false ||
          typeof toolResult.error !== "string" || !toolResult.error.trim() || toolResult.error.length > 1200 ||
          typeof toolResult.rollbackConfirmed !== "boolean" ||
          typeof toolResult.failedPath !== "string" || toolResult.failedPath.length > 80 ||
          (toolResult.stack !== undefined && (typeof toolResult.stack !== "string" || toolResult.stack.length > 8000))) {
        res.status(400).json({ outcome: "failed", reply: "The native edit repair context exceeds its safe limits.", error: "scriptRepair requires a request <=1500 chars, failed action <=12000 chars, error <=1200 chars, and a bounded failed native tool result", documentRevision, requestId, sessionId });
        return;
      }
      scriptRepair = {
        originalRequest: repair.originalRequest,
        failedScript: repair.failedScript,
        error: repair.error,
        ...(typeof repair.stack === "string" ? { stack: repair.stack } : {}),
        toolResult: {
          toolName: toolResult.toolName as "run_drawio_script" | "propose_native_edits",
          success: false,
          error: (toolResult as Record<string, unknown>).error as string,
          ...(typeof toolResult.stack === "string" ? { stack: toolResult.stack.slice(0, 8000) } : {}),
          rollbackConfirmed: toolResult.rollbackConfirmed as boolean,
          failedPath: toolResult.failedPath as string
        }
      };
      await deps.writeLog("request.script-repair.received", {
        requestId, sessionId, failedActionLength: scriptRepair.failedScript.length, failedTool: scriptRepair.toolResult.toolName, errorLength: scriptRepair.error.length,
        originalRequestLength: scriptRepair.originalRequest.length, errorStackLength: scriptRepair.stack?.length ?? 0,
        toolResult: scriptRepair.toolResult,
        revision: computedRevision, activePageId: pageInfo.id
      });
    }
    const suppliedRuntimeInspection = (requestedContext as { runtimeInspection?: unknown }).runtimeInspection;
    const runtimeInspection = normalizeDrawioRuntimeInspection(suppliedRuntimeInspection, {
      documentRevision: computedRevision, pageId: pageInfo.id, drawioVersion: PINNED_DRAWIO_VERSION
    });
    if (suppliedRuntimeInspection !== undefined && !runtimeInspection) {
      await deps.writeLog("request.runtime-inspection.rejected", {
        requestId, sessionId, reason: "snapshot_did_not_match_revision_page_or_pinned_runtime",
        expectedRevision: computedRevision, expectedPageId: pageInfo.id, expectedDrawioVersion: PINNED_DRAWIO_VERSION
      });
    }
    // The model-facing list is {id,label}: a label survives revisions, and an ID is trustworthy only
    // when this list or the selection supplied it. Cell tools keep the private name-based index.
    const promptCells = visibleCells.map((cell) => ({ id: cell.id, label: cell.name, cellType: cell.cellType }));
    const context = {
      kind: "drawio",
      title: typeof (requestedContext as { title?: unknown }).title === "string"
        ? ((requestedContext as { title: string }).title.slice(0, 200))
        : pageInfo.title || "Draw.io diagram",
      activePageId: pageInfo.id,
      selectedCell,
      cells: promptCells,
      ...(runtimeInspection ? { runtimeInspection } : {}),
      ...(scriptRepair ? { scriptRepair } : {})
    };
    if (!standalone) {
      let authoritative: { drawioXml: string; revision: string } | null;
      try {
        authoritative = await deps.getWorkspaceDiagramSnapshot();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "workspace_snapshot_unavailable", errorMessage: message });
        res.status(502).json({ outcome: "failed", reply: "The server could not verify the workspace revision. No edit was dispatched.", error: message.slice(0, 1000), requestId, sessionId });
        return;
      }
      if (!authoritative || authoritative.revision !== documentRevision || authoritative.drawioXml !== diagramXml) {
        await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: "stale_workspace_revision", requestedRevision: documentRevision, currentRevision: authoritative?.revision ?? null });
        res.status(409).json({ outcome: "stale_context", reply: "The workspace diagram is not saved at the revision shown in the editor. Save or reload, then retry.", error: "The workspace diagram changed or has not been saved to this revision.", documentRevision: authoritative?.revision ?? null, requestId, sessionId });
        return;
      }
    }
    let modelChoice: Awaited<ReturnType<CopilotRuntime["resolveModel"]>>;
    try {
      modelChoice = await deps.copilot.resolveModel(requestedModel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.writeLog("turn.failed", { requestId, sessionId, requestedModel, standalone, errorMessage: message, stage: "model_resolution" });
      res.status(502).json({ outcome: "failed", reply: "Copilot could not resolve a model for this request. No edit was dispatched.", error: message.slice(0, 1000), requestId, sessionId });
      return;
    }
    const model = modelChoice.model || requestedModel;

    const startedAt = Date.now();
    const turnTimeoutMs = resolveCopilotTurnTimeoutMs();
    const expiredBefore = Date.now() - ACK_TTL_MS;
    for (const id of acknowledgements.expire(Date.now(), ACK_TTL_MS)) {
      await deps.writeLog("turn.native-edit.ack-expired", { requestId: id });
    }
    for (const [id, proposal] of pendingNativeProposals) {
      if (proposal.createdAt < expiredBefore) {
        pendingNativeProposals.delete(id);
        await deps.writeLog("turn.native-edit.proposal-expired", { proposalId: id, sessionId: proposal.sessionId });
      }
    }
    const cells = context.cells.slice(0, 80).map((cell) => ({ id: cell.id, label: cell.label.slice(0, 120), cellType: cell.cellType }));
    await deps.writeLog("request.received", { requestId, sessionId, model, requestedModel: requestedModel === model ? undefined : requestedModel, modelSource: modelChoice.reason, reasoningEffort: requestedEffort, standalone, prompt, promptLength: prompt.length, contextKind: (context as { kind?: unknown }).kind ?? null, contextTitle: typeof (context as { title?: unknown }).title === "string" ? (context as { title: string }).title : null, cellCount: (context.cells as unknown[]).length, cells });
    try {
      if (!standalone) await deps.persistSessionId(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.writeLog("turn.failed", { requestId, sessionId, standalone, stage: "session_persistence", errorMessage: message });
      res.status(502).json({ outcome: "failed", reply: "The Copilot session could not be saved. No edit was dispatched.", error: message.slice(0, 1000), requestId, sessionId });
      return;
    }
    try {
      await deps.writeLog("request.session.acquire.started", { requestId, sessionId, model, standalone });
      const acquireStartedAt = Date.now();
      const sessionWorkspace = standalone ? null : await deps.getProjectWorkspace();
      const scopeKey = standalone
        ? "standalone"
        : "workspace:" + JSON.stringify([
            sessionWorkspace?.id ?? null,
            sessionWorkspace?.rootPath ?? null,
            sessionWorkspace?.primaryDiagram ?? null
          ]);
      const runtime = await deps.copilot.acquireSession({
        conversationId: sessionId,
        model,
        requestedEffort,
        configRevisionId: config.revisionId,
        scopeKey,
        prepare: async () => {
          const latestConfig = await deps.getStudioConfig();
          return {
            configRevisionId: latestConfig.revisionId,
            systemMessage: await buildSystemMessage(standalone),
            tools: [
              createSelectDiagramElementTool(sessionId),
              createDrawioShapeSearchTool(sessionId),
              createDrawioRuntimeShapeSearchTool(sessionId),
              createDrawioElementSearchTool(sessionId),
              createDrawioReferenceTool(),
              createRunDrawioScriptTool(sessionId),
              createProposeNativeEditsTool(sessionId),
              createReportIntentOutcomeTool(sessionId)
            ],
            workspaceId: sessionWorkspace?.id
          };
        }
      });
      await deps.writeLog("request.session.acquire.completed", { requestId, sessionId, sdkSessionId: runtime.sdkSessionId, model: runtime.model, reasoningEffort: runtime.reasoningEffort || "model-default", durationMs: Date.now() - acquireStartedAt });
      if (requestCancelled) return;
      const plan = await deps.copilot.withTurn(sessionId, async (turn) => {
        abortActiveTurn = () => turn.session.session.abort();
        if (requestCancelled) {
          await turn.session.session.abort().catch(() => undefined);
          throw new Error("Copilot request cancelled by client.");
        }
        // Keep the complete server-derived target index private to tools. The model-facing context is
        // intentionally capped for prompt size, but target uniqueness must be checked against every cell
        // on the active page or duplicate labels beyond that cap could be resolved incorrectly.
        contextBySession.set(sessionId, { ...context, documentRevision, activePageId: pageInfo.id, cells: allNativeCells, runtimeInspection: context.runtimeInspection });
        pendingAgentSelections.delete(sessionId);
        pendingNativeEdits.delete(sessionId);
        pendingReportedOutcomes.delete(sessionId);
        pendingTerminalIntents.delete(sessionId);
        conflictingTerminalIntents.delete(sessionId);
        const usageSamples: TurnUsageMetrics[] = [];
        const modelCallUsages: ModelCallUsage[] = [];
        let contextUsage: ContextUsage | undefined;
        const turnDeadlineAt = Date.now() + turnTimeoutMs;
        await deps.writeLog("turn.started", {
          requestId, sessionId, model: runtime.model, reasoningEffort: runtime.reasoningEffort || "model-default",
          timeoutMs: turnTimeoutMs, idleTimeoutMs: resolveCopilotTurnIdleTimeoutMs(), prompt
        });
        const collectedContext = standalone
          ? { mode: "standalone", workspace: null, snippets: [], diagram: context, cacheHits: 0, cacheMisses: 0, characterBudget: 0 }
          : await deps.collectAgentWorkspaceContext(prompt);
        const contextRecord = { ...((collectedContext || {}) as Record<string, unknown>) };
        const contextCacheHits = typeof contextRecord.cacheHits === "number" ? contextRecord.cacheHits : 0;
        const contextCacheMisses = typeof contextRecord.cacheMisses === "number" ? contextRecord.cacheMisses : 0;
        const contextCharacters = typeof contextRecord.characterBudget === "number" ? contextRecord.characterBudget : null;
        // These fields are diagnostics, not business context. Leaving them out keeps the prompt prefix
        // stable when the same workspace files are served from cache on a later turn.
        delete contextRecord.cacheHits;
        delete contextRecord.cacheMisses;
        delete contextRecord.characterBudget;
        const projectContext = contextRecord;
        await deps.writeLog("turn.workspace-context.loaded", {
          sessionId,
          workspaceId: (projectContext as { workspace?: { id?: string } }).workspace?.id || null,
          snippetCount: (projectContext as { snippets?: unknown[] }).snippets?.length || 0,
          contextCacheHits,
          contextCacheMisses,
          contextCharacters
        });
        let modelText = "";
        const sendAttempt = async (attempt: number, requestPrompt: string, reason?: string): Promise<void> => {
          if (requestCancelled) throw new Error("Copilot request cancelled by client.");
          const callStartedAt = Date.now();
          const timeoutMs = Math.max(0, turnDeadlineAt - callStartedAt);
          if (timeoutMs === 0) {
            throw new Error("Copilot turn deadline expired before the model call could start.");
          }
          await deps.writeLog("turn.model-call.started", {
            requestId, sessionId, attempt, timeoutMs, turnTimeoutMs,
            idleTimeoutMs: resolveCopilotTurnIdleTimeoutMs(), model: turn.session.model,
            promptLength: prompt.length, requestPromptLength: requestPrompt.length,
            requestPrompt, standalone, toolCount: turn.session.prepared.tools.length,
            ...(reason ? { reason } : {})
          });
          const result = await turn.send({ prompt: requestPrompt }, timeoutMs, { requestId, attempt }, () => requestCancelled);
          if (result.usage) usageSamples.push(result.usage);
          modelCallUsages.push(...result.modelCallUsages);
          contextUsage = result.contextUsage ?? contextUsage;
          modelText = assistantText(result.message) || modelText;
          await deps.writeLog("turn.model-call.completed", {
            requestId, sessionId, attempt, durationMs: Date.now() - callStartedAt,
            responseType: result.message?.type ?? null, responseAvailable: Boolean(result.message),
            responseText: assistantText(result.message), usage: result.usage ?? null,
            modelCallUsages: result.modelCallUsages, contextUsage: result.contextUsage ?? null
          });
        };

        // Keep stable context before the changing user request for providers supporting prefix caching.
        const firstRequestPrompt = JSON.stringify({
          projectWorkspace: projectContext,
          diagram: context,
          request: prompt,
          editingGuidance: "Prefer compact typed native operations over generated scripts when they express the requested change. For C4 diagrams, apply explicit labels with set_label and colors with set_style; each style operation changes one key (fillColor, strokeColor, or fontColor), so batch a few operations instead of writing a large script. For C4 creation, call search_drawio_shapes with `C4 directory` exactly once: it returns Person (person2), Software System, Container, the relationship edge recipe and a script skeleton. That single query is the whole discovery step — do not call get_drawio_reference and do not search again; create the requested cells and edges in one run_drawio_script call. In scripts, use graph.insertVertex/insertEdge and model-layer postcondition checks only; never call graph.refresh(), graph.view.validate(), or graph.view.getState() after a mutation or model.endUpdate(). Keep the returned evidence minimal: one xmlAssertion per cell you created or changed, at most 3 postconditions, and never assert untouched cells; Studio compares the before/after XML itself. Suggested C4 palette when the user asks for standard C4 styling: Person fill #08427B, External System fill #999999, System fill #1168BD; preserve user-edited colors and do not recolor unrelated cells. Resolve edit targets inside the script by label (model.getValue(cell) compared with the requested text, throwing when none or several match) and trust a cell ID only when selectedCell or diagram.cells gives it; never infer that a cell is a C4 type unless the request or diagram context establishes it. Use run_drawio_script only when typed operations cannot express the change."
        });
        await sendAttempt(1, firstRequestPrompt);
        let capturedSelection = pendingAgentSelections.get(sessionId) || null;
        let capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
        let capturedReportedOutcome = pendingReportedOutcomes.get(sessionId) || null;
        if (!capturedSelection && !capturedNativeEdits && !capturedReportedOutcome) {
          await deps.writeLog("turn.native-tool-not-called", { sessionId, attempt: 1, modelText: modelText.slice(0, 2000) });
          const retryPrompt = JSON.stringify({
            request: "Finish with exactly one terminal tool call. Use propose_native_edits as a convenience fast path for simple common edits and Studio-owned auto_layout. Use run_drawio_script as the primary full-capability path for non-trivial native edits or whenever direct Draw.io APIs are simpler; do not limit it to a typed-operation allowlist. No second confirmation is required in local single-user mode. Use select_diagram_element only for pure focus. For informational questions use report_intent_outcome(answered), and ask for clarification only when the user's intent is genuinely ambiguous. Do not author/replace the saved mxfile XML directly or claim success until editor serialization and the required persistence acknowledgement are complete.",
            diagram: context
          });
          await sendAttempt(2, retryPrompt, "the first response did not invoke a native editor tool");
          capturedSelection = pendingAgentSelections.get(sessionId) || null;
          capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
          capturedReportedOutcome = pendingReportedOutcomes.get(sessionId) || null;
        }
        pendingAgentSelections.delete(sessionId);
        pendingNativeEdits.delete(sessionId);
        pendingReportedOutcomes.delete(sessionId);
        const terminalConflict = conflictingTerminalIntents.has(sessionId);
        pendingTerminalIntents.delete(sessionId);
        conflictingTerminalIntents.delete(sessionId);
        return {
          capturedSelection, capturedNativeEdits, capturedReportedOutcome, terminalConflict, modelText,
          session: turn.session,
          usage: mergeTurnUsage(usageSamples), modelCallUsages, contextUsage
        };
      });

      contextBySession.delete(sessionId);
      if (plan.terminalConflict) {
        pendingNativeEdits.delete(sessionId);
        pendingAgentSelections.delete(sessionId);
        pendingReportedOutcomes.delete(sessionId);
        await deps.writeLog("turn.failed", {
          requestId, sessionId, reason: "conflicting_terminal_tools", durationMs: Date.now() - startedAt
        });
        res.status(200).json({
          outcome: "failed",
          reply: "Copilot returned conflicting final actions. No diagram changes were dispatched; submit the request again.",
          error: "More than one terminal intent tool was called in the same model turn.",
          requestId, sessionId
        });
        return;
      }
      if (!standalone) {
        const authoritative = await deps.getWorkspaceDiagramSnapshot();
        if (!authoritative || authoritative.revision !== documentRevision || authoritative.drawioXml !== diagramXml) {
          pendingNativeEdits.delete(sessionId);
          pendingAgentSelections.delete(sessionId);
          await deps.writeLog("turn.native-edit.stale", { sessionId, requestId, requestedRevision: documentRevision, currentRevision: authoritative?.revision ?? null });
          res.status(409).json({ outcome: "stale_context", reply: "The workspace changed while Copilot was interpreting the request. No edit was applied; retry against the latest diagram.", error: "The workspace diagram changed while Copilot was interpreting the request.", documentRevision: authoritative?.revision ?? null, requestId, sessionId });
          return;
        }
      }
      const modelReply = plan.modelText.trim().slice(0, 500);
      const selection = plan.capturedSelection || undefined;
      const toolsUsed = plan.capturedNativeEdits
        ? (plan.capturedNativeEdits.operations.some((operation) => operation.op === "run_drawio_script")
            ? ["run_drawio_script"] : ["propose_native_edits"])
        : plan.capturedSelection ? ["select_diagram_element"] : [];
      const shared = {
        sessionId, model: plan.session.observedModel || plan.session.model,
        reasoningEffort: plan.session.reasoningEffort || "model-default",
        provider: "github-copilot-sdk", durationMs: Date.now() - startedAt, toolsUsed,
        ...(plan.usage ? { usage: plan.usage } : {}),
        ...(plan.modelCallUsages.length ? { modelCallUsages: plan.modelCallUsages } : {}),
        ...(plan.contextUsage ? { contextUsage: plan.contextUsage } : {})
      };
      if (plan.capturedNativeEdits) {
        const nativeEdits = plan.capturedNativeEdits;
        if (requiresExplicitConfirmation(nativeEdits.operations, Boolean(context.scriptRepair))) {
          const proposalId = randomUUID();
          pendingNativeProposals.set(proposalId, {
            id: proposalId, sessionId, standalone, documentRevision, pageId: context.activePageId,
            operations: nativeEdits.operations, summary: nativeEdits.summary, createdAt: Date.now()
          });
          const proposal = {
            id: proposalId, summary: nativeEdits.summary, operations: nativeEdits.operations,
            pageId: context.activePageId, documentRevision
          };
          const response = {
            outcome: "proposal_required" as const,
            reply: confirmationReviewMessage(nativeEdits.operations),
            proposal,
            ...shared
          };
          await deps.writeLog("turn.completed.proposal-required", {
            requestId, proposalId, sessionId, operationCount: nativeEdits.operations.length,
            deleteCount: nativeEdits.operations.filter((operation) => operation.op === "delete").length,
            summary: nativeEdits.summary, documentRevision
          });
          res.json(response);
          return;
        }
        acknowledgements.register({
          requestId, sessionId, standalone, documentRevision,
          operationCount: nativeEdits.operations.length, summary: nativeEdits.summary,
          operations: nativeEdits.operations, createdAt: Date.now()
        });
        const response = {
          // This is a command-ready response, not a final success outcome. The browser must post the native execution/persistence acknowledgement.
          outcome: "command_ready" as const,
          commands: [],
          reply: nativeEdits.operations.some((operation) => operation.op === "run_drawio_script")
            ? "执行原生 Draw.io 脚本：" + nativeEdits.summary + "。等待编辑器序列化和保存确认。"
            : nativeEdits.summary,
          selection,
          nativeEdits: { operations: nativeEdits.operations, summary: nativeEdits.summary, pageId: context.activePageId, documentRevision, requestId },
          ...shared
        };
        await deps.writeLog("turn.completed.with-native-edits", {
          requestId, sessionId, durationMs: Date.now() - startedAt,
          operationCount: nativeEdits.operations.length, summary: nativeEdits.summary,
          selection: selection ?? null, operations: nativeEdits.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}) })), usage: plan.usage
        });
        res.json(response);
        return;
      }
      if (selection) {
        const response = { outcome: "selected" as const, commands: [], reply: modelReply || "Selected diagram element: " + selection.label, selection, ...shared };
        await deps.writeLog("turn.completed.with-selection", { sessionId, selection, response, usage: plan.usage });
        res.json(response);
        return;
      }
      if (plan.capturedReportedOutcome) {
        const reported = plan.capturedReportedOutcome;
        await deps.writeLog("turn.completed.without-native-edit", {
          requestId, sessionId, outcome: reported.outcome, reply: reported.reply, usage: plan.usage
        });
        res.json({ ...reported, ...shared });
        return;
      }
      await deps.writeLog("turn.completed.without-native-edit", {
        requestId, sessionId, outcome: "failed", model: plan.session.model, modelText: modelReply, usage: plan.usage,
        reason: "structured_outcome_missing"
      });
      res.status(502).json({
        outcome: "failed",
        reply: "The Copilot service did not return a validated intent outcome. No diagram changes were dispatched.",
        error: "The agent failed to call a native edit, selection, or report_intent_outcome tool.",
        requestId, ...shared
      });
    } catch (error) {
      abortActiveTurn = null;
      contextBySession.delete(sessionId);
      pendingNativeEdits.delete(sessionId);
      pendingAgentSelections.delete(sessionId);
      pendingReportedOutcomes.delete(sessionId);
      pendingTerminalIntents.delete(sessionId);
      conflictingTerminalIntents.delete(sessionId);
      const message = error instanceof Error ? error.message : String(error);
      if (requestCancelled || res.destroyed) {
        await deps.writeLog("turn.cancelled", { requestId, sessionId, stage: "client-disconnected", errorMessage: message.slice(0, 300) });
        return;
      }
      if (error instanceof CopilotSessionBusyError) {
        await deps.writeLog("turn.rejected.busy", { requestId, sessionId, reason: message });
        res.status(429).json({
          outcome: "busy",
          reply: "This Copilot session is already processing another request. Wait for it to finish before sending another instruction.",
          error: message, requestId, sessionId
        });
        return;
      }
      const actualModel = deps.copilot.lastObservedModel(sessionId);
      const noMutationOutcome = classifyNoMutationFailure(message);
      if (noMutationOutcome) {
        await deps.writeLog("turn.completed.without-native-edit", {
          requestId, sessionId, outcome: noMutationOutcome.outcome, reply: noMutationOutcome.reply,
          model, actualModel: actualModel ?? null, durationMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : typeof error, errorMessage: message
        });
        res.status(200).json({ ...noMutationOutcome, requestId, sessionId, model: actualModel || model, provider: "github-copilot-sdk" });
        return;
      }
      await deps.writeLog("turn.failed", {
        requestId, sessionId, model, requestedModel: requestedModel === model ? undefined : requestedModel, actualModel: actualModel ?? null,
        provider: deps.copilot.providerInfo.mode, providerHost: deps.copilot.providerInfo.host ?? null,
        standalone, durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: message, errorStack: error instanceof Error ? error.stack : null
      });
      res.status(502).json({ outcome: "failed", reply: "Copilot could not complete this request. No edit was confirmed.", error: describeCopilotFailure(message, { requestedModel: model, actualModel }), requestId, sessionId });
    }
  });
}

function createSelectDiagramElementTool(sessionId: string) {
  return defineTool("select_diagram_element", {
    description: "Select and focus one existing element in the native Draw.io canvas. This is a UI selection action, not a diagram edit, so it does not create a version or require a commit. Use exact IDs or a unique exact label from the supplied diagram context; do not guess.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["target"],
      additionalProperties: false
    },
    handler: async (args: { target: string }) => {
      const current = contextBySession.get(sessionId);
      const source = current && typeof current === "object" ? current as { cells?: unknown; selectedCell?: { pageId?: unknown } | null; activePageId?: unknown } : {};
      const cells = Array.isArray(source.cells) ? source.cells as Array<{ id?: unknown; name?: unknown }> : [];
      const target = args.target.trim();
      const exactIdMatches = cells.filter((cell) => typeof cell.id === "string" && cell.id === target);
      const matches = exactIdMatches.length
        ? exactIdMatches
        : cells.filter((cell) =>
            typeof cell.name === "string" && cell.name.trim().toLocaleLowerCase() === target.toLocaleLowerCase()
          );
      if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
        throw new Error(matches.length > 1 ? "The element label is ambiguous; provide its exact cell ID." : "The element was not found in the supplied diagram context. No selection changed.");
      }
      const selected = { cellId: matches[0].id, pageId: typeof source.activePageId === "string" ? source.activePageId : typeof source.selectedCell?.pageId === "string" ? source.selectedCell.pageId : null, label: typeof matches[0].name === "string" ? matches[0].name : matches[0].id };
      registerTerminalIntent(sessionId, "selection");
      pendingAgentSelections.set(sessionId, selected);
      return { selected: true, ...selected, documentChanged: false };
    }
  });
}

function mergeTurnUsage(samples: TurnUsageMetrics[]): TurnUsageMetrics | undefined {
  if (!samples.length) return undefined;
  const sources = new Set(samples.map((item) => item.source));
  const result: TurnUsageMetrics = {
    source: sources.size === 1 ? samples[0]!.source : "unknown"
  };
  const byModel: NonNullable<TurnUsageMetrics["byModel"]> = {};
  for (const sample of samples) {
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "premiumRequestCost", "totalNanoAiu", "modelCalls"] as const) {
      const value = sample[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        const target = result as unknown as Record<string, unknown>;
        target[key] = ((typeof target[key] === "number" ? target[key] : 0) as number) + value;
      }
    }
    for (const [model, counts] of Object.entries(sample.byModel ?? {})) {
      const aggregate = { ...(byModel[model] ?? {}) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(counts)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          aggregate[key] = ((typeof aggregate[key] === "number" ? aggregate[key] : 0) as number) + value;
        }
      }
      byModel[model] = aggregate as NonNullable<TurnUsageMetrics["byModel"]>[string];
    }
  }
  if (Object.keys(byModel).length) result.byModel = byModel;
  return result;
}

function assistantText(message: unknown): string {
  const content = (message as { data?: { content?: unknown } } | undefined)?.data?.content;
  return typeof content === "string" ? content.trim() : "";
}
