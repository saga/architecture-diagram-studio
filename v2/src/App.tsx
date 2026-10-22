import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Checkbox, ConfigProvider, Input, Layout, Modal, Select, theme as antdTheme } from "antd";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import type { ButtonHTMLAttributes, ChangeEvent, CSSProperties, InputHTMLAttributes, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { hasStackedGeometry, isDiagramDocument } from "./model/types";
import type { DiagramDocument, DiagramKind, DiagramNode, SequenceFragment } from "./model/types";
import { FIXTURES } from "./model/fixtures";
import { moveNode } from "./layout/move";
import { LAYOUT_PROFILES } from "./layout/profiles";
import { useCopilotIntent } from "./hooks/useCopilotIntent";
import type { AppliedDiagramEdit } from "./intent/aiProvider";
import { downloadText, toDrawioXml } from "./export/drawio";
import { fromDrawioXml } from "./import/drawio";
import { canApplySemanticEdits, getDrawioXmlDiagnostics, isDrawioXmlDocument, patchDrawioXml, preserveDrawioThemeMetadata } from "./model/drawio-xml-source";
import { roleLabels } from "./design/tokens";
import DrawioFrame from "./components/DrawioFrame";
import WorkspacePages, { type WorkspacePage } from "./components/WorkspacePages";
import { readDiagnosticEntries, recordDiagnostic } from "./diagnostics";
import type { DiagnosticEntry } from "./diagnostics";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useWorkspaceBootstrap } from "./hooks/useWorkspaceBootstrap";
import { useDiagramEditing } from "./hooks/useDiagramEditing";
import { requestServerLayout, layoutSample } from "./api/diagram-operations";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type VersionSummary = { id: string; createdAt: string; label: string; documentId: string | null; title: string | null };
type ProjectWorkspace = { schemaVersion: 1; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
type WorkspaceFile = { path: string; name: string; kind: "diagram" | "code" | "document" | "other"; size: number; modifiedAt: string };
type SavedAISettings = { baseUrl: string; model: string; reasoningEffort: "high" | "max" };
type UiTheme = "editorial" | "youth" | "warm" | "midnight";
/** Ant Design primary colour per theme, so library-rendered controls match the studio palette. */
const THEME_ACCENTS: Record<UiTheme, string> = { editorial: "#425bc7", youth: "#b91f6d", warm: "#ad4d32", midnight: "#4b61ce" };
function loadSavedTheme(): UiTheme {
  try {
    const storageKey = "architecture-diagram-studio:v2:ui-theme";
    const versionKey = "architecture-diagram-studio:v2:ui-theme-version";
    const saved = window.localStorage.getItem(storageKey);
    const migrated = window.localStorage.getItem(versionKey) === "2";
    // "editorial" was the cold, low-contrast default before the theme chooser existed.
    // Migrate that default once, while preserving an already-selected vibrant/warm/dark theme.
    if (saved === "editorial" && !migrated) return "warm";
    if (saved === "editorial" || saved === "youth" || saved === "warm" || saved === "midnight") return saved;
  } catch { /* Theme selection is optional when browser storage is disabled. */ }
  return "warm";
}
type PanelWidths = { left: number; right: number };
type CanvasMenu = { x: number; y: number; kind: "node" | "relation" | "fragment" | "boundary" | "canvas"; id?: string };
const PANEL_LIMITS: Record<keyof PanelWidths, [number, number]> = { left: [190, 420], right: [300, 620] };
const PANEL_STORAGE_KEY = "architecture-diagram-studio:v2:panel-widths";
function loadPanelWidths(): PanelWidths {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelWidths>;
      if (typeof parsed.left === "number" && typeof parsed.right === "number") return { left: parsed.left, right: parsed.right };
    }
  } catch { /* Fall back to the default sidebar widths. */ }
  return { left: 240, right: 380 };
}

function loadSavedAISettings(): SavedAISettings {  try {
    const saved = window.localStorage.getItem("architecture-diagram-studio:v2:ai-provider");
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<SavedAISettings>;
      return { baseUrl: "copilot-sdk", model: typeof parsed.model === "string" && parsed.model !== "gpt-5" ? parsed.model : "claude-sonnet-5.5", reasoningEffort: parsed.reasoningEffort === "high" ? "high" : "max" };
    }
  } catch {
    // The page can still use deterministic local rules when browser storage is unavailable.
  }
  return { baseUrl: "copilot-sdk", model: "claude-sonnet-5.5", reasoningEffort: "max" };
}
/** Ant Design Button adapter preserving existing HTML button semantics during UI migration. */
function UiButton({ type, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...(props as any)} htmlType={type === "submit" ? "submit" : "button"} />;
}

function UiInput({ ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  if (props.type === "file") return <input {...props} ref={ref} />;
  if (props.type === "checkbox") return <Checkbox {...(props as any)} />;
  return <Input {...(props as any)} />;
}

function UiTextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Input.TextArea {...(props as any)} />;
}

