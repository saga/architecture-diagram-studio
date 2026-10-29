import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import { CopilotRuntime, CopilotSessionBusyError, describeCopilotFailure } from "./runtime";
import type { ContextUsage, ModelCallUsage, TurnUsageMetrics } from "./runtime";
import {
  describeNativeEditOperation,
  nativePageAccepts,
  MAX_NATIVE_EDIT_OPERATIONS, parseNativeEditOperations, type ResolvedNativeEditOperation
} from "../../src/model/native-edit-operations";
import { getCachedNativeDiagramSnapshot } from "./diagram-snapshot-cache";
import { workspaceRevision } from "../storage";
import { resolveNativeEditTargets } from "./native-edit-tool";
import { NATIVE_EDIT_OPERATION_ITEM_SCHEMA } from "./native-edit-tool-schema";
import { normalizeDrawioRuntimeInspection, PINNED_DRAWIO_VERSION } from "../../src/model/drawio-runtime-contract";
import { resolveCopilotTurnTimeoutMs, resolveCopilotTurnIdleTimeoutMs } from "./turn-timeout";
import { requiresNativeEditReview } from "./edit-confirmation-policy";
import { NATIVE_DIAGRAM_CORE_INSTRUCTIONS } from "./native-diagram-instructions";
import { readDrawioAgentReference, isDrawioReferenceTopic } from "./drawio-agent-reference";
import { searchDrawioShapeCatalogDetailed, C4_DIRECTORY_SCRIPT_TEMPLATE, DRAWIO_SHAPE_CATALOG_VERSION, isC4DirectoryQuery } from "../../src/model/drawio-shape-catalog";

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

  getReceipt(requestId: string): NativeExecutionAckReceipt | null {
    return this.completed.get(requestId) ?? null;
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
  commitWorkspaceXmlPatch?(input: { patch: Array<Record<string, unknown>>; baseRevision: string; pageId: string | null; label: string }): Promise<{ ok: boolean; status: number; body: unknown }>;
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
const pendingXmlPatches = new Map<string, { patch: Array<Record<string, unknown>>; baseRevision: string; pageId: string | null; summary: string }>();

type TerminalIntentRegistration =
  | { accepted: true; replaced?: TerminalIntentKind }
  | { accepted: false; registeredKind: TerminalIntentKind };

function registerTerminalIntent(sessionId: string, kind: TerminalIntentKind): TerminalIntentRegistration {
  const registeredKind = pendingTerminalIntents.get(sessionId);
  if (!registeredKind) {
    pendingTerminalIntents.set(sessionId, kind);
    return { accepted: true };
  }
  // A concrete edit is more specific than a speculative focus/no-mutation conclusion.
  // Promote the edit rather than letting a premature terminal call poison the whole turn.
  if (kind === "native_edit" && registeredKind !== "native_edit") {
    pendingTerminalIntents.set(sessionId, "native_edit");
    if (registeredKind === "selection") pendingAgentSelections.delete(sessionId);
    if (registeredKind === "no_mutation") pendingReportedOutcomes.delete(sessionId);
    return { accepted: true, replaced: registeredKind };
  }
  // Never throw across the SDK boundary: SDK errors are often collapsed to the
  // unhelpful "Tool execution failed". Keep the first native edit and explain why
  // the later terminal action was ignored.
  return { accepted: false, registeredKind };
}

/**
 * The select and native-edit tools must see the elements of the *current* request.
 * The SDK session survives across turns and its tool closures are created once, so the
 * per-request context is read from here instead of being captured at session build time.
 */
const contextBySession = new Map<string, unknown>();

const ACK_TTL_MS = 10 * 60_000;
const MAX_PENDING_NATIVE_PROPOSALS = 500;
const EMPTY_QUERY_WARNING_THRESHOLD = 3;
const EMPTY_QUERY_STREAK_TTL_MS = 30 * 60_000;
const EMPTY_QUERY_STREAK_MAX_KEYS = 1_000;
const emptyQueryStreaks = new Map<string, { count: number; query: string; tool: string; updatedAt: number }>();

function prunePendingNativeProposals(
  now: number, reservedSlots = 0
): { expired: Array<{ id: string; proposal: PendingNativeProposal }>; evicted: Array<{ id: string; proposal: PendingNativeProposal }> } {
  const expired: Array<{ id: string; proposal: PendingNativeProposal }> = [];
  const evicted: Array<{ id: string; proposal: PendingNativeProposal }> = [];
  for (const [id, proposal] of pendingNativeProposals) {
    if (now - proposal.createdAt < ACK_TTL_MS) continue;
    pendingNativeProposals.delete(id);
    expired.push({ id, proposal });
  }
  while (pendingNativeProposals.size + Math.max(0, reservedSlots) > MAX_PENDING_NATIVE_PROPOSALS) {
    const oldest = pendingNativeProposals.entries().next().value as [string, PendingNativeProposal] | undefined;
    if (!oldest) break;
    pendingNativeProposals.delete(oldest[0]);
    evicted.push({ id: oldest[0], proposal: oldest[1] });
  }
  return { expired, evicted };
}

async function logPendingProposalSweep(
  sweep: ReturnType<typeof prunePendingNativeProposals>,
  writeLog: IntentDependencies["writeLog"]
): Promise<void> {
  for (const item of sweep.expired) {
    await writeLog("turn.native-edit.proposal-expired", { proposalId: item.id, sessionId: item.proposal.sessionId });
  }
  for (const item of sweep.evicted) {
    await writeLog("turn.native-edit.proposal-evicted", {
      proposalId: item.id, sessionId: item.proposal.sessionId,
      reason: "pending_proposal_capacity", maxPending: MAX_PENDING_NATIVE_PROPOSALS
    });
  }
}

function pruneEmptyQueryStreaks(now: number): void {
  // Map insertion order is refreshed below whenever a streak is updated, so stale entries
  // can be removed from the front without scanning every session.
  for (const [key, streak] of emptyQueryStreaks) {
    if (now - streak.updatedAt <= EMPTY_QUERY_STREAK_TTL_MS) break;
    emptyQueryStreaks.delete(key);
  }
  while (emptyQueryStreaks.size > EMPTY_QUERY_STREAK_MAX_KEYS) {
    const oldest = emptyQueryStreaks.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    emptyQueryStreaks.delete(oldest);
  }
}
const acknowledgementsDefault = new NativeExecutionAcknowledgements();

async function logQueryResult(
  sessionId: string,
  tool: string,
  query: string,
  resultCount: number,
  writeLog: IntentDependencies["writeLog"]
): Promise<{ warning?: string }> {
  const now = Date.now();
  pruneEmptyQueryStreaks(now);
  const key = sessionId + ":" + tool;
  if (resultCount > 0) {
    emptyQueryStreaks.delete(key);
    return {};
  }
  const previous = emptyQueryStreaks.get(key);
  const count = previous && now - previous.updatedAt <= EMPTY_QUERY_STREAK_TTL_MS ? previous.count + 1 : 1;
  // Delete/reinsert refreshes Map order so the least-recently-updated key stays first.
  emptyQueryStreaks.delete(key);
  emptyQueryStreaks.set(key, { count, query, tool, updatedAt: now });
  pruneEmptyQueryStreaks(now);
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

export function requiresExplicitConfirmation(operations: ResolvedNativeEditOperation[]): boolean {
  // Whole-page layout and destructive edits can affect many cells; require a deliberate review
  // even in local single-user mode. Ordinary typed edits retain the fast path.
  return operations.some((operation) => operation.op === "delete" || operation.op === "auto_layout");
}

function confirmationReviewMessage(operations: ResolvedNativeEditOperation[]): string {
  if (operations.some((operation) => operation.op === "auto_layout")) {
    return "Review this whole-page layout change before applying it. Studio will calculate positions with its configured layout engine, then update only native cell geometry and connector waypoints.";
  }
  if (operations.some((operation) => operation.op === "delete")) {
    return "This change deletes existing diagram elements. Confirm before applying it.";
  }
  return "This batch is broad and requires review before it can be applied.";
}

/**
 * Bounds the "declare this instead" hint attached to an undeclared native change so a repair
 * attempt receives the concrete serialized value it must assert, not just the missing field name.
 */
export function registerCopilotIntentRoute(app: Express, deps: IntentDependencies): void {
  const acknowledgements = deps.acknowledgements ?? acknowledgementsDefault;
  app.post("/api/copilot/intent/confirm", async (req, res) => {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    const proposalId = typeof body.proposalId === "string" ? body.proposalId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    await logPendingProposalSweep(prunePendingNativeProposals(Date.now()), deps.writeLog);
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
    const identity = parsedSnapshot.snapshot.identity;
    if (identity.documentPageId !== proposal.pageId) {
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
      nativeEdits: { operations: revalidated.operations, summary: proposal.summary, pageId: identity.documentPageId, documentRevision, requestId }
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
    const readOnlyNoChange = false;
    if (!outcome) {
      await deps.writeLog("turn.native-edit.ack-rejected", { requestId, sessionId, reason: "invalid_outcome", receivedOutcome: body.outcome ?? null });
      res.status(400).json({
        outcome: "failed", reason: "invalid_outcome",
        reply: "The final edit result has an invalid outcome.",
        error: "outcome must be either applied or failed."
      });
      return;
    }
    if (outcome === "applied" && (!editorAcknowledged || (!serializedXmlRevision && !readOnlyNoChange))) {
      await deps.writeLog("turn.native-edit.ack-rejected", {
        requestId, sessionId, reason: "incomplete_applied_evidence",
        editorAcknowledged, serializedXmlRevision, persistenceStatus
      });
      res.status(400).json({
        outcome: "failed", reason: "incomplete_applied_evidence",
        reply: "The editor result is incomplete and cannot be accepted as applied.",
        error: "An applied outcome requires native-editor acknowledgement and a serialized XML revision."
      });
      return;
    }
    if (outcome === "applied" && !readOnlyNoChange && applicationState !== "applied-and-verified") {
      await deps.writeLog("turn.native-edit.ack-rejected", {
        requestId, sessionId, reason: "editor_state_not_verified", applicationState,
        failureStage, serializedXmlRevision
      });
      res.status(400).json({
        outcome: "failed", reason: "editor_state_not_verified",
        reply: "The native editor state is not verified; the server will not record this as a successful edit.",
        error: "A mutating operation may be acknowledged as applied only when applicationState is applied-and-verified."
      });
      return;
    }
    if (outcome === "failed" && !errorMessage && !failureStage) {
      await deps.writeLog("turn.native-edit.ack-rejected", { requestId, sessionId, reason: "missing_failure_evidence" });
      res.status(400).json({
        outcome: "failed", reason: "missing_failure_evidence",
        reply: "The failed edit result is incomplete.",
        error: "A failed outcome must include a failure stage or error message."
      });
      return;
    }
    if (outcome === "applied" && pending.standalone && persistenceStatus !== "not_managed_by_server" && !readOnlyNoChange) {
      res.status(400).json({ outcome: "failed", reply: "Standalone file persistence is owned by the browser.", error: "Standalone acknowledgements must not claim a server-managed workspace save." });
      return;
    }
    if (outcome === "applied" && !pending.standalone && !readOnlyNoChange) {
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
        const responseBody = { outcome: "stale_context", reply: "The saved XML revision does not match its immutable version.", error: "The claimed immutable workspace version does not contain the acknowledged XML revision.", documentRevision: savedVersion?.revision ?? null, versionId: null };
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
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        preserveLocalGrouping: operation.preserveLocalGrouping,
        preserveCanvasOrigin: operation.preserveCanvasOrigin,
        preserveRelativeAnchors: operation.preserveRelativeAnchors,
        anchorCellIds: operation.anchorCellIds,
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
        if (args?.outcome !== "answered" && args?.outcome !== "needs_clarification" && args?.outcome !== "unsupported") {
          const error = "The no-mutation outcome must be answered, needs_clarification, or unsupported.";
          await deps.writeLog("tool.report_intent_outcome.rejected", { sessionId, reason: "invalid_outcome" });
          return { recorded: false, accepted: false, reason: "invalid_outcome", error, instructions: "Use one of the supported outcomes and do not claim that a diagram edit was applied." };
        }
        if (typeof args.reply !== "string" || !args.reply.trim() || args.reply.length > 2000) {
          const error = "A no-mutation outcome requires a user-facing reply of 1–2000 characters.";
          await deps.writeLog("tool.report_intent_outcome.rejected", { sessionId, reason: "invalid_reply" });
          return { recorded: false, accepted: false, reason: "invalid_reply", error, instructions: "Provide a concise non-empty reply up to 2000 characters; no terminal outcome was registered." };
        }
        const report: ReportedNoEditOutcome = {
          outcome: args.outcome,
          reply: args.reply.trim(),
          ...(typeof args.question === "string" && args.question.trim() ? { question: args.question.trim().slice(0, 1000) } : {}),
          ...(typeof args.reason === "string" && args.reason.trim() ? { reason: args.reason.trim().slice(0, 1000) } : {})
        } as ReportedNoEditOutcome;
        const registration = registerTerminalIntent(sessionId, "no_mutation");
        if (!registration.accepted) {
          await deps.writeLog("tool.terminal-intent.rejected", {
            sessionId, requestedKind: "no_mutation", registeredKind: registration.registeredKind,
            reason: "terminal_action_already_registered"
          });
          return {
            recorded: false, accepted: false, reason: "terminal_action_already_registered",
            registeredKind: registration.registeredKind,
            instructions: registration.registeredKind === "native_edit"
              ? "A native edit is already queued for dispatch. Do not call another terminal tool; let that edit execute."
              : "A terminal action is already queued for dispatch. Do not call another terminal tool this turn."
          };
        }
        pendingReportedOutcomes.set(sessionId, report);
        await deps.writeLog("tool.report_intent_outcome", { sessionId, outcome: report.outcome, replyLength: report.reply.length });
        return {
          recorded: true, accepted: true, terminal: true, outcome: report.outcome,
          replaceableByNativeEdit: true,
          instructions: "This no-mutation report will be returned if the turn ends now. If you determine the user actually requested a diagram mutation, submit exactly one native edit instead; Studio will promote that concrete edit over this provisional report. Otherwise stop. Never submit two native edits."
        };
      }
    });
  }

  function createDrawioShapeSearchTool(sessionId: string) {
    return defineTool("search_drawio_shapes", {
      description: "Search the curated local Draw.io shape catalogue for exact vetted styles and dimensions. Includes a C4 directory alias: query `C4 directory` once to return Person (person2), Software System and Container recipes, the relationship edge recipe, and a minimal script skeleton; use those exact styles and dimensions directly in one native script. A C4 creation turn allows this single catalogue query and no get_drawio_reference call. Query an individual type only when you need that specific recipe. Read-only and non-exhaustive: a miss does not prove a shape is unavailable.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 120, description: "Shape name or concept, in English or Chinese; a single CJK character is valid." },
          limit: { type: "integer", minimum: 1, maximum: 8, default: 5 }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args: { query?: unknown; limit?: unknown }) => {
        if (typeof args?.query !== "string" || args.query.trim().length < 1 || args.query.length > 120) {
          const error = "Shape search requires a non-empty query no longer than 120 characters.";
          await deps.writeLog("tool.search_drawio_shapes.rejected", { sessionId, reason: "invalid_query" });
          return { found: false, accepted: false, reason: "invalid_query", error, guidance: "Retry with a specific shape name or concept in English or Chinese." };
        }
        const requestedLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.floor(args.limit) : 5;
        const c4Directory = isC4DirectoryQuery(args.query);
        // The C4 alias is a bundle: never truncate the relationship recipe out of it.
        const searchPage = searchDrawioShapeCatalogDetailed(args.query, c4Directory ? Math.max(requestedLimit, 4) : requestedLimit);
        const results = searchPage.results;
        const queryStatus = await logQueryResult(sessionId, "search_drawio_shapes", args.query.trim(), searchPage.matchCount, deps.writeLog);
        return {
          found: searchPage.matchCount > 0,
          query: args.query.trim(),
          catalogueVersion: DRAWIO_SHAPE_CATALOG_VERSION,
          exhaustive: false,
          matchCount: searchPage.matchCount,
          returnedCount: searchPage.returnedCount,
          truncated: searchPage.truncated,
          results,
          ...(searchPage.truncated ? {
            guidance: "The curated catalogue matched " + searchPage.matchCount +
              " entries but returned only " + searchPage.returnedCount +
              ". Do not treat this subset as the complete candidate set. Retry with a more specific name/category or use the live Draw.io UI/runtime discovery path; the catalogue is intentionally non-exhaustive."
          } : {}),
          ...(c4Directory ? {
            scriptTemplate: C4_DIRECTORY_SCRIPT_TEMPLATE,
            guidance: "These recipes answer the whole C4 creation turn: build the script now. Replace the *_STYLE placeholders with the exact style strings above and keep their width/height; assert only the cells you create (one xmlAssertion each, at most 3 postconditions). Do not call get_drawio_reference or repeat this search in this turn."
          } : {}),
          ...(!searchPage.matchCount ? {
            ...(queryStatus.warning ? { warning: queryStatus.warning } : {}),
            guidance: "No match exists in the curated local catalogue. This is inconclusive: do not invent an ID or style. Probe the live Draw.io UI/runtime for matching native entries (for example, inspect ui.sidebar.searchEntries if available); do not treat the curated catalogue as exhaustive. Use a typed operation for a supported concept or report the limitation if no native definition can be verified."
          } : {})
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
        query: { type: "string", minLength: 1, maxLength: 120, description: "Shape class, library or concept keyword, e.g. c4, person, uml; a single CJK character is valid." },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 15 }
      },
      required: ["query"],
      additionalProperties: false
    },
    handler: async (args: { query?: unknown; limit?: unknown }) => {
      if (typeof args?.query !== "string" || args.query.trim().length < 1 || args.query.length > 120) {
        const error = "Live Draw.io shape search requires a non-empty query no longer than 120 characters.";
        await deps.writeLog("tool.search_drawio_runtime_shapes.rejected", { sessionId, reason: "invalid_query" });
        return { found: false, accepted: false, reason: "invalid_query", error, guidance: "Retry with a specific shape class, library or concept keyword." };
      }
      const current = contextBySession.get(sessionId);
      const context = current && typeof current === "object" ? current as {
        runtimeInspection?: {
          liveShapeClasses?: unknown; liveShapeClassesTruncated?: unknown;
          drawioVersion?: unknown; documentRevision?: unknown
        }
      } : {};
      const inspection = context.runtimeInspection;
      const classes = Array.isArray(inspection?.liveShapeClasses) ? inspection.liveShapeClasses.filter((name): name is string => typeof name === "string") : [];
      const registrySnapshotTruncated = inspection?.liveShapeClassesTruncated === true;
      const query = args.query.trim().toLocaleLowerCase();
      const matches = classes.filter((name) => name.toLocaleLowerCase().includes(query));
      const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(30, Math.floor(args.limit))) : 15;
      const results = matches.slice(0, limit);
      const resultSetTruncated = matches.length > results.length;
      const guidance = registrySnapshotTruncated
        ? "The live shape registry snapshot itself was truncated at its transport cap. These counts cover only the retained subset; do not conclude a class is unavailable from no match. Inspect the live Draw.io sidebar/runtime search APIs and verify a representative native cell."
        : resultSetTruncated
          ? "This query matched more classes than were returned. Use a narrower query or increase limit; do not treat this result subset as complete."
          : classes.length === 0
            ? "No live shape registry snapshot is available for this turn. Refresh the active editor runtime inspection before concluding that a shape is unavailable."
            : matches.length === 0
              ? "No registered JavaScript shape class matched this query. This does not exclude built-in mxGraph shapes, stencil libraries, sidebar search entries, or lazily loaded libraries; inspect live sidebar/library APIs and verify a native cell before falling back."
              : undefined;
      await deps.writeLog("tool.search_drawio_runtime_shapes.completed", {
        sessionId, query: args.query.trim(), registryCount: classes.length, registrySnapshotTruncated,
        matchCount: matches.length, returnedCount: results.length, resultSetTruncated,
        truncated: registrySnapshotTruncated || resultSetTruncated,
        drawioVersion: inspection?.drawioVersion ?? null, documentRevision: inspection?.documentRevision ?? null
      });
      return {
        source: "live-mxCellRenderer.defaultShapes",
        liveSnapshotAvailable: classes.length > 0,
        registrySnapshotTruncated,
        matchCountComplete: !registrySnapshotTruncated,
        drawioVersion: inspection?.drawioVersion ?? null,
        matchCount: matches.length,
        returnedCount: results.length,
        resultSetTruncated,
        truncated: registrySnapshotTruncated || resultSetTruncated,
        results,
        ...(guidance ? { guidance } : {})
      };
    }
  });
}

