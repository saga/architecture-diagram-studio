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
import { hideNativeScriptDetails } from "../intent/hide-native-script-details";
import type { DrawioRuntimeInspection } from "../model/drawio-runtime-contract";
import { calculateNativeAutoLayout } from "../layout/native-layout";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number; proposal?: { id: string; summary: string; script?: string } };
type Workspace = { id: string } | null;

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
  reasoningEffort: "high" | "max";
  copilotSessionId: string;
  selectedNativeCellId: string | null;
  selectedNativePageId: string | null;
  getCurrentDiagramState?: () => { drawioXml: string; selectedNativeCellId: string | null; selectedNativePageId: string | null };
  /** Read-only iframe inspection, matched to the XML revision/page about to be sent to the Agent. */
  getRuntimeInspection?: (input: { documentRevision: string; pageId: string | null; jsShapeClassNames?: string[] }) => Promise<DrawioRuntimeInspection>;
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
    copilotSessionId, selectedNativeCellId, selectedNativePageId, getCurrentDiagramState, getRuntimeInspection, persistWorkspaceDocument,
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
      let runtimeInspection: DrawioRuntimeInspection | undefined;
      if (getRuntimeInspection) {
        const requestedJsShapeClassNames = new Set<string>();
        for (const match of requestText.match(/\bmxgraph(?:\.[A-Za-z0-9_-]+)+\b/gi) ?? []) {
          if (requestedJsShapeClassNames.size < 40) requestedJsShapeClassNames.add(match);
        }
        runtimeInspection = await getRuntimeInspection({
          documentRevision, pageId: activePageId, jsShapeClassNames: [...requestedJsShapeClassNames].slice(0, 40)
        });
        if (runtimeInspection.documentRevision !== documentRevision || runtimeInspection.pageId !== activePageId) {
          throw new Error("The live Draw.io inspection did not match the source XML revision and active page. No Agent request was sent.");
        }
        const afterInspection = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
        if (afterInspection.drawioXml !== sourceXml || afterInspection.selectedNativePageId !== sourcePageId ||
            afterInspection.selectedNativeCellId !== sourceSelectedCellId) {
          throw new Error("The diagram, page, or selection changed during runtime inspection. No Agent request was sent; retry against the current state.");
        }
      }
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
            label: selectedTarget?.name || ""
          } : null,
          cells: nativeTargets,
          ...(runtimeInspection ? { runtimeInspection } : {})
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
        nativeEditCount: plan.outcome === "command_ready" ? plan.nativeEdits.operations.length : 0,
        hasSelection: plan.outcome === "selected" || (plan.outcome === "command_ready" && Boolean(plan.selection)),
        replyLength: plan.reply.length
      });

      if (plan.outcome === "proposal_required") {
        const safeReply = hideNativeScriptDetails(plan.reply);
        const safeSummary = hideNativeScriptDetails(plan.proposal.summary);
        const scriptOperation = plan.proposal.operations.find((operation) => operation.op === "run_drawio_script");
        const reviewScript = scriptOperation?.op === "run_drawio_script" ? scriptOperation.script : undefined;
        setMessages((items) => [...items, {
          role: "assistant", id: Date.now() + 1,
          text: (safeReply || "A diagram change is ready for review.") +
            "\n\n**Proposed changes:** " + (safeSummary || "Apply the proposed diagram changes.") +
            (reviewScript ? "\n\n原生 Draw.io 脚本（完整内容）：\n" + reviewScript +
              "\n\n只有实际结果检查全部通过并且序列化 XML 符合预期，才会确认成功。" : "") +
            "\n\nNothing has been changed yet. Confirm to apply this proposal to the current diagram.",
          proposal: { id: plan.proposal.id, summary: safeSummary || "Apply the proposed diagram changes.", ...(reviewScript ? { script: reviewScript } : {}) }
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
      if (plan.outcome === "applied") {
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply }]);
        return;
      }

      if (plan.outcome === "command_ready") {
        if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable; no change was applied.");
        if (plan.nativeEdits.documentRevision !== documentRevision || plan.nativeEdits.pageId !== activePageId) {
          throw new Error("The native edit plan is stale or targets another Draw.io page. No change was applied.");
        }
        const operations = plan.nativeEdits.operations;
        const layoutOperation = operations.length === 1 && operations[0].op === "auto_layout" ? operations[0] : undefined;
        const layoutPlan = layoutOperation
          ? await calculateNativeAutoLayout(sourceXml, plan.nativeEdits.pageId, documentRevision, layoutOperation)
          : undefined;
        if (layoutOperation) {
          const currentState = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
          if (currentState.drawioXml !== sourceXml || currentState.selectedNativePageId !== sourcePageId) {
            throw new Error("The diagram or active page changed while Studio was calculating the layout. Nothing was applied; retry.");
          }
        }
        const cellPlan = toNativeCellEdits(operations, sourceXml, plan.nativeEdits.pageId, layoutPlan);
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
            scriptResult: execution.scriptResult ?? null,
            operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, targetLabel: operation.targetLabel, ...(operation.op === "set_label" ? { label: operation.label } : {}), ...(operation.op === "add_node_after" || operation.op === "add_node_below" ? { newLabel: operation.newLabel } : {}) }))
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
          const failedScriptOperation = operations.find((operation) => operation.op === "run_drawio_script");
          const scriptRuntimeError = failedStep?.path === "cell:execute-script" &&
            typeof failedStep.error === "string" &&
            failedStep.error.trim().length > 0;
          const repairState = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
          const shouldTryScriptRepair = Boolean(
            failedScriptOperation &&
            scriptRuntimeError &&
            execution.rolledBack &&
            failedScriptOperation.op === "run_drawio_script" &&
            failedScriptOperation.script.length <= 12_000 &&
            requestText.length <= 1_500 &&
            getRuntimeInspection &&
            runtimeInspection &&
            repairState.drawioXml === sourceXml &&
            repairState.selectedNativePageId === sourcePageId &&
            repairState.selectedNativeCellId === sourceSelectedCellId
          );
          if (shouldTryScriptRepair && failedScriptOperation?.op === "run_drawio_script") {
            const boundedError = (failedStep?.error || reason).slice(0, 1200);
            recordDiagnostic("copilot.native-script-repair.started", "Starting one automatic native script repair attempt after an editor-reported script failure and confirmed rollback", {
              sessionId: plan.sessionId || copilotSessionId,
              error: boundedError,
              errorStack: failedStep?.stack?.slice(0, 8000) ?? null,
              scriptLength: failedScriptOperation.script.length,
              rollbackConfirmed: execution.rolledBack,
              documentRevision,
              pageId: activePageId
            }, "warn");
            setMessages((items) => [...items, {
              role: "assistant",
              id: Date.now() + 1,
              text: "原生脚本执行失败（" + boundedError + "），编辑器已确认回滚。正在自动修正并重试 1/1。"
            }]);
            try {
              const repairPlan = await requestAIIntentPlan({
                model: aiModel,
                reasoningEffort,
                sessionId: plan.sessionId || copilotSessionId,
                standalone: standaloneMode,
                diagramXml: sourceXml,
                documentRevision
              }, "Automatically repair the failed native Draw.io script described in scriptRepair. Preserve the original user request and active-page scope. Use the exact editor error and runtime inspection to correct the actual failure; do not merely repeat the failed script unchanged. Return one corrected action by calling the dedicated run_drawio_script tool directly. There is no script allowlist or confirmation gate in local single-user mode. Do not claim the edit has been applied until the native editor returns the script result and the resulting XML/persistence acknowledgement succeeds.", {
                kind: "drawio",
                title: nativePage.title || "Draw.io diagram",
                activePageId,
                selectedCell: sourceSelectedCellId ? {
                  cellId: sourceSelectedCellId, pageId: activePageId,
                  label: selectedTarget?.name || ""
                } : null,
                cells: nativeTargets,
                ...(runtimeInspection ? { runtimeInspection } : {}),
                scriptRepair: {
                  originalRequest: requestText,
                  failedScript: failedScriptOperation.script,
                  error: boundedError,
                  ...(failedStep?.stack ? { stack: failedStep.stack.slice(0, 8000) } : {})
                }
              });
              if (repairPlan.outcome === "command_ready") {
                const command = repairPlan.nativeEdits;
                if (command.documentRevision !== documentRevision || command.pageId !== activePageId) {
                  throw new Error("The repaired script targets a stale revision or a different Draw.io page.");
                }
                const repairCellPlan = toNativeCellEdits(command.operations, sourceXml, command.pageId);
                if (!repairCellPlan.ok) throw new Error("The repaired script is invalid: " + repairCellPlan.error);
                if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable for script repair.");
                const repairedExecution = await applyNativeCellEdits(repairCellPlan.edits, command.pageId, {
                  requestId: command.requestId,
                  sessionId: repairPlan.sessionId || plan.sessionId || copilotSessionId,
                  standalone: standaloneMode,
                  documentRevision
                });
                if (repairedExecution.ok) {
                  recordDiagnostic("copilot.native-script-repair.applied", "The single corrected native script was automatically dispatched and acknowledged", {
                    sessionId: repairPlan.sessionId || plan.sessionId || copilotSessionId,
                    requestId: command.requestId,
                    operationCount: command.operations.length,
                    scriptResult: repairedExecution.scriptResult ?? null,
                    documentRevision,
                    pageId: activePageId
                  });
                  setMessages((items) => [...items, {
                    role: "assistant",
                    id: Date.now() + 1,
                    text: "自动修正已应用：" + command.operations.map(describeNativeEditOperation).join("；") + "。" +
                      (repairedExecution.auditWarning ? " 警告：" + repairedExecution.auditWarning : "")
                  }]);
                } else {
                  const repairReason = repairedExecution.error || "Draw.io rejected the repaired script.";
                  recordDiagnostic("copilot.native-script-repair.apply-failed", "The automatically dispatched corrected script was not acknowledged as applied", {
                    sessionId: repairPlan.sessionId || plan.sessionId || copilotSessionId,
                    requestId: command.requestId,
                    errorMessage: repairReason,
                    failureStage: repairedExecution.failureStage ?? null,
                    rolledBack: repairedExecution.rolledBack,
                    scriptResult: repairedExecution.scriptResult ?? null
                  }, "error");
                  setMessages((items) => [...items, {
                    role: "assistant",
                    id: Date.now() + 1,
                    text: repairedExecution.failureStage === "persistence"
                      ? "自动修正已在编辑器执行，但保存未获确认：" + repairReason + "。请检查当前图和实际文件；不要盲目重试或直接恢复版本。"
                      : "自动修正未成功：" + repairReason + describeNativeExecutionState(repairedExecution)
                  }]);
                }
                return;
              }

              // The AI-first runtime does not turn a corrected script into a manual approval proposal.
              // A repair request must call run_drawio_script and return a command_ready receipt.
              recordDiagnostic("copilot.native-script-repair.no-command", "The repair turn did not return an executable native script command", {
                sessionId: plan.sessionId || copilotSessionId,
                outcome: repairPlan.outcome,
                reply: repairPlan.reply.slice(0, 400),
                documentRevision
              }, "warn");
              setMessages((items) => [...items, {
                role: "assistant",
                id: Date.now() + 1,
                text: "自动修正没有返回可执行的脚本命令；未进行第二次执行。原编辑失败：" + reason +
                  describeNativeExecutionState(execution)
              }]);
              return;
            } catch (repairError) {
              const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
              recordDiagnostic("copilot.native-script-repair.failed", "The single bounded repair request failed; no automatic re-execution occurred", {
                sessionId: plan.sessionId || copilotSessionId,
                error: repairMessage.slice(0, 1200),
                documentRevision
              }, "warn");
              setMessages((items) => [...items, {
                role: "assistant",
                id: Date.now() + 1,
                text: "自动修正尝试失败，未执行第二次脚本：" + repairMessage +
                  "\n\n原编辑失败：" + reason + describeNativeExecutionState(execution)
              }]);
              return;
            }
          }
          recordDiagnostic("copilot.native-edits.failed", "The native edit did not reach a verified successful outcome", {
            operationCount: operations.length, errorMessage: reason, failedStepIndex: failedStep?.index ?? null,
            rolledBack: execution.rolledBack, applicationState: execution.applicationState ?? null,
            scriptResult: execution.scriptResult ?? null,
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
        applyNativeCellEdit(selection.cellId, "cell:select", selection.pageId || "");
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
      const pageInfo = getNativeDiagramPageInfo(sourceXml, sourcePageId);
      const nativeTargets = extractNativeEditTargets(sourceXml, pageInfo.id).slice(0, 200);
      const selectedTarget = nativeTargets.find((target) => target.id === sourceSelectedCellId);
      const requestContext = {
        kind: "drawio" as const,
        title: pageInfo.title || "Draw.io diagram",
        activePageId: pageInfo.id,
        selectedCell: sourceSelectedCellId ? {
          cellId: sourceSelectedCellId, pageId: pageInfo.id,
          label: selectedTarget?.name || ""
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
      const layoutOperation = command.operations.length === 1 && command.operations[0].op === "auto_layout"
        ? command.operations[0] : undefined;
      const layoutPlan = layoutOperation
        ? await calculateNativeAutoLayout(sourceXml, command.pageId, documentRevision, layoutOperation)
        : undefined;
      if (layoutOperation) {
        const stateAfterLayout = getCurrentDiagramState?.() ?? { drawioXml, selectedNativeCellId, selectedNativePageId };
        if (stateAfterLayout.drawioXml !== sourceXml || stateAfterLayout.selectedNativePageId !== sourcePageId) {
          throw new Error("The diagram or active page changed while Studio was calculating the confirmed layout. Nothing was applied; retry.");
        }
      }
      const cellPlan = toNativeCellEdits(command.operations, sourceXml, command.pageId, layoutPlan);
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
