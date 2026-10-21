import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App as AntApp, Button, Checkbox, ConfigProvider, Input, Layout, Modal, Select, theme as antdTheme } from "antd";
import { XProvider } from "@ant-design/x";
import zhCN from "antd/locale/zh_CN";
import type { ButtonHTMLAttributes, ChangeEvent, CSSProperties, InputHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { isDiagramDocument } from "./model/types";
import type { DiagramDocument, DiagramKind, DiagramNode, SequenceFragment, VisualRole } from "./model/types";
import { FIXTURES } from "./model/fixtures";
import { moveNode } from "./layout/layout";
import { LAYOUT_PROFILES } from "./layout/profiles";
import { evaluateLayout } from "./layout/quality";
import { requestAIIntentPlan } from "./intent/aiProvider";
import { normalizeSequenceDocument } from "./layout/sequence";
import { downloadText, toDrawioXml } from "./export/drawio";
import { fromDrawioXml } from "./import/drawio";
import { roleLabels } from "./design/tokens";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";
import WorkspacePages, { type WorkspacePage } from "./components/WorkspacePages";
import { readDiagnosticEntries, recordDiagnostic } from "./diagnostics";
import type { DiagnosticEntry } from "./diagnostics";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type VersionSummary = { id: string; createdAt: string; label: string; documentId: string | null; title: string | null };
type ProjectWorkspace = { schemaVersion: 1; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
type WorkspaceFile = { path: string; name: string; kind: "diagram" | "code" | "document" | "other"; size: number; modifiedAt: string };
type SavedAISettings = { baseUrl: string; model: string; reasoningEffort: "high" | "max" };
type UiTheme = "editorial" | "youth" | "warm" | "midnight";
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
function loadSavedAISettings(): SavedAISettings {
  try {
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

function UiInput(props: InputHTMLAttributes<HTMLInputElement>) {
  if (props.type === "file") return <input {...props} />;
  if (props.type === "checkbox") return <Checkbox {...(props as any)} />;
  return <Input {...(props as any)} />;
}

function UiTextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Input.TextArea {...(props as any)} />;
}

function UiSelect({ children, onChange, value, defaultValue, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
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
    throw new Error(payload.error || "服务端布局计算失败（HTTP " + response.status + "）");
  }
  const result = await response.json() as { document: DiagramDocument };
  if (!isDiagramDocument(result.document)) throw new Error("服务端返回了无效的图形文档");
  return result.document;
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
  const [previewSummary, setPreviewSummary] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("domain");
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const [rightPanelTab, setRightPanelTab] = useState<"properties" | "quality" | "design">("properties");
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => loadSavedTheme());
  const [viewMode, setViewMode] = useState<"studio" | "drawio">("studio");
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
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const initial: ChatMessage[] = [
      { role: "assistant", id: 1, text: "描述想要的布局变化即可，例如「所有 external 移到右侧」「数据库放到底部」或「所有连线改成直角折线」。未配置模型时使用本地规则；配置后会把请求转换为受限的布局指令，并先生成预览供确认。" }
    ];
    try {
      const saved = window.localStorage.getItem("architecture-diagram-studio:v2:chat-messages");
      if (!saved) return initial;
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed)) return initial;
      return parsed.filter((item): item is ChatMessage =>
        !!item && typeof item === "object" &&
        ((item as ChatMessage).role === "assistant" || (item as ChatMessage).role === "user") &&
        typeof (item as ChatMessage).text === "string" &&
        typeof (item as ChatMessage).id === "number"
      ).slice(-300);
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
  const [lastAction, setLastAction] = useState("已加载 Studio Editorial 示例");
  const [isLayoutting, setIsLayoutting] = useState(false);
  const [relationTargetId, setRelationTargetId] = useState("");
  const [relationLabel, setRelationLabel] = useState("");
  const [relationLabelDrafts, setRelationLabelDrafts] = useState<Record<string, string>>({});
  const importFileRef = useRef<HTMLInputElement>(null);

  const visibleDocument = previewDocument || document;
  const selectedNode = document.nodes.find((node) => node.id === selectedNodeId) || null;
  const selectedRelation = document.relations.find((relation) => relation.id === selectedRelationId) || null;
  const quality = useMemo(() => evaluateLayout(visibleDocument), [visibleDocument]);
  const generatedDrawioXml = useMemo(() => toDrawioXml(document), [document]);
  const [nativeXmlOverride, setNativeXmlOverride] = useState<string | null>(null);
  const [serverHydrated, setServerHydrated] = useState(false);
  const [serverDocumentAvailable, setServerDocumentAvailable] = useState(false);
  const workspaceInitialLoadRef = useRef<string | null>(null);
  const [projectWorkspace, setProjectWorkspace] = useState<ProjectWorkspace | null>(null);
  const [workspaceSetupOpen, setWorkspaceSetupOpen] = useState(false);
  const [workspaceChecking, setWorkspaceChecking] = useState(true);
  const [workspaceSaving, setWorkspaceSaving] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceRootPath, setWorkspaceRootPath] = useState("");
  const [workspacePrimaryDiagram, setWorkspacePrimaryDiagram] = useState("");
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [workspaceError, setWorkspaceError] = useState("");
  const nextSaveLabelRef = useRef("自动保存");
  const drawioXml = nativeXmlOverride ?? generatedDrawioXml;

  useEffect(() => {
    let active = true;
    fetch("/api/workspace/config").then(async (response) => { if (!response.ok) throw new Error("无法读取项目工作区配置"); return response.json() as Promise<{ configured?: boolean; workspace?: ProjectWorkspace | null }>; }).then((result) => { if (!active) return; const workspace = result.workspace || null; setProjectWorkspace(workspace); setWorkspaceSetupOpen(!result.configured || !workspace); if (workspace) { setWorkspaceName(workspace.name); setWorkspaceRootPath(workspace.rootPath); setWorkspacePrimaryDiagram(workspace.primaryDiagram || ""); void fetch("/api/workspace/files").then((response) => response.ok ? response.json() as Promise<{ files?: WorkspaceFile[] }> : Promise.resolve({ files: [] })).then((result) => { if (active) setWorkspaceFiles(result.files || []); }).catch(() => undefined); } }).catch((error) => { if (!active) return; setWorkspaceError(error instanceof Error ? error.message : String(error)); setWorkspaceSetupOpen(true); }).finally(() => { if (active) setWorkspaceChecking(false); });
    return () => { active = false; };
  }, []);

  async function saveProjectWorkspace() {
    setWorkspaceSaving(true); setWorkspaceError("");
    try {
      const response = await fetch("/api/workspace/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath, primaryDiagram: workspacePrimaryDiagram || null }) });
      const result = await response.json() as { error?: string; workspace?: ProjectWorkspace; files?: WorkspaceFile[]; counts?: { files: number; diagrams: number; code: number; documents: number } };
      if (!response.ok || !result.workspace) throw new Error(result.error || "工作区配置失败");
      const nextWorkspace = result.workspace;
      let nextDocument = document;
      let nextXml: string | null = nativeXmlOverride;
      const workspaceChanged = projectWorkspace?.id !== nextWorkspace.id;
      if (workspaceChanged) { setMessages([{ role: "assistant", id: Date.now(), text: "已切换到新项目工作区。后续分析将以该目录中的 Draw.io 图、代码和设计文档为依据。" }]); const newSessionId = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : newId("session"); setCopilotSessionId(newSessionId); }
      if (nextWorkspace.primaryDiagram && /\.(drawio|dio|xml)$/i.test(nextWorkspace.primaryDiagram)) {
        const fileResponse = await fetch("/api/workspace/files/content?path=" + encodeURIComponent(nextWorkspace.primaryDiagram));
        const fileResult = await fileResponse.json() as { error?: string; content?: string };
        if (!fileResponse.ok || typeof fileResult.content !== "string") throw new Error(fileResult.error || "无法读取所选 Draw.io 文件");
        nextXml = fileResult.content;
        nextDocument = fromDrawioXml(fileResult.content, document);
      } else if (workspaceChanged) {
        nextDocument = FIXTURES.c4();
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
      recordDiagnostic("workspace.project.configured", "项目工作区已配置", { workspaceId: nextWorkspace.id, rootPath: nextWorkspace.rootPath, primaryDiagram: nextWorkspace.primaryDiagram, ...(result.counts || {}) });
    } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)); }
    finally { setWorkspaceSaving(false); }
  }

  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    fetch("/api/workspace/state")
      .then(async (response) => {
        if (!response.ok) throw new Error("服务端工作区加载失败（HTTP " + response.status + "）");
        return response.json() as Promise<{ document?: unknown; drawioXml?: unknown; copilotSessionId?: unknown; chatMessages?: unknown[] }>;
      })
      .then((state) => {
        if (!active) return;
        const savedDocument = isDiagramDocument(state.document) ? state.document : null;
        setServerDocumentAvailable(Boolean(savedDocument));
        if (savedDocument) {
          setDocument(savedDocument);
          setSelectedNodeId(savedDocument.nodes[0]?.id || null);
          setNativeXmlOverride(typeof state.drawioXml === "string" ? state.drawioXml : null);
          historyRef.current = [savedDocument];
          historyIndexRef.current = 0;
          setCanUndo(false);
          setCanRedo(false);
          recordDiagnostic("workspace.hydrated", "从服务端恢复工作区和原生 Draw.io XML", {
            documentId: savedDocument.id, nodeCount: savedDocument.nodes.length,
            xmlLength: typeof state.drawioXml === "string" ? state.drawioXml.length : 0,
            durationMs: Date.now() - startedAt
          });
        }
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
        recordDiagnostic("workspace.hydrate.failed", "无法从服务端恢复工作区，暂时使用本地草稿", {
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
          if (!response.ok || typeof result.content !== "string") throw new Error(result.error || "无法加载主要 Draw.io 图");
          const imported = fromDrawioXml(result.content, FIXTURES.c4());
          if (!active) return;
          setDocument(imported); setNativeXmlOverride(result.content); setSelectedNodeId(imported.nodes[0]?.id || null);
          historyRef.current = [imported]; historyIndexRef.current = 0; setCanUndo(false); setCanRedo(false);
          setServerDocumentAvailable(true);
          recordDiagnostic("workspace.primary-diagram.loaded", "已从项目工作区加载主要 Draw.io 图", { workspaceId: projectWorkspace.id, path: projectWorkspace.primaryDiagram, xmlLength: result.content.length });
        } else {
          const laidOut = await requestServerLayout(FIXTURES.c4());
          if (!active) return;
          setDocument(laidOut); setNativeXmlOverride(null); setSelectedNodeId(laidOut.nodes[0]?.id || null);
          historyRef.current = [laidOut]; historyIndexRef.current = 0; setCanUndo(false); setCanRedo(false);
        }
      } catch (error) {
        if (active) recordDiagnostic("workspace.primary-diagram.load.failed", "无法加载工作区主要图形", { workspaceId: projectWorkspace.id, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
      }
    };
    void load();
    return () => { active = false; };
  }, [serverHydrated, projectWorkspace, serverDocumentAvailable]);

  useEffect(() => {
    if (!serverHydrated || !projectWorkspace) return;
    const timer = window.setTimeout(() => {
      fetch("/api/workspace/document", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document, drawioXml, label: nextSaveLabelRef.current })
      }).then(async (response) => {
        if (!response.ok) throw new Error("HTTP " + response.status + ": " + (await response.text()).slice(0, 300));
        const result = await response.json() as { saved?: boolean; version?: { id?: string } | null };
        if (result.saved) recordDiagnostic("workspace.version.persisted", "文档及 Draw.io XML 版本已持久化到服务端", {
          versionId: result.version?.id, xmlLength: drawioXml.length, nodeCount: document.nodes.length
        });
      }).catch((error: unknown) => {
        recordDiagnostic("workspace.persist.failed", "服务端保存工作区失败", {
          errorMessage: error instanceof Error ? error.message : String(error),
          xmlLength: drawioXml.length, nodeCount: document.nodes.length
        }, "error");
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [document, drawioXml, serverHydrated, projectWorkspace]);

  useEffect(() => {
    if (!serverHydrated || !projectWorkspace) return;
    fetch("/api/workspace/chat", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ copilotSessionId, chatMessages: messages.slice(-2000) })
    }).then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
    }).catch((error: unknown) => {
      recordDiagnostic("copilot.chat.persist.failed", "Copilot 会话记录无法保存到服务端", {
        sessionId: copilotSessionId, messageCount: messages.length,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
    });
  }, [copilotSessionId, messages, serverHydrated, projectWorkspace]);

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
      recordDiagnostic("runtime.window.error", "未捕获浏览器运行时错误", {
        errorMessage: event.message, fileName: event.filename, line: event.lineno, column: event.colno
      }, "error");
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      recordDiagnostic("runtime.unhandled_rejection", "出现未处理的 Promise rejection", {
        reasonType: reason instanceof Error ? reason.name : typeof reason,
        reasonMessage: reason instanceof Error ? reason.message : String(reason).slice(0, 250)
      }, "error");
    };
    window.addEventListener("studio:diagnostic", refreshTraces);
    window.addEventListener("studio:diagnostic-clear", refreshTraces);
    window.addEventListener("error", handleWindowError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    recordDiagnostic("app.started", "V2 工作区启动", {
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
      setLastAction("浏览器存储不可用；本次会话仍可继续编辑");
    }
  }, [document]);

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
    recordDiagnostic("ui.theme.changed", "更新界面配色主题", { theme: uiTheme });
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
    recordDiagnostic("diagram.change.committed", "正式图形文档已更新", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length,
      hasPreview: false, preservedNativeXml: Boolean(preservedNativeXml)
    });
  }, []);

  const runLayout = useCallback(async (source: DiagramDocument = document) => {
    const startedAt = Date.now();
    recordDiagnostic("layout.run.started", "开始重新计算布局、路由和重叠修复", {
      diagramKind: source.kind, nodeCount: source.nodes.length, relationCount: source.relations.length,
      routing: source.layout.routing, profile: source.layout.profile
    });
    setIsLayoutting(true);
    try {
      const next = await requestServerLayout(source);
      recordDiagnostic("layout.run.completed", "布局计算成功", {
        durationMs: Date.now() - startedAt, nodeCount: next.nodes.length, relationCount: next.relations.length,
        routing: next.layout.routing, profile: next.layout.profile
      });
      commitDocument(next, "已重新计算布局、路由并运行重叠修复");
    } catch (error) {
      recordDiagnostic("layout.run.failed", "布局计算失败", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("布局失败：" + (error instanceof Error ? error.message : String(error)));
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
    setLastAction("已撤销到上一版本");
    recordDiagnostic("diagram.history.undo", "已撤销到上一版本", {
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
    setLastAction("已重做到下一版本");
    recordDiagnostic("diagram.history.redo", "已重做到下一版本", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length
    });
  }

  function changeKind(kind: DiagramKind) {
    setPreviewDocument(null);
    setPreviewSummary("");
    setSelectedRelationId(null);
    const next = FIXTURES[kind]();
    setSelectedNodeId(next.nodes[0]?.id || null);
    setViewMode("studio");
    commitDocument(next, "切换到 " + (kind === "c4" ? "C4 架构图" : kind === "sequence" ? "时序图" : "流程图"));
    void runLayout(next);
  }

  async function sendIntent() {
    if (!projectWorkspace) { setWorkspaceSetupOpen(true); return; }
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const startedAt = Date.now();
    recordDiagnostic("copilot.request.started", "开始处理布局意图", {
      configuredModel: Boolean(aiModel.trim()), provider: aiModel.trim() ? "github-copilot-sdk" : "local-rules", model: aiModel.trim() || "local-rules",
      sessionId: copilotSessionId, diagramKind: document.kind, nodeCount: document.nodes.length, relationCount: document.relations.length,
      inputLength: text.length
    });
    setMessages((items) => [...items, { role: "user", id: Date.now(), text }]);
    setChatInput("");
    setChatBusy(true);
    try {
      let effectiveText = text;
      let modelReply = "";
      if (aiModel.trim()) {
        recordDiagnostic("copilot.agent.request", "请求 Copilot SDK Agent 生成受限布局计划", {
          sessionId: copilotSessionId, model: aiModel.trim(), reasoningEffort, provider: "github-copilot-sdk", inputLength: text.length, nodeCount: Math.min(document.nodes.length, 80)
        });
        const plan = await requestAIIntentPlan(
          { baseUrl: "copilot-sdk", model: aiModel, reasoningEffort, sessionId: copilotSessionId },
          text,
          {
            kind: document.kind,
            title: document.title,
            selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name, role: selectedNode.role } : null,
            nodes: document.nodes.slice(0, 80).map((node) => ({ id: node.id, name: node.name, role: node.role }))
          }
        );
        if (plan.sessionId && plan.sessionId !== copilotSessionId) {
          setCopilotSessionId(plan.sessionId);
          try { window.localStorage.setItem("architecture-diagram-studio:v2:copilot-session-id", plan.sessionId); } catch { /* Session remains active in memory. */ }
        }
        modelReply = plan.reply;
        recordDiagnostic("copilot.agent.response", "已收到 Copilot SDK Agent 工具计划", {
          sessionId: plan.sessionId || copilotSessionId, provider: plan.provider || "github-copilot-sdk", model: plan.model || aiModel.trim(),
          reasoningEffort: plan.reasoningEffort, durationMs: plan.durationMs, toolUsed: "propose_layout_plan",
          commandCount: plan.commands.length, replyLength: plan.reply.length
        });
        if (!plan.commands.length) {
          recordDiagnostic("copilot.plan.empty", "模型未返回可执行布局指令，未修改正式文档", {}, "warn");
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: "未执行修改。 " + (modelReply || "这个请求没有匹配到当前支持的安全布局操作。") }]);
          return;
        }
        effectiveText = plan.commands.join("；");
      }
      const applyResponse = await fetch("/api/workspace/intent/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document, prompt: effectiveText }),
        signal: AbortSignal.timeout(70_000)
      });
      if (!applyResponse.ok) {
        const payload = await applyResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || "服务端布局意图处理失败（HTTP " + applyResponse.status + "）");
      }
      const result = await applyResponse.json() as {
        document: DiagramDocument; summary: string; requiresLayout: boolean; changed: boolean;
      };
      recordDiagnostic(result.changed ? "copilot.intent.matched" : "copilot.intent.no_change",
        result.changed ? "布局意图已映射到可执行规则" : "布局意图没有匹配到可执行规则",
        { changed: result.changed, requiresLayout: result.requiresLayout, commandLength: effectiveText.length });
      if (result.changed) {
        setPreviewDocument(result.document);
        setPreviewSummary(result.summary);
        setViewMode("studio");
        const previewQuality = evaluateLayout(result.document);
        const prefix = modelReply ? modelReply + " " : "";
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: prefix + result.summary + "。已生成临时预览，布局分数 " + previewQuality.score + "；正式文档尚未改变。请检查后应用或丢弃。" }]);
        recordDiagnostic("copilot.preview.created", "已生成待确认的布局预览", {
          durationMs: Date.now() - startedAt, qualityScore: previewQuality.score,
          nodeCount: result.document.nodes.length, relationCount: result.document.relations.length
        });
      } else {
        const reply = modelReply
          ? "没有应用任何修改。 " + modelReply + "（模型计划未匹配到可执行的布局操作。）"
          : result.summary;
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: reply }]);
      }
    } catch (error) {
      recordDiagnostic("copilot.request.failed", "处理布局意图失败，没有提交修改", {
        durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        detailRecordedByProvider: Boolean(aiModel.trim())
      }, "error");
      setMessages((items) => [...items, { role: "assistant", id: Date.now() + 2, text: "没有提交修改：" + (error instanceof Error ? error.message : String(error)) }]);
    } finally {
      recordDiagnostic("copilot.request.finished", "布局意图处理流程结束", {
        durationMs: Date.now() - startedAt, busy: false
      });
      setChatBusy(false);
    }
  }

  function saveAISettings() {
    const next = { baseUrl: "copilot-sdk", model: aiModel.trim(), reasoningEffort };
    setAiBaseUrl("copilot-sdk");
    setAiModel(next.model);
    let saved = true;
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:ai-provider", JSON.stringify(next));
    } catch {
      saved = false;
      setLastAction("无法保存 Copilot SDK 模型设置；当前页面仍可继续使用");
    }
    recordDiagnostic("settings.model.saved", saved ? "模型接口配置已保存" : "模型接口配置无法写入浏览器存储", {
      provider: "github-copilot-sdk", model: next.model || "server-default", persisted: saved
    }, saved ? "info" : "warn");
    if (saved) setLastAction(next.model ? "Copilot SDK 模型配置已保存" : "已切回本地规则模式");
  }

  function clearAISettings() {
    setAiBaseUrl("");
    setAiModel("");
    setAiApiKey("");
    try { window.localStorage.removeItem("architecture-diagram-studio:v2:ai-provider"); } catch { /* Ignore unavailable storage. */ }
    setLastAction("已切回本地规则模式");
    recordDiagnostic("settings.model.cleared", "已清除持久模型配置并切换到本地规则", {}, "warn");
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
    commitDocument(next, "已添加 alt 时序片段");
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
    commitDocument(next, "已更新时序片段");
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
    commitDocument(next, "已删除时序片段");
  }

  function changeRelationEndpoints(relationId: string, source: string, target: string) {
    if (!source || !target || source === target) {
      setLastAction("关系线的源节点和目标节点必须不同");
      return;
    }
    const current = document.relations.find((relation) => relation.id === relationId);
    if (!current || (current.source === source && current.target === target)) return;
    const next = normalizeSequenceDocument({
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, source, target, points: [] }
        : relation)
    });
    commitDocument(next, "已更新关系线的源节点与目标节点");
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
    commitDocument(next, "已更新节点属性");
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
    commitDocument(next, "添加节点：" + node.name);
    void runLayout(next);
  }

  function addRelation() {
    if (!selectedNode || !relationTargetId || relationTargetId === selectedNode.id) return;
    const alreadyExists = document.relations.some((relation) =>
      relation.source === selectedNode.id && relation.target === relationTargetId && relation.label === relationLabel.trim()
    );
    if (alreadyExists) {
      setLastAction("这条关系已经存在");
      return;
    }
    const next = normalizeSequenceDocument({
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
    commitDocument(next, "已建立 " + selectedNode.name + " → " + (document.nodes.find((node) => node.id === relationTargetId)?.name || relationTargetId) + " 的关系");
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
    commitDocument(next, "已更新关系标签");
  }

  function removeRelation(relationId: string) {
    if (selectedRelationId === relationId) setSelectedRelationId(null);
    const next = normalizeSequenceDocument({ ...document, relations: document.relations.filter((relation) => relation.id !== relationId) });
    setRelationLabelDrafts((drafts) => {
      const updated = { ...drafts };
      delete updated[relationId];
      return updated;
    });
    commitDocument(next, "已删除一条关系");
  }

  function reverseRelation(relationId: string) {
    const next = {
      ...document,
      relations: document.relations.map((relation) => relation.id === relationId
        ? { ...relation, source: relation.target, target: relation.source, points: [] }
        : relation)
    };
    commitDocument(next, "已反转关系方向");
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
    commitDocument(next, routingChanged ? "已更新关系线路由" : "已更新关系线型");
  }

  function removeSelectedNode() {
    if (!selectedNode) return;
    setSelectedRelationId(null);
    const next = normalizeSequenceDocument({
      ...document,
      nodes: document.nodes.filter((node) => node.id !== selectedNode.id),
      relations: document.relations.filter((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id),
      boundaries: document.boundaries.map((boundary) => ({ ...boundary, members: boundary.members.filter((id) => id !== selectedNode.id) })),
      flow: document.flow ? { ...document.flow, primaryPath: document.flow.primaryPath.filter((id) => id !== selectedNode.id) } : undefined,
      sequence: document.sequence ? { ...document.sequence, participants: document.sequence.participants.filter((id) => id !== selectedNode.id) } : undefined
    });
    setSelectedNodeId(next.nodes[0]?.id || null);
    commitDocument(next, "已删除节点及其关系");
  }

  function resetDiagram() {
    setSelectedRelationId(null);
    const next = FIXTURES[document.kind]();
    setSelectedNodeId(next.nodes[0]?.id || null);
    commitDocument(next, "已恢复示例图");
    recordDiagnostic("diagram.reset", "用户恢复了当前图形类型的内置示例", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length
    }, "warn");
    void runLayout(next);
  }

  function acceptPreview() {
    if (!previewDocument) return;
    const next = previewDocument;
    const summary = previewSummary || "已应用布局预览";
    commitDocument(next, summary + "（已应用）");
    recordDiagnostic("copilot.preview.applied", "用户确认应用布局预览", {
      diagramKind: next.kind, nodeCount: next.nodes.length, relationCount: next.relations.length
    });
    setMessages((items) => [...items, { role: "assistant", id: Date.now(), text: "预览已应用，正式文档已更新。" }]);
  }

  function discardPreview() {
    if (!previewDocument) return;
    setPreviewDocument(null);
    setPreviewSummary("");
    setLastAction("已丢弃预览，正式文档保持不变");
    recordDiagnostic("copilot.preview.discarded", "用户丢弃布局预览，正式文档未改变");
  }

  function exportDiagram() {
    const filename = document.title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "architecture-diagram";
    downloadText(filename + ".drawio", drawioXml);
    setLastAction("已导出原生 .drawio 文件");
    recordDiagnostic("drawio.export.completed", "已导出 .drawio 文件", { xmlLength: drawioXml.length, nodeCount: document.nodes.length, relationCount: document.relations.length });
  }

  async function importDiagramFile(file: File | undefined) {
    if (!file) return;
    const startedAt = Date.now();
    recordDiagnostic("drawio.import.started", "开始导入 Draw.io 文件", { fileBytes: file.size, fileType: file.name.split(".").pop()?.toLowerCase() || "unknown" });
    try {
      const xml = await file.text();
      const empty: DiagramDocument = { ...document, id: newId("imported"), nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined };
      const parsed = fromDrawioXml(xml, empty);
      if (!parsed.nodes.length) {
        setLastAction("没有找到可导入的节点；请检查文件是否为有效的 .drawio XML");
        return;
      }
      const next = await requestServerLayout(parsed);
      setSelectedRelationId(null);
      setSelectedNodeId(next.nodes[0]?.id || null);
      commitDocument(next, "已导入 " + file.name + "，解析 " + next.nodes.length + " 个节点与 " + next.relations.length + " 条关系");
      recordDiagnostic("drawio.import.completed", "Draw.io 文件解析并导入完成", {
        durationMs: Date.now() - startedAt, nodeCount: next.nodes.length, relationCount: next.relations.length
      });
    } catch (error) {
      recordDiagnostic("drawio.import.failed", "导入 Draw.io 文件失败", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("导入失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
  }

  async function checkDrawioStatus() {
    setDrawioStatus("checking");
    setDrawioStatusMessage("检查本地资源清单与编辑器入口…");
    const startedAt = Date.now();
    recordDiagnostic("drawio.healthcheck.started", "手动检查本地 Draw.io 资源", {
      manifestUrl: "/drawio/studio-bundle.json", entryUrl: "/drawio/index.html"
    });
    try {
      const [manifestResponse, entryResponse] = await Promise.all([
        fetch("/drawio/studio-bundle.json", { cache: "no-store" }),
        fetch("/drawio/index.html", { method: "HEAD", cache: "no-store" })
      ]);
      if (!manifestResponse.ok || !entryResponse.ok) {
        const message = "manifest HTTP " + manifestResponse.status + "；index.html HTTP " + entryResponse.status;
        setDrawioStatus("missing");
        setDrawioStatusMessage(message);
        recordDiagnostic("drawio.healthcheck.missing", "Draw.io 本地资源不可用", {
          manifestStatus: manifestResponse.status, indexStatus: entryResponse.status,
          durationMs: Date.now() - startedAt
        }, "error");
        return;
      }
      const manifest = await manifestResponse.json() as { version?: string; sha256?: string };
      const matches = manifest.version === "v32.0.2" && manifest.sha256 === "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
      if (!matches) {
        setDrawioStatus("missing");
        setDrawioStatusMessage("资源已响应，但版本或 SHA-256 与固定版本不一致。");
        recordDiagnostic("drawio.healthcheck.mismatch", "Draw.io 资源清单不匹配", {
          installedVersion: manifest.version ?? null, checksumMatches: manifest.sha256 === "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7",
          durationMs: Date.now() - startedAt
        }, "error");
        return;
      }
      setDrawioStatus("ready");
      setDrawioStatusMessage("v32.0.2 资源与 SHA-256 清单匹配；index.html HTTP " + entryResponse.status + "。此检查不代替 iframe embed 初始化握手。");
      recordDiagnostic("drawio.healthcheck.ready", "Draw.io 本地资源检查通过", {
        version: manifest.version, indexStatus: entryResponse.status, durationMs: Date.now() - startedAt
      });
    } catch (error) {
      setDrawioStatus("error");
      setDrawioStatusMessage(error instanceof Error ? error.message : String(error));
      recordDiagnostic("drawio.healthcheck.failed", "检查 Draw.io 本地资源时发生异常", {
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
      recordDiagnostic("workspace.versions.load.failed", "无法加载服务端版本历史", {
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("无法加载版本历史，请检查服务端日志");
    } finally {
      setVersionHistoryLoading(false);
    }
  }

  async function restoreVersion(versionId: string) {
    try {
      const response = await fetch("/api/workspace/versions/" + encodeURIComponent(versionId) + "/restore", { method: "POST" });
      const result = await response.json() as { error?: string; state?: { document?: unknown; drawioXml?: unknown }; version?: { id?: string } };
      const restoredState = result.state;
      if (!response.ok || !restoredState || !isDiagramDocument(restoredState.document) || typeof restoredState.drawioXml !== "string") {
        throw new Error(result.error || "服务端版本恢复失败");
      }
      const restored = restoredState.document as DiagramDocument;
      const restoredXml = restoredState.drawioXml as string;
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
      setLastAction("已从服务端版本历史恢复图形和原生 Draw.io XML");
      setVersionHistoryOpen(false);
      recordDiagnostic("workspace.version.restored", "已恢复完整的服务端版本快照", {
        sourceVersionId: versionId, newVersionId: result.version?.id,
        xmlLength: restoredXml.length, nodeCount: restored.nodes.length
      });
    } catch (error) {
      recordDiagnostic("workspace.version.restore.failed", "恢复服务端版本失败", {
        sourceVersionId: versionId,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      setLastAction("版本恢复失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }

  function refreshTraceHistory() {
    recordDiagnostic("trace.refreshed", "刷新服务端应用轨迹");
  }

  function openPage(page: WorkspacePage) {
    setActivePage(page);
    recordDiagnostic("navigation.opened", "打开工作区页面", { page });
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
    recordDiagnostic("diagram.relation.selected", "在画布上选中一条关系线", { relationId: id });
  }

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: uiTheme === "midnight" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: "#425bc7",
          colorInfo: "#425bc7",
          borderRadius: 8,
          fontFamily: '"SF Pro Display", "Segoe UI", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
          fontSize: 13,
          controlHeight: 34,
        },
      }}
    >
      <XProvider>
        <AntApp>
    <Layout className="app-shell" data-theme={uiTheme}>
      <Modal title="设置项目工作区" open={!workspaceChecking && workspaceSetupOpen} closable={Boolean(projectWorkspace)} maskClosable={false} onCancel={() => { if (projectWorkspace) setWorkspaceSetupOpen(false); }} footer={null} width={680}>
        <div style={{ display: "grid", gap: 16, paddingTop: 8 }}>
          <p>工作区是所有图形编辑、代码分析和 Agent 推理的项目边界。请选择运行 Studio 的这台机器上的项目根目录；服务端会扫描其中的 Draw.io 图、代码和设计文档，并将配置保存为 JSON。</p>
          {workspaceError && <div role="alert" style={{ color: "#b42318", background: "#fef3f2", borderRadius: 6, padding: 10 }}>{workspaceError}</div>}
          <label style={{ display: "grid", gap: 6 }}><strong>工作区名称</strong><Input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="例如：Payments Architecture" /></label>
          <label style={{ display: "grid", gap: 6 }}><strong>本机项目目录绝对路径</strong><Input value={workspaceRootPath} onChange={(event) => setWorkspaceRootPath(event.target.value)} placeholder="/Users/you/work/project" /></label>
          <small style={{ color: "var(--muted, #667085)" }}>路径由本地 Node.js 服务访问，不是浏览器的文件选择器路径。可填写包含源码、ADR、README 和 .drawio 文件的项目根目录。</small>
          {workspaceFiles.length > 0 && <div style={{ border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, padding: 12 }}><strong>已发现文件</strong><div style={{ marginTop: 6 }}>{workspaceFiles.length} 个文件 · {workspaceFiles.filter((file) => file.kind === "diagram").length} 个图形 · {workspaceFiles.filter((file) => file.kind === "code").length} 个代码文件 · {workspaceFiles.filter((file) => file.kind === "document").length} 个文档</div></div>}
          <label style={{ display: "grid", gap: 6 }}><strong>主要 Draw.io 图（可选）</strong><Select value={workspacePrimaryDiagram || undefined} allowClear showSearch placeholder="保存目录后可选择主要图形" options={workspaceFiles.filter((file) => file.kind === "diagram").map((file) => ({ value: file.path, label: file.path }))} onChange={(value) => setWorkspacePrimaryDiagram(value || "")} /></label>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><Button onClick={() => { void (async () => { try { setWorkspaceError(""); const response = await fetch("/api/workspace/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: workspaceName, rootPath: workspaceRootPath }) }); const result = await response.json() as { error?: string; files?: WorkspaceFile[]; workspace?: ProjectWorkspace }; if (!response.ok || !result.workspace) throw new Error(result.error || "目录扫描失败"); setWorkspaceFiles(result.files || []); if (projectWorkspace?.rootPath === result.workspace.rootPath && projectWorkspace.primaryDiagram) setWorkspacePrimaryDiagram(projectWorkspace.primaryDiagram); else setWorkspacePrimaryDiagram(""); } catch (error) { setWorkspaceError(error instanceof Error ? error.message : String(error)); } })(); }}>验证目录并扫描文件</Button><Button type="primary" loading={workspaceSaving} disabled={!workspaceName.trim() || !workspaceRootPath.trim()} onClick={() => void saveProjectWorkspace()}>保存并进入 Studio</Button></div>
          <small style={{ color: "var(--muted, #667085)" }}>配置文件：~/.architecture-diagram-studio/data/project-workspace.json。Agent/MCP 通过服务端接口访问工作区，不依赖浏览器 localStorage。</small>
        </div>
      </Modal>
      <Modal title="服务端版本历史" open={versionHistoryOpen} onCancel={() => setVersionHistoryOpen(false)} footer={null} width={760}>
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          {versionHistoryLoading ? <p>正在加载版本历史…</p> : versionEntries.length === 0 ? <p>服务端还没有保存版本。</p> : [...versionEntries].reverse().map((version) => (
            <div key={version.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 0", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
              <div style={{ minWidth: 0 }}>
                <strong>{version.title || "未命名图形"} · {version.label}</strong>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>{new Date(version.createdAt).toLocaleString()} · {version.id}</div>
              </div>
              <UiButton type="button" className="button button-secondary" onClick={() => void restoreVersion(version.id)}>恢复</UiButton>
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
        <div className="document-breadcrumb"><span className="crumb-muted">{projectWorkspace?.name || "WORKSPACE"}</span><span>/</span><strong>{document.title}</strong><span className="save-state"><i />已保存 · r{revision}</span></div>
        <nav className="workspace-nav" aria-label="工作区页面">
          {([["studio", "Studio"], ["copilot", "Layout Copilot"], ["traces", "Agent 轨迹"], ["settings", "配置"]] as Array<[WorkspacePage, string]>).map(([page, label]) =>
            <UiButton key={page} type="button" className={activePage === page ? "active" : ""} aria-current={activePage === page ? "page" : undefined} onClick={() => openPage(page)}>{label}{page === "traces" && traceEntries.some((entry) => entry.level === "error") && <i className="nav-error-dot" />}</UiButton>
          )}
        </nav>
        <label className="theme-selector" title="切换整个工作界面的配色">
          <span aria-hidden="true">◐</span>
          <UiSelect value={uiTheme} aria-label="界面配色主题" onChange={(event) => setUiTheme(event.target.value as UiTheme)}>
            <option value="editorial">经典编辑室</option>
            <option value="youth">青春鲜艳</option>
            <option value="warm">暖色纸感</option>
            <option value="midnight">午夜深色</option>
          </UiSelect>
        </label>
        <UiInput ref={importFileRef} className="file-input-hidden" type="file" accept=".drawio,.xml,application/xml,text/xml" onChange={(event) => void importDiagramFile(event.target.files?.[0])} />
        {activePage === "studio" ? <div className="topbar-actions">
          <UiButton className="button button-quiet" disabled={!canUndo || Boolean(previewDocument)} onClick={undoDocument}>撤销</UiButton>
          <UiButton className="button button-quiet" disabled={!canRedo || Boolean(previewDocument)} onClick={redoDocument}>重做</UiButton>
          <UiButton className="button button-quiet" onClick={resetDiagram}>重置示例</UiButton>
          <UiButton className="button button-secondary" onClick={() => importFileRef.current?.click()}><span className="button-icon">↑</span>导入 .drawio</UiButton>
          <UiButton className="button button-secondary" onClick={exportDiagram} disabled={Boolean(previewDocument)}><span className="button-icon">↓</span>导出 .drawio</UiButton>
          <UiButton className="button button-secondary" onClick={() => void openVersionHistory()}>版本历史</UiButton>
          <UiButton className="button button-primary" disabled={Boolean(previewDocument)} onClick={() => setViewMode(viewMode === "studio" ? "drawio" : "studio")}><span className="button-icon">◇</span>{viewMode === "studio" ? "原生 Draw.io" : "Studio 画布"}</UiButton>
        </div> : <div className="topbar-actions"><UiButton className="button button-secondary" type="button" onClick={() => openPage("studio")}>返回画布</UiButton></div>}
      </header>

      {activePage === "studio" ? (
        <>
      <aside className="left-panel">
        <div className="workspace-label">DIAGRAM WORKSPACE</div>
        {projectWorkspace && <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--muted, #667085)", overflowWrap: "anywhere" }} title={projectWorkspace.rootPath}><strong>{projectWorkspace.name}</strong><br />{projectWorkspace.rootPath}<br /><button type="button" style={{ marginTop: 6, cursor: "pointer" }} onClick={() => setWorkspaceSetupOpen(true)}>切换工作区</button></div>}
        <div className="side-section">
          <div className="section-heading">图形类型 <span>03</span></div>
          <UiButton className={"diagram-kind " + (document.kind === "c4" ? "active" : "")} onClick={() => changeKind("c4")}>
            <span className="kind-icon kind-c4"><i /><i /><i /></span><span><b>C4 架构图</b><small>Context · Container · Component</small></span><span className="kind-arrow">↗</span>
          </UiButton>
          <UiButton className={"diagram-kind " + (document.kind === "flowchart" ? "active" : "")} onClick={() => changeKind("flowchart")}>
            <span className="kind-icon kind-flow"><i /><i /><i /></span><span><b>业务流程图</b><small>主路径 · 分支 · 合并</small></span><span className="kind-arrow">↗</span>
          </UiButton>
          <UiButton className={"diagram-kind " + (document.kind === "sequence" ? "active" : "")} onClick={() => changeKind("sequence")}>
            <span className="kind-icon kind-sequence"><i /><i /></span><span><b>时序图</b><small>Participant · Message · Return</small></span><span className="kind-arrow">↗</span>
          </UiButton>
        </div>

        <div className="side-section components-section">
          <div className="section-heading">添加元素 <span>+</span></div>
          <div className="add-grid">
            <UiButton onClick={() => addNode("ui")}><span className="add-glyph">▱</span>界面 / UI</UiButton>
            <UiButton onClick={() => addNode("domain")}><span className="add-glyph">▰</span>业务服务</UiButton>
            <UiButton onClick={() => addNode("storage")}><span className="add-glyph">▤</span>数据库</UiButton>
            <UiButton onClick={() => addNode("external")}><span className="add-glyph">↗</span>外部系统</UiButton>
            <UiButton onClick={() => addNode("infra")}><span className="add-glyph">⌘</span>基础设施</UiButton>
            <UiButton onClick={() => addNode("decision")}><span className="add-glyph">◇</span>判断 / 分支</UiButton>
          </div>
        </div>

        <div className="side-bottom">
          <div className="offline-card"><span className="local-indicator" /><div><b>Local-first workspace</b><small>布局、质量检查与导出在本地执行</small></div></div>
          <div className="v1-note">V2 · independent implementation</div>
        </div>
      </aside>

      <main className="main-panel">
        <div className="canvas-toolbar">
          <div>
            <div className="canvas-kicker">{document.kind === "c4" ? "SYSTEM ARCHITECTURE" : document.kind === "flowchart" ? "PROCESS DESIGN" : "INTERACTION DESIGN"} <span>/</span> STUDIO EDITORIAL</div>
            <div className="canvas-title">{visibleDocument.title}<span className="canvas-subtitle">V2 semantic canvas</span>{previewDocument && <span className="preview-pill">PREVIEW</span>}</div>
          </div>
          <div className="canvas-tools">
            {previewDocument && <div className="preview-toolbar-actions">
              <UiButton type="button" className="preview-discard" onClick={discardPreview}>丢弃预览</UiButton>
              <UiButton type="button" className="preview-accept" onClick={acceptPreview}>应用修改</UiButton>
            </div>}
            {document.kind === "sequence" && <UiButton className="toolbar-button" onClick={addSequenceFragment} disabled={Boolean(previewDocument)}>＋ 时序片段</UiButton>}
            <label className="layout-profile-control" title="选择自动布局算法">
              <span>算法</span>
              <UiSelect className="text-field" aria-label="自动布局算法" value={LAYOUT_PROFILES.some((profile) => profile.value === document.layout.profile) ? document.layout.profile : "elk-layered"}
                disabled={isLayoutting || Boolean(previewDocument) || document.kind === "sequence"}
                onChange={(event) => {
                  const next = { ...document, layout: { ...document.layout, profile: event.target.value } };
                  void runLayout(next);
                }}>
                {LAYOUT_PROFILES.map((profile) => <option key={profile.value} value={profile.value}>{profile.label}</option>)}
              </UiSelect>
            </label>
            <label className="layout-profile-control" title="设置图的主方向">
              <span>方向</span>
              <UiSelect className="text-field" aria-label="布局方向" value={document.layout.direction}
                disabled={isLayoutting || Boolean(previewDocument) || document.kind === "sequence"}
                onChange={(event) => {
                  const next = { ...document, layout: { ...document.layout, direction: event.target.value as DiagramDocument["layout"]["direction"] } };
                  void runLayout(next);
                }}>
                <option value="RIGHT">横向 · 左→右</option>
                <option value="DOWN">纵向 · 上→下</option>
              </UiSelect>
            </label>
            <UiButton className="toolbar-button" onClick={() => void runLayout()} disabled={isLayoutting || Boolean(previewDocument)}><span>{isLayoutting ? <i className="spinner" /> : "⌁"}</span>{isLayoutting ? "计算中…" : "自动排版"}</UiButton>
            <div className="segmented"><UiButton disabled={Boolean(previewDocument)} className={viewMode === "studio" ? "selected" : ""} onClick={() => setViewMode("studio")}>Studio</UiButton><UiButton disabled={Boolean(previewDocument)} className={viewMode === "drawio" ? "selected" : ""} onClick={() => setViewMode("drawio")}>Draw.io</UiButton></div>
            <UiButton className="toolbar-button" type="button" title="在独立页面并排比较 Studio 与真实 Draw.io embed 渲染" onClick={() => window.open("/drawio-lab", "_blank", "noopener,noreferrer")}>渲染实验 ↗</UiButton>
          </div>
        </div>

        <div className={"canvas-stage " + (viewMode === "drawio" ? "native-mode" : "")}>
          {viewMode === "studio" ? (
            <DiagramCanvas document={visibleDocument} zoom={studioZoom} viewResetToken={canvasViewResetToken} selectedNodeId={selectedNodeId}
              selectedRelationId={selectedRelationId} onSelectNode={selectNode} onSelectRelation={selectRelation}
              onMoveNode={(id, x, y) => {
                const moved = moveNode(visibleDocument, id, x, y);
                if (previewDocument) {
                  setPreviewDocument(moved);
                  setPreviewSummary((summary) => summary ? summary + "；预览中手动调整了节点位置" : "预览中手动调整了节点位置");
                } else {
                  commitDocument(moved, "已手动移动节点；该位置已锁定");
                }
              }} />
          ) : (
            <DrawioFrame document={document} xml={drawioXml} onDocumentChange={(next, nativeXml) => commitDocument(next, "已从原生 Draw.io 同步修改", nativeXml)} />
          )}
          <div className="canvas-stage-footer"><span><i className="canvas-dot" />{viewMode === "studio" ? "Studio semantic preview" : "Local Draw.io editor"}</span><span>拖动画布空白处可平移 · 拖动节点可调整位置 · 自动排版会尊重锁定节点</span></div>
          {viewMode === "studio" && <div className="zoom-indicator">
            <UiButton type="button" className="zoom-control" aria-label="缩小" disabled={studioZoom <= 0.5} onClick={() => setStudioZoom((zoom) => Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10))}>−</UiButton>
            <UiButton type="button" className="zoom-percent" aria-label="重置画布视图" title="重置平移与缩放" onClick={() => { setStudioZoom(1); setCanvasViewResetToken((value) => value + 1); }}>{Math.round(studioZoom * 100)}%</UiButton>
            <UiButton type="button" className="zoom-control" aria-label="放大" disabled={studioZoom >= 1.8} onClick={() => setStudioZoom((zoom) => Math.min(1.8, Math.round((zoom + 0.1) * 10) / 10))}>＋</UiButton>
          </div>}
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right"><span>{visibleDocument.nodes.length} nodes</span><span>{visibleDocument.relations.length} relations</span><span>Profile: {visibleDocument.layout.profile}</span><span>Layout: {document.layout.profile || "elk-layered"}</span></div></div>
      </main>

      <aside className="right-panel">
        <div className="right-tabs" role="tablist" aria-label="右侧检查面板">
          {([["properties", "属性"], ["quality", "设计质量"], ["design", "样式规则"]] as Array<[typeof rightPanelTab, string]>).map(([tab, label]) =>
            <UiButton key={tab} type="button" role="tab" aria-selected={rightPanelTab === tab}
              className={"right-tab" + (rightPanelTab === tab ? " active" : "")}
              onClick={() => setRightPanelTab(tab)}>{label}</UiButton>
          )}
        </div>
        {rightPanelTab === "properties" && <section className="inspector-section">
          <div className="panel-section-heading"><span>SELECTED ELEMENT</span><span className="small-icon">⌗</span></div>
          {selectedRelation && (
            <div className="inspector-form selected-relation-inspector">
              <div className="field-label">已选中关系线 · 源节点</div>
              <UiSelect className="text-field" aria-label="关系线源节点" value={selectedRelation.source}
                onChange={(event) => changeRelationEndpoints(selectedRelation.id, event.target.value, selectedRelation.target)}>
                {document.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
              </UiSelect>
              <div className="field-label">目标节点</div>
              <UiSelect className="text-field" aria-label="关系线目标节点" value={selectedRelation.target}
                onChange={(event) => changeRelationEndpoints(selectedRelation.id, selectedRelation.source, event.target.value)}>
                {document.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
              </UiSelect>
              <div className="field-label">关系标签</div>
              <UiInput className="text-field" aria-label="关系线标签" value={relationLabelDrafts[selectedRelation.id] ?? selectedRelation.label}
                onChange={(event) => setRelationLabelDrafts((drafts) => ({ ...drafts, [selectedRelation.id]: event.target.value }))}
                onBlur={() => commitRelationLabel(selectedRelation.id)} />
              <div className="relation-actions">
                <UiButton type="button" onClick={() => reverseRelation(selectedRelation.id)}>↔ 反转方向</UiButton>
                <UiButton type="button" onClick={() => removeRelation(selectedRelation.id)}>删除关系</UiButton>
              </div>
            </div>
          )}
          {selectedNode && !selectedRelation ? (
            <div className="inspector-form">
              <div className="field-label">名称</div><UiInput key={selectedNode.id + ":" + selectedNode.name} className="text-field" defaultValue={selectedNode.name} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.name) changeNode({ name: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">语义角色</div>
              <UiSelect className="text-field" value={selectedNode.role} onChange={(event) => changeNode({ role: event.target.value as DiagramNode["role"] })}>
                {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
              </UiSelect>
              <div className="field-label">技术 / 平台</div><UiInput key={selectedNode.id + ":" + (selectedNode.technology || "")} className="text-field" defaultValue={selectedNode.technology || ""} placeholder="例如：Java / Spring" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.technology || "")) changeNode({ technology: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">描述</div><UiTextArea key={selectedNode.id + ":" + (selectedNode.description || "")} className="text-field text-area" defaultValue={selectedNode.description || ""} placeholder="此组件的职责…" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.description || "")) changeNode({ description: event.currentTarget.value }); }} rows={2} />
              <label className="lock-row"><UiInput type="checkbox" checked={Boolean(selectedNode.layoutHints?.locked)} onChange={(event) => changeNode({ layoutHints: { ...(selectedNode.layoutHints || {}), locked: event.target.checked } })} /><span><b>锁定当前位置</b><small>重排时保留此节点位置</small></span></label>
              <div className="relation-editor">
                <div className="field-label">建立关系（当前节点 → 目标）</div>
                <UiSelect className="text-field" value={relationTargetId} onChange={(event) => setRelationTargetId(event.target.value)}>
                  <option value="">选择目标节点…</option>
                  {document.nodes.filter((node) => node.id !== selectedNode.id).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                </UiSelect>
                <UiInput className="text-field relation-label-field" value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} placeholder="关系说明（可选）" />
                <UiButton className="relation-add-button" onClick={addRelation} disabled={!relationTargetId || relationTargetId === selectedNode.id}>＋ 添加关系</UiButton>
              </div>
              <div className="connected-relations">
                <div className="field-label">关联关系（{document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).length}）</div>
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
                      placeholder="关系标签…"
                      onChange={(event) => setRelationLabelDrafts((drafts) => ({ ...drafts, [relation.id]: event.target.value }))}
                      onBlur={() => commitRelationLabel(relation.id)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
                    />
                    <div className="relation-style-controls">
                      <label>路由
                        <UiSelect disabled={document.kind === "sequence"} value={relation.routing || "inherit"} onChange={(event) => {
                          const value = event.target.value;
                          updateRelationStyle(relation.id, { routing: value === "inherit" ? undefined : value as "orthogonal" | "polyline" | "curved" });
                        }}>
                          <option value="inherit">默认</option>
                          <option value="orthogonal">直角折线</option>
                          <option value="polyline">折线</option>
                          <option value="curved">曲线</option>
                        </UiSelect>
                      </label>
                      <label>线型
                        <UiSelect value={relation.dashed === undefined ? "inherit" : relation.dashed ? "dashed" : "solid"} onChange={(event) => {
                          const value = event.target.value;
                          updateRelationStyle(relation.id, { dashed: value === "inherit" ? undefined : value === "dashed" });
                        }}>
                          <option value="inherit">默认</option>
                          <option value="solid">实线</option>
                          <option value="dashed">虚线</option>
                        </UiSelect>
                      </label>
                    </div>
                    <div className="relation-actions">
                      <UiButton type="button" title="反转方向" onClick={() => reverseRelation(relation.id)}>↔ 方向</UiButton>
                      <UiButton type="button" title="删除关系" onClick={() => removeRelation(relation.id)}>删除</UiButton>
                    </div>
                  </div>
                ))}
                {document.relations.every((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id) && <div className="empty-relations">当前元素没有关联线。</div>}
              </div>
              {document.kind === "sequence" && (document.sequence?.fragments || []).length > 0 && <div className="sequence-fragment-editor">
                <div className="field-label">时序片段（alt / opt / loop）</div>
                {(document.sequence?.fragments || []).map((fragment) => (
                  <div className="sequence-fragment-card" key={fragment.id}>
                    <UiSelect value={fragment.kind} onChange={(event) => updateSequenceFragment(fragment.id, { kind: event.target.value as SequenceFragment["kind"] })}>
                      <option value="alt">alt · 条件分支</option>
                      <option value="opt">opt · 可选</option>
                      <option value="loop">loop · 循环</option>
                    </UiSelect>
                    <UiInput key={fragment.id + ":" + fragment.label} className="text-field" defaultValue={fragment.label} placeholder="片段说明" onBlur={(event) => {
                      if (event.currentTarget.value !== fragment.label) updateSequenceFragment(fragment.id, { label: event.currentTarget.value });
                    }} />
                    <div className="sequence-fragment-range">
                      <label>起始消息<UiInput key={fragment.id + ":start:" + fragment.startOrder} type="number" min="0" max={Math.max(0, document.relations.length - 1)} defaultValue={fragment.startOrder} onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isFinite(value) && value !== fragment.startOrder) updateSequenceFragment(fragment.id, { startOrder: value });
                      }} /></label>
                      <label>结束消息<UiInput key={fragment.id + ":end:" + fragment.endOrder} type="number" min="0" max={Math.max(0, document.relations.length - 1)} defaultValue={fragment.endOrder} onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isFinite(value) && value !== fragment.endOrder) updateSequenceFragment(fragment.id, { endOrder: value });
                      }} /></label>
                    </div>
                    <UiButton type="button" className="sequence-fragment-remove" onClick={() => removeSequenceFragment(fragment.id)}>删除片段</UiButton>
                  </div>
                ))}
              </div>}
              <UiButton className="delete-node-button" onClick={removeSelectedNode}>删除此元素</UiButton>
            </div>
          ) : !selectedRelation ? <div className="empty-inspector">选择画布中的节点或关系线以查看属性。</div> : null}
        </section>}
        {rightPanelTab === "quality" && <section className="quality-section">
          <div className="panel-section-heading"><span>LAYOUT QUALITY</span><span className="quality-score">{quality.score}</span></div>
          <div className="quality-score-line"><div><strong>{quality.score >= 85 ? "布局状态良好" : quality.metrics.nodeOverlaps ? "需要修复重叠" : "建议检查连线"}</strong><small>确定性质量检查 · 非主观模型评分</small></div><div className="quality-ring" style={{ "--score": quality.score } as CSSProperties}><span>{quality.score}</span></div></div>
          <div className="metric-grid">
            <div className={quality.metrics.nodeOverlaps ? "metric bad" : "metric"}><strong>{quality.metrics.nodeOverlaps}</strong><span>节点重叠</span></div>
            <div className={quality.metrics.edgeNodeIntersections ? "metric bad" : "metric"}><strong>{quality.metrics.edgeNodeIntersections}</strong><span>线穿过节点</span></div>
            <div className={quality.metrics.edgeCrossings ? "metric warn" : "metric"}><strong>{quality.metrics.edgeCrossings}</strong><span>可能交叉</span></div>
            <div className="metric"><strong>{Math.round(quality.metrics.whitespaceScore * 100)}%</strong><span>留白分数</span></div>
          </div>
          <div className="quality-footnote">{quality.errors.length ? quality.errors[0].message : quality.warnings.length ? quality.warnings[0].message : "无节点重叠。质量检查持续评估线条交叉和留白。"}</div>
        </section>}
        {rightPanelTab === "design" && <section className="design-section">
          <div className="panel-section-heading"><span>STYLE RULES</span><span className="small-icon">◌</span></div>
          <div className="style-rule"><span className="style-rule-mark mark-solid" /><div><b>低对比边界</b><small>1px · neutral surface</small></div></div>
          <div className="style-rule"><span className="style-rule-mark mark-flow" /><div><b>克制的语义色</b><small>颜色表达职责，不随机分配</small></div></div>
          <div className="style-rule"><span className="style-rule-mark mark-spacing" /><div><b>结构化留白</b><small>{document.layout.nodeSpacing}px node · {document.layout.layerSpacing}px layer</small></div></div>
        </section>}
      </aside>
        </>
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
        />
      )}
    </Layout>
        </AntApp>
      </XProvider>
    </ConfigProvider>
  );
}