function createDrawioElementSearchTool(sessionId: string) {
    return defineTool("search_drawio_elements", {
      description: "Search every native cell on the active Draw.io page by ID, label, shape key or geometry metadata. Read-only and non-terminal. Single-character CJK queries are valid. Use inspect_drawio_graph for structured shape/coordinate filters or pagination.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 120, description: "Exact ID, label text, native shape key, or a distinctive part of geometry metadata. A single character is valid." },
          limit: { type: "integer", minimum: 1, maximum: 10, default: 10 }
        },
        required: ["query"],
        additionalProperties: false
      },
      handler: async (args: { query?: unknown; limit?: unknown }) => {
        if (typeof args?.query !== "string" || args.query.trim().length < 1 || args.query.length > 120) {
          const error = "Element search requires a non-empty query no longer than 120 characters.";
          await deps.writeLog("tool.search_drawio_elements.rejected", { sessionId, reason: "invalid_query" });
          return { found: false, accepted: false, reason: "invalid_query", error, guidance: "Retry with an ID, label, native shape key or geometry fragment." };
        }
        const current = contextBySession.get(sessionId);
        const context = current && typeof current === "object"
          ? current as { cells?: unknown; activePageId?: unknown; documentRevision?: unknown }
          : {};
        const cells = Array.isArray(context.cells)
          ? context.cells as Array<{
              id?: unknown; name?: unknown; cellType?: unknown; shape?: unknown;
              geometry?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
              rotation?: unknown; parentId?: unknown
            }>
          : [];
        const query = args.query.trim();
        const normalized = query.toLocaleLowerCase();
        const exactId = cells.filter((cell) => typeof cell.id === "string" && cell.id === query);
        const exactLabel = cells.filter((cell) =>
          typeof cell.name === "string" && cell.name.trim().toLocaleLowerCase() === normalized
        );
        const searchableText = (cell: typeof cells[number]): string => {
          const geometry = cell.geometry;
          return [
            cell.id, cell.name, cell.cellType, cell.shape, cell.parentId,
            geometry ? "x:" + geometry.x + " y:" + geometry.y + " width:" + geometry.width + " height:" + geometry.height : "",
            typeof cell.rotation === "number" ? "rotation:" + cell.rotation : ""
          ].filter((value): value is string => typeof value === "string").join(" ").toLocaleLowerCase();
        };
        const exactIdCells = new Set(exactId);
        const exactLabelCells = new Set(exactLabel);
        const matches = cells.filter((cell) => {
          const index = searchableText(cell);
          if (index.includes(normalized)) return true;
          const tokens = normalized.split(/\s+/u).filter(Boolean);
          return tokens.length > 1 && tokens.every((token) => index.includes(token));
        }).sort((left, right) => {
          // Exact ID/label hits rank first, but never suppress other ID or rich-label substring matches.
          const priority = (cell: typeof cells[number]) => exactIdCells.has(cell) ? 0 : exactLabelCells.has(cell) ? 1 : 2;
          return priority(left) - priority(right);
        });
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.max(1, Math.min(10, Math.floor(args.limit)))
          : 10;
        const queryStatus = await logQueryResult(sessionId, "search_drawio_elements", query, matches.length, deps.writeLog);
        const results = matches.slice(0, limit).flatMap((cell) =>
          typeof cell.id === "string" ? [{
            id: cell.id,
            label: typeof cell.name === "string" && cell.name.trim() ? cell.name.trim() : "",
            cellType: typeof cell.cellType === "string" ? cell.cellType : "unknown",
            ...(typeof cell.shape === "string" && cell.shape ? { shape: cell.shape } : {}),
            ...(cell.geometry && typeof cell.geometry === "object" ? { geometry: cell.geometry } : {}),
            ...(typeof cell.rotation === "number" ? { rotation: cell.rotation } : {}),
            ...(typeof cell.parentId === "string" ? { parentId: cell.parentId } : {})
          }] : []
        );
        await deps.writeLog("tool.search_drawio_elements.completed", {
          sessionId, matchCount: matches.length, returnedCount: results.length,
          truncated: matches.length > results.length
        });
        return {
          found: matches.length > 0,
          query,
          pageId: typeof context.activePageId === "string" ? context.activePageId : null,
          documentRevision: typeof context.documentRevision === "string" ? context.documentRevision : null,
          matchCount: matches.length,
          returnedCount: results.length,
          truncated: matches.length > results.length,
          results,
          ...(matches.length > results.length ? {
            guidance: "This result is truncated; do not perform an 'all' edit from this subset. Use inspect_drawio_graph with the same query and offset/nextOffset until truncated is false, keeping the same pageId and documentRevision. Narrow queries only when you can account for the complete union of results; copy every cell ID verbatim."
          } : {}),
          ...(queryStatus.warning ? { warning: queryStatus.warning } : {})
        };
      }
    });
  }

  function createDrawioGraphInspectionTool(sessionId: string) {
    return defineTool("inspect_drawio_graph", {
      description: "Read-only, non-terminal inspection of every native cell on the current Draw.io page. Filter by shape, cell type, unlabeled status, a point or a bounding box; paginate with offset/limit. Use before editing unnamed shapes such as furniture in a floor plan. Returns native IDs, shapes and rounded geometry; does not mutate the diagram.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 120, description: "Optional case-insensitive substring of ID, label, shape or parent ID." },
          shape: { type: "string", minLength: 1, maxLength: 180, description: "Optional substring of the native Draw.io shape style key." },
          cellType: { type: "string", enum: ["vertex", "edge"] },
          unlabeled: { type: "boolean", description: "When true, include only cells with an empty visible label." },
          point: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" } },
            required: ["x", "y"], additionalProperties: false
          },
          bounds: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number", minimum: 0 }, height: { type: "number", minimum: 0 } },
            required: ["x", "y", "width", "height"], additionalProperties: false
          },
          offset: { type: "integer", minimum: 0, maximum: 20000, default: 0 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 40 }
        },
        additionalProperties: false
      },
      handler: async (args: {
        query?: unknown; shape?: unknown; cellType?: unknown; unlabeled?: unknown;
        point?: unknown; bounds?: unknown; offset?: unknown; limit?: unknown
      }) => {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          return { ok: false, reason: "invalid_arguments", error: "Graph inspection requires an object of valid filters.", results: [] };
        }
        const current = contextBySession.get(sessionId);
        const context = current && typeof current === "object"
          ? current as { cells?: unknown; documentRevision?: unknown; activePageId?: unknown }
          : {};
        const cells = Array.isArray(context.cells) ? context.cells as Array<{
          id?: unknown; name?: unknown; cellType?: unknown; shape?: unknown;
          geometry?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
          rotation?: unknown; parentId?: unknown
        }> : [];
        const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase() : "";
        const shapeQuery = typeof args.shape === "string" ? args.shape.trim().toLocaleLowerCase() : "";
        if (args?.query !== undefined && (!query || query.length > 120)) return { ok: false, reason: "invalid_query", error: "Graph inspection query must be 1–120 characters.", results: [] };
        if (args?.shape !== undefined && (!shapeQuery || shapeQuery.length > 180)) return { ok: false, reason: "invalid_shape_filter", error: "Shape filter must be 1–180 characters.", results: [] };
        if (args.cellType !== undefined && args.cellType !== "vertex" && args.cellType !== "edge") return { ok: false, reason: "invalid_cell_type", error: "cellType must be vertex or edge.", results: [] };
        if (args.unlabeled !== undefined && typeof args.unlabeled !== "boolean") return { ok: false, reason: "invalid_unlabeled_filter", error: "unlabeled must be a boolean.", results: [] };
        const point = args.point;
        if (point !== undefined && (!point || typeof point !== "object" || Array.isArray(point) ||
            typeof (point as { x?: unknown }).x !== "number" || !Number.isFinite((point as { x: number }).x) ||
            typeof (point as { y?: unknown }).y !== "number" || !Number.isFinite((point as { y: number }).y))) {
          return { ok: false, reason: "invalid_point", error: "point requires finite x and y coordinates.", results: [] };
        }
        const bounds = args.bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
        if (bounds !== undefined && (!bounds || typeof bounds !== "object" || Array.isArray(bounds) ||
            ![bounds.x, bounds.y, bounds.width, bounds.height].every((value) => typeof value === "number" && Number.isFinite(value)) ||
            (bounds.width as number) < 0 || (bounds.height as number) < 0)) {
          return { ok: false, reason: "invalid_bounds", error: "bounds requires finite x/y and non-negative width/height.", results: [] };
        }
        const offset = typeof args.offset === "number" && Number.isInteger(args.offset)
          ? Math.max(0, Math.min(20000, args.offset)) : 0;
        const limit = typeof args.limit === "number" && Number.isInteger(args.limit)
          ? Math.max(1, Math.min(100, args.limit)) : 40;
        const matches = cells.filter((cell) => {
          const name = typeof cell.name === "string" ? cell.name.trim() : "";
          const id = typeof cell.id === "string" ? cell.id : "";
          const shape = typeof cell.shape === "string" ? cell.shape : "";
          const parentId = typeof cell.parentId === "string" ? cell.parentId : "";
          const type = cell.cellType === "vertex" || cell.cellType === "edge" ? cell.cellType : "unknown";
          const geometry = cell.geometry;
          if (args.cellType !== undefined && type !== args.cellType) return false;
          if (args.unlabeled === true && name.length > 0) return false;
          if (query && ![id, name, shape, parentId, type].some((value) => value.toLocaleLowerCase().includes(query))) return false;
          if (shapeQuery && !shape.toLocaleLowerCase().includes(shapeQuery)) return false;
          if (point !== undefined) {
            const px = (point as { x: number }).x;
            const py = (point as { y: number }).y;
            if (!geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number" ||
                typeof geometry.width !== "number" || typeof geometry.height !== "number" ||
                px < geometry.x || py < geometry.y || px > geometry.x + geometry.width || py > geometry.y + geometry.height) return false;
          }
          if (bounds) {
            if (!geometry || typeof geometry.x !== "number" || typeof geometry.y !== "number" ||
                typeof geometry.width !== "number" || typeof geometry.height !== "number") return false;
            const left = bounds.x as number; const top = bounds.y as number;
            const right = left + (bounds.width as number); const bottom = top + (bounds.height as number);
            if (geometry.x + geometry.width < left || geometry.x > right ||
                geometry.y + geometry.height < top || geometry.y > bottom) return false;
          }
          return true;
        });
        const page = typeof context.activePageId === "string" ? context.activePageId : null;
        const results = matches.slice(offset, offset + limit).map((cell) => ({
          id: typeof cell.id === "string" ? cell.id : "",
          label: typeof cell.name === "string" ? cell.name : "",
          cellType: typeof cell.cellType === "string" ? cell.cellType : "unknown",
          shape: typeof cell.shape === "string" ? cell.shape : "",
          // Edges have no bounding box: Draw.io omits x/y/width/height from their serialized
          // mxGeometry, so reporting the normalized zeros here invites assertions that can never
          // pass against the saved XML. Geometry filtering above still uses the internal values.
          ...(cell.cellType !== "edge" && cell.geometry && typeof cell.geometry === "object"
            ? { geometry: cell.geometry } : {}),
          ...(typeof cell.rotation === "number" ? { rotation: cell.rotation } : {}),
          ...(typeof cell.parentId === "string" ? { parentId: cell.parentId } : {})
        }));
        const truncated = offset + results.length < matches.length;
        await deps.writeLog("tool.inspect_drawio_graph.completed", {
          sessionId, pageId: page, documentRevision: context.documentRevision ?? null,
          totalCount: matches.length, offset, returnedCount: results.length, truncated,
          filters: { query: query || null, shape: shapeQuery || null, cellType: args.cellType ?? null,
            unlabeled: args.unlabeled === true, hasPoint: point !== undefined, hasBounds: bounds !== undefined }
        });
        return {
          source: "native-drawio-xml", pageId: page, documentRevision: context.documentRevision ?? null,
          totalCount: matches.length, offset, limit, returnedCount: results.length,
          nextOffset: truncated ? offset + results.length : null, truncated, results
        };
      }
    });
  }

  function createDrawioReferenceTool(sessionId: string) {
    return defineTool("get_drawio_reference", {
      description: "Read the local Draw.io Agent API reference on demand. Read-only; does not change the diagram.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["overview", "api_ownership", "shape_discovery", "postconditions", "recipes", "all"],
            description: "Choose the smallest relevant reference section."
          }
        },
        required: ["topic"],
        additionalProperties: false
      },
      handler: async (args: { topic?: unknown }) => {
        const topic = args?.topic;
        if (!isDrawioReferenceTopic(topic)) {
          await deps.writeLog("tool.get_drawio_reference.rejected", { sessionId, reason: "invalid_reference_topic" });
          return { accepted: false, reason: "invalid_reference_topic", error: "Select one supported Draw.io reference topic.", availableTopics: ["overview", "api_ownership", "shape_discovery", "postconditions", "recipes", "all"] };
        }
        try {
          return { accepted: true, topic, reference: await readDrawioAgentReference(topic) };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          await deps.writeLog("tool.get_drawio_reference.failed", {
            sessionId, topic, errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: errorMessage.slice(0, 1000)
          });
          return {
            accepted: false, reason: "reference_unavailable", topic,
            error: errorMessage.slice(0, 1000),
            instructions: "The local reference could not be loaded; this is not a Draw.io bridge failure. Continue using the core instructions and native inspection tools, or choose another reference topic."
          };
        }
      }
    });
  }

  function createEditDrawioXmlTool(sessionId: string) {
    return defineTool("edit_drawio_xml", {
      description: "Edit the active workspace Draw.io document by proposing a cell-scoped XML patch. This is the terminal editing action: the server applies the patch to the native XML, validates it, and persists it with revision checks. Do not use JavaScript or editor scripts. Target cells by exact native cell ID copied from the supplied diagram context. Use set-cell-attributes for mxCell attributes, set-geometry for coordinates and size, delete-cell to remove a cell, or insert-cell-xml to add a native mxCell/object fragment under an existing parent ID. The inserted fragment must include its exact unique native cell ID and any mxGeometry needed by the shape or edge.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 1000 },
          patch: {
            type: "array", minItems: 1, maxItems: 100,
            items: {
              oneOf: [
                { type: "object", properties: {
                  op: { type: "string", enum: ["set-cell-attributes"] },
                  cellId: { type: "string", minLength: 1 },
                  attributes: { type: "object", additionalProperties: { oneOf: [{ type: "string" }, { type: "null" }] } }
                }, required: ["op", "cellId", "attributes"], additionalProperties: false },
                { type: "object", properties: {
                  op: { type: "string", enum: ["set-geometry"] },
                  cellId: { type: "string", minLength: 1 },
                  geometry: { type: "object", properties: {
                    x: { type: "number" }, y: { type: "number" },
                    width: { type: "number" }, height: { type: "number" }
                  }, minProperties: 1, additionalProperties: false }
                }, required: ["op", "cellId", "geometry"], additionalProperties: false },
                { type: "object", properties: {
                  op: { type: "string", enum: ["set-geometry-xml"] },
                  cellId: { type: "string", minLength: 1 },
                  geometryXml: { type: "string", minLength: 1, maxLength: 100000 }
                }, required: ["op", "cellId", "geometryXml"], additionalProperties: false },
                { type: "object", properties: {
                  op: { type: "string", enum: ["delete-cell"] },
                  cellId: { type: "string", minLength: 1 }
                }, required: ["op", "cellId"], additionalProperties: false },
                { type: "object", properties: {
                  op: { type: "string", enum: ["insert-cell-xml"] },
                  parentId: { type: "string", minLength: 1 },
                  cellXml: { type: "string", minLength: 1, maxLength: 200000 }
                }, required: ["op", "parentId", "cellXml"], additionalProperties: false }
              ]
            }
          }
        },
        required: ["summary", "patch"],
        additionalProperties: false
      },
      handler: async (args: { summary?: unknown; patch?: unknown }) => {
        if (typeof args.summary !== "string" || !args.summary.trim() || args.summary.length > 1000 ||
            !Array.isArray(args.patch) || args.patch.length < 1 || args.patch.length > 100) {
          return { accepted: false, terminal: false, reason: "invalid_xml_patch", error: "Provide a summary and 1–100 valid XML patch operations." };
        }
        if (!deps.commitWorkspaceXmlPatch) {
          return { accepted: false, terminal: false, reason: "xml_patch_persistence_unavailable", error: "Server-side XML patch persistence is not configured." };
        }
        const context = contextBySession.get(sessionId) as { documentRevision?: string; activePageId?: string | null } | undefined;
        const snapshot = await deps.getWorkspaceDiagramSnapshot();
        if (!snapshot || !context?.documentRevision || context.documentRevision !== snapshot.revision) {
          return { accepted: false, terminal: false, reason: "stale_document_revision", error: "The active document changed since the model context was prepared. Reload the current XML and retry." };
        }
        const registration = registerTerminalIntent(sessionId, "native_edit");
        if (!registration.accepted) {
          return { accepted: false, terminal: false, reason: "terminal_action_already_registered", registeredKind: registration.registeredKind };
        }
        pendingXmlPatches.set(sessionId, {
          patch: args.patch as Array<Record<string, unknown>>,
          baseRevision: snapshot.revision,
          pageId: typeof context.activePageId === "string" ? context.activePageId : null,
          summary: args.summary.trim()
        });
        await deps.writeLog("tool.edit_drawio_xml.accepted", {
          sessionId, summary: args.summary.trim(), operationCount: args.patch.length,
          baseRevision: snapshot.revision
        });
        return {
          accepted: true, terminal: true, execution: "after_model_turn",
          summary: args.summary.trim(), operationCount: args.patch.length,
          instructions: "The server will apply and persist this XML patch after the model turn. Do not call another editing tool and do not claim success until the final persistence receipt is returned."
        };
      }
    });
  }

  function createProposeNativeEditsTool(sessionId: string) {
    return defineTool("propose_native_edits", {
      description: "Queue one batch of common, typed native Draw.io edits such as rename, styling, move, resize, delete, simple connected-node insertion and Studio-owned automatic layout. This is a convenience fast path, not a limit on Draw.io capability. Typed set_label fails closed on rich HTML labels when plain-text replacement would flatten nested formatting or placeholders; use the XML-first editing tool for markup-preserving edits. This is the terminal action for the turn: it is queued, not yet applied or saved. Do not call another terminal tool or claim completion after acceptance. In local single-user mode, valid batches do not require a second confirmation click; Studio still validates the revision and verifies native XML/persistence. For other graph operations use edit_drawio_xml; never fabricate cell IDs.",
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
          await deps.writeLog("tool.propose_native_edits.rejected", { sessionId, reason: "invalid_native_edit_batch", error: parsed.error });
          return { accepted: false, reason: "invalid_native_edit_batch", error: parsed.error, instructions: "Correct the operations payload to match the tool schema. No edit was queued." };
        }
        const resolved = resolveNativeEditTargets(contextBySession.get(sessionId) ?? null, parsed.operations);
        if (!resolved.ok) {
          await deps.writeLog("tool.propose_native_edits.unresolved", { sessionId, operations: parsed.operations, reason: "unresolved_targets", error: resolved.error });
          return { accepted: false, reason: "unresolved_targets", error: resolved.error, instructions: "Use current-page IDs or a unique exact label from the supplied context. No edit was queued." };
        }
        const summary = resolved.operations.map(describeNativeEditOperation).join("; ");
        const registration = registerTerminalIntent(sessionId, "native_edit");
        if (!registration.accepted) {
          await deps.writeLog("tool.terminal-intent.rejected", {
            sessionId, requestedKind: "native_edit", registeredKind: registration.registeredKind,
            reason: "terminal_action_already_registered", operationCount: resolved.operations.length
          });
          return {
            accepted: false, reason: "terminal_action_already_registered",
            registeredKind: registration.registeredKind,
            instructions: "This terminal action was not queued. The previously registered action remains authoritative. Do not retry or call another terminal tool; if the registered action is a native edit, let it dispatch."
          };
        }
        pendingNativeEdits.set(sessionId, { operations: resolved.operations, summary });
        if (registration.replaced) {
          await deps.writeLog("tool.terminal-intent.promoted-to-edit", {
            sessionId, replacedKind: registration.replaced, operationCount: resolved.operations.length
          });
        }
        await deps.writeLog("tool.propose_native_edits.accepted", {
          sessionId, operationCount: resolved.operations.length,
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}), 
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        preserveLocalGrouping: operation.preserveLocalGrouping,
        preserveCanvasOrigin: operation.preserveCanvasOrigin,
        nodeSpacing: operation.nodeSpacing, layerSpacing: operation.layerSpacing, edgeRouting: operation.edgeRouting,
        iterations: operation.iterations, randomSeed: operation.randomSeed, margin: operation.margin } : {}) }))
        });
        return {
          // This is tool feedback, not proof of editor execution/persistence.
          accepted: true, queued: true, execution: "after_model_turn", terminal: true, result_available: false,
          instructions: "The native edit intent is queued, but the diagram has not been changed or saved yet. Do not call another terminal tool or claim success. Studio will validate the current revision and dispatch the operation for native XML and persistence verification; in local single-user mode there is no second confirmation click.",
          operationCount: resolved.operations.length,
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}),
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        preserveLocalGrouping: operation.preserveLocalGrouping,
        preserveCanvasOrigin: operation.preserveCanvasOrigin,
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
          await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: suppliedSnapshot.reason, xmlLength: diagramXml.length });
          if (suppliedSnapshot.reason === "page-not-found") {
            res.status(409).json({ outcome: "stale_context", reply: "The active Draw.io page is no longer present in this document revision.", error: "The requested page is not present in this XML revision.", documentRevision, requestId, sessionId });
          } else {
            res.status(400).json({ outcome: "failed", reply: "The Copilot request contains invalid Draw.io XML.", error: "The Copilot request contains invalid Draw.io XML", requestId, sessionId });
          }
          return;
        }
        if (!nativePageAccepts(suppliedSnapshot.snapshot.identity, requestedPageId)) {
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
      await deps.writeLog("request.validation.failed", { requestId, sessionId, reason: parsedSnapshot.reason, xmlLength: diagramXml.length });
      if (parsedSnapshot.reason === "page-not-found") {
        res.status(409).json({ outcome: "stale_context", reply: "The active Draw.io page is no longer present in this document revision.", error: "The requested page is not present in this XML revision.", documentRevision, requestId, sessionId });
      } else {
        res.status(400).json({ outcome: "failed", reply: "The Copilot request contains invalid Draw.io XML.", error: "The Copilot request contains invalid Draw.io XML", requestId, sessionId });
      }
      return;
    }
    const identity = parsedSnapshot.snapshot.identity;
    await deps.writeLog("diagram.snapshot.cache", {
      requestId, revision: computedRevision, activePageId: identity.documentPageId,
      cacheHit: parsedSnapshot.cacheHit, targetCount: parsedSnapshot.snapshot.targets.length
    });
    // Page identity comes from the document, not from the caller: a bare mxGraphModel declares no
    // page ID, so any editor-reported ID there refers to its single page.
    if (!nativePageAccepts(identity, requestedPageId)) {
      res.status(409).json({ outcome: "stale_context", reply: "The active Draw.io page is no longer present in this document revision.", error: "The requested page is not present in this XML revision.", documentRevision, requestId, sessionId });
      return;
    }
    const allNativeCells = parsedSnapshot.snapshot.targets;
    const requestedSelection = (requestedContext as { selectedCell?: unknown }).selectedCell;
    let selectedCell: { cellId: string; pageId: string | null; label: string } | null = null;
    if (requestedSelection && typeof requestedSelection === "object" && !Array.isArray(requestedSelection)) {
      const selection = requestedSelection as { cellId?: unknown; pageId?: unknown };
      if (typeof selection.cellId === "string" && selection.cellId.trim()) {
        if (typeof selection.pageId === "string" && identity.documentPageId && selection.pageId !== identity.documentPageId) {
          res.status(409).json({ outcome: "stale_context", reply: "The selected element belongs to another page. Select it again and retry.", error: "The selected cell belongs to a different Draw.io page.", documentRevision, requestId, sessionId });
          return;
        }
        const target = allNativeCells.find((cell) => cell.id === selection.cellId);
        if (!target) {
          res.status(409).json({ outcome: "stale_context", reply: "The selected element changed or was removed. Select it again and retry.", error: "The selected cell is not present on the active Draw.io page in this revision.", documentRevision, requestId, sessionId });
          return;
        }
        selectedCell = { cellId: target.id, pageId: identity.documentPageId, label: target.name };
      }
    }
    let visibleCells = allNativeCells.slice(0, 200);
    if (selectedCell && !visibleCells.some((cell) => cell.id === selectedCell!.cellId)) {
      visibleCells = [...visibleCells.slice(0, 199), allNativeCells.find((cell) => cell.id === selectedCell!.cellId)!];
    }
    const suppliedRuntimeInspection = (requestedContext as { runtimeInspection?: unknown }).runtimeInspection;
    const runtimeInspection = normalizeDrawioRuntimeInspection(suppliedRuntimeInspection, {
      documentRevision: computedRevision, pageId: identity.documentPageId, drawioVersion: PINNED_DRAWIO_VERSION
    });
    if (suppliedRuntimeInspection !== undefined && !runtimeInspection) {
      await deps.writeLog("request.runtime-inspection.rejected", {
        requestId, sessionId, reason: "snapshot_did_not_match_revision_page_or_pinned_runtime",
        expectedRevision: computedRevision, expectedPageId: identity.documentPageId, expectedDrawioVersion: PINNED_DRAWIO_VERSION
      });
    }
    // The model-facing list is {id,label}: a label survives revisions, and an ID is trustworthy only
    // when this list or the selection supplied it. Cell tools keep the private name-based index.
    const promptCells = visibleCells.map((cell) => ({
      id: cell.id, label: cell.name, cellType: cell.cellType,
      ...(cell.shape ? { shape: cell.shape } : {}),
      ...(cell.geometry ? { geometry: cell.geometry } : {}),
      ...(cell.rotation !== undefined ? { rotation: cell.rotation } : {}),
      ...(cell.parentId ? { parentId: cell.parentId } : {})
    }));
    const context = {
      kind: "drawio",
      title: typeof (requestedContext as { title?: unknown }).title === "string"
        ? ((requestedContext as { title: string }).title.slice(0, 200))
        : identity.title || "Draw.io diagram",
      activePageId: identity.documentPageId,
      selectedCell,
      cells: promptCells,
      ...(runtimeInspection ? { runtimeInspection } : {}),
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
    for (const id of acknowledgements.expire(Date.now(), ACK_TTL_MS)) {
      await deps.writeLog("turn.native-edit.ack-expired", { requestId: id });
    }
    await logPendingProposalSweep(prunePendingNativeProposals(Date.now()), deps.writeLog);
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
              createSelectDiagramElementTool(sessionId, deps.writeLog),
              createDrawioShapeSearchTool(sessionId),
              createDrawioRuntimeShapeSearchTool(sessionId),
              createDrawioElementSearchTool(sessionId),
              createDrawioGraphInspectionTool(sessionId),
              createDrawioReferenceTool(sessionId),
              ...(!standalone ? [createEditDrawioXmlTool(sessionId)] : []),
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
        contextBySession.set(sessionId, { ...context, documentRevision, activePageId: identity.documentPageId, cells: allNativeCells, runtimeInspection: context.runtimeInspection });
        pendingAgentSelections.delete(sessionId);
        pendingNativeEdits.delete(sessionId);
        pendingReportedOutcomes.delete(sessionId);
        pendingTerminalIntents.delete(sessionId);
        pendingXmlPatches.delete(sessionId);
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
        const terminalIntentModelFailure: { value: { attempt: number; error: string } | null } = { value: null };
        const sendAttemptPreservingAcceptedIntent = async (
          attempt: number, requestPrompt: string, reason?: string
        ): Promise<void> => {
          try {
            await sendAttempt(attempt, requestPrompt, reason);
          } catch (error) {
            const terminalKind = pendingTerminalIntents.get(sessionId);
            const errorMessage = error instanceof Error ? error.message : String(error);
            // Tool handlers can accept and fully validate a terminal action before the SDK stream
            // fails while trying to obtain the model's follow-up text. Do not silently delete that
            // already-accepted action; the browser still has to verify native XML and persistence.
            if (requestCancelled || res.destroyed || !terminalKind) throw error;
            terminalIntentModelFailure.value = { attempt, error: errorMessage.slice(0, 1000) };
            await deps.writeLog("turn.model-call.failed-after-terminal-intent.failed", {
              requestId, sessionId, attempt, terminalKind,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage: errorMessage.slice(0, 1000),
              acceptedNativeEdit: pendingNativeEdits.has(sessionId),
              acceptedSelection: pendingAgentSelections.has(sessionId),
              acceptedReportedOutcome: pendingReportedOutcomes.has(sessionId)
            });
          }
        };
        const firstRequestPrompt = JSON.stringify({
          projectWorkspace: projectContext,
          diagram: context,
          request: prompt,
          editingGuidance: "Prefer compact typed native operations over generated scripts when they express the requested change. For C4 diagrams, apply explicit labels with set_label and colors with set_style; each style operation changes one key (fillColor, strokeColor, or fontColor), so batch a few operations instead of writing a large script. For C4 creation, call search_drawio_shapes with `C4 directory` exactly once: it returns Person (person2), Software System, Container, the relationship edge recipe and a script skeleton. That single query is the whole discovery step — do not call get_drawio_reference and do not search again;  Keep the returned evidence minimal: one xmlAssertion per cell you created or changed, at most 3 postconditions, and never assert untouched cells; labelContains is Studio-only, not Draw.io XML. Studio diffs XML. Suggested C4 palette when the user asks for standard C4 styling: Person fill #08427B, External System fill #999999, System fill #1168BD; preserve user-edited colors and do not recolor unrelated cells. Resolve display labels with graph.convertValueToString(cell), rejecting zero or ambiguous matches. model.getValue(cell) may be a UserObject DOM Element: never String() it blindly. For a wrapped value, clone the element, update only its label attribute, and call model.setValue(cell, clone) so placeholders and metadata survive. For rich HTML labels with nested formatting/placeholders, do not use typed set_label because Studio rejects plain-text replacements that would flatten markup; use edit_drawio_xml to patch only the intended text while preserving the native XML. Trust cell IDs from selectedCell, diagram.cells, or search/inspection results bound to this exact documentRevision; never reuse stale IDs. Never infer a cell is a C4 type unless the request or diagram context establishes it. Use edit_drawio_xml when the typed operations cannot express the change. Connector routing is a special case: an edge has no box geometry, so a reroute must be proved with geometry.points (the waypoints you set), never with geometry.x/y/width/height, and curved=1 alone bends nothing unless a waypoint exists."
        });
        await sendAttemptPreservingAcceptedIntent(1, firstRequestPrompt);
        let capturedSelection = pendingAgentSelections.get(sessionId) || null;
        let capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
        let capturedReportedOutcome = pendingReportedOutcomes.get(sessionId) || null;
        if (!capturedSelection && !capturedNativeEdits && !capturedReportedOutcome) {
          await deps.writeLog("turn.native-tool-not-called", { sessionId, attempt: 1, modelText: modelText.slice(0, 2000) });
          const retryPrompt = JSON.stringify({
            request: "Finish with exactly one terminal tool call. Use propose_native_edits as a convenience fast path for simple common edits and Studio-owned auto_layout. Use edit_drawio_xml for non-trivial native edits beyond the typed-operation allowlist. Use the read-only inspection tools for discovery. Use inspect_drawio_graph/search_drawio_elements for same-turn read-only data, then edit. After a terminal native edit is accepted, do not call another terminal tool. The accepted edit is dispatched after this model turn ends, so finish the turn with it and do not try to re-dispatch or re-confirm it. Use select_diagram_element only for pure focus. For informational questions use report_intent_outcome(answered), and ask for clarification only when the user's intent is genuinely ambiguous. Do not author/replace the saved mxfile XML directly or claim success until editor serialization and required persistence acknowledgement are complete.",
            diagram: context
          });
          await sendAttemptPreservingAcceptedIntent(2, retryPrompt, "the first response did not invoke a native editor tool");
          capturedSelection = pendingAgentSelections.get(sessionId) || null;
          capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
          capturedReportedOutcome = pendingReportedOutcomes.get(sessionId) || null;
        }
        pendingAgentSelections.delete(sessionId);
        pendingNativeEdits.delete(sessionId);
        pendingReportedOutcomes.delete(sessionId);
        pendingTerminalIntents.delete(sessionId);
        return {
          capturedSelection, capturedNativeEdits, capturedReportedOutcome, modelText,
          ...(terminalIntentModelFailure.value ? { terminalIntentModelFailure: terminalIntentModelFailure.value } : {}),
          session: turn.session,
          usage: mergeTurnUsage(usageSamples), modelCallUsages, contextUsage
        };
      });

      contextBySession.delete(sessionId);
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
        ? ["propose_native_edits"]
        : plan.capturedSelection ? ["select_diagram_element"] : [];
      const terminalIntentWarning = plan.terminalIntentModelFailure
        ? "The model stream failed after a terminal action was accepted; Studio is continuing with the accepted action and will verify the native editor result and persistence. "
        : "";
      const shared = {
        sessionId, model: plan.session.observedModel || plan.session.model,
        ...(plan.terminalIntentModelFailure ? { modelTurnWarning: plan.terminalIntentModelFailure.error } : {}),
        reasoningEffort: plan.session.reasoningEffort || "model-default",
        provider: "github-copilot-sdk", durationMs: Date.now() - startedAt, toolsUsed,
        ...(plan.usage ? { usage: plan.usage } : {}),
        ...(plan.modelCallUsages.length ? { modelCallUsages: plan.modelCallUsages } : {}),
        ...(plan.contextUsage ? { contextUsage: plan.contextUsage } : {})
      };
      const pendingXmlPatch = pendingXmlPatches.get(sessionId);
      if (pendingXmlPatch) {
        pendingXmlPatches.delete(sessionId);
        try {
          const receipt = await deps.commitWorkspaceXmlPatch!({
            patch: pendingXmlPatch.patch,
            baseRevision: pendingXmlPatch.baseRevision,
            pageId: pendingXmlPatch.pageId,
            label: "Copilot: " + pendingXmlPatch.summary
          });
          const body = receipt.body && typeof receipt.body === "object" ? receipt.body as Record<string, unknown> : {};
          if (!receipt.ok) {
            const message = typeof body.error === "string" ? body.error : "The server rejected the XML patch.";
            await deps.writeLog("turn.completed.xml-patch-failed", {
              requestId, sessionId, status: receipt.status, baseRevision: pendingXmlPatch.baseRevision, error: message
            });
            res.status(receipt.status >= 400 ? receipt.status : 409).json({
              outcome: "failed", reply: message, error: message, requestId, ...shared
            });
            return;
          }
          await deps.writeLog("turn.completed.xml-patch-committed", {
            requestId, sessionId, summary: pendingXmlPatch.summary,
            baseRevision: pendingXmlPatch.baseRevision, receipt: body
          });
          res.json({
            outcome: "xml_committed",
            reply: typeof body.workspaceRevision === "string"
              ? pendingXmlPatch.summary + "。已由服务端修改并保存原生 Draw.io XML。"
              : pendingXmlPatch.summary + "。服务端已接受 XML 修改。",
            requestId, persistence: body, ...shared
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await deps.writeLog("turn.completed.xml-patch-failed", { requestId, sessionId, error: message });
          res.status(500).json({ outcome: "failed", reply: "服务端 XML 修改失败：" + message, error: message, requestId, ...shared });
          return;
        }
      }

      if (plan.capturedNativeEdits) {
        const nativeEdits = plan.capturedNativeEdits;
        // Local single-user Studio applies native edits directly by default, scripts included.
        // STUDIO_REQUIRE_EDIT_CONFIRMATION=1 restores the proposal/review gate.
        const reviewRequired = requiresNativeEditReview() &&
          requiresExplicitConfirmation(nativeEdits.operations);
        if (reviewRequired) {
          const proposalId = randomUUID();
          await logPendingProposalSweep(prunePendingNativeProposals(Date.now(), 1), deps.writeLog);
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
            reply: terminalIntentWarning + confirmationReviewMessage(nativeEdits.operations),
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
          reply: terminalIntentWarning + nativeEdits.summary,
          selection,
          nativeEdits: { operations: nativeEdits.operations, summary: nativeEdits.summary, pageId: context.activePageId, documentRevision, requestId },
          ...shared
        };
        await deps.writeLog("turn.completed.with-native-edits", {
          requestId, sessionId, durationMs: Date.now() - startedAt,
          operationCount: nativeEdits.operations.length, summary: nativeEdits.summary,
          selection: selection ?? null, modelTurnWarning: plan.terminalIntentModelFailure ?? null,
          editReview: "auto-approved",
          operations: nativeEdits.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}) })), usage: plan.usage
        });
        res.json(response);
        return;
      }
      if (selection) {
        const response = { outcome: "selected" as const, commands: [], reply: terminalIntentWarning + (modelReply || "Selected diagram element: " + selection.label), selection, ...shared };
        await deps.writeLog("turn.completed.with-selection", { sessionId, selection, response, usage: plan.usage });
        res.json(response);
        return;
      }
      if (plan.capturedReportedOutcome) {
        const reported = plan.capturedReportedOutcome;
        await deps.writeLog("turn.completed.without-native-edit", {
          requestId, sessionId, outcome: reported.outcome, reply: reported.reply, usage: plan.usage
        });
        res.json({ ...reported, reply: terminalIntentWarning + reported.reply, ...shared });
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
      // Clarification/unsupported are model-intent outcomes and must be reported via
      // report_intent_outcome. Never infer them from SDK/runtime exception wording:
      // e.g. "model was not found" is infrastructure failure, not user ambiguity.
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

function createSelectDiagramElementTool(sessionId: string, writeLog: IntentDependencies["writeLog"]) {
  return defineTool("select_diagram_element", {
    description: "Queue a focus/selection action for one existing native Draw.io element. This is the terminal action for the turn and runs after the model turn ends; the tool result confirms only that selection was queued, not that the canvas has selected it. Use exact IDs or a unique exact label from current diagram context; do not guess.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["target"],
      additionalProperties: false
    },
    handler: async (args: { target: string }) => {
      if (typeof args?.target !== "string" || !args.target.trim() || args.target.length > 200) {
        const error = "Element selection requires a non-empty target no longer than 200 characters.";
        await writeLog("tool.select_diagram_element.rejected", { sessionId, reason: "invalid_target" });
        return {
          selected: false, accepted: false, reason: "invalid_target", error,
          instructions: "Provide a non-empty exact cell ID or unique element label from the current diagram context. No selection was queued."
        };
      }
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
        const ambiguous = matches.length > 1;
        const error = ambiguous
          ? "The element label is ambiguous; provide its exact cell ID."
          : "The element was not found in the supplied diagram context. No selection changed.";
        return {
          selected: false, accepted: false,
          reason: ambiguous ? "ambiguous_target" : "target_not_found",
          error,
          instructions: ambiguous
            ? "Use an exact ID returned for the current documentRevision, or a unique exact label."
            : "Search the current diagram using search_drawio_elements or inspect_drawio_graph; do not guess an ID."
        };
      }
      const selected = { cellId: matches[0].id, pageId: typeof source.activePageId === "string" ? source.activePageId : typeof source.selectedCell?.pageId === "string" ? source.selectedCell.pageId : null, label: typeof matches[0].name === "string" ? matches[0].name : matches[0].id };
      const registration = registerTerminalIntent(sessionId, "selection");
      if (!registration.accepted) {
        return {
          selected: false, accepted: false, reason: "terminal_action_already_registered",
          registeredKind: registration.registeredKind,
          instructions: registration.registeredKind === "native_edit"
            ? "A native edit is already queued for dispatch. Do not call another terminal tool; let that edit execute."
            : "A terminal action is already queued for dispatch. Do not call another terminal tool this turn."
        };
      }
      pendingAgentSelections.set(sessionId, selected);
      return {
        accepted: true, queued: true, execution: "after_model_turn", terminal: true,
        replaceableByNativeEdit: true, result_available: false, action: "select_diagram_element",
        ...selected, documentChanged: false,
        instructions: "The selection is queued and has not happened yet. If the user only asked to focus this element, stop here and do not claim selection succeeded before the bridge acknowledgement. If the user's request requires changing diagram content, submit exactly one native edit instead; Studio will promote that concrete edit over this provisional selection. Never submit two native edits."
      };
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
