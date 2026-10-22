import { useCallback, type Dispatch, type SetStateAction } from "react";
import { requestAIIntentPlan, type AppliedDiagramEdit } from "../intent/aiProvider";
import type { DiagramDocument, DiagramNode } from "../model/types";
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
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, document, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNode, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput,
    setChatBusy, setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, onAppliedEdit
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
      executionCapabilities: standaloneMode ? ["allowlisted global layout plans only", "workspace mutations disabled"] : ["diagram inspection", "validated semantic operations", "reviewable proposals", "allowlisted layout plans"]
    });
    setMessages((items) => [...items, { role: "user", id: Date.now(), text }]);
    if (!promptOverride) setChatInput("");
    setChatBusy(true);
    try {
      if (!workspaceContentReady && !standaloneMode) throw new Error("The project diagram has not finished loading; no Agent request was sent.");
      if (!standaloneMode) await persistDocumentNow(document, drawioXml, "Before Copilot request");
      let effectiveText = text;
      let modelReply = "";
      if (aiModel.trim()) {
        recordDiagnostic("copilot.agent.request", "Asked the Copilot SDK agent for a constrained layout plan", {
          sessionId: copilotSessionId, model: aiModel.trim(), reasoningEffort, provider: "github-copilot-sdk",
          standaloneMode, inputLength: text.length, userRequest: text, diagramTitle: document.title,
          nodeCount: Math.min(document.nodes.length, 80), relationCount: document.relations.length,
          selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name, role: selectedNode.role } : null,
          executionCapabilities: standaloneMode ? ["allowlisted global layout plans only", "workspace mutations disabled"] : ["diagram inspection", "validated semantic operations", "reviewable proposals", "allowlisted layout plans"]
        });
        const plan = await requestAIIntentPlan(
          { baseUrl: "copilot-sdk", model: aiModel, reasoningEffort, sessionId: copilotSessionId, standalone: standaloneMode },
          text,
          {
            kind: document.kind, title: document.title,
            selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name, role: selectedNode.role } : null,
            nodes: document.nodes.slice(0, 80).map((node) => ({ id: node.id, name: node.name, role: node.role }))
          }
        );
        if (plan.sessionId && plan.sessionId !== copilotSessionId) {
          setCopilotSessionId(plan.sessionId);
          try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", plan.sessionId); } catch { /* Session remains active in memory. */ }
        }
        modelReply = plan.reply;
        recordDiagnostic("copilot.agent.response", "Received a structured result from the Copilot SDK agent", {
          sessionId: plan.sessionId || copilotSessionId, provider: plan.provider || "github-copilot-sdk", model: plan.model || aiModel.trim(),
          reasoningEffort: plan.reasoningEffort, durationMs: plan.durationMs, toolUsed: plan.application ? "apply_diagram_operation" : plan.proposal ? "propose_diagram_operation" : "propose_layout_plan",
          commandCount: plan.commands.length, hasProposal: Boolean(plan.proposal), hasAppliedEdit: Boolean(plan.application), replyLength: plan.reply.length
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
    copilotSessionId, selectedNode, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy,
    setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, onAppliedEdit
  ]);
}
