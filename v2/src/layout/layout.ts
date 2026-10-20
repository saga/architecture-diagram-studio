import ELK from "elkjs/lib/elk.bundled.js";
import type { DiagramDocument, DiagramNode, Point } from "../model/types";
import { evaluateLayout } from "./quality";

const elk = new ELK();

function center(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
function routeRelations(doc: DiagramDocument): DiagramDocument {
  const lookup = new Map(doc.nodes.map((node) => [node.id, node]));
  const relations = doc.relations.map((relation, index) => {
    const source = lookup.get(relation.source), target = lookup.get(relation.target);
    if (!source || !target || doc.kind === "sequence") return { ...relation, points: [] };
    const s = center(source), t = center(target);
    const dx = t.x - s.x, dy = t.y - s.y;
    const lane = 24 + (index % 3) * 12;
    let start: Point, end: Point, points: Point[] = [];
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 40) {
      if (dy >= 0) {
        start = { x: s.x, y: source.y + source.height };
        end = { x: t.x, y: target.y };
        points = [{ x: start.x, y: start.y + lane }, { x: end.x, y: start.y + lane }, { x: end.x, y: end.y - lane }];
      } else {
        start = { x: s.x, y: source.y };
        end = { x: t.x, y: target.y + target.height };
        points = [{ x: start.x, y: start.y - lane }, { x: end.x, y: start.y - lane }, { x: end.x, y: end.y + lane }];
      }
    } else if (dx >= 0) {
      start = { x: source.x + source.width, y: s.y };
      end = { x: target.x, y: t.y };
      const midX = Math.max(start.x + lane, (start.x + end.x) / 2);
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

function applySemanticLanes(doc: DiagramDocument): DiagramDocument {
  const nodes = doc.nodes.map((n) => ({ ...n, layoutHints: { ...(n.layoutHints || {}) } }));
  if (doc.kind === "sequence") return { ...doc, nodes };
  const unlocked = nodes.filter((n) => !n.layoutHints?.locked);
  const internal = unlocked.filter((n) => n.role !== "external" && n.role !== "vendor");
  const maxX = Math.max(0, ...internal.map((n) => n.x + n.width));
  const maxY = Math.max(0, ...internal.map((n) => n.y + n.height));
  const external = unlocked.filter((n) => n.layoutHints?.preferredSide === "RIGHT" || ((n.role === "external" || n.role === "vendor") && doc.layout.externalSide === "RIGHT"));
  const storage = unlocked.filter((n) => n.layoutHints?.preferredSide === "BOTTOM" || ((n.role === "storage" || n.role === "data") && doc.layout.storageSide === "BOTTOM"));
  const infra = unlocked.filter((n) => n.role === "infra");
  const externalIds = new Set(external.map((n) => n.id));
  const storageIds = new Set(storage.map((n) => n.id));
  const infraIds = new Set(infra.map((n) => n.id));
  external.sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));
  external.forEach((n, i) => { n.x = maxX + doc.layout.layerSpacing; n.y = 74 + i * (n.height + doc.layout.nodeSpacing); });
  storage.sort((a, b) => a.x - b.x);
  infra.sort((a, b) => a.name.localeCompare(b.name));
  const infraY = Math.max(maxY + 40, ...external.map((n) => n.y + n.height + 32));
  infra.forEach((n, i) => { n.x = i * (n.width + doc.layout.nodeSpacing); n.y = infraY; });
  const maxInfraHeight = Math.max(0, ...infra.map((n) => n.height));
  const storageY = Math.max(infraY + (infra.length ? maxInfraHeight + 36 : 56), ...external.map((n) => n.y + n.height + 64));
  storage.forEach((n, i) => { n.x = i * (n.width + doc.layout.nodeSpacing); n.y = storageY; });
  return {
    ...doc,
    nodes: nodes.map((n) => {
      if (n.layoutHints?.locked) return n;
      if (externalIds.has(n.id)) return external.find((x) => x.id === n.id) || n;
      if (storageIds.has(n.id)) return storage.find((x) => x.id === n.id) || n;
      if (infraIds.has(n.id)) return infra.find((x) => x.id === n.id) || n;
      return n;
    })
  };
}

async function layoutLayered(doc: DiagramDocument): Promise<DiagramDocument> {
  const children = doc.nodes.map((node) => {
    const constraint = node.layoutHints?.preferredSide === "LEFT" ? "FIRST" :
      node.layoutHints?.preferredSide === "RIGHT" || node.role === "external" || node.role === "vendor" ? "LAST_SEPARATE" : undefined;
    return {
      id: node.id, width: node.width, height: node.height,
      layoutOptions: constraint ? { "org.eclipse.elk.layered.layering.layerConstraint": constraint } : undefined
    };
  });
  const edges = doc.relations
    .filter((r) => doc.nodes.some((n) => n.id === r.source) && doc.nodes.some((n) => n.id === r.target))
    .map((r) => ({ id: r.id, sources: [r.source], targets: [r.target] }));
  const graph = {
    id: "studio-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": doc.layout.direction,
      "elk.edgeRouting": doc.layout.routing === "curved" ? "SPLINES" : "ORTHOGONAL",
      "elk.spacing.nodeNode": String(doc.layout.nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(doc.layout.layerSpacing),
      "elk.padding": "[top=56,left=48,bottom=58,right=48]",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.cycleBreaking.strategy": "GREEDY",
      "elk.layered.thoroughness": "15"
    },
    children, edges
  };
  const result = await elk.layout(graph as never) as { children?: Array<{ id: string; x?: number; y?: number }> };
  const byId = new Map((result.children || []).map((node) => [node.id, node]));
  let next: DiagramDocument = {
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.layoutHints?.locked) return node;
      const position = byId.get(node.id);
      return position ? { ...node, x: position.x || 0, y: position.y || 0 } : node;
    })
  };
  if (doc.kind === "flowchart") next = applyFlowLanes(next);
  else next = applySemanticLanes(next);
  return routeRelations(next);
}

