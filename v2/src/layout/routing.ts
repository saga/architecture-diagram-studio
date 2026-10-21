import type { DiagramDocument, DiagramNode, DiagramRelation, Point } from "../model/types";

type Side = "LEFT" | "RIGHT" | "TOP" | "BOTTOM";
type Endpoint = "source" | "target";
interface PortRequest { relationId: string; endpoint: Endpoint; nodeId: string; side: Side; }
interface PortAssignments {
  source: Map<string, Point>;
  target: Map<string, Point>;
  violations: number;
}
function center(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
function sidesFor(source: DiagramNode, target: DiagramNode): { source: Side; target: Side } {
  const s = center(source), t = center(target);
  const dx = t.x - s.x, dy = t.y - s.y;
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
    return dy >= 0 ? { source: "BOTTOM", target: "TOP" } : { source: "TOP", target: "BOTTOM" };
  }
  return dx >= 0 ? { source: "RIGHT", target: "LEFT" } : { source: "LEFT", target: "RIGHT" };
}
function pointAtPort(node: DiagramNode, side: Side, index: number, count: number): Point {
  const horizontal = side === "TOP" || side === "BOTTOM";
  const length = horizontal ? node.width : node.height;
  const margin = Math.min(12, Math.max(4, length / 8));
  const available = Math.max(0, length - margin * 2);
  const offset = margin + available * (index + 1) / (count + 1);
  if (side === "LEFT") return { x: node.x, y: node.y + offset };
  if (side === "RIGHT") return { x: node.x + node.width, y: node.y + offset };
  if (side === "TOP") return { x: node.x + offset, y: node.y };
  return { x: node.x + offset, y: node.y + node.height };
}
function assignPorts(doc: DiagramDocument): PortAssignments {
  const source = new Map<string, Point>();
  const target = new Map<string, Point>();
  if (doc.kind === "sequence") return { source, target, violations: 0 };
  const nodeById = new Map(doc.nodes.map((node) => [node.id, node]));
  const requests = new Map<string, PortRequest[]>();
  for (const relation of doc.relations) {
    const sourceNode = nodeById.get(relation.source), targetNode = nodeById.get(relation.target);
    if (!sourceNode || !targetNode) continue;
    const sides = sidesFor(sourceNode, targetNode);
    for (const request of [
      { relationId: relation.id, endpoint: "source" as const, nodeId: sourceNode.id, side: sides.source },
      { relationId: relation.id, endpoint: "target" as const, nodeId: targetNode.id, side: sides.target }
    ]) {
      const key = request.nodeId + ":" + request.side;
      const group = requests.get(key) || [];
      group.push(request);
      requests.set(key, group);
    }
  }

  let violations = 0;
  for (const group of requests.values()) {
    group.sort((a, b) => a.relationId.localeCompare(b.relationId) || a.endpoint.localeCompare(b.endpoint));
    const node = nodeById.get(group[0]?.nodeId || "");
    if (!node) continue;
    const side = group[0].side;
    const ports = group.map((request, index) => ({
      request,
      point: pointAtPort(node, side, index, group.length)
    }));
    for (let index = 1; index < ports.length; index++) {
      const previous = ports[index - 1].point;
      const current = ports[index].point;
      const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
      const sideLength = side === "LEFT" || side === "RIGHT" ? node.height : node.width;
      if (distance + 0.001 < (sideLength < 48 ? 8 : 12)) violations++;
    }
    for (const { request, point } of ports) {
      (request.endpoint === "source" ? source : target).set(request.relationId, point);
    }
  }
  return { source, target, violations };
}

/** Number of collocated port pairs below the documented 12px / small-node 8px spacing. */
export function countPortSpacingViolations(doc: DiagramDocument): number {
  return assignPorts(doc).violations;
}

