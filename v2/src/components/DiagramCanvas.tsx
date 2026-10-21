import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { DiagramBoundary, DiagramDocument, DiagramNode, DiagramRelation, Point, SequenceFragment } from "../model/types";
import { nodePaint, relationPaint } from "../design/styles";
import { tokens } from "../design/tokens";
import { diagramPalette, DIAGRAM_FONT_STACK, RENDER_METRICS, normalizeRenderTheme, sequenceActivationGeometry, sequenceLifelineBottom, sequenceFragmentVerticalGeometry } from "../design/render-spec";
import { measureTextWidth, truncateTextToWidth, wrapTextToWidth } from "../design/text-metrics";
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
  onCreateRelation: (sourceId: string, targetId: string) => void;
  onReconnectRelation: (relationId: string, endpoint: "source" | "target", nodeId: string) => void;
  onRenameNode: (nodeId: string, name: string) => void;
  onUpdateRelationLabel: (relationId: string, label: string) => void;
  onUpdateSequenceFragment: (fragmentId: string, patch: Partial<SequenceFragment>) => void;
  onUpdateBoundary: (boundaryId: string, patch: Partial<DiagramBoundary>) => void;
  connectionSourceId: string | null;
  onConnectionSourceChange: (nodeId: string | null) => void;
  onContextMenu: (target: { kind: "node" | "relation" | "fragment" | "boundary" | "canvas"; id?: string }, x: number, y: number) => void;
}
interface DragState { id: string; offsetX: number; offsetY: number; x: number; y: number; originX: number; originY: number; }
interface PanState { startClientX: number; startClientY: number; originX: number; originY: number; }
interface ConnectionDrag { sourceId: string; start: Point; current: Point; relationId?: string; endpoint?: "source" | "target"; }
interface FragmentDrag { id: string; endpoint: "start" | "end"; currentOrder: number; }

