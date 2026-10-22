import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { FIXTURES } from "../model/fixtures";
import type { DiagramDocument } from "../model/types";
import { fromDrawioXml } from "../import/drawio";
import { getDrawioXmlDiagnostics, isDrawioXmlDocument } from "../model/drawio-xml-source";
import { requestServerLayout } from "../api/diagram-operations";
import { recordDiagnostic } from "../diagnostics";
import { selectCompatibleWorkspaceDocument } from "./workspaceHydration";

type ProjectWorkspace = { schemaVersion: 1; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
interface Options {
  projectWorkspace: ProjectWorkspace | null;
  setDocument: Dispatch<SetStateAction<DiagramDocument>>;
  setNativeXmlOverride: Dispatch<SetStateAction<string | null>>;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  setCopilotSessionId: Dispatch<SetStateAction<string>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  historyRef: MutableRefObject<DiagramDocument[]>;
  historyIndexRef: MutableRefObject<number>;
  setCanUndo: (value: boolean) => void;
  setCanRedo: (value: boolean) => void;
  serverRevisionRef: MutableRefObject<string | null>;
  setLastAction: (value: string) => void;
  onDiagnostic: typeof recordDiagnostic;
}
export function useWorkspaceBootstrap(options: Options) {
  const {
    projectWorkspace, setDocument, setNativeXmlOverride, setSelectedNodeId, setCopilotSessionId, setMessages,
    historyRef, historyIndexRef, setCanUndo, setCanRedo, serverRevisionRef, setLastAction, onDiagnostic
  } = options;
  const [serverHydrated, setServerHydrated] = useState(false);
  const [serverDocumentAvailable, setServerDocumentAvailable] = useState(false);
  const [workspaceContentReady, setWorkspaceContentReady] = useState(false);
  const workspaceInitialLoadRef = useRef<string | null>(null);

  const reportXmlDiagnostics = (xml: string, filePath: string | null) => {
    const diagnostics = getDrawioXmlDiagnostics(xml);
    if (diagnostics.issues.length) {
      const message = diagnostics.issues[0];
      setLastAction(message);
      onDiagnostic("drawio.compatibility.validation-failed", message, { path: filePath, issues: diagnostics.issues.slice(0, 10) }, "error");
      return diagnostics;
    }
    if (diagnostics.warnings.length) {
      const message = "Draw.io compatibility: " + diagnostics.warnings.length + " warning(s). " + diagnostics.warnings.slice(0, 2).join(" ");
      setLastAction(message);
      onDiagnostic("drawio.compatibility.warnings", message, {
        path: filePath, pageCount: diagnostics.pageCount,
        warningCount: diagnostics.warnings.length, warnings: diagnostics.warnings.slice(0, 20)
      }, "warn");
    }
    return diagnostics;
  };

  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    fetch("/api/workspace/state")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the server-side workspace (HTTP " + response.status + ")");
        return response.json() as Promise<{ document?: unknown; drawioXml?: unknown; copilotSessionId?: unknown; chatMessages?: unknown[]; workspaceMismatch?: boolean; workspaceRevision?: string | null }>;
      })
      .then((state) => {
        if (!active) return;
        // The persisted semantic document is only a cache. Hydrate the current editing view
        // from the authoritative XML whenever it exists; never restore a cached projection alone.
        const cachedDocument = selectCompatibleWorkspaceDocument(state.document, Boolean(state.workspaceMismatch));
        const authoritativeXml = !state.workspaceMismatch && typeof state.drawioXml === "string" && isDrawioXmlDocument(state.drawioXml)
          ? state.drawioXml : null;
        let savedDocument: DiagramDocument | null = null;
        if (authoritativeXml) {
          reportXmlDiagnostics(authoritativeXml, null);
          const projectionBase = cachedDocument ?? FIXTURES.c4();
          const projection = fromDrawioXml(authoritativeXml, projectionBase);
          savedDocument = projection === projectionBase ? projectionBase : projection;
        }
        setServerDocumentAvailable(Boolean(savedDocument && authoritativeXml));
        serverRevisionRef.current = state.workspaceMismatch || !authoritativeXml
          ? null : typeof state.workspaceRevision === "string" ? state.workspaceRevision : null;
        setWorkspaceContentReady(Boolean(savedDocument && authoritativeXml));
        if (savedDocument && authoritativeXml) {
          setDocument(savedDocument);
          setSelectedNodeId(savedDocument.nodes[0]?.id || null);
          setNativeXmlOverride(authoritativeXml);
          historyRef.current = [savedDocument];
          historyIndexRef.current = 0;
          setCanUndo(false); setCanRedo(false);
          onDiagnostic("workspace.hydrated", "Restored the authoritative Draw.io XML and derived a semantic view", {
            documentId: savedDocument.id, nodeCount: savedDocument.nodes.length,
            xmlLength: authoritativeXml.length, durationMs: Date.now() - startedAt
          });
        }
        if (state.workspaceMismatch) {
          const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "session-" + Math.random().toString(36).slice(2, 8);
          setCopilotSessionId(newSessionId);
          setMessages([{ role: "assistant", id: Date.now(), text: "The project workspace changed, so the previous conversation context was cleared." }]);
        }
        if (typeof state.copilotSessionId === "string" && state.copilotSessionId.length >= 8 && !state.workspaceMismatch) {
          setCopilotSessionId(state.copilotSessionId);
          try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", state.copilotSessionId); } catch { /* Server state remains authoritative. */ }
        }
        if (Array.isArray(state.chatMessages) && state.chatMessages.length && !state.workspaceMismatch) {
          const savedMessages = state.chatMessages.filter((item): item is ChatMessage =>
            !!item && typeof item === "object" &&
            ((item as ChatMessage).role === "assistant" || (item as ChatMessage).role === "user") &&
            typeof (item as ChatMessage).text === "string" && typeof (item as ChatMessage).id === "number"
          ).slice(-2000);
          if (savedMessages.length) setMessages(savedMessages);
        }
        setServerHydrated(true);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setServerDocumentAvailable(false);
        setServerHydrated(true);
        serverRevisionRef.current = null;
        setWorkspaceContentReady(false);
        onDiagnostic("workspace.hydrate.failed", "Could not restore the workspace from the server; loading the configured primary diagram", {
          durationMs: Date.now() - startedAt, errorMessage: error instanceof Error ? error.message : String(error)
        }, "error");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!serverHydrated || !projectWorkspace || serverDocumentAvailable || workspaceInitialLoadRef.current === projectWorkspace.id) return;
    let active = true;
    workspaceInitialLoadRef.current = projectWorkspace.id;
    const load = async () => {
      try {
        if (projectWorkspace.primaryDiagram && /\.(drawio|dio|xml)$/i.test(projectWorkspace.primaryDiagram)) {
          const response = await fetch("/api/workspace/files/content?path=" + encodeURIComponent(projectWorkspace.primaryDiagram));
          const result = await response.json() as { error?: string; content?: string };
          if (!response.ok || typeof result.content !== "string") throw new Error(result.error || "Could not load the primary Draw.io diagram");
          const baseDocument = FIXTURES.c4();
          const xmlDiagnostics = reportXmlDiagnostics(result.content, projectWorkspace.primaryDiagram);
          if (xmlDiagnostics.issues.length) throw new Error(xmlDiagnostics.issues[0]);
          const parsedDocument = fromDrawioXml(result.content, baseDocument);
          // A valid native document remains openable even when the partial semantic projection
          // cannot represent any of its cells. The original XML remains authoritative.
          const imported = parsedDocument === baseDocument ? baseDocument : parsedDocument;
          if (!active) return;
          setDocument(imported); setNativeXmlOverride(result.content); setSelectedNodeId(imported.nodes[0]?.id || null);
          historyRef.current = [imported]; historyIndexRef.current = 0; setCanUndo(false); setCanRedo(false);
          setServerDocumentAvailable(true); setWorkspaceContentReady(true);
          onDiagnostic("workspace.primary-diagram.loaded", "Loaded the primary Draw.io diagram from the project workspace", { workspaceId: projectWorkspace.id, path: projectWorkspace.primaryDiagram, xmlLength: result.content.length });
        } else {
          const laidOut = await requestServerLayout(FIXTURES.c4());
          if (!active) return;
          setDocument(laidOut); setNativeXmlOverride(null); setSelectedNodeId(laidOut.nodes[0]?.id || null);
          historyRef.current = [laidOut]; historyIndexRef.current = 0; setCanUndo(false); setCanRedo(false);
          setWorkspaceContentReady(true);
        }
      } catch (error) {
        if (active) {
          setWorkspaceContentReady(false);
          onDiagnostic("workspace.primary-diagram.load.failed", "Could not load the workspace primary diagram; automatic persistence remains disabled", {
            workspaceId: projectWorkspace.id, primaryDiagram: projectWorkspace.primaryDiagram,
            errorMessage: error instanceof Error ? error.message : String(error)
          }, "error");
        }
      }
    };
    void load();
    return () => { active = false; };
  }, [serverHydrated, projectWorkspace, serverDocumentAvailable]);

  return { serverHydrated, workspaceContentReady, setWorkspaceContentReady, setServerDocumentAvailable, workspaceInitialLoadRef };
}
