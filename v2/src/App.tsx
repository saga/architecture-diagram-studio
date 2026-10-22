import { Children, isValidElement, useEffect, useRef, useState } from "react";
import { App as AntApp, Button, Checkbox, ConfigProvider, Input, Layout, Modal, Select, theme as antdTheme } from "antd";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import type { ButtonHTMLAttributes, ChangeEvent, CSSProperties, InputHTMLAttributes, PointerEvent as ReactPointerEvent, ReactElement, ReactNode, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useCopilotIntent } from "./hooks/useCopilotIntent";
import { downloadText } from "./model/download-text";
import { getDrawioXmlDiagnostics, isDrawioXmlDocument } from "./model/drawio-xml-source";
import DrawioFrame, { DRAWIO_VERSION } from "./components/DrawioFrame";
import NativeSelectionInspector from "./components/NativeSelectionInspector";
import WorkspacePages, { type WorkspacePage } from "./components/WorkspacePages";
import { readDiagnosticEntries, recordDiagnostic } from "./diagnostics";
import type { DiagnosticEntry } from "./diagnostics";
import { useWorkspacePersistence } from "./hooks/useWorkspacePersistence";
import { useWorkspaceBootstrap } from "./hooks/useWorkspaceBootstrap";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type VersionSummary = { id: string; createdAt: string; label: string };
type ProjectWorkspace = { schemaVersion: 1; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
type WorkspaceFile = { path: string; name: string; kind: "diagram" | "code" | "document" | "other"; size: number; modifiedAt: string };
type SavedAISettings = { model: string; reasoningEffort: "high" | "max" };
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
      // An empty model means "no explicit choice": the server's configured model is used instead of
      // pinning a browser-side default that the Copilot runtime may not even have.
      return { model: typeof parsed.model === "string" && parsed.model !== "gpt-5" ? parsed.model : "", reasoningEffort: parsed.reasoningEffort === "high" ? "high" : "max" };
    }
  } catch {
    // The page can still use deterministic local rules when browser storage is unavailable.
  }
  return { model: "", reasoningEffort: "max" };
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

const EMPTY_DRAWIO_XML = '<mxfile host="localhost" agent="Architecture Diagram Studio V2"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="800" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

