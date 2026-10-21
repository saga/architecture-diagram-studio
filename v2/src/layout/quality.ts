import type { DiagramDocument, LayoutQualityReport, Point, QualityIssue } from "../model/types";
import { sequenceMessageGeometry } from "./sequence";
import { countPortSpacingViolations } from "./routing";
import { measureTextWidth, containsWideCharacters, wrapTextToWidth } from "../design/text-metrics";
import { contrastRatio } from "../design/contrast";
import { nodePaint, relationPaint } from "../design/styles";
import { tokens } from "../design/tokens";
import { evaluateComplexityBudget } from "./complexity";

type Rect = { x: number; y: number; width: number; height: number };
function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function onSegment(a: Point, b: Point, p: Point): boolean {
  return p.x >= Math.min(a.x, b.x) - 0.001 && p.x <= Math.max(a.x, b.x) + 0.001 &&
    p.y >= Math.min(a.y, b.y) - 0.001 && p.y <= Math.max(a.y, b.y) + 0.001;
}
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = cross(a, b, c), o2 = cross(a, b, d);
  const o3 = cross(c, d, a), o4 = cross(c, d, b);
  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) &&
      (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) return true;
  if (Math.abs(o1) <= 0.001 && onSegment(a, b, c)) return true;
  if (Math.abs(o2) <= 0.001 && onSegment(a, b, d)) return true;
  if (Math.abs(o3) <= 0.001 && onSegment(c, d, a)) return true;
  if (Math.abs(o4) <= 0.001 && onSegment(c, d, b)) return true;
  return false;
}
function segmentIntersectsRect(a: Point, b: Point, rect: Rect): boolean {
  let tMin = 0, tMax = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - rect.x, rect.x + rect.width - a.x, a.y - rect.y, rect.y + rect.height - a.y];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 0.001) {
      if (q[i] < 0) return false;
      continue;
    }
    const ratio = q[i] / p[i];
    if (p[i] < 0) {
      if (ratio > tMax) return false;
      tMin = Math.max(tMin, ratio);
    } else {
      if (ratio < tMin) return false;
      tMax = Math.min(tMax, ratio);
    }
  }
  return tMin < tMax && tMax > 0 && tMin < 1;
}

/** Uses the same canonical sequence geometry as the SVG and Draw.io renderers. */
function pathFor(doc: DiagramDocument, id: string): Point[] {
  const edge = doc.relations.find((relation) => relation.id === id);
  if (!edge) return [];
  const source = doc.nodes.find((node) => node.id === edge.source);
  const target = doc.nodes.find((node) => node.id === edge.target);
  if (!source || !target) return [];
  if (doc.kind === "sequence") {
    const geometry = sequenceMessageGeometry(doc, edge);
    return geometry ? [geometry.start, ...geometry.points, geometry.end] : [];
  }
  const sc = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const tc = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const dx = tc.x - sc.x, dy = tc.y - sc.y;
  let start: Point, end: Point;
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
    start = { x: sc.x, y: dy >= 0 ? source.y + source.height : source.y };
    end = { x: tc.x, y: dy >= 0 ? target.y : target.y + target.height };
  } else if (dx >= 0) {
    start = { x: source.x + source.width, y: sc.y };
    end = { x: target.x, y: tc.y };
  } else {
    start = { x: source.x, y: sc.y };
    end = { x: target.x + target.width, y: tc.y };
  }
  start = edge.sourcePort || start;
  end = edge.targetPort || end;
  return [start, ...(edge.points || []), end];
}
function midpoint(points: Point[]): Point | null {
  if (points.length < 2) return null;
  const segments = points.slice(1).map((point, index) => ({
    start: points[index], end: point,
    length: Math.hypot(point.x - points[index].x, point.y - points[index].y)
  }));
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = total / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const ratio = segment.length < 0.001 ? 0.5 : remaining / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        y: segment.start.y + (segment.end.y - segment.start.y) * ratio
      };
    }
    remaining -= segment.length;
  }
  return points[points.length - 1];
}
function labelBoxes(doc: DiagramDocument): Array<Rect & { relationId: string }> {
  return doc.relations.filter((edge) => edge.label.trim()).flatMap((edge) => {
    const point = midpoint(pathFor(doc, edge.id));
    if (!point) return [];
    return [{
      relationId: edge.id,
      x: point.x - Math.max(24, measureTextWidth(edge.label, 13) / 2 + 10),
      y: point.y - 22,
      width: Math.max(48, measureTextWidth(edge.label, 13) + 20),
      height: 22
    }];
  });
}
function countComponents(doc: DiagramDocument): number {
  if (!doc.nodes.length) return 0;
  const adjacency = new Map(doc.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of doc.relations) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const visited = new Set<string>();
  let count = 0;
  for (const node of doc.nodes) {
    if (visited.has(node.id)) continue;
    count++;
    const stack = [node.id];
    visited.add(node.id);
    while (stack.length) {
      const id = stack.pop()!;
      for (const next of adjacency.get(id) || []) {
        if (!visited.has(next)) { visited.add(next); stack.push(next); }
      }
    }
  }
  return count;
}
function canvasBounds(doc: DiagramDocument): { width: number; height: number } {
  const messageBottom = doc.kind === "sequence" ? 148 + Math.max(0, doc.relations.length - 1) * 72 + 100 : 0;
  return {
    width: Math.max(1240, ...doc.nodes.map((node) => node.x + node.width + 100)),
    height: Math.max(doc.kind === "sequence" ? 820 : 760, messageBottom, ...doc.nodes.map((node) => node.y + node.height + 120))
  };
}
function isOffGrid(value: number, grid = 4): boolean {
  return Math.abs(value / grid - Math.round(value / grid)) > 0.001;
}
function pushContrastWarning(warnings: QualityIssue[], label: string, ratio: number, minimum: number, nodeIds?: string[], relationIds?: string[]) {
  if (ratio + 0.001 >= minimum) return 0;
  warnings.push({
    code: "contrast-violation",
    severity: "warning",
    message: label + " contrast ratio " + ratio.toFixed(2) + ":1 is below " + minimum.toFixed(1) + ":1",
    ...(nodeIds ? { nodeIds } : {}),
    ...(relationIds ? { relationIds } : {})
  });
  return 1;
}

