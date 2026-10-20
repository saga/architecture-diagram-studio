import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { DiagramDocument, DiagramKind, DiagramNode } from "./model/types";
import { FIXTURES } from "./model/fixtures";
import { layoutDiagram, moveNode } from "./layout/layout";
import { evaluateLayout } from "./layout/quality";
import { applyIntent } from "./intent/applyIntent";
import { requestAIIntentPlan } from "./intent/aiProvider";
import { downloadText, toDrawioXml } from "./export/drawio";
import { fromDrawioXml } from "./import/drawio";
import { roleLabels } from "./design/tokens";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";

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
        const parsed = JSON.parse(saved) as DiagramDocument;
        if (parsed.schemaVersion === 2 && Array.isArray(parsed.nodes) && Array.isArray(parsed.relations) && ["c4", "flowchart", "sequence"].includes(parsed.kind)) return parsed;
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
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [savedAISettings] = useState<SavedAISettings>(() => loadSavedAISettings());
  const [aiBaseUrl, setAiBaseUrl] = useState(savedAISettings.baseUrl);
  const [aiModel, setAiModel] = useState(savedAISettings.model);
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", id: 1, text: "可以直接说布局意图，例如「所有 external 放到右侧」「数据库放底部」「所有线改成虚线」「曲线改成折线」。目前使用本地确定性规则，不会假装已调用云端模型。" }
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
  const chatEndRef = useRef<HTMLDivElement>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  const visibleDocument = previewDocument || document;
  const selectedNode = document.nodes.find((node) => node.id === selectedNodeId) || null;
  const quality = useMemo(() => evaluateLayout(visibleDocument), [visibleDocument]);
  const drawioXml = useMemo(() => toDrawioXml(document), [document]);

  useEffect(() => {
    let active = true;
    layoutDiagram(document).then((laidOut) => {
      if (!active) return;
      setDocument(laidOut);
      historyRef.current = [laidOut];
      historyIndexRef.current = 0;
      setCanUndo(false);
      setCanRedo(false);
    }).catch((error: unknown) => {
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
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages]);

  const commitDocument = useCallback((next: DiagramDocument, action: string) => {
    setPreviewDocument(null);
    setPreviewSummary("");
    const nextHistory = [...historyRef.current.slice(0, historyIndexRef.current + 1), next].slice(-50);
    historyRef.current = nextHistory;
    historyIndexRef.current = nextHistory.length - 1;
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(false);
    setDocument(next);
    setRevision((value) => value + 1);
    setLastAction(action);
  }, []);

  const runLayout = useCallback(async (source: DiagramDocument = document) => {
    setIsLayoutting(true);
    try {
      const next = await layoutDiagram(source);
      commitDocument(next, "已重新计算布局、路由并运行重叠修复");
    } catch (error) {
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
    setDocument(previous);
    setSelectedNodeId((current) => previous.nodes.some((node) => node.id === current) ? current : previous.nodes[0]?.id || null);
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(true);
    setRevision((value) => value + 1);
    setLastAction("已撤销到上一版本");
  }

  function redoDocument() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return;
    historyIndexRef.current += 1;
    const next = historyRef.current[historyIndexRef.current];
    setPreviewDocument(null);
    setPreviewSummary("");
    setDocument(next);
    setSelectedNodeId((current) => next.nodes.some((node) => node.id === current) ? current : next.nodes[0]?.id || null);
    setCanUndo(historyIndexRef.current > 0);
    setCanRedo(historyIndexRef.current < historyRef.current.length - 1);
    setRevision((value) => value + 1);
    setLastAction("已重做到下一版本");
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
    setMessages((items) => [...items, { role: "user", id: Date.now(), text }]);
    setChatInput("");
    setChatBusy(true);
    try {
      let effectiveText = text;
      let modelReply = "";
      if (aiBaseUrl.trim() && aiModel.trim()) {
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
        if (!plan.commands.length) {
          setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: "未执行修改。 " + (modelReply || "这个请求没有匹配到当前支持的安全布局操作。") }]);
          return;
        }
        effectiveText = plan.commands.join("；");
      }
      const result = await applyIntent(document, effectiveText);
      if (result.changed) {
        setPreviewDocument(result.document);
        setPreviewSummary(result.summary);
        setViewMode("studio");
        const previewQuality = evaluateLayout(result.document);
        const prefix = modelReply ? modelReply + " " : "";
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: prefix + result.summary + "。已生成临时预览，布局分数 " + previewQuality.score + "；正式文档尚未改变。请检查画布后应用或丢弃。" }]);
      } else {
        const reply = modelReply
          ? "没有应用任何修改。 " + modelReply + "（模型计划未匹配到可执行的布局操作。）"
          : result.summary;
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: reply }]);
      }
    } catch (error) {
      setMessages((items) => [...items, { role: "assistant", id: Date.now() + 2, text: "没有提交修改：" + (error instanceof Error ? error.message : String(error)) }]);
    } finally {
      setChatBusy(false);
    }
  }

  function saveAISettings() {
    const next = { baseUrl: aiBaseUrl.trim().replace(/\/+$/, ""), model: aiModel.trim() };
    setAiBaseUrl(next.baseUrl);
    setAiModel(next.model);
    try {
      window.localStorage.setItem("architecture-diagram-studio:v2:ai-provider", JSON.stringify(next));
    } catch {
      setLastAction("无法保存模型接口设置；当前页面仍可使用已输入的配置");
    }
    setAiSettingsOpen(false);
    setMessages((items) => [...items, {
      role: "assistant",
      id: Date.now() + 3,
      text: next.baseUrl && next.model
        ? "模型接口已配置。API Key只保存在当前页面内存，不会写入浏览器存储。"
        : "已切回本地规则模式；未配置的模型接口不会被调用。"
    }]);
  }

  function clearAISettings() {
    setAiBaseUrl("");
    setAiModel("");
    setAiApiKey("");
    try { window.localStorage.removeItem("architecture-diagram-studio:v2:ai-provider"); } catch { /* Ignore unavailable storage. */ }
    setAiSettingsOpen(false);
    setLastAction("已切回本地规则模式");
  }

  function changeNode(patch: Partial<DiagramNode>) {
    if (!selectedNode) return;
    const next = {
      ...document,
      nodes: document.nodes.map((node) => node.id === selectedNode.id ? { ...node, ...patch } : node)
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
    const next: DiagramDocument = {
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
    };
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
    const next = { ...document, relations: document.relations.filter((relation) => relation.id !== relationId) };
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

  function removeSelectedNode() {
    if (!selectedNode) return;
    const next: DiagramDocument = {
      ...document,
      nodes: document.nodes.filter((node) => node.id !== selectedNode.id),
      relations: document.relations.filter((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id),
      boundaries: document.boundaries.map((boundary) => ({ ...boundary, members: boundary.members.filter((id) => id !== selectedNode.id) })),
      flow: document.flow ? { ...document.flow, primaryPath: document.flow.primaryPath.filter((id) => id !== selectedNode.id) } : undefined,
      sequence: document.sequence ? { ...document.sequence, participants: document.sequence.participants.filter((id) => id !== selectedNode.id) } : undefined
    };
    setSelectedNodeId(next.nodes[0]?.id || null);
    commitDocument(next, "已删除节点及其关系");
  }

  function resetDiagram() {
    const next = FIXTURES[document.kind]();
    setSelectedNodeId(next.nodes[0]?.id || null);
    commitDocument(next, "已恢复示例图");
    void runLayout(next);
  }

  function acceptPreview() {
    if (!previewDocument) return;
    const next = previewDocument;
    const summary = previewSummary || "已应用布局预览";
    commitDocument(next, summary + "（已应用）");
    setMessages((items) => [...items, { role: "assistant", id: Date.now(), text: "预览已应用，正式文档已更新。" }]);
  }

  function discardPreview() {
    if (!previewDocument) return;
    setPreviewDocument(null);
    setPreviewSummary("");
    setLastAction("已丢弃预览，正式文档保持不变");
  }

  function exportDiagram() {
    const filename = document.title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "architecture-diagram";
    downloadText(filename + ".drawio", drawioXml);
    setLastAction("已导出原生 .drawio 文件");
  }

  async function importDiagramFile(file: File | undefined) {
    if (!file) return;
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
    } catch (error) {
      setLastAction("导入失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (importFileRef.current) importFileRef.current.value = "";
    }
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
        <input ref={importFileRef} className="file-input-hidden" type="file" accept=".drawio,.xml,application/xml,text/xml" onChange={(event) => void importDiagramFile(event.target.files?.[0])} />
        <div className="topbar-actions">
          <button className="button button-quiet" disabled={!canUndo || Boolean(previewDocument)} onClick={undoDocument}>撤销</button>
          <button className="button button-quiet" disabled={!canRedo || Boolean(previewDocument)} onClick={redoDocument}>重做</button>
          <button className="button button-quiet" onClick={resetDiagram}>重置示例</button>
          <button className="button button-secondary" onClick={() => importFileRef.current?.click()}><span className="button-icon">↑</span>导入 .drawio</button>
          <button className="button button-secondary" onClick={exportDiagram} disabled={Boolean(previewDocument)}><span className="button-icon">↓</span>导出 .drawio</button>
          <button className="button button-primary" disabled={Boolean(previewDocument)} onClick={() => setViewMode(viewMode === "studio" ? "drawio" : "studio")}><span className="button-icon">◇</span>{viewMode === "studio" ? "原生 Draw.io" : "Studio 画布"}</button>
        </div>
      </header>

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
            <button className="toolbar-button" onClick={() => void runLayout()} disabled={isLayoutting || Boolean(previewDocument)}><span>{isLayoutting ? <i className="spinner" /> : "⌁"}</span>{isLayoutting ? "计算中…" : "自动排版"}</button>
            <div className="segmented"><button disabled={Boolean(previewDocument)} className={viewMode === "studio" ? "selected" : ""} onClick={() => setViewMode("studio")}>Studio</button><button disabled={Boolean(previewDocument)} className={viewMode === "drawio" ? "selected" : ""} onClick={() => setViewMode("drawio")}>Draw.io</button></div>
          </div>
        </div>

        <div className={"canvas-stage " + (viewMode === "drawio" ? "native-mode" : "")}>
          {viewMode === "studio" ? (
            <DiagramCanvas document={visibleDocument} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId}
              onMoveNode={(id, x, y) => commitDocument(moveNode(visibleDocument, id, x, y), "已手动移动节点；该位置已锁定")} />
          ) : (
            <DrawioFrame document={document} xml={drawioXml} onDocumentChange={(next) => commitDocument(next, "已从原生 Draw.io 同步修改")} />
          )}
          <div className="canvas-stage-footer"><span><i className="canvas-dot" />{viewMode === "studio" ? "Studio semantic preview" : "Local Draw.io editor"}</span><span>拖动节点可调整位置 · 自动排版会尊重锁定节点</span></div>
          {viewMode === "studio" && <div className="zoom-indicator"><span>−</span><strong>100%</strong><span>＋</span><i /></div>}
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right"><span>{visibleDocument.nodes.length} nodes</span><span>{visibleDocument.relations.length} relations</span><span>Profile: {visibleDocument.layout.profile}</span><span>Layout engine: ELK Layered</span></div></div>
      </main>

      <aside className="right-panel">
        <div className="right-tabs"><span className="right-tab active">属性检查</span><span className="right-tab">设计质量</span><span className="right-tab-label">STUDIO</span></div>
        <section className="inspector-section">
          <div className="panel-section-heading"><span>SELECTED ELEMENT</span><span className="small-icon">⌗</span></div>
          {selectedNode ? (
            <div className="inspector-form">
              <div className="field-label">名称</div><input className="text-field" value={selectedNode.name} onChange={(event) => changeNode({ name: event.target.value })} />
              <div className="field-label">语义角色</div>
              <select className="text-field" value={selectedNode.role} onChange={(event) => changeNode({ role: event.target.value as DiagramNode["role"] })}>
                {Object.entries(roleLabels).map(([role, label]) => <option key={role} value={role}>{label}</option>)}
              </select>
              <div className="field-label">技术 / 平台</div><input className="text-field" value={selectedNode.technology || ""} placeholder="例如：Java / Spring" onChange={(event) => changeNode({ technology: event.target.value })} />
              <div className="field-label">描述</div><textarea className="text-field text-area" value={selectedNode.description || ""} placeholder="此组件的职责…" onChange={(event) => changeNode({ description: event.target.value })} rows={2} />
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
                    <div className="relation-actions">
                      <button type="button" title="反转方向" onClick={() => reverseRelation(relation.id)}>↔ 方向</button>
                      <button type="button" title="删除关系" onClick={() => removeRelation(relation.id)}>删除</button>
                    </div>
                  </div>
                ))}
                {document.relations.every((relation) => relation.source !== selectedNode.id && relation.target !== selectedNode.id) && <div className="empty-relations">当前元素没有关联线。</div>}
              </div>
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

        <section className="copilot-section">
          <div className="copilot-heading">
            <div><span className="copilot-mark">✳</span><b>Layout Copilot</b><button type="button" className="ai-settings-toggle" onClick={() => setAiSettingsOpen((open) => !open)}>{aiSettingsOpen ? "关闭设置" : "模型设置"}</button></div>
            <span className="local-rule-tag">{aiBaseUrl.trim() && aiModel.trim() ? "MODEL + RULES" : "LOCAL RULES"}</span>
          </div>
          {aiSettingsOpen && <div className="ai-settings">
            <div className="ai-settings-title">OpenAI-compatible 接口</div>
            <label>Base URL<input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="例如：http://localhost:1234/v1" /></label>
            <label>Model<input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="模型名称" /></label>
            <label>API Key（可选）<input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="只保留在当前页面内存" autoComplete="off" /></label>
            <div className="ai-settings-note">模型只负责把自然语言转换为受限布局指令；坐标由本地布局器计算。请求会发送用户输入、图标题和节点名称/角色到该接口。请勿将敏感架构信息发送给未经批准的服务；API Key只保留在当前页面内存。</div>
            <div className="ai-settings-actions"><button type="button" onClick={clearAISettings}>清除配置</button><button type="button" className="ai-settings-save" onClick={saveAISettings}>保存设置</button></div>
          </div>
          <div className="chat-messages">
            {messages.map((message) => <div key={message.id} className={"chat-message " + message.role}>
              {message.role === "assistant" && <span className="assistant-avatar">F</span>}<div className="chat-bubble">{message.text}</div>
            </div>)}
            <div ref={chatEndRef} />
          </div>
          {previewDocument && <div className="preview-actions"><div className="preview-summary">{previewSummary || "布局预览已生成"}</div><div className="preview-buttons"><button type="button" className="preview-discard" onClick={discardPreview}>丢弃</button><button type="button" className="preview-accept" onClick={acceptPreview}>应用修改</button></div></div>}
          <form className="chat-input-wrap" onSubmit={(event) => { event.preventDefault(); void sendIntent(); }}>
            <textarea disabled={Boolean(previewDocument)} value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="例如：把所有 external 移到右侧…" rows={2}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendIntent(); } }} />
            <button type="submit" disabled={chatBusy || Boolean(previewDocument) || !chatInput.trim()} aria-label="执行布局指令">↑</button>
          </form>
          <div className="copilot-footnote">意图 → 语义约束 → 布局 → 质量检查</div>
        </section>
      </aside>
    </div>
  );
}