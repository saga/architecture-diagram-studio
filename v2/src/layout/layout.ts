import ELK from "elkjs/lib/elk.bundled.js";
import type { DiagramDocument, DiagramNode, Point } from "../model/types";
import { evaluateLayout } from "./quality";
import { normalizeSequenceDocument } from "./sequence";

const elk = new ELK();

function center(node: DiagramNode): Point {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}
function routeRelations(doc: DiagramDocument, routeVariant = 0): DiagramDocument {
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

function applyC4SemanticRanks(doc: DiagramDocument): DiagramDocument {
  if (doc.kind !== "c4" || doc.layout.direction !== "RIGHT") return doc;
  const defaultRank: Record<string, number> = {
    actor: 0, source: 0,
    ui: 1,
    entry: 2,
    domain: 3, business: 3, service: 3,
    api: 4, worker: 4
  };
  const ranked = new Map<number, DiagramNode[]>();
  for (const node of doc.nodes) {
    if (node.layoutHints?.locked || ["external", "vendor", "storage", "data", "infra"].includes(node.role)) continue;
    const rank = node.layoutHints?.preferredRank ?? defaultRank[node.role] ?? 3;
    const group = ranked.get(rank) || [];
    group.push(node);
    ranked.set(rank, group);
  }
  let x = 48;
  const nodes = doc.nodes.map((node) => ({ ...node }));
  for (const rank of [...ranked.keys()].sort((a, b) => a - b)) {
    const group = ranked.get(rank)!;
    group.sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));
    const width = Math.max(...group.map((node) => node.width));
    let y = 56;
    for (const item of group) {
      const node = nodes.find((candidate) => candidate.id === item.id)!;
      node.x = x;
      node.y = Math.max(y, node.y);
      y = node.y + node.height + doc.layout.nodeSpacing;
    }
    x += width + doc.layout.layerSpacing;
  }
  return { ...doc, nodes };
}

function applySemanticLanes(doc: DiagramDocument): DiagramDocument {
  const nodes = doc.nodes.map((n) => ({ ...n, layoutHints: { ...(n.layoutHints || {}) } }));
  if (doc.kind === "sequence") return { ...doc, nodes };
  const unlocked = nodes.filter((n) => !n.layoutHints?.locked);
  const internal = unlocked.filter((n) => !["external", "vendor", "storage", "data", "infra"].includes(n.role));
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
  let infraX = 0;
  infra.forEach((n) => { n.x = infraX; n.y = infraY; infraX += n.width + doc.layout.nodeSpacing; });
  const maxInfraHeight = Math.max(0, ...infra.map((n) => n.height));
  const storageY = Math.max(infraY + (infra.length ? maxInfraHeight + 36 : 56), ...external.map((n) => n.y + n.height + 64));
  let storageX = 0;
  storage.forEach((n) => { n.x = storageX; n.y = storageY; storageX += n.width + doc.layout.nodeSpacing; });
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

type ElkLayoutProfile = "elk-layered" | "elk-mrtree" | "elk-radial" | "elk-stress" | "elk-force";

function layoutProfile(doc: DiagramDocument): ElkLayoutProfile {
  const profile = doc.layout.profile;
  return profile === "elk-mrtree" || profile === "elk-radial" || profile === "elk-stress" || profile === "elk-force"
    ? profile
    : "elk-layered";
}

async function layoutLayered(doc: DiagramDocument, profile: ElkLayoutProfile = "elk-layered"): Promise<DiagramDocument> {
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
      "elk.algorithm": profile === "elk-layered" ? "layered" : profile.slice(4),
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
  // Semantic lane/rank post-processing is specific to layered diagrams. Applying it
  // after radial, tree, stress or force layout would destroy the selected algorithm's geometry.
  if (profile === "elk-layered") {
    if (doc.kind === "flowchart") next = applyFlowLanes(next);
    else {
      next = applyC4SemanticRanks(next);
      next = applySemanticLanes(next);
    }
  }
  return routeRelations(next);
}

function applyFlowLanes(doc: DiagramDocument): DiagramDocument {
  const primaryPath = doc.flow?.primaryPath || [];
  const primary = new Set(primaryPath);
  const rank = new Map(primaryPath.map((id, index) => [id, index] as const));
  const nodes = doc.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}) } }));
  const main = nodes.filter((node) => primary.has(node.id));
  const pathNodes: DiagramNode[] = primaryPath.flatMap((id) => {
    const pathNode = nodes.find((candidate) => candidate.id === id);
    return pathNode ? [pathNode] : [];
  });

  // ELK may reserve empty layers for off-path branches. Once those branches move
  // into a separate lane, compact the main path in its declared order to remove
  // the dead space while leaving manually locked main-path nodes untouched.
  const firstPathNode = pathNodes[0];
  if (firstPathNode && doc.layout.direction === "RIGHT") {
    const baselineY = firstPathNode.y;
    let cursor = firstPathNode.x;
    for (const node of pathNodes) {
      if (node.layoutHints?.locked) {
        cursor = Math.max(cursor, node.x + node.width + doc.layout.layerSpacing);
      } else {
        node.x = cursor;
        node.y = baselineY;
        cursor += node.width + doc.layout.layerSpacing;
      }
    }
  } else if (firstPathNode && doc.layout.direction === "DOWN") {
    const baselineX = firstPathNode.x;
    let cursor = firstPathNode.y;
    for (const node of pathNodes) {
      if (node.layoutHints?.locked) {
        cursor = Math.max(cursor, node.y + node.height + doc.layout.layerSpacing);
      } else {
        node.x = baselineX;
        node.y = cursor;
        cursor += node.height + doc.layout.layerSpacing;
      }
    }
  }

  const branches = nodes.filter((node) => !primary.has(node.id) && !node.layoutHints?.locked);
  if (!branches.length || !main.length) return routeRelations({ ...doc, nodes });

  // A flowchart without manual locks gets a single, stable main lane.
  // Exception/review nodes are placed below the exact primary-path segment they connect to.
  const allPrimaryUnlocked = primaryPath.every((id) => {
    const node = nodes.find((item) => item.id === id);
    return node && !node.layoutHints?.locked;
  });
  if (doc.layout.direction === "RIGHT" && allPrimaryUnlocked) {
    let x = 48;
    const gap = Math.max(36, Math.min(64, Math.round(doc.layout.layerSpacing * 0.55)));
    for (const id of primaryPath) {
      const node = nodes.find((item) => item.id === id);
      if (!node) continue;
      node.x = x;
      node.y = 116;
      x += node.width + gap;
    }
  }

  const neighborsByBranch = (branchId: string) => {
    const ids = new Set<string>();
    for (const relation of doc.relations) {
      if (relation.source === branchId && primary.has(relation.target)) ids.add(relation.target);
      if (relation.target === branchId && primary.has(relation.source)) ids.add(relation.source);
    }
    return [...ids].map((id) => nodes.find((node) => node.id === id)!).filter(Boolean)
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  };
  const attachedX = (branch: DiagramNode) => {
    const neighbors = neighborsByBranch(branch.id);
    if (!neighbors.length) return Math.max(24, branch.x);
    const first = neighbors[0];
    const last = neighbors[neighbors.length - 1];
    const midpoint = ((first.x + first.width / 2) + (last.x + last.width / 2)) / 2;
    return Math.max(24, Math.round(midpoint - branch.width / 2));
  };

  if (doc.layout.direction === "RIGHT") {
    const branchPlacements = branches
      .map((node) => ({ node, x: attachedX(node) }))
      .sort((a, b) => a.x - b.x || a.node.name.localeCompare(b.node.name));
    const mainBottom = Math.max(...main.map((node) => node.y + node.height));
    const rows: Array<Array<{ x: number; width: number }>> = [];
    for (const { node, x } of branchPlacements) {
      let row = 0;
      while ((rows[row] || []).some((placed) => x < placed.x + placed.width + 36 && x + node.width + 36 > placed.x)) row++;
      rows[row] ||= [];
      rows[row].push({ x, width: node.width });
      node.x = x;
      node.y = mainBottom + 72 + row * (node.height + 30);
    }
  } else {
    const mainRight = Math.max(...main.map((node) => node.x + node.width));
    const branchPlacements = branches
      .map((node) => {
        const neighbors = neighborsByBranch(node.id);
        const centerY = neighbors.length
          ? (neighbors[0].y + neighbors[0].height / 2 + neighbors[neighbors.length - 1].y + neighbors[neighbors.length - 1].height / 2) / 2
          : node.y + node.height / 2;
        return { node, centerY };
      })
      .sort((a, b) => a.centerY - b.centerY || a.node.name.localeCompare(b.node.name));
    branchPlacements.forEach(({ node, centerY }, index) => {
      node.x = mainRight + 72 + index * (node.width + 30);
      node.y = Math.max(24, Math.round(centerY - node.height / 2));
    });
  }

  return routeRelations({ ...doc, nodes });
}

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
  const initial = document.kind === "sequence" ? layoutSequence(document) : await layoutLayered(document, layoutProfile(document));
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
  return best;
}

