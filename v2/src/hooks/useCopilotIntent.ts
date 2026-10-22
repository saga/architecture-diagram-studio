import { useCallback, type Dispatch, type SetStateAction } from "react";
import { requestAIIntentPlan } from "../intent/aiProvider";
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
  setWorkspaceSetupOpen: (open: boolean) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChatInput: (value: string) => void;
  setChatBusy: (busy: boolean) => void;
  setCopilotSessionId: (id: string) => void;
  applyNativeCellEdit?: (cellId: string, path: string, value: string) => void;
  /** Executes one atomic batch in Draw.io and resolves only after editor acknowledgement. */
  applyNativeCellEdits?: (edits: NativeCellEdit[]) => Promise<NativeEditExecution>;
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId, setWorkspaceSetupOpen, setMessages, setChatInput,
    setChatBusy, setCopilotSessionId, applyNativeCellEdit, applyNativeCellEdits
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

      let nativeTargets: Array<{ id: string; name: string; cellType: "vertex" | "edge" }> = [];
      try {
        nativeTargets = extractNativeEditTargets(drawioXml, selectedNativePageId).slice(0, 200);
      } catch (error) {
        recordDiagnostic("copilot.native-context.parse-failed", "Could not index native Draw.io cells from the current XML", {
          errorMessage: error instanceof Error ? error.message : String(error), xmlLength: drawioXml.length
        }, "warn");
      }

      const nativePage = getNativeDiagramPageInfo(drawioXml, selectedNativePageId);
      const activePageId = nativePage.id || selectedNativePageId;
      const selectedTarget = nativeTargets.find((target) => target.id === selectedNativeCellId);
      const plan = await requestAIIntentPlan(
        { model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode },
        requestText,
        {
          kind: "drawio",
          title: nativePage.title || "Draw.io diagram",
          activePageId,
          selectedCell: selectedNativeCellId ? {
            cellId: selectedNativeCellId, pageId: activePageId,
            label: selectedTarget?.name || selectedNativeCellId
          } : null,
          cells: nativeTargets
        }
      );

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
        const operations = plan.nativeEdits.operations;
        const cellPlan = toNativeCellEdits(operations, drawioXml, selectedNativePageId);
        if (!cellPlan.ok) throw new Error("The native edit plan is invalid: " + cellPlan.error);
        const execution = await applyNativeCellEdits(cellPlan.edits);
        const describeAt = (stepIndex: number) => {
          let cursor = 0;
          for (const operation of operations) {
            const width = operation.op === "move" ? 2 : 1;
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
              operations.map(describeNativeEditOperation).join("; ") + "."
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
            text: "Nothing was applied: " + describeAt((failedStep?.index ?? 1) - 1) + " failed (" + reason + "). " +
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
    copilotSessionId, selectedNativeCellId, selectedNativePageId, setWorkspaceSetupOpen, setMessages, setChatInput,
    setChatBusy, setCopilotSessionId, applyNativeCellEdit, applyNativeCellEdits
  ]);
}
