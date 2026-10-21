import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DiagramDocument, DiagramNode, DiagramRelation, Point } from "../model/types";
import { nodePaint, relationPaint } from "../design/styles";
import { tokens } from "../design/tokens";
import { measureTextWidth, truncateTextToWidth } from "../design/text-metrics";
import { deriveSequenceActivations, sequenceMessageGeometry } from "../layout/sequence";

interface Props {
  document: DiagramDocument;
  zoom: number;
  viewResetToken: number;
  selectedNodeId: string | null;
  selectedRelationId: string | null;
  onSelectNode: (id: string) => void;
  onSelectRelation: (id: string) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
  onContextMenu: (target: { kind: "node" | "relation" | "canvas"; id?: string }, x: number, y: number) => void;
}
interface DragState { id: string; offsetX: number; offsetY: number; x: number; y: number; originX: number; originY: number; }
interface PanState { startClientX: number; startClientY: number; originX: number; originY: number; }

function center(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
function relationPath(document: DiagramDocument, relation: DiagramRelation): { d: string; label: Point } | null {
  const source = document.nodes.find((node) => node.id === relation.source);
  const target = document.nodes.find((node) => node.id === relation.target);
  if (!source || !target) return null;
  let start: Point, end: Point;
  const points = relation.points || [];
  if (document.kind === "sequence") {
    const geometry = sequenceMessageGeometry(document, relation);
    if (!geometry) return null;
    start = geometry.start;
    end = geometry.end;
  } else {
    const s = center(source), t = center(target);
    const dx = t.x - s.x, dy = t.y - s.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
      start = { x: s.x, y: dy >= 0 ? source.y + source.height : source.y };
      end = { x: t.x, y: dy >= 0 ? target.y : target.y + target.height };
    } else if (dx >= 0) {
      start = { x: source.x + source.width, y: s.y };
      end = { x: target.x, y: t.y };
    } else {
      start = { x: source.x, y: s.y };
      end = { x: target.x + target.width, y: t.y };
    }
  }
  if (document.kind !== "sequence") {
    start = relation.sourcePort || start;
    end = relation.targetPort || end;
  }
  const sequenceGeometry = document.kind === "sequence" ? sequenceMessageGeometry(document, relation) : null;
  const all = sequenceGeometry
    ? [sequenceGeometry.start, ...sequenceGeometry.points, sequenceGeometry.end]
    : [start, ...points, end];
  const routing = relation.routing || document.layout.routing;
  let d = "M " + all[0].x + " " + all[0].y;
  if (routing === "curved" && all.length > 2) {
    for (let i = 1; i < all.length - 1; i++) {
      const previous = all[i - 1], current = all[i], next = all[i + 1];
      const beforeLength = Math.hypot(previous.x - current.x, previous.y - current.y);
      const afterLength = Math.hypot(next.x - current.x, next.y - current.y);
      const radius = Math.min(18, beforeLength / 2, afterLength / 2);
      const before = {
        x: current.x + (previous.x - current.x) * radius / Math.max(beforeLength, 0.001),
        y: current.y + (previous.y - current.y) * radius / Math.max(beforeLength, 0.001)
      };
      const after = {
        x: current.x + (next.x - current.x) * radius / Math.max(afterLength, 0.001),
        y: current.y + (next.y - current.y) * radius / Math.max(afterLength, 0.001)
      };
      d += " L " + before.x + " " + before.y + " Q " + current.x + " " + current.y + " " + after.x + " " + after.y;
    }
    d += " L " + all[all.length - 1].x + " " + all[all.length - 1].y;
  } else {
    d = all.map((point, index) => (index === 0 ? "M " : "L ") + point.x + " " + point.y).join(" ");
  }
  let length = 0;
  for (let i = 0; i < all.length - 1; i++) length += Math.hypot(all[i + 1].x - all[i].x, all[i + 1].y - all[i].y);
  let remaining = length / 2, label = all[0];
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i], b = all[i + 1], segment = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= segment || i === all.length - 2) {
      const ratio = segment === 0 ? 0.5 : remaining / segment;
      label = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio - 8 };
      break;
    }
    remaining -= segment;
  }
  return { d, label };
}
function nodePath(node: DiagramNode, shape: string): string {
  if (shape === "pill") {
    const radius = Math.min(tokens.nodeRadius * 2, node.width / 2, node.height / 2);
    return "M " + (node.x + radius) + " " + node.y + " H " + (node.x + node.width - radius) + " Q " + (node.x + node.width) + " " + node.y + " " + (node.x + node.width) + " " + (node.y + radius) + " V " + (node.y + node.height - radius) + " Q " + (node.x + node.width) + " " + (node.y + node.height) + " " + (node.x + node.width - radius) + " " + (node.y + node.height) + " H " + (node.x + radius) + " Q " + node.x + " " + (node.y + node.height) + " " + node.x + " " + (node.y + node.height - radius) + " V " + (node.y + radius) + " Q " + node.x + " " + node.y + " " + (node.x + radius) + " " + node.y + " Z";
  }
  if (shape === "diamond") return "M " + (node.x + node.width / 2) + " " + node.y + " L " + (node.x + node.width) + " " + (node.y + node.height / 2) + " L " + (node.x + node.width / 2) + " " + (node.y + node.height) + " L " + node.x + " " + (node.y + node.height / 2) + " Z";
  const radius = Math.min(tokens.nodeRadius, node.width / 2, node.height / 2);
  return "M " + (node.x + radius) + " " + node.y + " H " + (node.x + node.width - radius) + " Q " + (node.x + node.width) + " " + node.y + " " + (node.x + node.width) + " " + (node.y + radius) + " V " + (node.y + node.height - radius) + " Q " + (node.x + node.width) + " " + (node.y + node.height) + " " + (node.x + node.width - radius) + " " + (node.y + node.height) + " H " + (node.x + radius) + " Q " + node.x + " " + (node.y + node.height) + " " + node.x + " " + (node.y + node.height - radius) + " V " + (node.y + radius) + " Q " + node.x + " " + node.y + " " + (node.x + radius) + " " + node.y + " Z";
}
export default function DiagramCanvas({
  document, zoom, viewResetToken, selectedNodeId, selectedRelationId, onSelectNode, onSelectRelation, onMoveNode, onContextMenu
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [panGesture, setPanGesture] = useState<PanState | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const frame = useMemo(() => ({
    width: Math.max(1240, ...document.nodes.map((node) => node.x + node.width + 100)),
    height: Math.max(document.kind === "sequence" ? 820 : 760,
      document.kind === "sequence" ? 148 + Math.max(0, document.relations.length - 1) * 72 + 100 : 0,
      ...document.nodes.map((node) => node.y + node.height + 120))
  }), [document.nodes, document.kind, document.relations.length]);
  const safeSvgId = document.id.replace(/[^A-Za-z0-9_-]/g, "-") || "diagram";
  const titleId = "studio-diagram-title-" + safeSvgId;
  const descriptionId = "studio-diagram-description-" + safeSvgId;

  useEffect(() => {
    setPan({ x: 0, y: 0 });
    setPanGesture(null);
  }, [document.id, document.kind, viewResetToken]);

  function pointerToDiagram(clientX: number, clientY: number): Point {
    const svg = svgRef.current;
    const matrix = svg?.getScreenCTM();
    if (!svg || !matrix) return { x: clientX, y: clientY };
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
  }
  function startDrag(event: ReactPointerEvent<SVGGElement>, node: DiagramNode) {
    if (event.button !== 0) return;
    event.stopPropagation();
    const point = pointerToDiagram(event.clientX, event.clientY);
    setDrag({ id: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y, x: node.x, y: node.y, originX: node.x, originY: node.y });
    onSelectNode(node.id);
    svgRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function startPan(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || drag) return;
    setPanGesture({
      startClientX: event.clientX, startClientY: event.clientY, originX: pan.x, originY: pan.y
    });
    svgRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveDrag(event: ReactPointerEvent<SVGSVGElement>) {
    if (drag) {
      const point = pointerToDiagram(event.clientX, event.clientY);
      setDrag({ ...drag, x: Math.max(12, point.x - drag.offsetX), y: Math.max(12, point.y - drag.offsetY) });
      return;
    }
    if (panGesture) {
      const matrix = svgRef.current?.getScreenCTM();
      if (!matrix) return;
      const scaleX = Math.abs(matrix.a) || 1;
      const scaleY = Math.abs(matrix.d) || 1;
      setPan({
        x: panGesture.originX - (event.clientX - panGesture.startClientX) / scaleX,
        y: panGesture.originY - (event.clientY - panGesture.startClientY) / scaleY
      });
    }
  }
  function endDrag() {
    if (drag) {
      if (Math.abs(drag.x - drag.originX) > 2 || Math.abs(drag.y - drag.originY) > 2) {
        onMoveNode(drag.id, drag.x, drag.y);
      }
      setDrag(null);
    }
    setPanGesture(null);
  }
  function selectRelation(event: ReactMouseEvent<SVGGElement>, relationId: string) {
    event.stopPropagation();
    onSelectRelation(relationId);
  }
  const displayNodes = document.nodes.map((node) => drag && drag.id === node.id ? { ...node, x: drag.x, y: drag.y } : node);
  const displayDoc = { ...document, nodes: displayNodes };

  return (
    <svg ref={svgRef} className={"diagram-svg" + (panGesture ? " is-panning" : "")}
      viewBox={(frame.width * (1 - 1 / zoom) / 2 + pan.x) + " " + (frame.height * (1 - 1 / zoom) / 2 + pan.y) + " " + (frame.width / zoom) + " " + (frame.height / zoom)}
      preserveAspectRatio={document.kind === "flowchart" ? "xMidYMin meet" : "xMidYMid meet"} onPointerDown={startPan}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu({ kind: "canvas" }, event.clientX, event.clientY); }}
      role="group" aria-labelledby={titleId + " " + descriptionId}>
      <title id={titleId}>{document.title}</title>
      <desc id={descriptionId}>{document.kind.toUpperCase() + " diagram with " + document.nodes.length + " nodes and " + document.relations.length + " relationships."}</desc>
      <defs>
        <pattern id="studio-grid" width={tokens.grid * 6} height={tokens.grid * 6} patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill={tokens.canvasGrid} /></pattern>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#33475F" /></marker>
        <marker id="arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#4C5C72" strokeWidth="1.3" /></marker>
      </defs>
      <rect width={frame.width} height={frame.height} fill={tokens.canvas} />
      <rect width={frame.width} height={frame.height} fill="url(#studio-grid)" />
      {displayDoc.boundaries.map((boundary) => {
        const members = displayNodes.filter((node) => boundary.members.includes(node.id));
        if (!members.length) return null;
        const left = Math.min(...members.map((node) => node.x)) - document.layout.boundaryPadding;
        const top = Math.min(...members.map((node) => node.y)) - document.layout.boundaryPadding - 16;
        const right = Math.max(...members.map((node) => node.x + node.width)) + document.layout.boundaryPadding;
        const bottom = Math.max(...members.map((node) => node.y + node.height)) + document.layout.boundaryPadding;
        return <g key={boundary.id} className="diagram-boundary">
          <rect className="diagram-boundary-frame" x={left} y={top} width={right - left} height={bottom - top} rx="13" fill="#E8EDF6" fillOpacity="0.85" stroke="#8C9AB0" strokeWidth="1.4" strokeDasharray="5 5" />
          <text className="diagram-boundary-label" x={left + 14} y={top + 20} fontSize="13" fontWeight="500" fill="#0C1626">{boundary.name.toUpperCase()}</text>
        </g>;
      })}
      {document.kind === "sequence" && (document.sequence?.fragments || []).map((fragment) => {
        const participantNodes = displayNodes.filter((node) => (document.sequence?.participants || []).includes(node.id));
        if (!participantNodes.length) return null;
        const left = Math.min(...participantNodes.map((node) => node.x)) - 12;
        const right = Math.max(...participantNodes.map((node) => node.x + node.width)) + 12;
        const top = 148 + fragment.startOrder * 72 - 22;
        const bottom = 148 + fragment.endOrder * 72 + 22;
        const tag = fragment.kind.toUpperCase();
        const tagWidth = Math.max(44, tag.length * 8.6 + 16);
        return <g key={fragment.id} className="sequence-fragment">
          <rect className="sequence-fragment-frame" x={left} y={top} width={right - left} height={bottom - top} rx="5" fill="#EDF1F9" fillOpacity="0.9" stroke="#7E8EA6" strokeWidth="1.4" strokeDasharray="5 4" />
          <rect className="sequence-fragment-tag" x={left + 10} y={top - 2} width={tagWidth} height="24" rx="4" fill="#DCE3F0" stroke="#7E8EA6" strokeWidth="1.2" />
          <text className="sequence-fragment-kind" x={left + 18} y={top + 15} fontSize="13" fontWeight="500" fill="#0C1626">{tag}</text>
          <text className="sequence-fragment-label" x={left + 10 + tagWidth + 10} y={top + 15} fontSize="13" fontWeight="500" fill="#0C1626">{fragment.label}</text>
        </g>;
      })}
      {document.kind === "sequence" && displayNodes.map((node) => <line className="sequence-lifeline" key={node.id + "-lifeline"} x1={center(node).x} y1={node.y + node.height} x2={center(node).x} y2={148 + Math.max(0, document.relations.length - 1) * 72 + 62} stroke="#7C8CA3" strokeWidth="1.2" strokeDasharray="4 5" />)}
      {document.kind === "sequence" && deriveSequenceActivations(displayDoc).map((activation) => {
        const participant = displayNodes.find((node) => node.id === activation.participantId);
        if (!participant) return null;
        // Activation bars touch the initiating call and the matching return line.
        const y = 148 + activation.startOrder * 72;
        const height = Math.max(12, (activation.endOrder - activation.startOrder) * 72);
        return <rect className="sequence-activation" key={activation.id} x={center(participant).x - 7} y={y} width="14" height={height} rx="3"
          fill="#CFDDF1" stroke="#6E88AC" strokeWidth="1.2" />;
      })}
      {displayDoc.relations.map((relation) => {
        const path = relationPath(displayDoc, relation);
        if (!path) return null;
        const paint = relationPaint(relation);
        const selected = selectedRelationId === relation.id;
        const sourceNode = displayNodes.find((node) => node.id === relation.source);
        const targetNode = displayNodes.find((node) => node.id === relation.target);
        const accessibleRelation = "Relation from " + (sourceNode?.name || relation.source) + " to " + (targetNode?.name || relation.target) + (relation.label ? ": " + relation.label : "");
        const labelWidth = Math.max(48, measureTextWidth(relation.label, 13) + 20);
        return <g key={relation.id} className={"diagram-relation" + (selected ? " selected" : "")}
          role="button" tabIndex={0} aria-label={accessibleRelation}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => selectRelation(event, relation.id)}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ kind: "relation", id: relation.id }, event.clientX, event.clientY); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectRelation(relation.id); } }}
          style={{ cursor: "pointer" }}>
          <path className="relation-hit-area" d={path.d} fill="none" stroke="transparent" strokeWidth="18" pointerEvents="stroke" />
          <path className="relation-visible-path" d={path.d} fill="none" stroke={selected ? tokens.accent : paint.stroke}
            strokeWidth={selected ? Math.max(2.8, paint.width + 1.1) : paint.width}
            strokeDasharray={relation.dashed === undefined ? paint.dash || undefined : relation.dashed ? "5 5" : undefined}
            markerEnd={"url(#" + paint.marker + ")"} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
          {relation.label && <g className="relation-label" pointerEvents="none">
            <rect className="relation-label-bg" x={path.label.x - labelWidth / 2} y={path.label.y - 14} width={labelWidth} height="22" rx="4" fill={tokens.canvas} fillOpacity="0.98" />
            <text className="relation-label-text" x={path.label.x} y={path.label.y + 2} textAnchor="middle" fontSize="13" fontWeight="500" fill="#0C1626">{relation.label}</text>
          </g>}
        </g>;
      })}
      {displayNodes.map((node) => {
        const paint = nodePaint(node);
        const selected = selectedNodeId === node.id;
        const titleY = node.y + (node.description || node.technology ? 28 : node.height / 2 + 4);
        const centeredFlowNode = document.kind === "flowchart" && ["decision", "start", "end"].includes(node.role);
        // One type size everywhere: 13px averages ~6.8px per glyph, so the label budget comes from node width.
        const availableTextWidth = Math.max(0, node.width - 34);
        const compactTitle = truncateTextToWidth(node.name, availableTextWidth, 13);
        const technologyLabel = node.technology ? truncateTextToWidth(node.technology, availableTextWidth, 13) : "";
        const descriptionLabel = node.description ? truncateTextToWidth(node.description, availableTextWidth, 13) : "";
        const accessibleNode = "Node: " + node.name + (node.technology ? ". Technology: " + node.technology : "") + (node.description ? ". Description: " + node.description : "");
        return <g key={node.id} data-role={node.role} className={"diagram-node" + (selected ? " selected" : "") + (drag?.id === node.id ? " dragging" : "")}
          role="button" tabIndex={0} aria-label={accessibleNode}
          onPointerDown={(event) => startDrag(event, node)} onClick={(event) => { event.stopPropagation(); onSelectNode(node.id); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectNode(node.id); } }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ kind: "node", id: node.id }, event.clientX, event.clientY); }}
          style={{ cursor: "grab" }}>
          <title>{accessibleNode}</title>
          <path d={nodePath(node, paint.shape)} fill={paint.fill} stroke={selected ? tokens.accent : paint.stroke} strokeWidth={selected ? 2.4 : 1.4} />
          {!["decision", "start", "end"].includes(node.role) && <path d={"M " + (node.x + 9) + " " + (node.y + 13) + " V " + (node.y + node.height - 13)} stroke={paint.accent} strokeWidth="3.4" strokeLinecap="round" opacity={node.role === "actor" || node.role === "source" ? 0.6 : 1} />}
          <text x={centeredFlowNode ? node.x + node.width / 2 : node.x + 17} y={titleY + 1}
            textAnchor={centeredFlowNode ? "middle" : "start"} fontSize="13" fontWeight="500" fill="#0C1626">{compactTitle}</text>
          {node.technology && <text x={node.x + 17} y={node.y + 47} fontSize="13" fontWeight="500" fill="#0C1626">{technologyLabel}</text>}
          {node.description && <text x={node.x + 17} y={node.y + (node.technology ? 64 : 52)} fontSize="13" fontWeight="500" fill="#0C1626">{descriptionLabel}</text>}
          {node.layoutHints?.locked && <text x={node.x + node.width - 16} y={node.y + 17} textAnchor="middle" fontSize="13" fontWeight="500" fill="#0C1626">●</text>}
        </g>;
      })}
    </svg>
  );
}