function UiSelect({ children, onChange, value, defaultValue, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { popupMatchSelectWidth?: boolean }) {
  const options = Children.toArray(children).filter(isValidElement).map((child) => {
    const option = child as ReactElement<{ value?: string; disabled?: boolean; children?: ReactNode }>;
    return { value: option.props.value ?? "", label: option.props.children, disabled: option.props.disabled };
  });
  return <Select {...(props as any)} value={value as string | undefined} defaultValue={defaultValue as string | undefined}
    options={options} onChange={(nextValue) => onChange?.({ target: { value: nextValue } } as unknown as ChangeEvent<HTMLSelectElement>)} />;
}

function newId(prefix: string): string { return prefix + "-" + Math.random().toString(36).slice(2, 8); }

export default function App() {
  // The server-derived XML projection is authoritative; browser storage keeps preferences only.
  const [document, setDocument] = useState<DiagramDocument>(() => FIXTURES.c4());
  useEffect(() => {
    // Clean up the previous application's persisted semantic cache after switching to XML-only storage.
    try { window.localStorage.removeItem("architecture-diagram-studio:v2:document"); } catch { /* Storage may be disabled. */ }
  }, []);
  const [previewDocument, setPreviewDocument] = useState<DiagramDocument | null>(null);
  const [pendingAgentProposalId, setPendingAgentProposalId] = useState<string | null>(null);
  const [previewSummary, setPreviewSummary] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("domain");
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<"properties" | "quality" | "design" | "copilot">("properties");
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadSavedTheme());
  const [enabledLayoutProfiles, setEnabledLayoutProfiles] = useState<string[]>(LAYOUT_PROFILES.map((profile) => profile.value));
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => loadPanelWidths());
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu | null>(null);
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState<WorkspacePage>("diagram");
  const [traceEntries, setTraceEntries] = useState<DiagnosticEntry[]>(() => readDiagnosticEntries());
  const [drawioStatus, setDrawioStatus] = useState<"unknown" | "checking" | "ready" | "missing" | "error">("unknown");
  const [drawioStatusMessage, setDrawioStatusMessage] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [copilotSessionId, setCopilotSessionId] = useState(() => {
    try {
      const key = "architecture-diagram-studio:v2:copilot-session-id";
      const saved = window.localStorage.getItem(key);
      if (saved) return saved;
      const created = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session");
      window.localStorage.setItem(key, created);
      return created;
    } catch {
      return newId("session");
    }
  });

  const [chatBusy, setChatBusy] = useState(false);
  const [savedAISettings] = useState<SavedAISettings>(() => loadSavedAISettings());
  const [aiBaseUrl, setAiBaseUrl] = useState(savedAISettings.baseUrl);
  const [aiModel, setAiModel] = useState(savedAISettings.model);
  const [reasoningEffort, setReasoningEffort] = useState<"high" | "max">(savedAISettings.reasoningEffort);
  const [aiApiKey, setAiApiKey] = useState("");
  // Transcripts persisted by older sessions may open with a greeting that no longer exists;
  // drop it so a restored conversation starts with real content.
  const LEGACY_GREETING_PREFIXES = ["描述想要的布局变化即可", "Describe the layout change you want"];
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const initial: ChatMessage[] = [];
    try {
      const saved = window.localStorage.getItem("architecture-diagram-studio:v2:chat-messages");
      if (!saved) return initial;
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed)) return initial;
      const restored = parsed.filter((item): item is ChatMessage =>
        !!item && typeof item === "object" &&
        ((item as ChatMessage).role === "assistant" || (item as ChatMessage).role === "user") &&
        typeof (item as ChatMessage).text === "string" &&
        typeof (item as ChatMessage).id === "number"
      ).filter((item) => !(item.role === "assistant" && item.id === 1 && LEGACY_GREETING_PREFIXES.some((prefix) => item.text.startsWith(prefix))));
      return restored.slice(-300);
    } catch {
      return initial;
    }
  });
  const [versionHistoryOpen, setVersionHistoryOpen] = useState(false);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false);
  const [versionEntries, setVersionEntries] = useState<VersionSummary[]>([]);
  const [revision, setRevision] = useState(1);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const historyRef = useRef<DiagramDocument[]>([document]);
  const historyIndexRef = useRef(0);
  /** Guards the auto-heal effect so the repair runs at most once per page load. */
  const geometryHealRef = useRef(false);
  /** Latest document, readable from effects that must not re-subscribe on every edit. */
  const documentRef = useRef(document);
  documentRef.current = document;
  const [lastAction, setLastAction] = useState("Studio Editorial sample loaded");
  const [isLayoutting, setIsLayoutting] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const openExistingFileRef = useRef<HTMLInputElement>(null);
  const [standaloneFileHandle, setStandaloneFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [standaloneFileName, setStandaloneFileName] = useState<string | null>(null);
  const standaloneLastSavedXmlRef = useRef<string | null>(null);

  const visibleDocument = previewDocument || document;
  const selectedNode = document.nodes.find((node) => node.id === selectedNodeId) || null;
  const selectedRelation = document.relations.find((relation) => relation.id === selectedRelationId) || null;
  const [quality, setQuality] = useState<import("./model/types").LayoutQualityReport | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/workspace/diagram/quality", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: visibleDocument }) })
      .then(async (response) => { if (!response.ok) throw new Error("Layout quality evaluation failed"); return response.json() as Promise<{ report: import("./model/types").LayoutQualityReport }>; })
      .then(({ report }) => { if (!cancelled) setQuality(report); })
      .catch(() => { if (!cancelled) setQuality(null); });
    return () => { cancelled = true; };
  }, [visibleDocument]);
  // The native XML is authoritative. The semantic XML is only a disposable projection.
  const generatedDrawioXml = useMemo(() => toDrawioXml(document), [document]);
  const [nativeXmlOverride, setNativeXmlOverride] = useState<string | null>(null);
  const serverRevisionRef = useRef<string | null>(null);
  const serverCommittedDocumentRef = useRef<{ document: DiagramDocument; workspaceId: string | null } | null>(null);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [workspaceChecking, setWorkspaceChecking] = useState(true);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceLaunchMode, setWorkspaceLaunchMode] = useState<"open" | "create">("open");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceRootPath, setWorkspaceRootPath] = useState("");
  const [workspacePrimaryDiagram, setWorkspacePrimaryDiagram] = useState("");
  const [workspaceNewDiagramName, setWorkspaceNewDiagramName] = useState("architecture.drawio");
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  useEffect(() => {
    let active = true;
    void fetch("/api/workspace/configuration")
      .then(async (response) => { if (!response.ok) throw new Error("Could not read the Studio configuration"); return response.json() as Promise<{ config?: { layoutProfiles?: string[]; model?: string; reasoningEffort?: "high" | "max" }; revisions?: number; hasRuntimeSettings?: boolean }>; })
      .then(async (payload) => {
        if (!active || !payload.config) return;
        if (Array.isArray(payload.config.layoutProfiles) && payload.config.layoutProfiles.length) setEnabledLayoutProfiles(payload.config.layoutProfiles);
        // Migrate the previous browser-only model preference into the authoritative server JSONL config once.
        if (!payload.hasRuntimeSettings) {
          const response = await fetch("/api/workspace/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { model: savedAISettings.model, reasoningEffort: savedAISettings.reasoningEffort } }) });
          const migrated = await response.json() as { config?: { model?: string; reasoningEffort?: "high" | "max" }; error?: string };
          if (!response.ok || !migrated.config) throw new Error(migrated.error || "Migrating the model settings failed");
          if (active) { setAiModel(migrated.config.model || ""); setReasoningEffort(migrated.config.reasoningEffort || "max"); }
        } else {
          if (active && typeof payload.config.model === "string") setAiModel(payload.config.model);
          if (active && (payload.config.reasoningEffort === "high" || payload.config.reasoningEffort === "max")) setReasoningEffort(payload.config.reasoningEffort);
        }
      })
      .catch((error) => { if (active) recordDiagnostic("settings.configuration.load.failed", "Could not load the versioned server configuration", { errorMessage: error instanceof Error ? error.message : String(error) }, "error"); });
    return () => { active = false; };
  }, []);
  const [workspaceError, setWorkspaceError] = useState("");
  const nextSaveLabelRef = useRef("Autosave");
  const drawioXml = nativeXmlOverride ?? generatedDrawioXml;
  const semanticEditingSafe = canApplySemanticEdits(drawioXml, generatedDrawioXml, document);
  const previewDrawioXml = previewDocument && semanticEditingSafe
    ? patchDrawioXml(drawioXml, toDrawioXml(previewDocument), document)
    : null;
  const bootstrap = useWorkspaceBootstrap({
    projectWorkspace, setDocument, setNativeXmlOverride, setSelectedNodeId, setCopilotSessionId, setMessages,
    historyRef, historyIndexRef, setCanUndo, setCanRedo, serverRevisionRef, setLastAction, onDiagnostic: recordDiagnostic
  });
  const { serverHydrated, workspaceContentReady, setWorkspaceContentReady, setServerDocumentAvailable, workspaceInitialLoadRef } = bootstrap;
  const { persistDocumentNow } = useWorkspacePersistence({ document, drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef: nextSaveLabelRef, serverRevisionRef, serverCommittedDocumentRef, setLastAction, onDiagnostic: recordDiagnostic });

  // The native Draw.io editor is the only canvas. Unsupported native XML disables
  // semantic edits, while preserving full native editing and the original XML.

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/config").then(async (response) => { if (!response.ok) throw new Error("Could not read the project workspace configuration"); return response.json() as Promise<{ configured?: boolean; workspace?: ProjectWorkspace | null; suggestedRootPath?: string }>; }).then((result) => { if (!active) return; const workspace = result.workspace || null; setProjectWorkspace(workspace); setWorkspaceSetupOpen(!workspace || !workspace.primaryDiagram); if (!workspace && result.suggestedRootPath) { setWorkspaceRootPath(result.suggestedRootPath); setWorkspaceName(result.suggestedRootPath.split(/[\\/]/).filter(Boolean).pop() || "Project Workspace"); } if (workspace) { setWorkspaceName(workspace.name); setWorkspaceRootPath(workspace.rootPath); setWorkspacePrimaryDiagram(workspace.primaryDiagram || ""); void fetch("/api/workspace/files").then((response) => response.ok ? response.json() as Promise<{ files?: WorkspaceFile[] }> : Promise.resolve({ files: [] })).then((result) => { if (active) setWorkspaceFiles(result.files || []); }).catch(() => undefined); } }).catch((error) => { if (!active) return; setWorkspaceError(error instanceof Error ? error.message : String(error)); setWorkspaceSetupOpen(true); }).finally(() => { if (active) setWorkspaceChecking(false); });
    return () => { active = false; };
  }, []);

  async function saveProjectWorkspace(selectedDiagramPath?: string, requestedMode: "open" | "create" = workspaceLaunchMode) {
    const previousContentReady = workspaceContentReady;
    let serverActiveContextChanged = false;
    setWorkspaceSaving(true); setWorkspaceContentReady(false); setWorkspaceError("");
    try {
      // Flush the current file before the workspace's active diagram changes; the debounced autosave
      // is intentionally paused while the launch dialog is working.
      if (workspaceContentReady && projectWorkspace?.primaryDiagram && drawioXml.trim()) {
        await persistDocumentNow(document, drawioXml, "Autosave before changing the active diagram");
      }
      if (requestedMode === "create") {
        const response = await fetch("/api/workspace/diagram/create", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath, fileName: workspaceNewDiagramName, renderTheme: uiTheme })
        });
        const result = await response.json() as {
          error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[];
          document?: DiagramDocument; drawioXml?: string; workspaceRevision?: string;
          version?: { id: string; createdAt: string; label: string };
        };
        serverActiveContextChanged = response.ok;
        if (!response.ok || !result.workspace || !result.document || typeof result.drawioXml !== "string" || typeof result.workspaceRevision !== "string") {
          throw new Error(result.error || "Creating the Draw.io file failed");
        }
        const nextWorkspace = result.workspace, nextDocument = result.document;
        setDocument(nextDocument); setSelectedNodeId(null);
        historyRef.current = [nextDocument]; historyIndexRef.current = 0;
        setCanUndo(false); setCanRedo(false);
        setNativeXmlOverride(result.drawioXml);
        setProjectWorkspace(nextWorkspace); setStandaloneFileHandle(null); setStandaloneFileName(null); standaloneLastSavedXmlRef.current = null; setWorkspaceFiles(result.files || []);
        setWorkspaceName(nextWorkspace.name); setWorkspaceRootPath(nextWorkspace.rootPath);
        setWorkspacePrimaryDiagram(nextWorkspace.primaryDiagram || "");
        const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session");
        setCopilotSessionId(newSessionId);
        setMessages([{ role: "assistant", id: Date.now(), text: "Created a new Draw.io diagram. The project workspace remains the folder; this file is the active diagram." }]);
        serverRevisionRef.current = result.workspaceRevision;
        serverCommittedDocumentRef.current = { document: nextDocument, workspaceId: nextWorkspace.id };
        workspaceInitialLoadRef.current = nextWorkspace.id;
        setServerDocumentAvailable(true); setWorkspaceContentReady(true);
        setWorkspaceLaunchMode("open"); setWorkspaceSetupOpen(false);
        recordDiagnostic("workspace.diagram.created", "Created a new Draw.io file and opened it", {
          workspaceId: nextWorkspace.id, rootPath: nextWorkspace.rootPath, primaryDiagram: nextWorkspace.primaryDiagram,
          versionId: result.version?.id, nodeCount: nextDocument.nodes.length
        });
        return;
      }

      const targetDiagramPath = selectedDiagramPath || workspacePrimaryDiagram;
      if (!targetDiagramPath) throw new Error("Select an existing Draw.io file to open.");
      const response = await fetch("/api/workspace/config", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath, primaryDiagram: targetDiagramPath })
      });
      const result = await response.json() as {
        error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[];
        counts?: { files: number; diagrams: number; code: number; documents: number };
      };
      if (!response.ok || !result.workspace) throw new Error(result.error || "Opening the Draw.io workspace failed");
      const nextWorkspace = result.workspace;
      let nextDocument = document, nextXml: string | null = nativeXmlOverride;
      const workspaceChanged = projectWorkspace?.id !== nextWorkspace.id;
      const diagramChanged = projectWorkspace?.id === nextWorkspace.id && projectWorkspace?.primaryDiagram !== nextWorkspace.primaryDiagram;
      const diagramContextChanged = workspaceChanged || diagramChanged;
      serverActiveContextChanged = diagramContextChanged;
      if (diagramContextChanged) {
        setMessages([{ role: "assistant", id: Date.now(), text: "Opened a different Draw.io diagram. The previous diagram's chat context and edit history are no longer active." }]);
        const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session");
        setCopilotSessionId(newSessionId);
        serverRevisionRef.current = null; serverCommittedDocumentRef.current = null;
      }
      if (nextWorkspace.primaryDiagram && /\.(drawio|dio|xml)$/i.test(nextWorkspace.primaryDiagram)) {
        const fileResponse = await fetch("/api/workspace/files/content?path=" + encodeURIComponent(nextWorkspace.primaryDiagram));
        const fileResult = await fileResponse.json() as { error?: string; content?: string };
        if (!fileResponse.ok || typeof fileResult.content !== "string") throw new Error(fileResult.error || "Could not read the selected Draw.io file");
        nextXml = fileResult.content;
        const xmlDiagnostics = getDrawioXmlDiagnostics(fileResult.content);
        if (xmlDiagnostics.issues.length) throw new Error(xmlDiagnostics.issues[0]);
        if (xmlDiagnostics.warnings.length) {
          const message = "Opened Draw.io with " + xmlDiagnostics.warnings.length + " compatibility warning(s): " + xmlDiagnostics.warnings.slice(0, 2).join(" ");
          setLastAction(message);
          recordDiagnostic("drawio.compatibility.warnings", message, {
            path: nextWorkspace.primaryDiagram, pageCount: xmlDiagnostics.pageCount,
            warningCount: xmlDiagnostics.warnings.length, warnings: xmlDiagnostics.warnings.slice(0, 20)
          }, "warn");
        }
        const importBaseDocument = diagramContextChanged ? { ...FIXTURES.c4(), renderTheme: uiTheme } : document;
        const parsedDocument = fromDrawioXml(fileResult.content, importBaseDocument);
        if (parsedDocument === importBaseDocument) throw new Error("The file passed XML validation but could not be represented by the supported semantic projection.");
        // Opening a Draw.io file must preserve its geometry; semantic normalization is an explicit action only.
        nextDocument = parsedDocument;
      } else if (workspaceChanged) {
        nextDocument = await layoutSample(FIXTURES.c4()); nextXml = null;
      }
      if (nextDocument !== document) {
        setDocument(nextDocument); setSelectedNodeId(nextDocument.nodes[0]?.id || null);
        historyRef.current = [nextDocument]; historyIndexRef.current = 0;
        setCanUndo(false); setCanRedo(false);
      }
      setNativeXmlOverride(nextXml);
      // Opening a file is an explicit refresh, so don't let a prior Copilot receipt suppress
      // persistence if the native XML changed while the app was open.
      serverCommittedDocumentRef.current = null;
      workspaceInitialLoadRef.current = nextWorkspace.id;
      setServerDocumentAvailable(true); setProjectWorkspace(nextWorkspace); setStandaloneFileHandle(null); setStandaloneFileName(null); standaloneLastSavedXmlRef.current = null; setWorkspaceFiles(result.files || workspaceFiles);
      setWorkspacePrimaryDiagram(nextWorkspace.primaryDiagram || "");
      setWorkspaceSetupOpen(false); setWorkspaceContentReady(true); setWorkspaceLaunchMode("open");
      recordDiagnostic("workspace.diagram.opened", "Opened an existing Draw.io file in the project workspace", {
        workspaceId: nextWorkspace.id, rootPath: nextWorkspace.rootPath, primaryDiagram: nextWorkspace.primaryDiagram,
        ...(result.counts || {})
      });
    } catch (error) {
      setWorkspaceContentReady(serverActiveContextChanged ? false : previousContentReady);
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    } finally { setWorkspaceSaving(false); }
  }

  useEffect(() => {
    const refreshTraces = () => {
      void fetch("/api/workspace/logs?limit=1200")
        .then(async (response) => {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json() as Promise<{ logs?: Array<Record<string, unknown>> }>;
        })
        .then((result) => {
          const serverEntries: DiagnosticEntry[] = (result.logs || []).flatMap((item) => {
            if (typeof item.event !== "string" || typeof item.message !== "string") return [];
            return [{
              id: typeof item.id === "string" ? item.id : String(item.receivedAt || Date.now()),
              timestamp: typeof item.clientTimestamp === "string" ? item.clientTimestamp : String(item.receivedAt || ""),
              level: ["debug", "info", "warn", "error"].includes(String(item.level)) ? item.level as DiagnosticEntry["level"] : "info",
              event: item.event,
              message: item.message,
              details: item.details && typeof item.details === "object" ? item.details as Record<string, unknown> : {}
            }];
          });
          const byId = new Map<string, DiagnosticEntry>();
          for (const entry of [...serverEntries, ...readDiagnosticEntries()]) byId.set(entry.id, entry);
          setTraceEntries([...byId.values()].slice(-1200));
        })
        .catch(() => setTraceEntries(readDiagnosticEntries()));
    };
    const handleWindowError = (event: ErrorEvent) => {
      recordDiagnostic("runtime.window.error", "Uncaught browser runtime error", {
        errorMessage: event.message, fileName: event.filename, line: event.lineno, column: event.colno
      }, "error");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      recordDiagnostic("runtime.unhandled_rejection", "Unhandled promise rejection", {
        reasonType: reason instanceof Error ? reason.name : typeof reason,
        reasonMessage: reason instanceof Error ? reason.message : String(reason).slice(0, 250)
      }, "error");
    };
    window.addEventListener("studio:diagnostic", refreshTraces);
    window.addEventListener("studio:diagnostic-clear", refreshTraces);
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    recordDiagnostic("app.started", "V2 workspace started", {
      diagramKind: document.kind, nodeCount: document.nodes.length, relationCount: document.relations.length
    });
    return () => {
      window.removeEventListener("studio:diagnostic", refreshTraces);
      window.removeEventListener("studio:diagnostic-clear", refreshTraces);
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);


  useEffect(() => {
    if (!standaloneFileHandle || !standaloneFileName || !drawioXml || drawioXml === standaloneLastSavedXmlRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const writable = await standaloneFileHandle.createWritable();
          await writable.write(drawioXml);
          await writable.close();
          if (cancelled) return;
          standaloneLastSavedXmlRef.current = drawioXml;
          setLastAction("Saved " + standaloneFileName);
          recordDiagnostic("drawio.standalone.autosaved", "Standalone Draw.io XML saved directly to the opened local file", { fileName: standaloneFileName, xmlLength: drawioXml.length });
        } catch (error) {
          if (cancelled) return;
          setLastAction("Autosave failed for " + standaloneFileName + ": " + (error instanceof Error ? error.message : String(error)) + ". Use Export to save a copy.");
          recordDiagnostic("drawio.standalone.autosave.failed", "Could not write the standalone Draw.io file", { fileName: standaloneFileName, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
        }
      })();
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [drawioXml, standaloneFileHandle, standaloneFileName]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(panelWidths));
    } catch {
      // Resized widths stay for this session only.
    }
  }, [panelWidths]);

  useEffect(() => {
    if (!canvasMenu) return;
    const close = () => setCanvasMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { close(); setConnectionSourceId(null); }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [canvasMenu]);

  useEffect(() => {
    if (!connectionSourceId) return;
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setConnectionSourceId(null);
        setLastAction("Connection cancelled");
      }
    };
    window.addEventListener("keydown", cancelOnEscape);
    return () => window.removeEventListener("keydown", cancelOnEscape);
  }, [connectionSourceId]);

  useEffect(() => {
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:chat-messages", JSON.stringify(messages.slice(-300)));
    } catch {
      // Keep the active conversation usable if browser storage is unavailable.
    }
  }, [messages]);

  useEffect(() => {
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:ui-theme", uiTheme);
      window.localStorage.setItem("architecture-diagram-studio:v2:ui-theme-version", "2");
    } catch {
      // The selected theme remains active in memory for this session.
    }
    recordDiagnostic("ui.theme.changed", "Updated the interface colour theme", { theme: uiTheme });
  }, [uiTheme]);

  const commitDocument = useCallback((next: DiagramDocument, action: string, preservedNativeXml?: string) => {
    let nextXml = preservedNativeXml;
    if (nextXml === undefined) {
      if (!semanticEditingSafe) {
        const message = "Semantic editing is disabled because this Draw.io XML contains cells or structure that cannot be safely round-tripped. Continue editing in the native Draw.io canvas.";
        setLastAction(message);
        recordDiagnostic("drawio.semantic-edit.blocked", message, { documentId: document.id, action }, "warn");
        return;
      }
      nextXml = patchDrawioXml(drawioXml, toDrawioXml(next), document) ?? undefined;
      if (nextXml === undefined) {
        const message = "The semantic edit was not applied because the native XML could not be patched safely.";
        setLastAction(message);
        recordDiagnostic("drawio.semantic-patch.failed", message, { documentId: document.id, action }, "error");
        return;
      }
    }
    nextSaveLabelRef.current = action;
    setPreviewDocument(null);
    setPreviewSummary("");
    setNativeXmlOverride(nextXml);
    const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), next].slice(-50);
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(false);
    setDocument(next);
    setRevision((value) => value + 1);
    setLastAction(action);
    recordDiagnostic("diagram.change.committed", "The diagram projection was updated and patched into the authoritative Draw.io XML", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length,
      hasPreview: false, preservedNativeXml: Boolean(preservedNativeXml), xmlLength: nextXml.length
    });
  }, [document, drawioXml, semanticEditingSafe]);

  /** Updates the document in place: the current history entry is replaced instead of pushing a new step. */
  const replaceDocument = useCallback((next: DiagramDocument) => {
    if (semanticEditingSafe) {
      const patchedXml = patchDrawioXml(drawioXml, toDrawioXml(next), document);
      if (!patchedXml) {
        setLastAction("The update was not applied because the authoritative Draw.io XML could not be patched safely.");
        recordDiagnostic("drawio.semantic-patch.failed", "A replacement update was refused because XML cell patching was unsafe", { documentId: document.id }, "error");
        return;
      }
      setNativeXmlOverride(patchedXml);
    }
    const index = historyIndexRef.current;
    if (index >= 0) historyRef.current = [...historyRef.current.slice(0, index), next];
    setDocument(next);
    setRevision((value) => value + 1);
  }, [document, drawioXml, semanticEditingSafe]);

  // The color theme is a workspace/UI preference, not a property of an individual diagram.
  // In particular, never synchronize it back from an imported document: doing so made every
  // theme selection immediately revert to the document's previous renderTheme.
  useEffect(() => {
    if (!serverHydrated || document.renderTheme) return;
    replaceDocument({ ...document, renderTheme: uiTheme });
  }, [serverHydrated, document, uiTheme, replaceDocument]);

  /**
   * Heals a document that is already broken on disk or in the browser draft: an earlier build could persist
   * a fixture before it was laid out, and every later reload restored the stack of nodes on one spot.
   *
   * Runs once, after hydration, on whatever document the server handed back — the layouts of new documents
   * are already computed by the paths that create them.
   */
  useEffect(() => {
    if (!serverHydrated || geometryHealRef.current || !semanticEditingSafe) return;
    geometryHealRef.current = true;
    const current = documentRef.current;
    if (!hasStackedGeometry(current)) return;
    void layoutSample(current).then((laidOut) => {
      if (hasStackedGeometry(laidOut) || documentRef.current.id !== current.id) return;
      commitDocument(laidOut, "Nodes shared a position, so the layout was computed automatically");
      recordDiagnostic("diagram.layout.auto-healed", "Nodes shared a position; layout computed automatically", {
        documentId: laidOut.id, diagramKind: laidOut.kind, nodeCount: laidOut.nodes.length
      }, "warn");
    }).catch((error: unknown) => {
      geometryHealRef.current = false;
      recordDiagnostic("diagram.layout.auto-heal.failed", "Automatic layout repair failed", {
        documentId: current.id, errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
    });
  }, [serverHydrated, commitDocument]);

  const runLayout = useCallback(async (source: DiagramDocument = document) => {
    const startedAt = Date.now();
    recordDiagnostic("layout.run.started", "Started recomputing layout, routing, and overlap repair", {
      diagramKind: source.kind, nodeCount: source.nodes.length, relationCount: source.relations.length,
      routing: source.layout.routing, profile: source.layout.profile
    });
    setIsLayoutting(true);
    try {
      const next = await requestServerLayout(source);
      recordDiagnostic("layout.run.completed", "Layout computed", {
        durationMs: Date.now() - startedAt, nodeCount: next.nodes.length, relationCount: next.relations.length,
        routing: next.layout.routing, profile: next.layout.profile
      });
      commitDocument(next, "Recomputed layout and routing, and repaired overlaps");
    } catch (error) {
      recordDiagnostic("layout.run.failed", "Layout computation failed", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("Layout failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setIsLayoutting(false);
    }
  }, [commitDocument, document]);

  function undoDocument() {
    if (!semanticEditingSafe) { setLastAction("Undo is available in the native Draw.io editor for this document."); return; }
    if (historyIndexRef.current <= 0) return;
    const previous = historyRef.current[historyIndexRef.current - 1];
    const restoredXml = patchDrawioXml(drawioXml, toDrawioXml(previous), document);
    if (!restoredXml) { setLastAction("Undo was refused because the native XML could not be patched safely."); return; }
    setSelectedRelationId(null);
    historyIndexRef.current -= 1;
    setPreviewDocument(null);
    setPreviewSummary("");
    setNativeXmlOverride(restoredXml);
    setDocument(previous);
    setSelectedNodeId((current) => previous.nodes.some((node) => node.id === current) ? current : previous.nodes[0]?.id || null);
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(true);
    setRevision((value) => value + 1);
    setLastAction("Undid to the previous revision");
    recordDiagnostic("diagram.history.undo", "Undid to the previous revision", {
      diagramKind: previous.kind, nodeCount: previous.nodes.length, relationCount: previous.relations.length
    });
  }

  function redoDocument() {
    if (!semanticEditingSafe) { setLastAction("Redo is available in the native Draw.io editor for this document."); return; }
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    const next = historyRef.current[historyIndexRef.current + 1];
    const restoredXml = patchDrawioXml(drawioXml, toDrawioXml(next), document);
    if (!restoredXml) { setLastAction("Redo was refused because the native XML could not be patched safely."); return; }
    setSelectedRelationId(null);
    historyIndexRef.current += 1;
    setPreviewDocument(null);
    setPreviewSummary("");
    setNativeXmlOverride(restoredXml);
    setDocument(next);
    setSelectedNodeId((current) => next.nodes.some((node) => node.id === current) ? current : next.nodes[0]?.id || null);
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    setRevision((value) => value + 1);
    setLastAction("Redid to the next revision");
    recordDiagnostic("diagram.history.redo", "Redid to the next revision", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length
    });
  }

  function changeKind(kind: DiagramKind) {
    if (!semanticEditingSafe) { setLastAction("Create a new diagram before switching semantic diagram types; this native XML is preserved unchanged."); return; }
    setPreviewDocument(null);
    setPreviewSummary("");
    setSelectedRelationId(null);
    const label = "Switched to " + (kind === "c4" ? "C4 diagram" : kind === "sequence" ? "sequence diagram" : "flowchart");
    // Fixtures carry no coordinates, so the layout has to exist before the first paint; committing the
    // raw fixture first is what used to stack every node on one spot until "Auto layout" was pressed.
    void (async () => {
      const next = await layoutSample(FIXTURES[kind]());
      setSelectedNodeId(next.nodes[0]?.id || null);
      commitDocument(next, label);
    })();
  }

  const applyCopilotEdit = useCallback(async (application: AppliedDiagramEdit) => {
    serverRevisionRef.current = application.workspaceRevision;
    setPendingAgentProposalId(null);
    setPreviewDocument(null);
    setPreviewSummary("");
    setSelectedRelationId(null);
    try {
      // The server has already applied and versioned this operation. Re-read its XML
      // source instead of rebuilding from the returned semantic projection, especially
      // for native version restores and XML-only edits.
      const response = await fetch("/api/workspace/state");
      const payload = await response.json() as {
        document?: unknown; drawioXml?: unknown; workspaceRevision?: unknown;
      };
      if (response.ok && typeof payload.drawioXml === "string" && isDrawioXmlDocument(payload.drawioXml)) {
        const base = isDiagramDocument(payload.document) ? payload.document : application.document;
        const parsed = fromDrawioXml(payload.drawioXml, base);
        const next = parsed === base ? application.document : parsed;
        setSelectedNodeId((current) => next.nodes.some((node) => node.id === current)
          ? current : next.nodes[0]?.id || null);
        serverRevisionRef.current = typeof payload.workspaceRevision === "string"
          ? payload.workspaceRevision : application.workspaceRevision;
        serverCommittedDocumentRef.current = { document: next, workspaceId: projectWorkspace?.id ?? null };
        commitDocument(next, "Copilot: " + application.summary, preserveDrawioThemeMetadata(drawioXml, payload.drawioXml));
      } else {
        // A fallback semantic patch is safe only if the current source passes the normal
        // XML completeness gate; commitDocument will refuse rather than rebuild otherwise.
        setSelectedNodeId((current) => application.document.nodes.some((node) => node.id === current)
          ? current : application.document.nodes[0]?.id || null);
        commitDocument(application.document, "Copilot: " + application.summary);
      }
      setLastAction("Copilot edit applied · version " + application.versionId);
      recordDiagnostic("copilot.edit.synced", "Applied server-versioned Copilot edit and synchronized the authoritative XML", {
        versionId: application.versionId, nodeCount: application.document.nodes.length, relationCount: application.document.relations.length
      });
    } catch (error) {
      setLastAction("Copilot edit was saved on the server but the current XML could not be refreshed: " + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("copilot.edit.sync-failed", "The server-applied edit could not be rehydrated into the browser; the authoritative source remains on the server", {
        versionId: application.versionId, errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }, [commitDocument, projectWorkspace?.id]);

  const sendIntent = useCopilotIntent({
    projectWorkspace, standaloneMode: Boolean(standaloneFileName), chatInput, chatBusy, workspaceContentReady, document, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNode, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy,
    setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary,
    onAppliedEdit: applyCopilotEdit
  });

  async function saveAISettings() {
    const next = { model: aiModel.trim(), reasoningEffort };
    try {
      const response = await fetch("/api/workspace/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) });
      const payload = await response.json() as { config?: { model?: string; reasoningEffort?: "high" | "max"; revisionId?: string }; error?: string };
      if (!response.ok || !payload.config) throw new Error(payload.error || "Saving the server config failed");
      setAiBaseUrl("copilot-sdk");
      setAiModel(payload.config.model || "");
      setReasoningEffort(payload.config.reasoningEffort || "max");
      try { window.localStorage.setItem("architecture-diagram-studio:v2:ai-provider", JSON.stringify({ baseUrl: "copilot-sdk", ...next })); } catch { /* Server JSONL is authoritative. */ }
      recordDiagnostic("settings.model.saved", "Model and reasoning effort written to a new server config revision", { model: next.model || "local-rules", reasoningEffort: next.reasoningEffort, revisionId: payload.config.revisionId });
      setLastAction(next.model ? "Copilot SDK model settings saved as a new revision" : "Local-rules mode config saved as a new revision");
    } catch (error) {
      setLastAction("Saving model settings failed: " + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("settings.model.save.failed", "Model settings were not saved", { errorMessage: error instanceof Error ? error.message : String(error) }, "error");
    }
  }

  async function clearAISettings() {
    try {
      const response = await fetch("/api/workspace/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { model: "" } }) });
      const payload = await response.json() as { config?: { model?: string; revisionId?: string }; error?: string };
      if (!response.ok || !payload.config) throw new Error(payload.error || "Saving the server config failed");
      setAiBaseUrl("");
      setAiModel("");
      setAiApiKey("");
      try { window.localStorage.removeItem("architecture-diagram-studio:v2:ai-provider"); } catch { /* Server JSONL is authoritative. */ }
      setLastAction("Local-rules mode config saved as a new revision");
      recordDiagnostic("settings.model.cleared", "Model settings cleared from the server revision history", { revisionId: payload.config.revisionId }, "warn");
    } catch (error) {
      setLastAction("Clearing model settings failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  const {
    addSequenceFragment, updateSequenceFragment, removeSequenceFragment, changeRelationEndpoints,
    changeNode, updateNodeById, renameNode, addNode, createRelation, updateRelationLabel,
    removeRelation, reverseRelation, updateRelationKind, updateRelationStyle, updateBoundary, createBoundaryForNode, removeBoundary, removeNodeById, duplicateNodeById
  } = useDiagramEditing({
    document, selectedNode, selectedRelationId,
    setSelectedNodeId, setSelectedRelationId, setLastAction,
    commitDocument, runLayout
  });

  /** Drag a sidebar edge to resize it; the width is persisted with the rest of the UI preferences. */
  function startPanelResize(side: keyof PanelWidths, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidths[side];
    const [min, max] = PANEL_LIMITS[side];
    const onMove = (moveEvent: PointerEvent) => {
      const delta = side === "left" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      setPanelWidths((current) => ({ ...current, [side]: Math.min(max, Math.max(min, startWidth + delta)) }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.document.body.classList.remove("resizing-panels");
    };
    window.document.body.classList.add("resizing-panels");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resetDiagram() {
    if (!semanticEditingSafe) { setLastAction("Reset is disabled for native Draw.io documents to prevent replacing their XML."); return; }
    setSelectedRelationId(null);
    void (async () => {
      const next = await layoutSample(FIXTURES[document.kind]());
      setSelectedNodeId(next.nodes[0]?.id || null);
      commitDocument(next, "Sample diagram restored");
      recordDiagnostic("diagram.reset", "User restored the built-in sample for this diagram kind", {
        diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length
      }, "warn");
    })();
  }

  async function acceptPreview() {
    if (!previewDocument) return;
    const proposalId = pendingAgentProposalId;
    const summary = previewSummary || "Layout preview applied";
    if (proposalId) {
      try {
        const response = await fetch("/api/workspace/diagram/apply-proposal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId, confirmed: true }) });
        const payload = await response.json() as { error?: string; document?: unknown; workspaceRevision?: string; version?: { id?: string; drawioXml?: unknown } };
        if (!response.ok || !isDiagramDocument(payload.document)) throw new Error(payload.error || "The Agent proposal could not be applied");
        const preservedXml = typeof payload.version?.drawioXml === "string" ? payload.version.drawioXml : undefined;
        serverRevisionRef.current = typeof payload.workspaceRevision === "string" ? payload.workspaceRevision : null;
        serverCommittedDocumentRef.current = { document: payload.document, workspaceId: projectWorkspace?.id ?? null };
        setPendingAgentProposalId(null);
        commitDocument(payload.document, summary + " (confirmed)", preservedXml);
        setMessages((items) => [...items, { role: "assistant", id: Date.now(), text: "The reviewed proposal was applied and versioned by the Studio server." }]);
        recordDiagnostic("copilot.preview.applied", "User confirmed and applied the revision-bound Agent proposal", { proposalId, versionId: payload.version?.id, documentId: payload.document.id });
      } catch (error) {
        setLastAction("Proposal not applied: " + (error instanceof Error ? error.message : String(error)));
        recordDiagnostic("copilot.preview.apply.failed", "The Agent proposal could not be applied; the current document was preserved", { proposalId, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
      }
      return;
    }
    const next = previewDocument;
    commitDocument(next, summary + " (applied)");
    recordDiagnostic("copilot.preview.applied", "User applied the layout preview", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length
    });
    setMessages((items) => [...items, { role: "assistant", id: Date.now(), text: "Preview applied; the document has been updated." }]);
  }

  function discardPreview() {
    if (!previewDocument) return;
    setPreviewDocument(null);
    setPreviewSummary("");
    setPendingAgentProposalId(null);
    setLastAction("Preview discarded; document unchanged");
    recordDiagnostic("copilot.preview.discarded", "User discarded the layout preview; document unchanged");
  }

  function exportDiagram() {
    const filename = document.title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "architecture-diagram";
    downloadText(filename + ".drawio", drawioXml);
    setLastAction("Exported the native .drawio file");
    recordDiagnostic("drawio.export.completed", "Exported a .drawio file", { xmlLength: drawioXml.length, nodeCount: document.nodes.length, relationCount: document.relations.length });
  }

  async function openDrawioFile() {
    const picker = (window as Window & { showOpenFilePicker?: (options?: { types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (!picker) { openExistingFileRef.current?.click(); return; }
    try {
      const [handle] = await picker({ types: [{ description: "Draw.io diagrams", accept: { "application/xml": [".drawio", ".dio", ".xml"] } }] });
      if (handle) await openStandaloneDiagram(await handle.getFile(), handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLastAction("Could not open the selected Draw.io file: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function openStandaloneDiagram(file: File, handle: FileSystemFileHandle | null = null) {
    const startedAt = Date.now();
    try {
      const xml = await file.text();
      const diagnostics = getDrawioXmlDiagnostics(xml);
      if (diagnostics.issues.length) throw new Error(diagnostics.issues[0]);
      if (!isDrawioXmlDocument(xml)) throw new Error("The selected file is not a supported Draw.io diagram.");
      const empty: DiagramDocument = {
        ...FIXTURES.c4(), id: newId("opened"), title: file.name.replace(/\.(drawio|dio|xml)$/i, ""),
        renderTheme: uiTheme, nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined
      };
      const parsed = fromDrawioXml(xml, empty);
      if (parsed === empty) throw new Error("The file passed XML validation but could not be represented by the supported semantic projection.");
      if (workspaceContentReady && projectWorkspace?.primaryDiagram && drawioXml.trim()) {
        await persistDocumentNow(document, drawioXml, "Autosave before opening standalone Draw.io");
      }
      setWorkspaceContentReady(false);
      setStandaloneFileHandle(handle); setStandaloneFileName(file.name);
      standaloneLastSavedXmlRef.current = xml;
      setDocument(parsed); setNativeXmlOverride(xml);
      setPreviewDocument(null); setPreviewSummary(""); setPendingAgentProposalId(null);
      setSelectedNodeId(parsed.nodes[0]?.id || null); setSelectedRelationId(null);
      historyRef.current = [parsed]; historyIndexRef.current = 0;
      setCanUndo(false); setCanRedo(false);
      serverRevisionRef.current = null; serverCommittedDocumentRef.current = null;
      setMessages([{ role: "assistant", id: Date.now(), text: "Opened a standalone Draw.io file. It is independent of the configured project workspace." }]);
      setWorkspaceSetupOpen(false); setWorkspaceError("");
      setLastAction(handle ? "Opened " + file.name + " with local autosave enabled" : "Opened " + file.name + " as a standalone document; use Export to save changes");
      recordDiagnostic("drawio.open.standalone", "Opened a Draw.io file independently of the project workspace", {
        fileName: file.name, xmlLength: xml.length, fileBytes: file.size, hasLocalWriteAccess: Boolean(handle), durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastAction("Opening Draw.io failed: " + message);
      recordDiagnostic("drawio.open.standalone.failed", "Could not open a standalone Draw.io file", { fileName: file.name, errorMessage: message }, "error");
    }
  }

  async function importDiagramFile(file: File | undefined) {
    if (!file) return;
    const startedAt = Date.now();
    recordDiagnostic("drawio.import.started", "Draw.io import started", { fileBytes: file.size, fileType: file.name.split(".").pop()?.toLowerCase() || "unknown" });
    try {
      const xml = await file.text();
      const xmlDiagnostics = getDrawioXmlDiagnostics(xml);
      if (xmlDiagnostics.issues.length) {
        setLastAction(xmlDiagnostics.issues[0]);
        recordDiagnostic("drawio.import.validation-failed", xmlDiagnostics.issues[0], {
          fileName: file.name, issues: xmlDiagnostics.issues.slice(0, 10)
        }, "error");
        return;
      }
      if (xmlDiagnostics.warnings.length) {
        const message = "Imported Draw.io with " + xmlDiagnostics.warnings.length + " compatibility warning(s): " + xmlDiagnostics.warnings.slice(0, 2).join(" ");
        setLastAction(message);
        recordDiagnostic("drawio.compatibility.warnings", message, {
          fileName: file.name, pageCount: xmlDiagnostics.pageCount,
          warningCount: xmlDiagnostics.warnings.length, warnings: xmlDiagnostics.warnings.slice(0, 20)
        }, "warn");
      }
      if (!isDrawioXmlDocument(xml)) {
        setLastAction("The selected file is not a supported Draw.io diagram; the active document was not changed.");
        return;
      }
      // Import into a clean semantic base. Spreading the active document here leaked its
      // previous diagram kind, layout profile and theme into the newly selected file.
      const empty: DiagramDocument = {
        ...FIXTURES.c4(),
        id: newId("imported"),
        title: file.name.replace(/\.(drawio|dio|xml)$/i, ""),
        renderTheme: uiTheme,
        nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined
      };
      const parsed = fromDrawioXml(xml, empty);
      const next = parsed === empty ? empty : { ...parsed, title: empty.title };
      setSelectedRelationId(null);
      setSelectedNodeId(next.nodes[0]?.id || null);
      commitDocument(next, "Imported native Draw.io XML from " + file.name, xml);
      if (xmlDiagnostics.warnings.length) {
        setLastAction("Imported " + file.name + " with " + xmlDiagnostics.warnings.length + " compatibility warning(s): " + xmlDiagnostics.warnings.slice(0, 2).join(" "));
      }
      recordDiagnostic("drawio.import.completed", "Draw.io file parsed and imported", {
        durationMs: Date.now() - startedAt, nodeCount: next.nodes.length, relationCount: next.relations.length
      });
    } catch (error) {
      recordDiagnostic("drawio.import.failed", "Draw.io import failed", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("Import failed: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  }

  async function checkDrawioStatus() {
    setDrawioStatus("checking");
    setDrawioStatusMessage("Checking the local asset manifest and editor entry…");
    const startedAt = Date.now();
    recordDiagnostic("drawio.healthcheck.started", "Manual check of the local Draw.io assets", {
      manifestUrl: "/drawio/studio-bundle.json", entryUrl: "/drawio/index.html"
    });
    try {
      const [manifestResponse, entryResponse] = await Promise.all([
        fetch("/drawio/studio-bundle.json", { cache: "no-store" }),
        fetch("/drawio/index.html", { method: "HEAD", cache: "no-store" })
      ]);
      if (!manifestResponse.ok || !entryResponse.ok) {
        const message = "manifest HTTP " + manifestResponse.status + "; index.html HTTP " + entryResponse.status;
        setDrawioStatus("missing");
        setDrawioStatusMessage(message);
        recordDiagnostic("drawio.healthcheck.missing", "Local Draw.io assets are unavailable", {
          manifestStatus: manifestResponse.status, indexStatus: entryResponse.status,
          durationMs: Date.now() - startedAt
        }, "error");
        return;
      }
      const manifest = await manifestResponse.json() as { version?: string; sha256?: string };
      const matches = manifest.version === "v32.0.2" && manifest.sha256 === "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
      if (!matches) {
        setDrawioStatus("missing");
        setDrawioStatusMessage("Assets responded, but the version or SHA-256 does not match the pinned build.");
        recordDiagnostic("drawio.healthcheck.mismatch", "Draw.io asset manifest mismatch", {
          installedVersion: manifest.version ?? null, checksumMatches: manifest.sha256 === "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7",
          durationMs: Date.now() - startedAt
        }, "error");
        return;
      }
      setDrawioStatus("ready");
      setDrawioStatusMessage("v32.0.2 assets match the SHA-256 manifest; index.html HTTP " + entryResponse.status + ". This check does not replace the iframe embed handshake.");
      recordDiagnostic("drawio.healthcheck.ready", "Local Draw.io asset check passed", {
        version: manifest.version, indexStatus: entryResponse.status, durationMs: Date.now() - startedAt
      });
    } catch (error) {
      setDrawioStatus("error");
      setDrawioStatusMessage(error instanceof Error ? error.message : String(error));
      recordDiagnostic("drawio.healthcheck.failed", "Checking the local Draw.io assets threw an error", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }

  async function openVersionHistory() {
    setVersionHistoryOpen(true);
    setVersionHistoryLoading(true);
    try {
      const response = await fetch("/api/workspace/versions");
      if (!response.ok) throw new Error("HTTP " + response.status);
      const result = await response.json() as { versions?: VersionSummary[] };
      setVersionEntries(result.versions || []);
    } catch (error) {
      recordDiagnostic("workspace.versions.load.failed", "Could not load the server-side version history", {
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("Could not load version history; check the server log");
    } finally {
      setVersionHistoryLoading(false);
    }
  }

  async function restoreVersion(versionId: string) {
    try {
      const response = await fetch("/api/workspace/versions/" + encodeURIComponent(versionId) + "/restore", { method: "POST" });
      const result = await response.json() as { error?: string; workspaceRevision?: string; state?: { document?: unknown; drawioXml?: unknown }; version?: { id?: string } };
      const restoredState = result.state;
      if (!response.ok || !restoredState || !isDiagramDocument(restoredState.document) || typeof restoredState.drawioXml !== "string") {
        throw new Error(result.error || "Server-side version restore failed");
      }
      const restored = restoredState.document as DiagramDocument;
      const restoredXml = restoredState.drawioXml as string;
      serverRevisionRef.current = typeof result.workspaceRevision === "string" ? result.workspaceRevision : null;
      setDocument(restored);
      setNativeXmlOverride(restoredXml);
      setPreviewDocument(null);
      setPreviewSummary("");
      setSelectedNodeId(restored.nodes[0]?.id || null);
      setSelectedRelationId(null);
      historyRef.current = [restored];
      historyIndexRef.current = 0;
      setCanUndo(false);
      setCanRedo(false);
      setRevision((value) => value + 1);
      setLastAction("Restored the diagram and native Draw.io XML from server version history");
      setVersionHistoryOpen(false);
      recordDiagnostic("workspace.version.restored", "Restored the full server version snapshot", {
        sourceVersionId: versionId, newVersionId: result.version?.id,
        xmlLength: restoredXml.length, nodeCount: restored.nodes.length
      });
    } catch (error) {
      recordDiagnostic("workspace.version.restore.failed", "Restoring the server version failed", {
        sourceVersionId: versionId,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("Version restore failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  function refreshTraceHistory() {
    recordDiagnostic("trace.refreshed", "Refreshed server-side app traces");
  }

  function openPage(page: WorkspacePage) {
    if (page === "copilot") {
      setActivePage("diagram");
      setRightPanelTab("copilot");
    } else {
      setActivePage(page);
    }
    recordDiagnostic("navigation.opened", "Opened a workspace page", { page });
  }

  function selectNode(id: string) {
    setSelectedNodeId(id);
    setSelectedRelationId(null);
  }

  function selectRelation(id: string) {
    const relation = document.relations.find((item) => item.id === id);
    if (!relation) return;
    setSelectedRelationId(id);
    setSelectedNodeId(relation.source);
    recordDiagnostic("diagram.relation.selected", "Selected a relation on the canvas", { relationId: id });
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: uiTheme === "midnight" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: THEME_ACCENTS[uiTheme],
          colorInfo: THEME_ACCENTS[uiTheme],
          borderRadius: 8,
          fontFamily: '"SF Pro Display", "Segoe UI", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: 13,
          controlHeight: 34,
        },
      }}
    >
      <XProvider>
        <AntApp>
    <Layout className="app-shell" data-theme={uiTheme} style={{ "--left-w": panelWidths.left + "px", "--right-w": panelWidths.right + "px" } as CSSProperties}>
      <Modal
        title={workspaceLaunchMode === "open" ? "Open existing Draw.io" : "Create new Draw.io"}
        open={!workspaceChecking && workspaceSetupOpen}
        closable={Boolean(projectWorkspace && workspaceContentReady)}
        maskClosable={false}
        onCancel={() => { if (projectWorkspace && workspaceContentReady) setWorkspaceSetupOpen(false); }}
        footer={null}
        width={720}
      >
        <div style={{ display: "grid", gap: 16, paddingTop: 8 }}>
          <p>The workspace is the project folder, like a VS Code workspace. The active diagram is a single Draw.io file inside it. Copilot can use the rest of the workspace—code, documentation and other diagrams—as project context.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <Button type={workspaceLaunchMode === "open" ? "primary" : "default"} onClick={() => { setWorkspaceLaunchMode("open"); setWorkspaceError(""); }}>Open existing Draw.io</Button>
            <Button type={workspaceLaunchMode === "create" ? "primary" : "default"} onClick={() => { setWorkspaceLaunchMode("create"); setWorkspaceError(""); }}>Create new Draw.io</Button>
          </div>
          {workspaceError && <div role="alert" style={{ color: "#b42318", background: "#fef3f2", borderRadius: 6, padding: 10 }}>{workspaceError}</div>}
          <label style={{ display: "grid", gap: 6 }}><strong>Workspace name</strong><Input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="e.g. Payments Architecture" /></label>
          <label style={{ display: "grid", gap: 6 }}><strong>Absolute path of the project directory</strong><Input value={workspaceRootPath} onChange={(event) => setWorkspaceRootPath(event.target.value)} placeholder="Path to a local folder or repository root" /></label>
          <small style={{ color: "var(--muted, #667085)" }}>The local Node.js server reads this path. Verify and scan the folder to discover existing diagrams. New diagrams are created directly in the workspace root.</small>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Button onClick={() => { void (async () => {
              try {
                setWorkspaceError("");
                const response = await fetch("/api/workspace/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath }) });
                const result = await response.json() as { error?: string; files?: WorkspaceFile[]; workspace?: ProjectWorkspace };
                if (!response.ok || !result.workspace) throw new Error(result.error || "Directory scan failed");
                setWorkspaceFiles(result.files || []);
                const currentWorkspace = projectWorkspace;
                const keptPrimary = currentWorkspace && currentWorkspace.rootPath === result.workspace.rootPath
                  ? currentWorkspace.primaryDiagram
                  : null;
                if (keptPrimary) setWorkspacePrimaryDiagram(keptPrimary);
                else if (!(result.files || []).some((file) => file.path === workspacePrimaryDiagram)) setWorkspacePrimaryDiagram("");
              } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)); }
            })(); }} disabled={!workspaceRootPath.trim()}>Verify directory and scan</Button>
            {workspaceFiles.length > 0 && <span style={{ color: "var(--muted, #667085)" }}>{workspaceFiles.length} files · {workspaceFiles.filter((file) => file.kind === "diagram" && /\.(drawio|dio|xml)$/i.test(file.path)).length} Draw.io/XML files · {workspaceFiles.filter((file) => file.kind === "code").length} code files · {workspaceFiles.filter((file) => file.kind === "document").length} documents</span>}
          </div>
          {workspaceLaunchMode === "open" ? (
            <label style={{ display: "grid", gap: 6 }}><strong>Draw.io file to open</strong><Select value={workspacePrimaryDiagram || undefined} allowClear showSearch optionFilterProp="label" placeholder="Scan the folder, then choose an existing file" options={workspaceFiles.filter((file) => file.kind === "diagram" && /\.(drawio|dio|xml)$/i.test(file.path)).map((file) => ({ value: file.path, label: file.path }))} onChange={(value) => setWorkspacePrimaryDiagram(value || "")} /></label>
          ) : (
            <label style={{ display: "grid", gap: 6 }}><strong>New file name</strong><Input value={workspaceNewDiagramName} onChange={(event) => setWorkspaceNewDiagramName(event.target.value)} placeholder="architecture.drawio" /><small style={{ color: "var(--muted, #667085)" }}>Creates a blank .drawio file and refuses to overwrite an existing file.</small></label>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Button onClick={() => { if (projectWorkspace && workspaceContentReady) setWorkspaceSetupOpen(false); }} disabled={!projectWorkspace || !workspaceContentReady}>Cancel</Button>
            <Button type="primary" loading={workspaceSaving} disabled={!workspaceName.trim() || !workspaceRootPath.trim() || (workspaceLaunchMode === "open" ? !workspacePrimaryDiagram : !workspaceNewDiagramName.trim())} onClick={() => void saveProjectWorkspace()}>{workspaceLaunchMode === "open" ? "Open diagram" : "Create diagram"}</Button>
          </div>
        </div>
      </Modal>
      <Modal title="Server version history" open={versionHistoryOpen} onCancel={() => setVersionHistoryOpen(false)} footer={null} width={760}>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {versionHistoryLoading ? <p>Loading version history…</p> : versionEntries.length === 0 ? <p>The server has no saved versions yet.</p> : [...versionEntries].reverse().map((version) => (
            <div key={version.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 0", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <div style={{ minWidth: 0 }}>
                <strong>{version.title || "Untitled diagram"} · {version.label}</strong>
                <div style={{ opacity: 0.7, marginTop: 4 }}>{new Date(version.createdAt).toLocaleString()} · {version.id}</div>
              </div>
              <UiButton type="button" className="button button-secondary" onClick={() => void restoreVersion(version.id)}>Restore</UiButton>
            </div>
          ))}
        </div>
      </Modal>
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><i /><i /><i /><i /></div>
          <div><div className="brand-name">FORM <span>STUDIO</span></div><div className="brand-caption">ARCHITECTURE DIAGRAMS</div></div>
        </div>
        <div className="topbar-divider" />
        <div className="document-breadcrumb"><span className="crumb-muted">{projectWorkspace?.name || "WORKSPACE"}</span><span className="crumb-sep">/</span><strong>{projectWorkspace?.primaryDiagram || document.title}</strong><span className="save-state"><i />Saved · r{revision}</span></div>
        <nav className="workspace-nav" aria-label="Workspace pages">
          {([["diagram", "Diagram"], ["copilot", "Layout Copilot"], ["traces", "Agent traces"], ["settings", "Settings"]] as Array<[WorkspacePage, string]>).map(([page, label]) =>
            <UiButton key={page} type="button" className={(page === "copilot" ? activePage === "diagram" && rightPanelTab === "copilot" : activePage === page) ? "active" : ""} aria-current={(page === "copilot" ? activePage === "diagram" && rightPanelTab === "copilot" : activePage === page) ? "page" : undefined} onClick={() => openPage(page)}>{label}{page === "traces" && traceEntries.some((entry) => entry.level === "error") && <i className="nav-error-dot" />}</UiButton>
          )}
        </nav>
        <label className="theme-selector" title="Switch the color theme of the whole workspace">
          <span aria-hidden="true">◐</span>
          <UiSelect value={uiTheme} aria-label="Interface color theme" popupMatchSelectWidth={false} onChange={(event) => {
            const nextTheme = event.target.value as UiTheme;
            setUiTheme(nextTheme);
            // Update the semantic render theme when the native XML can be round-tripped safely.
            // The UI preference is still allowed for native documents with custom cells.
            if (semanticEditingSafe) replaceDocument({ ...document, renderTheme: nextTheme });
          }}>
            <option value="editorial">Editorial</option>
            <option value="youth">Vivid</option>
            <option value="warm">Warm paper</option>
            <option value="midnight">Midnight</option>
          </UiSelect>
        </label>
        <UiButton type="button" className="button button-secondary" onClick={() => void openDrawioFile()}>Open Draw.io</UiButton>
        <UiButton type="button" className="button button-secondary" onClick={() => {
          setWorkspaceLaunchMode("create"); setWorkspaceError("");
          if (projectWorkspace) {
            setWorkspaceName(projectWorkspace.name); setWorkspaceRootPath(projectWorkspace.rootPath);
          }
          setWorkspaceNewDiagramName("architecture.drawio");
          setWorkspaceSetupOpen(true);
        }}>New Draw.io</UiButton>
        <UiInput ref={importFileRef} className="file-input-hidden" type="file" accept=".drawio,.xml,application/xml,text/xml" onChange={(event) => void importDiagramFile(event.target.files?.[0])} />
        <input ref={openExistingFileRef} className="file-input-hidden" type="file" accept=".drawio,.dio,.xml,application/xml,text/xml" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void openStandaloneDiagram(file);
        }} />
        {activePage === "studio" ? <div className="topbar-actions">
          <UiButton className="button button-quiet" disabled={!semanticEditingSafe || !canUndo || Boolean(previewDocument)} onClick={undoDocument}>Undo</UiButton>
          <UiButton className="button button-quiet" disabled={!semanticEditingSafe || !canRedo || Boolean(previewDocument)} onClick={redoDocument}>Redo</UiButton>
          <UiButton className="button button-quiet" title="Reload the built-in sample" disabled={!semanticEditingSafe} onClick={resetDiagram}>Reset</UiButton>
          <UiButton className="button button-secondary" title="Import a .drawio file" onClick={() => importFileRef.current?.click()}><span className="button-icon">↑</span>Import</UiButton>
          <UiButton className="button button-secondary" title="Export a .drawio file" onClick={exportDiagram} disabled={Boolean(previewDocument)}><span className="button-icon">↓</span>Export</UiButton>
          <UiButton className="button button-secondary" title="Browse and restore saved versions" onClick={() => void openVersionHistory()}>History</UiButton>
          
        </div> : <div className="topbar-actions"><UiButton className="button button-secondary" type="button" onClick={() => openPage("diagram")}>Back to diagram</UiButton></div>}
      </header>

      {activePage === "studio" ? (
        <>
      <aside className="left-panel">
        {projectWorkspace && <div className="workspace-card" title={projectWorkspace.rootPath}>
          <b>{projectWorkspace.name}</b>
          <UiButton type="button" className="workspace-switch" onClick={() => setWorkspaceSetupOpen(true)}>Switch workspace</UiButton>
        </div>}
        <div className="side-section">
          <UiButton disabled={!semanticEditingSafe} className={"diagram-kind " + (document.kind === "c4" ? "active" : "")} onClick={() => changeKind("c4")}>
            <span className="kind-icon kind-c4"><i /><i /><i /></span><span className="kind-text"><b>C4 architecture</b></span>
          </UiButton>
          <UiButton disabled={!semanticEditingSafe} className={"diagram-kind " + (document.kind === "flowchart" ? "active" : "")} onClick={() => changeKind("flowchart")}>
            <span className="kind-icon kind-flow"><i /><i /><i /></span><span className="kind-text"><b>Process flow</b></span>
          </UiButton>
          <UiButton disabled={!semanticEditingSafe} className={"diagram-kind " + (document.kind === "sequence" ? "active" : "")} onClick={() => changeKind("sequence")}>
            <span className="kind-icon kind-sequence"><i /><i /></span><span className="kind-text"><b>Sequence diagram</b></span>
          </UiButton>
        </div>

      </aside>
      <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the left sidebar" title="Drag to resize" onPointerDown={(event) => startPanelResize("left", event)} />

      <main className="main-panel">
        <div className="canvas-toolbar">
          <div className="canvas-title">{visibleDocument.title}{previewDocument && <span className="preview-pill">PREVIEW</span>}</div>
          <div className="canvas-tools">
            {previewDocument && <div className="preview-toolbar-actions">
              <UiButton type="button" className="preview-discard" onClick={discardPreview}>Discard preview</UiButton>
              <UiButton type="button" className="preview-accept" onClick={acceptPreview}>Apply changes</UiButton>
            </div>}
            {document.kind === "sequence" && <UiButton className="toolbar-button" onClick={() => addSequenceFragment()} disabled={Boolean(previewDocument)}>＋ Sequence fragment</UiButton>}
            <label className="layout-profile-control" title="Choose the auto-layout algorithm">
              <span>Algorithm</span>
              <UiSelect className="text-field" aria-label="Auto-layout algorithm" value={LAYOUT_PROFILES.some((profile) => profile.value === document.layout.profile) ? document.layout.profile : (enabledLayoutProfiles[0] || "elk-layered") }
                disabled={!semanticEditingSafe || isLayoutting || Boolean(previewDocument) || document.kind === "sequence"}
                onChange={(event) => {
                  const next = { ...document, layout: { ...document.layout, profile: event.target.value } };
                  void runLayout(next);
                }}>
                {LAYOUT_PROFILES.filter((profile) => enabledLayoutProfiles.includes(profile.value) || profile.value === document.layout.profile).map((profile) => <option key={profile.value} value={profile.value} disabled={!enabledLayoutProfiles.includes(profile.value)}>{profile.label}{enabledLayoutProfiles.includes(profile.value) ? "" : " (disabled, current document setting kept)"}</option>)}
              </UiSelect>
            </label>
            <label className="layout-profile-control" title="Set the diagram's main direction">
              <span>Direction</span>
              <UiSelect className="text-field" aria-label="Layout direction" value={document.layout.direction}
                disabled={isLayoutting || Boolean(previewDocument) || document.kind === "sequence"}
                onChange={(event) => {
                  const next = { ...document, layout: { ...document.layout, direction: event.target.value as DiagramDocument["layout"]["direction"] } };
                  void runLayout(next);
                }}>
                <option value="RIGHT">Left → right</option>
                <option value="DOWN">Top → bottom</option>
              </UiSelect>
            </label>
            <UiButton className="toolbar-button" onClick={() => void runLayout()} disabled={!semanticEditingSafe || isLayoutting || Boolean(previewDocument)}><span>{isLayoutting ? <i className="spinner" /> : "⌁"}</span>{isLayoutting ? "Computing…" : "Auto layout"}</UiButton>
            
          </div>
        </div>

        <div className="canvas-stage native-mode">
          {!semanticEditingSafe && <div className="drawio-source-banner" role="status">This diagram contains native Draw.io structure that cannot be safely represented by the semantic projection. The original XML remains authoritative; semantic layout and structural operations are disabled to prevent data loss.</div>}
          {previewDocument && !previewDrawioXml && <div className="drawio-source-banner" role="status">This preview cannot be safely rendered as a native Draw.io revision. The current diagram is unchanged; discard the preview or use a supported operation.</div>}
                      <DrawioFrame document={previewDrawioXml && previewDocument ? previewDocument : document} xml={previewDrawioXml ?? drawioXml} theme={uiTheme} onDocumentChange={previewDocument ? () => {} : (next, nativeXml) => commitDocument(next, "Synced changes from native Draw.io", nativeXml)} />
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right"><span>{visibleDocument.nodes.length} nodes</span><span>{visibleDocument.relations.length} relations</span></div></div>
      </main>
      <div className="panel-resizer panel-resizer-right" role="separator" aria-orientation="vertical" aria-label="Resize the inspector sidebar" title="Drag to resize" onPointerDown={(event) => startPanelResize("right", event)} />

      <aside className="right-panel">
        <div className="right-tabs" role="tablist" aria-label="Inspector panel">
          {([["properties", "Properties"], ["quality", "Quality"], ["copilot", "Copilot"]] as Array<[typeof rightPanelTab, string]>).map(([tab, label]) =>
            <button key={tab} type="button" role="tab" aria-selected={rightPanelTab === tab}
              className={"right-tab" + (rightPanelTab === tab ? " active" : "")}
              onClick={() => setRightPanelTab(tab)}>{label}</button>
          )}
        </div>
        {rightPanelTab === "copilot" && <div className="right-copilot-panel">
          <WorkspacePages
            page="copilot" document={document} previewDocument={previewDocument} previewSummary={previewSummary}
            messages={messages} chatInput={chatInput} setChatInput={setChatInput} chatBusy={chatBusy}
            sendIntent={() => void sendIntent()} acceptPreview={acceptPreview} discardPreview={discardPreview}
            openDiagram={() => { setRightPanelTab("properties"); }}
            aiBaseUrl={aiBaseUrl} setAiBaseUrl={setAiBaseUrl} aiModel={aiModel} setAiModel={setAiModel}
            reasoningEffort={reasoningEffort} setReasoningEffort={setReasoningEffort}
            aiApiKey={aiApiKey} setAiApiKey={setAiApiKey} saveAISettings={saveAISettings} clearAISettings={clearAISettings}
            traceEntries={traceEntries} refreshTraces={refreshTraceHistory}
            drawioStatus={drawioStatus} drawioStatusMessage={drawioStatusMessage}
            checkDrawioStatus={() => void checkDrawioStatus()} onLayoutProfilesChanged={setEnabledLayoutProfiles}
          />
        </div>}
        {rightPanelTab === "properties" && <section className="inspector-section">
          {selectedRelation && (
            <div className="inspector-form selected-relation-inspector">
              <div className="field-label">Selected relation</div>
              <div className="selected-relation-summary">
                <strong>{document.nodes.find((node) => node.id === selectedRelation.source)?.name || selectedRelation.source}</strong>
                <span className="relation-arrow">→</span>
                <strong>{document.nodes.find((node) => node.id === selectedRelation.target)?.name || selectedRelation.target}</strong>
              </div>
              <p className="graph-action-hint">Edit the label by double-clicking it on the diagram. Drag either endpoint handle to reconnect it. Right-click the relation for type, routing, line style, reversal and deletion. Ask Copilot from that same menu for semantic or multi-step changes.</p>
            </div>
          )}
          {selectedNode && !selectedRelation ? (
            <div className="inspector-form">
              <div className="field-label">Technology / platform</div><UiInput key={selectedNode.id + ":" + (selectedNode.technology || "")} className="text-field" defaultValue={selectedNode.technology || ""} placeholder="e.g. Java / Spring" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.technology || "")) changeNode({ technology: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">Description</div><UiTextArea key={selectedNode.id + ":" + (selectedNode.description || "")} className="text-field text-area" defaultValue={selectedNode.description || ""} placeholder="What this component is responsible for…" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.description || "")) changeNode({ description: event.currentTarget.value }); }} rows={2} />
              <div className="connected-relations">
                <div className="field-label">Connected relations · {document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).length}</div>
                {document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).map((relation) => (
                  <button type="button" className={"connected-relation-link" + (selectedRelationId === relation.id ? " active" : "")}
                    key={relation.id} onClick={() => selectRelation(relation.id)}>
                    <span className="connected-relation-direction">
                      <span>{document.nodes.find((node) => node.id === relation.source)?.name || relation.source}</span>
                      <span className="relation-arrow">→</span>
                      <span>{document.nodes.find((node) => node.id === relation.target)?.name || relation.target}</span>
                    </span>
                    <span className="connected-relation-label">{relation.label || "Double-click line to add a label"}</span>
                  </button>
                ))}
                {document.relations.every((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id) && <div className="empty-relations">No relations yet. Drag from a connection point on this node to another node.</div>}
              </div>
              <p className="graph-action-hint">Rename the node by double-clicking its title. Use the node's right-click menu to connect, duplicate, change its semantic role, lock its position, delete it or ask Copilot to edit it.</p>
            </div>
          ) : !selectedRelation ? <div className="empty-inspector">Select a node or relation on the canvas to inspect it.</div> : null}
        </section>}
        {rightPanelTab === "quality" && <section className="quality-section">
          {!quality ? <div className="quality-footnote">Evaluating layout quality on the server…</div> : <>
          <div className="quality-score-line"><div><strong>{quality.score >= 85 ? "Layout looks healthy" : quality.metrics.nodeOverlaps ? "Overlaps need fixing" : "Check the connections"}</strong></div><div className="quality-ring" style={{ "--score": quality.score } as CSSProperties}><span>{quality.score}</span></div></div>
          <div className="metric-grid">
            <div className={quality.metrics.nodeOverlaps ? "metric bad" : "metric"}><strong>{quality.metrics.nodeOverlaps}</strong><span>Node overlaps</span></div>
            <div className={quality.metrics.edgeNodeIntersections ? "metric bad" : "metric"}><strong>{quality.metrics.edgeNodeIntersections}</strong><span>Edges through nodes</span></div>
            <div className={quality.metrics.edgeCrossings ? "metric warn" : "metric"}><strong>{quality.metrics.edgeCrossings}</strong><span>Possible crossings</span></div>
            <div className="metric"><strong>{Math.round(quality.metrics.whitespaceScore * 100)}%</strong><span>Whitespace</span></div>
          </div>
          {quality.errors.length > 0 && <div className="quality-footnote">{quality.errors[0].message}</div>}
          </>}
        </section>}
      </aside>        </>
      ) : (
        <WorkspacePages
          page={activePage}
          document={document}
          previewDocument={previewDocument}
          previewSummary={previewSummary}
          messages={messages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatBusy={chatBusy}
          sendIntent={() => void sendIntent()}
          acceptPreview={acceptPreview}
          discardPreview={discardPreview}
          openDiagram={() => { openPage("diagram"); }}
          aiBaseUrl={aiBaseUrl}
          setAiBaseUrl={setAiBaseUrl}
          aiModel={aiModel}
          setAiModel={setAiModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
          aiApiKey={aiApiKey}
          setAiApiKey={setAiApiKey}
          saveAISettings={saveAISettings}
          clearAISettings={clearAISettings}
          traceEntries={traceEntries}
          refreshTraces={refreshTraceHistory}
          drawioStatus={drawioStatus}
          drawioStatusMessage={drawioStatusMessage}
          checkDrawioStatus={() => void checkDrawioStatus()}
          onLayoutProfilesChanged={setEnabledLayoutProfiles}
        />
      )}
      {canvasMenu && (() => {
        const close = () => setCanvasMenu(null);
        const menuNode = canvasMenu.kind === "node" ? document.nodes.find((node) => node.id === canvasMenu.id) : undefined;
        const menuRelation = canvasMenu.kind === "relation" ? document.relations.find((relation) => relation.id === canvasMenu.id) : undefined;
        const menuFragment = canvasMenu.kind === "fragment" ? (document.sequence?.fragments || []).find((fragment) => fragment.id === canvasMenu.id) : undefined;
        const menuBoundary = canvasMenu.kind === "boundary" ? document.boundaries.find((boundary) => boundary.id === canvasMenu.id) : undefined;
        const messageOrder = menuRelation ? (menuRelation.sequenceOrder ?? document.relations.findIndex((relation) => relation.id === menuRelation.id)) : -1;
        return <div className="canvas-menu" role="menu" style={{ left: canvasMenu.x, top: canvasMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {menuNode && <>
            <div className="canvas-menu-title">{menuNode.name}</div>
            <button type="button" role="menuitem" onClick={() => { setConnectionSourceId(menuNode.id); setLastAction("Connecting from " + menuNode.name + " · click a target node or press Esc"); close(); }}>Connect from this node…</button>
            <button type="button" role="menuitem" onClick={() => { duplicateNodeById(menuNode.id); close(); }}>Duplicate node</button>
            <button type="button" role="menuitem" onClick={() => { setSelectedNodeId(menuNode.id); setSelectedRelationId(null); updateNodeById(menuNode.id, { layoutHints: { ...(menuNode.layoutHints || {}), locked: !menuNode.layoutHints?.locked } }); close(); }}>{menuNode.layoutHints?.locked ? "Unlock position" : "Lock position"}</button>
            <div className="canvas-menu-divider" />
            <div className="canvas-menu-caption">Change role</div>
            {Object.entries(roleLabels).filter(([role]) => role !== menuNode.role).map(([role, label]) =>
              <button type="button" role="menuitem" key={role} onClick={() => { setSelectedNodeId(menuNode.id); setSelectedRelationId(null); updateNodeById(menuNode.id, { role: role as DiagramNode["role"] }); close(); }}>Make {label.toLowerCase()}</button>
            )}
            <div className="canvas-menu-divider" />
            <div className="canvas-menu-caption">System boundary</div>
            <button type="button" role="menuitem" onClick={() => { createBoundaryForNode(menuNode.id); close(); }}>Create boundary around this node</button>
            {document.boundaries.map((boundary) => {
              const isMember = boundary.members.includes(menuNode.id);
              return <button type="button" role="menuitem" key={boundary.id}
                onClick={() => { updateBoundary(boundary.id, { members: isMember ? boundary.members.filter((id) => id !== menuNode.id) : [...boundary.members, menuNode.id] }); close(); }}>
                {isMember ? "Remove from" : "Add to"} boundary · {boundary.name}
              </button>;
            })}
            <div className="canvas-menu-divider" />
            <button type="button" role="menuitem" onClick={() => { setSelectedNodeId(menuNode.id); setSelectedRelationId(null); setRightPanelTab("properties"); close(); }}>Edit details…</button>
            <button type="button" role="menuitem" onClick={() => { void sendIntent("For node " + menuNode.name + " (id " + menuNode.id + "), inspect its connected relationships and propose a focused improvement. Use the structured diagram operation tool and return a reviewable preview."); setRightPanelTab("copilot"); close(); }}>Ask Copilot to edit…</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { void removeNodeById(menuNode.id); close(); }}>Delete node</button>
          </>}
          {menuRelation && <>
            <div className="canvas-menu-title">{menuRelation.label || "Relation"}</div>
            <button type="button" role="menuitem" onClick={() => { void reverseRelation(menuRelation.id); close(); }}>Reverse direction</button>
            <div className="canvas-menu-caption">Relation type</div>
            {(document.kind === "sequence"
              ? [["call", "Call"], ["return", "Return"], ["async", "Async message"]]
              : [["flow", "Flow"], ["call", "Call"], ["return", "Return"], ["async", "Async message"], ["event", "Event"], ["dependency", "Dependency"]]
            ).map(([kind, label]) =>
              <button type="button" role="menuitem" key={kind} className={menuRelation.kind === kind ? "checked" : ""}
                onClick={() => { updateRelationKind(menuRelation.id, kind as import("./model/types").EdgeKind); close(); }}>{label}</button>
            )}
            <div className="canvas-menu-divider" />
            {document.kind === "sequence" && (document.sequence?.fragments || []).length > 0 && <>
              <div className="canvas-menu-caption">Sequence fragments · this message</div>
              {(document.sequence?.fragments || []).map((fragment) => <Fragment key={fragment.id}>
                <button type="button" role="menuitem" onClick={() => { updateSequenceFragment(fragment.id, { startOrder: messageOrder }); close(); }}>Set “{fragment.label}” start here</button>
                <button type="button" role="menuitem" onClick={() => { updateSequenceFragment(fragment.id, { endOrder: messageOrder }); close(); }}>Set “{fragment.label}” end here</button>
              </Fragment>)}
              <button type="button" role="menuitem" onClick={() => { addSequenceFragment(messageOrder, "alt"); close(); }}>Add alt fragment around this message</button>
              <button type="button" role="menuitem" onClick={() => { addSequenceFragment(messageOrder, "opt"); close(); }}>Add opt fragment around this message</button>
              <button type="button" role="menuitem" onClick={() => { addSequenceFragment(messageOrder, "loop"); close(); }}>Add loop fragment around this message</button>
            </>}
            <div className="canvas-menu-divider" />
            <div className="canvas-menu-caption">Routing</div>
            {([
              ["inherit", "Default routing", undefined], ["orthogonal", "Orthogonal", "orthogonal"],
              ["polyline", "Polyline", "polyline"], ["curved", "Curved", "curved"]
            ] as Array<[string, string, "orthogonal" | "polyline" | "curved" | undefined]>).map(([value, label, routing]) =>
              <button type="button" role="menuitem" key={value} className={(menuRelation.routing || "inherit") === value ? "checked" : ""}
                disabled={document.kind === "sequence"} onClick={() => { updateRelationStyle(menuRelation.id, { routing }); close(); }}>{label}</button>
            )}
            <div className="canvas-menu-caption">Line style</div>
            {([
              ["inherit", "Default line", undefined], ["solid", "Solid line", false], ["dashed", "Dashed line", true]
            ] as Array<[string, string, boolean | undefined]>).map(([value, label, dashed]) =>
              <button type="button" role="menuitem" key={value} className={(menuRelation.dashed === undefined ? "inherit" : menuRelation.dashed ? "dashed" : "solid") === value ? "checked" : ""}
                onClick={() => { updateRelationStyle(menuRelation.id, { dashed }); close(); }}>{label}</button>
            )}
            <button type="button" role="menuitem" onClick={() => { void sendIntent("Improve relation " + menuRelation.id + " from " + menuRelation.source + " to " + menuRelation.target + " (label: " + menuRelation.label + "). Check semantics and path quality, then propose a focused structured diagram operation."); setRightPanelTab("copilot"); close(); }}>Ask Copilot to edit…</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { void removeRelation(menuRelation.id); close(); }}>Delete relation</button>
          </>}
          {menuFragment && <>
            <div className="canvas-menu-title">{menuFragment.kind.toUpperCase()} · {menuFragment.label}</div>
            <div className="canvas-menu-caption">Fragment type</div>
            {(["alt", "opt", "loop"] as SequenceFragment["kind"][]).map((kind) =>
              <button type="button" role="menuitem" key={kind} className={menuFragment.kind === kind ? "checked" : ""}
                onClick={() => { updateSequenceFragment(menuFragment.id, { kind }); close(); }}>{kind.toUpperCase()}</button>
            )}
            <div className="canvas-menu-caption">Range</div>
            <button type="button" role="menuitem" disabled={menuFragment.startOrder <= 0}
              onClick={() => { updateSequenceFragment(menuFragment.id, { startOrder: menuFragment.startOrder - 1 }); close(); }}>Extend start to previous message</button>
            <button type="button" role="menuitem" disabled={menuFragment.startOrder >= menuFragment.endOrder}
              onClick={() => { updateSequenceFragment(menuFragment.id, { startOrder: menuFragment.startOrder + 1 }); close(); }}>Move start to next message</button>
            <button type="button" role="menuitem" disabled={menuFragment.endOrder <= menuFragment.startOrder}
              onClick={() => { updateSequenceFragment(menuFragment.id, { endOrder: menuFragment.endOrder - 1 }); close(); }}>Move end to previous message</button>
            <button type="button" role="menuitem" disabled={menuFragment.endOrder >= document.relations.length - 1}
              onClick={() => { updateSequenceFragment(menuFragment.id, { endOrder: menuFragment.endOrder + 1 }); close(); }}>Extend end to next message</button>
            <button type="button" role="menuitem" onClick={() => { void sendIntent("Update sequence fragment " + menuFragment.id + " (" + menuFragment.kind + ", currently " + menuFragment.startOrder + "–" + menuFragment.endOrder + " messages) to improve its semantics and scope. Use propose_diagram_operation and return a reviewable preview."); setRightPanelTab("copilot"); close(); }}>Ask Copilot to edit…</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { removeSequenceFragment(menuFragment.id); close(); }}>Delete fragment</button>
          </>}
          {menuBoundary && <>
            <div className="canvas-menu-title">{menuBoundary.name}</div>
            <div className="canvas-menu-caption">Members · {menuBoundary.members.length}</div>
            {selectedNodeId && document.nodes.some((node) => node.id === selectedNodeId) && <>
              <button type="button" role="menuitem" onClick={() => {
                const nodeId = selectedNodeId;
                updateBoundary(menuBoundary.id, { members: menuBoundary.members.includes(nodeId)
                  ? menuBoundary.members.filter((id) => id !== nodeId)
                  : [...menuBoundary.members, nodeId] });
                close();
              }}>{menuBoundary.members.includes(selectedNodeId) ? "Remove selected node from boundary" : "Add selected node to boundary"}</button>
            </>}
            <button type="button" role="menuitem" onClick={() => { void sendIntent("Review boundary " + menuBoundary.id + " named " + menuBoundary.name + " with members " + menuBoundary.members.join(", ") + ". Propose a focused typed boundary update if its name, grouping or membership should change."); setRightPanelTab("copilot"); close(); }}>Ask Copilot to edit…</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { removeBoundary(menuBoundary.id); close(); }}>Delete boundary</button>
          </>}
          {canvasMenu.kind === "canvas" && <>
            <div className="canvas-menu-caption">Add to diagram</div>
            <button type="button" role="menuitem" onClick={() => { addNode("service"); close(); }}>Add service</button>
            <button type="button" role="menuitem" onClick={() => { addNode("storage"); close(); }}>Add data store</button>
            <button type="button" role="menuitem" onClick={() => { addNode("external"); close(); }}>Add external system</button>
            <button type="button" role="menuitem" onClick={() => { addNode("decision"); close(); }}>Add decision</button>
            <div className="canvas-menu-divider" />
            <button type="button" role="menuitem" onClick={() => { void runLayout(); close(); }}>Auto layout</button>
            <button type="button" role="menuitem" onClick={() => { setStudioZoom(1); setCanvasViewResetToken((value) => value + 1); close(); }}>Reset view</button>
            <button type="button" role="menuitem" onClick={() => { void sendIntent("Inspect the active diagram quality and propose targeted fixes for the most important layout and semantic issues using structured diagram operations. Return a reviewable preview."); setRightPanelTab("copilot"); close(); }}>Ask Copilot to improve diagram…</button>
          </>}
        </div>;
      })()}
    </Layout>
        </AntApp>
      </XProvider>
    </ConfigProvider>
  );
}