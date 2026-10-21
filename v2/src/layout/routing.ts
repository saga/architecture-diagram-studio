import type { DiagramDocument, DiagramNode, Point } from "../model/types";

function center(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
export function routeRelations(doc: DiagramDocument, routeVariant = 0): DiagramDocument {
  const lookup = new Map(doc.nodes.map((node) => [node.id, node]));
  const relations = doc.relations.map((relation, index) => {
    const source = lookup.get(relation.source), target = lookup.get(relation.target);
    if (!source || !target || doc.kind === "sequence") return { ...relation, points: [] };
    const s = center(source), t = center(target);
    const dx = t.x - s.x, dy = t.y - s.y;
    const lane = 22 + ((index + routeVariant) % 4) * 12;
    let start: Point, end: Point, points: Point[] = [];
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
      if (dy >= 0) {
        start = { x: s.x, y: source.y + source.height };
        end = { x: t.x, y: target.y };
        const channelY = start.y + lane;
        points = [{ x: start.x, y: channelY }, { x: end.x, y: channelY }, { x: end.x, y: end.y - Math.min(lane, Math.max(8, Math.abs(dy) / 3)) }];
      } else {
        start = { x: s.x, y: source.y };
        end = { x: t.x, y: target.y + target.height };
        const channelY = start.y - lane;
        points = [{ x: start.x, y: channelY }, { x: end.x, y: channelY }, { x: end.x, y: end.y + Math.min(lane, Math.max(8, Math.abs(dy) / 3)) }];
      }
    } else if (dx >= 0) {
      start = { x: source.x + source.width, y: s.y };
      end = { x: target.x, y: t.y };
      const gap = Math.max(1, end.x - start.x);
      const fractions = [0.34, 0.5, 0.66, 0.42];
      const fraction = fractions[(index + routeVariant) % fractions.length];
      const midX = start.x + Math.max(1, Math.min(gap - 1, gap * fraction));
      points = [{ x: midX, y: start.y }, { x: midX, y: end.y }];
    } else {
      start = { x: source.x, y: s.y };
      end = { x: target.x + target.width, y: t.y };
      const outerX = Math.min(source.x, target.x) - lane - 18;
      points = [{ x: outerX, y: start.y }, { x: outerX, y: end.y }];
    }
    return { ...relation, points };
  });
  return { ...doc, relations };
}
