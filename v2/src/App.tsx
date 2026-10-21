import { Children, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import { App as AntApp, Button, Checkbox, ConfigProvider, Input, Layout, Modal, Select, theme as antdTheme } from "antd";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import type { ButtonHTMLAttributes, ChangeEvent, CSSProperties, InputHTMLAttributes, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { hasStackedGeometry, isDiagramDocument } from "./model/types";
import type { DiagramDocument, DiagramKind, DiagramNode, SequenceFragment, VisualRole } from "./model/types";
import { FIXTURES } from "./model/fixtures";
import { moveNode } from "./layout/move";
import { LAYOUT_PROFILES } from "./layout/profiles";
import { useCopilotIntent } from "./hooks/useCopilotIntent";
import { downloadText } from "./export/drawio";
import { fromDrawioXml } from "./import/drawio";
import { roleLabels } from "./design/tokens";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";
import WorkspacePages, { type WorkspacePage } from "./components/WorkspacePages";
import { readDiagnosticEntries, recordDiagnostic } from "./diagnostics";
import type { DiagnosticEntry } from "./diagnostics";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";

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
type CanvasMenu = { x: number; y: number; kind: "node" | "relation" | "canvas"; id?: string };
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

async function requestServerLayout(document: DiagramDocument): Promise<DiagramDocument> {
  const response = await fetch("/api/workspace/layout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document }),
    signal: AbortSignal.timeout(70_000)
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "Server-side layout failed (HTTP " + response.status + ")");
  }
  const result = await response.json() as { document: DiagramDocument };
  if (!isDiagramDocument(result.document)) throw new Error("The server returned an invalid diagram document");
  return result.document;
}

/**
 * Layout for a sample or an imported draft that has no geometry yet.
 *
 * The server owns layout and the enabled-profile policy, but the sample has to render even when the API is
 * unreachable, so the same engine runs locally as a fallback. That engine is loaded on demand: it is only
 * needed when a document arrives without coordinates, and it should not weigh on the first paint.
 */
async function layoutSample(document: DiagramDocument): Promise<DiagramDocument> {
  try {
    return await requestServerLayout(document);
  } catch {
    const { layoutDiagram } = await import("./layout/layout");
    return layoutDiagram(document);
  }
}

async function requestServerSequenceNormalize(document: DiagramDocument): Promise<DiagramDocument> {
  const response = await fetch("/api/workspace/diagram/normalize-sequence", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document })
  });
  const payload = await response.json() as { document?: DiagramDocument; error?: string };
  if (!response.ok || !payload.document || !isDiagramDocument(payload.document)) {
    throw new Error(payload.error || "Server-side sequence normalisation failed");
  }
  return payload.document;
}

