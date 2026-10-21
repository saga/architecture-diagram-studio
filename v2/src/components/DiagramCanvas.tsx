import { useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { DiagramDocument, DiagramNode, DiagramRelation, Point } from "../model/types";
import { nodePaint, relationPaint } from "../design/styles";
import { tokens } from "../design/tokens";
import { deriveSequenceActivations } from "../layout/sequence";

interface Props {
  document: DiagramDocument;
  zoom: number;
  selectedNodeId: string | null;
  selectedRelationId: string | null;
  onSelectNode: (id: string) => void;
  onSelectRelation: (id: string) => void;
  onMoveNode: (id: string, x: number, y: number) => void;
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
    const order = relation.sequenceOrder ?? 0;
    const y = 148 + order * 72;
    const sx = center(source).x, tx = center(target).x;
    const activations = deriveSequenceActivations(document);
    const activeActivation = (participantId: string) => activations
      .filter((activation) => activation.participantId === participantId &&
        activation.startOrder <= order && activation.endOrder >= order)
      .sort((a, b) => b.startOrder - a.startOrder || a.endOrder - b.endOrder)[0];
    const endpointX = (participant: DiagramNode, towardX: number) => {
      const activation = activeActivation(participant.id);
      if (!activation) return center(participant).x;
      return center(participant).x + (towardX >= center(participant).x ? -7 : 7);
    };
    // Lifelines run through each participant's center. During an active call,
    // connect to the activation bar's edge; otherwise connect to the lifeline.
    start = { x: endpointX(source, tx), y };
    end = { x: endpointX(target, sx), y };
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
  const all = [start, ...points, end];
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
  if (shape === "pill") return "M " + (node.x + 16) + " " + node.y + " H " + (node.x + node.width - 16) + " Q " + (node.x + node.width) + " " + node.y + " " + (node.x + node.width) + " " + (node.y + 16) + " V " + (node.y + node.height - 16) + " Q " + (node.x + node.width) + " " + (node.y + node.height) + " " + (node.x + node.width - 16) + " " + (node.y + node.height) + " H " + (node.x + 16) + " Q " + node.x + " " + (node.y + node.height) + " " + node.x + " " + (node.y + node.height - 16) + " V " + (node.y + 16) + " Q " + node.x + " " + node.y + " " + (node.x + 16) + " " + node.y + " Z";
  if (shape === "diamond") return "M " + (node.x + node.width / 2) + " " + node.y + " L " + (node.x + node.width) + " " + (node.y + node.height / 2) + " L " + (node.x + node.width / 2) + " " + (node.y + node.height) + " L " + node.x + " " + (node.y + node.height / 2) + " Z";
  return "M " + (node.x + 8) + " " + node.y + " H " + (node.x + node.width - 8) + " Q " + (node.x + node.width) + " " + node.y + " " + (node.x + node.width) + " " + (node.y + 8) + " V " + (node.y + node.height - 8) + " Q " + (node.x + node.width) + " " + (node.y + node.height) + " " + (node.x + node.width - 8) + " " + (node.y + node.height) + " H " + (node.x + 8) + " Q " + node.x + " " + (node.y + node.height) + " " + node.x + " " + (node.y + node.height - 8) + " V " + (node.y + 8) + " Q " + node.x + " " + node.y + " " + (node.x + 8) + " " + node.y + " Z";
}
export default function DiagramCanvas({
  document, zoom, selectedNodeId, selectedRelationId, onSelectNode, onSelectRelation, onMoveNode
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [panGesture, setPanGesture] = useState<PanState | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const frame = useMemo(() => ({
    width: Math.max(1240, ...document.nodes.map((node) => node.x + node.width + 100)),
    height: Math.max(document.kind === "sequence" ? 820 : 760, ...document.nodes.map((node) => node.y + node.height + 120))
  }), [document.nodes, document.kind]);

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
  function selectRelation(event: React.MouseEvent<SVGGElement>, relationId: string) {
    event.stopPropagation();
    onSelectRelation(relationId);
  }
  const displayNodes = document.nodes.map((node) => drag && drag.id === node.id ? { ...node, x: drag.x, y: drag.y } : node);
  const displayDoc = { ...document, nodes: displayNodes };

  return (
    <svg ref={svgRef} className={"diagram-svg" + (panGesture ? " is-panning" : "")}
      viewBox={(frame.width * (1 - 1 / zoom) / 2 + pan.x) + " " + (frame.height * (1 - 1 / zoom) / 2 + pan.y) + " " + (frame.width / zoom) + " " + (frame.height / zoom)}
      preserveAspectRatio="xMidYMid meet" onPointerDown={startPan}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
      role="img" aria-label={document.title}>
      <defs>
        <pattern id="studio-grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill={tokens.canvasGrid} /></pattern>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748B" /></marker>
        <marker id="arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#778496" strokeWidth="1.2" /></marker>
      </defs>
      <rect width={frame.width} height={frame.height} fill="#FBFCFD" onPointerDown={startPan} />
      <rect width={frame.width} height={frame.height} fill="url(#studio-grid)" onPointerDown={startPan} />
      {displayDoc.boundaries.map((boundary) => {
        const members = displayNodes.filter((node) => boundary.members.includes(node.id));
        if (!members.length) return null;
        const left = Math.min(...members.map((node) => node.x)) - document.layout.boundaryPadding;
        const top = Math.min(...members.map((node) => node.y)) - document.layout.boundaryPadding - 16;
        const right = Math.max(...members.map((node) => node.x + node.width)) + document.layout.boundaryPadding;
        const bottom = Math.max(...members.map((node) => node.y + node.height)) + document.layout.boundaryPadding;
        return <g key={boundary.id}>
          <rect x={left} y={top} width={right - left} height={bottom - top} rx="13" fill="#F6F8FB" fillOpacity="0.5" stroke="#D4DCE7" strokeWidth="1.2" strokeDasharray="4 6" />
          <text x={left + 14} y={top + 17} fontSize="10" fontWeight="600" letterSpacing="1.2" fill="#7E8B9D">{boundary.name.toUpperCase()}</text>
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
        return <g key={fragment.id}>
          <rect x={left} y={top} width={right - left} height={bottom - top} rx="5" fill="#F8FAFD" fillOpacity="0.64" stroke="#B8C4D4" strokeWidth="1.2" strokeDasharray="5 4" />
          <rect x={left + 10} y={top - 1} width={Math.max(34, tag.length * 7 + 14)} height="20" rx="4" fill="#EEF2F8" stroke="#B8C4D4" strokeWidth="1" />
          <text x={left + 17} y={top + 13} fontSize="9" fontWeight="700" letterSpacing=".6" fill="#68788F">{tag}</text>
          <text x={left + 58} y={top + 13} fontSize="10" fill="#536276">{fragment.label}</text>
        </g>;
      })}
      {document.kind === "sequence" && displayNodes.map((node) => <line key={node.id + "-lifeline"} x1={center(node).x} y1={node.y + node.height} x2={center(node).x} y2={148 + Math.max(0, document.relations.length - 1) * 72 + 62} stroke="#BCC5D1" strokeWidth="1" strokeDasharray="4 6" />)}
      {document.kind === "sequence" && deriveSequenceActivations(displayDoc).map((activation) => {
        const participant = displayNodes.find((node) => node.id === activation.participantId);
        if (!participant) return null;
        const y = 148 + activation.startOrder * 72 + 5;
        const height = Math.max(12, (activation.endOrder - activation.startOrder) * 72 - 10);
        return <rect key={activation.id} x={center(participant).x - 7} y={y} width="14" height={height} rx="3"
          fill="#E7EDF7" stroke="#B7C5D9" strokeWidth="1" />;
      })}
      {displayDoc.relations.map((relation) => {
        const path = relationPath(displayDoc, relation);
        if (!path) return null;
        const paint = relationPaint(relation);
        const selected = selectedRelationId === relation.id;
        return <g key={relation.id} className={"diagram-relation" + (selected ? " selected" : "")}
          role="button" tabIndex={0} aria-label={"选择关系：" + (relation.label || relation.id)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => selectRelation(event, relation.id)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectRelation(relation.id); } }}
          style={{ cursor: "pointer" }}>
          <path className="relation-hit-area" d={path.d} fill="none" stroke="transparent" strokeWidth="18" pointerEvents="stroke" />
          <path className="relation-visible-path" d={path.d} fill="none" stroke={selected ? "#425BC7" : paint.stroke}
            strokeWidth={selected ? Math.max(2.8, paint.width + 1.1) : paint.width}
            strokeDasharray={relation.dashed === undefined ? paint.dash || undefined : relation.dashed ? "5 5" : undefined}
            markerEnd={"url(#" + paint.marker + ")"} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
          {relation.label && <g pointerEvents="none">
            <rect x={path.label.x - Math.max(18, relation.label.length * 3.1)} y={path.label.y - 12} width={Math.max(36, relation.label.length * 6.2)} height="19" rx="4" fill="#FBFCFD" fillOpacity="0.96" />
            <text x={path.label.x} y={path.label.y + 1} textAnchor="middle" fontSize="10" fill="#38485E">{relation.label}</text>
          </g>}
        </g>;
      })}
      {displayNodes.map((node) => {
        const paint = nodePaint(node);
        const selected = selectedNodeId === node.id;
        const titleY = node.y + (node.description || node.technology ? 28 : node.height / 2 + 4);
        return <g key={node.id} className={"diagram-node" + (selected ? " selected" : "") + (drag?.id === node.id ? " dragging" : "")}
          onPointerDown={(event) => startDrag(event, node)} onClick={(event) => { event.stopPropagation(); onSelectNode(node.id); }} style={{ cursor: "grab" }}>
          <path d={nodePath(node, paint.shape)} fill={paint.fill} stroke={selected ? tokens.accent : paint.stroke} strokeWidth={selected ? 2 : 1.2} />
          <path d={"M " + (node.x + 9) + " " + (node.y + 13) + " V " + (node.y + node.height - 13)} stroke={paint.accent} strokeWidth="3" strokeLinecap="round" opacity={node.role === "actor" || node.role === "source" ? 0.45 : 0.9} />
          <text x={node.x + 17} y={titleY + 1} fontSize="13" fontWeight="600" fill={paint.text}>{node.name.length > 25 ? node.name.slice(0, 24) + "…" : node.name}</text>
          {node.technology && <text x={node.x + 17} y={node.y + 47} fontSize="10" fill="#7B8798">{node.technology}</text>}
          {node.description && <text x={node.x + 17} y={node.y + (node.technology ? 64 : 52)} fontSize="10" fill={paint.muted}>{node.description.length > 27 ? node.description.slice(0, 26) + "…" : node.description}</text>}
          {node.layoutHints?.locked && <text x={node.x + node.width - 16} y={node.y + 15} textAnchor="middle" fontSize="10" fill="#718096">●</text>}
        </g>;
      })}
    </svg>
  );
}