import dagre from '@dagrejs/dagre';
import { hierarchy, tree } from 'd3-hierarchy';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { DiagramDocument, DiagramPortLayout, DiagramPortSide, DiagramRelation, NodeLayout } from '../model/diagram';
import { validateDiagram } from '../model/validate';

export type LayoutEngine = 'elk' | 'dagre' | 'hierarchy' | 'force';
export type ElkAlgorithm = 'layered' | 'mrtree' | 'radial' | 'stress' | 'force';
export type LayoutDirection = 'RIGHT' | 'LEFT' | 'DOWN' | 'UP';

export type LayoutConfig = {
  elk: { algorithm: ElkAlgorithm; direction: LayoutDirection; nodeSpacing: number; layerSpacing: number; edgeRouting: 'ORTHOGONAL' | 'POLYLINE' | 'SPLINES'; iterations: number; randomSeed: number };
  dagre: { direction: 'LR' | 'RL' | 'TB' | 'BT'; nodeSpacing: number; layerSpacing: number; margin: number };
  hierarchy: { direction: LayoutDirection; nodeSpacingX: number; nodeSpacingY: number; componentSpacing: number; margin: number };
  force: { linkDistance: number; linkStrength: number; repulsion: number; collisionScale: number; collisionIterations: number; simulationTicks: number; margin: number };
};

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  elk: { algorithm: 'layered', direction: 'RIGHT', nodeSpacing: 64, layerSpacing: 90, edgeRouting: 'ORTHOGONAL', iterations: 300, randomSeed: 1 },
  dagre: { direction: 'LR', nodeSpacing: 64, layerSpacing: 90, margin: 30 },
  hierarchy: { direction: 'RIGHT', nodeSpacingX: 130, nodeSpacingY: 250, componentSpacing: 90, margin: 30 },
  force: { linkDistance: 230, linkStrength: 0.65, repulsion: 700, collisionScale: 0.72, collisionIterations: 3, simulationTicks: 240, margin: 30 },
};

export const LAYOUT_ENGINES: Array<{ value: LayoutEngine; label: string; hint: string }> = [
  { value: 'elk', label: 'ELK', hint: 'Layered, tree, radial, stress, or force layout with optional ports and edge routing' },
  { value: 'dagre', label: 'Dagre', hint: 'Fast directed layered graph layout' },
  { value: 'hierarchy', label: 'D3 Hierarchy', hint: 'Tree / forest layout; cross-links do not affect tree placement' },
  { value: 'force', label: 'D3 Force', hint: 'Force-directed layout for connected graphs' },
];

const elk = new ELK();
const DEFAULT_WIDTH = 190;
const DEFAULT_HEIGHT = 84;
const PORT_SIZE = 8;

