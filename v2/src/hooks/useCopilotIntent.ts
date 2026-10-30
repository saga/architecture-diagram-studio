import { useCallback, type Dispatch, type SetStateAction } from "react";
import { calculateDrawioXmlRevision, requestAIIntentPlan } from "../intent/aiProvider";
import { resolveNativePageIdentity } from "../model/native-edit-operations";
import { recordDiagnostic } from "../diagnostics";
import { compareCopilotRequestContext, type CopilotRequestDiagramState } from "../model/copilot-stale-context";
import type { DrawioRuntimeInspection } from "../model/drawio-runtime-contract";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
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
  getRuntimeInspection?: (input: { documentRevision: string; pageId: string | null }) => Promise<DrawioRuntimeInspection>;
  persistWorkspaceDocument?: (xml: string, label: string) => Promise<{ workspaceRevision?: string | null }>;
  onServerXmlCommitted?: () => Promise<void>;
  onStandaloneXmlPatchReady?: (xml: string) => Promise<void>;
  setWorkspaceSetupOpen: (open: boolean) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setChatInput: (value: string) => void;
  setChatBusy: (busy: boolean) => void;
  setCopilotSessionId: (id: string) => void;
  selectNativeCell?: (cellId: string, pageId?: string | null) => void | Promise<void>;
}

export function useCopilotIntent(options: CopilotIntentOptions) {
  const {
    projectWorkspace, standaloneMode, chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId, getCurrentDiagramState, getRuntimeInspection, persistWorkspaceDocument, onServerXmlCommitted, onStandaloneXmlPatchReady,
    setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy, setCopilotSessionId, selectNativeCell
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
        // A multi-page mxfile may arrive before the iframe's initial page-selection event has
        // reached React. Ask the live editor to identify its active page instead of rejecting a
        // valid inspection merely because the caller supplied pageId=null.
        runtimeInspection = await getRuntimeInspection({ documentRevision, pageId: activePageId });
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

      // Re-resolve once the editor has confirmed the active page: the request carries the document
      // identity, which is null for a bare mxGraphModel.
      pageIdentity = resolveNativePageIdentity(sourceXml, activePageId);
      const requestPageId = pageIdentity.documentPageId;
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
          // The server resolves the selection against its own snapshot; a client-side label would be
          // thrown away, and building it meant parsing the whole document on the UI thread.
          selectedCell: sourceSelectedCellId ? { cellId: sourceSelectedCellId, pageId: requestPageId } : null,
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
        hasSelection: plan.outcome === "selected",
        replyLength: plan.reply.length
      });

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
      if (plan.outcome === "xml_patch_ready") {
        if (!standaloneMode) throw new Error("A standalone XML patch was returned for a workspace document; no canvas state was changed.");
        if (!onStandaloneXmlPatchReady) throw new Error("The server prepared the XML patch, but browser-owned file persistence is unavailable.");
        if (plan.documentRevision !== documentRevision ||
            await calculateDrawioXmlRevision(plan.drawioXml) !== plan.patchedRevision) {
          throw new Error("The standalone XML patch failed revision verification. The local file was not changed.");
        }
        const currentState = getStateForResolvedPage();
        if (await calculateDrawioXmlRevision(currentState.drawioXml) !== plan.documentRevision) {
          throw new Error("The current local XML no longer matches the patch source revision. The local file was not changed.");
        }
        assertCopilotRequestContextFresh(
          "before-standalone-xml-apply",
          { drawioXml: sourceXml, selectedNativeCellId: sourceSelectedCellId, selectedNativePageId: sourcePageId },
          currentState,
          "before applying the server-generated XML. No change was applied; retry against the current state."
        );
        await onStandaloneXmlPatchReady(plan.drawioXml);
        recordDiagnostic("copilot.xml-edit.standalone-patch-applied",
          "Applied a revision-checked server XML patch to the standalone editor; browser file-handle persistence will confirm the write",
          { requestId: plan.requestId, sourceRevision: plan.documentRevision,
            patchedRevision: plan.patchedRevision, changedCellIds: plan.changedCellIds });
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: plan.reply.replace("正在交由浏览器写回所选本地文件。", "浏览器已将变更写回所选本地文件。") }]);
        return;
      }
      if (plan.outcome === "selected") {
        const selection = plan.selection;
        if (!selectNativeCell) throw new Error("The native Draw.io selection bridge is unavailable; the element was not selected.");
        if ((selection.pageId ?? null) !== (activePageId ?? null)) throw new Error("The selection result targets a different Draw.io page; no selection changed.");
        await selectNativeCell(selection.cellId, selection.pageId);
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
    setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy, setCopilotSessionId, selectNativeCell
  ]);



  return { sendIntent };
}
