import { useCallback, useEffect, type MutableRefObject } from "react";
import type { DiagramDocument } from "../model/types";
type Workspace = { id: string } | null;
type ChatMessage = { role: "assistant" | "user"; id: number; text: string };
type Diagnostic = (event: string, message: string, details?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
interface Options {
  document: DiagramDocument; drawioXml: string; serverHydrated: boolean; workspaceContentReady: boolean;
  projectWorkspace: Workspace; copilotSessionId: string; messages: ChatMessage[];
  saveLabelRef: MutableRefObject<string>; serverRevisionRef: MutableRefObject<string | null>; onDiagnostic: Diagnostic;
}
interface SaveResult { saved: boolean; workspaceRevision?: string | null; version?: { id?: string } | null; error?: string; }
export function useWorkspacePersistence(options: Options) {
  const { document, drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef, serverRevisionRef, onDiagnostic } = options;
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const persistDocumentNow = useCallback((snapshot: DiagramDocument, xml: string, label = "Autosave"): Promise<SaveResult> => {
    const operation = saveQueueRef.current.then(async () => {
      const baseRevision = serverRevisionRef.current;
      const response = await fetch("/api/workspace/document", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: snapshot, drawioXml: xml, label, baseRevision })
      });
      const payload = await response.json().catch(() => ({})) as SaveResult & { currentRevision?: string | null };
      if (response.status === 409) {
        onDiagnostic("workspace.persist.conflict", "The server rejected a stale diagram save; the newer revision was preserved", {
          baseRevision, currentRevision: payload.workspaceRevision ?? payload.currentRevision ?? null,
          documentId: snapshot.id, nodeCount: snapshot.nodes.length
        }, "error");
        throw new Error(payload.error || "The diagram changed in another editor. Reload the latest version before continuing.");
      }
      if (!response.ok) throw new Error(payload.error || "HTTP " + response.status + " while saving the document");
      if (typeof payload.workspaceRevision === "string" || payload.workspaceRevision === null) serverRevisionRef.current = payload.workspaceRevision ?? null;
      if (payload.saved) onDiagnostic("workspace.version.persisted", "Document and Draw.io XML revision persisted to the server", {
        versionId: payload.version?.id, revision: serverRevisionRef.current, xmlLength: xml.length, nodeCount: snapshot.nodes.length
      });
      return payload;
    });
    saveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, [onDiagnostic]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace) return;
    const timer = window.setTimeout(() => {
      void persistDocumentNow(document, drawioXml, saveLabelRef.current).catch((error: unknown) => {
        onDiagnostic("workspace.persist.failed", "Saving the workspace to the server failed", {
          errorMessage: error instanceof Error ? error.message : String(error), xmlLength: drawioXml.length, nodeCount: document.nodes.length
        }, "error");
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [document, drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, persistDocumentNow, saveLabelRef, onDiagnostic]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace) return;
    fetch("/api/workspace/chat", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ copilotSessionId, chatMessages: messages.slice(-2000) })
    }).then((response) => { if (!response.ok) throw new Error("HTTP " + response.status); }).catch((error: unknown) => {
      onDiagnostic("copilot.chat.persist.failed", "Could not save the Copilot conversation to the server", {
        sessionId: copilotSessionId, messageCount: messages.length,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
    });
  }, [copilotSessionId, messages, serverHydrated, workspaceContentReady, projectWorkspace, onDiagnostic]);
  return { persistDocumentNow };
}
