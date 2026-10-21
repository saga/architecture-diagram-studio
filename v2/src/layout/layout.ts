import { layoutWithDagre } from "./dagre";
import { layoutWithElk } from "./elk";
import { routeRelations } from "./routing";
import { resolveLayoutProfile } from "./profiles";
import type { DiagramDocument } from "../model/types";
import { evaluateLayout } from "./quality";
import { normalizeSequenceDocument } from "./sequence";



function layoutSequence(doc: DiagramDocument): DiagramDocument {
  const normalized = normalizeSequenceDocument(doc);
  const order = normalized.sequence?.participants || normalized.nodes.map((node) => node.id);
  const nodes = normalized.nodes.map((node) => {
    if (node.layoutHints?.locked) return node;
    const index = Math.max(0, order.indexOf(node.id));
    return { ...node, x: 58 + index * 228, y: 54, width: Math.max(150, node.width), height: 58 };
  });
  const relations = [...normalized.relations]
    .map((relation, index) => ({ ...relation, sequenceOrder: index, points: [] }));
  return {
    ...normalized,
    nodes,
    relations,
    sequence: { ...(normalized.sequence || { participants: [] }), participants: order },
    layout: { ...normalized.layout, direction: "RIGHT", routing: "polyline" }
  };
}

function repairOverlaps(doc: DiagramDocument, routeVariant = 0): DiagramDocument {
  const nodes = doc.nodes.map((node) => ({ ...node }));
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const overlap = a.x < b.x + b.width + 12 && a.x + a.width + 12 > b.x &&
          a.y < b.y + b.height + 12 && a.y + a.height + 12 > b.y;
        if (!overlap) continue;
        if (b.layoutHints?.locked && !a.layoutHints?.locked) a.y = b.y + b.height + 36;
        else if (!b.layoutHints?.locked) b.y = a.y + a.height + 36;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return routeRelations({ ...doc, nodes }, routeVariant);
}

export async function layoutDiagram(document: DiagramDocument): Promise<DiagramDocument> {
  const profile = resolveLayoutProfile(document.layout.profile);
  const initial = document.kind === "sequence"
    ? layoutSequence(document)
    : profile === "dagre-layered"
      ? routeRelations(layoutWithDagre(document))
      : await layoutWithElk(document, profile);
  let best = repairOverlaps(initial, 0);
  let bestReport = evaluateLayout(best);
  for (let variant = 1; variant <= 3; variant++) {
    const candidate = repairOverlaps({ ...initial, nodes: best.nodes.map((node) => ({ ...node })) }, variant);
    const report = evaluateLayout(candidate);
    if (report.score > bestReport.score) {
      best = candidate;
      bestReport = report;
    }
    if (
      bestReport.metrics.nodeOverlaps === 0 &&
      bestReport.metrics.edgeNodeIntersections === 0 &&
      bestReport.metrics.edgeCrossings === 0 &&
      bestReport.metrics.labelCollisions === 0
    ) break;
  }
  // Normalize legacy/unknown profiles to the actual engine used, so the
  // toolbar and persisted document never disagree about the active layout.
  return document.kind === "sequence"
    ? best
    : { ...best, layout: { ...best.layout, profile } };
}

export { clearNodeLocks, moveNode } from "./move";
