import { Children, isValidElement, useEffect, useRef, useState } from "react";
import { App as AntApp, Button, ConfigProvider, Input, InputNumber, Layout, Modal, Select, theme as antdTheme } from "antd";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import type { ButtonHTMLAttributes, ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, SelectHTMLAttributes } from "react";
import { useCopilotIntent } from "./hooks/useCopilotIntent";
import { calculateDrawioXmlRevision } from "./intent/aiProvider";
import { calculateNativePalettePlan, detectDrawioDiagramTheme, type DrawioDiagramTheme } from "./model/drawio-theme";
import { getDrawioXmlDiagnostics, isDrawioXmlDocument } from "./model/drawio-xml-source";
import DrawioFrame, { DRAWIO_VERSION, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, type DrawioFrameHandle, type NativeAutoLayoutOptions, type NativeHistoryState } from "./components/DrawioFrame";
import NativeSelectionInspector from "./components/NativeSelectionInspector";
import WorkspacePages, { type WorkspacePage } from "./components/WorkspacePages";
import { readDiagnosticEntries, recordDiagnostic, setDiagnosticScope } from "./diagnostics";
import type { DiagnosticEntry } from "./diagnostics";
import { useWorkspacePersistence, type WorkspaceSaveState } from "./hooks/useWorkspacePersistence";
import { useWorkspaceBootstrap } from "./hooks/useWorkspaceBootstrap";
import { calculateNativeAutoLayout, defaultNativeLayoutAlgorithm, nativeLayoutAlgorithmsForEngine, nativeLayoutSupportsDirection, nativeLayoutSupportsAlgorithm, NATIVE_AUTO_LAYOUT_ENGINES } from "./layout/native-layout";
import { spatialRegionAnalysisProvider } from "./layout/spatial-region-analysis";
import { chooseDrawioFile, chooseDrawioSaveFile, ensureDrawioWritePermission, getLocalDocumentId, writeDrawioFile, type StudioLocalFileHandle } from "./persistence/local-file-handles";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number; proposal?: { id: string; summary: string } };
type VersionSummary = { id: string; createdAt: string; label: string };
type ProjectWorkspace = { schemaVersion: 1; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
type WorkspaceFile = { path: string; name: string; kind: "diagram" | "code" | "document" | "other"; size: number; modifiedAt: string };
type UiTheme = "editorial" | "youth" | "warm" | "midnight";
type DiagramTheme = DrawioDiagramTheme;

const NATIVE_LAYOUT_STORAGE_KEY = "architecture-diagram-studio:v2:native-layout-options";
const NATIVE_LAYOUT_ENGINE_LABELS: Record<NativeAutoLayoutOptions["engine"], string> = {
  elk: "ELK", dagre: "Dagre", graphviz: "Graphviz", msagl: "MSAGL.js", cytoscape: "Cytoscape.js", d3: "D3"
};
const NATIVE_LAYOUT_ENGINES: Array<{ value: NativeAutoLayoutOptions["engine"]; label: string }> =
  NATIVE_AUTO_LAYOUT_ENGINES.map((value) => ({ value, label: NATIVE_LAYOUT_ENGINE_LABELS[value] }));
const NATIVE_LAYOUT_DIRECTIONS: Array<{ value: NativeAutoLayoutOptions["direction"]; label: string }> = [
  { value: "RIGHT", label: "Left to right" },
  { value: "LEFT", label: "Right to left" },
  { value: "DOWN", label: "Top to bottom" },
  { value: "UP", label: "Bottom to top" }
];

function loadNativeLayoutOptions(): NativeAutoLayoutOptions {
  try {
    const raw = window.localStorage.getItem(NATIVE_LAYOUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS };
    const saved = JSON.parse(raw) as Record<string, unknown>;
    // Migrate preferences from the retired Draw.io-native layout dropdown without losing user settings.
    const engine = NATIVE_AUTO_LAYOUT_ENGINES.includes(saved.engine as NativeAutoLayoutOptions["engine"]) ? saved.engine as NativeAutoLayoutOptions["engine"] : "elk";
    const oldAliases: Record<string, NativeAutoLayoutOptions["algorithm"]> = {
      elkLayered: "layered", elkTree: "mrtree", elkRadial: "radial", elkOrganic: "force"
    };
    const rawAlgorithm = typeof saved.algorithm === "string" ? saved.algorithm : "";
    const algorithmCandidate = nativeLayoutAlgorithmsForEngine(engine).some((item) => item.value === rawAlgorithm)
      ? rawAlgorithm as NativeAutoLayoutOptions["algorithm"]
      : oldAliases[rawAlgorithm] && nativeLayoutSupportsAlgorithm(engine, oldAliases[rawAlgorithm])
        ? oldAliases[rawAlgorithm]
        : defaultNativeLayoutAlgorithm(engine);
    const algorithm = nativeLayoutSupportsAlgorithm(engine, algorithmCandidate)
      ? algorithmCandidate : defaultNativeLayoutAlgorithm(engine);
    const direction = NATIVE_LAYOUT_DIRECTIONS.some((item) => item.value === saved.direction)
      ? saved.direction as NativeAutoLayoutOptions["direction"] : DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.direction;
    const edgeRouting = ["ORTHOGONAL", "POLYLINE", "SPLINES"].includes(String(saved.edgeRouting ?? ""))
      ? saved.edgeRouting as NativeAutoLayoutOptions["edgeRouting"] : DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.edgeRouting;
    const boundedNumber = (key: string, fallback: number, min: number, max: number) =>
      typeof saved[key] === "number" && Number.isFinite(saved[key])
        ? Math.max(min, Math.min(max, Math.round(saved[key] as number))) : fallback;
    return {
      engine, algorithm, direction, edgeRouting,
      nodeSpacing: boundedNumber("nodeSpacing", DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.nodeSpacing, 5, 500),
      layerSpacing: boundedNumber("layerSpacing", DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.layerSpacing, 10, 800),
      iterations: boundedNumber("iterations", DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.iterations, 20, 3000),
      randomSeed: boundedNumber("randomSeed", DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.randomSeed, 0, 100000),
      margin: boundedNumber("margin", DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.margin, 0, 300)
    };
  } catch {
    return { ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS };
  }
}
/** The persisted application appearance remains independent from the Draw.io diagram color preset. */
const THEME_ACCENTS: Record<UiTheme, string> = { editorial: "#425bc7", youth: "#b91f6d", warm: "#ad4d32", midnight: "#4b61ce" };
function loadSavedTheme(): UiTheme {
  try {
    const storageKey = "architecture-diagram-studio:v2:ui-theme";
    const versionKey = "architecture-diagram-studio:v2:ui-theme-version";
    const saved = window.localStorage.getItem(storageKey);
    const migrated = window.localStorage.getItem(versionKey) === "2";
    // Preserve the existing one-time migration from the legacy Editorial default to Warm.
    if (saved === "editorial" && !migrated) return "warm";
    if (saved === "editorial" || saved === "youth" || saved === "warm" || saved === "midnight") return saved;
  } catch { /* Keep the default appearance when browser storage is unavailable. */ }
  return "warm";
}
type PanelWidths = { right: number };
const PANEL_LIMITS: Record<keyof PanelWidths, [number, number]> = { right: [300, 620] };
const PANEL_STORAGE_KEY = "architecture-diagram-studio:v2:panel-widths";
function loadPanelWidths(): PanelWidths {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PanelWidths>;
      if (typeof parsed.right === "number") return { right: parsed.right };
    }
  } catch { /* Fall back to the default sidebar widths. */ }
  return { right: 380 };
}

