import dagre from "@dagrejs/dagre";
import type { DiagramDocument } from "../model/types";

/**
 * Dagre adapter. Dagre computes center-based node coordinates; the Studio IR
 * stores top-left coordinates. Direction is intentionally supplied by the
 * document so horizontal and vertical layouts share one engine profile.
 */
export function layoutWithDagre(document: DiagramDocument): DiagramDocument {
  if (document.kind === "sequence" || document.nodes.length === 0) return document;

  const direction = document.layout.direction === "DOWN" ? "TB" : "LR";
  const graph = new dagre.graphlib.Graph({ multigraph: true, compound: false });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: direction,
    nodesep: Math.max(12, document.layout.nodeSpacing),
    ranksep: Math.max(24, document.layout.layerSpacing),
    marginx: 48,
    marginy: 56,
    align: "UL",
    acyclicer: "greedy",
    ranker: "network-simplex",
  });

  for (const node of document.nodes) {
    graph.setNode(node.id, { width: node.width, height: node.height });
  }
  for (const relation of document.relations) {
    if (!document.nodes.some((node) => node.id === relation.source) ||
        !document.nodes.some((node) => node.id === relation.target)) continue;
    graph.setEdge(relation.source, relation.target, { minlen: 1, weight: 1 }, relation.id);
  }

  dagre.layout(graph);
  return {
    ...document,
    nodes: document.nodes.map((node) => {
      if (node.layoutHints?.locked) return node;
      const position = graph.node(node.id) as { x?: number; y?: number } | undefined;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return node;
      return {
        ...node,
        x: Math.round((position.x ?? 0) - node.width / 2),
        y: Math.round((position.y ?? 0) - node.height / 2),
      };
    }),
  };
}