function applyFlowLanes(doc: DiagramDocument): DiagramDocument {
  const primary = new Set(doc.flow?.primaryPath || []);
  const nodes = doc.nodes.map((n) => ({ ...n }));
  const main = nodes.filter((n) => primary.has(n.id));
  const maxX = Math.max(0, ...main.map((n) => n.x + n.width));
  const maxY = Math.max(0, ...main.map((n) => n.y + n.height));
  const branches = nodes.filter((n) => !primary.has(n.id) && !n.layoutHints?.locked);
  if (doc.layout.direction === "RIGHT") {
    branches.sort((a, b) => a.y - b.y || a.name.localeCompare(b.name)).forEach((node, index) => {
      node.y = maxY + 72 + index * (node.height + 28);
      if (node.role === "business" || node.role === "worker") node.x = Math.max(30, maxX - node.width - 150);
    });
  } else {
    branches.sort((a, b) => a.x - b.x || a.name.localeCompare(b.name)).forEach((node, index) => {
      node.x = maxX + 70 + index * (node.width + 28);
    });
  }
  return routeRelations({ ...doc, nodes });
}

function layoutSequence(doc: DiagramDocument): DiagramDocument {
  const order = doc.sequence?.participants || doc.nodes.map((node) => node.id);
  const nodes = doc.nodes.map((node) => {
    if (node.layoutHints?.locked) return node;
    const index = Math.max(0, order.indexOf(node.id));
    return { ...node, x: 58 + index * 228, y: 54, width: Math.max(150, node.width), height: 58 };
  });
  const relations = [...doc.relations]
    .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0))
    .map((relation, index) => ({ ...relation, sequenceOrder: relation.sequenceOrder ?? index, points: [] }));
  return { ...doc, nodes, relations, layout: { ...doc.layout, direction: "RIGHT", routing: "polyline" } };
}

function repairOverlaps(doc: DiagramDocument): DiagramDocument {
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
  return routeRelations({ ...doc, nodes });
}

export async function layoutDiagram(document: DiagramDocument): Promise<DiagramDocument> {
  let laidOut = document.kind === "sequence" ? layoutSequence(document) : await layoutLayered(document);
  laidOut = repairOverlaps(laidOut);
  if (evaluateLayout(laidOut).metrics.nodeOverlaps > 0) laidOut = repairOverlaps(laidOut);
  return laidOut;
}

export function moveNode(document: DiagramDocument, id: string, x: number, y: number): DiagramDocument {
  const nodes = document.nodes.map((node) => node.id === id
    ? { ...node, x: Math.max(20, x), y: Math.max(20, y), layoutHints: { ...(node.layoutHints || {}), locked: true } }
    : node);
  return routeRelations({ ...document, nodes });
}

export function clearNodeLocks(document: DiagramDocument): DiagramDocument {
  return { ...document, nodes: document.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}), locked: false } })) };
}