export default function App() {
  // The active diagram is native Draw.io XML; browser storage keeps only user preferences.
  useEffect(() => {
    // Clean up the previous application's persisted semantic cache after switching to XML-only storage.
    try { window.localStorage.removeItem("architecture-diagram-studio:v2:document"); } catch { /* Storage may be disabled. */ }
  }, []);
  const [selectedNativeCellId, setSelectedNativeCellId] = useState<string | null>(null);
  const [selectedNativePageId, setSelectedNativePageId] = useState<string | null>(null);
  const [cellEditRequest, setCellEditRequest] = useState<{ cellId: string; pageId: string | null; path: string; value: string; requestId: number } | null>(null);
  const cellEditRequestSequenceRef = useRef(0);
  /** Resolves the awaited native-edit batch with the editor's acknowledgement. */
  const nativeEditResolversRef = useRef(new Map<number, (result: { success: boolean; error?: string; batchResults?: Array<{ index: number; cellId: string; path: string; value: string; success: boolean; error?: string }> | null; batchRolledBack?: boolean | null }) => void>());
  const [rightPanelTab, setRightPanelTab] = useState<"properties" | "design" | "copilot">("properties");
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadSavedTheme());
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(() => loadPanelWidths());
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
  const [aiModel, setAiModel] = useState(savedAISettings.model);
  const [reasoningEffort, setReasoningEffort] = useState<"high" | "max">(savedAISettings.reasoningEffort);
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
  const [localHistoryEntries, setLocalHistoryEntries] = useState<Array<{ id: string; createdAt: string; label: string; xml: string }>>([]);
  const [localHistorySelectedId, setLocalHistorySelectedId] = useState<string | null>(null);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false);
  const [versionEntries, setVersionEntries] = useState<VersionSummary[]>([]);
  const [revision, setRevision] = useState(1);
  const [lastAction, setLastAction] = useState("Studio Editorial sample loaded");
  const [nativeEditorReady, setNativeEditorReady] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  const openExistingFileRef = useRef<HTMLInputElement>(null);
  const [standaloneFileHandle, setStandaloneFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [standaloneFileName, setStandaloneFileName] = useState<string | null>(null);
  const standaloneLastSavedXmlRef = useRef<string | null>(null);

  // The complete native Draw.io XML is the only active diagram source.
  const [nativeXmlOverride, setNativeXmlOverride] = useState<string | null>(null);
  const serverRevisionRef = useRef<string | null>(null);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
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
      .then(async (response) => { if (!response.ok) throw new Error("Could not read the Studio configuration"); return response.json() as Promise<{ config?: { model?: string; reasoningEffort?: "high" | "max" }; revisions?: number; hasRuntimeSettings?: boolean }>; })
      .then(async (payload) => {
        if (!active || !payload.config) return;
                // Migrate the previous browser-only model preference into the authoritative server JSONL config
        // once. The model is only sent when the browser holds an explicit choice; otherwise the server
        // keeps its own configured model, which is the one the Copilot runtime can actually serve.
        if (!payload.hasRuntimeSettings) {
          const migratedConfig: Record<string, unknown> = { reasoningEffort: savedAISettings.reasoningEffort };
          if (savedAISettings.model.trim()) migratedConfig.model = savedAISettings.model;
          const response = await fetch("/api/workspace/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: migratedConfig }) });
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
  const drawioXml = nativeXmlOverride ?? EMPTY_DRAWIO_XML;
  const bootstrap = useWorkspaceBootstrap({
    projectWorkspace, setNativeXmlOverride, setCopilotSessionId, setMessages,
    serverRevisionRef, setLastAction, onDiagnostic: recordDiagnostic
  });
  const { serverHydrated, workspaceContentReady, setWorkspaceContentReady, setServerXmlAvailable, workspaceInitialLoadRef } = bootstrap;
  const { persistDocumentNow } = useWorkspacePersistence({ drawioXml, serverHydrated, workspaceContentReady, projectWorkspace, copilotSessionId, messages, saveLabelRef: nextSaveLabelRef, serverRevisionRef, setLastAction, onDiagnostic: recordDiagnostic });

  // The native Draw.io editor is the only canvas. Unsupported native XML disables
  // native cell edits while preserving the complete source XML.

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
        setProjectWorkspace(nextWorkspace); setStandaloneFileHandle(null); setStandaloneFileName(null); standaloneLastSavedXmlRef.current = null; setWorkspaceFiles(result.files || []);
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
        error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[];
        counts?: { files: number; diagrams: number; code: number; documents: number };
      };
      if (!response.ok || !result.workspace) throw new Error(result.error || "Opening the Draw.io workspace failed");
      const nextWorkspace = result.workspace;
      let nextXml: string | null = nativeXmlOverride;
      const workspaceChanged = projectWorkspace?.id !== nextWorkspace.id;
      const diagramChanged = projectWorkspace?.id === nextWorkspace.id && projectWorkspace?.primaryDiagram !== nextWorkspace.primaryDiagram;
      const diagramContextChanged = workspaceChanged || diagramChanged;
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
      // Opening a file is an explicit refresh, so don't let a prior Copilot receipt suppress
      // persistence if the native XML changed while the app was open.
      workspaceInitialLoadRef.current = nextWorkspace.id;
      setServerXmlAvailable(true); setProjectWorkspace(nextWorkspace); setStandaloneFileHandle(null); setStandaloneFileName(null); standaloneLastSavedXmlRef.current = null; setWorkspaceFiles(result.files || workspaceFiles);
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
          const chronological = [...byId.values()].sort((left, right) => {
            const leftTime = Date.parse(left.timestamp);
            const rightTime = Date.parse(right.timestamp);
            return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
          });
          setTraceEntries(chronological.slice(-1200));
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
      diagramKind: "drawio", xmlLength: drawioXml.length
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

  const archiveNativeHistory = (label: string, requestId: number) => {
    const fileKey = (standaloneFileName || "standalone").replace(/[^a-zA-Z0-9._-]/g, "_");
    const historyKey = "architecture-diagram-studio:v2:standalone-history:" + fileKey;
    try {
      const existing = JSON.parse(window.localStorage.getItem(historyKey) || "[]") as Array<{ id: string; createdAt: string; label: string; xml: string }>;
      existing.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), label, xml: drawioXml });
      window.localStorage.setItem(historyKey, JSON.stringify(existing.slice(-100)));
      recordDiagnostic("copilot.standalone.history.snapshot", "Archived the current standalone Draw.io XML before a Copilot mutation", {
        historyKey, snapshotCount: Math.min(existing.length, 100), xmlLength: drawioXml.length, requestId
      });
    } catch (error) {
      recordDiagnostic("copilot.standalone.history.snapshot.failed", "Could not archive a local pre-edit XML snapshot", {
        historyKey, errorMessage: error instanceof Error ? error.message : String(error), requestId
      }, "error");
      throw new Error("Copilot edit cancelled because a local history snapshot could not be saved: " + (error instanceof Error ? error.message : String(error)));
    }
  };

  const sendIntent = useCopilotIntent({
    projectWorkspace, standaloneMode: Boolean(standaloneFileName), chatInput, chatBusy, workspaceContentReady, drawioXml, aiModel, reasoningEffort,
    copilotSessionId, selectedNativeCellId, selectedNativePageId, setWorkspaceSetupOpen, setMessages, setChatInput, setChatBusy,
    setCopilotSessionId,
    applyNativeCellEdit: (cellId, path, value) => {
      const requestId = ++cellEditRequestSequenceRef.current;
      // Selection is UI state, not a document mutation: it must not consume a history slot.
      if (path !== "cell:select") archiveNativeHistory("Before Copilot: " + path + " on " + cellId, requestId);
      recordDiagnostic("copilot.standalone.native-edit.dispatch", "Dispatching a Copilot edit to the active native Draw.io editor", {
        cellId, path, requestId, pageId: selectedNativePageId, standaloneMode: Boolean(standaloneFileName), fileName: standaloneFileName
      });
      setCellEditRequest({ cellId, pageId: selectedNativePageId, path, value, requestId });
    },
    applyNativeCellEdits: (edits) => {
      if (!edits.length) return Promise.resolve({ ok: false, error: "No native edits were supplied", rolledBack: false, steps: [] });
      const requestId = ++cellEditRequestSequenceRef.current;
      archiveNativeHistory("Before Copilot: " + edits.length + " native edit" + (edits.length === 1 ? "" : "s"), requestId);
      return new Promise((resolve) => {
        nativeEditResolversRef.current.set(requestId, (result) => {
          resolve({
            ok: result.success,
            error: result.error,
            rolledBack: result.success ? false : result.batchRolledBack !== false,
            steps: (result.batchResults ?? []).map((step) => ({ index: step.index, cellId: step.cellId, path: step.path, value: step.value, success: step.success, error: step.error }))
          });
        });
        recordDiagnostic("copilot.native-edits.dispatch", "Dispatching an atomic Copilot native edit batch to the active Draw.io editor", {
          requestId, editCount: edits.length, edits, pageId: selectedNativePageId, standaloneMode: Boolean(standaloneFileName), fileName: standaloneFileName
        });
        setCellEditRequest({ cellId: "__batch__", pageId: selectedNativePageId, path: "cell:batch", value: JSON.stringify(edits), requestId });
        window.setTimeout(() => {
          const pending = nativeEditResolversRef.current.get(requestId);
          if (!pending) return;
          nativeEditResolversRef.current.delete(requestId);
          recordDiagnostic("copilot.native-edits.timeout", "The native Draw.io editor did not acknowledge a Copilot batch", { requestId, editCount: edits.length }, "error");
          resolve({ ok: false, error: "The native editor did not acknowledge the batch within 30 seconds.", rolledBack: false, steps: [] });
        }, 30_000);
      });
    }
  });

  async function saveAISettings() {
    const next = { model: aiModel.trim(), reasoningEffort };
    try {
      const response = await fetch("/api/workspace/configuration", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: next }) });
      const payload = await response.json() as { config?: { model?: string; reasoningEffort?: "high" | "max"; revisionId?: string }; error?: string };
      if (!response.ok || !payload.config) throw new Error(payload.error || "Saving the server config failed");
      setAiModel(payload.config.model || "");
      setReasoningEffort(payload.config.reasoningEffort || "max");
      try { window.localStorage.setItem("architecture-diagram-studio:v2:ai-provider", JSON.stringify(next)); } catch { /* Server JSONL is authoritative. */ }
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
      setAiModel("");
      try { window.localStorage.removeItem("architecture-diagram-studio:v2:ai-provider"); } catch { /* Server JSONL is authoritative. */ }
      setLastAction("Local-rules mode config saved as a new revision");
      recordDiagnostic("settings.model.cleared", "Model settings cleared from the server revision history", { revisionId: payload.config.revisionId }, "warn");
    } catch (error) {
      setLastAction("Clearing model settings failed: " + (error instanceof Error ? error.message : String(error)));
    }
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

  function exportDiagram() {
    const sourceName = standaloneFileName || projectWorkspace?.primaryDiagram?.split("/").pop() || "architecture.drawio";
    const filename = sourceName.replace(/\.(drawio|dio|xml)$/i, "").trim().toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "architecture-diagram";
    downloadText(filename + ".drawio", drawioXml);
    setLastAction("Exported the native .drawio file");
    recordDiagnostic("drawio.export.completed", "Exported a .drawio file", { xmlLength: drawioXml.length, fileName: filename + ".drawio" });
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
      if (!isDrawioXmlDocument(xml)) throw new Error("The selected file is not a valid Draw.io XML document.");
      if (workspaceContentReady && projectWorkspace?.primaryDiagram && drawioXml.trim()) {
        try {
          await persistDocumentNow(drawioXml, "Autosave before opening standalone Draw.io");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setLastAction("Could not open " + file.name + " because the current workspace could not be saved: " + message);
          recordDiagnostic("drawio.open.standalone.pre-save-failed", "Opening the selected Draw.io file was stopped because saving the current workspace failed", {
            fileName: file.name, errorMessage: message, currentPrimaryDiagram: projectWorkspace.primaryDiagram,
            workspaceId: projectWorkspace.id, stage: "save-current-workspace-before-open"
          }, "error");
          return;
        }
      }
      setWorkspaceContentReady(false);
      setStandaloneFileHandle(handle);
      setStandaloneFileName(file.name);
      standaloneLastSavedXmlRef.current = xml;
      setNativeXmlOverride(xml);
      setServerXmlAvailable(false);
      serverRevisionRef.current = null;
      setMessages([{ role: "assistant", id: Date.now(), text: "Opened a standalone Draw.io file. It is independent of the configured project workspace." }]);
      setWorkspaceSetupOpen(false);
      setWorkspaceError("");
      setLastAction(handle ? "Opened " + file.name + " with local autosave enabled" : "Opened " + file.name + " as a standalone document; use Export to save changes");
      recordDiagnostic("drawio.open.standalone", "Opened a standalone native Draw.io file", {
        fileName: file.name, xmlLength: xml.length, fileBytes: file.size, pageCount: diagnostics.pageCount,
        hasLocalWriteAccess: Boolean(handle), durationMs: Date.now() - startedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastAction("Opening Draw.io failed: " + message);
      recordDiagnostic("drawio.open.standalone.failed", "Could not open a standalone Draw.io file", {
        fileName: file.name, errorMessage: message
      }, "error");
    }
  }

  async function importDiagramFile(file: File | undefined) {
    if (!file) return;
    const startedAt = Date.now();
    recordDiagnostic("drawio.import.started", "Native Draw.io import started", {
      fileBytes: file.size, fileType: file.name.split(".").pop()?.toLowerCase() || "unknown"
    });
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
      if (!isDrawioXmlDocument(xml)) {
        setLastAction("The selected file is not a supported Draw.io diagram; the active document was not changed.");
        return;
      }
      setNativeXmlOverride(xml);
      setRevision((value) => value + 1);
      if (standaloneFileName) standaloneLastSavedXmlRef.current = xml;
      if (xmlDiagnostics.warnings.length) {
        setLastAction("Imported " + file.name + " with " + xmlDiagnostics.warnings.length + " compatibility warning(s): " + xmlDiagnostics.warnings.slice(0, 2).join(" "));
      } else {
        setLastAction("Imported native Draw.io XML from " + file.name);
      }
      recordDiagnostic("drawio.import.completed", "Native Draw.io XML imported without projection conversion", {
        durationMs: Date.now() - startedAt, xmlLength: xml.length, pageCount: xmlDiagnostics.pageCount,
        warningCount: xmlDiagnostics.warnings.length
      });
    } catch (error) {
      recordDiagnostic("drawio.import.failed", "Draw.io import failed", {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
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

  function openStandaloneHistory() {
    if (!standaloneFileName) return;
    const fileKey = standaloneFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const historyKey = "architecture-diagram-studio:v2:standalone-history:" + fileKey;
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(historyKey) || "[]");
      const entries = Array.isArray(parsed) ? parsed.filter((item): item is { id: string; createdAt: string; label: string; xml: string } =>
        !!item && typeof item === "object" && typeof item.id === "string" && typeof item.createdAt === "string" &&
        typeof item.label === "string" && typeof item.xml === "string") : [];
      setLocalHistoryEntries(entries.slice(-100));
      setLocalHistorySelectedId(entries.at(-1)?.id ?? null);
      setLocalHistoryOpen(true);
    } catch (error) {
      recordDiagnostic("copilot.standalone.history.read.failed", "Could not read local standalone diagram history", {
        fileName: standaloneFileName, errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("Could not read local history");
    }
  }

  function restoreStandaloneHistory(entry: { id: string; createdAt: string; label: string; xml: string }) {
    if (!standaloneFileName || !isDrawioXmlDocument(entry.xml)) {
      setLastAction("History restore cancelled: snapshot is not valid Draw.io XML");
      return;
    }
    const currentXml = drawioXml;
    const fileKey = standaloneFileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const historyKey = "architecture-diagram-studio:v2:standalone-history:" + fileKey;
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(historyKey) || "[]");
      const entries = Array.isArray(parsed) ? parsed as Array<{ id: string; createdAt: string; label: string; xml: string }> : [];
      entries.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), label: "Before restore: " + entry.label, xml: currentXml });
      window.localStorage.setItem(historyKey, JSON.stringify(entries.slice(-100)));
    } catch (error) {
      setLastAction("History restore cancelled because the current XML could not be backed up");
      recordDiagnostic("copilot.standalone.history.restore.backup-failed", "Could not back up current XML before restoring history", {
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      return;
    }
    setNativeXmlOverride(entry.xml);
    setLocalHistoryOpen(false);
    setLastAction("Restored local snapshot: " + entry.label);
    recordDiagnostic("copilot.standalone.history.restored", "Restored a validated local Draw.io XML snapshot", {
      fileName: standaloneFileName, snapshotId: entry.id, xmlLength: entry.xml.length, previousXmlLength: currentXml.length
    });
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
      setNativeXmlOverride(restoredXml);
      setServerXmlAvailable(true);
      setWorkspaceContentReady(true);
      setRevision((value) => value + 1);
      setLastAction("Restored native Draw.io XML from server version history");
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
            <Button type={workspaceLaunchMode === "open" ? "primary" : "default"} onClick={() => { setWorkspaceError(""); if (workspaceLaunchMode === "open") { setWorkspaceSetupOpen(false); void openDrawioFile(); } else { setWorkspaceLaunchMode("open"); } }}>Open existing Draw.io</Button>
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
            {localHistoryEntries.length === 0 ? <p>No local snapshots saved yet. A snapshot is created before each Copilot edit.</p> : [...localHistoryEntries].reverse().map((entry) => (
              <button key={entry.id} type="button" onClick={() => setLocalHistorySelectedId(entry.id)}
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
        <div className="document-breadcrumb"><strong>{projectWorkspace?.primaryDiagram || standaloneFileName || "Draw.io diagram"}</strong><span className="save-state"><i />Saved · r{revision}</span></div>
        <nav className="workspace-nav" aria-label="Workspace pages">
          {([["diagram", "Diagram"], ["traces", "Agent traces"], ["settings", "Settings"]] as Array<[WorkspacePage, string]>).map(([page, label]) =>
            <UiButton key={page} type="button" className={activePage === page ? "active" : ""} aria-current={activePage === page ? "page" : undefined} onClick={() => openPage(page)}>{label}{page === "traces" && traceEntries.some((entry) => entry.level === "error") && <i className="nav-error-dot" />}</UiButton>
          )}
        </nav>
        <label className="theme-selector" title="Switch the color theme of the whole workspace">
          <span aria-hidden="true">◐</span>
          <UiSelect value={uiTheme} aria-label="Interface color theme" popupMatchSelectWidth={false} onChange={(event) => {
            const nextTheme = event.target.value as UiTheme;
            setUiTheme(nextTheme);
            // Theme selection changes the editor chrome only; native cell styles stay untouched.
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
        <div className="topbar-actions">
          {activePage === "diagram" && <>
            <UiButton className="button button-secondary" title="Import a .drawio file" onClick={() => importFileRef.current?.click()}><span className="button-icon">↑</span>Import</UiButton>
            <UiButton className="button button-secondary" title="Export a .drawio file" onClick={exportDiagram}><span className="button-icon">↓</span>Export</UiButton>
            <UiButton className="button button-secondary" title="Browse and restore saved versions" onClick={() => void openVersionHistory()}>History</UiButton>
            {standaloneFileName && <UiButton className="button button-secondary" title="Browse and restore local Draw.io XML snapshots" onClick={openStandaloneHistory}>Local history</UiButton>}
          </>}
        </div>
      </header>

      <div className={"diagram-workspace" + (activePage === "diagram" ? "" : " is-hidden")}>
        <>
      <aside className="left-panel">
        {projectWorkspace && <div className="workspace-card" title={projectWorkspace.rootPath}>
          <b>{projectWorkspace.name}</b>
          <UiButton type="button" className="workspace-switch" onClick={() => setWorkspaceSetupOpen(true)}>Switch workspace</UiButton>
        </div>}


      </aside>
      <div className="panel-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the left sidebar" title="Drag to resize" onPointerDown={(event) => startPanelResize("left", event)} />

      <main className="main-panel">
        <div className="canvas-toolbar">
          <div className="canvas-title">Draw.io diagram</div>
        </div>

        <div className="canvas-stage">
                      <DrawioFrame xml={drawioXml} theme={uiTheme}
            onNativeEditResult={(result) => {
              const resolver = result.requestId === null ? undefined : nativeEditResolversRef.current.get(result.requestId);
              if (resolver && result.requestId !== null) {
                nativeEditResolversRef.current.delete(result.requestId);
                resolver(result);
              }
              const status = result.success ? "Native Draw.io accepted " + (result.path || "edit") + (result.cellId === "__batch__" ? " batch" : "") + "." : "Native Draw.io edit failed: " + (result.error || "Unknown error");
              setLastAction(status);
              if (result.batchResults?.length) {
                for (const step of result.batchResults) {
                  recordDiagnostic("copilot.native-batch.step." + (result.success ? "applied" : "rolled-back"),
                    "Native batch step " + step.index + (result.success ? " applied" : " was rolled back"),
                    { requestId: result.requestId, index: step.index, cellId: step.cellId, path: step.path, value: step.value,
                      stepSuccess: step.success, stepError: step.error ?? null, batchSuccess: result.success, rollbackConfirmed: result.batchRolledBack ?? null });
                }
              }
              recordDiagnostic(result.success ? "copilot.native-edit.acknowledged" : "copilot.native-edit.rejected", status, {
                requestId: result.requestId, cellId: result.cellId, path: result.path, error: result.error || null,
                failedIndex: result.failedIndex ?? null, rollbackErrors: result.rollbackErrors ?? [],
                batchRolledBack: result.batchRolledBack ?? null, batchResults: result.batchResults ?? null
              }, result.success && !(result.rollbackErrors?.length) ? "info" : "error");
            }}
            onSelectionChange={(cellId, pageId) => { setSelectedNativeCellId(cellId); setSelectedNativePageId(pageId); }} cellEdit={cellEditRequest}
            onEditorStatusChange={setNativeEditorReady}
            onDocumentChange={(nativeXml) => { setNativeXmlOverride(nativeXml); setRevision((value) => value + 1); setLastAction("Synced native Draw.io changes"); }} />
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right">
          <span className="status-drawio" title="Same-origin local Draw.io bundle · no hosted embed">Local Draw.io {DRAWIO_VERSION}</span>
          <span className="status-native" title={nativeEditorReady ? "Native editor ready · edits autosave back into Studio" : "Waiting for the Draw.io embed handshake"}>{nativeEditorReady ? "Native editor ready" : "Connecting to Draw.io…"}</span>
        </div></div>
      </main>
      <div className="panel-resizer panel-resizer-right" role="separator" aria-orientation="vertical" aria-label="Resize the inspector sidebar" title="Drag to resize" onPointerDown={(event) => startPanelResize("right", event)} />

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