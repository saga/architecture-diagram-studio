import ELK from "elkjs/lib/elk.bundled.js";
import type { DiagramDocument, DiagramNode } from "../model/types";
import type { ElkLayoutProfile } from "./profiles";
import { routeRelations } from "./routing";

const elk = new ELK();

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

export function applySemanticSideConstraints(doc: DiagramDocument, automaticRolePlacement = true): DiagramDocument {
  const nodes = doc.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}) } }));
  if (doc.kind === "sequence") return { ...doc, nodes };
  const unlocked = nodes.filter((node) => !node.layoutHints?.locked);
  const sideOf = (node: DiagramNode): "LEFT" | "RIGHT" | "TOP" | "BOTTOM" | undefined => {
    // Explicit per-node constraints apply in either direction. Automatic C4 zoning
    // is horizontal-first; forcing external/storage columns into vertical Dagre
    // layouts would defeat the user's selected orientation.
    if (node.layoutHints?.preferredSide) return node.layoutHints.preferredSide;
    if (!automaticRolePlacement || doc.layout.direction !== "RIGHT") return undefined;
    if (node.role === "external" || node.role === "vendor") return doc.layout.externalSide;
    if (node.role === "storage" || node.role === "data") return doc.layout.storageSide;
    if (node.role === "infra") return "BOTTOM";
    return undefined;
  };
  const buckets = new Map<string, DiagramNode[]>([["LEFT", []], ["RIGHT", []], ["TOP", []], ["BOTTOM", []]]);
  for (const node of unlocked) {
    const side = sideOf(node);
    if (side) buckets.get(side)?.push(node);
  }
  const sideNodeIds = new Set([...buckets.values()].flat().map((node) => node.id));
  const fixedAndInternal = nodes.filter((node) => node.layoutHints?.locked || !sideNodeIds.has(node.id));
  const gap = Math.max(24, doc.layout.layerSpacing);
  const top = buckets.get("TOP") || [];
  const bottom = buckets.get("BOTTOM") || [];
  const left = buckets.get("LEFT") || [];
  const right = buckets.get("RIGHT") || [];
  const maxTopHeight = Math.max(0, ...top.map((node) => node.height));

  // Reserve a proper top lane. Only unlocked internal nodes move; manually locked
  // geometry remains authoritative and is left for the quality checker to report.
  if (top.length && maxTopHeight > 0) {
    for (const node of fixedAndInternal) {
      if (!node.layoutHints?.locked) node.y += maxTopHeight + gap;
    }
  }
  const leftWidth = Math.max(0, ...left.map((node) => node.width));
  const minUnlockedX = Math.min(...fixedAndInternal.filter((node) => !node.layoutHints?.locked).map((node) => node.x));
  const leftXShift = left.length && Number.isFinite(minUnlockedX)
    ? Math.max(0, 24 + leftWidth + gap - minUnlockedX)
    : 0;
  if (leftXShift) {
    fixedAndInternal.filter((node) => !node.layoutHints?.locked).forEach((node) => { node.x += leftXShift; });
  }

  const minX = Math.min(48, ...fixedAndInternal.map((node) => node.x));
  const maxX = Math.max(48, ...fixedAndInternal.map((node) => node.x + node.width));
  const maxY = Math.max(56, ...fixedAndInternal.map((node) => node.y + node.height));
  const rightX = maxX + gap;
  const topY = 24;
  const bottomY = maxY + gap;
  const sortStable = (items: DiagramNode[]) => items.sort((a, b) => a.y - b.y || a.name.localeCompare(b.name));
  const placeVerticalLane = (items: DiagramNode[], x: number) => {
    let y = 56;
    for (const node of sortStable(items)) {
      node.x = x;
      node.y = y;
      y += node.height + doc.layout.nodeSpacing;
    }
  };
  const placeHorizontalLane = (items: DiagramNode[], y: number) => {
    let x = 48;
    for (const node of sortStable(items)) {
      node.x = x;
      node.y = y;
      x += node.width + doc.layout.nodeSpacing;
    }
  };
  placeVerticalLane(left, Math.max(24, minX - leftWidth - gap));
  placeVerticalLane(right, rightX);
  placeHorizontalLane(top, topY);
  placeHorizontalLane(bottom, bottomY);
  return { ...doc, nodes };
}

export async function layoutWithElk(doc: DiagramDocument, profile: ElkLayoutProfile = "elk-layered"): Promise<DiagramDocument> {
  const children = doc.nodes.map((node) => {
    const semanticSide = node.layoutHints?.preferredSide ??
      ((node.role === "external" || node.role === "vendor") ? doc.layout.externalSide :
      ((node.role === "storage" || node.role === "data") ? doc.layout.storageSide : undefined));
    const constraint = doc.layout.direction === "RIGHT"
      ? (semanticSide === "LEFT" ? "FIRST" : semanticSide === "RIGHT" ? "LAST_SEPARATE" : undefined)
      : (semanticSide === "TOP" ? "FIRST" : semanticSide === "BOTTOM" ? "LAST_SEPARATE" : undefined);
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
    if (doc.kind === "flowchart") {
      next = applyFlowLanes(next);
      // The flow-specific primary/exception lanes are authoritative. Honor only
      // explicit node-side hints here; automatic C4 role zoning would move review
      // and approval branches away from their connected decision/main-path steps.
      next = applySemanticSideConstraints(next, false);
    } else {
      next = applyC4SemanticRanks(next);
      next = applySemanticSideConstraints(next);
    }
  } else {
    // Preserve the selected tree/radial/force geometry unless a node explicitly
    // requests a side; explicit constraints are still part of the document contract.
    next = applySemanticSideConstraints(next, false);
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
