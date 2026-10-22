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
  applyNativeCellEdit?: (cellId: string, path: string, value: string) => void;
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, document, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNode, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput,
    setChatBusy, setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, onAppliedEdit, applyNativeCellEdit
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
      // Standalone edits operate on the authoritative Draw.io XML and are applied by
      // the native editor bridge, which marks the editor dirty and requests serialization.
      if (standaloneMode && applyNativeCellEdit) {
        const parsed = new DOMParser().parseFromString(drawioXml, "application/xml");
        if (parsed.querySelector("parsererror")) throw new Error("The authoritative Draw.io XML could not be parsed; no edit was applied.");
        const normalized = text.trim();
        const move = normalized.match(/(?:move|将|把)?\s*[“"']?(.+?)[”"']?\s*(向上移动|上移|向下移动|下移|向左移动|左移|向右移动|右移|move up|move down|move left|move right|up|down|left|right)\s*(\d+(?:\.\d+)?)\s*(?:px|pixels?|像素)?/i);
        const rename = normalized.match(/(?:rename|change|set|把|将)?\s*[“"']?(.+?)[”"']?\s*(?:重命名为|改名为|名称改为|改成|命名为|rename to|to)\s*[“"']?(.+?)[”"']?$/i);
        const recolor = normalized.match(/(?:change|set|make|把|将)?\s*[“"']?(.+?)[”"']?\s*(?:fill|fill color|background|stroke|stroke color|border|颜色|填充色|边框色)\s*(?:to|为|改成|设置为)?\s*(#[0-9a-f]{3}(?:[0-9a-f]{3})?|red|blue|green|black|white|orange|purple|灰色|红色|蓝色|绿色|黑色|白色|橙色|紫色)\s*$/i);
        const cells = Array.from(parsed.getElementsByTagName("mxCell"));
        const labelOf = (cell: Element) => {
          const owner = cell.parentElement;
          return (cell.getAttribute("value") || cell.getAttribute("label") || owner?.getAttribute("label") || owner?.getAttribute("value") || "")
            .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").trim();
        };
        const targetName = (move?.[1] || rename?.[1] || recolor?.[1] || "").trim().replace(/^(?:the|node|element|元素|节点)\s+/i, "").replace(/[。.!！]+$/, "");
        if (move || rename || recolor) {
          const matches = cells.filter((cell) => labelOf(cell).localeCompare(targetName, undefined, { sensitivity: "accent" }) === 0 && cell.getAttribute("vertex") !== "0" && cell.getAttribute("edge") !== "1");
          if (matches.length !== 1) throw new Error(matches.length ? "The label “" + targetName + "” is ambiguous (" + matches.length + " matching cells). Select a specific element or use a unique label." : "Could not find a Draw.io element named “" + targetName + "”. No changes were applied.");
          const cell = matches[0];
          const id = cell.getAttribute("id");
          const geometry = cell.getElementsByTagName("mxGeometry")[0];
          if (!id) throw new Error("The target element has no stable Draw.io cell ID.");
          let path = "", value = "", summary = "";
          if (move) {
            const direction = move[2].toLowerCase(), delta = Number(move[3]);
            if (!Number.isFinite(delta) || delta <= 0 || delta > 10000) throw new Error("Move distance must be between 0 and 10000 pixels.");
            const axis = direction.includes("left") || direction.includes("右") || direction.includes("左") ? "x" : "y";
            const sign = direction.includes("up") || direction.includes("上") || direction.includes("left") || direction.includes("左") ? -1 : 1;
            const raw = geometry?.getAttribute(axis), coordinate = raw === null || raw === undefined ? NaN : Number(raw);
            if (!geometry || !Number.isFinite(coordinate)) throw new Error("The target element has no explicit " + axis.toUpperCase() + " coordinate.");
            path = "geometry:" + axis; value = String(coordinate + sign * delta);
            summary = "Move “" + targetName + "” " + direction + " " + delta + " px";
          } else if (rename) {
            const newName = rename[2].trim().replace(/^[“"']|[”"']$/g, "");
            if (!newName || newName.length > 500) throw new Error("The new label must contain 1–500 characters.");
            path = "label"; value = newName; summary = "Rename “" + targetName + "” to “" + newName + "”";
          } else if (recolor) {
            const property = recolor[0].toLowerCase();
            const colorProperty = /stroke|border|边框/.test(property) ? "strokeColor" : "fillColor";
            const rawColor = recolor[2].toLowerCase();
            const colorMap: Record<string, string> = { red: "#ff0000", blue: "#0000ff", green: "#008000", black: "#000000", white: "#ffffff", orange: "#ffa500", purple: "#800080", "灰色": "#808080", "红色": "#ff0000", "蓝色": "#0000ff", "绿色": "#008000", "黑色": "#000000", "白色": "#ffffff", "橙色": "#ffa500", "紫色": "#800080" };
            path = "style:" + colorProperty; value = colorMap[rawColor] || rawColor; summary = "Set " + colorProperty + " of “" + targetName + "” to " + value;
          }
          recordDiagnostic("copilot.standalone.native-edit.validated", "Validated a standalone native Draw.io edit against the authoritative XML", { cellId: id, targetName, operation: move ? "move" : rename ? "rename" : "recolor", path, value, xmlLength: drawioXml.length });
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
    setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, onAppliedEdit, applyNativeCellEdit
  ]);
}