function dimensions(doc: DiagramDocument, id: string): NodeLayout {
  return doc.layout[id] ?? { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function validateLayoutInput(doc: DiagramDocument): void {
  const errors = validateDiagram(doc).filter((issue) => issue.severity === 'error');
  if (errors.length) throw new Error('Cannot lay out an invalid diagram: ' + errors.map((issue) => issue.message).join(' '));
}

function portIds(relation: DiagramRelation): { source: string; target: string } {
  return { source: relation.sourceHandleId ?? 'out-' + relation.id, target: relation.targetHandleId ?? 'in-' + relation.id };
}

function sidesForDirection(direction: LayoutDirection): { source: DiagramPortSide; target: DiagramPortSide } {
  switch (direction) {
    case 'LEFT': return { source: 'LEFT', target: 'RIGHT' };
    case 'DOWN': return { source: 'BOTTOM', target: 'TOP' };
    case 'UP': return { source: 'TOP', target: 'BOTTOM' };
    default: return { source: 'RIGHT', target: 'LEFT' };
  }
}

function elkPortSpecifications(doc: DiagramDocument, direction: LayoutDirection): Map<string, DiagramPortLayout[]> {
  const sides = sidesForDirection(direction);
  const portsByNode = new Map<string, Map<string, DiagramPortLayout>>();
  const add = (nodeId: string, id: string, side: DiagramPortSide) => {
    let ports = portsByNode.get(nodeId);
    if (!ports) { ports = new Map(); portsByNode.set(nodeId, ports); }
    if (!ports.has(id)) ports.set(id, { id, side, x: 0, y: 0 });
  };
  for (const relation of doc.relations) {
    const ids = portIds(relation);
    add(relation.sourceId, ids.source, sides.source);
    add(relation.targetId, ids.target, sides.target);
  }
  return new Map(Array.from(portsByNode, ([nodeId, ports]) => [nodeId, Array.from(ports.values())]));
}

function withoutPorts(layout: NodeLayout): Omit<NodeLayout, 'ports'> {
  const { ports: _ports, ...geometry } = layout;
  return geometry;
}

function centerPositions(
  doc: DiagramDocument,
  positions: Map<string, { x: number; y: number; ports?: DiagramPortLayout[] }>,
  preservePorts = false,
): DiagramDocument {
  const layout = { ...doc.layout };
  for (const node of doc.nodes) {
    const current = dimensions(doc, node.id);
    const point = positions.get(node.id);
    if (!point) continue;
    const geometry = preservePorts ? current : withoutPorts(current);
    layout[node.id] = {
      ...geometry,
      x: point.x,
      y: point.y,
      ...(point.ports ? { ports: point.ports } : {}),
    };
  }
  return { ...doc, layout };
}

async function layoutElk(doc: DiagramDocument, config: LayoutConfig['elk']): Promise<DiagramDocument> {
  const portSpecifications = elkPortSpecifications(doc, config.direction);
  const result = await elk.layout({
    id: doc.id,
    layoutOptions: {
      'elk.algorithm': config.algorithm,
      'elk.direction': config.direction,
      'elk.spacing.nodeNode': String(config.nodeSpacing),
      'elk.layered.spacing.nodeNodeBetweenLayers': String(config.layerSpacing),
      'elk.edgeRouting': config.edgeRouting,
      'elk.separateConnectedComponents': 'true',
      'elk.randomSeed': String(config.randomSeed),
      'elk.stress.iterationLimit': String(config.iterations),
      'elk.force.iterations': String(config.iterations),
    },
    children: doc.nodes.map((node) => {
      const size = dimensions(doc, node.id);
      const ports = portSpecifications.get(node.id) ?? [];
      return {
        id: node.id,
        width: size.width,
        height: size.height,
        ports: ports.map((port) => ({
          id: port.id,
          width: PORT_SIZE,
          height: PORT_SIZE,
          properties: { side: port.side === 'LEFT' ? 'WEST' : port.side === 'RIGHT' ? 'EAST' : port.side === 'TOP' ? 'NORTH' : 'SOUTH' },
        })),
        ...(ports.length ? { properties: { 'org.eclipse.elk.portConstraints': 'FIXED_ORDER' } } : {}),
      };
    }),
    edges: doc.relations.map((edge) => {
      const ids = portIds(edge);
      return { id: edge.id, sources: [ids.source], targets: [ids.target] };
    }),
  });

  const positions = new Map<string, { x: number; y: number; ports?: DiagramPortLayout[] }>();
  for (const node of result.children ?? []) {
    const requested = new Map((portSpecifications.get(node.id) ?? []).map((port) => [port.id, port]));
    const ports = (node.ports ?? []).map((port) => {
      const expected = requested.get(port.id);
      const side = (port.layoutOptions?.['org.eclipse.elk.port.side'] as DiagramPortSide | undefined) ?? expected?.side ?? 'RIGHT';
      return {
        id: port.id,
        side,
        x: Number(port.x ?? (side === 'LEFT' ? 0 : dimensions(doc, node.id).width)) + PORT_SIZE / 2,
        y: Number(port.y ?? (side === 'TOP' ? 0 : dimensions(doc, node.id).height)) + PORT_SIZE / 2,
      };
    });
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0, ports });
  }
  const positioned = centerPositions(doc, positions, true);
  const routes = new Map<string, Array<{ x: number; y: number }>>();
  for (const edge of result.edges ?? []) {
    if (!edge.sections) continue;
    routes.set(edge.id, edge.sections.flatMap((section) => (section.bendPoints ?? []).map((point) => ({ x: point.x, y: point.y }))));
  }
  return {
    ...positioned,
    relations: positioned.relations.map((relation) => ({
      ...relation,
      waypoints: routes.has(relation.id) ? routes.get(relation.id) : undefined,
    })),
  };
}

function layoutDagre(doc: DiagramDocument, config: LayoutConfig['dagre']): DiagramDocument {
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: config.direction, nodesep: config.nodeSpacing, ranksep: config.layerSpacing, marginx: config.margin, marginy: config.margin });
  for (const node of doc.nodes) {
    const size = dimensions(doc, node.id);
    graph.setNode(node.id, { width: size.width, height: size.height });
  }
  for (const edge of doc.relations) graph.setEdge(edge.sourceId, edge.targetId, {}, edge.id);
  dagre.layout(graph);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of doc.nodes) {
    const point = graph.node(node.id) as { x: number; y: number };
    const size = dimensions(doc, node.id);
    positions.set(node.id, { x: point.x - size.width / 2, y: point.y - size.height / 2 });
  }
  return {
    ...centerPositions(doc, positions),
    relations: doc.relations.map(({ waypoints: _waypoints, ...relation }) => relation),
  };
}

type HierarchyItem = { id: string; children: HierarchyItem[] };

