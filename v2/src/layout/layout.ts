import { layoutWithDagre } from "./dagre";
import { layoutWithElk } from "./elk";
import { routeRelations } from "./routing";
import { resolveLayoutProfile } from "./profiles";
import type { DiagramDocument } from "../model/types";
import { evaluateLayout } from "./quality";
import { normalizeSequenceDocument } from "./sequence";



function snapToGrid(value: number): number {
  return Math.round(value / 4) * 4;
}

function snapLayoutGeometry(doc: DiagramDocument): DiagramDocument {
  const nodes = doc.nodes.map((node) => node.layoutHints?.locked
    ? node
    : { ...node, x: snapToGrid(node.x), y: snapToGrid(node.y) });
  return routeRelations({ ...doc, nodes });
}

function isBetterLayout(candidate: ReturnType<typeof evaluateLayout>, current: ReturnType<typeof evaluateLayout>): boolean {
  // Hard geometry violations are constraints, not tradeable style metrics. Compare their
  // counts before total score; the total score is clamped at zero and can otherwise hide
  // improvements when both candidate routes have several obstructions.
  const hardCost = (report: ReturnType<typeof evaluateLayout>) =>
    report.metrics.nodeOverlaps * 1000 +
    report.metrics.edgeNodeIntersections * 100 +
    report.metrics.connectorRoutingViolations * 100 +
    report.errors.filter((issue) =>
      !["node-overlap", "edge-through-node", "diagonal-orthogonal-route"].includes(issue.code)
    ).length * 10000;
  const candidateHardCost = hardCost(candidate), currentHardCost = hardCost(current);
  if (candidateHardCost !== currentHardCost) return candidateHardCost < currentHardCost;
  const candidateWarnings = candidate.metrics.edgeCrossings + candidate.metrics.labelCollisions +
    candidate.metrics.labelOverflowCount + candidate.metrics.edgeLabelOutOfBoundsCount +
    candidate.metrics.connectorRoutingViolations + candidate.metrics.portSpacingViolations;
  const currentWarnings = current.metrics.edgeCrossings + current.metrics.labelCollisions +
    current.metrics.labelOverflowCount + current.metrics.edgeLabelOutOfBoundsCount +
    current.metrics.connectorRoutingViolations + current.metrics.portSpacingViolations;
  if (candidateWarnings !== currentWarnings) return candidateWarnings < currentWarnings;
  return candidate.score > current.score;
}

function layoutSequence(doc: DiagramDocument): DiagramDocument {
  const normalized = normalizeSequenceDocument(doc);
  const order = normalized.sequence?.participants || normalized.nodes.map((node) => node.id);
  const nodes = normalized.nodes.map((node) => {
    if (node.layoutHints?.locked) return node;
    const index = Math.max(0, order.indexOf(node.id));
    return { ...node, x: 56 + index * 228, y: 56, width: Math.max(150, node.width), height: 58 };
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
        if (b.layoutHints?.locked && !a.layoutHints?.locked) a.y = snapToGrid(b.y + b.height + 36);
        else if (!b.layoutHints?.locked) b.y = snapToGrid(a.y + a.height + 36);
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
  const alignedInitial = snapLayoutGeometry(initial);
  let best = repairOverlaps(alignedInitial, 0);
  let bestReport = evaluateLayout(best);
  const maxVariants = document.relations.length <= 40 ? 7
    : document.relations.length <= 150 ? 3
      : document.relations.length <= 400 ? 1 : 0;
  for (let variant = 1; variant <= maxVariants; variant++) {
    // Evaluate independent route variants from the same aligned node geometry rather than
    // mutating the current winner cumulatively between candidates.
    const candidate = repairOverlaps({ ...alignedInitial, nodes: alignedInitial.nodes.map((node) => ({ ...node })) }, variant);
    const report = evaluateLayout(candidate);
    if (isBetterLayout(report, bestReport)) {
      best = candidate;
      bestReport = report;
    }
    if (
      bestReport.metrics.nodeOverlaps === 0 &&
      bestReport.metrics.edgeNodeIntersections === 0 &&
      bestReport.metrics.connectorRoutingViolations === 0 &&
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