export function moveNode(document: DiagramDocument, id: string, x: number, y: number): DiagramDocument {
  const moving = document.nodes.find((node) => node.id === id);
  if (!moving) return document;
  const others = document.nodes.filter((node) => node.id !== id);
  let chosenX = Math.max(20, Math.round(x / 8) * 8);
  let chosenY = Math.max(20, Math.round(y / 8) * 8);

  const isFree = (candidateX: number, candidateY: number) => !others.some((other) =>
    candidateX < other.x + other.width + 14 &&
    candidateX + moving.width + 14 > other.x &&
    candidateY < other.y + other.height + 14 &&
    candidateY + moving.height + 14 > other.y
  );

  if (!isFree(chosenX, chosenY)) {
    const originX = chosenX, originY = chosenY;
    const step = 24;
    let found = false;
    for (let radius = 1; radius <= 60 && !found; radius++) {
      const candidates: Point[] = [];
      for (let dx = -radius; dx <= radius; dx++) {
        candidates.push({ x: originX + dx * step, y: originY - radius * step });
        candidates.push({ x: originX + dx * step, y: originY + radius * step });
      }
      for (let dy = -radius + 1; dy < radius; dy++) {
        candidates.push({ x: originX - radius * step, y: originY + dy * step });
        candidates.push({ x: originX + radius * step, y: originY + dy * step });
      }
      for (const candidate of candidates) {
        const candidateX = Math.max(20, candidate.x);
        const candidateY = Math.max(20, candidate.y);
        if (isFree(candidateX, candidateY)) {
          chosenX = candidateX;
          chosenY = candidateY;
          found = true;
          break;
        }
      }
    }
  }

  const nodes = document.nodes.map((node) => node.id === id
    ? { ...node, x: chosenX, y: chosenY, layoutHints: { ...(node.layoutHints || {}), locked: true } }
    : node);
  return routeRelations({ ...document, nodes });
}

export function clearNodeLocks(document: DiagramDocument): DiagramDocument {
  return { ...document, nodes: document.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}), locked: false } })) };
}