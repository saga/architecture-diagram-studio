import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { isDiagramDocument } from "./model/types";
import type { DiagramDocument, DiagramKind, DiagramNode, SequenceFragment, VisualRole } from "./model/types";
import { FIXTURES } from "./model/fixtures";
import { layoutDiagram, moveNode } from "./layout/layout";
import { evaluateLayout } from "./layout/quality";
import { applyIntent } from "./intent/applyIntent";
import { requestAIIntentPlan } from "./intent/aiProvider";
import { normalizeSequenceDocument } from "./layout/sequence";
import { downloadText, toDrawioXml } from "./export/drawio";
import { fromDrawioXml } from "./import/drawio";
import { roleLabels } from "./design/tokens";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";
import WorkspacePages, { type WorkspacePage } from "./components/WorkspacePages";
import { clearDiagnosticEntries, readDiagnosticEntries, recordDiagnostic } from "./diagnostics";
import type { DiagnosticEntry } from "./diagnostics";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type SavedAISettings = { baseUrl: string; model: string };
function loadSavedAISettings(): SavedAISettings {
  try {
    const saved = window.localStorage.getItem("architecture-diagram-studio:v2:ai-provider");
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<SavedAISettings>;
      return { baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "", model: typeof parsed.model === "string" ? parsed.model : "" };
    }
  } catch {
    // The page can still use deterministic local rules when browser storage is unavailable.
  }
  return { baseUrl: "", model: "" };
}
function newId(prefix: string): string { return prefix + "-" + Math.random().toString(36).slice(2, 8); }

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
  const [viewMode, setViewMode] = useState<"studio" | "drawio">("studio");
  const [activePage, setActivePage] = useState<WorkspacePage>("studio");
  const [traceEntries, setTraceEntries] = useState<DiagnosticEntry[]>(() => readDiagnosticEntries());
  const [drawioStatus, setDrawioStatus] = useState<"unknown" | "checking" | "ready" | "missing" | "error">("unknown");
  const [drawioStatusMessage, setDrawioStatusMessage] = useState("");
  const [studioZoom, setStudioZoom] = useState(1);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [savedAISettings] = useState<SavedAISettings>(() => loadSavedAISettings());
  const [aiBaseUrl, setAiBaseUrl] = useState(savedAISettings.baseUrl);
  const [aiModel, setAiModel] = useState(savedAISettings.model);
  const [aiApiKey, setAiApiKey] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", id: 1, text: "描述想要的布局变化即可，例如「所有 external 移到右侧」「数据库放到底部」或「所有连线改成直角折线」。未配置模型时使用本地规则；配置后会把请求转换为受限的布局指令，并先生成预览供确认。" }
  ]);
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
  const quality = useMemo(() => evaluateLayout(visibleDocument), [visibleDocument]);
  const generatedDrawioXml = useMemo(() => toDrawioXml(document), [document]);
  const [nativeXmlOverride, setNativeXmlOverride] = useState<string | null>(null);
  const drawioXml = nativeXmlOverride ?? generatedDrawioXml;

  useEffect(() => {
    const refreshTraces = () => setTraceEntries(readDiagnosticEntries());
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
    let active = true;
    const startedAt = Date.now();
    recordDiagnostic("layout.initial.start", "启动时运行本地布局", {
      diagramKind: document.kind, nodeCount: document.nodes.length, relationCount: document.relations.length
    });
    layoutDiagram(document).then((laidOut) => {
      if (!active) return;
      setDocument(laidOut);
      historyRef.current = [laidOut];
      historyIndexRef.current = 0;
      setCanUndo(false);
      setCanRedo(false);
      recordDiagnostic("layout.initial.completed", "启动布局完成", {
        durationMs: Date.now() - startedAt, nodeCount: laidOut.nodes.length, relationCount: laidOut.relations.length
      });
    }).catch((error: unknown) => {
      recordDiagnostic("layout.initial.failed", "启动布局失败", {
        durationMs: Date.now() - startedAt, errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
      if (active) setLastAction("布局器异常：" + (error instanceof Error ? error.message : String(error)));
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:document", JSON.stringify(document));
    } catch {
      setLastAction("浏览器存储不可用；本次会话仍可继续编辑");
    }
  }, [document]);

  const commitDocument = useCallback((next: DiagramDocument, action: string, preservedNativeXml?: string) => {
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
      const next = await layoutDiagram(source);
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
    const next = FIXTURES[kind]();
    setSelectedNodeId(next.nodes[0]?.id || null);
    setViewMode("studio");
    commitDocument(next, "切换到 " + (kind === "c4" ? "C4 架构图" : kind === "sequence" ? "时序图" : "流程图"));
    void runLayout(next);
  }

  async function sendIntent() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const startedAt = Date.now();
    recordDiagnostic("copilot.request.started", "开始处理布局意图", {
      configuredModel: Boolean(aiBaseUrl.trim() && aiModel.trim()), model: aiModel.trim() || "local-rules",
      diagramKind: document.kind, nodeCount: document.nodes.length, relationCount: document.relations.length,
      inputLength: text.length
    });
    setMessages((items) => [...items, { role: "user", id: Date.now(), text }]);
    setChatInput("");
    setChatBusy(true);
    try {
      let effectiveText = text;
      let modelReply = "";
      if (aiBaseUrl.trim() && aiModel.trim()) {
        recordDiagnostic("copilot.model.request", "请求兼容模型生成受限布局计划", {
          model: aiModel.trim(), baseUrlConfigured: true, inputLength: text.length, nodeCount: Math.min(document.nodes.length, 80)
        });
        const plan = await requestAIIntentPlan(
          { baseUrl: aiBaseUrl, model: aiModel, apiKey: aiApiKey },
          text,
          {
            kind: document.kind,
            title: document.title,
            selectedNode: selectedNode ? { id: selectedNode.id, name: selectedNode.name, role: selectedNode.role } : null,
            nodes: document.nodes.slice(0, 80).map((node) => ({ id: node.id, name: node.name, role: node.role }))
          }
        );
        modelReply = plan.reply;
        recordDiagnostic("copilot.model.response", "已收到模型布局计划", {
          model: aiModel.trim(), commandCount: plan.commands.length, replyLength: plan.reply.length
        });
        if (!plan.commands.length) {
          recordDiagnostic("copilot.plan.empty", "模型未返回可执行布局指令，未修改正式文档", {}, "warn");
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: "未执行修改。 " + (modelReply || "这个请求没有匹配到当前支持的安全布局操作。") }]);
          return;
        }
        effectiveText = plan.commands.join("；");
      }
      const result = await applyIntent(document, effectiveText);
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
        detailRecordedByProvider: Boolean(aiBaseUrl.trim() && aiModel.trim())
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
    const next = { baseUrl: aiBaseUrl.trim().replace(/\/+$/, ""), model: aiModel.trim() };
    setAiBaseUrl(next.baseUrl);
    setAiModel(next.model);
    let saved = true;
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:ai-provider", JSON.stringify(next));
    } catch {
      saved = false;
      setLastAction("无法保存模型接口设置；当前页面仍可使用已输入的配置");
    }
    recordDiagnostic("settings.model.saved", saved ? "模型接口配置已保存" : "模型接口配置无法写入浏览器存储", {
      baseUrlConfigured: Boolean(next.baseUrl), model: next.model || "local-rules", apiKeyPresent: Boolean(aiApiKey), persisted: saved
    }, saved ? "info" : "warn");
    if (saved) setLastAction(next.baseUrl && next.model ? "模型接口配置已保存" : "已切回本地规则模式");
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
      width: role === "actor" ? 154 : 190, height: role === "decision" ? 84 : 82, layoutHints: {}
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
      const next = await layoutDiagram(parsed);
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

  function clearTraces() {
    clearDiagnosticEntries();
    setTraceEntries([]);
    recordDiagnostic("trace.cleared", "已清空本地轨迹");
    setTraceEntries(readDiagnosticEntries());
  }

  function openPage(page: WorkspacePage) {
    setActivePage(page);
    recordDiagnostic("navigation.opened", "打开工作区页面", { page });
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><i /><i /><i /><i /></div>
          <div><div className="brand-name">FORM <span>STUDIO</span></div><div className="brand-caption">ARCHITECTURE DIAGRAMS</div></div>
        </div>
        <div className="topbar-divider" />
        <div className="document-breadcrumb"><span className="crumb-muted">WORKSPACE</span><span>/</span><strong>{document.title}</strong><span className="save-state"><i />已保存 · r{revision}</span></div>
        <nav className="workspace-nav" aria-label="工作区页面">
          {([["studio", "Studio"], ["copilot", "Layout Copilot"], ["traces", "Agent 轨迹"], ["settings", "配置"]] as Array<[WorkspacePage, string]>).map(([page, label]) =>
            <button key={page} type="button" className={activePage === page ? "active" : ""} aria-current={activePage === page ? "page" : undefined} onClick={() => openPage(page)}>{label}{page === "traces" && traceEntries.some((entry) => entry.level === "error") && <i className="nav-error-dot" />}</button>
          )}
        </nav>
        <input ref={importFileRef} className="file-input-hidden" type="file" accept=".drawio,.xml,application/xml,text/xml" onChange={(event) => void importDiagramFile(event.target.files?.[0])} />
        {activePage === "studio" ? <div className="topbar-actions">
          <button className="button button-quiet" disabled={!canUndo || Boolean(previewDocument)} onClick={undoDocument}>撤销</button>
          <button className="button button-quiet" disabled={!canRedo || Boolean(previewDocument)} onClick={redoDocument}>重做</button>
          <button className="button button-quiet" onClick={resetDiagram}>重置示例</button>
          <button className="button button-secondary" onClick={() => importFileRef.current?.click()}><span className="button-icon">↑</span>导入 .drawio</button>
          <button className="button button-secondary" onClick={exportDiagram} disabled={Boolean(previewDocument)}><span className="button-icon">↓</span>导出 .drawio</button>
          <button className="button button-primary" disabled={Boolean(previewDocument)} onClick={() => setViewMode(viewMode === "studio" ? "drawio" : "studio")}><span className="button-icon">◇</span>{viewMode === "studio" ? "原生 Draw.io" : "Studio 画布"}</button>
        </div> : <div className="topbar-actions"><button className="button button-secondary" type="button" onClick={() => openPage("studio")}>返回画布</button></div>}
      </header>

      {activePage === "studio" ? (
        <>
      <aside className="left-panel">
        <div className="workspace-label">DIAGRAM WORKSPACE</div>
        <div className="side-section">
          <div className="section-heading">图形类型 <span>03</span></div>
          <button className={"diagram-kind " + (document.kind === "c4" ? "active" : "")} onClick={() => changeKind("c4")}>
            <span className="kind-icon kind-c4"><i /><i /><i /></span><span><b>C4 架构图</b><small>Context · Container · Component</small></span><span className="kind-arrow">↗</span>
          </button>
          <button className={"diagram-kind " + (document.kind === "flowchart" ? "active" : "")} onClick={() => changeKind("flowchart")}>
            <span className="kind-icon kind-flow"><i /><i /><i /></span><span><b>业务流程图</b><small>主路径 · 分支 · 合并</small></span><span className="kind-arrow">↗</span>
          </button>
          <button className={"diagram-kind " + (document.kind === "sequence" ? "active" : "")} onClick={() => changeKind("sequence")}>
            <span className="kind-icon kind-sequence"><i /><i /></span><span><b>时序图</b><small>Participant · Message · Return</small></span><span className="kind-arrow">↗</span>
          </button>
        </div>

        <div className="side-section components-section">
          <div className="section-heading">添加元素 <span>+</span></div>
          <div className="add-grid">
            <button onClick={() => addNode("ui")}><span className="add-glyph">▱</span>界面 / UI</button>
            <button onClick={() => addNode("domain")}><span className="add-glyph">▰</span>业务服务</button>
            <button onClick={() => addNode("storage")}><span className="add-glyph">▤</span>数据库</button>
            <button onClick={() => addNode("external")}><span className="add-glyph">↗</span>外部系统</button>
            <button onClick={() => addNode("infra")}><span className="add-glyph">⌘</span>基础设施</button>
            <button onClick={() => addNode("decision")}><span className="add-glyph">◇</span>判断 / 分支</button>
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
              <button type="button" className="preview-discard" onClick={discardPreview}>丢弃预览</button>
              <button type="button" className="preview-accept" onClick={acceptPreview}>应用修改</button>
            </div>}
            {document.kind === "sequence" && <button className="toolbar-button" onClick={addSequenceFragment} disabled={Boolean(previewDocument)}>＋ 时序片段</button>}
            <button className="toolbar-button" onClick={() => void runLayout()} disabled={isLayoutting || Boolean(previewDocument)}><span>{isLayoutting ? <i className="spinner" /> : "⌁"}</span>{isLayoutting ? "计算中…" : "自动排版"}</button>
            <div className="segmented"><button disabled={Boolean(previewDocument)} className={viewMode === "studio" ? "selected" : ""} onClick={() => setViewMode("studio")}>Studio</button><button disabled={Boolean(previewDocument)} className={viewMode === "drawio" ? "selected" : ""} onClick={() => setViewMode("drawio")}>Draw.io</button></div>
          </div>
        </div>

        <div className={"canvas-stage " + (viewMode === "drawio" ? "native-mode" : "")}>
          {viewMode === "studio" ? (
            <DiagramCanvas document={visibleDocument} zoom={studioZoom} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId}
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
          <div className="canvas-stage-footer"><span><i className="canvas-dot" />{viewMode === "studio" ? "Studio semantic preview" : "Local Draw.io editor"}</span><span>拖动节点可调整位置 · 自动排版会尊重锁定节点</span></div>
          {viewMode === "studio" && <div className="zoom-indicator">
            <button type="button" className="zoom-control" aria-label="缩小" disabled={studioZoom <= 0.5} onClick={() => setStudioZoom((zoom) => Math.max(0.5, Math.round((zoom - 0.1) * 10) / 10))}>−</button>
            <button type="button" className="zoom-percent" aria-label="重置缩放" onClick={() => setStudioZoom(1)}>{Math.round(studioZoom * 100)}%</button>
            <button type="button" className="zoom-control" aria-label="放大" disabled={studioZoom >= 1.8} onClick={() => setStudioZoom((zoom) => Math.min(1.8, Math.round((zoom + 0.1) * 10) / 10))}>＋</button>
          </div>}
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right"><span>{visibleDocument.nodes.length} nodes</span><span>{visibleDocument.relations.length} relations</span><span>Profile: {visibleDocument.layout.profile}</span><span>Layout engine: ELK Layered</span></div></div>
      </main>

      <aside className="right-panel">
        <div className="right-tabs"><span className="right-tab active">属性检查</span><span className="right-tab">设计质量</span><span className="right-tab-label">STUDIO</span></div>
        <section className="inspector-section">
          <div className="panel-section-heading"><span>SELECTED ELEMENT</span><span className="small-icon">⌗</span></div>
          {selectedNode ? (
            <div className="inspector-form">
              <div className="field-label">名称</div><input key={selectedNode.id + ":" + selectedNode.name} className="text-field" defaultValue={selectedNode.name} onBlur={(event) => { if (event.currentTarget.value !== selectedNode.name) changeNode({ name: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">语义角色</div>
              <select className="text-field" value={selectedNode.role} onChange={(event) => changeNode({ role: event.target.value as DiagramNode["role"] })}>
                {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
              </select>
              <div className="field-label">技术 / 平台</div><input key={selectedNode.id + ":" + (selectedNode.technology || "")} className="text-field" defaultValue={selectedNode.technology || ""} placeholder="例如：Java / Spring" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.technology || "")) changeNode({ technology: event.currentTarget.value }); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
              <div className="field-label">描述</div><textarea key={selectedNode.id + ":" + (selectedNode.description || "")} className="text-field text-area" defaultValue={selectedNode.description || ""} placeholder="此组件的职责…" onBlur={(event) => { if (event.currentTarget.value !== (selectedNode.description || "")) changeNode({ description: event.currentTarget.value }); }} rows={2} />
              <label className="lock-row"><input type="checkbox" checked={Boolean(selectedNode.layoutHints?.locked)} onChange={(event) => changeNode({ layoutHints: { ...(selectedNode.layoutHints || {}), locked: event.target.checked } })} /><span><b>锁定当前位置</b><small>重排时保留此节点位置</small></span></label>
              <div className="relation-editor">
                <div className="field-label">建立关系（当前节点 → 目标）</div>
                <select className="text-field" value={relationTargetId} onChange={(event) => setRelationTargetId(event.target.value)}>
                  <option value="">选择目标节点…</option>
                  {document.nodes.filter((node) => node.id !== selectedNode.id).map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
                </select>
                <input className="text-field relation-label-field" value={relationLabel} onChange={(event) => setRelationLabel(event.target.value)} placeholder="关系说明（可选）" />
                <button className="relation-add-button" onClick={addRelation} disabled={!relationTargetId || relationTargetId === selectedNode.id}>＋ 添加关系</button>
              </div>
              <div className="connected-relations">
                <div className="field-label">关联关系（{document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).length}）</div>
                {document.relations.filter((relation) => relation.source === selectedNode.id || relation.target === selectedNode.id).map((relation) => (
                  <div className="connected-relation" key={relation.id}>
                    <div className="connected-relation-direction">
                      <span>{document.nodes.find((node) => node.id === relation.source)?.name || relation.source}</span>
                      <span className="relation-arrow">→</span>
                      <span>{document.nodes.find((node) => node.id === relation.target)?.name || relation.target}</span>
                    </div>
                    <input
                      className="text-field relation-label-field"
                      value={relationLabelDrafts[relation.id] ?? relation.label}
                      placeholder="关系标签…"
                      onChange={(event) => setRelationLabelDrafts((drafts) => ({ ...drafts, [relation.id]: event.target.value }))}
                      onBlur={() => commitRelationLabel(relation.id)}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }}
                    />
                    <div className="relation-style-controls">
                      <label>路由
                        <select disabled={document.kind === "sequence"} value={relation.routing || "inherit"} onChange={(event) => {
                          const value = event.target.value;
                          updateRelationStyle(relation.id, { routing: value === "inherit" ? undefined : value as "orthogonal" | "polyline" | "curved" });
                        }}>
                          <option value="inherit">默认</option>
                          <option value="orthogonal">直角折线</option>
                          <option value="polyline">折线</option>
                          <option value="curved">曲线</option>
                        </select>
                      </label>
                      <label>线型
                        <select value={relation.dashed === undefined ? "inherit" : relation.dashed ? "dashed" : "solid"} onChange={(event) => {
                          const value = event.target.value;
                          updateRelationStyle(relation.id, { dashed: value === "inherit" ? undefined : value === "dashed" });
                        }}>
                          <option value="inherit">默认</option>
                          <option value="solid">实线</option>
                          <option value="dashed">虚线</option>
                        </select>
                      </label>
                    </div>
                    <div className="relation-actions">
                      <button type="button" title="反转方向" onClick={() => reverseRelation(relation.id)}>↔ 方向</button>
                      <button type="button" title="删除关系" onClick={() => removeRelation(relation.id)}>删除</button>
                    </div>
                  </div>
                ))}
                {document.relations.every((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id) && <div className="empty-relations">当前元素没有关联线。</div>}
              </div>
              {document.kind === "sequence" && (document.sequence?.fragments || []).length > 0 && <div className="sequence-fragment-editor">
                <div className="field-label">时序片段（alt / opt / loop）</div>
                {(document.sequence?.fragments || []).map((fragment) => (
                  <div className="sequence-fragment-card" key={fragment.id}>
                    <select value={fragment.kind} onChange={(event) => updateSequenceFragment(fragment.id, { kind: event.target.value as SequenceFragment["kind"] })}>
                      <option value="alt">alt · 条件分支</option>
                      <option value="opt">opt · 可选</option>
                      <option value="loop">loop · 循环</option>
                    </select>
                    <input key={fragment.id + ":" + fragment.label} className="text-field" defaultValue={fragment.label} placeholder="片段说明" onBlur={(event) => {
                      if (event.currentTarget.value !== fragment.label) updateSequenceFragment(fragment.id, { label: event.currentTarget.value });
                    }} />
                    <div className="sequence-fragment-range">
                      <label>起始消息<input key={fragment.id + ":start:" + fragment.startOrder} type="number" min="0" max={Math.max(0, document.relations.length - 1)} defaultValue={fragment.startOrder} onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isFinite(value) && value !== fragment.startOrder) updateSequenceFragment(fragment.id, { startOrder: value });
                      }} /></label>
                      <label>结束消息<input key={fragment.id + ":end:" + fragment.endOrder} type="number" min="0" max={Math.max(0, document.relations.length - 1)} defaultValue={fragment.endOrder} onBlur={(event) => {
                        const value = Number(event.currentTarget.value);
                        if (Number.isFinite(value) && value !== fragment.endOrder) updateSequenceFragment(fragment.id, { endOrder: value });
                      }} /></label>
                    </div>
                    <button type="button" className="sequence-fragment-remove" onClick={() => removeSequenceFragment(fragment.id)}>删除片段</button>
                  </div>
                ))}
              </div>}
              <button className="delete-node-button" onClick={removeSelectedNode}>删除此元素</button>
            </div>
          ) : <div className="empty-inspector">选择画布中的节点以查看和编辑其属性。</div>}
        </section>

        <section className="quality-section">
          <div className="panel-section-heading"><span>LAYOUT QUALITY</span><span className="quality-score">{quality.score}</span></div>
          <div className="quality-score-line"><div><strong>{quality.score >= 85 ? "布局状态良好" : quality.metrics.nodeOverlaps ? "需要修复重叠" : "建议检查连线"}</strong><small>确定性质量检查 · 非主观模型评分</small></div><div className="quality-ring" style={{ "--score": quality.score } as CSSProperties}><span>{quality.score}</span></div></div>
          <div className="metric-grid">
            <div className={quality.metrics.nodeOverlaps ? "metric bad" : "metric"}><strong>{quality.metrics.nodeOverlaps}</strong><span>节点重叠</span></div>
            <div className={quality.metrics.edgeNodeIntersections ? "metric bad" : "metric"}><strong>{quality.metrics.edgeNodeIntersections}</strong><span>线穿过节点</span></div>
            <div className={quality.metrics.edgeCrossings ? "metric warn" : "metric"}><strong>{quality.metrics.edgeCrossings}</strong><span>可能交叉</span></div>
            <div className="metric"><strong>{Math.round(quality.metrics.whitespaceScore * 100)}%</strong><span>留白分数</span></div>
          </div>
          <div className="quality-footnote">{quality.errors.length ? quality.errors[0].message : quality.warnings.length ? quality.warnings[0].message : "无节点重叠。质量检查持续评估线条交叉和留白。"}</div>
        </section>

        <section className="design-section">
          <div className="panel-section-heading"><span>STYLE RULES</span><span className="small-icon">◌</span></div>
          <div className="style-rule"><span className="style-rule-mark mark-solid" /><div><b>低对比边界</b><small>1px · neutral surface</small></div></div>
          <div className="style-rule"><span className="style-rule-mark mark-flow" /><div><b>克制的语义色</b><small>颜色表达职责，不随机分配</small></div></div>
          <div className="style-rule"><span className="style-rule-mark mark-spacing" /><div><b>结构化留白</b><small>{document.layout.nodeSpacing}px node · {document.layout.layerSpacing}px layer</small></div></div>
        </section>

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
          aiApiKey={aiApiKey}
          setAiApiKey={setAiApiKey}
          saveAISettings={saveAISettings}
          clearAISettings={clearAISettings}
          traceEntries={traceEntries}
          clearTraces={clearTraces}
          drawioStatus={drawioStatus}
          drawioStatusMessage={drawioStatusMessage}
          checkDrawioStatus={() => void checkDrawioStatus()}
        />
      )}
    </div>
  );
}