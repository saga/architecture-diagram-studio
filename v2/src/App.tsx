import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { DiagramDocument, DiagramKind, DiagramNode } from "./model/types";
import { FIXTURES } from "./model/fixtures";
import { layoutDiagram, moveNode } from "./layout/layout";
import { evaluateLayout } from "./layout/quality";
import { applyIntent } from "./intent/applyIntent";
import { downloadText, toDrawioXml } from "./export/drawio";
import { roleLabels } from "./design/tokens";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
function newId(prefix: string): string { return prefix + "-" + Math.random().toString(36).slice(2, 8); }

export default function App() {
  const [document, setDocument] = useState<DiagramDocument>(() => FIXTURES.c4());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("domain");
  const [viewMode, setViewMode] = useState<"studio" | "drawio">("studio");
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", id: 1, text: "可以直接说布局意图，例如「所有 external 放到右侧」「数据库放底部」「所有线改成虚线」「曲线改成折线」。目前使用本地确定性规则，不会假装已调用云端模型。" }
  ]);
  const [revision, setRevision] = useState(1);
  const [lastAction, setLastAction] = useState("已加载 Studio Editorial 示例");
  const [isLayoutting, setIsLayoutting] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const selectedNode = document.nodes.find((node) => node.id === selectedNodeId) || null;
  const quality = useMemo(() => evaluateLayout(document), [document]);
  const drawioXml = useMemo(() => toDrawioXml(document), [document]);

  useEffect(() => {
    let active = true;
    layoutDiagram(FIXTURES.c4()).then((laidOut) => { if (active) setDocument(laidOut); })
      .catch((error: unknown) => { if (active) setLastAction("布局器异常：" + (error instanceof Error ? error.message : String(error))); });
    return () => { active = false; };
  }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [messages]);

  const commitDocument = useCallback((next: DiagramDocument, action: string) => {
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

  function changeKind(kind: DiagramKind) {
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
      const result = await applyIntent(document, text);
      if (result.changed) {
        commitDocument(result.document, result.summary);
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: result.summary + "。修改已作为一个新版本写入当前文档。" }]);
      } else {
        setMessages((items) => [...items, { role: "assistant", id: Date.now() + 1, text: result.summary }]);
      }
    } catch (error) {
      setMessages((items) => [...items, { role: "assistant", id: Date.now() + 2, text: "没有提交修改：" + (error instanceof Error ? error.message : String(error)) }]);
    } finally {
      setChatBusy(false);
    }
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

  function exportDiagram() {
    const filename = document.title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "") || "architecture-diagram";
    downloadText(filename + ".drawio", drawioXml);
    setLastAction("已导出原生 .drawio 文件");
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
        <div className="topbar-actions">
          <button className="button button-quiet" onClick={resetDiagram}>重置示例</button>
          <button className="button button-secondary" onClick={exportDiagram}><span className="button-icon">↓</span>导出 .drawio</button>
          <button className="button button-primary" onClick={() => setViewMode(viewMode === "studio" ? "drawio" : "studio")}><span className="button-icon">◇</span>{viewMode === "studio" ? "原生 Draw.io" : "Studio 画布"}</button>
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
            <div className="canvas-title">{document.title}<span className="canvas-subtitle">V2 semantic canvas</span></div>
          </div>
          <div className="canvas-tools">
            <button className="toolbar-button" onClick={() => void runLayout()} disabled={isLayoutting}><span>{isLayoutting ? <i className="spinner" /> : "⌁"}</span>{isLayoutting ? "计算中…" : "自动排版"}</button>
            <div className="segmented"><button className={viewMode === "studio" ? "selected" : ""} onClick={() => setViewMode("studio")}>Studio</button><button className={viewMode === "drawio" ? "selected" : ""} onClick={() => setViewMode("drawio")}>Draw.io</button></div>
          </div>
        </div>

        <div className={"canvas-stage " + (viewMode === "drawio" ? "native-mode" : "")}>
          {viewMode === "studio" ? (
            <DiagramCanvas document={document} selectedNodeId={selectedNodeId} onSelectNode={setSelectedNodeId}
              onMoveNode={(id, x, y) => commitDocument(moveNode(document, id, x, y), "已手动移动节点；该位置已锁定")} />
          ) : (
            <DrawioFrame document={document} xml={drawioXml} onDocumentChange={(next) => commitDocument(next, "已从原生 Draw.io 同步修改")} />
          )}
          <div className="canvas-stage-footer"><span><i className="canvas-dot" />{viewMode === "studio" ? "Studio semantic preview" : "Local Draw.io editor"}</span><span>拖动节点可调整位置 · 自动排版会尊重锁定节点</span></div>
          {viewMode === "studio" && <div className="zoom-indicator"><span>−</span><strong>100%</strong><span>＋</span><i /></div>}
        </div>
        <div className="bottom-status"><div className="status-left"><span className="status-pulse" />{lastAction}</div><div className="status-right"><span>{document.nodes.length} nodes</span><span>{document.relations.length} relations</span><span>Profile: {document.layout.profile}</span><span>Layout engine: ELK Layered</span></div></div>
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
          <div className="copilot-heading"><div><span className="copilot-mark">✳</span><b>Layout Copilot</b></div><span className="local-rule-tag">LOCAL RULES</span></div>
          <div className="chat-messages">
            {messages.map((message) => <div key={message.id} className={"chat-message " + message.role}>
              {message.role === "assistant" && <span className="assistant-avatar">F</span>}<div className="chat-bubble">{message.text}</div>
            </div>)}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-input-wrap" onSubmit={(event) => { event.preventDefault(); void sendIntent(); }}>
            <textarea value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="例如：把所有 external 移到右侧…" rows={2}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendIntent(); } }} />
            <button type="submit" disabled={chatBusy || !chatInput.trim()} aria-label="执行布局指令">↑</button>
          </form>
          <div className="copilot-footnote">意图 → 语义约束 → 布局 → 质量检查</div>
        </section>
      </aside>
    </div>
  );
}