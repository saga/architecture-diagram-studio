import { useCallback, type Dispatch, type SetStateAction } from "react";
import { calculateDrawioXmlRevision, confirmAIIntentProposal, requestAIIntentPlan } from "../intent/aiProvider";
import {
  describeNativeEditOperation,
  extractNativeEditTargets,
  resolveNativePageIdentity,
  toNativeCellEdits,
  type NativeCellEdit,
  type NativeEditExecution
} from "../model/native-edit-operations";
import { recordDiagnostic } from "../diagnostics";
import { hideNativeScriptDetails } from "../intent/hide-native-script-details";
import { compareCopilotRequestContext, type CopilotRequestDiagramState } from "../model/copilot-stale-context";
import type { DrawioRuntimeInspection } from "../model/drawio-runtime-contract";
import { calculateNativeAutoLayout } from "../layout/native-layout";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number; proposal?: { id: string; summary: string; script?: string } };
type Workspace = { id: string } | null;

function assertCopilotRequestContextFresh(
  stage: string,
  source: CopilotRequestDiagramState,
  current: CopilotRequestDiagramState,
  guidance: string
): void {
  const comparison = compareCopilotRequestContext(source, current);
  if (!comparison.stale) return;

  recordDiagnostic(
    "copilot.request.stale-context",
    "Aborted a Copilot action because the source document or active page changed semantically",
    {
      stage,
      staleField: comparison.staleField,
      before: {
        pageId: source.selectedNativePageId,
        selectedCellId: source.selectedNativeCellId,
        xmlLength: source.drawioXml.length
      },
      after: {
        pageId: current.selectedNativePageId,
        selectedCellId: current.selectedNativeCellId,
        xmlLength: current.drawioXml.length
      },
      xmlChanged: comparison.xmlChanged,
      pageChanged: comparison.pageChanged,
      selectionChanged: comparison.selectionChanged,
      semanticDocumentChanged: comparison.semanticDocumentChanged,
      semanticDiffAvailable: comparison.semanticDiffAvailable,
      semanticDiffSummary: comparison.semanticDiffSummary ?? null
    },
    "warn"
  );

  const reason = comparison.staleField === "page"
    ? "The active Draw.io page changed"
    : "The diagram content changed";
  throw new Error(reason + " " + guidance);
}

function describeNativeExecutionState(execution: NativeEditExecution): string {
  if (execution.applicationState === "changed-unverified") {
    return "（文档已发生变化但未通过验证；先检查当前图，不要重试或直接恢复旧版本）";
  }
  if (execution.applicationState === "not-applied") {
    return "（未检测到文档变化）";
  }
  if (execution.applicationState === "applied-and-verified") {
    return "（图形修改已通过验证；请确认保存状态）";
  }
  if (execution.rolledBack) {
    return "（编辑器已确认回滚）";
  }
  return "（回滚状态未确认；先检查当前图和 History，不要盲目重试）";
}

