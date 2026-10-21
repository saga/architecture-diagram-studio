import { useMemo, useState } from "react";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";
import { toDrawioXml } from "./export/drawio";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "./model/fixtures";
import type { DiagramDocument } from "./model/types";

type Scenario = "sequence" | "c4" | "flowchart";
const factories: Record<Scenario, () => DiagramDocument> = {
  sequence: () => {
    const document = createSequenceFixture();
    document.relations.push({ id: "lab-self-call", source: "web", target: "web", label: "Refresh local cache", kind: "call", sequenceOrder: document.relations.length });
    return document;
  },
  c4: createC4Fixture,
  flowchart: createFlowFixture
};

/**
 * Real-embed visual test bench. Open /drawio-lab while running Vite to compare
 * the semantic SVG renderer with the exact XML loaded by the bundled Draw.io.
 */
export default function DrawioRenderLab() {
  const [scenario, setScenario] = useState<Scenario>("sequence");
  const [document, setDocument] = useState<DiagramDocument>(() => factories.sequence());
  const [nativeXml, setNativeXml] = useState<string | null>(null);
  const [showXml, setShowXml] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const xml = useMemo(() => nativeXml ?? toDrawioXml(document), [nativeXml, document]);

  function chooseScenario(next: Scenario) {
    setScenario(next);
    setDocument(factories[next]());
    setNativeXml(null);
    setSelectedNodeId(null);
    setSelectedRelationId(null);
  }

  return (
    <main className="drawio-render-lab">
      <header className="drawio-render-lab-header">
        <div>
          <h1>Draw.io 渲染实验室</h1>
          <p>左侧是 Studio SVG，右侧是本地 Draw.io embed。用于核对关系线、箭头、自调用、生命线和 activation bar 的真实渲染。</p>
        </div>
        <div className="drawio-render-lab-controls">
          <label>测试场景
            <select value={scenario} onChange={(event) => chooseScenario(event.target.value as Scenario)}>
              <option value="sequence">时序图（含调用与返回）</option>
              <option value="c4">C4 架构图</option>
              <option value="flowchart">流程图</option>
            </select>
          </label>
          <button type="button" onClick={() => setShowXml((value) => !value)}>{showXml ? "隐藏 XML" : "查看 XML"}</button>
          <button type="button" onClick={() => chooseScenario(scenario)}>重置场景</button>
          <a href="/" target="_blank" rel="noreferrer">打开 Studio 主应用 ↗</a>
        </div>
      </header>
      <section className="drawio-render-lab-panels">
        <article className="drawio-render-lab-panel">
          <div className="drawio-render-lab-panel-title"><strong>Studio SVG</strong><span>共享语义模型</span></div>
          <div className="drawio-render-lab-canvas">
            <DiagramCanvas document={document} zoom={1} viewResetToken={0}
              selectedNodeId={selectedNodeId} selectedRelationId={selectedRelationId}
              onSelectNode={(id) => { setSelectedNodeId(id); setSelectedRelationId(null); }}
              onSelectRelation={(id) => { setSelectedRelationId(id); setSelectedNodeId(null); }}
              onMoveNode={(id, x, y) => setDocument((current) => ({
                ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, x, y } : node)
              }))} />
          </div>
        </article>
        <article className="drawio-render-lab-panel">
          <div className="drawio-render-lab-panel-title"><strong>原生 Draw.io embed</strong><span>实际渲染与交互</span></div>
          <div className="drawio-render-lab-editor">
            <DrawioFrame key={scenario} document={document} xml={xml}
              onDocumentChange={(next, savedXml) => { setDocument(next); setNativeXml(savedXml); }} />
          </div>
        </article>
      </section>
      {showXml && <section className="drawio-render-lab-xml">
        <div><strong>当前发送给 Draw.io 的 XML</strong><span>{xml.length.toLocaleString()} chars · {document.nodes.length} nodes · {document.relations.length} relations</span></div>
        <textarea readOnly spellCheck={false} value={xml} aria-label="Draw.io XML source" />
      </section>}
    </main>
  );
}