function center(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
function relationPath(document: DiagramDocument, relation: DiagramRelation): { d: string; label: Point; start: Point; end: Point } | null {
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
      label = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio - RENDER_METRICS.relation.labelOffsetY };
      break;
    }
    remaining -= segment;
  }
  return { d, label, start: all[0], end: all[all.length - 1] };
}
function nodePath(node: DiagramNode, shape: string, requestedRadius = tokens.nodeRadius): string {
  if (shape === "pill") {
    const radius = Math.min(requestedRadius, node.width / 2, node.height / 2);
    return "M " + (node.x + radius) + " " + node.y + " H " + (node.x + node.width - radius) + " Q " + (node.x + node.width) + " " + node.y + " " + (node.x + node.width) + " " + (node.y + radius) + " V " + (node.y + node.height - radius) + " Q " + (node.x + node.width) + " " + (node.y + node.height) + " " + (node.x + node.width - radius) + " " + (node.y + node.height) + " H " + (node.x + radius) + " Q " + node.x + " " + (node.y + node.height) + " " + node.x + " " + (node.y + node.height - radius) + " V " + (node.y + radius) + " Q " + node.x + " " + node.y + " " + (node.x + radius) + " " + node.y + " Z";
  }
  if (shape === "diamond") return "M " + (node.x + node.width / 2) + " " + node.y + " L " + (node.x + node.width) + " " + (node.y + node.height / 2) + " L " + (node.x + node.width / 2) + " " + (node.y + node.height) + " L " + node.x + " " + (node.y + node.height / 2) + " Z";
  const radius = Math.min(requestedRadius, node.width / 2, node.height / 2);
  return "M " + (node.x + radius) + " " + node.y + " H " + (node.x + node.width - radius) + " Q " + (node.x + node.width) + " " + node.y + " " + (node.x + node.width) + " " + (node.y + radius) + " V " + (node.y + node.height - radius) + " Q " + (node.x + node.width) + " " + (node.y + node.height) + " " + (node.x + node.width - radius) + " " + (node.y + node.height) + " H " + (node.x + radius) + " Q " + node.x + " " + (node.y + node.height) + " " + node.x + " " + (node.y + node.height - radius) + " V " + (node.y + radius) + " Q " + node.x + " " + node.y + " " + (node.x + radius) + " " + node.y + " Z";
}
export default function DiagramCanvas({
  document, zoom, viewResetToken, selectedNodeId, selectedRelationId, onSelectNode, onSelectRelation, onMoveNode,
  onCreateRelation, onReconnectRelation, onRenameNode, onUpdateRelationLabel, onUpdateSequenceFragment, onUpdateBoundary, connectionSourceId,
  onConnectionSourceChange, onContextMenu
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [panGesture, setPanGesture] = useState<PanState | null>(null);
  const [connectionDrag, setConnectionDrag] = useState<ConnectionDrag | null>(null);
  const [fragmentDrag, setFragmentDrag] = useState<FragmentDrag | null>(null);
  const [editingFragmentId, setEditingFragmentId] = useState<string | null>(null);
  const [fragmentLabelDraft, setFragmentLabelDraft] = useState("");
  const [editingBoundaryId, setEditingBoundaryId] = useState<string | null>(null);
  const [boundaryNameDraft, setBoundaryNameDraft] = useState("");
  const [editingRelationId, setEditingRelationId] = useState<string | null>(null);
  const [relationLabelDraft, setRelationLabelDraft] = useState("");
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [nodeNameDraft, setNodeNameDraft] = useState("");
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
    if (connectionSourceId) return;
    const point = pointerToDiagram(event.clientX, event.clientY);
    setDrag({ id: node.id, offsetX: point.x - node.x, offsetY: point.y - node.y, x: node.x, y: node.y, originX: node.x, originY: node.y });
    onSelectNode(node.id);
    svgRef.current?.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function startConnection(event: ReactPointerEvent<SVGCircleElement>, node: DiagramNode, start: Point) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDrag(null);
    setPanGesture(null);
    setConnectionDrag({ sourceId: node.id, start, current: pointerToDiagram(event.clientX, event.clientY) });
    onSelectNode(node.id);
    onConnectionSourceChange(null);
    svgRef.current?.setPointerCapture(event.pointerId);
  }
  function startFragmentResize(event: ReactPointerEvent<SVGCircleElement>, fragment: SequenceFragment, endpoint: "start" | "end", point: Point) {
    if (event.button !== 0 || document.kind !== "sequence") return;
    event.preventDefault();
    event.stopPropagation();
    setDrag(null);
    setConnectionDrag(null);
    setPanGesture(null);
    setFragmentDrag({ id: fragment.id, endpoint, currentOrder: endpoint === "start" ? fragment.startOrder : fragment.endOrder });
    svgRef.current?.setPointerCapture(event.pointerId);
    void point;
  }
  function startReconnect(event: ReactPointerEvent<SVGCircleElement>, relation: DiagramRelation, endpoint: "source" | "target", start: Point) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setDrag(null);
    setPanGesture(null);
    setConnectionDrag({ sourceId: endpoint === "source" ? relation.source : relation.target, start,
      current: pointerToDiagram(event.clientX, event.clientY), relationId: relation.id, endpoint });
    svgRef.current?.setPointerCapture(event.pointerId);
  }
  function finishRelationLabel(commit: boolean, value = relationLabelDraft) {
    if (commit && editingRelationId) onUpdateRelationLabel(editingRelationId, value);
    setEditingRelationId(null);
    setRelationLabelDraft("");
  }
  function finishNodeName(commit: boolean, value = nodeNameDraft) {
    if (commit && editingNodeId && value.trim()) onRenameNode(editingNodeId, value.trim());
    setEditingNodeId(null);
    setNodeNameDraft("");
  }
  function finishFragmentLabel(commit: boolean, value = fragmentLabelDraft) {
    if (commit && editingFragmentId) onUpdateSequenceFragment(editingFragmentId, { label: value.trim().slice(0, 500) });
    setEditingFragmentId(null);
    setFragmentLabelDraft("");
  }
  function finishBoundaryName(commit: boolean, value = boundaryNameDraft) {
    if (commit && editingBoundaryId) onUpdateBoundary(editingBoundaryId, { name: value.trim().slice(0, 200) });
    setEditingBoundaryId(null);
    setBoundaryNameDraft("");
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
    if (fragmentDrag) {
      const point = pointerToDiagram(event.clientX, event.clientY);
      const maxOrder = Math.max(0, document.relations.length - 1);
      const rawOrder = fragmentDrag.endpoint === "start"
        ? Math.round((point.y - 126) / 72)
        : Math.round((point.y - 170) / 72);
      setFragmentDrag({ ...fragmentDrag, currentOrder: Math.max(0, Math.min(maxOrder, rawOrder)) });
      return;
    }
    if (connectionDrag) {
      setConnectionDrag({ ...connectionDrag, current: pointerToDiagram(event.clientX, event.clientY) });
      return;
    }
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
  function endDrag(event: ReactPointerEvent<SVGSVGElement>) {
    if (fragmentDrag) {
      const fragment = document.sequence?.fragments?.find((item) => item.id === fragmentDrag.id);
      if (fragment) onUpdateSequenceFragment(fragment.id, fragmentDrag.endpoint === "start"
        ? { startOrder: Math.min(fragmentDrag.currentOrder, fragment.endOrder) }
        : { endOrder: Math.max(fragmentDrag.currentOrder, fragment.startOrder) });
      setFragmentDrag(null);
      setPanGesture(null);
      return;
    }
    if (connectionDrag) {
      const point = pointerToDiagram(event.clientX, event.clientY);
      const target = [...displayNodes].reverse().find((node) =>
        node.id !== connectionDrag.sourceId &&
        point.x >= node.x && point.x <= node.x + node.width &&
        point.y >= node.y && point.y <= node.y + node.height
      );
      if (target) {
        if (connectionDrag.relationId && connectionDrag.endpoint) onReconnectRelation(connectionDrag.relationId, connectionDrag.endpoint, target.id);
        else onCreateRelation(connectionDrag.sourceId, target.id);
      }
      setConnectionDrag(null);
      setPanGesture(null);
      return;
    }
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
  const displaySequence = document.sequence && fragmentDrag ? {
    ...document.sequence,
    fragments: (document.sequence.fragments || []).map((fragment) => fragment.id !== fragmentDrag.id ? fragment : ({
      ...fragment,
      startOrder: fragmentDrag.endpoint === "start" ? Math.min(fragmentDrag.currentOrder, fragment.endOrder) : fragment.startOrder,
      endOrder: fragmentDrag.endpoint === "end" ? Math.max(fragmentDrag.currentOrder, fragment.startOrder) : fragment.endOrder
    }))
  } : document.sequence;
  const displayDoc = { ...document, nodes: displayNodes, sequence: displaySequence };
  const renderTheme = normalizeRenderTheme(document.renderTheme);
  const palette = diagramPalette(renderTheme);
  const markerId = (relationId: string, kind: "arrow" | "arrow-open") =>
    safeSvgId + "-edge-" + relationId.replace(/[^a-zA-Z0-9_-]/g, "-") + "-" + kind;

  return (
    <svg ref={svgRef} data-render-theme={renderTheme} className={"diagram-svg" + (panGesture ? " is-panning" : "")}
      viewBox={(frame.width * (1 - 1 / zoom) / 2 + pan.x) + " " + (frame.height * (1 - 1 / zoom) / 2 + pan.y) + " " + (frame.width / zoom) + " " + (frame.height / zoom)}
      preserveAspectRatio={document.kind === "flowchart" ? "xMidYMin meet" : "xMidYMid meet"} onPointerDown={startPan}
      onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => { setConnectionDrag(null); setDrag(null); setPanGesture(null); }}
      onContextMenu={(event) => { event.preventDefault(); onContextMenu({ kind: "canvas" }, event.clientX, event.clientY); }}
      role="group" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <title id={titleId}>{document.title}</title>
      <desc id={descriptionId}>{document.kind.toUpperCase() + " diagram with " + document.nodes.length + " nodes and " + document.relations.length + " relationships."}</desc>
      <defs>
        <pattern id={safeSvgId + "-studio-grid"} width={tokens.grid * 6} height={tokens.grid * 6} patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill={palette.grid} /></pattern>
        {displayDoc.relations.map((relation) => {
          const paint = relationPaint(relation, renderTheme);
          return <marker key={relation.id + "-closed"} id={markerId(relation.id, "arrow")} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={RENDER_METRICS.relation.arrowSize} markerHeight={RENDER_METRICS.relation.arrowSize} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={paint.endFill ? paint.stroke : "none"} stroke={paint.endFill ? "none" : paint.stroke} strokeWidth={RENDER_METRICS.relation.returnStrokeWidth} />
          </marker>;
        })}
        {displayDoc.relations.map((relation) => {
          const paint = relationPaint(relation, renderTheme);
          return <marker key={relation.id + "-open"} id={markerId(relation.id, "arrow-open")} viewBox="0 0 10 10" refX="9" refY="5" markerWidth={RENDER_METRICS.relation.arrowSize} markerHeight={RENDER_METRICS.relation.arrowSize} orient="auto-start-reverse">
            <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke={paint.stroke} strokeWidth={RENDER_METRICS.relation.returnStrokeWidth} />
          </marker>;
        })}
      </defs>
      <rect width={frame.width} height={frame.height} fill={palette.canvas} />
      <rect width={frame.width} height={frame.height} fill={"url(#" + safeSvgId + "-studio-grid)"} />
      {displayDoc.boundaries.map((boundary) => {
        const members = displayNodes.filter((node) => boundary.members.includes(node.id));
        if (!members.length) return null;
        const left = Math.min(...members.map((node) => node.x)) - document.layout.boundaryPadding;
        const top = Math.min(...members.map((node) => node.y)) - document.layout.boundaryPadding - 16;
        const right = Math.max(...members.map((node) => node.x + node.width)) + document.layout.boundaryPadding;
        const bottom = Math.max(...members.map((node) => node.y + node.height)) + document.layout.boundaryPadding;
        return <g key={boundary.id} className="diagram-boundary"
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ kind: "boundary", id: boundary.id }, event.clientX, event.clientY); }}
          onDoubleClick={(event) => { event.stopPropagation(); setEditingBoundaryId(boundary.id); setBoundaryNameDraft(boundary.name); }}>
          <rect className="diagram-boundary-frame" x={left} y={top} width={right - left} height={bottom - top} rx={RENDER_METRICS.boundary.radius} fill={palette.boundaryFill} fillOpacity={palette.boundaryOpacity} stroke={palette.boundaryStroke} strokeWidth={RENDER_METRICS.boundary.strokeWidth} strokeDasharray={RENDER_METRICS.boundary.dashPattern} />
          {editingBoundaryId !== boundary.id && <text className="diagram-boundary-label" x={left + 14} y={top + 20} fontFamily={DIAGRAM_FONT_STACK} fontSize={RENDER_METRICS.boundaryLabel.size} fontWeight={RENDER_METRICS.boundaryLabel.weight} fill={palette.boundaryText}>{boundary.name.toUpperCase()}</text>}
          {editingBoundaryId === boundary.id && <foreignObject x={left + 8} y={top + 3} width={Math.max(140, right - left - 16)} height="30">
            <input className="boundary-inline-input" aria-label="Rename boundary" autoFocus onPointerDown={(event) => event.stopPropagation()}
              value={boundaryNameDraft} onChange={(event) => setBoundaryNameDraft(event.currentTarget.value)}
              onBlur={(event) => { if (event.currentTarget.dataset.cancelled !== "true") finishBoundaryName(true, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.currentTarget.dataset.cancelled = "true"; finishBoundaryName(false); }
              }} />
          </foreignObject>}
        </g>;
      })}
      {document.kind === "sequence" && (displayDoc.sequence?.fragments || []).map((fragment) => {
        const fragmentParticipantIds = fragment.participants?.length
          ? fragment.participants
          : (document.sequence?.participants || []);
        const participantNodes = displayNodes.filter((node) => fragmentParticipantIds.includes(node.id));
        if (!participantNodes.length) return null;
        const left = Math.min(...participantNodes.map((node) => node.x)) - 12;
        const right = Math.max(...participantNodes.map((node) => node.x + node.width)) + 12;
        const vertical = sequenceFragmentVerticalGeometry(fragment);
        const top = vertical.top;
        const bottom = vertical.bottom;
        const tag = fragment.kind.toUpperCase();
        const tagWidth = Math.max(44, tag.length * 8.6 + 16);
        return <g key={fragment.id} className="sequence-fragment"
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ kind: "fragment", id: fragment.id }, event.clientX, event.clientY); }}
          onDoubleClick={(event) => { event.stopPropagation(); setEditingFragmentId(fragment.id); setFragmentLabelDraft(fragment.label); }}>
          <rect className="sequence-fragment-frame" x={left} y={top} width={right - left} height={bottom - top} rx={RENDER_METRICS.fragment.radius} fill={palette.fragmentFill} fillOpacity={palette.fragmentOpacity} stroke={palette.fragmentStroke} strokeWidth={RENDER_METRICS.fragment.strokeWidth} strokeDasharray={RENDER_METRICS.fragment.dashPattern} />
          <rect className="sequence-fragment-tag" x={left + 10} y={top - 2} width={tagWidth} height={RENDER_METRICS.fragment.tagHeight} rx={RENDER_METRICS.fragment.tagRadius} fill={palette.fragmentTagFill} stroke={palette.fragmentTagStroke} strokeWidth={RENDER_METRICS.fragment.strokeWidth} />
          <text className="sequence-fragment-kind" x={left + 18} y={top + 15} fontFamily={DIAGRAM_FONT_STACK} fontSize={RENDER_METRICS.fragmentLabel.size} fontWeight={RENDER_METRICS.fragmentLabel.weight} fill={palette.fragmentText}>{tag}</text>
          {editingFragmentId !== fragment.id && <text className="sequence-fragment-label" x={left + 10 + tagWidth + 10} y={top + 15} fontFamily={DIAGRAM_FONT_STACK} fontSize={RENDER_METRICS.fragmentLabel.size} fontWeight={RENDER_METRICS.fragmentLabel.weight} fill={palette.fragmentText}>{fragment.label}</text>}
          {editingFragmentId === fragment.id && <foreignObject x={left + 10 + tagWidth + 5} y={top - 1} width={Math.max(130, right - left - tagWidth - 25)} height="26">
            <input className="fragment-inline-input" aria-label="Edit sequence fragment label" autoFocus onPointerDown={(event) => event.stopPropagation()}
              value={fragmentLabelDraft} onChange={(event) => setFragmentLabelDraft(event.currentTarget.value)}
              onBlur={(event) => { if (event.currentTarget.dataset.cancelled !== "true") finishFragmentLabel(true, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.currentTarget.dataset.cancelled = "true"; finishFragmentLabel(false); }
              }} />
          </foreignObject>}
          <circle className="fragment-resize-handle" cx={right - 9} cy={top} r="5"
            aria-label="Change fragment start message" onPointerDown={(event) => startFragmentResize(event, fragment, "start", { x: right - 9, y: top })} />
          <circle className="fragment-resize-handle" cx={right - 9} cy={bottom} r="5"
            aria-label="Change fragment end message" onPointerDown={(event) => startFragmentResize(event, fragment, "end", { x: right - 9, y: bottom })} />
        </g>;
      })}
      {document.kind === "sequence" && displayNodes.map((node) => <line className="sequence-lifeline" key={node.id + "-lifeline"} x1={center(node).x} y1={node.y + node.height} x2={center(node).x} y2={sequenceLifelineBottom(document.relations.length)} stroke={palette.lifelineStroke} strokeWidth={RENDER_METRICS.relation.lifelineStrokeWidth} strokeDasharray={RENDER_METRICS.relation.lifelineDashPattern} />)}
      {document.kind === "sequence" && deriveSequenceActivations(displayDoc).map((activation) => {
        const participant = displayNodes.find((node) => node.id === activation.participantId);
        if (!participant) return null;
        // The same insets and minimum height are used by the native mxGraph cells.
        const geometry = sequenceActivationGeometry(activation.startOrder, activation.endOrder, center(participant).x);
        return <rect className="sequence-activation" key={activation.id} x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height} rx="0"
          fill={palette.activationFill} stroke={palette.activationStroke} strokeWidth="1" />;
      })}
      {connectionSourceId && <text className="connection-mode-hint" x={24} y={30} fontSize="13" fontWeight="600" fill={palette.accent}>Connecting from {displayNodes.find((node) => node.id === connectionSourceId)?.name || "node"} · select a target or press Esc</text>}
      {connectionDrag && <path className="connection-preview" d={"M " + connectionDrag.start.x + " " + connectionDrag.start.y + " L " + connectionDrag.current.x + " " + connectionDrag.current.y} fill="none" stroke={palette.accent} strokeWidth="2" strokeDasharray="6 4" pointerEvents="none" />}
      {displayDoc.relations.map((relation) => {
        const path = relationPath(displayDoc, relation);
        if (!path) return null;
        const paint = relationPaint(relation, renderTheme);
        const selected = selectedRelationId === relation.id;
        const sourceNode = displayNodes.find((node) => node.id === relation.source);
        const targetNode = displayNodes.find((node) => node.id === relation.target);
        const accessibleRelation = "Relation from " + (sourceNode?.name || relation.source) + " to " + (targetNode?.name || relation.target) + (relation.label ? ": " + relation.label : "");
        const labelWidth = Math.max(48, measureTextWidth(relation.label, paint.fontSize) + 20);
        return <g key={relation.id} className={"diagram-relation" + (selected ? " selected" : "")}
          role="button" tabIndex={0} aria-label={accessibleRelation}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => selectRelation(event, relation.id)}
          onDoubleClick={(event) => { event.stopPropagation(); setEditingRelationId(relation.id); setRelationLabelDraft(relation.label); }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ kind: "relation", id: relation.id }, event.clientX, event.clientY); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectRelation(relation.id); } }}
          style={{ cursor: "pointer" }}>
          <path className="relation-hit-area" d={path.d} fill="none" stroke="transparent" strokeWidth="18" pointerEvents="stroke" />
          <path className="relation-visible-path" d={path.d} fill="none" stroke={selected ? palette.selected : paint.stroke}
            strokeWidth={selected ? Math.max(2.8, paint.width + 1.1) : paint.width}
            strokeDasharray={paint.dash || undefined}
            markerStart={paint.startArrow && paint.startArrow !== "none" ? "url(#" + markerId(relation.id, paint.startArrow === "open" ? "arrow-open" : "arrow") + ")" : undefined}
            markerEnd={paint.marker ? "url(#" + markerId(relation.id, paint.marker) + ")" : undefined}
            strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
          {relation.label && editingRelationId !== relation.id && <g className="relation-label" pointerEvents="none">
            <rect className="relation-label-bg" x={path.label.x - labelWidth / 2} y={path.label.y - RENDER_METRICS.relation.labelBackgroundOffsetY} width={labelWidth} height={RENDER_METRICS.relation.labelBackgroundHeight} rx="0" fill={paint.labelBackground} fillOpacity="1" />
            <text className="relation-label-text" x={path.label.x} y={path.label.y + RENDER_METRICS.relation.labelTextBaselineOffsetY} textAnchor="middle" fontFamily={paint.fontFamily === "Arial" ? DIAGRAM_FONT_STACK : paint.fontFamily} fontSize={paint.fontSize} fontWeight={RENDER_METRICS.relationLabel.weight} fill={paint.fontColor}>{relation.label}</text>
          </g>}
          {selected && <>
            <circle className="relation-endpoint-handle" cx={path.start.x} cy={path.start.y} r="5.5"
              aria-label="Reconnect relation source" onPointerDown={(event) => startReconnect(event, relation, "source", path.start)} />
            <circle className="relation-endpoint-handle" cx={path.end.x} cy={path.end.y} r="5.5"
              aria-label="Reconnect relation target" onPointerDown={(event) => startReconnect(event, relation, "target", path.end)} />
          </>}
          {editingRelationId === relation.id && <foreignObject x={path.label.x - Math.max(58, labelWidth / 2)} y={path.label.y - 18} width={Math.max(116, labelWidth)} height="34">
            <input className="relation-inline-input" aria-label="Edit relation label" autoFocus
              value={relationLabelDraft} onChange={(event) => setRelationLabelDraft(event.currentTarget.value)}
              onBlur={(event) => { if (event.currentTarget.dataset.cancelled !== "true") finishRelationLabel(true, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.currentTarget.dataset.cancelled = "true"; finishRelationLabel(false); }
              }}
            />
          </foreignObject>}
        </g>;
      })}
      {displayNodes.map((node) => {
        const paint = nodePaint(node, renderTheme);
        const selected = selectedNodeId === node.id;
        const titleY = node.y + (node.description || node.technology ? 28 : node.height / 2 + 4);
        const centeredFlowNode = document.kind === "flowchart" && ["decision", "start", "end"].includes(node.role);
        // One type size everywhere: 13px averages ~6.8px per glyph, so the label budget comes from node width.
        const availableTextWidth = Math.max(0, node.width - 34);
        const compactTitle = truncateTextToWidth(node.name, availableTextWidth, RENDER_METRICS.title.size);
        const technologyLabel = node.technology ? truncateTextToWidth(node.technology, availableTextWidth, RENDER_METRICS.secondary.size) : "";
        const descriptionY = node.y + (node.technology ? 64 : 52);
        const descriptionLineCapacity = node.description
          ? Math.max(1, Math.floor((node.height - (node.technology ? 64 : 52) - 6) / 12) + 1)
          : 0;
        const descriptionLines = node.description
          ? wrapTextToWidth(node.description, availableTextWidth, RENDER_METRICS.secondary.size, descriptionLineCapacity)
          : [];
        const accessibleNode = "Node: " + node.name + (node.technology ? ". Technology: " + node.technology : "") + (node.description ? ". Description: " + node.description : "");
        return <g key={node.id} data-node-id={node.id} data-role={node.role}
          className={"diagram-node" + (selected ? " selected" : "") + (drag?.id === node.id ? " dragging" : "") + (connectionSourceId === node.id ? " connection-source" : "")}
          role="button" tabIndex={0} aria-label={accessibleNode}
          onPointerDown={(event) => startDrag(event, node)}
          onClick={(event) => {
            event.stopPropagation();
            if (connectionSourceId) {
              if (connectionSourceId !== node.id) onCreateRelation(connectionSourceId, node.id);
              onConnectionSourceChange(null);
              return;
            }
            onSelectNode(node.id);
          }}
          onDoubleClick={(event) => { event.stopPropagation(); setEditingNodeId(node.id); setNodeNameDraft(node.name); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectNode(node.id); } }}
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onContextMenu({ kind: "node", id: node.id }, event.clientX, event.clientY); }}
          style={{ cursor: connectionSourceId && connectionSourceId !== node.id ? "crosshair" : "grab" }}>
          <title>{accessibleNode}</title>
          <path d={nodePath(node, paint.shape, paint.radius)} fill={paint.fill} stroke={selected ? palette.selected : paint.stroke} strokeWidth={selected ? 2.4 : paint.strokeWidth} />
          {!["decision", "start", "end"].includes(node.role) && <path d={"M " + (node.x + RENDER_METRICS.node.accentInsetX) + " " + (node.y + RENDER_METRICS.node.accentInsetY) + " V " + (node.y + node.height - RENDER_METRICS.node.accentInsetY)} stroke={paint.accent} strokeWidth={RENDER_METRICS.node.accentWidth} strokeLinecap="round" opacity={node.role === "actor" || node.role === "source" ? 0.6 : 1} />}
          {editingNodeId !== node.id && <text x={centeredFlowNode ? node.x + node.width / 2 : node.x + 17} y={titleY + 1}
            textAnchor={centeredFlowNode ? "middle" : "start"} fontFamily={paint.fontFamily === "Arial" ? DIAGRAM_FONT_STACK : paint.fontFamily} fontSize={paint.fontSize} fontWeight={paint.fontWeight} fill={paint.text}>{compactTitle}</text>}
          {editingNodeId === node.id && <foreignObject x={node.x + 8} y={node.y + 8} width={Math.max(80, node.width - 16)} height="34">
            <input className="node-inline-input" aria-label="Rename node" autoFocus
              onPointerDown={(event) => event.stopPropagation()}
              value={nodeNameDraft} onChange={(event) => setNodeNameDraft(event.currentTarget.value)}
              onBlur={(event) => { if (event.currentTarget.dataset.cancelled !== "true") finishNodeName(true, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                if (event.key === "Escape") { event.currentTarget.dataset.cancelled = "true"; finishNodeName(false); }
              }}
            />
          </foreignObject>}
          {node.technology && <text x={node.x + 17} y={node.y + 47} fontFamily={paint.fontFamily === "Arial" ? DIAGRAM_FONT_STACK : paint.fontFamily} fontSize={RENDER_METRICS.secondary.size} fontWeight={RENDER_METRICS.secondary.weight} fill={paint.muted}>{technologyLabel}</text>}
          {node.description && <text fontFamily={paint.fontFamily === "Arial" ? DIAGRAM_FONT_STACK : paint.fontFamily} fontSize={RENDER_METRICS.secondary.size} fontWeight={RENDER_METRICS.secondary.weight} fill={paint.muted}>
            {descriptionLines.map((line, index) => <tspan key={index} x={node.x + 17} y={descriptionY + index * 12}>{line}</tspan>)}
          </text>}
          {node.layoutHints?.locked && <text x={node.x + node.width - 16} y={node.y + 17} textAnchor="middle" fontFamily={DIAGRAM_FONT_STACK} fontSize={RENDER_METRICS.secondary.size} fontWeight={RENDER_METRICS.secondary.weight} fill={paint.text}>●</text>}
          {!editingNodeId && <>
            <circle className="connection-handle" cx={node.x + node.width} cy={node.y + node.height / 2} r="5.5"
              aria-label={"Connect from " + node.name} onPointerDown={(event) => startConnection(event, node, { x: node.x + node.width, y: node.y + node.height / 2 })} />
            <circle className="connection-handle" cx={node.x} cy={node.y + node.height / 2} r="5.5"
              aria-label={"Connect from " + node.name} onPointerDown={(event) => startConnection(event, node, { x: node.x, y: node.y + node.height / 2 })} />
            <circle className="connection-handle" cx={node.x + node.width / 2} cy={node.y} r="5.5"
              aria-label={"Connect from " + node.name} onPointerDown={(event) => startConnection(event, node, { x: node.x + node.width / 2, y: node.y })} />
            <circle className="connection-handle" cx={node.x + node.width / 2} cy={node.y + node.height} r="5.5"
              aria-label={"Connect from " + node.name} onPointerDown={(event) => startConnection(event, node, { x: node.x + node.width / 2, y: node.y + node.height })} />
          </>}
        </g>;
      })}
    </svg>
  );
}