import { useCallback, type Dispatch, type SetStateAction } from "react";
import { calculateDrawioXmlRevision, confirmAIIntentProposal, requestAIIntentPlan } from "../intent/aiProvider";
import {
  describeNativeEditOperation,
  extractNativeEditTargets,
  getNativeDiagramPageInfo,
  toNativeCellEdits,
  type NativeCellEdit,
  type NativeEditExecution
} from "../model/native-edit-operations";
import { recordDiagnostic } from "../diagnostics";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number; proposal?: { id: string; summary: string } };
type Workspace = { id: string } | null;

interface CopilotIntentOptions {
  projectWorkspace: Workspace;
  standaloneMode: boolean;
  chatInput: string;
  chatBusy: boolean;
  workspaceContentReady: boolean;
  drawioXml: string;
  aiModel: string;
  reasoningEffort: "high" | "max";
  copilotSessionId: string;
  selectedNativeCellId: string | null;
  selectedNativePageId: string | null;
  getCurrentDiagramState?: () => { drawioXml: string; selectedNativeCellId: string | null; selectedNativePageId: string | null };
  persistWorkspaceDocument?: (xml: string, label: string) => Promise<{ workspaceRevision?: string | null }>;
  setWorkspaceSetupOpen: (open: boolean) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChatInput: (value: string) => void;
  setChatBusy: (busy: boolean) => void;
  setCopilotSessionId: (id: string) => void;
  applyNativeCellEdit?: (cellId: string, path: string, value: string) => void;
  /** Executes an atomic batch and correlates its final editor/persistence result back to the server. */
  applyNativeCellEdits?: (edits: NativeCellEdit[], pageId: string | null, acknowledgement: {
    requestId: string; sessionId: string; standalone: boolean; documentRevision: string;
  }) => Promise<NativeEditExecution>;
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId, getCurrentDiagramState, persistWorkspaceDocument,
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
      const sourceSelectedCellId = requestState.selectedNativeCellId;
      const sourcePageId = requestState.selectedNativePageId;
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
      if (stateBeforeSend.drawioXml !== sourceXml || stateBeforeSend.selectedNativePageId !== sourcePageId ||
          stateBeforeSend.selectedNativeCellId !== sourceSelectedCellId) {
        throw new Error("The diagram, page, or selection changed before Copilot started. Send the request again against the current state.");
      }

      let nativeTargets: Array<{ id: string; name: string; cellType: "vertex" | "edge" }> = [];
      try {
        nativeTargets = extractNativeEditTargets(sourceXml, sourcePageId).slice(0, 200);
      } catch (error) {
        recordDiagnostic("copilot.native-context.parse-failed", "Could not index native Draw.io cells from the current XML", {
          errorMessage: error instanceof Error ? error.message : String(error), xmlLength: drawioXml.length
        }, "warn");
      }

      const nativePage = getNativeDiagramPageInfo(sourceXml, sourcePageId);
      const activePageId = nativePage.id || sourcePageId;
      const selectedTarget = nativeTargets.find((target) => target.id === sourceSelectedCellId);
      const plan = await requestAIIntentPlan(
        { model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode,
          diagramXml: sourceXml, documentRevision },
        requestText,
        {
          kind: "drawio",
          title: nativePage.title || "Draw.io diagram",
          activePageId,
          selectedCell: sourceSelectedCellId ? {
            cellId: sourceSelectedCellId, pageId: activePageId,
            label: selectedTarget?.name || sourceSelectedCellId
          } : null,
          cells: nativeTargets
        }
      );

