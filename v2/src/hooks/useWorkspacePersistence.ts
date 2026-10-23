import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
type Workspace = { id: string; primaryDiagram?: string | null } | null;
function getWorkspaceKey(workspace: Workspace): string | null {
  return workspace ? JSON.stringify([workspace.id, workspace.primaryDiagram ?? null]) : null;
}
type SaveConflict = { workspaceKey: string | null; currentRevision: string | null };
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
  expectedWorkspaceKey?: string | null;
}
export function useWorkspacePersistence(options: Options) {
  const { drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef, serverRevisionRef, setLastAction, onDiagnostic } = options;
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastPersistedXmlRef = useRef<string | null>(null);
  const lastPersistedVersionIdRef = useRef<string | null>(null);
  const currentXmlRef = useRef(drawioXml);
  const currentWorkspaceIdRef = useRef<string | null>(projectWorkspace?.id ?? null);
  const currentWorkspaceKeyRef = useRef<string | null>(getWorkspaceKey(projectWorkspace));
  const saveConflictRef = useRef<SaveConflict | null>(null);
  const saveEpochRef = useRef(0);
  const pausedAutosaveLoggedRef = useRef(false);
  // Keep these refs current during render so queued work detects an XML, workspace or diagram switch.
  currentXmlRef.current = drawioXml;
  currentWorkspaceIdRef.current = projectWorkspace?.id ?? null;
  const nextWorkspaceKey = getWorkspaceKey(projectWorkspace);
  if (currentWorkspaceKeyRef.current !== nextWorkspaceKey) saveEpochRef.current += 1;
  currentWorkspaceKeyRef.current = nextWorkspaceKey;

  const clearSaveConflict = useCallback((reason: string, nextXml?: string, alreadyPersisted = false) => {
    const previous = saveConflictRef.current;
    // Update these refs synchronously: an old save may already be queued when restore succeeds.
    // It must see that its XML is stale before the conflict latch is released.
    if (typeof nextXml === "string") currentXmlRef.current = nextXml;
    if (alreadyPersisted && typeof nextXml === "string") lastPersistedXmlRef.current = nextXml;
    // Invalidate queued operations captured before a server restore/document switch.
    saveEpochRef.current += 1;
    saveConflictRef.current = null;
    pausedAutosaveLoggedRef.current = false;
    if (previous) onDiagnostic("workspace.persist.conflict.cleared",
      "Workspace saving was re-enabled after an authoritative context change",
      { reason, previousWorkspaceKey: previous.workspaceKey,
        currentWorkspaceKey: currentWorkspaceKeyRef.current, conflictingRevision: previous.currentRevision }, "info");
  }, [onDiagnostic]);

  useEffect(() => {
    const conflict = saveConflictRef.current;
    if (conflict && conflict.workspaceKey !== currentWorkspaceKeyRef.current) {
      clearSaveConflict("workspace-changed");
    }
  }, [projectWorkspace?.id, projectWorkspace?.primaryDiagram, clearSaveConflict]);

  const persistDocumentNow = useCallback((xml: string, label = "Autosave", saveOptions?: SaveOptions): Promise<SaveResult> => {
    const scheduledWorkspaceKey = currentWorkspaceKeyRef.current;
    const scheduledSaveEpoch = saveEpochRef.current;
    const operation = saveQueueRef.current.then(async () => {
      if (scheduledSaveEpoch !== saveEpochRef.current || scheduledWorkspaceKey !== currentWorkspaceKeyRef.current) {
        const message = "Skipped a queued save because the active document context changed before it could be written.";
        onDiagnostic("workspace.persist.queued-save.invalidated", message, {
          scheduledWorkspaceKey, currentWorkspaceKey: currentWorkspaceKeyRef.current,
          scheduledSaveEpoch, currentSaveEpoch: saveEpochRef.current, xmlLength: xml.length
        }, saveOptions?.onlyIfCurrent ? "info" : "warn");
        if (saveOptions?.onlyIfCurrent) {
          return { saved: false, workspaceRevision: serverRevisionRef.current,
            version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null, error: message };
        }
        throw new Error(message);
      }
      if (saveOptions?.onlyIfCurrent &&
          (currentXmlRef.current !== xml ||
           currentWorkspaceIdRef.current !== saveOptions.expectedWorkspaceId ||
           currentWorkspaceKeyRef.current !== saveOptions.expectedWorkspaceKey)) {
        onDiagnostic("workspace.persist.stale-autosave.skipped", "Skipped a queued autosave because its XML or workspace context is no longer current", {
          xmlLength: xml.length, expectedWorkspaceId: saveOptions.expectedWorkspaceId ?? null,
          currentWorkspaceId: currentWorkspaceIdRef.current,
          expectedWorkspaceKey: saveOptions.expectedWorkspaceKey ?? null,
          currentWorkspaceKey: currentWorkspaceKeyRef.current,
          currentXmlLength: currentXmlRef.current.length
        }, "info");
        return {
          saved: false, workspaceRevision: serverRevisionRef.current,
          version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null
        };
      }
      const existingConflict = saveConflictRef.current;
      if (existingConflict && existingConflict.workspaceKey !== currentWorkspaceKeyRef.current) {
        clearSaveConflict("workspace-changed");
      }
      if (saveConflictRef.current) {
        const errorMessage = "Workspace saving is paused after a revision conflict. Export the local draft, then restore or reload an authoritative server version before continuing.";
        if (saveOptions?.onlyIfCurrent) {
          if (!pausedAutosaveLoggedRef.current) {
            pausedAutosaveLoggedRef.current = true;
            onDiagnostic("workspace.persist.autosave.paused",
              "Skipped autosave while a revision conflict remains unresolved",
              { workspaceKey: saveConflictRef.current.workspaceKey, conflictingRevision: saveConflictRef.current.currentRevision,
                xmlLength: xml.length }, "warn");
          }
          return {
            saved: false, workspaceRevision: serverRevisionRef.current,
            version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null,
            error: errorMessage
          };
        }
        throw new Error(errorMessage);
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
        const conflictingRevision = payload.workspaceRevision ?? payload.currentRevision ?? null;
        saveConflictRef.current = {
          workspaceKey: currentWorkspaceKeyRef.current,
          currentRevision: typeof conflictingRevision === "string" ? conflictingRevision : null
        };
        pausedAutosaveLoggedRef.current = false;
        setLastAction("Save conflict: local edits remain in this editor but were not written. Automatic saves are paused; export a copy before restoring or reloading a server version.");
        onDiagnostic("workspace.persist.conflict", "The server rejected a stale diagram save; further automatic saves are paused and the newer revision was preserved", {
          baseRevision, currentRevision: saveConflictRef.current.currentRevision,
          workspaceKey: saveConflictRef.current.workspaceKey, xmlLength: xml.length
        }, "error");
        throw new Error(payload.error || "The diagram changed in another editor. Export the local draft, then restore or reload the latest version before continuing.");
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
  }, [clearSaveConflict, onDiagnostic, setLastAction]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace || lastPersistedXmlRef.current !== null) return;
    if (typeof serverRevisionRef.current === "string") lastPersistedXmlRef.current = drawioXml;
  }, [drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, serverRevisionRef]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace) return;
    // The native Draw.io XML is the complete document. Save it directly without comparing a model projection.
    const expectedWorkspaceId = projectWorkspace.id;
    const expectedWorkspaceKey = getWorkspaceKey(projectWorkspace);
    const timer = window.setTimeout(() => {
      void persistDocumentNow(drawioXml, saveLabelRef.current, {
        onlyIfCurrent: true, expectedWorkspaceId, expectedWorkspaceKey
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
  return { persistDocumentNow, clearSaveConflict };
}