function layoutHierarchy(doc: DiagramDocument, config: LayoutConfig['hierarchy']): DiagramDocument {
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
  const visited = new Set<string>();
  const makeTree = (id: string): HierarchyItem => {
    visited.add(id);
    return { id, children: (childrenById.get(id) ?? []).filter((childId) => !visited.has(childId)).map(makeTree) };
  };
  const roots = doc.nodes.filter((node) => !incoming.has(node.id));
  const forest: HierarchyItem[] = [];
  for (const node of roots) if (!visited.has(node.id)) forest.push(makeTree(node.id));
  for (const node of doc.nodes) if (!visited.has(node.id)) forest.push(makeTree(node.id));

  const positions = new Map<string, { x: number; y: number }>();
  let offsetY = config.margin;
  for (const item of forest) {
    const root = tree<HierarchyItem>().nodeSize([config.nodeSpacingX, config.nodeSpacingY])(hierarchy(item, (d) => d.children));
    const descendants = root.descendants();
    const coords = descendants.map((node) => {
      const size = dimensions(doc, node.data.id);
      const cx = config.direction === 'RIGHT' ? node.y : config.direction === 'LEFT' ? -node.y : node.x;
      const cy = config.direction === 'DOWN' ? node.y : config.direction === 'UP' ? -node.y : node.x;
      return { node, size, cx, cy };
    });
    const minX = Math.min(...coords.map((point) => point.cx - point.size.width / 2));
    const maxX = Math.max(...coords.map((point) => point.cx + point.size.width / 2));
    const minY = Math.min(...coords.map((point) => point.cy - point.size.height / 2));
    const maxY = Math.max(...coords.map((point) => point.cy + point.size.height / 2));
    for (const point of coords) {
      positions.set(point.node.data.id, {
        x: config.margin + point.cx - point.size.width / 2 - minX,
        y: offsetY + point.cy - point.size.height / 2 - minY,
      });
    }
    offsetY += Math.max(150, maxY - minY + config.componentSpacing);
    // Keep the computed horizontal extent available for future canvas sizing diagnostics.
    void maxX;
  }
  return {
    ...centerPositions(doc, positions),
    relations: doc.relations.map(({ waypoints: _waypoints, ...relation }) => relation),
  };
}

function layoutForce(doc: DiagramDocument, config: LayoutConfig['force']): DiagramDocument {
  if (!doc.nodes.length) return doc;
  type ForceNode = { id: string; x: number; y: number; width: number; height: number };
  const nodes: ForceNode[] = doc.nodes.map((node, index) => {
    const size = dimensions(doc, node.id);
    return { id: node.id, x: Number.isFinite(size.x) ? size.x + size.width / 2 : 80 + (index % 5) * 170, y: Number.isFinite(size.y) ? size.y + size.height / 2 : 80 + Math.floor(index / 5) * 130, width: size.width, height: size.height };
  });
  const links = doc.relations.filter((edge) => nodes.some((node) => node.id === node.sourceId) && nodes.some((node) => node.id === edge.targetId)).map((edge) => ({ source: edge.sourceId, target: edge.targetId }));
  const simulation = forceSimulation<ForceNode>(nodes)
    .force('link', forceLink<ForceNode, { source: string; target: string }>(links).id((node) => node.id).distance(config.linkDistance).strength(config.linkStrength))
    .force('charge', forceManyBody<ForceNode>().strength(-config.repulsion))
    .force('center', forceCenter<ForceNode>(350, 260))
    .force('collide', forceCollide<ForceNode>().radius((node) => Math.max(node.width, node.height) * config.collisionScale).iterations(config.collisionIterations))
    .stop();
  for (let i = 0; i < config.simulationTicks; i += 1) simulation.tick();
  simulation.stop();
  const minX = Math.min(...nodes.map((node) => node.x - node.width / 2));
  const minY = Math.min(...nodes.map((node) => node.y - node.height / 2));
  const positions = new Map<string, { x: number; y: number }>(nodes.map((node) => [
    node.id, { x: node.x - node.width / 2 - minX + config.margin, y: node.y - node.height / 2 - minY + config.margin },
  ] as const));
  return {
    ...centerPositions(doc, positions),
    relations: doc.relations.map(({ waypoints: _waypoints, ...relation }) => relation),
  };
}

export async function applyLayout(doc: DiagramDocument, engine: LayoutEngine, config: LayoutConfig = DEFAULT_LAYOUT_CONFIG): Promise<DiagramDocument> {
  validateLayoutInput(doc);
  switch (engine) {
    case 'elk': return layoutElk(doc, config.elk);
    case 'dagre': return layoutDagre(doc, config.dagre);
    case 'hierarchy': return layoutHierarchy(doc, config.hierarchy);
    case 'force': return layoutForce(doc, config.force);
  }
}