function routeRelationsForVariant(doc: DiagramDocument, routeVariant = 0): DiagramDocument {
  if (doc.kind === "sequence") {
    return {
      ...doc,
      relations: doc.relations.map((relation) => ({ ...relation, points: [], sourcePort: undefined, targetPort: undefined }))
    };
  }
  const lookup = new Map(doc.nodes.map((node) => [node.id, node]));
  const ports = assignPorts(doc);
  const relations = doc.relations.map((relation, index) => {
    const sourceNode = lookup.get(relation.source), targetNode = lookup.get(relation.target);
    if (!sourceNode || !targetNode) return { ...relation, points: [] };
    const start = ports.source.get(relation.id) || center(sourceNode);
    const end = ports.target.get(relation.id) || center(targetNode);
    const s = center(sourceNode), t = center(targetNode);
    const dx = t.x - s.x, dy = t.y - s.y;
    const lane = 24 + routeVariant * 16 + (index % 3) * 8;
    let points: Point[] = [];

    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
      const direction = dy >= 0 ? 1 : -1;
      const gap = Math.abs(end.y - start.y);
      const offset = gap > 8 ? Math.min(lane, gap / 3) : lane;
      const channelY = start.y + direction * offset;
      const approachY = end.y - direction * offset;
      points = [
        { x: start.x, y: channelY },
        { x: end.x, y: channelY },
        { x: end.x, y: approachY }
      ];
    } else if (dx >= 0) {
      const gap = end.x - start.x;
      if (Math.abs(start.y - end.y) < 8 && routeVariant > 0 && gap > 96) {
        // Parallel row edges normally share a direct horizontal path. Alternate candidates
        // deliberately route above/below that row so the quality scorer can avoid blockers.
        const inset = Math.min(32, gap / 4);
        const entryX = start.x + inset;
        const exitX = end.x - inset;
        const laneY = start.y + (routeVariant % 2 === 1 ? -lane : lane);
        points = [
          { x: entryX, y: start.y },
          { x: entryX, y: laneY },
          { x: exitX, y: laneY },
          { x: exitX, y: end.y }
        ];
      } else {
        const fractions = [0.34, 0.5, 0.66, 0.42];
        const fraction = fractions[(index + routeVariant) % fractions.length];
        const offset = gap > 8 ? Math.max(1, Math.min(gap - 1, gap * fraction)) : lane;
        const channelX = start.x + offset;
        points = [{ x: channelX, y: start.y }, { x: channelX, y: end.y }];
      }
    } else {
      const outerX = Math.min(sourceNode.x, targetNode.x) - lane - 18;
      points = [{ x: outerX, y: start.y }, { x: outerX, y: end.y }];
    }
    return { ...relation, sourcePort: start, targetPort: end, points };
  });
  return { ...doc, relations };
}

function segmentHitsRect(a: Point, b: Point, rect: { x: number; y: number; width: number; height: number }): boolean {
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
function segmentCrosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const orientation = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = orientation(a, b, c), o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a), o4 = orientation(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
    ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}
function routeCost(document: DiagramDocument): number {
  const routes = document.relations.map((relation) => ({
    relation,
    points: [
      ...(relation.sourcePort ? [relation.sourcePort] : []),
      ...(relation.points || []),
      ...(relation.targetPort ? [relation.targetPort] : [])
    ]
  }));
  let obstacleHits = 0, crossings = 0, length = 0;
  for (const route of routes) {
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1], b = route.points[index];
      length += Math.hypot(b.x - a.x, b.y - a.y);
      for (const node of document.nodes) {
        if (node.id === route.relation.source || node.id === route.relation.target) continue;
        if (segmentHitsRect(a, b, node)) obstacleHits++;
      }
    }
  }
  // Pairwise connector intersections dominate for very dense graphs. Keep the
  // exhaustive crossing search for ordinary architecture diagrams; large graphs
  // still get node-obstruction avoidance without an O(E²) cost per route candidate.
  if (routes.length <= 300) for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const left = routes[i], right = routes[j];
      if ([left.relation.source, left.relation.target].some((id) =>
        id === right.relation.source || id === right.relation.target
      )) continue;
      let crossed = false;
      for (let a = 1; a < left.points.length && !crossed; a++) {
        for (let b = 1; b < right.points.length; b++) {
          if (segmentCrosses(left.points[a - 1], left.points[a], right.points[b - 1], right.points[b])) {
            crossed = true;
            break;
          }
        }
      }
      if (crossed) crossings++;
    }
  }
  return obstacleHits * 10000 + crossings * 1000 + length * 0.001;
}

/**
 * Tries four deterministic orthogonal route variants and keeps the one with the
 * fewest node obstructions and unrelated-edge crossings. Supplying a variant
 * lets the layout optimizer compare the same alternatives explicitly.
 */
export function routeRelations(doc: DiagramDocument, routeVariant?: number): DiagramDocument {
  if (routeVariant !== undefined || doc.kind === "sequence") {
    return routeRelationsForVariant(doc, routeVariant ?? 0);
  }
  const candidates = [0, 1, 2, 3, 4, 5].map((variant) => routeRelationsForVariant(doc, variant));
  return candidates.reduce((best, candidate) =>
    routeCost(candidate) < routeCost(best) ? candidate : best
  );
}
