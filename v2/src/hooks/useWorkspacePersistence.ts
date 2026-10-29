import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
type Workspace = { id: string; primaryDiagram?: string | null } | null;
function getWorkspaceKey(workspace: Workspace): string | null {
  return workspace ? JSON.stringify([workspace.id, workspace.primaryDiagram ?? null]) : null;
}
export type WorkspaceSaveState = "saved" | "saving" | "conflict" | "failed";
type SaveConflict = { workspaceKey: string | null; currentRevision: string | null };
type ChatMessage = { role: "assistant" | "user"; id: number; text: string };
type Diagnostic = (event: string, message: string, details?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
interface Options {
  drawioXml: string; serverHydrated: boolean; workspaceContentReady: boolean;
  projectWorkspace: Workspace; copilotSessionId: string; messages: ChatMessage[];
  saveLabelRef: MutableRefObject<string>; serverRevisionRef: MutableRefObject<string | null>;
  setLastAction: (message: string) => void; setSaveState: (state: WorkspaceSaveState) => void; onDiagnostic: Diagnostic;
  onAuthoritativeRevision: (xml: string, revision: string) => void;
}
interface SaveResult { saved: boolean; workspaceRevision?: string | null; version?: { id?: string } | null; error?: string; }
interface SaveOptions {
  /** Debounced autosaves must not persist an XML snapshot after the editor or workspace has moved on. */
  onlyIfCurrent?: boolean;
  expectedWorkspaceId?: string | null;
  expectedWorkspaceKey?: string | null;
}
export function useWorkspacePersistence(options: Options) {
  const { drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef, serverRevisionRef, setLastAction, setSaveState, onDiagnostic, onAuthoritativeRevision } = options;
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastPersistedXmlRef = useRef<string | null>(null);
  const lastPersistedVersionIdRef = useRef<string | null>(null);
  const currentXmlRef = useRef(drawioXml);
  const currentWorkspaceIdRef = useRef<string | null>(projectWorkspace?.id ?? null);
  const currentWorkspaceKeyRef = useRef<string | null>(getWorkspaceKey(projectWorkspace));
  const saveConflictRef = useRef<SaveConflict | null>(null);
  const saveEpochRef = useRef(0);
  const pausedAutosaveLoggedRef = useRef(false);
  const lastObservedAutosaveXmlRef = useRef(drawioXml);
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
    if (typeof nextXml === "string") {
      currentXmlRef.current = nextXml;
      lastObservedAutosaveXmlRef.current = nextXml;
    }
    if (alreadyPersisted && typeof nextXml === "string") {
      lastPersistedXmlRef.current = nextXml;
      setSaveState("saved");
    }
    // Invalidate queued operations captured before a server restore/document switch.
    saveEpochRef.current += 1;
    saveConflictRef.current = null;
    pausedAutosaveLoggedRef.current = false;
    if (previous) onDiagnostic("workspace.persist.conflict.cleared",
      "Workspace saving was re-enabled after an authoritative context change",
      { reason, previousWorkspaceKey: previous.workspaceKey,
        currentWorkspaceKey: currentWorkspaceKeyRef.current, conflictingRevision: previous.currentRevision }, "info");
  }, [onDiagnostic, setSaveState]);

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
        if (scheduledSaveEpoch === saveEpochRef.current && scheduledWorkspaceKey === currentWorkspaceKeyRef.current && currentXmlRef.current === xml) {
          setSaveState("saved");
        }
        return {
          saved: false, workspaceRevision: serverRevisionRef.current,
          version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null
        };
      }
      const baseRevision = serverRevisionRef.current;
      setSaveState("saving");
      let response: Response;
      try {
        response = await fetch("/api/workspace/document", {
          method: "PUT", headers: { "content-type": "application/json" },
          body: JSON.stringify({ drawioXml: xml, label, baseRevision })
        });
      } catch (error) {
        if (scheduledSaveEpoch === saveEpochRef.current && scheduledWorkspaceKey === currentWorkspaceKeyRef.current && currentXmlRef.current === xml) {
          setSaveState(saveConflictRef.current ? "conflict" : "failed");
        }
        throw error;
      }
      const payload = await response.json().catch(() => ({})) as SaveResult & { currentRevision?: string | null };
      if (response.status === 409) {
        // A request can finish after restore/workspace-switch invalidated its context.
        // Do not let that old conflict pause the newly authoritative document.
        if (scheduledSaveEpoch !== saveEpochRef.current || scheduledWorkspaceKey !== currentWorkspaceKeyRef.current) {
          const message = "Ignored a save conflict from an outdated document context.";
          onDiagnostic("workspace.persist.stale-conflict.ignored", message, {
            scheduledWorkspaceKey, currentWorkspaceKey: currentWorkspaceKeyRef.current,
            scheduledSaveEpoch, currentSaveEpoch: saveEpochRef.current, xmlLength: xml.length
          }, "warn");
          if (saveOptions?.onlyIfCurrent) {
            return { saved: false, workspaceRevision: serverRevisionRef.current,
              version: lastPersistedVersionIdRef.current ? { id: lastPersistedVersionIdRef.current } : null, error: message };
          }
          throw new Error(message);
        }
        const conflictingRevision = payload.workspaceRevision ?? payload.currentRevision ?? null;
        saveConflictRef.current = {
          workspaceKey: currentWorkspaceKeyRef.current,
          currentRevision: typeof conflictingRevision === "string" ? conflictingRevision : null
        };
        setSaveState("conflict");
        pausedAutosaveLoggedRef.current = false;
        setLastAction("Save conflict: local edits remain in this editor but were not written. Automatic saves are paused; export a copy before restoring or reloading a server version.");
        onDiagnostic("workspace.persist.conflict", "The server rejected a stale diagram save; further automatic saves are paused and the newer revision was preserved", {
          baseRevision, currentRevision: saveConflictRef.current.currentRevision,
          workspaceKey: saveConflictRef.current.workspaceKey, xmlLength: xml.length
        }, "error");
        throw new Error(payload.error || "The diagram changed in another editor. Export the local draft, then restore or reload the latest version before continuing.");
      }
      if (!response.ok) {
        if (scheduledSaveEpoch === saveEpochRef.current && scheduledWorkspaceKey === currentWorkspaceKeyRef.current && currentXmlRef.current === xml) setSaveState("failed");
        throw new Error(payload.error || "HTTP " + response.status + " while saving the document");
      }
      if (typeof payload.workspaceRevision === "string" || payload.workspaceRevision === null) serverRevisionRef.current = payload.workspaceRevision ?? null;
      if (typeof payload.version?.id === "string") lastPersistedVersionIdRef.current = payload.version.id;
      if (payload.saved) {
        lastPersistedXmlRef.current = xml;
        onDiagnostic("workspace.version.persisted", "Document and Draw.io XML revision persisted to the server", {
          versionId: payload.version?.id, revision: serverRevisionRef.current, xmlLength: xml.length
        });
      }
      if (scheduledSaveEpoch === saveEpochRef.current && scheduledWorkspaceKey === currentWorkspaceKeyRef.current && currentXmlRef.current === xml) setSaveState("saved");
      return payload;
    });
    saveQueueRef.current = operation.catch(() => undefined);
    return operation;
  }, [clearSaveConflict, onDiagnostic, setLastAction, setSaveState]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace || lastPersistedXmlRef.current !== null) return;
    if (typeof serverRevisionRef.current === "string") lastPersistedXmlRef.current = drawioXml;
  }, [drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, serverRevisionRef]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace) return;
    // The native Draw.io XML is the complete document. Save it directly without comparing a model projection.
    const expectedWorkspaceId = projectWorkspace.id;
    const expectedWorkspaceKey = getWorkspaceKey(projectWorkspace);
    if (lastObservedAutosaveXmlRef.current !== drawioXml) {
      lastObservedAutosaveXmlRef.current = drawioXml;
      if (!saveConflictRef.current) setSaveState("saving");
    }
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
  }, [drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, persistDocumentNow, saveLabelRef, onDiagnostic, setSaveState]);
  useEffect(() => {
    if (!serverHydrated || !workspaceContentReady || !projectWorkspace) return;
    let active = true;
    let polling = false;
    const workspaceKey = currentWorkspaceKeyRef.current;
    const pollAuthoritativeRevision = async () => {
      if (polling || !active || workspaceKey !== currentWorkspaceKeyRef.current) return;
      polling = true;
      const observedRevision = serverRevisionRef.current;
      const observedXml = currentXmlRef.current;
      try {
        const response = await fetch("/api/workspace/state");
        if (!response.ok) throw new Error("HTTP " + response.status);
        const state = await response.json() as {
          drawioXml?: unknown; workspaceRevision?: unknown; workspaceMismatch?: boolean;
        };
        if (!active || workspaceKey !== currentWorkspaceKeyRef.current || state.workspaceMismatch ||
            typeof state.drawioXml !== "string" || typeof state.workspaceRevision !== "string" ||
            state.workspaceRevision === observedRevision) return;
        if (serverRevisionRef.current !== observedRevision || currentXmlRef.current !== observedXml) return;
        if (lastPersistedXmlRef.current !== observedXml) {
          saveConflictRef.current = { workspaceKey, currentRevision: state.workspaceRevision };
          setSaveState("conflict");
          setLastAction("The server document changed while this editor had unsaved changes. The local draft was preserved; automatic saving is paused until the newer server version is reloaded or the draft is exported.");
          onDiagnostic("workspace.persist.external-revision-conflict",
            "A newer authoritative server revision was detected while local XML differed from the last persisted snapshot; local XML was not overwritten",
            { previousRevision: observedRevision, currentRevision: state.workspaceRevision,
              localXmlLength: observedXml.length, workspaceKey }, "error");
          return;
        }
        const authoritativeXml = state.drawioXml;
        // Invalidate autosaves captured before this server-side commit and update the baseline
        // synchronously before React applies the XML state update.
        saveEpochRef.current += 1;
        currentXmlRef.current = authoritativeXml;
        lastObservedAutosaveXmlRef.current = authoritativeXml;
        lastPersistedXmlRef.current = authoritativeXml;
        serverRevisionRef.current = state.workspaceRevision;
        saveConflictRef.current = null;
        pausedAutosaveLoggedRef.current = false;
        onAuthoritativeRevision(authoritativeXml, state.workspaceRevision);
        setSaveState("saved");
        onDiagnostic("workspace.persist.external-revision-reloaded",
          "Loaded a newer native Draw.io XML revision committed by the server",
          { previousRevision: observedRevision, currentRevision: state.workspaceRevision,
            xmlLength: authoritativeXml.length }, "info");
      } catch (error) {
        if (active) onDiagnostic("workspace.persist.revision-poll.failed",
          "Could not check for newer server-side diagram revisions",
          { errorMessage: error instanceof Error ? error.message : String(error) }, "warn");
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => { void pollAuthoritativeRevision(); }, 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [serverHydrated, workspaceContentReady, projectWorkspace?.id, projectWorkspace?.primaryDiagram,
    onAuthoritativeRevision, onDiagnostic, setLastAction, setSaveState, serverRevisionRef]);

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
