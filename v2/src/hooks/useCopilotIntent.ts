import { useCallback, type Dispatch, type SetStateAction } from "react";
import { calculateDrawioXmlRevision, requestAIIntentPlan } from "../intent/aiProvider";
import {
  describeNativeEditOperation,
  extractNativeEditTargets,
  getNativeDiagramPageInfo,
  toNativeCellEdits,
  type NativeCellEdit,
  type NativeEditExecution
} from "../model/native-edit-operations";
import { recordDiagnostic } from "../diagnostics";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
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

  return useCallback(async (promptOverride?: string) => {
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

      recordDiagnostic("copilot.agent.response", "Received a native Draw.io operation response", {
        sessionId: plan.sessionId || copilotSessionId,
        provider: plan.provider || "github-copilot-sdk",
        model: plan.model || aiModel.trim() || "server-default",
        durationMs: plan.durationMs,
        nativeEditCount: plan.nativeEdits?.operations.length ?? 0,
        hasSelection: Boolean(plan.selection),
        replyLength: plan.reply.length
      });

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
}
