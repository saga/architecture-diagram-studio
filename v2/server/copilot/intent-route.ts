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
    const readOnlyNoChange = pending.operations.some((operation) =>
      operation.op === "run_drawio_script" && operation.mode === "read"
    ) && applicationState === "not-applied" && persistenceStatus === "read_only_no_change";
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
          ...(cell.geometry && typeof cell.geometry === "object" ? { geometry: cell.geometry } : {}),
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
            enum: ["overview", "api_ownership", "shape_discovery", "script_execution", "postconditions", "recipes", "all"],
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
          return { accepted: false, reason: "invalid_reference_topic", error: "Select one supported Draw.io reference topic.", availableTopics: ["overview", "api_ownership", "shape_discovery", "script_execution", "postconditions", "recipes", "all"] };
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

  function createRunDrawioScriptTool(sessionId: string) {
    return defineTool("run_drawio_script", {
      description: "Execute a synchronous JavaScript mutation against the live native Draw.io editor. This is a terminal action that runs only after the model turn ends. Do not use mode=read for discovery: it returns no data and is rejected because deferred scripts cannot feed inspection results into the same turn. Use inspect_drawio_graph/search_drawio_elements for non-terminal read-only data, then make the requested edit. Mutation scripts require ok=true, non-empty true postconditions, and xmlAssertions for every changed cell. For label access use graph.convertValueToString(cell); model.getValue may be a UserObject DOM Element, which must be cloned and have only its label attribute updated. Independently re-scan labels for postconditions. Allowed xmlAssertions fields are cellId, exists, kind, label, labelContains, parentId, sourceId, targetId, style and geometry. These are Studio-only verifier fields, not Draw.io XML attributes. Prefer {cellId,label:fullFinalLabel} for a full-label edit; for a title embedded in a rich label use {cellId,labelContains:titleSubstring}; the host verifies that substring against serialized XML. Do not invent fields or compose IDs: cell IDs are opaque strings and must be copied verbatim. Unknown extra fields are diagnostic-only and never replace required concrete evidence. style is a non-empty key/value map, not a style string; geometry must contain explicit expected fields. The iframe is sandboxed on a separate origin; do not access the Studio parent DOM, local APIs or network side effects. Do not replace saved mxfile XML. Do not call graph.refresh(), graph.view.validate() or graph.view.getState() after mutation/endUpdate.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 1000, description: "Brief description of the inspection or requested change." },
          mode: { type: "string", enum: ["read", "mutate"], default: "mutate", description: "Use mutate for edits. read is retained only for compatibility and returns an explicit rejection with no data; use inspect_drawio_graph for same-turn inspection." },
          script: { type: "string", minLength: 1, maxLength: 50000, description: "Synchronous JavaScript source with live ui, editor, graph, model and inspectRuntime bindings. For mutate mode, return {ok:true, postconditions:{checkName:true}, xmlAssertions:[...]}; each assertion must contain cellId and concrete, host-verifiable evidence. Read labels with graph.convertValueToString(cell), not String(model.getValue(cell)); wrapped values are DOM Elements and must be cloned when editing so metadata remains intact. Re-scan independently for postconditions. Allowed fields are Studio-only xmlAssertions verifier keys, not Draw.io XML attributes: cellId, exists, kind, label, labelContains, parentId, sourceId, targetId, style, geometry. Use {cellId,label:exactFinalLabel} or {cellId,labelContains:titleSubstring} for an embedded title substring. Unknown extras are diagnostic-only and do not count as evidence. IDs are opaque: copy verbatim, never add prefixes. style must be a non-empty key/value object; geometry must contain at least one explicit field. All postcondition values must be true booleans. mode=read is compatibility-only and rejected with no execution or result; use inspect_drawio_graph for same-turn reads." }
        },
        required: ["summary", "script"],
        additionalProperties: false
      },
      handler: async (args: { summary?: unknown; script?: unknown; mode?: unknown }) => {
        if (typeof args?.summary !== "string" || !args.summary.trim() || args.summary.length > 1000) {
          return { accepted: false, terminal: false, result_available: false, reason: "invalid_summary", error: "run_drawio_script requires a summary from 1 to 1000 characters." };
        }
        if (typeof args?.script !== "string" || !args.script.trim() || args.script.length > 50000) {
          return { accepted: false, terminal: false, result_available: false, reason: "invalid_script", error: "run_drawio_script requires a non-empty JavaScript program no longer than 50000 characters." };
        }
        if (args?.mode !== undefined && args.mode !== "read" && args.mode !== "mutate") {
          return { accepted: false, terminal: false, result_available: false, reason: "invalid_mode", error: "run_drawio_script mode must be read or mutate." };
        }
        const mode = args.mode === "read" ? "read" : "mutate";
        if (mode === "read") {
          await deps.writeLog("tool.run_drawio_script.read.rejected", {
            sessionId, reason: "deferred_script_has_no_current_turn_result",
            scriptLength: args.script.length,
            documentRevision: (contextBySession.get(sessionId) as { documentRevision?: string } | undefined)?.documentRevision ?? null
          });
          return {
            accepted: false, mode: "read", result_available: false, terminal: false,
            reason: "deferred_script_has_no_current_turn_result",
            instructions: "No script was executed and no data was returned. This script tool executes only after the model turn ends. Use inspect_drawio_graph or search_drawio_elements for read-only data available in this turn, then continue with the requested edit. Do not report inspection success."
          };
        }
        const parsed = parseNativeEditOperations([{
          op: "run_drawio_script", target: "active_page", summary: args.summary, script: args.script, mode
        }]);
        if (!parsed.ok) {
          await deps.writeLog("tool.run_drawio_script.rejected", { sessionId, reason: "invalid_native_script", error: parsed.error });
          return { accepted: false, terminal: false, result_available: false, reason: "invalid_native_script", error: parsed.error, instructions: "Correct the script operation payload. No script was queued or executed." };
        }
        const resolved = resolveNativeEditTargets(contextBySession.get(sessionId) ?? null, parsed.operations);
        if (!resolved.ok) {
          await deps.writeLog("tool.run_drawio_script.rejected", { sessionId, reason: "unresolved_target", error: resolved.error });
          return { accepted: false, terminal: false, result_available: false, reason: "unresolved_target", error: resolved.error, instructions: "Use the current page context and exact native IDs or uniquely resolved labels. No script was queued or executed." };
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
        const activeContext = contextBySession.get(sessionId);
        const context = activeContext && typeof activeContext === "object"
          ? activeContext as { documentRevision?: string; activePageId?: string | null; runtimeInspection?: { drawioVersion?: string } }
          : {};
        await deps.writeLog("tool.run_drawio_script.accepted", {
          sessionId, summary, mode, script: args.script, scriptLength: args.script.length,
          documentRevision: context.documentRevision ?? null, pageId: context.activePageId ?? null,
          drawioVersion: context.runtimeInspection?.drawioVersion ?? PINNED_DRAWIO_VERSION
        });
        return {
          accepted: true, execution: "after_model_turn", summary, mode: "mutate",
          scriptLength: args.script.length, terminal: true,
          instructions: "This is the terminal editing action for this turn. The editor will execute the script after this model call ends. Return and verify postconditions plus XML assertions; do not claim success before serialization and persistence are confirmed."
        };
      }
    });
  }

  function createProposeNativeEditsTool(sessionId: string) {
    return defineTool("propose_native_edits", {
      description: "Queue one batch of common, typed native Draw.io edits such as rename, styling, move, resize, delete, simple connected-node insertion and Studio-owned automatic layout. This is a convenience fast path, not a limit on Draw.io capability. Typed set_label fails closed on rich HTML labels when plain-text replacement would flatten nested formatting or placeholders; use run_drawio_script for a markup-preserving substring edit. This is the terminal action for the turn: it is queued, not yet applied or saved. Do not call another terminal tool or claim completion after acceptance. In local single-user mode, valid batches do not require a second confirmation click; Studio still validates the revision and verifies native XML/persistence. For other graph operations use run_drawio_script; never fabricate cell IDs.",
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
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}), ...(operation.op === "run_drawio_script" ? { summary: operation.summary, scriptLength: operation.script.length } : {}),
      ...(operation.op === "auto_layout" ? { engine: operation.engine, algorithm: operation.algorithm, direction: operation.direction,
        nodeSpacing: operation.nodeSpacing, layerSpacing: operation.layerSpacing, edgeRouting: operation.edgeRouting,
        iterations: operation.iterations, randomSeed: operation.randomSeed, margin: operation.margin } : {}) }))
        });
        return {
          // This is tool feedback, not proof of editor execution/persistence.
          accepted: true, queued: true, execution: "after_model_turn", terminal: true, result_available: false,
          instructions: "The native edit intent is queued, but the diagram has not been changed or saved yet. Do not call another terminal tool or claim success. Studio will validate the current revision and dispatch the operation for native XML and persistence verification; in local single-user mode there is no second confirmation click.",
          operationCount: resolved.operations.length,
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
      toolResult: {
        toolName: "run_drawio_script" | "propose_native_edits"; success: false; error: string; stack?: string;
        rollbackConfirmed: boolean; failedPath: string;
        assertionFailures?: Array<{ kind: string; index: number | null; cellId?: string; field: string; reason: string }>;
        scopeViolations?: Array<{ kind: string; cellId: string; pageId: string | null; label: string; changedFields?: string[] }>;
      };
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
          (toolResult.stack !== undefined && (typeof toolResult.stack !== "string" || toolResult.stack.length > 8000)) ||
          (toolResult.assertionFailures !== undefined && (!Array.isArray(toolResult.assertionFailures) || toolResult.assertionFailures.length > 25)) ||
          (toolResult.scopeViolations !== undefined && (!Array.isArray(toolResult.scopeViolations) || toolResult.scopeViolations.length > 25))) {
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
          failedPath: toolResult.failedPath as string,
          ...(Array.isArray(toolResult.assertionFailures) ? {
            assertionFailures: toolResult.assertionFailures.slice(0, 25).flatMap((raw) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
              const item = raw as Record<string, unknown>;
              if (typeof item.field !== "string" || typeof item.reason !== "string" ||
                  !["invalid-result", "invalid-assertion", "invalid-document", "mismatch"].includes(String(item.kind))) return [];
              return [{
                kind: String(item.kind),
                index: typeof item.index === "number" && Number.isInteger(item.index) ? item.index : null,
                ...(typeof item.cellId === "string" ? { cellId: item.cellId.slice(0, 200) } : {}),
                field: item.field.slice(0, 120), reason: item.reason.slice(0, 400)
              }];
            })
          } : {}),
          ...(Array.isArray(toolResult.scopeViolations) ? {
            scopeViolations: toolResult.scopeViolations.slice(0, 25).flatMap((raw) => {
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
              const item = raw as Record<string, unknown>;
              if (typeof item.kind !== "string" || typeof item.cellId !== "string" ||
                  typeof item.label !== "string" || (item.pageId !== null && typeof item.pageId !== "string")) return [];
              const changedFields = Array.isArray(item.changedFields)
                ? item.changedFields.filter((field): field is string => typeof field === "string").slice(0, 20).map((field) => field.slice(0, 120))
                : undefined;
              return [{
                kind: item.kind.slice(0, 40), cellId: item.cellId.slice(0, 200),
                pageId: item.pageId as string | null, label: item.label.slice(0, 200),
                ...(changedFields?.length ? { changedFields } : {})
              }];
            })
          } : {})
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
          editingGuidance: "Prefer compact typed native operations over generated scripts when they express the requested change. For C4 diagrams, apply explicit labels with set_label and colors with set_style; each style operation changes one key (fillColor, strokeColor, or fontColor), so batch a few operations instead of writing a large script. For C4 creation, call search_drawio_shapes with `C4 directory` exactly once: it returns Person (person2), Software System, Container, the relationship edge recipe and a script skeleton. That single query is the whole discovery step — do not call get_drawio_reference and do not search again; create the requested cells and edges in one run_drawio_script call. In scripts, use graph.insertVertex/insertEdge and model-layer postcondition checks only; never call graph.refresh(), graph.view.validate(), or graph.view.getState() after a mutation or model.endUpdate(). Keep the returned evidence minimal: one xmlAssertion per cell you created or changed, at most 3 postconditions, and never assert untouched cells; xmlAssertions keys such as labelContains is a Studio-only verifier field, not a Draw.io XML attribute. Studio compares the before/after XML itself. Suggested C4 palette when the user asks for standard C4 styling: Person fill #08427B, External System fill #999999, System fill #1168BD; preserve user-edited colors and do not recolor unrelated cells. Resolve display labels with graph.convertValueToString(cell), rejecting zero or ambiguous matches. model.getValue(cell) may be a UserObject DOM Element: never String() it blindly. For a wrapped value, clone the element, update only its label attribute, and call model.setValue(cell, clone) so placeholders and metadata survive. For rich HTML labels with nested formatting/placeholders, do not use typed set_label because Studio rejects plain-text replacements that would flatten markup; use run_drawio_script to patch only the intended text. Re-scan postconditions independently via graph.convertValueToString; do not reuse the mutation's changed-count list as proof. Trust cell IDs from selectedCell, diagram.cells, or search/inspection results bound to this exact documentRevision; never reuse stale IDs. Never infer a cell is a C4 type unless the request or diagram context establishes it. Use run_drawio_script only when typed operations cannot express the change."
        });
        await sendAttemptPreservingAcceptedIntent(1, firstRequestPrompt);
        let capturedSelection = pendingAgentSelections.get(sessionId) || null;
        let capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
        let capturedReportedOutcome = pendingReportedOutcomes.get(sessionId) || null;
        if (!capturedSelection && !capturedNativeEdits && !capturedReportedOutcome) {
          await deps.writeLog("turn.native-tool-not-called", { sessionId, attempt: 1, modelText: modelText.slice(0, 2000) });
          const retryPrompt = JSON.stringify({
            request: "Finish with exactly one terminal tool call. Use propose_native_edits as a convenience fast path for simple common edits and Studio-owned auto_layout. Use run_drawio_script for non-trivial native edits or when direct Draw.io APIs are simpler; do not limit it to a typed-operation allowlist. Never use run_drawio_script(mode:read) for discovery: it is deferred and returns no data. Use inspect_drawio_graph/search_drawio_elements for same-turn read-only data, then edit. After a terminal native edit is accepted, do not call another terminal tool. No second confirmation is required in local single-user mode. Use select_diagram_element only for pure focus. For informational questions use report_intent_outcome(answered), and ask for clarification only when the user's intent is genuinely ambiguous. Do not author/replace the saved mxfile XML directly or claim success until editor serialization and required persistence acknowledgement are complete.",
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
        ? (plan.capturedNativeEdits.operations.some((operation) => operation.op === "run_drawio_script")
            ? ["run_drawio_script"] : ["propose_native_edits"])
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
      if (plan.capturedNativeEdits) {
        const nativeEdits = plan.capturedNativeEdits;
        if (requiresExplicitConfirmation(nativeEdits.operations, Boolean(context.scriptRepair))) {
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
          reply: terminalIntentWarning + (nativeEdits.operations.some((operation) => operation.op === "run_drawio_script")
            ? "执行原生 Draw.io 脚本：" + nativeEdits.summary + "。等待编辑器序列化和保存确认。"
            : nativeEdits.summary),
          selection,
          nativeEdits: { operations: nativeEdits.operations, summary: nativeEdits.summary, pageId: context.activePageId, documentRevision, requestId },
          ...shared
        };
        await deps.writeLog("turn.completed.with-native-edits", {
          requestId, sessionId, durationMs: Date.now() - startedAt,
          operationCount: nativeEdits.operations.length, summary: nativeEdits.summary,
          selection: selection ?? null, modelTurnWarning: plan.terminalIntentModelFailure ?? null,
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
