import type { DiagramDocument, DiagramPortLayout, DiagramPortSide, DiagramRelation, NodeLayout } from './diagram';
import type { LayoutDirection } from '../layout/layout';

const DEFAULT_WIDTH = 190;
const DEFAULT_HEIGHT = 84;
const ROUTE_CLEARANCE = 24;

export function relationPortIds(relation: DiagramRelation): { source: string; target: string } {
  return {
    source: relation.sourceHandleId ?? 'out-' + relation.id,
    target: relation.targetHandleId ?? 'in-' + relation.id,
  };
}

export function oppositePortSide(side: DiagramPortSide): DiagramPortSide {
  return side === 'LEFT' ? 'RIGHT' : side === 'RIGHT' ? 'LEFT' : side === 'TOP' ? 'BOTTOM' : 'TOP';
}

export function layoutDirectionFor(
  engine: 'elk' | 'dagre' | 'hierarchy' | 'force',
  config: { elk: { direction: LayoutDirection }; dagre: { direction: 'LR' | 'RL' | 'TB' | 'BT' }; hierarchy: { direction: LayoutDirection } },
): LayoutDirection {
  if (engine === 'dagre') return ({ LR: 'RIGHT', RL: 'LEFT', TB: 'DOWN', BT: 'UP' } as const)[config.dagre.direction];
  if (engine === 'hierarchy') return config.hierarchy.direction;
  if (engine === 'elk') return config.elk.direction;
  return 'RIGHT';
}

function directionalSides(direction: LayoutDirection): { source: DiagramPortSide; target: DiagramPortSide } {
  if (direction === 'LEFT') return { source: 'LEFT', target: 'RIGHT' };
  if (direction === 'DOWN') return { source: 'BOTTOM', target: 'TOP' };
  if (direction === 'UP') return { source: 'TOP', target: 'BOTTOM' };
  return { source: 'RIGHT', target: 'LEFT' };
}

function dimensions(doc: DiagramDocument, nodeId: string): NodeLayout {
  return doc.layout[nodeId] ?? { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

function getPortSide(port: DiagramPortLayout | undefined, fallback: DiagramPortSide): DiagramPortSide {
  return port?.side ?? fallback;
}

function portPosition(port: DiagramPortLayout, width: number, height: number): { x: number; y: number } {
  if (port.side === 'LEFT') return { x: 0, y: port.y };
  if (port.side === 'RIGHT') return { x: width, y: port.y };
  if (port.side === 'TOP') return { x: port.x, y: 0 };
  return { x: port.x, y: height };
}

export function orthogonalWaypoints(
  source: { x: number; y: number },
  target: { x: number; y: number },
  sourceSide: DiagramPortSide,
  targetSide: DiagramPortSide,
  clearance = ROUTE_CLEARANCE,
): Array<{ x: number; y: number }> {
  const vector = (side: DiagramPortSide) => side === 'LEFT' ? { x: -1, y: 0 }
    : side === 'RIGHT' ? { x: 1, y: 0 }
    : side === 'TOP' ? { x: 0, y: -1 } : { x: 0, y: 1 };
  const sv = vector(sourceSide);
  const tv = vector(targetSide);
  const start = { x: source.x + sv.x * clearance, y: source.y + sv.y * clearance };
  const end = { x: target.x + tv.x * clearance, y: target.y + tv.y * clearance };
  const horizontalPorts = (sourceSide === 'LEFT' || sourceSide === 'RIGHT')
    && (targetSide === 'LEFT' || targetSide === 'RIGHT');
  const verticalPorts = (sourceSide === 'TOP' || sourceSide === 'BOTTOM')
    && (targetSide === 'TOP' || targetSide === 'BOTTOM');

  let points: Array<{ x: number; y: number }>;
  if (horizontalPorts) {
    const facing = (sourceSide === 'RIGHT' && targetSide === 'LEFT' && target.x >= source.x)
      || (sourceSide === 'LEFT' && targetSide === 'RIGHT' && target.x <= source.x);
    if (facing && Math.abs(source.y - target.y) < 0.5) return [];
    const channelX = facing ? (start.x + end.x) / 2
      : (sourceSide === 'RIGHT' && targetSide === 'RIGHT' ? Math.max(source.x, target.x) + clearance * 2
        : sourceSide === 'LEFT' && targetSide === 'LEFT' ? Math.min(source.x, target.x) - clearance * 2
        : (start.x + end.x) / 2);
    points = [start, { x: channelX, y: start.y }, { x: channelX, y: end.y }, end];
  } else if (verticalPorts) {
    const facing = (sourceSide === 'BOTTOM' && targetSide === 'TOP' && target.y >= source.y)
      || (sourceSide === 'TOP' && targetSide === 'BOTTOM' && target.y <= source.y);
    if (facing && Math.abs(source.x - target.x) < 0.5) return [];
    const channelY = facing ? (start.y + end.y) / 2
      : sourceSide === 'BOTTOM' && targetSide === 'BOTTOM' ? Math.max(source.y, target.y) + clearance * 2
        : sourceSide === 'TOP' && targetSide === 'TOP' ? Math.min(source.y, target.y) - clearance * 2
        : (start.y + end.y) / 2;
    points = [start, { x: start.x, y: channelY }, { x: end.x, y: channelY }, end];
  } else {
    points = [start, { x: start.x, y: end.y }, end];
  }

  const simplified: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const previous = simplified[simplified.length - 1];
    if (previous && Math.abs(previous.x - point.x) < 0.5 && Math.abs(previous.y - point.y) < 0.5) continue;
    if (simplified.length >= 2) {
      const a = simplified[simplified.length - 2];
      const b = simplified[simplified.length - 1];
      const sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - point.x) < 0.5;
      const sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - point.y) < 0.5;
      if (sameX || sameY) simplified.pop();
    }
    simplified.push(point);
  }
  return simplified;
}

