import { useMemo, useState } from "react";
import { Button, Input, Select } from "antd";
import DiagramCanvas from "./components/DiagramCanvas";
import DrawioFrame from "./components/DrawioFrame";
import { toDrawioXml } from "./export/drawio";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "./model/fixtures";
import type { DiagramDocument, SequenceFragment } from "./model/types";

type Scenario = "sequence" | "c4" | "flowchart";
const factories: Record<Scenario, () => DiagramDocument> = {
  sequence: () => {
    const document = createSequenceFixture();
    document.relations.push({ id: "lab-self-call", source: "web", target: "web", label: "Refresh local cache", kind: "call", sequenceOrder: document.relations.length });
    document.sequence = { ...(document.sequence || { participants: [] }), fragments: [{ id: "lab-alt", kind: "alt", label: "Token valid or expired", startOrder: 1, endOrder: Math.min(6, document.relations.length - 1) }] };
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
  const [connectionSourceId, setConnectionSourceId] = useState<string | null>(null);
  const xml = useMemo(() => nativeXml ?? toDrawioXml(document), [nativeXml, document]);

  function chooseScenario(next: Scenario) {
    setScenario(next);
    setDocument(factories[next]());
    setNativeXml(null);
    setSelectedNodeId(null);
    setSelectedRelationId(null);
    setConnectionSourceId(null);
  }

  return (
    <main className="drawio-render-lab">
      <header className="drawio-render-lab-header">
        <div>
          <h1>Draw.io rendering lab</h1>
          <p>Studio SVG on the left, the local Draw.io embed on the right. Use it to compare relation lines, arrowheads, self-calls, lifelines, and activation bars against the real renderer.</p>
        </div>
        <div className="drawio-render-lab-controls">
          <label>Scenario
            <Select value={scenario} onChange={(value) => chooseScenario(value as Scenario)} options={[{ value: "sequence", label: "Sequence (calls and returns)" }, { value: "c4", label: "C4 architecture" }, { value: "flowchart", label: "Flowchart" }]} />
          </label>
          <Button onClick={() => setShowXml((value) => !value)}>{showXml ? "Hide XML" : "Show XML"}</Button>
          <Button onClick={() => chooseScenario(scenario)}>Reset scenario</Button>
          <a href="/" target="_blank" rel="noreferrer">Open the Studio app ↗</a>
        </div>
      </header>
      <section className="drawio-render-lab-panels">
        <article className="drawio-render-lab-panel">
          <div className="drawio-render-lab-panel-title"><strong>Studio SVG</strong><span>Shared semantic model</span></div>
          <div className="drawio-render-lab-canvas">
            <DiagramCanvas document={document} zoom={1} viewResetToken={0}
              selectedNodeId={selectedNodeId} selectedRelationId={selectedRelationId}
              connectionSourceId={connectionSourceId} onConnectionSourceChange={setConnectionSourceId}
              onSelectNode={(id) => { setSelectedNodeId(id); setSelectedRelationId(null); }}
              onSelectRelation={(id) => { setSelectedRelationId(id); setSelectedNodeId(null); }}
              onCreateRelation={(sourceId, targetId) => {
                if (document.kind === "sequence" && sourceId === targetId) return;
                setNativeXml(null);
                setDocument((current) => ({
                  ...current,
                  relations: [...current.relations, {
                    id: "lab-relation-" + Date.now(), source: sourceId, target: targetId, label: "",
                    kind: current.kind === "sequence" ? "call" : "flow",
                    sequenceOrder: current.kind === "sequence" ? current.relations.length : undefined,
                    points: []
                  }]
                }));
              }}
              onReconnectRelation={(relationId, endpoint, nodeId) => {
                setNativeXml(null);
                setDocument((current) => ({
                  ...current,
                  relations: current.relations.map((relation) => relation.id !== relationId ? relation : {
                    ...relation,
                    source: endpoint === "source" ? nodeId : relation.source,
                    target: endpoint === "target" ? nodeId : relation.target,
                    points: []
                  })
                }));
              }}
              onRenameNode={(nodeId, name) => {
                setNativeXml(null);
                setDocument((current) => ({ ...current, nodes: current.nodes.map((node) => node.id === nodeId ? { ...node, name } : node) }));
              }}
              onUpdateRelationLabel={(relationId, label) => {
                setNativeXml(null);
                setDocument((current) => ({ ...current, relations: current.relations.map((relation) => relation.id === relationId ? { ...relation, label } : relation) }));
              }}
              onUpdateSequenceFragment={(fragmentId, patch: Partial<SequenceFragment>) => {
                setNativeXml(null);
                setDocument((current) => ({
                  ...current,
                  sequence: current.sequence ? { ...current.sequence, fragments: (current.sequence.fragments || []).map((fragment) => {
                    if (fragment.id !== fragmentId) return fragment;
                    const nextFragment = { ...fragment, ...patch };
                    const maxOrder = Math.max(0, current.relations.length - 1);
                    const startOrder = Math.max(0, Math.min(maxOrder, nextFragment.startOrder));
                    const endOrder = Math.max(startOrder, Math.min(maxOrder, nextFragment.endOrder));
                    return { ...nextFragment, startOrder, endOrder };
                  }) } : undefined
                }));
              }}
              onUpdateBoundary={(boundaryId, patch) => {
                setNativeXml(null);
                setDocument((current) => ({
                  ...current,
                  boundaries: current.boundaries.map((boundary) => boundary.id === boundaryId ? { ...boundary, ...patch } : boundary)
                }));
              }}
              onMoveNode={(id, x, y) => { setNativeXml(null); setDocument((current) => ({
                ...current, nodes: current.nodes.map((node) => node.id === id ? { ...node, x, y } : node)
              })); }} onContextMenu={() => {}} />
          </div>
        </article>
        <article className="drawio-render-lab-panel">
          <div className="drawio-render-lab-panel-title"><strong>Native Draw.io embed</strong><span>Real rendering and interaction</span></div>
          <div className="drawio-render-lab-editor">
            <DrawioFrame key={scenario} document={document} xml={xml} theme="editorial"
              onDocumentChange={(next, savedXml) => { setDocument(next); setNativeXml(savedXml); }} />
          </div>
        </article>
      </section>
      {showXml && <section className="drawio-render-lab-xml">
        <div><strong>XML currently sent to Draw.io</strong><span>{xml.length.toLocaleString()} chars · {document.nodes.length} nodes · {document.relations.length} relations</span></div>
        <Input.TextArea readOnly spellCheck={false} value={xml} aria-label="Draw.io XML source" />
      </section>}
    </main>
  );
}
