import dagre from '@dagrejs/dagre';
import { hierarchy, tree } from 'd3-hierarchy';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramDocument, NodeLayout } from '../model/diagram';

export type LayoutEngine = 'elk' | 'dagre' | 'hierarchy' | 'force';

export const LAYOUT_ENGINES: Array<{ value: LayoutEngine; label: string; hint: string }> = [
  { value: 'elk', label: 'ELK', hint: 'Layered graph layout with edge routing' },
  { value: 'dagre', label: 'Dagre', hint: 'Fast directed graph layout' },
  { value: 'hierarchy', label: 'D3 Hierarchy', hint: 'Tree layout for rooted hierarchies' },
  { value: 'force', label: 'D3 Force', hint: 'Force-directed layout for connected graphs' },
];

const elk = new ELK();
const DEFAULT_WIDTH = 190;
const DEFAULT_HEIGHT = 84;

function dimensions(doc: DiagramDocument, id: string): NodeLayout {
  return doc.layout[id] ?? { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function centerPositions(doc: DiagramDocument, positions: Map<string, { x: number; y: number }>): DiagramDocument {
  const layout = { ...doc.layout };
  for (const node of doc.nodes) {
    const current = dimensions(doc, node.id);
    const point = positions.get(node.id);
    if (point) layout[node.id] = { ...current, x: point.x, y: point.y };
  }
  return { ...doc, layout };
}

async function layoutElk(doc: DiagramDocument): Promise<DiagramDocument> {
  const result = await elk.layout({
    id: doc.id,
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '64',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.edgeRouting': 'ORTHOGONAL',
    },
    children: doc.nodes.map((node) => {
      const size = dimensions(doc, node.id);
      return { id: node.id, width: size.width, height: size.height };
    }),
    edges: doc.relations.map((edge) => ({ id: edge.id, sources: [edge.sourceId], targets: [edge.targetId] })),
  });
  return centerPositions(doc, new Map<string, { x: number; y: number }>((result.children ?? []).map((node) => [
    node.id,
    { x: node.x ?? 0, y: node.y ?? 0 },
  ] as const)));
}

function layoutDagre(doc: DiagramDocument): DiagramDocument {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 64, ranksep: 90, marginx: 30, marginy: 30 });
  for (const node of doc.nodes) {
    const size = dimensions(doc, node.id);
    graph.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of doc.relations) graph.setEdge(edge.sourceId, edge.targetId, {}, edge.id);
  dagre.layout(graph);
  return centerPositions(doc, new Map<string, { x: number; y: number }>(doc.nodes.map((node) => {
    const point = graph.node(node.id) as { x: number; y: number };
    const size = dimensions(doc, node.id);
    return [node.id, { x: point.x - size.width / 2, y: point.y - size.height / 2 }] as const;
  })));
}

type HierarchyItem = { id: string; children: HierarchyItem[] };

function layoutHierarchy(doc: DiagramDocument): DiagramDocument {
  if (!doc.nodes.length) return doc;
  const ids = new Set(doc.nodes.map((node) => node.id));
  const childrenById = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of doc.relations) {
    if (!ids.has(edge.sourceId) || !ids.has(edge.targetId) || edge.sourceId === edge.targetId) continue;
    const list = childrenById.get(edge.sourceId) ?? [];
    if (!list.includes(edge.targetId)) list.push(edge.targetId);
    childrenById.set(edge.sourceId, list);
    incoming.add(edge.targetId);
  }

  // D3 hierarchy requires a tree. Build a deterministic spanning forest, so cycles,
  // cross-links, and disconnected components do not cause nodes to disappear.
  const visited = new Set<string>();
  const makeTree = (id: string): HierarchyItem => {
    visited.add(id);
    return {
      id,
      children: (childrenById.get(id) ?? [])
        .filter((childId) => !visited.has(childId))
        .map(makeTree),
    };
  };
  const roots = doc.nodes.filter((node) => !incoming.has(node.id));
  const forest: HierarchyItem[] = [];
  for (const node of roots) if (!visited.has(node.id)) forest.push(makeTree(node.id));
  // A cycle can leave no root. Add any remaining nodes as roots.
  for (const node of doc.nodes) if (!visited.has(node.id)) forest.push(makeTree(node.id));

  const positions = new Map<string, { x: number; y: number }>();
  let offsetY = 30;
  for (const item of forest) {
    const root = tree<HierarchyItem>().nodeSize([130, 250])(hierarchy(item, (d) => d.children));
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    root.each((node) => {
      minY = Math.min(minY, node.x);
      maxY = Math.max(maxY, node.x);
    });
    root.each((node) => {
      const size = dimensions(doc, node.data.id);
      positions.set(node.data.id, {
        x: 30 + node.y,
        y: offsetY + node.x - minY,
      });
      maxY = Math.max(maxY, node.x + size.height);
    });
    offsetY += Math.max(150, maxY - minY + 90);
  }
  return centerPositions(doc, positions);
}

function layoutForce(doc: DiagramDocument): DiagramDocument {
  if (!doc.nodes.length) return doc;
  type ForceNode = { id: string; x: number; y: number; width: number; height: number };
  const nodes: ForceNode[] = doc.nodes.map((node, index) => {
    const size = dimensions(doc, node.id);
    const old = size;
    return {
      id: node.id,
      x: Number.isFinite(old.x) ? old.x : 80 + (index % 5) * 170,
      y: Number.isFinite(old.y) ? old.y : 80 + Math.floor(index / 5) * 130,
      width: size.width,
      height: size.height,
    };
  });
  const links = doc.relations
    .filter((edge) => nodes.some((node) => node.id === edge.sourceId) && nodes.some((node) => node.id === edge.targetId))
    .map((edge) => ({ source: edge.sourceId, target: edge.targetId }));
  const simulation = forceSimulation<ForceNode>(nodes)
    .force('link', forceLink<ForceNode, { source: string; target: string }>(links)
      .id((node) => node.id).distance(230).strength(0.65))
    .force('charge', forceManyBody<ForceNode>().strength(-700))
    .force('center', forceCenter<ForceNode>(350, 260))
    .force('collide', forceCollide<ForceNode>().radius((node) => Math.max(node.width, node.height) * 0.72).iterations(3))
    .stop();
  for (let i = 0; i < 240; i += 1) simulation.tick();
  simulation.stop();
  const minX = Math.min(...nodes.map((node) => node.x - node.width / 2));
  const minY = Math.min(...nodes.map((node) => node.y - node.height / 2));
  return centerPositions(doc, new Map<string, { x: number; y: number }>(nodes.map((node) => [
    node.id,
    { x: node.x - node.width / 2 - minX + 30, y: node.y - node.height / 2 - minY + 30 },
  ] as const)));
}

export async function applyLayout(doc: DiagramDocument, engine: LayoutEngine): Promise<DiagramDocument> {
  switch (engine) {
    case 'elk': return layoutElk(doc);
    case 'dagre': return layoutDagre(doc);
    case 'hierarchy': return layoutHierarchy(doc);
    case 'force': return layoutForce(doc);
  }
}
