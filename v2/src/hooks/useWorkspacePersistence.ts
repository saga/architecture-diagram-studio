import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
type Workspace = { id: string } | null;
type ChatMessage = { role: "assistant" | "user"; id: number; text: string };
type Diagnostic = (event: string, message: string, details?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
interface Options {
  drawioXml: string; serverHydrated: boolean; workspaceContentReady: boolean;
  projectWorkspace: Workspace; copilotSessionId: string; messages: ChatMessage[];
  saveLabelRef: MutableRefObject<string>; serverRevisionRef: MutableRefObject<string | null>;
  setLastAction: (message: string) => void; onDiagnostic: Diagnostic;
}
interface SaveResult { saved: boolean; workspaceRevision?: string | null; version?: { id?: string } | null; error?: string; }
interface SaveOptions {
  /** Debounced autosaves must not persist an XML snapshot after the editor or workspace has moved on. */
  onlyIfCurrent?: boolean;
  expectedWorkspaceId?: string | null;
}
export function useWorkspacePersistence(options: Options) {
  const { drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef, serverRevisionRef, setLastAction, onDiagnostic } = options;
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastPersistedXmlRef = useRef<string | null>(null);
  const lastPersistedVersionIdRef = useRef<string | null>(null);
  const currentXmlRef = useRef(drawioXml);
  const currentWorkspaceIdRef = useRef<string | null>(projectWorkspace?.id ?? null);
  // Keep these refs current during render so already-queued work can detect a mode/document switch.
  currentXmlRef.current = drawioXml;
  currentWorkspaceIdRef.current = projectWorkspace?.id ?? null;
  const persistDocumentNow = useCallback((xml: string, label = "Autosave", saveOptions?: SaveOptions): Promise<SaveResult> => {
    const operation = saveQueueRef.current.then(async () => {
      if (saveOptions?.onlyIfCurrent &&
          (currentXmlRef.current !== xml ||
           currentWorkspaceIdRef.current !== saveOptions.expectedWorkspaceId)) {
        onDiagnostic("workspace.persist.stale-autosave.skipped", "Skipped a queued autosave because its XML or workspace context is no longer current", {
          xmlLength: xml.length, expectedWorkspaceId: saveOptions.expectedWorkspaceId ?? null,
          currentWorkspaceId: currentWorkspaceIdRef.current,
          currentXmlLength: currentXmlRef.current.length
        }, "info");
        return {
          saved: false, workspaceRevision: serverRevisionRef.current,
          version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null
        };
      }
      // The explicit Copilot save and the debounced autosave can observe the same editor event.
      // Avoid creating two version records for the same exact XML snapshot.
      if (lastPersistedXmlRef.current === xml && typeof serverRevisionRef.current === "string") {
        return {
          saved: false, workspaceRevision: serverRevisionRef.current,
          version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null
        };
      }
      const baseRevision = serverRevisionRef.current;
      const response = await fetch("/api/workspace/document", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ drawioXml: xml, label, baseRevision })
      });
      const payload = await response.json().catch(() => ({})) as SaveResult & { currentRevision?: string | null };
      if (response.status === 409) {
        setLastAction("Save conflict: the server has a newer diagram revision. The local changes were not written; reload the latest version before continuing.");
        onDiagnostic("workspace.persist.conflict", "The server rejected a stale diagram save; the newer revision was preserved", {
          baseRevision, currentRevision: payload.workspaceRevision ?? payload.currentRevision ?? null,
          xmlLength: xml.length
        }, "error");
        throw new Error(payload.error || "The diagram changed in another editor. Reload the latest version before continuing.");
      }
      if (!response.ok) throw new Error(payload.error || "HTTP " + response.status + " while saving the document");
      if (typeof payload.workspaceRevision === "string" || payload.workspaceRevision === null) serverRevisionRef.current = payload.workspaceRevision ?? null;
      if (typeof payload.version?.id === "string") lastPersistedVersionIdRef.current = payload.version.id;
      if (payload.saved) {
        lastPersistedXmlRef.current = xml;
        onDiagnostic("workspace.version.persisted", "Document and Draw.io XML revision persisted to the server", {
          versionId: payload.version?.id, revision: serverRevisionRef.current, xmlLength: xml.length
        });
      }
      return payload;
    });
    saveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, [onDiagnostic, setLastAction]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace || lastPersistedXmlRef.current !== null) return;
    if (typeof serverRevisionRef.current === "string") lastPersistedXmlRef.current = drawioXml;
  }, [drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, serverRevisionRef]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace) return;
    // The native Draw.io XML is the complete document. Save it directly without comparing a model projection.
    const expectedWorkspaceId = projectWorkspace.id;
    const timer = window.setTimeout(() => {
      void persistDocumentNow(drawioXml, saveLabelRef.current, {
        onlyIfCurrent: true, expectedWorkspaceId
      }).catch((error: unknown) => {
        onDiagnostic("workspace.persist.failed", "Saving the workspace to the server failed", {
          errorMessage: error instanceof Error ? error.message : String(error), xmlLength: drawioXml.length
        }, "error");
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, persistDocumentNow, saveLabelRef, onDiagnostic]);
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
