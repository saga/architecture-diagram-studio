import { useCallback, type Dispatch, type SetStateAction } from "react";
import { requestAIIntentPlan, type AppliedDiagramEdit } from "../intent/aiProvider";
import type { DiagramDocument, DiagramNode } from "../model/types";
import { describeNativeEditOperation, extractNativeEditTargets, getNativeDiagramPageInfo, toNativeCellEdits, type NativeCellEdit, type NativeEditExecution } from "../model/native-edit-operations";
import { recordDiagnostic } from "../diagnostics";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type Workspace = { id: string } | null;
type PersistDocument = (document: DiagramDocument, xml: string, label?: string) => Promise<unknown>;

interface CopilotIntentOptions {
  projectWorkspace: Workspace;
  standaloneMode: boolean;
  chatInput: string;
  chatBusy: boolean;
  workspaceContentReady: boolean;
  document: DiagramDocument;
  drawioXml: string;
  aiModel: string;
  reasoningEffort: "high" | "max";
  copilotSessionId: string;
  selectedNode: DiagramNode | null;
  selectedNativeCellId: string | null;
  selectedNativePageId: string | null;
  persistDocumentNow: PersistDocument;
  setWorkspaceSetupOpen: (open: boolean) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChatInput: (value: string) => void;
  setChatBusy: (busy: boolean) => void;
  setCopilotSessionId: (id: string) => void;
  setPendingAgentProposalId: (id: string | null) => void;
  setPreviewDocument: (document: DiagramDocument | null) => void;
  setPreviewSummary: (summary: string) => void;
  onAppliedEdit: (application: AppliedDiagramEdit) => void;
  applyNativeCellEdit?: (cellId: string, path: string, value: string) => void;
  /** Executes one atomic bridge batch and resolves with the editor's per-step acknowledgement. */
  applyNativeCellEdits?: (edits: NativeCellEdit[]) => Promise<NativeEditExecution>;
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, document, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNode, selectedNativeCellId, selectedNativePageId, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput,
    setChatBusy, setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, onAppliedEdit,
    applyNativeCellEdit, applyNativeCellEdits
  } = options;

  return useCallback(async (promptOverride?: string) => {
    if (!projectWorkspace && !standaloneMode) { setWorkspaceSetupOpen(true); return; }
    const text = (promptOverride ?? chatInput).trim();
    if (!text || chatBusy) return;
    const startedAt = Date.now();
    recordDiagnostic("copilot.request.started", "Layout intent handling started", {
      configuredModel: Boolean(aiModel.trim()), provider: aiModel.trim() ? "github-copilot-sdk" : "local-rules", model: aiModel.trim() || "local-rules",
      sessionId: copilotSessionId, standaloneMode, diagramKind: document.kind, diagramTitle: document.title,
      nodeCount: document.nodes.length, relationCount: document.relations.length,
      selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name, role: selectedNode.role } : null,
      userRequest: text, inputLength: text.length,
      executionCapabilities: standaloneMode ? ["typed native edits", "element selection", "allowlisted global layout plans", "workspace mutations disabled"] : ["diagram inspection", "validated semantic operations", "typed native edits", "reviewable proposals", "allowlisted layout plans"]
    });
    setMessages((items) => [...items, { role: "user", id: Date.now(), text }]);
    if (!promptOverride) setChatInput("");
    setChatBusy(true);
    try {
      if (!workspaceContentReady && !standaloneMode) throw new Error("The project diagram has not finished loading; no Agent request was sent.");
      // Standalone edits operate on the authoritative Draw.io XML and are applied by
      // the native editor bridge, which marks the editor dirty and requests serialization.
      // Only two unambiguous single-instruction forms keep a local fast path; every other
      // phrasing goes to the agent, which owns the operation vocabulary.
      if (standaloneMode && applyNativeCellEdit) {
        const parsed = new DOMParser().parseFromString(drawioXml, "application/xml");
        if (parsed.querySelector("parsererror")) throw new Error("The authoritative Draw.io XML could not be parsed; no edit was applied.");
        const normalized = text.trim();
        const rename = normalized.match(/(?:rename|重命名|改名|把|将)?\s*[“"']?(.+?)[”"']?\s*(?:重命名为|改名为|名称改为|rename to)\s*[“"']?(.+?)[”"']?$/i);
        const remove = normalized.match(/^(?:delete|remove|删除|移除)\s*[“"']?(.+?)[”"']?\s*(?:element|node|节点|元素)?[。.!！]?$/i);
        const selectionLayout = normalized.match(/^(?:align|对齐)\s+(?:selected\s+)?(?:cells?\s+)?(left|right|top|bottom|center|middle|左对齐|右对齐|顶部对齐|底部对齐|水平居中|垂直居中)\s*$/i)
          || normalized.match(/^(?:将|把)?(?:选中)?(?:元素|节点|图形)?\s*(左对齐|右对齐|顶部对齐|底部对齐|水平居中|垂直居中)\s*$/i)
          || normalized.match(/^(?:distribute|均匀分布|平均分布)\s+(?:selected\s+)?(?:cells?\s+)?(horizontally|vertically|horizontal|vertical|水平|垂直)\s*$/i)
          || normalized.match(/^(?:将|把)?(?:选中)?(?:元素|节点|图形)?\s*(水平|垂直)(?:均匀分布|平均分布)$/i);
        const groupSelection = /^(?:group|组合|编组)\s*(?:selected\s+)?(?:cells?|elements?|nodes?|元素|节点)?\s*$/i.test(normalized);
        const ungroupSelection = /^(?:ungroup|取消组合|解组)\s*(?:selected\s+)?(?:cells?|elements?|nodes?|元素|节点)?\s*$/i.test(normalized);
        if (selectionLayout || groupSelection || ungroupSelection) {
          let path = "";
          let summary = "";
          if (groupSelection) { path = "cell:group"; summary = "Group the selected Draw.io cells"; }
          else if (ungroupSelection) { path = "cell:ungroup"; summary = "Ungroup the selected Draw.io group"; }
          else {
            const mode = selectionLayout![1].toLowerCase();
            if (/left|左对齐/.test(mode)) path = "cell:align:left";
            else if (/right|右对齐/.test(mode)) path = "cell:align:right";
            else if (/top|顶部/.test(mode)) path = "cell:align:top";
            else if (/bottom|底部/.test(mode)) path = "cell:align:bottom";
            else if (/center|水平居中/.test(mode)) path = "cell:align:center";
            else if (/middle|垂直居中/.test(mode)) path = "cell:align:middle";
            else if (/horizontal|horizontally|水平/.test(mode)) path = "cell:distribute:horizontal";
            else path = "cell:distribute:vertical";
            summary = "Apply native Draw.io selection operation: " + path.slice("cell:".length);
          }
          recordDiagnostic("copilot.standalone.selection-operation.validated", "Validated a native Draw.io multi-selection operation", {
            operation: path, selectedCellId: "__selection__", request: text, xmlLength: drawioXml.length
          });
          applyNativeCellEdit("__selection__", path, "true");
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1,
            text: summary + ". The native editor will validate the current selection and report the result in Agent traces." }]);
          return;
        }
        const cells = Array.from(parsed.getElementsByTagName("mxCell"));
        const labelOf = (cell: Element) => {
          const owner = cell.parentElement;
          return (cell.getAttribute("value") || cell.getAttribute("label") || owner?.getAttribute("label") || owner?.getAttribute("value") || "")
            .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").trim();
        };
        const targetName = (rename?.[1] || remove?.[1] || "").trim().replace(/^(?:the|node|element|元素|节点)\s+/i, "").replace(/[。.!！]+$/, "");
        if (rename || remove) {
          const matches = cells.filter((cell) => labelOf(cell).localeCompare(targetName, undefined, { sensitivity: "accent" }) === 0 && cell.getAttribute("vertex") !== "0");
          if (matches.length !== 1) throw new Error(matches.length ? "The label “" + targetName + "” is ambiguous (" + matches.length + " matching cells). Select a specific element or use a unique label." : "Could not find a Draw.io element named “" + targetName + "”. No changes were applied.");
          const cell = matches[0];
          const id = cell.getAttribute("id");
          if (!id) throw new Error("The target element has no stable Draw.io cell ID.");
          let path = "", value = "", summary = "";
          if (remove) {
            path = "cell:delete"; value = "true"; summary = "Delete element “" + targetName + "”";
          } else {
            const newName = rename![2].trim().replace(/^[“"']|[”"']$/g, "");
            if (!newName || newName.length > 500) throw new Error("The new label must contain 1–500 characters.");
            path = "label"; value = newName; summary = "Rename “" + targetName + "” to “" + newName + "”";
          }
          recordDiagnostic("copilot.standalone.native-edit.validated", "Validated a standalone native Draw.io edit against the authoritative XML", {
            cellId: id, targetName, operation: remove ? "delete" : "rename", path, value, xmlLength: drawioXml.length
          });
          applyNativeCellEdit(id, path, value);
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: summary + ". The native editor has been asked to apply the change and autosave; check Agent traces for the editor acknowledgement." }]);
          return;
        }
      }
      if (!standaloneMode) await persistDocumentNow(document, drawioXml, "Before Copilot request");
      let effectiveText = text;
      let modelReply = "";
      if (aiModel.trim()) {
        recordDiagnostic("copilot.agent.request", "Asked the Copilot SDK agent for a constrained layout plan", {
          sessionId: copilotSessionId, model: aiModel.trim(), reasoningEffort, provider: "github-copilot-sdk",
          standaloneMode, inputLength: text.length, userRequest: text, diagramTitle: document.title,
          nodeCount: Math.min(document.nodes.length, 80), relationCount: document.relations.length,
          selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name, role: selectedNode.role } : null,
          executionCapabilities: standaloneMode ? ["typed native edits", "element selection", "allowlisted global layout plans", "workspace mutations disabled"] : ["diagram inspection", "validated semantic operations", "typed native edits", "reviewable proposals", "allowlisted layout plans"]
        });
        let nativeTargets: Array<{ id: string; name: string; cellType: "vertex" | "edge" }> = [];
        try { nativeTargets = extractNativeEditTargets(drawioXml, selectedNativePageId).slice(0, 200); }
        catch (error) {
          recordDiagnostic("copilot.native-context.parse-failed", "Could not index native Draw.io cells from the current XML", {
            errorMessage: error instanceof Error ? error.message : String(error), xmlLength: drawioXml.length
          }, "warn");
        }
        let nativePage: { id: string | null; title: string | null } = { id: selectedNativePageId, title: null };
        try { nativePage = getNativeDiagramPageInfo(drawioXml, selectedNativePageId); }
        catch { /* Cell indexing already records the XML parsing diagnostic above. */ }
        const selectedNativeTarget = nativeTargets.find((target) => target.id === selectedNativeCellId);
        const plan = await requestAIIntentPlan(
          { baseUrl: "copilot-sdk", model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode },
          text,
          {
            kind: "drawio", title: nativePage.title || "Draw.io diagram",
            selectedCell: selectedNativeCellId ? {
              cellId: selectedNativeCellId, pageId: nativePage.id || selectedNativePageId,
              label: selectedNativeTarget?.name || selectedNativeCellId
            } : null,
            nodes: nativeTargets
          }
        );
        if (plan.sessionId && plan.sessionId !== copilotSessionId) {
          setCopilotSessionId(plan.sessionId);
          try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", plan.sessionId); } catch { /* Session remains active in memory. */ }
        }
        modelReply = plan.reply;
        recordDiagnostic("copilot.agent.response", "Received a structured result from the Copilot SDK agent", {
          sessionId: plan.sessionId || copilotSessionId, provider: plan.provider || "github-copilot-sdk", model: plan.model || aiModel.trim(),
          reasoningEffort: plan.reasoningEffort, durationMs: plan.durationMs,
          toolUsed: plan.application ? "apply_diagram_operation" : plan.nativeEdits ? "propose_native_edits" : plan.proposal ? "propose_diagram_operation" : plan.selection ? "select_diagram_element" : "propose_layout_plan",
          commandCount: plan.commands.length, nativeEditCount: plan.nativeEdits?.operations.length ?? 0,
          hasProposal: Boolean(plan.proposal), hasAppliedEdit: Boolean(plan.application), hasSelection: Boolean(plan.selection), replyLength: plan.reply.length
        });
        if (plan.application) {
          const application = plan.application;
          setPendingAgentProposalId(null);
          setPreviewDocument(null);
          setPreviewSummary("");
          onAppliedEdit(application);
          const prefix = modelReply && modelReply !== application.summary ? modelReply + " " : "";
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1,
            text: prefix + "Applied directly and created version " + application.versionId + ". " + application.summary }]);
          recordDiagnostic("copilot.edit.applied", "Copilot applied a focused revision-bound diagram operation and created a server version", {
            versionId: application.versionId, baseRevision: application.baseRevision, workspaceRevision: application.workspaceRevision,
            nodeCount: application.document.nodes.length, relationCount: application.document.relations.length, qualityScore: application.quality.score
          });
          return;
        }
        if (plan.nativeEdits) {
          const operations = plan.nativeEdits.operations;
          if (!applyNativeCellEdits) throw new Error("The native Draw.io edit bridge is unavailable; no change was applied.");
          const cellPlan = toNativeCellEdits(operations, drawioXml);
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
          const prefix = modelReply && modelReply !== plan.nativeEdits.summary ? modelReply + " " : "";
          const failedStep = execution.steps.find((step) => !step.success);
          if (execution.ok) {
            recordDiagnostic("copilot.native-edits.applied", "The native editor applied an atomic Copilot edit batch", {
              operationCount: operations.length, steps: execution.steps.length,
              operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, label: operation.label }))
            });
            setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1,
              text: prefix + "Applied " + operations.length + " native change" + (operations.length === 1 ? "" : "s") + ": " +
                operations.map(describeNativeEditOperation).join("; ") + ". Autosave persists the XML; no server revision was created." }]);
          } else {
            const reason = failedStep?.error || execution.error || "the native editor rejected the batch";
            recordDiagnostic("copilot.native-edits.failed", "The native editor rejected an atomic Copilot edit batch", {
              operationCount: operations.length, errorMessage: reason, failedStepIndex: failedStep?.index ?? null,
              rolledBack: execution.rolledBack,
              operations: operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, label: operation.label }))
            }, "error");
            setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1,
              text: prefix + "Nothing was applied: " + describeAt((failedStep?.index ?? 1) - 1) + " failed (" + reason + "). " +
                (execution.rolledBack
                  ? "The batch is atomic, so every step was rolled back."
                  : "The native editor did not confirm a rollback; reload the diagram before continuing.") }]);
          }
          return;
        }
        if (plan.selection) {
          recordDiagnostic("copilot.selection.resolved", "Copilot resolved a native Draw.io cell selection", { cellId: plan.selection.cellId, pageId: plan.selection.pageId, label: plan.selection.label, standaloneMode });
          if (!applyNativeCellEdit) throw new Error("The native Draw.io selection bridge is unavailable; the element was not selected.");
          applyNativeCellEdit(plan.selection.cellId, "cell:select", plan.selection.pageId || "");
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1,
            text: "Selected “" + plan.selection!.label + "”. The selection is a UI state only: the diagram itself is unchanged." }]);
          return;
        }
        if (plan.proposal) {
          setPendingAgentProposalId(plan.proposal.proposalId);
          setPreviewDocument(plan.proposal.document);
          setPreviewSummary(plan.proposal.summary);
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.proposal!.summary + ". A server-validated preview is ready (quality score " + plan.proposal!.quality.score + "). Review it, then apply or discard." }]);
          recordDiagnostic("copilot.preview.created", "A revision-bound internal Agent proposal is awaiting user confirmation", { proposalId: plan.proposal.proposalId, qualityScore: plan.proposal.quality.score, nodeCount: plan.proposal.document.nodes.length, relationCount: plan.proposal.document.relations.length });
          return;
        }
        if (!plan.commands.length) {
          recordDiagnostic("copilot.plan.empty", "Model returned no executable layout command; document untouched", {}, "warn");
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: "No changes applied. " + (modelReply || "This request did not match any supported safe layout operation.") }]);
          return;
        }
        effectiveText = plan.commands.join("; ");
      }
      const applyResponse = await fetch(standaloneMode ? "/api/diagram/intent/apply" : "/api/workspace/intent/apply", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ document, prompt: effectiveText }), signal: AbortSignal.timeout(70_000)
      });
      if (!applyResponse.ok) {
        const payload = await applyResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || "Server-side layout intent failed (HTTP " + applyResponse.status + ")");
      }
      const result = await applyResponse.json() as { document: DiagramDocument; summary: string; requiresLayout: boolean; changed: boolean };
      recordDiagnostic(result.changed ? "copilot.intent.matched" : "copilot.intent.no_change",
        result.changed ? "Layout intent mapped to executable rules" : "Layout intent matched no executable rule",
        { changed: result.changed, requiresLayout: result.requiresLayout, commandLength: effectiveText.length });
      if (result.changed) {
        setPendingAgentProposalId(null);
        setPreviewDocument(result.document);
        setPreviewSummary(result.summary);
        const qualityResponse = await fetch("/api/workspace/diagram/quality", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document: result.document })
        });
        if (!qualityResponse.ok) throw new Error("Server-side layout quality check failed");
        const quality = (await qualityResponse.json() as { report: import("../model/types").LayoutQualityReport }).report;
        const prefix = modelReply ? modelReply + " " : "";
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: prefix + result.summary + ". A temporary preview was generated with layout score " + quality.score + "; the document itself is unchanged. Review it, then apply or discard." }]);
        recordDiagnostic("copilot.preview.created", "Layout preview created and awaiting confirmation", {
          durationMs: Date.now() - startedAt, qualityScore: quality.score,
          nodeCount: result.document.nodes.length, relationCount: result.document.relations.length
        });
      } else {
        const reply = modelReply
          ? "No changes applied. " + modelReply + " (the model plan matched no executable layout operation.)"
          : result.summary;
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: reply }]);
      }
    } catch (error) {
      recordDiagnostic("copilot.request.failed", "Layout intent failed; nothing was committed", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        sessionId: copilotSessionId, model: aiModel.trim() || "local-rules", standaloneMode,
        userRequest: text, diagramTitle: document.title, diagramKind: document.kind,
        selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name } : null,
        detailRecordedByProvider: Boolean(aiModel.trim())
      }, "error");
      setMessages((items) => [...items, { role: "assistant", id: Date.now() + 2, text: "Nothing was committed: " + (error instanceof Error ? error.message : String(error)) }]);
    } finally {
      recordDiagnostic("copilot.request.finished", "Layout intent flow finished", { durationMs: Date.now() - startedAt, busy: false });
      setChatBusy(false);
    }
  }, [
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, document, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNode, selectedNativeCellId, selectedNativePageId, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy,
    setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, onAppliedEdit, applyNativeCellEdit,
    applyNativeCellEdits
  ]);
}
