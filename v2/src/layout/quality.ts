import type { DiagramDocument, LayoutQualityReport, Point, QualityIssue } from "../model/types";

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
function isHorizontal(a: Point, b: Point): boolean { return Math.abs(a.y - b.y) < 0.001; }
function isVertical(a: Point, b: Point): boolean { return Math.abs(a.x - b.x) < 0.001; }
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  if (isHorizontal(a, b) && isVertical(c, d)) {
    return c.x > Math.min(a.x, b.x) && c.x < Math.max(a.x, b.x) && a.y > Math.min(c.y, d.y) && a.y < Math.max(c.y, d.y);
  }
  if (isVertical(a, b) && isHorizontal(c, d)) return intersects(c, d, a, b);
  if (isHorizontal(a, b) && isHorizontal(c, d) && Math.abs(a.y - c.y) < 0.001) {
    return Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) < Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x));
  }
  if (isVertical(a, b) && isVertical(c, d) && Math.abs(a.x - c.x) < 0.001) {
    return Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) < Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y));
  }
  return false;
}
function pathFor(doc: DiagramDocument, id: string): Point[] {
  const edge = doc.relations.find((relation) => relation.id === id);
  if (!edge) return [];
  const source = doc.nodes.find((node) => node.id === edge.source);
  const target = doc.nodes.find((node) => node.id === edge.target);
  if (!source || !target) return [];
  const s = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const t = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  return [s, ...(edge.points || []), t];
}

export function evaluateLayout(doc: DiagramDocument): LayoutQualityReport {
  const errors: QualityIssue[] = [];
  const warnings: QualityIssue[] = [];
  let nodeOverlaps = 0, edgeNodeIntersections = 0, edgeCrossings = 0;
  for (let i = 0; i < doc.nodes.length; i++) {
    for (let j = i + 1; j < doc.nodes.length; j++) {
      if (overlaps(doc.nodes[i], doc.nodes[j], 2)) {
        nodeOverlaps++;
        errors.push({ code: "node-overlap", severity: "error", message: doc.nodes[i].name + " overlaps " + doc.nodes[j].name, nodeIds: [doc.nodes[i].id, doc.nodes[j].id] });
      }
    }
  }
  const paths = doc.relations.map((relation) => ({ id: relation.id, points: pathFor(doc, relation.id) }));
  for (const path of paths) {
    const relation = doc.relations.find((item) => item.id === path.id);
    for (let i = 0; i < path.points.length - 1; i++) {
      const a = path.points[i], b = path.points[i + 1];
      const hit = doc.nodes.some((node) => {
        if (!relation || node.id === relation.source || node.id === relation.target) return false;
        if (isHorizontal(a, b)) return a.y > node.y && a.y < node.y + node.height && Math.max(Math.min(a.x, b.x), node.x) < Math.min(Math.max(a.x, b.x), node.x + node.width);
        if (isVertical(a, b)) return a.x > node.x && a.x < node.x + node.width && Math.max(Math.min(a.y, b.y), node.y) < Math.min(Math.max(a.y, b.y), node.y + node.height);
        return false;
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
  const alignmentScore = Math.max(0, 1 - nodeOverlaps / Math.max(1, doc.nodes.length));
  const xs = doc.nodes.map((n) => n.x), ys = doc.nodes.map((n) => n.y);
  const area = Math.max(1, (Math.max(...xs, 1) - Math.min(...xs, 0) + 240) * (Math.max(...ys, 1) - Math.min(...ys, 0) + 200));
  const occupancy = doc.nodes.reduce((sum, n) => sum + n.width * n.height, 0) / area;
  const whitespaceScore = Math.max(0, Math.min(1, 1 - Math.abs(occupancy - 0.18) * 2));
  const densityScore = Math.max(0, Math.min(1, 1 - doc.nodes.length / 32));
  if (edgeNodeIntersections) warnings.push({ code: "edge-through-node", severity: "warning", message: edgeNodeIntersections + " routed segment(s) cross a non-endpoint node" });
  if (edgeCrossings) warnings.push({ code: "edge-crossing", severity: "warning", message: edgeCrossings + " possible edge crossing(s)" });
  const score = Math.max(0, Math.round(100 - nodeOverlaps * 80 - edgeNodeIntersections * 100 - edgeCrossings * 12 + alignmentScore * 8 + whitespaceScore * 6 + densityScore * 4));
  return {
    score, errors, warnings,
    metrics: {
      nodeOverlaps, edgeNodeIntersections, edgeCrossings, labelCollisions: 0,
      disconnectedComponents: 0,
      alignmentScore: Math.round(alignmentScore * 100) / 100,
      whitespaceScore: Math.round(whitespaceScore * 100) / 100,
      densityScore: Math.round(densityScore * 100) / 100
    }
  };
}