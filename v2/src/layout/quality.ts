import type { DiagramDocument, LayoutQualityReport, Point, QualityIssue } from "../model/types";

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
function isHorizontal(a: Point, b: Point): boolean { return Math.abs(a.y - b.y) < 0.001; }
function isVertical(a: Point, b: Point): boolean { return Math.abs(a.x - b.x) < 0.001; }
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
function segmentIntersectsRect(a: Point, b: Point, rect: { x: number; y: number; width: number; height: number }): boolean {
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
function pathFor(doc: DiagramDocument, id: string): Point[] {
  const edge = doc.relations.find((relation) => relation.id === id);
  if (!edge) return [];
  const source = doc.nodes.find((node) => node.id === edge.source);
  const target = doc.nodes.find((node) => node.id === edge.target);
  if (!source || !target) return [];
  if (doc.kind === "sequence") {
    const order = edge.sequenceOrder ?? 0;
    const y = 148 + order * 72;
    const sourceX = source.x + source.width / 2;
    const targetX = target.x + target.width / 2;
    return [
      { x: sourceX + (targetX >= sourceX ? 1 : -1) * source.width * 0.42, y },
      { x: targetX + (targetX >= sourceX ? -1 : 1) * target.width * 0.42, y }
    ];
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
  return [start, ...(edge.points || []), end];
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
function labelBoxes(doc: DiagramDocument): Array<{ relationId: string; x: number; y: number; width: number; height: number }> {
  return doc.relations.filter((edge) => edge.label.trim()).flatMap((edge) => {
    const path = pathFor(doc, edge.id);
    if (path.length < 2) return [];
    const a = path[Math.floor((path.length - 1) / 2)], b = path[Math.ceil((path.length - 1) / 2)];
    const width = Math.max(36, Math.min(240, edge.label.length * 6.2));
    return [{ relationId: edge.id, x: (a.x + b.x) / 2 - width / 2, y: (a.y + b.y) / 2 - 12, width, height: 19 }];
  });
}

export function evaluateLayout(doc: DiagramDocument): LayoutQualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  let nodeOverlaps = 0, edgeNodeIntersections = 0, edgeCrossings = 0, labelCollisions = 0;
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
  for (const boundary of doc.boundaries) {
    const missing = boundary.members.filter((id) => !doc.nodes.some((node) => node.id === id));
    if (missing.length) {
      errors.push({ code: "invalid-boundary-member", severity: "error", message: "Boundary " + boundary.name + " contains missing node(s): " + missing.join(", ") });
    }
  }
  for (const node of doc.nodes) {
    if (node.x < 0 || node.y < 0) errors.push({ code: "negative-position", severity: "error", message: node.name + " is positioned outside the canvas", nodeIds: [node.id] });
  }
  const paths = doc.relations.map((edge) => ({ id: edge.id, points: pathFor(doc, edge.id) }));
  for (const path of paths) {
    const edge = doc.relations.find((item) => item.id === path.id);
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i], b = path.points[i + 1];
      const hit = doc.nodes.some((node) => {
        if (!edge || node.id === edge.source || node.id === edge.target) return false;
        return segmentIntersectsRect(a, b, node);
      });
      if (hit) edgeNodeIntersections++;
    }
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const left = doc.relations.find((r) => r.id === paths[i].id);
      const right = doc.relations.find((r) => r.id === paths[j].id);
      if (!left || !right || [left.source, left.target].some((id) => id === right.source || id === right.target)) continue;
      let crossed = false;
      for (let ai = 0; ai < paths[i].points.length - 1 && !crossed; ai++) {
        for (let bi = 0; bi < paths[j].points.length - 1; bi++) {
          if (intersects(paths[i].points[ai], paths[i].points[ai + 1], paths[j].points[bi], paths[j].points[bi + 1])) { crossed = true; break; }
        }
      }
      if (crossed) edgeCrossings++;
    }
  }
  const boxes = labelBoxes(doc);
  for (let i = 0; i < boxes.length; i++) {
    const current = boxes[i];
    const edge = doc.relations.find((item) => item.id === current.relationId);
    const collidesWithNode = doc.nodes.some((node) =>
      node.id !== edge?.source && node.id !== edge?.target &&
      overlaps(current, node, 0)
    );
    const collidesWithLabel = boxes.slice(i + 1).some((other) => overlaps(current, other, 2));
    if (collidesWithNode || collidesWithLabel) labelCollisions++;
  }
  const disconnectedComponents = Math.max(0, countComponents(doc) - 1);
  const alignmentScore = Math.max(0, 1 - nodeOverlaps / Math.max(1, doc.nodes.length));
  const xs = doc.nodes.map((n) => n.x), ys = doc.nodes.map((n) => n.y);
  const area = Math.max(1, (Math.max(...xs, 1) - Math.min(...xs, 0) + 240) * (Math.max(...ys, 1) - Math.min(...ys, 0) + 200));
  const occupancy = doc.nodes.reduce((sum, n) => sum + n.width * n.height, 0) / area;
  const whitespaceScore = Math.max(0, Math.min(1, 1 - Math.abs(occupancy - 0.18) * 2));
  const densityScore = Math.max(0, Math.min(1, 1 - doc.nodes.length / 32));
  if (edgeNodeIntersections) errors.push({ code: "edge-through-node", severity: "error", message: edgeNodeIntersections + " routed segment(s) cross a non-endpoint node" });
  if (edgeCrossings) warnings.push({ code: "edge-crossing", severity: "warning", message: edgeCrossings + " possible edge crossing(s)" });
  if (labelCollisions) warnings.push({ code: "label-collision", severity: "warning", message: labelCollisions + " estimated edge-label collision(s)" });
  if (disconnectedComponents) warnings.push({ code: "disconnected-components", severity: "warning", message: disconnectedComponents + " disconnected component(s) beyond the first" });
  const score = Math.max(0, Math.round(100 - nodeOverlaps * 80 - edgeNodeIntersections * 100 - edgeCrossings * 12 - labelCollisions * 20 - disconnectedComponents * 4 + alignmentScore * 8 + whitespaceScore * 6 + densityScore * 4));
  return {
    score, errors, warnings,
    metrics: {
      nodeOverlaps, edgeNodeIntersections, edgeCrossings, labelCollisions, disconnectedComponents,
      alignmentScore: Math.round(alignmentScore * 100) / 100,
      whitespaceScore: Math.round(whitespaceScore * 100) / 100,
      densityScore: Math.round(densityScore * 100) / 100
    }
  };
}