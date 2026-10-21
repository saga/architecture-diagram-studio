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

export function routeRelations(doc: DiagramDocument, routeVariant = 0): DiagramDocument {
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
    const lane = 22 + ((index + routeVariant) % 4) * 12;
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
      const fractions = [0.34, 0.5, 0.66, 0.42];
      const fraction = fractions[(index + routeVariant) % fractions.length];
      const offset = gap > 8 ? Math.max(1, Math.min(gap - 1, gap * fraction)) : lane;
      const channelX = start.x + offset;
      points = [{ x: channelX, y: start.y }, { x: channelX, y: end.y }];
    } else {
      const outerX = Math.min(sourceNode.x, targetNode.x) - lane - 18;
      points = [{ x: outerX, y: start.y }, { x: outerX, y: end.y }];
    }
    return { ...relation, sourcePort: start, targetPort: end, points };
  });
  return { ...doc, relations };
}