      const stateAfterResponse = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      if (stateAfterResponse.drawioXml !== sourceXml || stateAfterResponse.selectedNativePageId !== sourcePageId ||
          (sourceSelectedCellId && stateAfterResponse.selectedNativeCellId !== sourceSelectedCellId)) {
        throw new Error("The diagram, page, or selected target changed while Copilot was responding. No edit was sent to Draw.io; retry against the current state.");
      }

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
        nativeEditCount: plan.nativeEdits?.operations.length ?? 0,
        hasSelection: Boolean(plan.selection),
        replyLength: plan.reply.length
      });

      if (plan.outcome === "proposal_required") {
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: plan.reply + "\n\n**Proposed changes:** " + plan.proposal.summary + "\n\nNo change has been applied yet. Confirm only after reviewing the listed operations.",
          proposal: { id: plan.proposal.id, summary: plan.proposal.summary }
        }]);
        return;
      }
      if (plan.outcome === "answered" || plan.outcome === "needs_clarification" ||
          plan.outcome === "unsupported" || plan.outcome === "stale_context" || plan.outcome === "failed") {
        recordDiagnostic("copilot.intent.outcome", "Copilot returned a no-mutation outcome", {
          outcome: plan.outcome, sessionId: plan.sessionId || copilotSessionId, reply: plan.reply, error: plan.error ?? null
        }, plan.outcome === "failed" || plan.outcome === "stale_context" ? "warn" : "info");
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply || plan.error || "The diagram was not changed." }]);
        return;
      }
      if (plan.outcome === "applied") {
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply }]);
        return;
      }

      if (plan.nativeEdits) {
        if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable; no change was applied.");
        if (plan.nativeEdits.documentRevision !== documentRevision || plan.nativeEdits.pageId !== activePageId) {
          throw new Error("The native edit plan is stale or targets another Draw.io page. No change was applied.");
        }
        const operations = plan.nativeEdits.operations;
        const cellPlan = toNativeCellEdits(operations, sourceXml, plan.nativeEdits.pageId);
        if (!cellPlan.ok) throw new Error("The native edit plan is invalid: " + cellPlan.error);
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
            operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" ? { newLabel: operation.newLabel } : {}) }))
          });
          setMessages((items) => [...items, {
            role: "assistant",
            id: Date.now() + 1,
            // Native edit status is derived from the editor acknowledgement, never from model-generated prose.
            text: "Applied " + operations.length + " native change" + (operations.length === 1 ? "" : "s") + ": " +
              operations.map(describeNativeEditOperation).join("; ") + "." + (execution.auditWarning ? " Warning: " + execution.auditWarning : "")
          }]);
        } else {
          const reason = failedStep?.error || execution.error || "the native editor rejected the batch";
          recordDiagnostic("copilot.native-edits.failed", "The native editor rejected an atomic Copilot edit batch", {
            operationCount: operations.length, errorMessage: reason, failedStepIndex: failedStep?.index ?? null,
            rolledBack: execution.rolledBack,
            operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" ? { newLabel: operation.newLabel } : {}) }))
          }, "error");
          setMessages((items) => [...items, {
            role: "assistant",
            id: Date.now() + 1,
            text: execution.failureStage === "persistence"
              ? "The native editor applied and serialized the change, but the workspace save was not confirmed: " + reason + ". Reload the authoritative workspace before continuing."
              : "Nothing was applied: " + describeAt((failedStep?.index ?? 1) - 1) + " failed (" + reason + "). " +
                (execution.rolledBack
                  ? "The batch was rolled back."
                  : "The native editor did not confirm a rollback; reload the diagram before continuing.")
          }]);
        }
        return;
      }

      const selection = plan.selection;
      if (selection) {
        if (!applyNativeCellEdit) throw new Error("The native Draw.io selection bridge is unavailable; the element was not selected.");
        if ((selection.pageId ?? null) !== (activePageId ?? null)) throw new Error("The selection result targets a different Draw.io page; no selection changed.");
        applyNativeCellEdit(selection.cellId, "cell:select", selection.pageId || "");
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: "Selected “" + selection.label + "”. The diagram itself was not changed."
        }]);
        return;
      }

      recordDiagnostic("copilot.native-edit.empty", "The agent returned no supported native edit; the diagram is unchanged", {
        sessionId: plan.sessionId || copilotSessionId,
        durationMs: Date.now() - startedAt
      }, "warn");
      setMessages((items) => [...items, {
        role: "assistant", id: Date.now() + 1,
        text: plan.reply || "No supported native Draw.io change was produced. The diagram is unchanged."
      }]);
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
      const pageInfo = getNativeDiagramPageInfo(sourceXml, sourcePageId);
      const nativeTargets = extractNativeEditTargets(sourceXml, pageInfo.id).slice(0, 200);
      const selectedTarget = nativeTargets.find((target) => target.id === sourceSelectedCellId);
      const requestContext = {
        kind: "drawio" as const,
        title: pageInfo.title || "Draw.io diagram",
        activePageId: pageInfo.id,
        selectedCell: sourceSelectedCellId ? {
          cellId: sourceSelectedCellId, pageId: pageInfo.id,
          label: selectedTarget?.name || sourceSelectedCellId
        } : null,
        cells: nativeTargets
      };
      const beforeConfirm = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      if (beforeConfirm.drawioXml !== sourceXml || beforeConfirm.selectedNativePageId !== sourcePageId) {
        throw new Error("The diagram or active page changed before proposal confirmation. Request a fresh proposal.");
      }
      const plan = await confirmAIIntentProposal({
        model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode,
        diagramXml: sourceXml, documentRevision
      }, proposalId, requestContext);
      const afterConfirm = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
      if (afterConfirm.drawioXml !== sourceXml || afterConfirm.selectedNativePageId !== sourcePageId) {
        throw new Error("The diagram or active page changed while confirming the proposal. No operation was sent to Draw.io.");
      }
      if (plan.outcome !== "command_ready") {
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply || "The proposal could not be confirmed; the diagram was not changed." }]);
        return;
      }
      if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable.");
      const command = plan.nativeEdits;
      if (command.documentRevision !== documentRevision || command.pageId !== (pageInfo.id ?? null)) {
        throw new Error("The confirmed command belongs to another revision or Draw.io page.");
      }
      const cellPlan = toNativeCellEdits(command.operations, sourceXml, command.pageId);
      if (!cellPlan.ok) throw new Error("The confirmed proposal is no longer valid: " + cellPlan.error);
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
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: execution.failureStage === "persistence"
            ? "The native editor applied and serialized the confirmed change, but the workspace save was not confirmed: " + reason
            : "The confirmed proposal was not applied: " + reason + (execution.rolledBack ? " The batch was rolled back." : " Reload the diagram before continuing.")
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