export default function App() {
  const [document, setDocument] = useState<DiagramDocument>(() => {
    try {
      const saved = window.localStorage.getItem("architecture-diagram-studio:v2:document");
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        if (isDiagramDocument(parsed)) return parsed;
      }
    } catch {
      // Browser storage may be disabled or contain an older draft; use the sample instead.
    }
    return FIXTURES.c4();
  });
  const [previewDocument, setPreviewDocument] = useState<DiagramDocument | null>(null);
  const [pendingAgentProposalId, setPendingAgentProposalId] = useState<string | null>(null);
  const [previewSummary, setPreviewSummary] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("domain");
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<"properties" | "quality" | "design" | "copilot">("properties");
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadSavedTheme());
  const [enabledLayoutProfiles, setEnabledLayoutProfiles] = useState<string[]>(LAYOUT_PROFILES.map((profile) => profile.value));
  const [viewMode, setViewMode] = useState<"studio" | "drawio">("studio");
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => loadPanelWidths());
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu | null>(null);
  const [activePage, setActivePage] = useState<WorkspacePage>("studio");
  const [traceEntries, setTraceEntries] = useState<DiagnosticEntry[]>(() => readDiagnosticEntries());
  const [drawioStatus, setDrawioStatus] = useState<"unknown" | "checking" | "ready" | "missing" | "error">("unknown");
  const [drawioStatusMessage, setDrawioStatusMessage] = useState("");
  const [studioZoom, setStudioZoom] = useState(1);
  const [canvasViewResetToken, setCanvasViewResetToken] = useState(0);
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
  const [relationTargetId, setRelationTargetId] = useState("");
  const [relationLabel, setRelationLabel] = useState("");
  const [relationLabelDrafts, setRelationLabelDrafts] = useState<Record<string, string>>({});
  const importFileRef = useRef<HTMLInputElement>(null);

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
  const [generatedDrawioXml, setGeneratedDrawioXml] = useState("");
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/workspace/diagram/export-drawio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document }) })
      .then(async (response) => { const payload = await response.json() as { xml?: string; error?: string }; if (!response.ok || typeof payload.xml !== "string") throw new Error(payload.error || "Generating the Draw.io XML failed"); return payload.xml; })
      .then((xml) => { if (!cancelled) setGeneratedDrawioXml(xml); })
      .catch((error) => { if (!cancelled) setLastAction(error instanceof Error ? error.message : String(error)); });
    return () => { cancelled = true; };
  }, [document]);
  const [nativeXmlOverride, setNativeXmlOverride] = useState<string | null>(null);
  const [serverHydrated, setServerHydrated] = useState(false);
  const [serverDocumentAvailable, setServerDocumentAvailable] = useState(false);
  const [workspaceContentReady, setWorkspaceContentReady] = useState(false);
  const workspaceInitialLoadRef = useRef<string | null>(null);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [workspaceChecking, setWorkspaceChecking] = useState(true);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceRootPath, setWorkspaceRootPath] = useState("");
  const [workspacePrimaryDiagram, setWorkspacePrimaryDiagram] = useState("");
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
  const { serverRevisionRef, persistDocumentNow } = useWorkspacePersistence({ document, drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef: nextSaveLabelRef, onDiagnostic: recordDiagnostic });

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/config").then(async (response) => { if (!response.ok) throw new Error("Could not read the project workspace configuration"); return response.json() as Promise<{ configured?: boolean; workspace?: ProjectWorkspace | null; suggestedRootPath?: string }>; }).then((result) => { if (!active) return; const workspace = result.workspace || null; setProjectWorkspace(workspace); setWorkspaceSetupOpen(!result.configured || !workspace); if (!workspace && result.suggestedRootPath) { setWorkspaceRootPath(result.suggestedRootPath); setWorkspaceName(result.suggestedRootPath.split(/[\\/]/).filter(Boolean).pop() || "Project Workspace"); } if (workspace) { setWorkspaceName(workspace.name); setWorkspaceRootPath(workspace.rootPath); setWorkspacePrimaryDiagram(workspace.primaryDiagram || ""); void fetch("/api/workspace/files").then((response) => response.ok ? response.json() as Promise<{ files?: WorkspaceFile[] }> : Promise.resolve({ files: [] })).then((result) => { if (active) setWorkspaceFiles(result.files || []); }).catch(() => undefined); } }).catch((error) => { if (!active) return; setWorkspaceError(error instanceof Error ? error.message : String(error)); setWorkspaceSetupOpen(true); }).finally(() => { if (active) setWorkspaceChecking(false); });
    return () => { active = false; };
  }, []);

  async function saveProjectWorkspace() {
    setWorkspaceSaving(true); setWorkspaceContentReady(false); setWorkspaceError("");
    try {
      const response = await fetch("/api/workspace/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath, primaryDiagram: workspacePrimaryDiagram || null }) });
      const result = await response.json() as { error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[]; counts?: { files: number; diagrams: number; code: number; documents: number } };
      if (!response.ok || !result.workspace) throw new Error(result.error || "Configuring the workspace failed");
      const nextWorkspace = result.workspace;
      let nextDocument = document;
      let nextXml: string | null = nativeXmlOverride;
      const workspaceChanged = projectWorkspace?.id !== nextWorkspace.id;
      if (workspaceChanged) { setMessages([{ role: "assistant", id: Date.now(), text: "Switched to a new project workspace. Later analysis will be based on the Draw.io diagrams, code, and design documents in that directory." }]); const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session"); setCopilotSessionId(newSessionId); }
      if (workspaceChanged) serverRevisionRef.current = null;
      if (nextWorkspace.primaryDiagram && (workspaceChanged || projectWorkspace?.primaryDiagram !== nextWorkspace.primaryDiagram || !workspaceContentReady) && /\.(drawio|dio|xml)$/i.test(nextWorkspace.primaryDiagram)) {
        const fileResponse = await fetch("/api/workspace/files/content?path=" + encodeURIComponent(nextWorkspace.primaryDiagram));
        const fileResult = await fileResponse.json() as { error?: string; content?: string };
        if (!fileResponse.ok || typeof fileResult.content !== "string") throw new Error(fileResult.error || "Could not read the selected Draw.io file");
        nextXml = fileResult.content;
        const parsedDocument = fromDrawioXml(fileResult.content, document);
        if (parsedDocument === document) throw new Error("The selected file is not recognisable Draw.io XML");
        nextDocument = await requestServerSequenceNormalize(parsedDocument);
      } else if (workspaceChanged) {
        nextDocument = await layoutSample(FIXTURES.c4());
        nextXml = null;
      }
      if (nextDocument !== document) {
        setDocument(nextDocument);
        setSelectedNodeId(nextDocument.nodes[0]?.id || null);
        historyRef.current = [nextDocument];
        historyIndexRef.current = 0;
        setCanUndo(false);
        setCanRedo(false);
      }
      setNativeXmlOverride(nextXml);
      workspaceInitialLoadRef.current = nextWorkspace.id;
      setServerDocumentAvailable(true);
      setProjectWorkspace(nextWorkspace);
      setWorkspaceFiles(result.files || workspaceFiles);
      setWorkspacePrimaryDiagram(nextWorkspace.primaryDiagram || "");
      setWorkspaceSetupOpen(false);
      setWorkspaceContentReady(true);
      recordDiagnostic("workspace.project.configured", "Project workspace configured", { workspaceId: nextWorkspace.id, rootPath: nextWorkspace.rootPath, primaryDiagram: nextWorkspace.primaryDiagram, ...(result.counts || {}) });
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)); }
    finally { setWorkspaceSaving(false); }
  }

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
        const savedDocument = isDiagramDocument(state.document) ? state.document : null;
        setServerDocumentAvailable(Boolean(savedDocument));
        serverRevisionRef.current = typeof state.workspaceRevision === "string" ? state.workspaceRevision : null;
        setWorkspaceContentReady(Boolean(savedDocument && !state.workspaceMismatch));
        if (savedDocument) {
          setDocument(savedDocument);
          setSelectedNodeId(savedDocument.nodes[0]?.id || null);
          setNativeXmlOverride(typeof state.drawioXml === "string" ? state.drawioXml : null);
          historyRef.current = [savedDocument];
          historyIndexRef.current = 0;
          setCanUndo(false);
          setCanRedo(false);
          recordDiagnostic("workspace.hydrated", "Restored the workspace and native Draw.io XML from the server", {
            documentId: savedDocument.id, nodeCount: savedDocument.nodes.length,
            xmlLength: typeof state.drawioXml === "string" ? state.drawioXml.length : 0,
            durationMs: Date.now() - startedAt
          });
        }
        if (state.workspaceMismatch) { const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session"); setCopilotSessionId(newSessionId); setMessages([{ role: "assistant", id: Date.now(), text: "The project workspace changed, so the previous conversation context was cleared." }]); }
        if (typeof state.copilotSessionId === "string" && state.copilotSessionId.length >= 8) {
          setCopilotSessionId(state.copilotSessionId);
          try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", state.copilotSessionId); } catch { /* Server state remains authoritative. */ }
        }
        if (Array.isArray(state.chatMessages) && state.chatMessages.length) {
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
        recordDiagnostic("workspace.hydrate.failed", "Could not restore the workspace from the server; using the local draft", {
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error)
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
          const parsedDocument = fromDrawioXml(result.content, baseDocument);
          if (parsedDocument === baseDocument) throw new Error("The selected file is not recognisable Draw.io XML");
          const imported = await requestServerSequenceNormalize(parsedDocument);
          if (!active) return;
          setDocument(imported); setNativeXmlOverride(result.content); setSelectedNodeId(imported.nodes[0]?.id || null);
          historyRef.current = [imported]; historyIndexRef.current = 0; setCanUndo(false); setCanRedo(false);
          setServerDocumentAvailable(true);
          setWorkspaceContentReady(true);
          recordDiagnostic("workspace.primary-diagram.loaded", "Loaded the primary Draw.io diagram from the project workspace", { workspaceId: projectWorkspace.id, path: projectWorkspace.primaryDiagram, xmlLength: result.content.length });
        } else {
          const laidOut = await requestServerLayout(FIXTURES.c4());
          if (!active) return;
          setDocument(laidOut); setNativeXmlOverride(null); setSelectedNodeId(laidOut.nodes[0]?.id || null);
          historyRef.current = [laidOut]; historyIndexRef.current = 0; setCanUndo(false); setCanRedo(false);
          setWorkspaceContentReady(true);
        }
      } catch (error) {
        if (active) recordDiagnostic("workspace.primary-diagram.load.failed", "Could not load the workspace primary diagram", { workspaceId: projectWorkspace.id, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
      }
    };
    void load();
    return () => { active = false; };
  }, [serverHydrated, projectWorkspace, serverDocumentAvailable]);

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
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:document", JSON.stringify(document));
    } catch {
      setLastAction("Browser storage is unavailable; this session can still be edited");
    }
  }, [document]);

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
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
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
    nextSaveLabelRef.current = action;
    setPreviewDocument(null);
    setPreviewSummary("");
    setNativeXmlOverride(preservedNativeXml ?? null);
    const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), next].slice(-50);
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(false);
    setDocument(next);
    setRevision((value) => value + 1);
    setLastAction(action);
    recordDiagnostic("diagram.change.committed", "The diagram document was updated", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length,
      hasPreview: false, preservedNativeXml: Boolean(preservedNativeXml)
    });
  }, []);

  /** Updates the document in place: the current history entry is replaced instead of pushing a new step. */
  const replaceDocument = useCallback((next: DiagramDocument) => {
    const index = historyIndexRef.current;
    if (index >= 0) historyRef.current = [...historyRef.current.slice(0, index), next];
    setDocument(next);
    setRevision((value) => value + 1);
  }, []);

  /**
   * Heals a document that is already broken on disk or in the browser draft: an earlier build could persist
   * a fixture before it was laid out, and every later reload restored the stack of nodes on one spot.
   *
   * Runs once, after hydration, on whatever document the server handed back — the layouts of new documents
   * are already computed by the paths that create them.
   */
  useEffect(() => {
    if (!serverHydrated || geometryHealRef.current) return;
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
    if (historyIndexRef.current <= 0) return;
    setSelectedRelationId(null);
    historyIndexRef.current -= 1;
    const previous = historyRef.current[historyIndexRef.current];
    setPreviewDocument(null);
    setPreviewSummary("");
    setNativeXmlOverride(null);
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
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    setSelectedRelationId(null);
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    setPreviewDocument(null);
    setPreviewSummary("");
    setNativeXmlOverride(null);
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
    setPreviewDocument(null);
    setPreviewSummary("");
    setSelectedRelationId(null);
    setViewMode("studio");
    const label = "Switched to " + (kind === "c4" ? "C4 diagram" : kind === "sequence" ? "sequence diagram" : "flowchart");
    // Fixtures carry no coordinates, so the layout has to exist before the first paint; committing the
    // raw fixture first is what used to stack every node on one spot until "Auto layout" was pressed.
    void (async () => {
      const next = await layoutSample(FIXTURES[kind]());
      setSelectedNodeId(next.nodes[0]?.id || null);
      commitDocument(next, label);
    })();
  }

  const sendIntent = useCopilotIntent({
    projectWorkspace, chatInput, chatBusy, workspaceContentReady, document, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNode, persistDocumentNow, setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy,
    setCopilotSessionId, setPendingAgentProposalId, setPreviewDocument, setPreviewSummary, setViewMode
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

  function addSequenceFragment() {
    if (document.kind !== "sequence") return;
    const maxOrder = Math.max(0, document.relations.length - 1);
    const startOrder = Math.min(1, maxOrder);
    const fragment: SequenceFragment = {
      id: newId("fragment"),
      kind: "alt",
      label: "Condition branch",
      startOrder,
      endOrder: Math.min(maxOrder, startOrder + 2)
    };
    const next: DiagramDocument = {
      ...document,
      sequence: {
        participants: document.sequence?.participants || document.nodes.map((node) => node.id),
        fragments: [...(document.sequence?.fragments || []), fragment]
      }
    };
    commitDocument(next, "Added an alt sequence fragment");
  }

  function updateSequenceFragment(fragmentId: string, patch: Partial<SequenceFragment>) {
    if (document.kind !== "sequence") return;
    const maxOrder = Math.max(0, document.relations.length - 1);
    const fragments = (document.sequence?.fragments || []).map((fragment) => {
      if (fragment.id !== fragmentId) return fragment;
      const updated = { ...fragment, ...patch };
      let startOrder = Math.max(0, Math.min(maxOrder, Math.floor(updated.startOrder)));
      let endOrder = Math.max(0, Math.min(maxOrder, Math.floor(updated.endOrder)));
      if (startOrder > endOrder) {
        if (patch.startOrder !== undefined) endOrder = startOrder;
        else startOrder = endOrder;
      }
      return { ...updated, startOrder, endOrder };
    });
    const next: DiagramDocument = {
      ...document,
      sequence: {
        participants: document.sequence?.participants || document.nodes.map((node) => node.id),
        fragments
      }
    };
    commitDocument(next, "Sequence fragment updated");
  }

  function removeSequenceFragment(fragmentId: string) {
    if (document.kind !== "sequence") return;
    const next: DiagramDocument = {
      ...document,
      sequence: {
        participants: document.sequence?.participants || document.nodes.map((node) => node.id),
        fragments: (document.sequence?.fragments || []).filter((fragment) => fragment.id !== fragmentId)
      }
    };
    commitDocument(next, "Sequence fragment deleted");
  }

  async function changeRelationEndpoints(relationId: string, source: string, target: string) {
    if (!source || !target || source === target) {
      setLastAction("A relation needs two different endpoints");
      return;
    }
    const current = document.relations.find((relation) => relation.id === relationId);
    if (!current || (current.source === source && current.target === target)) return;
    const next = await requestServerSequenceNormalize({
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, source, target, points: [] }
        : relation)
    });
    commitDocument(next, "Relation endpoints updated");
    if (document.kind !== "sequence") void runLayout(next);
  }

  function changeNode(patch: Partial<DiagramNode>) {
    if (!selectedNode) return;
    const next = {
      ...document,
      nodes: document.nodes.map((node) => {
        if (node.id !== selectedNode.id) return node;
        if (patch.role === undefined) return { ...node, ...patch };
        const nextRole = patch.role;
        let layoutHints = { ...(node.layoutHints || {}) };
        if (
          (node.role === "external" || node.role === "vendor") &&
          layoutHints.preferredSide === "RIGHT" &&
          nextRole !== "external" && nextRole !== "vendor"
        ) {
          delete layoutHints.preferredSide;
        }
        if (
          (node.role === "storage" || node.role === "data") &&
          layoutHints.preferredSide === "BOTTOM" &&
          nextRole !== "storage" && nextRole !== "data"
        ) {
          delete layoutHints.preferredSide;
        }
        if ((nextRole === "external" || nextRole === "vendor") && !layoutHints.preferredSide) {
          layoutHints.preferredSide = "RIGHT";
        }
        if ((nextRole === "storage" || nextRole === "data") && !layoutHints.preferredSide) {
          layoutHints.preferredSide = "BOTTOM";
        }
        const visualRole: VisualRole = nextRole === "external" || nextRole === "vendor"
          ? "external"
          : node.visualRole === "external" ? "secondary" : node.visualRole;
        return { ...node, ...patch, visualRole, layoutHints };
      })
    };
    commitDocument(next, "Node properties updated");
  }

  function addNode(role: DiagramNode["role"]) {
    const id = newId(role);
    const node: DiagramNode = {
      id,
      name: role === "storage" ? "New data store" : role === "external" ? "External system" : role === "decision" ? "Decision" : "New component",
      role, visualRole: role === "external" ? "external" : "secondary",
      x: 80 + (document.nodes.length % 4) * 36, y: 90 + (document.nodes.length % 5) * 30,
      width: role === "decision" ? 156 : role === "actor" ? 154 : 190, height: role === "decision" ? 84 : 82, layoutHints: {}
    };
    const next = { ...document, nodes: [...document.nodes, node] };
    setSelectedNodeId(id);
    commitDocument(next, "Added node: " + node.name);
    void runLayout(next);
  }

  async function addRelation() {
    if (!selectedNode || !relationTargetId || relationTargetId === selectedNode.id) return;
    const alreadyExists = document.relations.some((relation) =>
      relation.source === selectedNode.id && relation.target === relationTargetId && relation.label === relationLabel.trim()
    );
    if (alreadyExists) {
      setLastAction("That relation already exists");
      return;
    }
    const next = await requestServerSequenceNormalize({
      ...document,
      relations: [...document.relations, {
        id: newId("relation"),
        source: selectedNode.id,
        target: relationTargetId,
        label: relationLabel.trim(),
        kind: document.kind === "sequence" ? "call" : "flow",
        sequenceOrder: document.kind === "sequence" ? document.relations.length : undefined,
        points: []
      }]
    });
    setRelationLabel("");
    commitDocument(next, "Linked " + selectedNode.name + " → " + (document.nodes.find((node) => node.id === relationTargetId)?.name || relationTargetId));
    if (document.kind !== "sequence") void runLayout(next);
  }

  function commitRelationLabel(relationId: string) {
    const current = document.relations.find((relation) => relation.id === relationId);
    if (!current) return;
    const label = relationLabelDrafts[relationId] ?? current.label;
    setRelationLabelDrafts((drafts) => {
      const next = { ...drafts };
      delete next[relationId];
      return next;
    });
    if (label === current.label) return;
    const next = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId ? { ...relation, label } : relation)
    };
    commitDocument(next, "Relation label updated");
  }

  async function removeRelation(relationId: string) {
    if (selectedRelationId === relationId) setSelectedRelationId(null);
    const next = await requestServerSequenceNormalize({ ...document, relations: document.relations.filter((relation) => relation.id !== relationId) });
    setRelationLabelDrafts((drafts) => {
      const updated = { ...drafts };
      delete updated[relationId];
      return updated;
    });
    commitDocument(next, "Relation removed");
  }

  function reverseRelation(relationId: string) {
    const next = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, source: relation.target, target: relation.source, points: [] }
        : relation)
    };
    commitDocument(next, "Relation direction reversed");
    if (document.kind !== "sequence") void runLayout(next);
  }

  function updateRelationStyle(
    relationId: string,
    patch: { dashed?: boolean; routing?: "orthogonal" | "polyline" | "curved" | undefined }
  ) {
    const routingChanged = Object.prototype.hasOwnProperty.call(patch, "routing");
    const next: DiagramDocument = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, ...patch, points: routingChanged ? [] : relation.points }
        : relation)
    };
    if (routingChanged && document.kind !== "sequence") {
      void runLayout(next);
      return;
    }
    commitDocument(next, routingChanged ? "Relation routing updated" : "Relation line style updated");
  }

  async function removeNodeById(nodeId: string) {
    setSelectedRelationId(null);
    const next = await requestServerSequenceNormalize({
      ...document,
      nodes: document.nodes.filter((node) => node.id !== nodeId),
      relations: document.relations.filter((relation) => relation.source !== nodeId && relation.target !== nodeId),
      boundaries: document.boundaries.map((boundary) => ({ ...boundary, members: boundary.members.filter((id) => id !== nodeId) })),
      flow: document.flow ? { ...document.flow, primaryPath: document.flow.primaryPath.filter((id) => id !== nodeId) } : undefined,
      sequence: document.sequence ? { ...document.sequence, participants: document.sequence.participants.filter((id) => id !== nodeId) } : undefined
    });
    setSelectedNodeId(next.nodes[0]?.id || null);
    commitDocument(next, "Node and its relations removed");
  }

  async function removeSelectedNode() {
    if (!selectedNode) return;
    await removeNodeById(selectedNode.id);
  }

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

  async function importDiagramFile(file: File | undefined) {
    if (!file) return;
    const startedAt = Date.now();
    recordDiagnostic("drawio.import.started", "Draw.io import started", { fileBytes: file.size, fileType: file.name.split(".").pop()?.toLowerCase() || "unknown" });
    try {
      const xml = await file.text();
      const empty: DiagramDocument = { ...document, id: newId("imported"), nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined };
      const parsed = fromDrawioXml(xml, empty);
      if (!parsed.nodes.length) {
        setLastAction("No importable nodes found; check that the file is valid .drawio XML");
        return;
      }
      const next = await requestServerLayout(parsed);
      setSelectedRelationId(null);
      setSelectedNodeId(next.nodes[0]?.id || null);
      commitDocument(next, "Imported " + file.name + " with " + next.nodes.length + " nodes and " + next.relations.length + " relations");
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
      setActivePage("studio");
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
      <Modal title="Set up project workspace" open={!workspaceChecking && workspaceSetupOpen} closable={Boolean(projectWorkspace)} maskClosable={false} onCancel={() => { if (projectWorkspace) setWorkspaceSetupOpen(false); }} footer={null} width={680}>
        <div style={{ display: "grid", gap: 16, paddingTop: 8 }}>
          <p>The workspace is the project boundary for every diagram edit, code analysis and agent run. The repository root is pre-filled and recommended, but any project root works; the server scans it for Draw.io diagrams, code and design docs, and stores the config as JSON.</p>
          {workspaceError && <div role="alert" style={{ color: "#b42318", background: "#fef3f2", borderRadius: 6, padding: 10 }}>{workspaceError}</div>}
          <label style={{ display: "grid", gap: 6 }}><strong>Workspace name</strong><Input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="e.g. Payments Architecture" /></label>
          <label style={{ display: "grid", gap: 6 }}><strong>Absolute path of the local project directory</strong><Input value={workspaceRootPath} onChange={(event) => setWorkspaceRootPath(event.target.value)} placeholder="Defaults to the repository root; any other project root works too" /></label>
          <small style={{ color: "var(--muted, #667085)" }}>The local Node.js server reads this path, not a browser file picker. Point it at a project root containing source, ADRs, READMEs and .drawio files.</small>
          {workspaceFiles.length > 0 && <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12 }}><strong>Files found</strong><div style={{ marginTop: 6 }}>{workspaceFiles.length} files · {workspaceFiles.filter((file) => file.kind === "diagram").length} diagrams · {workspaceFiles.filter((file) => file.kind === "code").length} code files · {workspaceFiles.filter((file) => file.kind === "document").length} documents</div></div>}
          <label style={{ display: "grid", gap: 6 }}><strong>Primary Draw.io diagram (optional)</strong><Select value={workspacePrimaryDiagram || undefined} allowClear showSearch placeholder="Save the directory first to pick a primary diagram" options={workspaceFiles.filter((file) => file.kind === "diagram" && /\\.(drawio|dio|xml)$/i.test(file.path)).map((file) => ({ value: file.path, label: file.path }))} onChange={(value) => setWorkspacePrimaryDiagram(value || "")} /></label>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><Button onClick={() => { void (async () => { try { setWorkspaceError(""); const response = await fetch("/api/workspace/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath }) }); const result = await response.json() as { error?: string; files?: WorkspaceFile[]; workspace?: ProjectWorkspace }; if (!response.ok || !result.workspace) throw new Error(result.error || "Directory scan failed"); setWorkspaceFiles(result.files || []); if (projectWorkspace?.rootPath === result.workspace.rootPath && projectWorkspace.primaryDiagram) setWorkspacePrimaryDiagram(projectWorkspace.primaryDiagram); else setWorkspacePrimaryDiagram(""); } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)); } })(); }}>Verify directory and scan</Button><Button type="primary" loading={workspaceSaving} disabled={!workspaceName.trim() || !workspaceRootPath.trim()} onClick={() => void saveProjectWorkspace()}>Save and open Studio</Button></div>
          <small style={{ color: "var(--muted, #667085)" }}>Config file: ~/.architecture-diagram-studio/data/project-workspace.json. Agents and MCP reach the workspace through the server API, never through browser localStorage.</small>
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
        <div className="document-breadcrumb"><span className="crumb-muted">{projectWorkspace?.name || "WORKSPACE"}</span><span className="crumb-sep">/</span><strong>{document.title}</strong><span className="save-state"><i />Saved · r{revision}</span></div>
        <nav className="workspace-nav" aria-label="Workspace pages">
          {([["studio", "Studio"], ["copilot", "Layout Copilot"], ["traces", "Agent traces"], ["settings", "Settings"]] as Array<[WorkspacePage, string]>).map(([page, label]) =>
            <UiButton key={page} type="button" className={(page === "copilot" ? activePage === "studio" && rightPanelTab === "copilot" : activePage === page) ? "active" : ""} aria-current={(page === "copilot" ? activePage === "studio" && rightPanelTab === "copilot" : activePage === page) ? "page" : undefined} onClick={() => openPage(page)}>{label}{page === "traces" && traceEntries.some((entry) => entry.level === "error") && <i className="nav-error-dot" />}</UiButton>
          )}
        </nav>
        <label className="theme-selector" title="Switch the color theme of the whole workspace">
          <span aria-hidden="true">◐</span>
          <UiSelect value={uiTheme} aria-label="Interface color theme" popupMatchSelectWidth={false} onChange={(event) => setUiTheme(event.target.value as UiTheme)}>
            <option value="editorial">Editorial</option>
            <option value="youth">Vivid</option>
            <option value="warm">Warm paper</option>
            <option value="midnight">Midnight</option>
          </UiSelect>
        </label>
        <UiInput ref={importFileRef} className="file-input-hidden" type="file" accept=".drawio,.xml,application/xml,text/xml" onChange={(event) => void importDiagramFile(event.target.files?.[0])} />
        {activePage === "studio" ? <div className="topbar-actions">
          <UiButton className="button button-quiet" disabled={!canUndo || Boolean(previewDocument)} onClick={undoDocument}>Undo</UiButton>
          <UiButton className="button button-quiet" disabled={!canRedo || Boolean(previewDocument)} onClick={redoDocument}>Redo</UiButton>
          <UiButton className="button button-quiet" title="Reload the built-in sample" onClick={resetDiagram}>Reset</UiButton>
          <UiButton className="button button-secondary" title="Import a .drawio file" onClick={() => importFileRef.current?.click()}><span className="button-icon">↑</span>Import</UiButton>
          <UiButton className="button button-secondary" title="Export a .drawio file" onClick={exportDiagram} disabled={Boolean(previewDocument)}><span className="button-icon">↓</span>Export</UiButton>
          <UiButton className="button button-secondary" title="Browse and restore saved versions" onClick={() => void openVersionHistory()}>History</UiButton>
          <UiButton className="button button-primary" disabled={Boolean(previewDocument)} onClick={() => setViewMode(viewMode === "studio" ? "drawio" : "studio")}><span className="button-icon">◇</span>{viewMode === "studio" ? "Freeform editor" : "Studio canvas"}</UiButton>
        </div> : <div className="topbar-actions"><UiButton className="button button-secondary" type="button" onClick={() => openPage("studio")}>Back to canvas</UiButton></div>}
      </header>

      {activePage === "studio" ? (
        <>
      <aside className="left-panel">
        {projectWorkspace && <div className="workspace-card" title={projectWorkspace.rootPath}>
          <b>{projectWorkspace.name}</b>
          <UiButton type="button" className="workspace-switch" onClick={() => setWorkspaceSetupOpen(true)}>Switch workspace</UiButton>
        </div>}
        <div className="side-section">
          <UiButton className={"diagram-kind " + (document.kind === "c4" ? "active" : "")} onClick={() => changeKind("c4")}>
            <span className="kind-icon kind-c4"><i /><i /><i /></span><span className="kind-text"><b>C4 architecture</b></span>
          </UiButton>
          <UiButton className={"diagram-kind " + (document.kind === "flowchart" ? "active" : "")} onClick={() => changeKind("flowchart")}>
            <span className="kind-icon kind-flow"><i /><i /><i /></span><span className="kind-text"><b>Process flow</b></span>
          </UiButton>
          <UiButton className={"diagram-kind " + (document.kind === "sequence" ? "active" : "")} onClick={() => changeKind("sequence")}>
            <span className="kind-icon kind-sequence"><i /><i /></span><span className="kind-text"><b>Sequence diagram</b></span>
          </UiButton>
        </div>

        <div className="side-section components-section">
          <div className="section-heading">Add element</div>
          <div className="add-grid">
            <button type="button" onClick={() => addNode("ui")}><span className="add-glyph">▱</span>UI</button>
            <button type="button" onClick={() => addNode("domain")}><span className="add-glyph">▰</span>Business service</button>
            <button type="button" onClick={() => addNode("storage")}><span className="add-glyph">▤</span>Database</button>
            <button type="button" onClick={() => addNode("external")}><span className="add-glyph">↗</span>External system</button>
            <button type="button" onClick={() => addNode("infra")}><span className="add-glyph">⌘</span>Infrastructure</button>
            <button type="button" onClick={() => addNode("decision")}><span className="add-glyph">◇</span>Decision / branch</button>
          </div>
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
            {document.kind === "sequence" && <UiButton className="toolbar-button" onClick={addSequenceFragment} disabled={Boolean(previewDocument)}>＋ Sequence fragment</UiButton>}
            <label className="layout-profile-control" title="Choose the auto-layout algorithm">
              <span>Algorithm</span>
              <UiSelect className="text-field" aria-label="Auto-layout algorithm" value={LAYOUT_PROFILES.some((profile) => profile.value === document.layout.profile) ? document.layout.profile : (enabledLayoutProfiles[0] || "elk-layered") }
                disabled={isLayoutting || Boolean(previewDocument) || document.kind === "sequence"}
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
            <UiButton className="toolbar-button" onClick={() => void runLayout()} disabled={isLayoutting || Boolean(previewDocument)}><span>{isLayoutting ? <i className="spinner" /> : "⌁"}</span>{isLayoutting ? "Computing…" : "Auto layout"}</UiButton>
            <div className="segmented"><UiButton disabled={Boolean(previewDocument)} className={viewMode === "studio" ? "selected" : ""} onClick={() => setViewMode("studio")}>Studio</UiButton><UiButton disabled={Boolean(previewDocument)} className={viewMode === "drawio" ? "selected" : ""} onClick={() => setViewMode("drawio")} title="Freeform editing in the embedded Draw.io canvas">Freeform</UiButton></div>
          </div>
        </div>

        <div className={"canvas-stage " + (viewMode === "drawio" ? "native-mode" : "")}>
          {viewMode === "studio" ? (
            <DiagramCanvas document={visibleDocument} zoom={studioZoom} viewResetToken={canvasViewResetToken} selectedNodeId={selectedNodeId}
              selectedRelationId={selectedRelationId} onSelectNode={selectNode} onSelectRelation={selectRelation}
              onContextMenu={(target, x, y) => {
                if (target.kind === "node") { setSelectedNodeId(target.id || null); setSelectedRelationId(null); }
                if (target.kind === "relation") setSelectedRelationId(target.id || null);
                setCanvasMenu({ x, y, kind: target.kind, id: target.id });
              }}
              onMoveNode={(id, x, y) => {
                // The drop is applied locally and committed right away. The server call used to own this step,
                // so a slow or unreachable API made the node fall back into its previous spot on release,
                // which reads as "drag it apart and it snaps back"; moveNode is pure geometry, so both sides compute the same result.
                const moved = moveNode(visibleDocument, id, x, y);
                if (previewDocument) {
                  setPreviewDocument(moved);
                  setPreviewSummary((summary) => summary ? summary + "; node positions adjusted manually in the preview" : "Node positions adjusted manually in the preview");
                } else {
                  commitDocument(moved, "Node moved manually; its position is now locked");
                }
                void fetch("/api/workspace/diagram/move-node", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ document: visibleDocument, id, x, y })
                }).then(async (response) => {
                  const payload = await response.json() as { document?: DiagramDocument; error?: string };
                  if (!response.ok || !payload.document) throw new Error(payload.error || "Node move failed");
                  const settled = payload.document.nodes.find((node) => node.id === id);
                  const local = moved.nodes.find((node) => node.id === id);
                  if (!settled || !local || (settled.x === local.x && settled.y === local.y)) return;
                  // The server only disagrees when its conflict search had to nudge the node; adopt that spot
                  // without creating a second undo step for the same drag.
                  if (previewDocument) setPreviewDocument(payload.document);
                  else replaceDocument(payload.document);
                  recordDiagnostic("diagram.node-move.reconciled", "Server nudged the node position per its conflict rules", {
                    documentId: payload.document.id, nodeId: id, localX: local.x, localY: local.y, serverX: settled.x, serverY: settled.y
                  });
                }).catch((error: unknown) => {
                  recordDiagnostic("diagram.node-move.sync-failed", "Node position could not be synced to the server; kept locally", {
                    documentId: visibleDocument.id, nodeId: id, errorMessage: error instanceof Error ? error.message : String(error)
                  }, "warn");
                });
              }} />
          ) : (
            <DrawioFrame document={document} xml={drawioXml} onDocumentChange={(next, nativeXml) => commitDocument(next, "Synced changes from native Draw.io", nativeXml)} />
          )}
          {viewMode === "studio" && <div className="zoom-indicator">
            <UiButton type="button" className="zoom-control" aria-label="Zoom out" disabled={studioZoom <= 0.5} onClick={() => setStudioZoom((zoom) => Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10))}>−</UiButton>
            <UiButton type="button" className="zoom-percent" aria-label="Reset canvas view" title="Reset pan and zoom" onClick={() => { setStudioZoom(1); setCanvasViewResetToken((value) => value + 1); }}>{Math.round(studioZoom * 100)}%</UiButton>
            <UiButton type="button" className="zoom-control" aria-label="Zoom in" disabled={studioZoom >= 1.8} onClick={() => setStudioZoom((zoom) => Math.min(1.8, Math.round((zoom + 0.1) * 10) / 10))}>＋</UiButton>
          </div>}
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
            openStudio={() => { setViewMode("studio"); setRightPanelTab("properties"); }}
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
              <div className="field-label">Selected relation · source</div>
              <UiSelect className="text-field" aria-label="Relation source node" value={selectedRelation.source}
                onChange={(event) => changeRelationEndpoints(selectedRelation.id, event.target.value, selectedRelation.target)}>
                {document.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
              </UiSelect>
              <div className="field-label">Target node</div>
              <UiSelect className="text-field" aria-label="Relation target node" value={selectedRelation.target}
                onChange={(event) => changeRelationEndpoints(selectedRelation.id, selectedRelation.source, event.target.value)}>
                {document.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
              </UiSelect>
              <div className="field-label">Relation label</div>
              <UiInput className="text-field" aria-label="Relation label" value={relationLabelDrafts[selectedRelation.id] ?? selectedRelation.label}
                onChange={(event) => setRelationLabelDrafts((drafts) => ({ ...drafts, [selectedRelation.id]: event.target.value }))}
                onBlur={() => commitRelationLabel(selectedRelation.id)} />
              <div className="relation-actions">
                <UiButton type="button" onClick={() => reverseRelation(selectedRelation.id)}>↔ Reverse</UiButton>
                <UiButton type="button" onClick={() => removeRelation(selectedRelation.id)}>Delete relation</UiButton>
              </div>
            </div>
          )}
          {selectedNode && !selectedRelation ? (
            <div className="inspector-form">
              <div className="field-label">Name</div><UiInput key={selectedNode.id + ":" + selectedNode.name} className="text-field" defaultValue={selectedNode.name} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.name) changeNode({ name: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">Semantic role</div>
              <UiSelect className="text-field" value={selectedNode.role} onChange={(event) => changeNode({ role: event.target.value as DiagramNode["role"] })}>
                {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
              </UiSelect>
              <div className="field-label">Technology / platform</div><UiInput key={selectedNode.id + ":" + (selectedNode.technology || "")} className="text-field" defaultValue={selectedNode.technology || ""} placeholder="e.g. Java / Spring" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.technology || "")) changeNode({ technology: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">Description</div><UiTextArea key={selectedNode.id + ":" + (selectedNode.description || "")} className="text-field text-area" defaultValue={selectedNode.description || ""} placeholder="What this component is responsible for…" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.description || "")) changeNode({ description: event.currentTarget.value }); }} rows={2} />
              <label className="lock-row"><UiInput type="checkbox" checked={Boolean(selectedNode.layoutHints?.locked)} onChange={(event) => changeNode({ layoutHints: { ...(selectedNode.layoutHints || {}), locked: event.target.checked } })} /><span><b>Lock position</b></span></label>
              <div className="relation-editor">
                <div className="field-label">Add relation</div>
                <UiSelect className="text-field" value={relationTargetId} onChange={(event) => setRelationTargetId(event.target.value)}>
                  <option value="">Pick a target node…</option>
                  {document.nodes.filter((node) => node.id !== selectedNode.id).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                </UiSelect>
                <UiInput className="text-field relation-label-field" value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} placeholder="Relation description (optional)" />
                <UiButton className="relation-add-button" onClick={addRelation} disabled={!relationTargetId || relationTargetId === selectedNode.id}>＋ Add relation</UiButton>
              </div>
              <div className="connected-relations">
                <div className="field-label">Relations ({document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).length})</div>
                {document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).map((relation) => (
                  <div className={"connected-relation" + (selectedRelationId === relation.id ? " active" : "")} key={relation.id}>
                    <div className="connected-relation-direction">
                      <span>{document.nodes.find((node) => node.id === relation.source)?.name || relation.source}</span>
                      <span className="relation-arrow">→</span>
                      <span>{document.nodes.find((node) => node.id === relation.target)?.name || relation.target}</span>
                    </div>
                    <UiInput
                      className="text-field relation-label-field"
                      value={relationLabelDrafts[relation.id] ?? relation.label}
                      placeholder="Relation label…"
                      onChange={(event) => setRelationLabelDrafts((drafts) => ({ ...drafts, [relation.id]: event.target.value }))}
                      onBlur={() => commitRelationLabel(relation.id)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
                    />
                    <div className="relation-style-controls">
                      <label>Routing
                        <UiSelect className="text-field" disabled={document.kind === "sequence"} value={relation.routing || "inherit"} onChange={(event) => {
                          const value = event.target.value;
                          updateRelationStyle(relation.id, { routing: value === "inherit" ? undefined : value as "orthogonal" | "polyline" | "curved" });
                        }}>
                          <option value="inherit">Default</option>
                          <option value="orthogonal">Orthogonal</option>
                          <option value="polyline">Polyline</option>
                          <option value="curved">Curved</option>
                        </UiSelect>
                      </label>
                      <label>Line style
                        <UiSelect className="text-field" value={relation.dashed === undefined ? "inherit" : relation.dashed ? "dashed" : "solid"} onChange={(event) => {
                          const value = event.target.value;
                          updateRelationStyle(relation.id, { dashed: value === "inherit" ? undefined : value === "dashed" });
                        }}>
                          <option value="inherit">Default</option>
                          <option value="solid">Solid</option>
                          <option value="dashed">Dashed</option>
                        </UiSelect>
                      </label>
                    </div>
                    <div className="relation-actions">
                      <UiButton type="button" title="Reverse direction" onClick={() => reverseRelation(relation.id)}>↔ Direction</UiButton>
                      <UiButton type="button" title="Delete relation" onClick={() => removeRelation(relation.id)}>Delete</UiButton>
                    </div>
                  </div>
                ))}
                {document.relations.every((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id) && <div className="empty-relations">This element has no relations yet.</div>}
              </div>
              {document.kind === "sequence" && (document.sequence?.fragments || []).length > 0 && <div className="sequence-fragment-editor">
                <div className="field-label">Sequence fragments (alt / opt / loop)</div>
                {(document.sequence?.fragments || []).map((fragment) => (
                  <div className="sequence-fragment-card" key={fragment.id}>
                    <UiSelect className="text-field" value={fragment.kind} onChange={(event) => updateSequenceFragment(fragment.id, { kind: event.target.value as SequenceFragment["kind"] })}>
                      <option value="alt">alt · conditional</option>
                      <option value="opt">opt · optional</option>
                      <option value="loop">loop · loop</option>
                    </UiSelect>
                    <UiInput key={fragment.id + ":" + fragment.label} className="text-field" defaultValue={fragment.label} placeholder="Fragment description" onBlur={(event) => {
                      if (event.currentTarget.value !== fragment.label) updateSequenceFragment(fragment.id, { label: event.currentTarget.value });
                    }} />
                    <div className="sequence-fragment-range">
                      <label>Start message<UiInput key={fragment.id + ":start:" + fragment.startOrder} type="number" min="0" max={Math.max(0, document.relations.length - 1)} defaultValue={fragment.startOrder} onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isFinite(value) && value !== fragment.startOrder) updateSequenceFragment(fragment.id, { startOrder: value });
                      }} /></label>
                      <label>End message<UiInput key={fragment.id + ":end:" + fragment.endOrder} type="number" min="0" max={Math.max(0, document.relations.length - 1)} defaultValue={fragment.endOrder} onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isFinite(value) && value !== fragment.endOrder) updateSequenceFragment(fragment.id, { endOrder: value });
                      }} /></label>
                    </div>
                    <UiButton type="button" className="sequence-fragment-remove" onClick={() => removeSequenceFragment(fragment.id)}>Delete fragment</UiButton>
                  </div>
                ))}
              </div>}
              <UiButton className="delete-node-button" onClick={removeSelectedNode}>Delete this element</UiButton>
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
          openStudio={() => { setViewMode("studio"); openPage("studio"); }}
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
        return <div className="canvas-menu" role="menu" style={{ left: canvasMenu.x, top: canvasMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          {menuNode && <>
            <div className="canvas-menu-title">{menuNode.name}</div>
            <button type="button" role="menuitem" onClick={() => { changeNode({ layoutHints: { ...(menuNode.layoutHints || {}), locked: !menuNode.layoutHints?.locked } }); close(); }}>{menuNode.layoutHints?.locked ? "Unlock position" : "Lock position"}</button>
            <button type="button" role="menuitem" onClick={() => { setRightPanelTab("properties"); close(); }}>Edit properties</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { void removeNodeById(menuNode.id); close(); }}>Delete node</button>
          </>}
          {menuRelation && <>
            <div className="canvas-menu-title">{menuRelation.label || "Relation"}</div>
            <button type="button" role="menuitem" onClick={() => { void reverseRelation(menuRelation.id); close(); }}>Reverse direction</button>
            <button type="button" role="menuitem" onClick={() => { setRightPanelTab("properties"); close(); }}>Edit relation</button>
            <button type="button" role="menuitem" className="danger" onClick={() => { void removeRelation(menuRelation.id); close(); }}>Delete relation</button>
          </>}
          {canvasMenu.kind === "canvas" && <>
            <button type="button" role="menuitem" onClick={() => { void runLayout(); close(); }}>Auto layout</button>
            <button type="button" role="menuitem" onClick={() => { setStudioZoom(1); setCanvasViewResetToken((value) => value + 1); close(); }}>Reset view</button>
          </>}
        </div>;
      })()}
    </Layout>
        </AntApp>
      </XProvider>
    </ConfigProvider>
  );
}