/** Add stable handles and deterministic orthogonal edge paths to a diagram.
 * Existing ELK port positions and bend points are preserved; legacy diagrams get defaults.
 */
export function ensureEdgeGeometry(doc: DiagramDocument, direction: LayoutDirection = 'RIGHT'): DiagramDocument {
  const sides = directionalSides(direction);
  const portMaps = new Map<string, Map<string, DiagramPortLayout>>();
  for (const node of doc.nodes) {
    portMaps.set(node.id, new Map((doc.layout[node.id]?.ports ?? []).map((port) => [port.id, { ...port }])));
  }

  const add = (nodeId: string, portId: string, side: DiagramPortSide) => {
    const nodePorts = portMaps.get(nodeId);
    if (!nodePorts || nodePorts.has(portId)) return;
    nodePorts.set(portId, { id: portId, side, x: Number.NaN, y: Number.NaN });
  };

  for (const relation of doc.relations) {
    const ids = relationPortIds(relation);
    add(relation.sourceId, ids.source, sides.source);
    add(relation.targetId, ids.target, sides.target);
  }

  for (const node of doc.nodes) {
    const ports = portMaps.get(node.id)!;
    if (![...ports.values()].some((port) => port.id.startsWith('out-'))) {
      ports.set('out-default-' + node.id, { id: 'out-default-' + node.id, side: sides.source, x: Number.NaN, y: Number.NaN });
    }
    if (![...ports.values()].some((port) => port.id.startsWith('in-'))) {
      ports.set('in-default-' + node.id, { id: 'in-default-' + node.id, side: sides.target, x: Number.NaN, y: Number.NaN });
    }

    const oldGeometry = dimensions(doc, node.id);
    const bySide = new Map<DiagramPortSide, DiagramPortLayout[]>();
    for (const port of ports.values()) {
      const group = bySide.get(port.side) ?? [];
      group.push(port);
      bySide.set(port.side, group);
    }
    for (const [side, group] of bySide) {
      group.forEach((port, index) => {
        const localX = side === 'LEFT' ? 0 : side === 'RIGHT' ? oldGeometry.width : oldGeometry.width * (index + 1) / (group.length + 1);
        const localY = side === 'TOP' ? 0 : side === 'BOTTOM' ? oldGeometry.height : oldGeometry.height * (index + 1) / (group.length + 1);
        if (!Number.isFinite(port.x) || !Number.isFinite(port.y) || (port.x === 0 && port.y === 0 && side !== 'LEFT' && side !== 'TOP')) {
          port.x = localX;
          port.y = localY;
        }
      });
    }
  }

  const layout = { ...doc.layout };
  for (const node of doc.nodes) {
    const oldGeometry = dimensions(doc, node.id);
    layout[node.id] = { ...oldGeometry, ports: [...portMaps.get(node.id)!.values()] };
  }
  const portAware = { ...doc, layout };
  return {
    ...portAware,
    relations: portAware.relations.map((relation) => {
      if (Array.isArray(relation.waypoints)) return relation;
      const ids = relationPortIds(relation);
      const sourceGeometry = dimensions(portAware, relation.sourceId);
      const targetGeometry = dimensions(portAware, relation.targetId);
      const sourcePort = portAware.layout[relation.sourceId]?.ports?.find((port) => port.id === ids.source);
      const targetPort = portAware.layout[relation.targetId]?.ports?.find((port) => port.id === ids.target);
      if (!sourcePort || !targetPort) return { ...relation, waypoints: [] };
      const sourceLocal = portPosition(sourcePort, sourceGeometry.width, sourceGeometry.height);
      const targetLocal = portPosition(targetPort, targetGeometry.width, targetGeometry.height);
      return {
        ...relation,
        waypoints: orthogonalWaypoints(
          { x: sourceGeometry.x + sourceLocal.x, y: sourceGeometry.y + sourceLocal.y },
          { x: targetGeometry.x + targetLocal.x, y: targetGeometry.y + targetLocal.y },
          getPortSide(sourcePort, sides.source),
          getPortSide(targetPort, sides.target),
        ),
      };
    }),
  };
}