/** Ant Design Button adapter preserving existing HTML button semantics during UI migration. */
function UiButton({ type, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...(props as any)} htmlType={type === "submit" ? "submit" : "button"} />;
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

const EMPTY_DRAWIO_XML = '<mxfile host="localhost" agent="Architecture Diagram Studio V2"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="800" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

export default function App() {
  // The active diagram is native Draw.io XML; browser storage keeps only user preferences.
  useEffect(() => {
    // Clear the obsolete browser-side semantic document cache once.
    try { window.localStorage.removeItem("architecture-diagram-studio:v2:document"); } catch { /* Storage may be disabled. */ }
  }, []);
  const [selectedNativeCellId, setSelectedNativeCellId] = useState<string | null>(null);
  const [selectedNativePageId, setSelectedNativePageId] = useState<string | null>(null);
  const [nativeHistoryState, setNativeHistoryState] = useState<NativeHistoryState>({ canUndo: false, canRedo: false });
  const [cellEditRequest, setCellEditRequest] = useState<{ cellId: string; pageId: string | null; path: string; value: string; requestId: number } | null>(null);
  const drawioFrameRef = useRef<DrawioFrameHandle | null>(null);
  const cellEditRequestSequenceRef = useRef(0);
  const nativeScriptWatchdogTimeoutMs = (() => {
    const configured = Number(import.meta.env.VITE_NATIVE_SCRIPT_WATCHDOG_TIMEOUT_MS);
    return Number.isFinite(configured) && configured >= 30_000 && configured <= 180_000
      ? Math.floor(configured)
      : 75_000;
  })();
  /** Resolves a Copilot batch only after Draw.io serializes it and workspace mode saves the XML. */
  const nativeEditResolversRef = useRef(new Map<number, (result: { success: boolean; error?: string; failureStage?: "editor" | "persistence"; auditWarning?: string; batchResults?: Array<{ index: number; cellId: string; path: string; value: string; success: boolean; error?: string; stack?: string }> | null; batchRolledBack?: boolean | null; scriptResult?: unknown; semanticChanged?: boolean; applicationState?: "applied-and-verified" | "changed-unverified" | "not-applied" | "unknown"; errorStack?: string }) => void>());
  const nativeEditAckContextsRef = useRef(new Map<number, { requestId: string; sessionId: string; standalone: boolean; documentRevision: string }>());
  const lateNativeEditRequestsRef = useRef(new Set<number>());
  const lateNativeSelectionRequestsRef = useRef(new Set<number>());
  const nativeEditWatchdogsRef = useRef(new Map<number, number>());
  const [rightPanelTab, setRightPanelTab] = useState<"properties" | "design" | "copilot">("properties");
  const [uiTheme] = useState<UiTheme>(() => loadSavedTheme());
  const [diagramTheme, setDiagramTheme] = useState<DiagramTheme | "">("");
  const [diagramThemeApplying, setDiagramThemeApplying] = useState(false);
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => loadPanelWidths());
  const [activePage, setActivePage] = useState<WorkspacePage>("diagram");
  const [traceEntries, setTraceEntries] = useState<DiagnosticEntry[]>(() => readDiagnosticEntries());
  const [drawioStatus, setDrawioStatus] = useState<"unknown" | "checking" | "ready" | "missing" | "error">("unknown");
  const [drawioStatusMessage, setDrawioStatusMessage] = useState("");
  const [autoLayoutRunning, setAutoLayoutRunning] = useState(false);
  const [nativeLayoutOptions, setNativeLayoutOptions] = useState<NativeAutoLayoutOptions>(() => loadNativeLayoutOptions());
  const [layoutSettingsOpen, setLayoutSettingsOpen] = useState(false);
  useEffect(() => {
    try { window.localStorage.setItem(NATIVE_LAYOUT_STORAGE_KEY, JSON.stringify(nativeLayoutOptions)); }
    catch { /* Layout preferences remain usable when browser storage is unavailable. */ }
  }, [nativeLayoutOptions]);
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
  const [aiModel, setAiModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<"low" | "medium" | "high" | "max">("medium");
  // Transcripts persisted by older sessions may open with a greeting that no longer exists;
  // drop it so a restored conversation starts with real content.
  const LEGACY_GREETING_PREFIXES = ["描述想要的布局变化即可", "Describe the change you want"];
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
  const [localHistoryOpen, setLocalHistoryOpen] = useState(false);
  const [localHistoryEntries, setLocalHistoryEntries] = useState<Array<{ id: string; createdAt: string; label: string; xml: string; xmlLength?: number }>>([]);
  const [localHistorySelectedId, setLocalHistorySelectedId] = useState<string | null>(null);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false);
  const [versionEntries, setVersionEntries] = useState<VersionSummary[]>([]);
  const [revision, setRevision] = useState(1);
  const [documentSaveState, setDocumentSaveState] = useState<WorkspaceSaveState | "exported">("saved");
  const lastExportedXmlRef = useRef<string | null>(null);
  const [lastAction, setLastAction] = useState("Draw.io editor ready");
  const [nativeEditorReady, setNativeEditorReady] = useState(false);
  const [standaloneFileName, setStandaloneFileName] = useState<string | null>(null);
  const [standaloneFileBinding, setStandaloneFileBinding] = useState<{ fileToken: string; documentId: string; name: string; revision: string; historyRevision: string } | null>(null);
  const standaloneFileBindingRef = useRef<{ fileToken: string; documentId: string; name: string; revision: string; historyRevision: string } | null>(null);
  const standaloneFileHandleRef = useRef<StudioLocalFileHandle | null>(null);
  const standaloneSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const standaloneLastSavedXmlRef = useRef<string | null>(null);

  // The complete native Draw.io XML is the only active diagram source.
  const [nativeXmlOverride, setNativeXmlOverride] = useState<string | null>(null);
  const serverRevisionRef = useRef<string | null>(null);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
  const traceScopeRef = useRef("single-file");
  useEffect(() => {
    const scope = standaloneFileName ? "single-file" : projectWorkspace?.id ? "workspace:" + projectWorkspace.id : "single-file";
    traceScopeRef.current = scope;
    setDiagnosticScope(scope);
  }, [standaloneFileName, projectWorkspace?.id]);
  useEffect(() => { setCellEditRequest(null); }, [activePage, projectWorkspace?.id]);
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
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not read the server model configuration");
        return response.json() as Promise<{ config?: { model?: string; reasoningEffort?: "low" | "medium" | "high" | "max" } }>;
      })
      .then((payload) => {
        if (!active || !payload.config) return;
        setAiModel(typeof payload.config.model === "string" ? payload.config.model : "");
        setReasoningEffort(["low", "medium", "high", "max"].includes(String(payload.config.reasoningEffort)) ? payload.config.reasoningEffort as "low" | "medium" | "high" | "max" : "medium");
      })
      .catch((error) => {
        if (active) recordDiagnostic("settings.configuration.load.failed", "Could not load the server model configuration", {
          errorMessage: error instanceof Error ? error.message : String(error)
        }, "error");
      });
    return () => { active = false; };
  }, []);
  const [workspaceError, setWorkspaceError] = useState("");
  const nextSaveLabelRef = useRef("Autosave");
  const drawioXml = nativeXmlOverride ?? EMPTY_DRAWIO_XML;
  const latestDiagramStateRef = useRef({ drawioXml, selectedNativeCellId, selectedNativePageId });
  latestDiagramStateRef.current = { drawioXml, selectedNativeCellId, selectedNativePageId };
  useEffect(() => {
    // Re-derive the preset from the current page XML after edits, page switches and document loads.
    // This avoids carrying a stale preset label across load boundaries or native Undo/Redo.
    setDiagramTheme(detectDrawioDiagramTheme(drawioXml, selectedNativePageId));
  }, [drawioXml, selectedNativePageId]);
  const bootstrap = useWorkspaceBootstrap({
    projectWorkspace, setNativeXmlOverride, setCopilotSessionId, setMessages,
    serverRevisionRef, setLastAction, onDiagnostic: recordDiagnostic
  });
  const { serverHydrated, workspaceContentReady, setWorkspaceContentReady, setServerXmlAvailable, workspaceInitialLoadRef } = bootstrap;
  const { persistDocumentNow, clearSaveConflict } = useWorkspacePersistence({ drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef: nextSaveLabelRef, serverRevisionRef, setLastAction, setSaveState: setDocumentSaveState, onDiagnostic: recordDiagnostic });

  useEffect(() => {
    function handleHistoryShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey);
      if (!isUndo && !isRedo) return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [role='textbox'], .ant-select-selection-search-input")) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      if (!nativeEditorReady || !drawioFrameRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      // Avoid interleaving with a palette/layout transaction, but keep the key away from browser-level undo.
      if (diagramThemeApplying || autoLayoutRunning || documentSaveState === "conflict") return;
      if (isRedo) drawioFrameRef.current.redo();
      else drawioFrameRef.current.undo();
    }
    window.addEventListener("keydown", handleHistoryShortcut, true);
    return () => window.removeEventListener("keydown", handleHistoryShortcut, true);
  }, [nativeEditorReady, diagramThemeApplying, autoLayoutRunning, documentSaveState]);

  // The native Draw.io editor is the only canvas; typed edits preserve unrelated XML cells.

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/config").then(async (response) => { if (!response.ok) throw new Error("Could not read the project workspace configuration"); return response.json() as Promise<{ configured?: boolean; workspace?: ProjectWorkspace | null; suggestedRootPath?: string }>; }).then((result) => { if (!active) return; const workspace = result.workspace || null; setProjectWorkspace(workspace); setWorkspaceSetupOpen(!workspace || !workspace.primaryDiagram); if (!workspace && result.suggestedRootPath) { setWorkspaceRootPath(result.suggestedRootPath); setWorkspaceName(result.suggestedRootPath.split(/[\\/]/).filter(Boolean).pop() || "Project Workspace"); } if (workspace) { setWorkspaceName(workspace.name); setWorkspaceRootPath(workspace.rootPath); setWorkspacePrimaryDiagram(workspace.primaryDiagram || ""); void fetch("/api/workspace/files").then(async (response) => {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json() as Promise<{ files?: WorkspaceFile[] }>;
      }).then((result) => { if (active) setWorkspaceFiles(result.files || []); }).catch((error: unknown) => {
        if (!active) return;
        recordDiagnostic("workspace.files.load.failed", "Could not load the project workspace file list", {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage: error instanceof Error ? error.message : String(error)
        }, "warn");
        setWorkspaceFiles([]);
      }); } }).catch((error) => { if (!active) return; setWorkspaceError(error instanceof Error ? error.message : String(error)); setWorkspaceSetupOpen(true); }).finally(() => { if (active) setWorkspaceChecking(false); });
    return () => { active = false; };
  }, []);

  async function saveProjectWorkspace(selectedDiagramPath?: string, requestedMode: "open" | "create" = workspaceLaunchMode) {
    const previousContentReady = workspaceContentReady;
    let serverActiveContextChanged = false;
    setWorkspaceSaving(true); setWorkspaceContentReady(false); setWorkspaceError("");
    try {
      // Flush the current file before the workspace's active diagram changes; the debounced autosave
      // is intentionally paused while the launch dialog is working.
      const activeStandalone = standaloneFileBindingRef.current;
      if (activeStandalone && standaloneFileName && drawioXml.trim() &&
          drawioXml !== standaloneLastSavedXmlRef.current) {
        await enqueueStandaloneSave(drawioXml, activeStandalone.fileToken);
        await standaloneSaveQueueRef.current;
      }
      if (!standaloneFileName && workspaceContentReady && projectWorkspace?.primaryDiagram && drawioXml.trim()) {
        await persistDocumentNow(drawioXml, "Autosave before changing the active diagram");
      }
      if (requestedMode === "create") {
        const response = await fetch("/api/workspace/diagram/create", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath, fileName: workspaceNewDiagramName,  })
        });
        const result = await response.json() as {
          error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[];
          drawioXml?: string; workspaceRevision?: string;
          version?: { id: string; createdAt: string; label: string };
        };
        serverActiveContextChanged = response.ok;
        if (!response.ok || !result.workspace || typeof result.drawioXml !== "string" || typeof result.workspaceRevision !== "string") {
          throw new Error(result.error || "Creating the Draw.io file failed");
        }
        const nextWorkspace = result.workspace;
        setNativeXmlOverride(result.drawioXml);
        setProjectWorkspace(nextWorkspace); setStandaloneFileBinding(null); standaloneFileBindingRef.current = null;
        standaloneFileHandleRef.current = null; setStandaloneFileName(null); standaloneLastSavedXmlRef.current = null; setWorkspaceFiles(result.files || []);
        setWorkspaceName(nextWorkspace.name); setWorkspaceRootPath(nextWorkspace.rootPath);
        setWorkspacePrimaryDiagram(nextWorkspace.primaryDiagram || "");
        const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session");
        setCopilotSessionId(newSessionId);
        setMessages([{ role: "assistant", id: Date.now(), text: "Created a new Draw.io diagram. The project workspace remains the folder; this file is the active diagram." }]);
        serverRevisionRef.current = result.workspaceRevision;
        workspaceInitialLoadRef.current = nextWorkspace.id;
        setServerXmlAvailable(true); setWorkspaceContentReady(true);
        setWorkspaceLaunchMode("open"); setWorkspaceSetupOpen(false);
        recordDiagnostic("workspace.diagram.created", "Created a new Draw.io file and opened it", {
          workspaceId: nextWorkspace.id, rootPath: nextWorkspace.rootPath, primaryDiagram: nextWorkspace.primaryDiagram,
          versionId: result.version?.id, xmlLength: result.drawioXml.length
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
        error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[]; workspaceRevision?: string | null;
        counts?: { files: number; diagrams: number; code: number; documents: number };
      };
      if (!response.ok || !result.workspace) throw new Error(result.error || "Opening the Draw.io workspace failed");
      const nextWorkspace = result.workspace;
      let nextXml: string | null = nativeXmlOverride;
      const workspaceChanged = projectWorkspace?.id !== nextWorkspace.id;
      const diagramChanged = projectWorkspace?.id === nextWorkspace.id && projectWorkspace?.primaryDiagram !== nextWorkspace.primaryDiagram;
      // Leaving a standalone file is a context boundary even when the configured workspace is unchanged.
      const diagramContextChanged = workspaceChanged || diagramChanged || Boolean(standaloneFileName);
      serverActiveContextChanged = diagramContextChanged;
      if (diagramContextChanged) {
        setMessages([{ role: "assistant", id: Date.now(), text: "Opened a different Draw.io diagram. The previous diagram's chat context and edit history are no longer active." }]);
        const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session");
        setCopilotSessionId(newSessionId);
        serverRevisionRef.current = null;
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

      } else if (workspaceChanged) {
        nextXml = EMPTY_DRAWIO_XML;
      }
      setNativeXmlOverride(nextXml);
      serverRevisionRef.current = typeof result.workspaceRevision === "string" ? result.workspaceRevision : null;
      // Opening a file is an explicit refresh, so don't let a prior Copilot receipt suppress
      // persistence if the native XML changed while the app was open.
      workspaceInitialLoadRef.current = nextWorkspace.id;
      setServerXmlAvailable(true); setProjectWorkspace(nextWorkspace); setStandaloneFileBinding(null); standaloneFileBindingRef.current = null;
        standaloneFileHandleRef.current = null; setStandaloneFileName(null); standaloneLastSavedXmlRef.current = null; setWorkspaceFiles(result.files || workspaceFiles);
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
    let traceRefreshInFlight = false;
    const refreshTraces = () => {
      if (traceRefreshInFlight) return;
      traceRefreshInFlight = true;
      void fetch("/api/workspace/logs?limit=1200&scope=" + encodeURIComponent(traceScopeRef.current))
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
          const chronological = [...byId.values()].sort((left, right) => {
            const leftTime = Date.parse(left.timestamp);
            const rightTime = Date.parse(right.timestamp);
            return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
          });
          setTraceEntries(chronological.slice(-1200));
        })
        .catch((error: unknown) => {
          recordDiagnostic("workspace.logs.load.failed", "Could not load server diagnostic logs; showing browser-local entries", {
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error)
          }, "warn");
          setTraceEntries(readDiagnosticEntries());
        })
        .finally(() => { traceRefreshInFlight = false; });
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
    window.addEventListener("studio:diagnostic-scope-change", refreshTraces);
    recordDiagnostic("app.started", "V2 workspace started", {
      diagramKind: "drawio", xmlLength: drawioXml.length
    });
    return () => {
      window.removeEventListener("studio:diagnostic", refreshTraces);
      window.removeEventListener("studio:diagnostic-clear", refreshTraces);
      window.removeEventListener("error", handleWindowError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
      window.removeEventListener("studio:diagnostic-scope-change", refreshTraces);
    };
  }, []);


  useEffect(() => {
    const binding = standaloneFileBinding;
    if (!binding || !standaloneFileName || !drawioXml || drawioXml === standaloneLastSavedXmlRef.current) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      setDocumentSaveState("saving");
      const pending = enqueueStandaloneSave(drawioXml, binding.fileToken);
      void pending.catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("changed outside") || message.includes("older editor revision")) setDocumentSaveState("conflict");
        else setDocumentSaveState("failed");
        setLastAction("Autosave failed for " + binding.name + ": " + message);
        recordDiagnostic("drawio.standalone.autosave.failed", "Could not save the opened Draw.io file through Node.js fs", {
          fileName: binding.name, documentId: binding.documentId, errorMessage: message
        }, "error");
      });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [drawioXml, standaloneFileBinding?.fileToken, standaloneFileBinding?.revision, standaloneFileName]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(panelWidths));
    } catch {
      // Resized widths stay for this session only.
    }
  }, [panelWidths]);

  useEffect(() => {
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:chat-messages", JSON.stringify(messages.slice(-300)));
    } catch {
      // Keep the active conversation usable if browser storage is unavailable.
    }
  }, [messages]);

  const { sendIntent, confirmProposal } = useCopilotIntent({
    projectWorkspace, standaloneMode: Boolean(standaloneFileName), chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId,
    getCurrentDiagramState: () => latestDiagramStateRef.current,
    getRuntimeInspection: ({ documentRevision, pageId, jsShapeClassNames }) => {
      const frame = drawioFrameRef.current;
      if (!frame) throw new Error("The native Draw.io frame is unavailable; no Agent request was sent.");
      return frame.inspectRuntime({ documentRevision, pageId, jsShapeClassNames });
    },
    persistWorkspaceDocument: (xml, label) => persistDocumentNow(xml, label),
    setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy, setCopilotSessionId,
    applyNativeCellEdit: async (cellId, path, value) => {
      const requestId = ++cellEditRequestSequenceRef.current;
      // Selection is UI state, not a document mutation: it must not consume a history slot.
      if (path !== "cell:select") await archiveStandaloneHistory("Before Copilot: " + path + " on " + cellId, requestId);
      recordDiagnostic("copilot.native-edit.dispatch", "Dispatching a Copilot edit to the active native Draw.io editor", {
        cellId, path, requestId, pageId: selectedNativePageId, standaloneMode: Boolean(standaloneFileName), fileName: standaloneFileName
      });
      if (path !== "cell:select") {
        setCellEditRequest({ cellId, pageId: selectedNativePageId, path, value, requestId });
        return;
      }
      // Pure focus actions still need a native bridge acknowledgement. Posting a request is not
      // proof the iframe accepted it; otherwise the chat can claim "Selected" while the canvas
      // never changed focus (or the target disappeared during dispatch).
      await new Promise<void>((resolve, reject) => {
        nativeEditResolversRef.current.set(requestId, (result) => {
          if (result.success) resolve();
          else reject(new Error(result.error || "Draw.io did not select the requested element."));
        });
        const watchdogTimeoutMs = 10_000;
        const watchdogTimerId = window.setTimeout(() => {
          nativeEditWatchdogsRef.current.delete(requestId);
          nativeEditResolversRef.current.delete(requestId);
          setCellEditRequest((current) => current?.requestId === requestId ? null : current);
          lateNativeSelectionRequestsRef.current.add(requestId);
          while (lateNativeSelectionRequestsRef.current.size > 100) {
            const oldest = lateNativeSelectionRequestsRef.current.values().next().value as number | undefined;
            if (oldest === undefined) break;
            lateNativeSelectionRequestsRef.current.delete(oldest);
          }
          const error = "Draw.io did not acknowledge the requested selection within 10 seconds; the focus result is unknown.";
          recordDiagnostic("copilot.selection.timeout", error, { requestId, cellId, pageId: selectedNativePageId, reconciliationPending: true }, "warn");
          reject(new Error(error));
        }, watchdogTimeoutMs);
        nativeEditWatchdogsRef.current.set(requestId, watchdogTimerId);
        setCellEditRequest({ cellId, pageId: selectedNativePageId, path, value, requestId });
      });
    },
    applyNativeCellEdits: async (edits, pageId, acknowledgement) => {
      if (lateNativeEditRequestsRef.current.size > 0) {
        return Promise.resolve({
          ok: false,
          error: "A previous native edit is still awaiting a final editor result. No new edit was dispatched.",
          rolledBack: false,
          applicationState: "unknown",
          auditWarning: "Inspect the current diagram and History. If no late result arrives, refresh/reload the Studio browser page and reopen the latest saved document; opening another file in the same page will not clear the in-memory pending state.",
          steps: []
        });
      }
      if (!edits.length) return Promise.resolve({ ok: false, error: "No native edits were supplied", rolledBack: false, steps: [] });
      const requestId = ++cellEditRequestSequenceRef.current;
      const containsReadOnlyScript = edits.length === 1 && edits[0].path === "cell:execute-script" && (() => {
        try {
          const payload = JSON.parse(edits[0].value) as { mode?: unknown; script?: unknown };
          return payload && payload.mode === "read" && typeof payload.script === "string";
        } catch {
          return false;
        }
      })();
      // An inspection is not a diagram edit. Do not create the "Before Copilot" standalone
      // history snapshot before knowing whether it is read-only; the snapshot itself would
      // pollute History even when DrawioFrame correctly skips persistence.
      if (containsReadOnlyScript) {
        recordDiagnostic("copilot.native-inspection.history-skipped",
          "Skipped the pre-edit standalone History snapshot for a read-only native inspection",
          { requestId, pageId, operationCount: edits.length });
      } else {
        await archiveStandaloneHistory("Before Copilot: " + edits.length + " native edit" + (edits.length === 1 ? "" : "s"), requestId);
      }
      const containsScript = edits.some((edit) => edit.path === "cell:execute-script");
      // DrawioFrame starts its XML-export confirmation window after the editor ACK.
      // Give that window plus a small scheduling buffer time to finish before the App watchdog.
      const watchdogTimeoutMs = containsScript ? nativeScriptWatchdogTimeoutMs + 40_000 : 30_000;
      return new Promise((resolve) => {
        nativeEditAckContextsRef.current.set(requestId, acknowledgement);
        nativeEditResolversRef.current.set(requestId, (result) => {
          resolve({
            ok: result.success,
            error: result.error,
            errorStack: result.errorStack,
            failureStage: result.failureStage,
            auditWarning: result.auditWarning,
            scriptResult: result.scriptResult,
            applicationState: result.applicationState,
            // Only explicit editor acknowledgement counts as a confirmed rollback; null/unknown is not success.
            rolledBack: result.success ? false : result.batchRolledBack === true,
            steps: (result.batchResults ?? []).map((step) => ({ index: step.index, cellId: step.cellId, path: step.path, value: step.value, success: step.success, error: step.error, stack: step.stack }))
          });
        });
        recordDiagnostic("copilot.native-edits.dispatch", "Dispatching an atomic native Draw.io edit batch to the active editor", {
          requestId, editCount: edits.length, edits, pageId: selectedNativePageId, standaloneMode: Boolean(standaloneFileName), fileName: standaloneFileName
        });
        setCellEditRequest({ cellId: "__batch__", pageId, path: "cell:batch", value: JSON.stringify(edits), requestId });
        const watchdogTimerId = window.setTimeout(() => {
          nativeEditWatchdogsRef.current.delete(requestId);
          const pending = nativeEditResolversRef.current.get(requestId);
          if (!pending) return;
          nativeEditResolversRef.current.delete(requestId);
          // Keep the acknowledgement context so a late serialized result can still be persisted
          // and reconciled with the server. A wait timeout is not proof of failure or rollback.
          lateNativeEditRequestsRef.current.add(requestId);
          setCellEditRequest((current) => current?.requestId === requestId ? null : current);
          const timeoutError = "The native Draw.io editor has not returned a final serialized result within " +
            Math.round(watchdogTimeoutMs / 1000) + " seconds. The edit outcome is still unknown.";
          recordDiagnostic("copilot.native-edits.timeout", "Stopped waiting for a native edit without declaring its final outcome", {
            requestId, editCount: edits.length, containsScript, watchdogTimeoutMs,
            reconciliationPending: true
          }, "warn");
          resolve({
            ok: false, error: timeoutError, rolledBack: false, applicationState: "unknown",
            auditWarning: "This is a wait timeout, not a confirmed rollback. Do not retry; the request remains pending reconciliation.",
            steps: []
          });
        }, watchdogTimeoutMs);
        nativeEditWatchdogsRef.current.set(requestId, watchdogTimerId);
      });
    }
  });

  async function applyDiagramTheme(theme: DrawioDiagramTheme) {
    if (diagramThemeApplying) return;
    const startingBinding = standaloneFileBindingRef.current;
    if (!projectWorkspace && !startingBinding) {
      setLastAction("Open or create a Draw.io document before applying a diagram color preset.");
      return;
    }
    if (!nativeEditorReady || !drawioFrameRef.current) {
      setLastAction("The native Draw.io editor is not ready for diagram colors.");
      return;
    }
    if (documentSaveState === "conflict") {
      setLastAction("Diagram colors were not changed because saving is paused after a revision conflict. Export or restore the authoritative version first.");
      return;
    }

    setDiagramThemeApplying(true);
    const source = latestDiagramStateRef.current;
    const sourceXml = source.drawioXml;
    const pageId = source.selectedNativePageId;
    const labels: Record<DiagramTheme, string> = {
      "ocean-depths": "Ocean Depths",
      "sunset-boulevard": "Sunset Boulevard",
      "forest-canopy": "Forest Canopy",
      "modern-minimalist": "Modern Minimalist",
      "golden-hour": "Golden Hour",
      "arctic-frost": "Arctic Frost",
      "desert-rose": "Desert Rose",
      "tech-innovation": "Tech Innovation",
      "botanical-garden": "Botanical Garden",
      "midnight-galaxy": "Midnight Galaxy"
    };
    const presetLabel = labels[theme];
    const saveLabel = "Apply Draw.io diagram colors (" + presetLabel + ", current page)";
    let applied = false;
    let appliedXml = sourceXml;
    try {
      const documentRevision = await calculateDrawioXmlRevision(sourceXml);
      const beforeApply = latestDiagramStateRef.current;
      if (beforeApply.drawioXml !== sourceXml || beforeApply.selectedNativePageId !== pageId) {
        throw new Error("The diagram or active page changed while colors were being prepared. Nothing was applied; select the preset again.");
      }
      const plan = calculateNativePalettePlan(sourceXml, pageId, documentRevision, theme);
      if (plan.changes.length === 0 && plan.expectedBackground === plan.background) {
        setDiagramTheme(detectDrawioDiagramTheme(sourceXml, pageId));
        setLastAction("The active page already matches " + presetLabel + ", or contains no colorable cells. No changes were made.");
        recordDiagnostic("drawio.palette.noop", "The active-page color preset produced no native style changes", {
          theme, pageId, xmlLength: sourceXml.length
        });
        return;
      }
      if (startingBinding) {
        const requestId = ++cellEditRequestSequenceRef.current;
        await archiveStandaloneHistory("Before diagram colors: " + presetLabel, requestId);
      }
      const currentBeforeMutation = latestDiagramStateRef.current;
      if (currentBeforeMutation.drawioXml !== sourceXml || currentBeforeMutation.selectedNativePageId !== pageId) {
        throw new Error("The diagram or active page changed before colors could be applied. No changes were made; retry.");
      }

      setLastAction("Applying " + presetLabel + " colors to the current page…");
      const serializedXml = await drawioFrameRef.current.applyPalette(plan);
      if (!isDrawioXmlDocument(serializedXml)) {
        throw new Error("Draw.io did not return valid XML after applying the color preset.");
      }
      applied = true;
      appliedXml = serializedXml;
      // The native autosave event normally updates this first. These assignments also make the
      // authoritative state explicit if the export response arrives before the autosave event.
      setNativeXmlOverride(serializedXml);
      setRevision((value) => value + 1);
      setDiagramTheme(detectDrawioDiagramTheme(serializedXml, pageId));

      if (startingBinding) {
        const activeBinding = standaloneFileBindingRef.current;
        if (!activeBinding || activeBinding.fileToken !== startingBinding.fileToken) {
          throw new Error("The active local file changed after the color transaction. The change remains in the editor, but saving was not confirmed.");
        }
        await enqueueStandaloneSave(serializedXml, activeBinding.fileToken);
        const savedBinding = standaloneFileBindingRef.current;
        const expectedRevision = await calculateDrawioXmlRevision(serializedXml);
        if (!savedBinding || savedBinding.fileToken !== activeBinding.fileToken || savedBinding.revision !== expectedRevision) {
          throw new Error("The local file did not confirm the exact XML revision after applying diagram colors.");
        }
        setDocumentSaveState("saved");
        try {
          await synchronizeStandaloneSnapshot(serializedXml, savedBinding.fileToken, saveLabel);
          setLastAction("Applied " + presetLabel + " colors to the current page and saved the Draw.io file.");
        } catch (historyError) {
          const message = historyError instanceof Error ? historyError.message : String(historyError);
          setLastAction("Applied " + presetLabel + " colors and saved the file, but local history sync failed: " + message);
          recordDiagnostic("drawio.palette.history-sync.failed", "The native color transaction was saved but standalone history synchronization failed", {
            theme, pageId, fileName: savedBinding.name, errorMessage: message, xmlLength: serializedXml.length
          }, "warn");
        }
      } else if (projectWorkspace && workspaceContentReady) {
        const saved = await persistDocumentNow(serializedXml, saveLabel);
        if (typeof saved.workspaceRevision !== "string" || typeof saved.version?.id !== "string") {
          throw new Error(saved.error || "The workspace did not confirm the color change's saved XML revision and version.");
        }
        setDocumentSaveState("saved");
        setLastAction("Applied " + presetLabel + " colors to the current page and saved a new Draw.io version.");
      } else {
        throw new Error("The active Draw.io document is not ready for a versioned save.");
      }

      recordDiagnostic("drawio.palette.applied", "Applied an active-page color preset through one native Draw.io model transaction", {
        theme, pageId, sourceXmlLength: sourceXml.length, themedXmlLength: serializedXml.length,
        changedCells: plan.changes.length, persistence: startingBinding ? "standalone-file" : "workspace"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (applied) {
        setNativeXmlOverride(appliedXml);
        setDiagramTheme(detectDrawioDiagramTheme(appliedXml, pageId));
        const likelyConflict = /conflict|revision|another editor|stale|changed outside/i.test(message);
        setDocumentSaveState(likelyConflict ? "conflict" : "failed");
        setLastAction("Applied " + presetLabel + " colors in the editor, but saving was not confirmed: " + message);
        recordDiagnostic("drawio.palette.persist.failed", "The native color transaction was applied, but the persistence step could not be confirmed", {
          theme, pageId, errorMessage: message, sourceXmlLength: sourceXml.length, appliedXmlLength: appliedXml.length
        }, "error");
      } else {
        setLastAction("Could not apply " + presetLabel + " colors: " + message);
        recordDiagnostic("drawio.palette.rejected", "The native color transaction was not confirmed as applied", {
          theme, pageId, errorMessage: message, sourceXmlLength: sourceXml.length
        }, "error");
      }
    } finally {
      setDiagramThemeApplying(false);
    }
  }

  async function saveAISettings() {
    const next = { model: aiModel.trim(), reasoningEffort };
    try {
      const response = await fetch("/api/workspace/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) });
      const payload = await response.json() as { config?: { model?: string; reasoningEffort?: "low" | "medium" | "high" | "max"; revisionId?: string }; error?: string };
      if (!response.ok || !payload.config) throw new Error(payload.error || "Saving the server config failed");
      setAiModel(payload.config.model || "");
      setReasoningEffort(payload.config.reasoningEffort || "medium");
      recordDiagnostic("settings.model.saved", "Model and reasoning effort written to a new server config revision", { model: next.model || "server-default", reasoningEffort: next.reasoningEffort, revisionId: payload.config.revisionId });
      setLastAction(next.model ? "Copilot SDK model settings saved as a new revision" : "Server default model selected in a new config revision");
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
      setAiModel("");
      setLastAction("Server default model selected in a new config revision");
      recordDiagnostic("settings.model.cleared", "Model settings cleared from the server revision history", { revisionId: payload.config.revisionId }, "warn");
    } catch (error) {
      setLastAction("Resetting the model to the server default failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }



  /** Drag the inspector edge to resize it; the width is persisted with the rest of the UI preferences. */
  function startPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidths.right;
    const [min, max] = PANEL_LIMITS.right;
    const onMove = (moveEvent: PointerEvent) => {
      const delta = startX - moveEvent.clientX;
      setPanelWidths((current) => ({ ...current, right: Math.min(max, Math.max(min, startWidth + delta)) }));
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

  async function openLocalFileDialog(mode: "open" | "import" | "export") {
    try {
      if (mode === "export") {
        await saveLocalExport();
        return;
      }
      const handle = await chooseDrawioFile();
      if (!handle) return;
      if (mode === "open") await openStandaloneDiagram(handle);
      else await importDiagramHandle(handle);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      const message = error instanceof Error ? error.message : String(error);
      setLastAction((mode === "import" ? "Import" : "Open") + " failed: " + message);
      recordDiagnostic("drawio.local-file-picker.failed", "The browser-native file picker operation failed", {
        mode, errorMessage: message
      }, "error");
    }
  }

  function enqueueStandaloneSave(xml: string, expectedToken: string): Promise<void> {
    const pending = standaloneSaveQueueRef.current.catch(() => undefined).then(() => persistStandaloneXml(xml, expectedToken));
    standaloneSaveQueueRef.current = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function synchronizeStandaloneSnapshot(xml: string, expectedToken: string, label: string): Promise<void> {
    const current = standaloneFileBindingRef.current;
    if (!current || current.fileToken !== expectedToken) return;
    const response = await fetch("/api/local/diagram/snapshot", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fileToken: current.fileToken, baseRevision: current.historyRevision, drawioXml: xml, label
      })
    });
    const result = await response.json() as { error?: string; revision?: string; snapshotCount?: number };
    if (!response.ok || !result.revision) throw new Error(result.error || "The Node.js service could not save the history snapshot");
    const latest = standaloneFileBindingRef.current;
    if (!latest || latest.fileToken !== expectedToken) return;
    const updated = { ...latest, historyRevision: result.revision };
    standaloneFileBindingRef.current = updated;
    setStandaloneFileBinding(updated);
  }

  async function persistStandaloneXml(xml: string, expectedToken: string): Promise<void> {
    let current = standaloneFileBindingRef.current;
    const handle = standaloneFileHandleRef.current;
    if (!current || current.fileToken !== expectedToken || !handle) return;
    if (!isDrawioXmlDocument(xml)) {
      throw new Error("The editor returned invalid Draw.io XML. The selected file was not overwritten.");
    }

    const diskFile = await handle.getFile();
    const diskXml = await diskFile.text();
    const diskRevision = await calculateDrawioXmlRevision(diskXml);
    if (diskRevision !== current.revision) {
      setDocumentSaveState("conflict");
      throw new Error("The file changed outside Draw.io Studio. Reopen it before overwriting those changes.");
    }

    const nextRevision = await calculateDrawioXmlRevision(xml);
    if (nextRevision !== current.revision) {
      await writeDrawioFile(handle, xml);
      current = standaloneFileBindingRef.current;
      if (!current || current.fileToken !== expectedToken) return;
      const updated = { ...current, revision: nextRevision };
      standaloneFileBindingRef.current = updated;
      setStandaloneFileBinding(updated);
      standaloneLastSavedXmlRef.current = xml;
      setDocumentSaveState("saved");
      setLastAction("Saved " + updated.name + " through the browser file handle");
      recordDiagnostic("drawio.standalone.autosaved", "The selected native Draw.io file was saved through FileSystemFileHandle", {
        fileName: updated.name, documentId: updated.documentId, xmlLength: xml.length
      });
    } else {
      standaloneLastSavedXmlRef.current = xml;
    }

    // The original file is already committed before this secondary history sync. A history
    // failure is reported as such, but never misreported as a failed source-file save.
    try {
      await synchronizeStandaloneSnapshot(xml, expectedToken, "Autosave");
    } catch (error) {
      setLastAction("Saved " + current.name + "; history snapshot sync is pending: " + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("drawio.standalone.history-sync.failed", "The original file was saved, but Node.js history sync failed", {
        fileName: current.name, documentId: current.documentId,
        errorMessage: error instanceof Error ? error.message : String(error), sourceFileSaved: true
      }, "warn");
    }
  }

  async function openStandaloneDiagram(handle: StudioLocalFileHandle) {
    const startedAt = Date.now();
    try {
      if (![".drawio", ".dio", ".xml"].some((extension) => handle.name.toLowerCase().endsWith(extension))) throw new Error("Choose a .drawio, .dio, or .xml file");
      // Ask for write access immediately after selection, while the picker interaction still has user activation.
      await ensureDrawioWritePermission(handle);
      const file = await handle.getFile();
      if (file.size > 20 * 1024 * 1024) throw new Error("Draw.io XML exceeds the 20 MiB limit");
      const xml = await file.text();
      const diagnostics = getDrawioXmlDiagnostics(xml);
      if (diagnostics.issues.length || !isDrawioXmlDocument(xml)) {
        throw new Error(diagnostics.issues[0] || "The selected file is not a valid Draw.io XML document.");
      }

      const previousBinding = standaloneFileBindingRef.current;
      if (previousBinding && drawioXml !== standaloneLastSavedXmlRef.current) {
        await enqueueStandaloneSave(drawioXml, previousBinding.fileToken);
      }
      await standaloneSaveQueueRef.current;

      if (workspaceContentReady && projectWorkspace?.primaryDiagram && drawioXml.trim()) {
        try {
          await persistDocumentNow(drawioXml, "Autosave before opening standalone Draw.io");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setLastAction("Could not open " + handle.name + " because the current workspace could not be saved: " + message);
          recordDiagnostic("drawio.open.standalone.pre-save-failed", "Opening the local Draw.io file was stopped because the current workspace could not be saved", {
            fileName: handle.name, errorMessage: message, currentPrimaryDiagram: projectWorkspace.primaryDiagram,
            workspaceId: projectWorkspace.id, stage: "save-current-workspace-before-open"
          }, "error");
          return;
        }
      }

      const documentId = await getLocalDocumentId(handle);
      const response = await fetch("/api/local/diagram/session", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId, name: handle.name, drawioXml: xml })
      });
      const result = await response.json() as {
        error?: string; fileToken?: string; documentId?: string; name?: string;
        revision?: string; snapshotCount?: number;
      };
      if (!response.ok || !result.fileToken || !result.documentId || !result.name || !result.revision) {
        throw new Error(result.error || "The Node.js service could not register this browser-owned file");
      }
      if (projectWorkspace?.id) workspaceInitialLoadRef.current = projectWorkspace.id;
      clearSaveConflict("standalone-document-opened", xml);
      setWorkspaceContentReady(false);
      const binding = {
        fileToken: result.fileToken, documentId: result.documentId, name: result.name,
        revision: result.revision, historyRevision: result.revision
      };
      standaloneFileHandleRef.current = handle;
      standaloneFileBindingRef.current = binding;
      setStandaloneFileBinding(binding);
      setStandaloneFileName(result.name);
      lastExportedXmlRef.current = null;
      setDocumentSaveState("saved");
      standaloneLastSavedXmlRef.current = xml;
      setNativeXmlOverride(xml);
      setServerXmlAvailable(false);
      serverRevisionRef.current = null;
      const standaloneSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session");
      setCopilotSessionId(standaloneSessionId);
      try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", standaloneSessionId); } catch { /* The standalone session stays isolated in memory. */ }
      setMessages([{ role: "assistant", id: Date.now(), text: "Opened a standalone Draw.io file. The browser file handle owns reads and writes; Node.js stores history snapshots." }]);
      setWorkspaceSetupOpen(false);
      setWorkspaceError("");
      setLastAction("Opened " + result.name + "; browser file-handle autosave enabled");
      recordDiagnostic("drawio.open.standalone", "Opened a native Draw.io file using the browser File System Access API", {
        fileName: result.name, documentId, xmlLength: xml.length, fileBytes: file.size,
        pageCount: diagnostics.pageCount, durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastAction("Opening Draw.io failed: " + message);
      recordDiagnostic("drawio.open.standalone.failed", "Could not open the selected Draw.io file through the browser file handle", {
        fileName: handle.name, errorMessage: message
      }, "error");
    }
  }

  async function importDiagramHandle(handle: StudioLocalFileHandle) {
    const startedAt = Date.now();
    recordDiagnostic("drawio.import.started", "Native Draw.io import started through FileSystemFileHandle", { fileName: handle.name });
    try {
      if (![".drawio", ".dio", ".xml"].some((extension) => handle.name.toLowerCase().endsWith(extension))) throw new Error("Choose a .drawio, .dio, or .xml file");
      const file = await handle.getFile();
      if (file.size > 20 * 1024 * 1024) throw new Error("Draw.io XML exceeds the 20 MiB limit");
      const xml = await file.text();
      const diagnostics = getDrawioXmlDiagnostics(xml);
      if (diagnostics.issues.length || !isDrawioXmlDocument(xml)) {
        throw new Error(diagnostics.issues[0] || "The selected file is not a supported Draw.io diagram; the active document was not changed.");
      }
      setNativeXmlOverride(xml);
      setRevision((value) => value + 1);
      if (standaloneFileBindingRef.current) standaloneLastSavedXmlRef.current = null;
      setLastAction("Imported native Draw.io XML from " + handle.name);
      recordDiagnostic("drawio.import.completed", "Imported native Draw.io XML through a browser-owned file handle", {
        fileName: handle.name, durationMs: Date.now() - startedAt, xmlLength: xml.length,
        pageCount: diagnostics.pageCount, warningCount: diagnostics.warnings.length
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordDiagnostic("drawio.import.failed", "Draw.io import failed", {
        fileName: handle.name, durationMs: Date.now() - startedAt, errorMessage: message
      }, "error");
      setLastAction("Import failed: " + message);
    }
  }

  async function exportDiagram() {
    await openLocalFileDialog("export");
  }

  async function saveLocalExport() {
    const activeName = standaloneFileBindingRef.current?.name || projectWorkspace?.primaryDiagram || "architecture.drawio";
    const baseName = activeName.split(/[\\/]/).pop()?.replace(/\.(drawio|dio|xml)$/i, "") || "architecture";
    const suggestedName = baseName + "-export.drawio";
    try {
      if (!isDrawioXmlDocument(drawioXml)) throw new Error("The current editor content is not valid Draw.io XML; export was cancelled.");
      const handle = await chooseDrawioSaveFile(suggestedName);
      if (!handle.name.toLowerCase().endsWith(".drawio") && !handle.name.toLowerCase().endsWith(".dio") && !handle.name.toLowerCase().endsWith(".xml")) {
        throw new Error("Choose a .drawio, .dio, or .xml filename for export.");
      }
      await writeDrawioFile(handle, drawioXml);
      lastExportedXmlRef.current = drawioXml;
      setDocumentSaveState("exported");
      setLastAction("Exported native Draw.io XML to " + handle.name);
      recordDiagnostic("drawio.export.completed", "Exported native Draw.io XML through the browser file handle", {
        fileName: handle.name, xmlLength: drawioXml.length
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLastAction("Export failed: " + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("drawio.export.failed", "Native Draw.io export through the browser file handle failed", {
        fileName: suggestedName, errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
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

  async function openStandaloneHistory() {
    let binding = standaloneFileBindingRef.current;
    const handle = standaloneFileHandleRef.current;
    if (!binding || !handle) return;
    const expectedToken = binding.fileToken;
    try {
      await standaloneSaveQueueRef.current;
      if (drawioXml !== standaloneLastSavedXmlRef.current) {
        await enqueueStandaloneSave(drawioXml, binding.fileToken);
      }
      await standaloneSaveQueueRef.current;
      binding = standaloneFileBindingRef.current;
      if (!binding || binding.fileToken !== expectedToken || handle !== standaloneFileHandleRef.current) return;

      // Retry any deferred snapshot synchronization before showing the history list, so history
      // does not silently omit a source-file save that previously succeeded.
      const file = await handle.getFile();
      const currentXml = await file.text();
      const currentRevision = await calculateDrawioXmlRevision(currentXml);
      if (currentRevision !== binding.revision) {
        setDocumentSaveState("conflict");
        throw new Error("The file changed outside Draw.io Studio. Reopen it before reading or restoring history.");
      }
      await synchronizeStandaloneSnapshot(currentXml, binding.fileToken, "Current file before opening history");
      binding = standaloneFileBindingRef.current;
      if (!binding || binding.historyRevision !== currentRevision) {
        throw new Error("The source file is unchanged, but its history snapshot could not be synchronized. Retry opening history.");
      }
      const response = await fetch("/api/local/diagram/history?fileToken=" + encodeURIComponent(binding.fileToken));
      const result = await response.json() as { error?: string; history?: Array<{ id: string; createdAt: string; label: string; xmlLength: number }> };
      if (!response.ok) throw new Error(result.error || "Could not read local file history");
      const entries = (result.history || []).map((item) => ({ ...item, xml: "" }));
      setLocalHistoryEntries(entries);
      const selectedId = entries.at(-1)?.id ?? null;
      setLocalHistorySelectedId(selectedId);
      if (selectedId) await loadStandaloneHistoryEntry(selectedId);
      setLocalHistoryOpen(true);
    } catch (error) {
      recordDiagnostic("copilot.standalone.history.read.failed", "Could not read standalone file history from Node.js storage", {
        fileName: binding?.name ?? null, errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("Could not read local history: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function loadStandaloneHistoryEntry(versionId: string) {
    const binding = standaloneFileBindingRef.current;
    if (!binding) return;
    try {
      const response = await fetch("/api/local/diagram/history/" + encodeURIComponent(versionId) + "?fileToken=" + encodeURIComponent(binding.fileToken));
      const result = await response.json() as { error?: string; id?: string; createdAt?: string; label?: string; xml?: string };
      if (!response.ok || typeof result.xml !== "string") throw new Error(result.error || "Could not load the selected snapshot");
      setLocalHistoryEntries((current) => current.map((entry) => entry.id === versionId ? { ...entry, xml: result.xml! } : entry));
      setLocalHistorySelectedId(versionId);
    } catch (error) {
      setLastAction("Could not read the selected snapshot: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function archiveStandaloneHistory(label: string, _requestId: number) {
    const binding = standaloneFileBindingRef.current;
    if (!binding) return;
    await standaloneSaveQueueRef.current;
    const active = standaloneFileBindingRef.current;
    if (!active || active.fileToken !== binding.fileToken) return;
    if (drawioXml !== standaloneLastSavedXmlRef.current) await enqueueStandaloneSave(drawioXml, binding.fileToken);
    const current = standaloneFileBindingRef.current;
    if (!current) return;
    await synchronizeStandaloneSnapshot(drawioXml, current.fileToken, label);
    recordDiagnostic("copilot.standalone.history.snapshot", "Saved the pre-edit native Draw.io XML snapshot through Node.js history storage", {
      fileName: current.name, documentId: current.documentId, xmlLength: drawioXml.length, requestId: _requestId
    });
  }

  async function restoreStandaloneHistory(entry: { id: string; createdAt: string; label: string; xml: string }) {
    const binding = standaloneFileBindingRef.current;
    const handle = standaloneFileHandleRef.current;
    if (!binding || !handle) return;
    try {
      const sourceFile = await handle.getFile();
      const currentXml = await sourceFile.text();
      const currentRevision = await calculateDrawioXmlRevision(currentXml);
      if (currentRevision !== binding.revision) {
        setDocumentSaveState("conflict");
        throw new Error("The file changed outside Draw.io Studio. Reopen it before restoring history.");
      }
      await synchronizeStandaloneSnapshot(currentXml, binding.fileToken, "Before restore");
      const synchronized = standaloneFileBindingRef.current;
      if (!synchronized || synchronized.fileToken !== binding.fileToken) return;
      const response = await fetch("/api/local/diagram/history/" + encodeURIComponent(entry.id) + "/restore", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileToken: synchronized.fileToken, baseRevision: synchronized.historyRevision, currentXml })
      });
      const result = await response.json() as { error?: string; drawioXml?: string; revision?: string; label?: string };
      if (!response.ok || typeof result.drawioXml !== "string" || !isDrawioXmlDocument(result.drawioXml)) {
        throw new Error(result.error || "History restore failed");
      }

      // Restore is a browser-owned file write. The server only prepares the historical XML and
      // archives the pre-restore state; it never writes to the selected source file.
      await writeDrawioFile(handle, result.drawioXml);
      const restoredRevision = await calculateDrawioXmlRevision(result.drawioXml);
      const latest = standaloneFileBindingRef.current;
      if (!latest || latest.fileToken !== synchronized.fileToken) return;
      const updated = { ...latest, revision: restoredRevision };
      standaloneFileBindingRef.current = updated;
      setStandaloneFileBinding(updated);
      standaloneLastSavedXmlRef.current = result.drawioXml;
      clearSaveConflict("standalone-history-restore", result.drawioXml);
      setNativeXmlOverride(result.drawioXml);
      setRevision((value) => value + 1);
      setDocumentSaveState("saved");
      try {
        await synchronizeStandaloneSnapshot(result.drawioXml, updated.fileToken, "Restored version: " + entry.label);
        setLastAction("Restored " + entry.label + " to " + updated.name);
      } catch (error) {
        setLastAction("Restored " + updated.name + "; history sync is pending: " + (error instanceof Error ? error.message : String(error)));
        recordDiagnostic("drawio.standalone.history-restore-sync.failed", "The browser file was restored but Node.js history sync failed", {
          documentId: updated.documentId, errorMessage: error instanceof Error ? error.message : String(error), sourceFileSaved: true
        }, "warn");
      }
      setLocalHistoryOpen(false);
      recordDiagnostic("drawio.standalone.history.restored", "Restored a native Draw.io snapshot through the browser file handle", {
        documentId: updated.documentId, sourceVersionId: entry.id, xmlLength: result.drawioXml.length
      });
    } catch (error) {
      recordDiagnostic("drawio.standalone.history.restore.failed", "Restoring a standalone native Draw.io snapshot failed", {
        documentId: binding.documentId, sourceVersionId: entry.id,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("History restore failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function restoreVersion(versionId: string) {
    try {
      const response = await fetch("/api/workspace/versions/" + encodeURIComponent(versionId) + "/restore", { method: "POST" });
      const result = await response.json() as { error?: string; workspaceRevision?: string; state?: { drawioXml?: unknown }; version?: { id?: string } };
      const restoredXml = result.state?.drawioXml;
      if (!response.ok || typeof restoredXml !== "string" || !isDrawioXmlDocument(restoredXml)) {
        throw new Error(result.error || "Server-side native Draw.io version restore failed");
      }
      serverRevisionRef.current = typeof result.workspaceRevision === "string" ? result.workspaceRevision : null;
      clearSaveConflict("server-version-restore", restoredXml, true);
      setNativeXmlOverride(restoredXml);
      setServerXmlAvailable(true);
      setWorkspaceContentReady(true);
      setRevision((value) => value + 1);
      setLastAction("Restored native Draw.io XML from server version history; native Undo/Redo history was reset. Use version history to return to an earlier snapshot.");
      setVersionHistoryOpen(false);
      recordDiagnostic("workspace.version.restored", "Restored the full native Draw.io XML snapshot", {
        sourceVersionId: versionId, newVersionId: result.version?.id, xmlLength: restoredXml.length
      });
    } catch (error) {
      recordDiagnostic("workspace.version.restore.failed", "Restoring the native Draw.io version failed", {
        sourceVersionId: versionId, errorMessage: error instanceof Error ? error.message : String(error)
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

  async function runAutoLayout(overrides: Partial<NativeAutoLayoutOptions> = {}) {
    if (autoLayoutRunning) return;
    const options: NativeAutoLayoutOptions = { ...nativeLayoutOptions, ...overrides };
    const algorithmLabel = NATIVE_LAYOUT_ENGINE_LABELS[options.engine] + " " + options.algorithm;
    const frame = drawioFrameRef.current;
    if (!frame) {
      setLastAction("Auto layout failed: the native Draw.io editor is unavailable");
      return;
    }
    setAutoLayoutRunning(true);
    setLastAction("Calculating Studio " + algorithmLabel + "…");
    try {
      const source = latestDiagramStateRef.current;
      const sourceXml = source.drawioXml;
      const pageId = source.selectedNativePageId;
      const documentRevision = await calculateDrawioXmlRevision(sourceXml);
      const regionAnalysisResponse = await spatialRegionAnalysisProvider.analyze({
        documentXml: sourceXml,
        documentRevision,
        pageId,
        selectedCellId: null,
        cells: []
      }, { documentRevision, pageId });
      const regionFindings = regionAnalysisResponse.status === "analyzed"
        ? regionAnalysisResponse.result.findings
        : [];
      const regionCandidates = regionFindings.filter((finding) => finding.ruleId === "spatial-region.candidate");
      const ambiguousRegionCount = regionFindings.filter((finding) =>
        finding.ruleId === "spatial-region.overlap-ambiguous" || finding.ruleId === "spatial-region.membership-ambiguous"
      ).length;
      const nativePlan = await calculateNativeAutoLayout(sourceXml, pageId, documentRevision, options);
      const latestState = latestDiagramStateRef.current;
      if (latestState.drawioXml !== sourceXml || latestState.selectedNativePageId !== pageId) {
        throw new Error("The diagram or active page changed while Studio was calculating the layout. Nothing was applied; retry.");
      }
      const coverage = nativePlan.coverage;
      recordDiagnostic("drawio.layout.ui.requested", "The user requested a Studio-owned auto layout", {
        pageId: nativePlan.pageId, documentRevision, drawioVersion: DRAWIO_VERSION,
        layoutLayerId: nativePlan.layoutLayerId, layoutLayerFallback: nativePlan.layoutLayerFallback,
        coverage, engine: options.engine, algorithm: options.algorithm, direction: options.direction,
        nodeSpacing: options.nodeSpacing, layerSpacing: options.layerSpacing, edgeRouting: options.edgeRouting,
        iterations: options.iterations, randomSeed: options.randomSeed, margin: options.margin,
        vertexCount: nativePlan.positions.length, edgeCount: nativePlan.edgeRoutes.length,
        spatialRegionCandidateCount: regionCandidates.length, spatialRegionAmbiguityCount: ambiguousRegionCount
      });
      const serializedXml = await frame.applyAutoLayout(nativePlan);
      if (!isDrawioXmlDocument(serializedXml)) throw new Error("Draw.io did not return a valid serialized XML document.");
      const untouchedParts: string[] = [];
      if (coverage.untouchedVertexCount > 0) untouchedParts.push(coverage.untouchedVertexCount + " nodes");
      if (coverage.untouchedEdgeCount > 0) untouchedParts.push(coverage.untouchedEdgeCount + " connectors");
      const untouchedSummary = untouchedParts.length ? " · " + untouchedParts.join(", ") + " untouched" : "";
      const routingSummary = coverage.connectorsAttachedToNestedChildrenCount > 0
        ? " · routed " + coverage.connectorsAttachedToNestedChildrenCount + " grouped connector(s)"
        : "";
      const regionSummary = coverage.spatialRegionCount > 0
        ? " · kept " + coverage.spatialRegionCount + " spatial region(s) atomic with " + coverage.spatialRegionMemberCount + " member node(s)"
        : "";
      setLastAction("Auto layout · " + coverage.plannedVertexCount + "/" + coverage.sourceVertexCount +
        " nodes, " + coverage.plannedEdgeCount + "/" + coverage.sourceEdgeCount + " connectors" + untouchedSummary +
        routingSummary + regionSummary);
      recordDiagnostic("drawio.layout.ui.serialized", "Native Draw.io applied the geometry and exported XML; workspace persistence is tracked separately", {
        xmlLength: serializedXml.length, pageId: nativePlan.pageId,
        layoutLayerId: nativePlan.layoutLayerId, layoutLayerFallback: nativePlan.layoutLayerFallback,
        coverage, engine: options.engine,
        algorithm: options.algorithm, direction: options.direction, vertexCount: nativePlan.positions.length,
        edgeCount: nativePlan.edgeRoutes.length
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setLastAction("Auto layout failed: " + errorMessage);
      recordDiagnostic("drawio.layout.ui.failed", "Studio auto layout failed or could not be confirmed", {
        pageId: selectedNativePageId, errorMessage, engine: options.engine, algorithm: options.algorithm,
        direction: options.direction
      }, "error");
    } finally {
      setAutoLayoutRunning(false);
    }
  }

  function runDirectionalLayout(direction: "RIGHT" | "DOWN") {
    // Direction shortcuts always produce a flow diagram: preserve Dagre if selected,
    // otherwise switch an ELK radial/organic configuration back to the layered algorithm.
    const preset: Partial<NativeAutoLayoutOptions> = {
      direction,
      algorithm: defaultNativeLayoutAlgorithm(nativeLayoutOptions.engine)
    };
    setNativeLayoutOptions((current) => ({ ...current, ...preset }));
    void runAutoLayout(preset);
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
    <Layout className="app-shell" data-theme={uiTheme} style={{ "--right-w": panelWidths.right + "px" } as CSSProperties}>
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
            <Button type={workspaceLaunchMode === "open" ? "primary" : "default"} onClick={() => { setWorkspaceError(""); if (workspaceLaunchMode === "open") { setWorkspaceSetupOpen(false); void openLocalFileDialog("open"); } else { setWorkspaceLaunchMode("open"); } }}>Open existing Draw.io</Button>
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
      
      <Modal title={"Local Draw.io history · " + (standaloneFileName || "")} open={localHistoryOpen} onCancel={() => setLocalHistoryOpen(false)} footer={null} width={900}>
        <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(0, 2fr)", gap: 16, maxHeight: "65vh" }}>
          <div style={{ overflowY: "auto" }}>
            {localHistoryEntries.length === 0 ? <p>No local snapshots saved yet. Snapshots are stored by the Node.js service before a file save or Copilot edit.</p> : [...localHistoryEntries].reverse().map((entry) => (
              <button key={entry.id} type="button" onClick={() => void loadStandaloneHistoryEntry(entry.id)}
                style={{ display: "block", width: "100%", textAlign: "left", padding: 10, border: "1px solid var(--border, #e5e7eb)", borderRadius: 6, marginBottom: 8, background: localHistorySelectedId === entry.id ? "var(--surface-selected, #eef2ff)" : "transparent", color: "inherit" }}>
                <strong>{entry.label}</strong><div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(entry.createdAt).toLocaleString()}</div><div style={{ fontSize: 12, opacity: 0.7 }}>{entry.xml.length.toLocaleString()} XML characters</div>
              </button>
            ))}
          </div>
          <div style={{ minWidth: 0, overflowY: "auto" }}>
            {(() => {
              const selected = localHistoryEntries.find((entry) => entry.id === localHistorySelectedId);
              if (!selected) return <p>Select a snapshot to inspect it.</p>;
              const current = drawioXml;
              const selectedLines = selected.xml.split(/\r?\n/);
              const currentLines = current.split(/\r?\n/);
              const firstDifference = selectedLines.findIndex((line, index) => line !== currentLines[index]);
              return <>
                <strong>Snapshot comparison</strong>
                <p>Current XML: {current.length.toLocaleString()} characters · Snapshot: {selected.xml.length.toLocaleString()} characters · {selected.xml === current ? "identical" : "different"}.</p>
                <p>First differing line: {firstDifference < 0 ? "none" : firstDifference + 1}. XML snapshots are compared as text; compressed multi-page payloads may appear as a single line.</p>
                <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 280, overflowY: "auto", fontSize: 11 }}>{selectedLines.slice(Math.max(0, firstDifference - 2), Math.max(0, firstDifference - 2) + 12).join("\n") || selected.xml.slice(0, 2000)}</pre>
                <Button type="primary" onClick={() => restoreStandaloneHistory(selected)}>Restore snapshot</Button>
              </>;
            })()}
          </div>
        </div>
      </Modal>
      <Modal title="Server version history" open={versionHistoryOpen} onCancel={() => setVersionHistoryOpen(false)} footer={null} width={760}>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {versionHistoryLoading ? <p>Loading version history…</p> : versionEntries.length === 0 ? <p>The server has no saved versions yet.</p> : [...versionEntries].reverse().map((version) => (
            <div key={version.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 0", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <div style={{ minWidth: 0 }}>
                <strong>{version.label}</strong>
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
        <div className="document-breadcrumb"><strong>{standaloneFileName || projectWorkspace?.primaryDiagram || "Draw.io diagram"}</strong><span className={"save-state save-state-" + documentSaveState} title={documentSaveState === "conflict" ? "Automatic saving is paused. Export local edits before restoring or reloading the latest server version." : undefined}><i />{standaloneFileName
          ? standaloneFileBinding
            ? documentSaveState === "saving" ? "Saving…"
              : documentSaveState === "failed" ? "Save failed" : "Saved to file"
            : lastExportedXmlRef.current === drawioXml && documentSaveState === "exported" ? "Exported copy" : "Export copy"
          : !projectWorkspace?.primaryDiagram ? "No active file"
          : !workspaceContentReady ? "Loading…"
          : documentSaveState === "saving" ? "Saving…"
          : documentSaveState === "conflict" ? "Save paused"
          : documentSaveState === "failed" ? "Save failed"
          : "Saved · r" + revision}</span></div>
        <nav className="workspace-nav" aria-label="Workspace pages">
          {([["diagram", "Diagram"], ["traces", "Agent traces"], ["settings", "Settings"]] as Array<[WorkspacePage, string]>).map(([page, label]) =>
            <UiButton key={page} type="button" className={activePage === page ? "active" : ""} aria-current={activePage === page ? "page" : undefined} onClick={() => openPage(page)}>{label}{page === "traces" && traceEntries.some((entry) => entry.level === "error") && <i className="nav-error-dot" />}</UiButton>
          )}
        </nav>
        <label className="theme-selector" title="Apply a coordinated canvas background, element and connector palette to the active Draw.io page. The change is one native Undo/Redo step.">
          <span aria-hidden="true">◐</span>
          <UiSelect value={diagramTheme} disabled={diagramThemeApplying || !nativeEditorReady || documentSaveState === "conflict"} aria-label="Draw.io diagram color theme for current page" popupMatchSelectWidth={false} onChange={(event) => {
            const nextTheme = event.target.value as DiagramTheme;
            if (nextTheme) void applyDiagramTheme(nextTheme);
          }}>
            <option value="" disabled>Diagram colors (this page)</option>
            <option value="ocean-depths">Ocean Depths</option>
            <option value="sunset-boulevard">Sunset Boulevard</option>
            <option value="forest-canopy">Forest Canopy</option>
            <option value="modern-minimalist">Modern Minimalist</option>
            <option value="golden-hour">Golden Hour</option>
            <option value="arctic-frost">Arctic Frost</option>
            <option value="desert-rose">Desert Rose</option>
            <option value="tech-innovation">Tech Innovation</option>
            <option value="botanical-garden">Botanical Garden</option>
            <option value="midnight-galaxy">Midnight Galaxy</option>
          </UiSelect>
        </label>
        <UiButton type="button" className="button button-secondary" onClick={() => void openLocalFileDialog("open")}>Open Draw.io</UiButton>
        <UiButton type="button" className="button button-secondary" onClick={() => {
          setWorkspaceLaunchMode("create"); setWorkspaceError("");
          if (projectWorkspace) {
            setWorkspaceName(projectWorkspace.name); setWorkspaceRootPath(projectWorkspace.rootPath);
          }
          setWorkspaceNewDiagramName("architecture.drawio");
          setWorkspaceSetupOpen(true);
        }}>New Draw.io</UiButton>

        <div className="topbar-actions">
          {projectWorkspace && <UiButton className="button button-secondary workspace-switch" aria-label="Switch workspace" title={"Switch workspace — " + projectWorkspace.name + " (" + projectWorkspace.rootPath + ")"} onClick={() => setWorkspaceSetupOpen(true)}><span className="workspace-switch-glyph" aria-hidden="true">⇄</span><span className="workspace-switch-label">Switch workspace</span></UiButton>}
          {activePage === "diagram" && <>
            <UiButton className="button button-secondary" title="Import a .drawio file" onClick={() => void openLocalFileDialog("import")}><span className="button-icon">↑</span>Import</UiButton>
            <UiButton className="button button-secondary" title="Export a .drawio file" onClick={exportDiagram}><span className="button-icon">↓</span>Export</UiButton>
            {!standaloneFileName && <UiButton className="button button-secondary" title="Browse and restore saved versions" onClick={() => void openVersionHistory()}>History</UiButton>}
            {standaloneFileName && <UiButton className="button button-secondary" title="Browse and restore local Draw.io XML snapshots" onClick={openStandaloneHistory}>Local history</UiButton>}
          </>}
        </div>
      </header>

      <div className={"diagram-workspace" + (activePage === "diagram" ? "" : " is-hidden")}>
        <>
      <main className="main-panel">
        <div className="canvas-toolbar">
          <div className="canvas-toolbar-actions" role="group" aria-label="Undo, redo and layout controls">
            <Button
              className="history-toolbar-button"
              disabled={!nativeEditorReady || !nativeHistoryState.canUndo || autoLayoutRunning || diagramThemeApplying || documentSaveState === "conflict"}
              title="Undo the last native canvas edit (Cmd/Ctrl+Z)"
              aria-label="Undo"
              onClick={() => drawioFrameRef.current?.undo()}
            >Undo</Button>
            <Button
              className="history-toolbar-button"
              disabled={!nativeEditorReady || !nativeHistoryState.canRedo || autoLayoutRunning || diagramThemeApplying || documentSaveState === "conflict"}
              title="Redo the last native canvas edit (Cmd/Ctrl+Shift+Z; Ctrl+Y on Windows/Linux)"
              aria-label="Redo"
              onClick={() => drawioFrameRef.current?.redo()}
            >Redo</Button>
            <label className="native-layout-field">
              <span>Layout engine</span>
              <Select<NativeAutoLayoutOptions["engine"]>
                aria-label="Layout engine"
                className="native-layout-select native-layout-engine"
                size="small"
                value={nativeLayoutOptions.engine}
                options={NATIVE_LAYOUT_ENGINES}
                disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict"}
                onChange={(engine) => setNativeLayoutOptions((current) => ({ ...current, engine, algorithm: defaultNativeLayoutAlgorithm(engine) }))}
              />
            </label>
            <label className="native-layout-field">
              <span>Algorithm</span>
              <Select<NativeAutoLayoutOptions["algorithm"]>
                aria-label="Layout algorithm"
                className="native-layout-select native-layout-algorithm"
                size="small"
                value={nativeLayoutOptions.algorithm}
                options={nativeLayoutAlgorithmsForEngine(nativeLayoutOptions.engine)}
                disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict" || nativeLayoutOptions.engine === "dagre"}
                onChange={(algorithm) => setNativeLayoutOptions((current) => ({ ...current, algorithm }))}
              />
            </label>
            <label className="native-layout-field">
              <span>Direction</span>
              <Select<NativeAutoLayoutOptions["direction"]>
                aria-label="Layout direction"
                className="native-layout-select native-layout-direction"
                size="small"
                value={nativeLayoutOptions.direction}
                options={NATIVE_LAYOUT_DIRECTIONS}
                disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict" ||
                  !nativeLayoutSupportsDirection(nativeLayoutOptions.engine, nativeLayoutOptions.algorithm)}
                onChange={(direction) => setNativeLayoutOptions((current) => ({ ...current, direction }))}
              />
            </label>
            <Button
              className="layout-direction-button"
              disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict"}
              title="Apply a left-to-right flow layout"
              aria-label="Horizontal layout"
              onClick={() => runDirectionalLayout("RIGHT")}
            >
              Horizontal
            </Button>
            <Button
              className="layout-direction-button"
              disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict"}
              title="Apply a top-to-bottom flow layout"
              aria-label="Vertical layout"
              onClick={() => runDirectionalLayout("DOWN")}
            >
              Vertical
            </Button>
            <Button
              className="auto-layout-button"
              type="primary"
              loading={autoLayoutRunning}
              disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict"}
              title="Calculate positions with the selected Studio layout engine and apply to native Draw.io cells"
              onClick={() => void runAutoLayout()}
            >
              Auto layout
            </Button>
            <Button
              className="layout-settings-button"
              disabled={!nativeEditorReady || autoLayoutRunning || documentSaveState === "conflict"}
              title="Configure spacing and connector routing"
              aria-label="Advanced layout settings"
              onClick={() => setLayoutSettingsOpen(true)}
            >
              Advanced
            </Button>
          </div>
        </div>
        <Modal
          title="Layout settings"
          open={layoutSettingsOpen}
          onCancel={() => setLayoutSettingsOpen(false)}
          footer={[
            <Button key="reset" onClick={() => setNativeLayoutOptions({ ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS })}>Reset</Button>,
            <Button key="done" type="primary" onClick={() => setLayoutSettingsOpen(false)}>Done</Button>
          ]}
        >
          <div className="native-layout-settings-grid">
            <label className="native-layout-settings-field">
              <span>Node spacing</span>
              <InputNumber
                aria-label="Node spacing"
                min={5}
                max={500}
                step={5}
                value={nativeLayoutOptions.nodeSpacing}
                onChange={(value) => {
                  if (typeof value === "number") setNativeLayoutOptions((current) => ({ ...current, nodeSpacing: value }));
                }}
                style={{ width: "100%" }}
              />
            </label>
            <label className="native-layout-settings-field">
              <span>Layer spacing</span>
              <InputNumber
                aria-label="Layer spacing"
                min={10}
                max={800}
                step={10}
                disabled={!((nativeLayoutOptions.engine === "dagre") || (nativeLayoutOptions.engine === "elk" && nativeLayoutOptions.algorithm === "layered") || (nativeLayoutOptions.engine === "graphviz" && nativeLayoutOptions.algorithm === "dot") || (nativeLayoutOptions.engine === "msagl" && nativeLayoutOptions.algorithm === "layered") || (nativeLayoutOptions.engine === "d3" && (nativeLayoutOptions.algorithm === "tree" || nativeLayoutOptions.algorithm === "cluster")))}
                value={nativeLayoutOptions.layerSpacing}
                onChange={(value) => {
                  if (typeof value === "number") setNativeLayoutOptions((current) => ({ ...current, layerSpacing: value }));
                }}
                style={{ width: "100%" }}
              />
            </label>
            <label className="native-layout-settings-field">
              <span>Iterations</span>
              <InputNumber aria-label="ELK iterations" min={20} max={3000} step={20}
                disabled={!((nativeLayoutOptions.engine === "elk" && (nativeLayoutOptions.algorithm === "stress" || nativeLayoutOptions.algorithm === "force")) || (nativeLayoutOptions.engine === "d3" && nativeLayoutOptions.algorithm === "force") || (nativeLayoutOptions.engine === "cytoscape" && (nativeLayoutOptions.algorithm === "cose" || nativeLayoutOptions.algorithm === "fcose")) || (nativeLayoutOptions.engine === "msagl" && (nativeLayoutOptions.algorithm === "mds" || nativeLayoutOptions.algorithm === "ipsepcola")))}
                value={nativeLayoutOptions.iterations}
                onChange={(value) => { if (typeof value === "number") setNativeLayoutOptions((current) => ({ ...current, iterations: value })); }}
                style={{ width: "100%" }} />
            </label>
            <label className="native-layout-settings-field">
              <span>Random seed</span>
              <InputNumber aria-label="Layout random seed" min={0} max={100000} step={1}
                disabled={!((nativeLayoutOptions.engine === "elk" && (nativeLayoutOptions.algorithm === "stress" || nativeLayoutOptions.algorithm === "force")) || (nativeLayoutOptions.engine === "d3" && nativeLayoutOptions.algorithm === "force") || (nativeLayoutOptions.engine === "graphviz" && ["neato", "fdp", "sfdp"].includes(nativeLayoutOptions.algorithm)))}
                value={nativeLayoutOptions.randomSeed}
                onChange={(value) => { if (typeof value === "number") setNativeLayoutOptions((current) => ({ ...current, randomSeed: value })); }}
                style={{ width: "100%" }} />
            </label>
            <label className="native-layout-settings-field">
              <span>Canvas margin</span>
              <InputNumber aria-label="Layout canvas margin" min={0} max={300} step={10}
                value={nativeLayoutOptions.margin}
                onChange={(value) => { if (typeof value === "number") setNativeLayoutOptions((current) => ({ ...current, margin: value })); }}
                style={{ width: "100%" }} />
            </label>
            <label className="native-layout-settings-field native-layout-routing-field">
              <span>Connector routing</span>
              <Select<NativeAutoLayoutOptions["edgeRouting"]>
                aria-label="Connector routing"
                value={nativeLayoutOptions.edgeRouting}
                options={[
                  { value: "ORTHOGONAL", label: "Orthogonal" },
                  { value: "POLYLINE", label: "Polyline" },
                  { value: "SPLINES", label: "Curved / splines" }
                ]}
                onChange={(edgeRouting) => setNativeLayoutOptions((current) => ({ ...current, edgeRouting }))}
                style={{ width: "100%" }}
              />
            </label>
          </div>
          <p className="native-layout-settings-help">Orthogonal routes avoid visible node bounds with a clearance margin. Polyline preserves engine-provided waypoint geometry; Curved renders those waypoints as a smooth path where supported. Settings are saved in this browser.</p>
        </Modal>

        <div className="canvas-stage">
                      <DrawioFrame ref={drawioFrameRef} xml={drawioXml}
            onNativeEditResult={async (result) => {
              const requestId = result.requestId;
              const watchdogTimerId = requestId === null ? undefined : nativeEditWatchdogsRef.current.get(requestId);
              if (requestId !== null && watchdogTimerId !== undefined) {
                window.clearTimeout(watchdogTimerId);
                nativeEditWatchdogsRef.current.delete(requestId);
              }
              const resolver = requestId === null ? undefined : nativeEditResolversRef.current.get(requestId);
              const isLateNativeBatch = result.path === "cell:batch" && requestId !== null &&
                !resolver && lateNativeEditRequestsRef.current.has(requestId);
              const isLateNativeSelection = result.path === "cell:select" && requestId !== null &&
                !resolver && lateNativeSelectionRequestsRef.current.has(requestId);
              const acknowledgement = requestId === null ? undefined : nativeEditAckContextsRef.current.get(requestId);
              const readOnlyNoChange = result.path === "cell:batch" &&
                result.scriptMode === "read" && result.applicationState === "not-applied" &&
                (result.success === true || result.batchRolledBack === true);
              let finalResult = result;
              let serializedXmlRevision: string | null = null;
              let persistedRevision: string | null = null;
              let persistedVersionId: string | null = null;
              let persistenceStatus = "not_attempted";
              const lateResultHasSnapshot = typeof result.serializedXml === "string" ||
                result.batchRolledBack === true || result.applicationState === "not-applied";
              if (readOnlyNoChange) {
                // An inspection receipt is terminal for the agent turn, but it is not a file edit.
                // Do not hash/export its transient serialized XML, rewrite a standalone file, or create a workspace version.
                persistenceStatus = "read_only_no_change";
              } else if (result.path === "cell:batch" && !(isLateNativeBatch && !lateResultHasSnapshot)) {
                if (typeof result.serializedXml !== "string") {
                  if (result.success) {
                    finalResult = { ...result, success: false, error: "Draw.io acknowledged the edit but did not return serialized XML.", batchRolledBack: false, failureStage: "persistence" };
                    persistenceStatus = "failed";
                  } else {
                    // Failed scripts also request XML serialization so any partial native edits can be
                    // saved as a version and shown to the agent. If serialization timed out, retain the
                    // original script failure and leave the last good persisted revision untouched.
                    persistenceStatus = "not_attempted";
                  }
                } else {
                  serializedXmlRevision = await calculateDrawioXmlRevision(result.serializedXml);
                  if (projectWorkspace && !standaloneFileName) {
                    try {
                      // Persist both successful results and captured failed-script state through the same
                      // revision-checked path; only the editor acknowledgement decides success/failure.
                      const saved = await persistDocumentNow(result.serializedXml, result.success
                        ? "Copilot native edit"
                        : result.applicationState === "changed-unverified"
                          ? "Captured unverified native XML after Copilot script edit"
                          : "Captured native XML after Copilot script failure");
                      persistedRevision = typeof saved.workspaceRevision === "string" ? saved.workspaceRevision : null;
                      persistedVersionId = typeof saved.version?.id === "string" ? saved.version.id : null;
                      if (persistedRevision !== serializedXmlRevision) throw new Error("The server did not confirm the exact serialized XML revision.");
                      if (!persistedVersionId) throw new Error("The server did not confirm the immutable version ID for this XML revision.");
                      persistenceStatus = "saved";
                    } catch (error) {
                      const persistenceError = error instanceof Error ? error.message : String(error);
                      persistenceStatus = "failed";
                      finalResult = result.success
                        ? {
                            ...result, success: false,
                            error: "Draw.io applied and serialized the edit, but the workspace save failed: " + persistenceError,
                            batchRolledBack: false, failureStage: "persistence"
                          }
                        : {
                            ...result,
                            error: (result.error || "The native Draw.io script failed.") +
                              " The resulting editor XML could not be saved as a version: " + persistenceError,
                            failureStage: "persistence"
                          };
                    }
                  } else if (standaloneFileName && standaloneFileBindingRef.current) {
                    // Standalone persistence is browser-owned, but the native edit receipt must still
                    // wait for the actual FileSystemFileHandle write to close successfully.
                    const activeBinding = standaloneFileBindingRef.current;
                    try {
                      await enqueueStandaloneSave(result.serializedXml, activeBinding.fileToken);
                      const savedBinding = standaloneFileBindingRef.current;
                      if (!savedBinding || savedBinding.fileToken !== activeBinding.fileToken ||
                          savedBinding.revision !== serializedXmlRevision) {
                        throw new Error("The browser did not confirm the exact serialized XML revision on the selected local file.");
                      }
                      persistedRevision = savedBinding.revision;
                      // The server records the result but does not claim it wrote the source file.
                      persistenceStatus = "not_managed_by_server";
                      if (savedBinding.historyRevision !== savedBinding.revision) {
                        finalResult = {
                          ...result,
                          auditWarning: "The selected file was saved, but the Node.js history snapshot is still pending."
                        };
                      }
                    } catch (error) {
                      const persistenceError = error instanceof Error ? error.message : String(error);
                      persistenceStatus = "failed";
                      finalResult = result.success
                        ? {
                            ...result, success: false,
                            error: "Draw.io applied and serialized the edit, but saving the standalone file failed: " + persistenceError,
                            batchRolledBack: false, failureStage: "persistence"
                          }
                        : {
                            ...result,
                            error: (result.error || "The native Draw.io script failed.") +
                              " The resulting XML could not be saved to the standalone file: " + persistenceError,
                            failureStage: "persistence"
                          };
                    }
                  } else {
                    persistenceStatus = "not_managed_by_server";
                  }
                }
              }
              if (acknowledgement && requestId !== null && !(isLateNativeBatch && !lateResultHasSnapshot)) {
                try {
                  const ackResponse = await fetch("/api/copilot/intent/ack", {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      requestId: acknowledgement.requestId, sessionId: acknowledgement.sessionId,
                      standalone: acknowledgement.standalone, documentRevision: acknowledgement.documentRevision,
                      outcome: finalResult.success ? "applied" : "failed",
                      editorAcknowledged: result.success || typeof result.serializedXml === "string",
                      applicationState: finalResult.applicationState ?? null,
                      serializedXmlRevision, persistenceStatus, persistedRevision, versionId: persistedVersionId,
                      failureStage: finalResult.failureStage ?? null, error: finalResult.error ?? null
                    })
                  });
                  const ackBody = await ackResponse.json().catch(() => null) as {
                    error?: string; outcome?: string; documentRevision?: string | null; persistedRevision?: string | null; versionId?: string | null;
                  } | null;
                  const expectedOutcome = finalResult.success ? "applied" : "failed";
                  const appliedReceiptMismatch = finalResult.success && !readOnlyNoChange && (
                    ackBody?.documentRevision !== serializedXmlRevision ||
                    ackBody?.persistedRevision !== persistedRevision ||
                    ackBody?.versionId !== persistedVersionId
                  );
                  if (!ackResponse.ok || ackBody?.outcome !== expectedOutcome || appliedReceiptMismatch) {
                    finalResult = {
                      ...finalResult,
                      auditWarning: "The browser received the edit result, but the server did not confirm the matching final outcome/revision/version: " +
                        (ackBody?.error || (ackResponse.ok ? "receipt fields did not match" : "HTTP " + ackResponse.status))
                    };
                  }
                } catch (error) {
                  finalResult = { ...finalResult, auditWarning: "The edit result could not be recorded by the server: " + (error instanceof Error ? error.message : String(error)) };
                }
                nativeEditAckContextsRef.current.delete(requestId);
              } else if (isLateNativeBatch && !lateResultHasSnapshot) {
                // Without a resulting XML snapshot (or explicit rollback), a late timeout response
                // is not a terminal receipt. Keep the request locked until the user reloads/reconciles.
                finalResult = {
                  ...result,
                  success: false,
                  applicationState: "unknown",
                  error: "The editor returned after the wait expired but did not provide a final serialized XML snapshot.",
                  auditWarning: "The edit remains unresolved. Do not retry; inspect History and reload the document before another edit."
                };
              }
              if (resolver && requestId !== null) {
                if (nativeEditResolversRef.current.get(requestId) !== resolver) {
                  recordDiagnostic("copilot.native-edit.acknowledgement.late", "A native edit result arrived after its wait timed out; no late success was shown", { requestId, success: finalResult.success }, "warn");
                  return;
                }
                nativeEditResolversRef.current.delete(requestId);
                resolver(finalResult);
              }
              const lateResultIsTerminal = finalResult.success ||
                typeof finalResult.serializedXml === "string" || finalResult.batchRolledBack === true ||
                finalResult.applicationState === "not-applied";
              const wasLateNativeEdit = isLateNativeBatch && lateResultIsTerminal &&
                requestId !== null && lateNativeEditRequestsRef.current.delete(requestId);
              if (result.path === "cell:batch" && !resolver && !isLateNativeBatch && !wasLateNativeEdit) {
                recordDiagnostic("copilot.native-edit.acknowledgement.unobserved", "A native edit completed without an active waiter or a registered timeout to reconcile", { requestId, success: finalResult.success }, "warn");
                return;
              }
              if (isLateNativeBatch && !wasLateNativeEdit) {
                const unresolvedText = "A native edit timed out without a final serialized result. The diagram state is still unknown; do not retry. Inspect the current document and History, then reload the document before submitting another edit.";
                setLastAction(unresolvedText);
                const unresolvedMessage: ChatMessage = { role: "assistant", id: Date.now(), text: unresolvedText };
                setMessages((items) => [...items, unresolvedMessage].slice(-300));
                recordDiagnostic("copilot.native-edit.acknowledgement.late-unresolved",
                  "A timed-out native edit returned without enough evidence to reconcile its outcome",
                  { requestId, applicationState: finalResult.applicationState ?? null, rollbackConfirmed: finalResult.batchRolledBack === true }, "error");
                return;
              }
              const status = readOnlyNoChange
                ? (finalResult.success
                    ? "Read-only inspection completed; the diagram, source file and History were left unchanged."
                    : "Read-only inspection failed; the diagram, source file and History were left unchanged: " + (finalResult.error || "Unknown error"))
                : (finalResult.success && finalResult.semanticChanged === false
                ? "Native script assertions passed; the requested state was already present, so no semantic diagram change was needed."
                : finalResult.success
                ? "Native Draw.io accepted and serialized " + (finalResult.path || "edit") + (finalResult.cellId === "__batch__" ? " batch" : "") +
                  (projectWorkspace && !standaloneFileName && finalResult.path === "cell:batch"
                    ? "; workspace save confirmed."
                    : standaloneFileName && finalResult.path === "cell:batch" ? "; standalone file save confirmed." : ".")
                : finalResult.applicationState === "changed-unverified" && finalResult.failureStage === "persistence"
                  ? "The native document changed, but the requested edit was not verified and persistence failed: " + (finalResult.error || "Unknown error")
                  : finalResult.applicationState === "unknown" && finalResult.failureStage === "persistence"
                    ? "The native edit outcome is unknown and persistence failed: " + (finalResult.error || "Unknown error")
                    : finalResult.failureStage === "persistence"
                      ? "Native edit was serialized but persistence failed: " + (finalResult.error || "Unknown error")
                      : finalResult.applicationState === "changed-unverified"
                        ? "The native document changed, but the requested edit was not verified: " + (finalResult.error || "Unknown verification error")
                        : finalResult.applicationState === "not-applied"
                      ? "No document change was detected for this edit: " + (finalResult.error || "No matching change")
                      : finalResult.applicationState === "unknown"
                        ? "The native edit outcome is unknown: " + (finalResult.error || "No reliable serialized result")
                        : "Native Draw.io edit failed: " + (finalResult.error || "Unknown error")) +
                (finalResult.auditWarning ? " " + finalResult.auditWarning : "");
              setLastAction(status);
              if (wasLateNativeEdit) {
                const reconciledText = "A native edit returned after the waiting period. " + status +
                  " Its final result has now been reconciled; do not repeat the operation.";
                const reconciledMessage: ChatMessage = { role: "assistant", id: Date.now(), text: reconciledText };
                setMessages((items) => [...items, reconciledMessage].slice(-300));
                recordDiagnostic("copilot.native-edit.acknowledgement.late-reconciled",
                  "Reconciled the user-visible outcome after a native edit returned past its wait timeout",
                  { requestId, success: finalResult.success, applicationState: finalResult.applicationState ?? null,
                    failureStage: finalResult.failureStage ?? null, auditWarning: finalResult.auditWarning ?? null }, "warn");
              }
              if (finalResult.batchResults?.length) {
                for (const step of finalResult.batchResults) {
                  const stepEvent = finalResult.success
                    ? "applied"
                    : finalResult.batchRolledBack === true
                      ? "rolled-back"
                      : finalResult.applicationState === "changed-unverified"
                        ? "failed-after-partial-apply"
                        : finalResult.applicationState === "unknown"
                          ? "outcome-unknown"
                          : "failed";
                  recordDiagnostic("copilot.native-batch.step." + stepEvent,
                    "Native batch step " + step.index + (stepEvent === "applied" ? " applied" : stepEvent === "rolled-back" ? " rolled back" : " did not reach verified completion"),
                    { requestId: finalResult.requestId, index: step.index, cellId: step.cellId, path: step.path, value: step.value,
                      stepSuccess: step.success, stepError: step.error ?? null, stepStack: step.stack ?? null,
                      batchSuccess: finalResult.success, applicationState: finalResult.applicationState ?? null,
                      rollbackConfirmed: finalResult.batchRolledBack ?? null });
                }
              }
              recordDiagnostic(finalResult.success ? "copilot.native-edit.acknowledged" : "copilot.native-edit.rejected", status, {
                requestId: finalResult.requestId, cellId: finalResult.cellId, path: finalResult.path, error: finalResult.error || null,
                failedIndex: finalResult.failedIndex ?? null, errorStack: finalResult.errorStack ?? null, rollbackErrors: finalResult.rollbackErrors ?? [],
                batchRolledBack: finalResult.batchRolledBack ?? null, batchResults: finalResult.batchResults ?? null, scriptResult: finalResult.scriptResult ?? null, applicationState: finalResult.applicationState ?? null, failureStage: finalResult.failureStage ?? null, auditWarning: finalResult.auditWarning ?? null
              }, finalResult.success && !(finalResult.rollbackErrors?.length) ? "info" : "error");
              if (isLateNativeSelection && requestId !== null && lateNativeSelectionRequestsRef.current.delete(requestId)) {
                const reconciledText = finalResult.success
                  ? "The native selection completed after the waiting period. The requested element is now selected; the diagram was not changed."
                  : "The native selection returned after the waiting period but failed: " + (finalResult.error || "Draw.io rejected the selection.");
                setLastAction(reconciledText);
                const reconciledMessage: ChatMessage = { role: "assistant", id: Date.now(), text: reconciledText };
                setMessages((items) => [...items, reconciledMessage].slice(-300));
                recordDiagnostic("copilot.selection.acknowledgement.late-reconciled",
                  "Reconciled a native selection result after the UI wait expired",
                  { requestId, cellId: finalResult.cellId, success: finalResult.success, error: finalResult.error ?? null },
                  finalResult.success ? "warn" : "error");
              }
            }}
            onSelectionChange={(cellId, pageId) => {
              setSelectedNativeCellId(cellId);
              setSelectedNativePageId(pageId);
              setDiagramTheme(detectDrawioDiagramTheme(latestDiagramStateRef.current.drawioXml, pageId));
            }}
            onHistoryStateChange={setNativeHistoryState}
            cellEdit={cellEditRequest}
            onEditorStatusChange={setNativeEditorReady}
            onDocumentChange={(nativeXml) => {
              setNativeXmlOverride(nativeXml);
              setRevision((value) => value + 1);
              setDiagramTheme(detectDrawioDiagramTheme(nativeXml, latestDiagramStateRef.current.selectedNativePageId));
              setLastAction("Synced native Draw.io changes");
            }} />
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right">
          <span className="status-drawio" title="Local Draw.io bundle on a dedicated sandboxed origin; CSP blocks network connections">Sandboxed Draw.io {DRAWIO_VERSION}</span>
          <span className={nativeEditorReady ? "status-native" : "status-native status-warn"}
            title={nativeEditorReady
              ? "Native Draw.io editor ready · AI scripts use the live editor API and save through Studio"
              : "Waiting for the native Draw.io editor handshake"}>
            {nativeEditorReady ? "Native editor ready · AI execution enabled" : "Connecting to Draw.io…"}
          </span>
        </div></div>
      </main>
      <div className="panel-resizer panel-resizer-right" role="separator" aria-orientation="vertical" aria-label="Resize the inspector sidebar" title="Drag to resize" onPointerDown={(event) => startPanelResize(event)} />

      <aside className="right-panel">
        <div className="right-tabs" role="tablist" aria-label="Inspector panel">
          {([["properties", "Properties"], ["copilot", "Copilot"]] as Array<[typeof rightPanelTab, string]>).map(([tab, label]) =>
            <button key={tab} type="button" role="tab" aria-selected={rightPanelTab === tab}
              className={"right-tab" + (rightPanelTab === tab ? " active" : "")}
              onClick={() => setRightPanelTab(tab)}>{label}</button>
          )}
        </div>
        {rightPanelTab === "copilot" && <div className="right-copilot-panel">
          <WorkspacePages
            page="copilot"
            messages={messages} chatInput={chatInput} setChatInput={setChatInput} chatBusy={chatBusy}
            sendIntent={() => void sendIntent()}
             confirmProposal={(proposalId) => void confirmProposal(proposalId)}
             aiModel={aiModel} setAiModel={setAiModel}
            reasoningEffort={reasoningEffort} setReasoningEffort={setReasoningEffort}
             saveAISettings={saveAISettings} clearAISettings={clearAISettings}
            traceEntries={traceEntries} refreshTraces={refreshTraceHistory}
            drawioStatus={drawioStatus} drawioStatusMessage={drawioStatusMessage}
             checkDrawioStatus={() => void checkDrawioStatus()}
          />
        </div>}
        {rightPanelTab === "properties" && <section className="inspector-section">
          {selectedNativeCellId ? <NativeSelectionInspector xml={drawioXml} cellId={selectedNativeCellId} pageId={selectedNativePageId}
            onEdit={(cellId, path, value, pageId) => setCellEditRequest({
              cellId, pageId, path, value, requestId: ++cellEditRequestSequenceRef.current
            })} /> : <div className="empty-inspector">Select a cell in the native Draw.io canvas to inspect or edit its properties.</div>}
        </section>}
      </aside>
        </>
      </div>
      {activePage !== "diagram" && (
        <WorkspacePages
          page={activePage}
          messages={messages}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatBusy={chatBusy}
          sendIntent={() => void sendIntent()}
             confirmProposal={(proposalId) => void confirmProposal(proposalId)}
             aiModel={aiModel} setAiModel={setAiModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
             saveAISettings={saveAISettings} clearAISettings={clearAISettings}
          traceEntries={traceEntries}
          refreshTraces={refreshTraceHistory}
          drawioStatus={drawioStatus}
          drawioStatusMessage={drawioStatusMessage}
          checkDrawioStatus={() => void checkDrawioStatus()}
        />
      )}
    </Layout>
        </AntApp>
      </XProvider>
    </ConfigProvider>
  );
}