interface CopilotIntentOptions {
  projectWorkspace: Workspace;
  standaloneMode: boolean;
  chatInput: string;
  chatBusy: boolean;
  workspaceContentReady: boolean;
  drawioXml: string;
  aiModel: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
  copilotSessionId: string;
  selectedNativeCellId: string | null;
  selectedNativePageId: string | null;
  getCurrentDiagramState?: () => { drawioXml: string; selectedNativeCellId: string | null; selectedNativePageId: string | null };
  /** Read-only iframe inspection, matched to the XML revision/page about to be sent to the Agent. */
  getRuntimeInspection?: (input: { documentRevision: string; pageId: string | null; jsShapeClassNames?: string[] }) => Promise<DrawioRuntimeInspection>;
  persistWorkspaceDocument?: (xml: string, label: string) => Promise<{ workspaceRevision?: string | null }>;
  onServerXmlCommitted?: () => Promise<void>;
  setWorkspaceSetupOpen: (open: boolean) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChatInput: (value: string) => void;
  setChatBusy: (busy: boolean) => void;
  setCopilotSessionId: (id: string) => void;
  applyNativeCellEdit?: (cellId: string, path: string, value: string, pageId?: string | null) => void | Promise<void>;
  /** Executes an atomic batch and correlates its final editor/persistence result back to the server. */
  applyNativeCellEdits?: (edits: NativeCellEdit[], pageId: string | null, acknowledgement: {
    requestId: string; sessionId: string; standalone: boolean; documentRevision: string;
  }) => Promise<NativeEditExecution>;
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId, getCurrentDiagramState, getRuntimeInspection, persistWorkspaceDocument, onServerXmlCommitted,
    setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy, setCopilotSessionId, applyNativeCellEdit, applyNativeCellEdits
  } = options;

  const sendIntent = useCallback(async (promptOverride?: string) => {
    if (!projectWorkspace && !standaloneMode) {
      setWorkspaceSetupOpen(true);
      return;
    }
    const requestText = (promptOverride ?? chatInput).trim();
    if (!requestText || chatBusy) return;

    const startedAt = Date.now();
    setMessages((items) => [...items, { role: "user", id: Date.now(), text: requestText }]);
    if (!promptOverride) setChatInput("");
    setChatBusy(true);

    try {
      if (!workspaceContentReady && !standaloneMode) {
        throw new Error("The Draw.io diagram has not finished loading; no Agent request was sent.");
      }

      const requestState = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      const sourceXml = requestState.drawioXml;
      let sourceSelectedCellId = requestState.selectedNativeCellId;
      let sourcePageId = requestState.selectedNativePageId;
      let documentRevision = await calculateDrawioXmlRevision(sourceXml);
      if (!standaloneMode) {
        if (!persistWorkspaceDocument) throw new Error("Workspace revision handling is unavailable; no Copilot request was sent.");
        const saved = await persistWorkspaceDocument(sourceXml, "Before Copilot request");
        if (typeof saved.workspaceRevision !== "string" || saved.workspaceRevision !== documentRevision) {
          throw new Error("The current Draw.io XML was not confirmed as the workspace revision. Reload or retry before editing.");
        }
        documentRevision = saved.workspaceRevision;
      }
      const stateBeforeSend = getCurrentDiagramState?.() ?? { drawioXml: drawioXml, selectedNativeCellId, selectedNativePageId };
      assertCopilotRequestContextFresh(
        "before-agent-request",
        { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
        stateBeforeSend,
        "before the Agent request. No request was sent; retry against the current state."
      );
      // Selection is prompt context only. Take the latest selection before assembling the Agent
      // context, but do not let a later selection change invalidate a label/ID-based edit.
      sourceSelectedCellId = stateBeforeSend.selectedNativeCellId;

      // The document declares the page identity; a bare mxGraphModel declares none, so the editor
      // UUID is only a runtime address and must never travel as the request's activePageId.
      let pageIdentity = resolveNativePageIdentity(sourceXml, sourcePageId);
      let activePageId = pageIdentity.runtimePageId;
      let runtimeInspection: DrawioRuntimeInspection | undefined;
      if (getRuntimeInspection) {
        const requestedJsShapeClassNames = new Set<string>();
        for (const match of requestText.match(/\bmxgraph(?:\.[A-Za-z0-9_-]+)+\b/gi) ?? []) {
          if (requestedJsShapeClassNames.size < 40) requestedJsShapeClassNames.add(match);
        }
        // A multi-page mxfile may arrive before the iframe's initial page-selection event has
        // reached React. Ask the live editor to identify its active page instead of rejecting a
        // valid inspection merely because the caller supplied pageId=null.
        runtimeInspection = await getRuntimeInspection({
          documentRevision, pageId: activePageId, jsShapeClassNames: [...requestedJsShapeClassNames].slice(0, 40)
        });
        if (runtimeInspection.documentRevision !== documentRevision ||
            (activePageId !== null && runtimeInspection.pageId !== activePageId)) {
          throw new Error("The live Draw.io inspection did not match the source XML revision and active page. No Agent request was sent.");
        }
        if (activePageId === null) activePageId = runtimeInspection.pageId;
        if (activePageId !== null && sourcePageId === null) sourcePageId = activePageId;
        if (activePageId === null && !pageIdentity.pageExists) {
          throw new Error("The active Draw.io page ID is not available. Wait for the editor to finish loading; no Agent request was sent.");
        }
        if (runtimeInspection.pageId !== activePageId) {
          throw new Error("The live Draw.io inspection could not establish the requested active page. No Agent request was sent.");
        }
        recordDiagnostic("copilot.native-context.active-page-resolved",
          "Resolved the active Draw.io page from the live editor because the UI selection state was not yet available",
          { pageId: activePageId, sourcePageId, documentRevision });
        const afterInspection = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
        if (afterInspection.selectedNativePageId && afterInspection.selectedNativePageId !== activePageId) {
          throw new Error("The active Draw.io page changed during runtime inspection. No Agent request was sent; retry.");
        }
        assertCopilotRequestContextFresh(
          "during-runtime-inspection",
          { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: activePageId },
          { ...afterInspection, selectedNativePageId: activePageId },
          "during runtime inspection. No Agent request was sent; retry against the current state."
        );
        sourceSelectedCellId = afterInspection.selectedNativeCellId;
      }

      let nativeTargets: Array<{ id: string; name: string; cellType: "vertex" | "edge" }> = [];
      // Re-resolve once the editor has confirmed the active page: the request carries the document
      // identity, which is null for a bare mxGraphModel.
      pageIdentity = resolveNativePageIdentity(sourceXml, activePageId);
      const requestPageId = pageIdentity.documentPageId;
      try {
        nativeTargets = extractNativeEditTargets(sourceXml, requestPageId);
      } catch (error) {
        recordDiagnostic("copilot.native-context.parse-failed", "Could not index native Draw.io cells from the current XML", {
          errorMessage: error instanceof Error ? error.message : String(error), xmlLength: sourceXml.length,
          requestedPageId: requestPageId, runtimePageId: runtimeInspection?.pageId ?? null
        }, "error");
        throw new Error("Could not read cells from the active Draw.io page: " +
          (error instanceof Error ? error.message : String(error)) + ". No Agent request was sent.");
      }
      let selectedTarget = nativeTargets.find((target) => target.id === sourceSelectedCellId);
      const getStateForResolvedPage = () => {
        const state = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
        return state.selectedNativePageId || !activePageId
          ? state
          : { ...state, selectedNativePageId: activePageId };
      };
      const plan = await requestAIIntentPlan(
        { model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode,
          diagramXml: sourceXml, documentRevision },
        requestText,
        {
          kind: "drawio",
          title: pageIdentity.title || "Draw.io diagram",
          activePageId: requestPageId,
          selectedCell: sourceSelectedCellId ? {
            cellId: sourceSelectedCellId, pageId: requestPageId,
            label: selectedTarget?.name || ""
          } : null,
          cells: nativeTargets,
          ...(runtimeInspection ? { runtimeInspection } : {})
        }
      );

      const stateAfterResponse = getStateForResolvedPage();
      assertCopilotRequestContextFresh(
        "during-agent-response",
        { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
        stateAfterResponse,
        "while Copilot was responding. No edit was sent to Draw.io; retry against the current state."
      );

      if (plan.sessionId && plan.sessionId !== copilotSessionId) {
        setCopilotSessionId(plan.sessionId);
        try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", plan.sessionId); }
        catch { /* The active session is still held in memory. */ }
      }

      recordDiagnostic("copilot.agent.response", "Received a validated Copilot intent outcome", {
        sessionId: plan.sessionId || copilotSessionId,
        provider: plan.provider || "github-copilot-sdk",
        model: plan.model || aiModel.trim() || "server-default",
        durationMs: plan.durationMs,
        outcome: plan.outcome,
        nativeEditCount: plan.outcome === "command_ready" ? plan.nativeEdits.operations.length : 0,
        hasSelection: plan.outcome === "selected" || (plan.outcome === "command_ready" && Boolean(plan.selection)),
        replyLength: plan.reply.length
      });

      if (plan.outcome === "proposal_required") {
        const safeReply = hideNativeScriptDetails(plan.reply);
        const safeSummary = hideNativeScriptDetails(plan.proposal.summary);
        // The executable script is deliberately kept out of the chat transcript: it is long, it is
        // not what the user asked for, and the sanitizer is a safety net rather than a formatter.
        // Never embed the script here; expose it through a dedicated review affordance instead.
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: (safeReply || "A diagram change is ready for review.") +
            "\n\n**Proposed changes:** " + (safeSummary || "Apply the proposed diagram changes.") +
            "\n\nNothing has been changed yet. Confirm to apply this proposal to the current diagram.",
          proposal: { id: plan.proposal.id, summary: safeSummary || "Apply the proposed diagram changes." }
        }]);
        return;
      }
      if (plan.outcome === "answered" || plan.outcome === "needs_clarification" ||
          plan.outcome === "unsupported" || plan.outcome === "stale_context" || plan.outcome === "failed") {
        const failure = "error" in plan ? plan.error : undefined;
        recordDiagnostic("copilot.intent.outcome", "Copilot returned a no-mutation outcome", {
          outcome: plan.outcome, sessionId: plan.sessionId || copilotSessionId, reply: plan.reply, error: failure ?? null
        }, plan.outcome === "failed" || plan.outcome === "stale_context" ? "warn" : "info");
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply || failure || "The diagram was not changed." }]);
        return;
      }
      if (plan.outcome === "xml_committed") {
        if (!onServerXmlCommitted) throw new Error("The server committed the XML edit, but Studio has no document-refresh handler.");
        await onServerXmlCommitted();
        recordDiagnostic("copilot.xml-edit.refreshed", "Reloaded the server-committed Draw.io XML revision", {
          requestId: plan.requestId, workspaceRevision: plan.persistence.workspaceRevision
        });
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply }]);
        return;
      }
      if (plan.outcome === "applied") {
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply }]);
        return;
      }

      if (plan.outcome === "command_ready") {
        if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable; no change was applied.");
        if (plan.nativeEdits.documentRevision !== documentRevision || plan.nativeEdits.pageId !== requestPageId) {
          throw new Error("The native edit plan is stale or targets another Draw.io page. No change was applied.");
        }
        const operations = plan.nativeEdits.operations;
        const layoutOperation = operations.length === 1 && operations[0].op === "auto_layout" ? operations[0] : undefined;
        // The layout plan is applied by the live editor and must carry the runtime page identity;
        // a bare mxGraphModel has no declared page ID but still has an editor page.
        const layoutPageId = pageIdentity.runtimePageId ?? plan.nativeEdits.pageId;
        const layoutPlan = layoutOperation
          ? await calculateNativeAutoLayout(sourceXml, layoutPageId, documentRevision, layoutOperation, layoutOperation.anchorCellIds)
          : undefined;
        if (layoutOperation) {
          const currentState = getStateForResolvedPage();
          assertCopilotRequestContextFresh(
            "during-layout-calculation",
            { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
            currentState,
            "while Studio was calculating the layout. Nothing was applied; retry."
          );
        }
        const cellPlan = toNativeCellEdits(operations, sourceXml, layoutPageId, layoutPlan);
        if (!cellPlan.ok) throw new Error("The native edit plan is invalid: " + cellPlan.error);
        // Bind the dispatch to the page that was inspected for this turn. The editor bridge
        // performs its own final page guard, but this catches page switches before queueing work.
        if (getRuntimeInspection) {
          const runtimeBeforeDispatch = await getRuntimeInspection({ documentRevision, pageId: activePageId });
          if (runtimeBeforeDispatch.documentRevision !== documentRevision ||
              runtimeBeforeDispatch.pageId !== activePageId) {
            throw new Error("The active Draw.io page changed before the native edit could be dispatched. No change was applied; retry.");
          }
        }
        const execution = await applyNativeCellEdits(cellPlan.edits, plan.nativeEdits.pageId, {
          requestId: plan.nativeEdits.requestId,
          sessionId: plan.sessionId || copilotSessionId,
          standalone: standaloneMode,
          documentRevision
        });
        const describeAt = (stepIndex: number) => {
          let cursor = 0;
          for (const operation of operations) {
            const width = 1;
            if (stepIndex < cursor + width) return describeNativeEditOperation(operation);
            cursor += width;
          }
          return "step " + (stepIndex + 1);
        };
        const failedStep = execution.steps.find((step) => !step.success);
        if (execution.ok) {
          recordDiagnostic("copilot.native-edits.applied", "The native editor applied an atomic Copilot edit batch", {
            operationCount: operations.length,
            steps: execution.steps.length,
            operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}) }))
          });
          setMessages((items) => [...items, {
            role: "assistant",
            id: Date.now() + 1,
            // Native edit status is derived from the editor acknowledgement, never from model-generated prose.
            text: scriptVerifiedNoChange
              ? "Verified the requested native state against the serialized XML; the diagram was already in that state, so no semantic change was made: " +
                operations.map(describeNativeEditOperation).join("; ") + "."
              : "Applied " + operations.length + " native change" + (operations.length === 1 ? "" : "s") + ": " +
                operations.map(describeNativeEditOperation).join("; ") + "." + (execution.auditWarning ? " Warning: " + execution.auditWarning : "")
          }]);
        } else {
          const reason = failedStep?.error || execution.error || "the native editor rejected the batch";
          recordDiagnostic("copilot.native-edits.failed", "The native edit did not reach a verified successful outcome", {
            operationCount: operations.length, errorMessage: reason, failedStepIndex: failedStep?.index ?? null,
            rolledBack: execution.rolledBack, applicationState: execution.applicationState ?? null,
            operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}) }))
          }, "error");
          const failureMessage =
            execution.applicationState === "changed-unverified"
              ? "The diagram has changed, but the requested edit was not verified: " + reason +
                (execution.failureStage === "persistence" ? " Saving the resulting XML also failed." : "") +
                "\n\nDo not retry this edit yet; inspect the current diagram and History first to avoid duplicating a message or other element."
              : execution.applicationState === "unknown"
                ? "The native edit outcome is unknown: " + reason +
                  (execution.failureStage === "persistence" ? " Saving the available XML also failed." : "") +
                  "\n\nDo not retry this edit yet; inspect the current diagram and History first."
                : execution.failureStage === "persistence"
                  ? "The native editor applied and serialized the change, but the workspace save was not confirmed: " + reason + ". Reload the authoritative workspace before continuing."
                  : execution.applicationState === "not-applied"
                    ? "No document change was detected for this edit: " + reason +
                      (execution.rolledBack ? " The batch was rolled back." : " Inspect the current diagram before retrying.")
                    : execution.rolledBack
                      ? "Nothing was applied: " + describeAt((failedStep?.index ?? 1) - 1) + " failed (" + reason + "). The batch was rolled back."
                      : "The native edit failed (" + reason + "), and rollback was not confirmed. The current diagram may contain partial changes; inspect it and History before retrying.";
          setMessages((items) => [...items, {
            role: "assistant",
            id: Date.now() + 1,
            text: failureMessage
          }]);
        }
        return;
      }

      if (plan.outcome === "selected") {
        const selection = plan.selection;
        if (!applyNativeCellEdit) throw new Error("The native Draw.io selection bridge is unavailable; the element was not selected.");
        if ((selection.pageId ?? null) !== (activePageId ?? null)) throw new Error("The selection result targets a different Draw.io page; no selection changed.");
        await applyNativeCellEdit(selection.cellId, "cell:select", "", selection.pageId);
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: "Selected “" + selection.label + "”. The diagram itself was not changed."
        }]);
        return;
      }

      const unreachableOutcome: never = plan;
      throw new Error("Unhandled Copilot intent outcome: " + String(unreachableOutcome));
    } catch (error) {
      recordDiagnostic("copilot.request.failed", "Native Draw.io Copilot request failed; no edit was confirmed", {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        sessionId: copilotSessionId,
        model: aiModel.trim() || "server-default",
        standaloneMode,
        userRequest: requestText
      }, "error");
      setMessages((items) => [...items, {
        role: "assistant", id: Date.now() + 2,
        text: "Nothing was confirmed as changed: " + (error instanceof Error ? error.message : String(error))
      }]);
    } finally {
      recordDiagnostic("copilot.request.finished", "Native Draw.io Copilot request finished", {
        durationMs: Date.now() - startedAt, busy: false
      });
      setChatBusy(false);
    }
  }, [
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId, getCurrentDiagramState, persistWorkspaceDocument,
    setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy, setCopilotSessionId, applyNativeCellEdit, applyNativeCellEdits
  ]);

  const confirmProposal = useCallback(async (proposalId: string) => {
    if (chatBusy || !proposalId) return;
    setChatBusy(true);
    setMessages((items) => items.map((message) => message.proposal?.id === proposalId
      ? { ...message, proposal: undefined, text: message.text + "\n\nConfirmation submitted; validating the current diagram revision…" }
      : message));
    try {
      if (!workspaceContentReady && !standaloneMode) throw new Error("The Draw.io diagram has not finished loading; proposal confirmation was not sent.");
      const requestState = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      const sourceXml = requestState.drawioXml;
      const sourcePageId = requestState.selectedNativePageId;
      const sourceSelectedCellId = requestState.selectedNativeCellId;
      let documentRevision = await calculateDrawioXmlRevision(sourceXml);
      if (!standaloneMode) {
        if (!persistWorkspaceDocument) throw new Error("Workspace revision handling is unavailable.");
        const saved = await persistWorkspaceDocument(sourceXml, "Before confirming Copilot proposal");
        if (typeof saved.workspaceRevision !== "string" || saved.workspaceRevision !== documentRevision) {
          throw new Error("The current XML was not confirmed as the workspace revision. Reload and request a fresh proposal.");
        }
        documentRevision = saved.workspaceRevision;
      }
      let pageIdentity = resolveNativePageIdentity(sourceXml, sourcePageId);
      let activePageId = pageIdentity.runtimePageId;
      if (getRuntimeInspection) {
        const runtimeInspection = await getRuntimeInspection({ documentRevision, pageId: activePageId });
        if (runtimeInspection.documentRevision !== documentRevision ||
            (activePageId !== null && runtimeInspection.pageId !== activePageId)) {
          throw new Error("The live Draw.io inspection did not match the proposal's source revision and page. Confirmation was not sent.");
        }
        activePageId = runtimeInspection.pageId;
      }
      if (!activePageId && !pageIdentity.pageExists) {
        throw new Error("The active Draw.io page ID is not available. Select a page and retry confirming this proposal.");
      }
      pageIdentity = resolveNativePageIdentity(sourceXml, activePageId);
      // An mxfile must still prove that the runtime page exists; a bare model has exactly one page
      // and no declared ID, so the editor's UUID is authoritative by definition.
      if (!pageIdentity.pageExists) throw new Error("The proposal's target page was not found in the source XML.");
      const requestPageId = pageIdentity.documentPageId;
      const nativeTargets = extractNativeEditTargets(sourceXml, requestPageId);
      const selectedTarget = nativeTargets.find((target) => target.id === sourceSelectedCellId);
      const requestContext = {
        kind: "drawio" as const,
        title: pageIdentity.title || "Draw.io diagram",
        activePageId: requestPageId,
        selectedCell: sourceSelectedCellId ? {
          cellId: sourceSelectedCellId, pageId: requestPageId,
          label: selectedTarget?.name || ""
        } : null,
        cells: nativeTargets
      };
      const beforeConfirm = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      assertCopilotRequestContextFresh(
        "before-proposal-confirmation",
        { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
        beforeConfirm,
        "before proposal confirmation. Request a fresh proposal."
      );
      const plan = await confirmAIIntentProposal({
        model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode,
        diagramXml: sourceXml, documentRevision
      }, proposalId, requestContext);
      const afterConfirm = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      assertCopilotRequestContextFresh(
        "during-proposal-confirmation",
        { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
        afterConfirm,
        "while confirming the proposal. No operation was sent to Draw.io."
      );
      if (plan.outcome !== "command_ready") {
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply || "The proposal could not be confirmed; the diagram was not changed." }]);
        return;
      }
      if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable.");
      const command = plan.nativeEdits;
      if (command.documentRevision !== documentRevision || command.pageId !== requestPageId) {
        throw new Error("The confirmed command belongs to another revision or Draw.io page.");
      }
      const layoutOperation = command.operations.length === 1 && command.operations[0].op === "auto_layout"
        ? command.operations[0] : undefined;
      // The editor applies the plan, so it must carry the runtime page identity rather than the
      // document identity that is null for a bare mxGraphModel.
      const layoutPageId = pageIdentity.runtimePageId ?? command.pageId;
      const layoutPlan = layoutOperation
        ? await calculateNativeAutoLayout(sourceXml, layoutPageId, documentRevision, layoutOperation, layoutOperation.anchorCellIds)
        : undefined;
      if (layoutOperation) {
        const stateAfterLayout = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
        assertCopilotRequestContextFresh(
          "during-confirmed-layout-calculation",
          { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
          stateAfterLayout,
          "while Studio was calculating the confirmed layout. Nothing was applied; retry."
        );
      }
      const cellPlan = toNativeCellEdits(command.operations, sourceXml, layoutPageId, layoutPlan);
      if (!cellPlan.ok) throw new Error("The confirmed proposal is no longer valid: " + cellPlan.error);
      if (getRuntimeInspection) {
        const runtimeBeforeDispatch = await getRuntimeInspection({ documentRevision, pageId: activePageId });
        if (runtimeBeforeDispatch.documentRevision !== documentRevision ||
            runtimeBeforeDispatch.pageId !== activePageId) {
          throw new Error("The active Draw.io page changed before the confirmed proposal could be dispatched. No change was applied.");
        }
      }
      const execution = await applyNativeCellEdits(cellPlan.edits, command.pageId, {
        requestId: command.requestId,
        sessionId: plan.sessionId || copilotSessionId,
        standalone: standaloneMode,
        documentRevision
      });
      if (execution.ok) {
        recordDiagnostic("copilot.proposal.confirmed.applied", "A confirmed native edit proposal was applied", {
          proposalId, requestId: command.requestId, operationCount: command.operations.length
        });
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: "Applied " + command.operations.length + " native change" + (command.operations.length === 1 ? "" : "s") +
            ": " + command.operations.map(describeNativeEditOperation).join("; ") + "." +
            (execution.auditWarning ? " Warning: " + execution.auditWarning : "")
        }]);
      } else {
        const reason = execution.error || "the native editor rejected the batch";
        const state = execution.applicationState;
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: execution.failureStage === "persistence"
            ? "The native editor applied and serialized the confirmed change, but the workspace save was not confirmed: " + reason
            : state === "changed-unverified"
              // The document did change and was saved; only Studio's evidence check failed. Saying
              // "not applied" here contradicts the reason string and sends the user to undo work
              // that is actually correct.
              ? "The change was applied and saved, but Studio could not verify it: " + reason +
                " Do not retry; inspect the current diagram and History first."
              : state === "not-applied"
                ? "The confirmed proposal was not applied: " + reason + (execution.rolledBack ? " The batch was rolled back." : "")
                : "The confirmed proposal produced an uncertain document state: " + reason +
                  (execution.rolledBack ? " The batch was rolled back." : " Reload the diagram before continuing.")
        }]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordDiagnostic("copilot.proposal.confirmation.failed", "A native edit proposal could not be confirmed", { proposalId, errorMessage: message }, "error");
      setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: "Proposal not applied: " + message }]);
    } finally {
      setChatBusy(false);
    }
  }, [
    chatBusy, workspaceContentReady, standaloneMode, drawioXml, selectedNativeCellId, selectedNativePageId,
    getCurrentDiagramState, persistWorkspaceDocument, aiModel, reasoningEffort, copilotSessionId,
    applyNativeCellEdits, setChatBusy, setMessages
  ]);

  return { sendIntent, confirmProposal };
}