export function evaluateLayout(doc: DiagramDocument): LayoutQualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  let nodeOverlaps = 0, edgeNodeIntersections = 0, edgeCrossings = 0, labelCollisions = 0;
  let labelOverflowCount = 0, cjkWidthViolations = 0, connectorRoutingViolations = 0;
  let edgeLabelOutOfBoundsCount = 0, contrastViolations = 0, offGridCoordinates = 0, gridCoordinates = 0;

  for (let i = 0; i < doc.nodes.length; i++) {
    for (let j = i + 1; j < doc.nodes.length; j++) {
      if (overlaps(doc.nodes[i], doc.nodes[j], 2)) {
        nodeOverlaps++;
        errors.push({ code: "node-overlap", severity: "error", message: doc.nodes[i].name + " overlaps " + doc.nodes[j].name, nodeIds: [doc.nodes[i].id, doc.nodes[j].id] });
      }
    }
  }
  for (const edge of doc.relations) {
    if (!doc.nodes.some((node) => node.id === edge.source) || !doc.nodes.some((node) => node.id === edge.target)) {
      errors.push({ code: "invalid-relation", severity: "error", message: "Relation " + edge.id + " references a missing source or target node", relationIds: [edge.id] });
    }
  }
  if (doc.boundaries.length > 3) warnings.push({
    code: "complexity-boundaries", severity: "warning",
    message: "Diagram has " + doc.boundaries.length + " boundaries; verify that zones remain visually hierarchical"
  });
  for (const boundary of doc.boundaries) {
    const missing = boundary.members.filter((id) => !doc.nodes.some((node) => node.id === id));
    if (missing.length) {
      errors.push({
        code: "invalid-boundary-member", severity: "error",
        message: "Boundary " + boundary.name + " contains missing node(s): " + missing.join(", ")
      });
    }
    if (new Set(boundary.members).size !== boundary.members.length) {
      warnings.push({
        code: "duplicate-boundary-member", severity: "warning",
        message: "Boundary " + boundary.name + " lists one or more members multiple times"
      });
    }
    if (boundary.members.length === 1) {
      warnings.push({
        code: "single-node-boundary", severity: "warning",
        message: "Boundary " + boundary.name + " contains only one node; verify that a grouping boundary is intended",
        nodeIds: [...boundary.members]
      });
    }
  }

  for (const node of doc.nodes) {
    if (node.x < 0 || node.y < 0) {
      errors.push({ code: "negative-position", severity: "error", message: node.name + " is positioned outside the canvas", nodeIds: [node.id] });
    }
    gridCoordinates += 2;
    if (isOffGrid(node.x)) offGridCoordinates++;
    if (isOffGrid(node.y)) offGridCoordinates++;

    const availableWidth = Math.max(0, node.width - 34);
    const singleLineFields = [
      { label: "title", value: node.name },
      ...(node.technology ? [{ label: "technology", value: node.technology }] : [])
    ];
    for (const field of singleLineFields) {
      if (measureTextWidth(field.value, 13) <= availableWidth) continue;
      labelOverflowCount++;
      const isCjk = containsWideCharacters(field.value);
      if (isCjk) cjkWidthViolations++;
      warnings.push({
        code: isCjk ? "cjk-text-overflow" : "node-text-overflow",
        severity: "warning",
        message: node.name + " " + field.label + " needs more than " + availableWidth.toFixed(0) + "px and will be visually truncated",
        nodeIds: [node.id]
      });
    }
    const descriptionStart = node.technology ? 64 : 52;
    const descriptionLines = node.description ? wrapTextToWidth(node.description, availableWidth, 13) : [];
    const requiredHeight = node.description
      ? descriptionStart + Math.max(0, descriptionLines.length - 1) * 15 + 10
      : node.technology ? 53 : 0;
    if (requiredHeight > node.height) {
      labelOverflowCount++;
      warnings.push({
        code: "node-text-height-overflow",
        severity: "warning",
        message: node.name + " wrapped content needs about " + requiredHeight + "px but the node is " + node.height + "px high",
        nodeIds: [node.id]
      });
    }
  }

  if (doc.kind === "sequence") {
    const maxOrder = doc.relations.length - 1;
    for (const fragment of doc.sequence?.fragments || []) {
      if (fragment.startOrder < 0 || fragment.endOrder > maxOrder) {
        warnings.push({
          code: "sequence-fragment-out-of-range", severity: "warning",
          message: "Sequence fragment " + fragment.id + " extends beyond the current message timeline",
          relationIds: doc.relations.filter((edge) => edge.sequenceOrder === fragment.startOrder || edge.sequenceOrder === fragment.endOrder).map((edge) => edge.id)
        });
      }
      const missingParticipants = (fragment.participants || []).filter((id) => !doc.nodes.some((node) => node.id === id));
      if (missingParticipants.length) warnings.push({
        code: "sequence-fragment-invalid-participant", severity: "warning",
        message: "Sequence fragment " + fragment.id + " references missing participant(s): " + missingParticipants.join(", "),
        nodeIds: missingParticipants
      });
    }
  }

  const edgeNodeIssueRelationIds = new Set<string>();
  const edgeNodeIssueNodeIds = new Set<string>();
  const paths = doc.relations.map((edge) => ({ id: edge.id, points: pathFor(doc, edge.id) }));
  for (const path of paths) {
    const edge = doc.relations.find((item) => item.id === path.id);
    const routing = edge?.routing || doc.layout.routing;
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i], b = path.points[i + 1];
      if (doc.kind !== "sequence" && routing === "orthogonal" &&
          Math.abs(a.x - b.x) > 0.001 && Math.abs(a.y - b.y) > 0.001) {
        connectorRoutingViolations++;
        errors.push({ code: "diagonal-orthogonal-route", severity: "error", message: "Orthogonal relation " + path.id + " contains a diagonal segment", relationIds: [path.id] });
      }
      let hit = false;
      for (const node of doc.nodes) {
        if (!edge || node.id === edge.source || node.id === edge.target) continue;
        if (!segmentIntersectsRect(a, b, node)) continue;
        hit = true;
        edgeNodeIssueNodeIds.add(node.id);
      }
      if (hit) {
        edgeNodeIntersections++;
        if (edge) edgeNodeIssueRelationIds.add(edge.id);
      }
    }
  }
  const crossedRelationIds = new Set<string>();
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const left = doc.relations.find((r) => r.id === paths[i].id);
      const right = doc.relations.find((r) => r.id === paths[j].id);
      if (!left || !right || [left.source, left.target].some((id) => id === right.source || id === right.target)) continue;
      let crossed = false;
      for (let ai = 0; ai < paths[i].points.length - 1 && !crossed; ai++) {
        for (let bi = 0; bi < paths[j].points.length - 1; bi++) {
          if (intersects(paths[i].points[ai], paths[i].points[ai + 1], paths[j].points[bi], paths[j].points[bi + 1])) {
            crossed = true;
            break;
          }
        }
      }
      if (crossed) {
        edgeCrossings++;
        crossedRelationIds.add(left.id);
        crossedRelationIds.add(right.id);
      }
    }
  }

  const boxes = labelBoxes(doc);
  const bounds = canvasBounds(doc);
  for (let i = 0; i < boxes.length; i++) {
    const current = boxes[i];
    const edge = doc.relations.find((item) => item.id === current.relationId);
    const collidesWithNode = doc.nodes.some((node) =>
      node.id !== edge?.source && node.id !== edge?.target && overlaps(current, node, 0)
    );
    const collidesWithLabel = boxes.slice(i + 1).some((other) => overlaps(current, other, 2));
    if (collidesWithNode || collidesWithLabel) labelCollisions++;
    if (current.x < 0 || current.y < 0 || current.x + current.width > bounds.width || current.y + current.height > bounds.height) {
      edgeLabelOutOfBoundsCount++;
      warnings.push({
        code: "edge-label-out-of-bounds", severity: "warning",
        message: "Label for relation " + current.relationId + " extends outside the diagram canvas",
        relationIds: [current.relationId]
      });
    }
  }

  const disconnectedComponents = Math.max(0, countComponents(doc) - 1);
  const alignmentScore = Math.max(0, 1 - nodeOverlaps / Math.max(1, doc.nodes.length));
  const gridAlignmentScore = gridCoordinates ? Math.max(0, 1 - offGridCoordinates / gridCoordinates) : 1;
  const xs = doc.nodes.map((node) => node.x), ys = doc.nodes.map((node) => node.y);
  const area = Math.max(1, (Math.max(...xs, 1) - Math.min(...xs, 0) + 240) * (Math.max(...ys, 1) - Math.min(...ys, 0) + 200));
  const occupancy = doc.nodes.reduce((sum, node) => sum + node.width * node.height, 0) / area;
  const whitespaceScore = Math.max(0, Math.min(1, 1 - Math.abs(occupancy - 0.18) * 2));
  const densityScore = Math.max(0, Math.min(1, 1 - doc.nodes.length / 32));
  const portSpacingViolations = countPortSpacingViolations(doc);

  if (edgeNodeIntersections) errors.push({
    code: "edge-through-node", severity: "error",
    message: edgeNodeIntersections + " routed segment(s) cross a non-endpoint node",
    nodeIds: [...edgeNodeIssueNodeIds], relationIds: [...edgeNodeIssueRelationIds]
  });
  if (edgeCrossings) warnings.push({
    code: "edge-crossing", severity: "warning",
    message: edgeCrossings + " possible edge crossing(s)",
    relationIds: [...crossedRelationIds]
  });
  if (labelCollisions) warnings.push({
    code: "label-collision", severity: "warning",
    message: labelCollisions + " estimated edge-label collision(s)",
    relationIds: [...new Set(boxes.filter((current) => {
      const edge = doc.relations.find((item) => item.id === current.relationId);
      const collidesWithNode = doc.nodes.some((node) => node.id !== edge?.source && node.id !== edge?.target && overlaps(current, node, 0));
      const collidesWithLabel = boxes.some((other) => other.relationId !== current.relationId && overlaps(current, other, 2));
      return collidesWithNode || collidesWithLabel;
    }).map((box) => box.relationId))]
  });
  if (disconnectedComponents) warnings.push({ code: "disconnected-components", severity: "warning", message: disconnectedComponents + " disconnected component(s) beyond the first" });
  if (offGridCoordinates) warnings.push({ code: "off-grid-node", severity: "warning", message: offGridCoordinates + " node coordinate(s) are not aligned to the 4px grid" });
  if (portSpacingViolations) warnings.push({ code: "port-spacing", severity: "warning", message: portSpacingViolations + " connector port pair(s) are closer than their minimum spacing" });

  for (const node of doc.nodes) {
    const paint = nodePaint(node);
    contrastViolations += pushContrastWarning(warnings, "Text on node " + node.name, contrastRatio(paint.text, paint.fill), 4.5, [node.id]);
    contrastViolations += pushContrastWarning(warnings, "Border of node " + node.name, contrastRatio(paint.stroke, paint.fill), 3, [node.id]);
  }
  for (const relation of doc.relations) {
    const paint = relationPaint(relation);
    contrastViolations += pushContrastWarning(warnings, "Relation " + (relation.label || relation.id), contrastRatio(paint.stroke, tokens.canvas), 3, undefined, [relation.id]);
    if (relation.label) contrastViolations += pushContrastWarning(warnings, "Label for relation " + relation.id, contrastRatio(tokens.ink, tokens.canvas), 4.5, undefined, [relation.id]);
  }
  const complexityIssues = evaluateComplexityBudget(doc);
  warnings.push(...complexityIssues);

  const score = Math.max(0, Math.round(
    100 - nodeOverlaps * 80 - edgeNodeIntersections * 100 - connectorRoutingViolations * 80 -
    edgeLabelOutOfBoundsCount * 25 - edgeCrossings * 12 - labelCollisions * 20 -
    labelOverflowCount * 5 - portSpacingViolations * 3 - contrastViolations * 2 -
    disconnectedComponents * 4 + alignmentScore * 8 + gridAlignmentScore * 5 +
    whitespaceScore * 6 + densityScore * 4
  ));
  return {
    score, errors, warnings,
    metrics: {
      nodeOverlaps, edgeNodeIntersections, edgeCrossings, labelCollisions, disconnectedComponents,
      alignmentScore: Math.round(alignmentScore * 100) / 100,
      gridAlignmentScore: Math.round(gridAlignmentScore * 100) / 100,
      whitespaceScore: Math.round(whitespaceScore * 100) / 100,
      densityScore: Math.round(densityScore * 100) / 100,
      labelOverflowCount, edgeLabelOutOfBoundsCount, connectorRoutingViolations,
      portSpacingViolations, contrastViolations, cjkWidthViolations,
      complexityWarnings: complexityIssues.length
    }
  };
}
