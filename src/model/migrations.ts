import type { DiagramDocument, DiagramKind, DiagramPortLayout, DiagramPortSide } from './diagram';
import { createDiagramTemplate } from './templates';
import { ensureDiagramBoundaries } from './boundaries';
import { normalizeSequenceRanges } from './sequence';

/**
 * Normalize persisted schema-v1 documents for the current renderer contract.
 *
 * Older versions used 84px-tall icon nodes. C4 cards now need enough vertical
 * space for a stereotype, title, technology and optional description. Geometry
 * is enlarged only when it is below the readable minimum; user positions and
 * any intentionally larger node dimensions are retained.
 */
export function normalizeDiagramDocument(input: DiagramDocument): DiagramDocument {
  if (input.kind === 'sequence') {
    if (!input.sequence || !Array.isArray(input.sequence.participants) || !Array.isArray(input.sequence.messages)) {
      const template = createDiagramTemplate('sequence');
      return { ...template, id: input.id || template.id, title: input.title || template.title };
    }
    return {
      ...input,
      nodes: [],
      relations: [],
      layout: {},
      boundaries: [],
      sequence: normalizeSequenceRanges({
        participants: input.sequence.participants.map((participant) => ({ ...participant })),
        messages: input.sequence.messages.map((message) => ({ ...message })),
        ...(Array.isArray(input.sequence.activations) ? { activations: input.sequence.activations.map((activation) => ({ ...activation })) } : {}),
        ...(Array.isArray(input.sequence.fragments) ? { fragments: input.sequence.fragments.map((fragment) => ({ ...fragment })) } : {}),
      }),
    };
  }

  const layout = { ...input.layout };
  const resizedNodeIds = new Set<string>();
  for (const node of input.nodes) {
    const rawGeometry = layout[node.id] as (typeof layout)[string] | null | undefined;
    const old = rawGeometry && typeof rawGeometry === 'object'
      ? rawGeometry
      : { x: 50, y: 50, width: 220, height: 112 };
    const oldX = Number.isFinite(old.x) ? old.x : 50;
    const oldY = Number.isFinite(old.y) ? old.y : 50;
    const oldWidth = Number.isFinite(old.width) && old.width > 0 ? old.width : 220;
    const oldHeight = Number.isFinite(old.height) && old.height > 0 ? old.height : 112;
    const width = Math.max(oldWidth, node.type === 'boundary' ? 260 : 220);
    const height = Math.max(oldHeight, 112);
    const nodeGeometryChanged = oldX !== old.x || oldY !== old.y || width !== old.width || height !== old.height;
    if (nodeGeometryChanged) resizedNodeIds.add(node.id);

    const sourcePorts = Array.isArray(old.ports) ? old.ports : [];
    const validPorts = sourcePorts.filter((port): port is DiagramPortLayout =>
      !!port && typeof port.id === 'string' && ['LEFT', 'RIGHT', 'TOP', 'BOTTOM'].includes(port.side)
      && Number.isFinite(port.x) && Number.isFinite(port.y));
    const portsBySide = new Map<DiagramPortSide, DiagramPortLayout[]>();
    for (const port of validPorts) {
      const group = portsBySide.get(port.side) ?? [];
      group.push(port);
      portsBySide.set(port.side, group);
    }
    const ports = validPorts.map((port) => {
      const x = port.side === 'LEFT' ? 0 : port.side === 'RIGHT' ? width : Math.min(width, Math.max(0, port.x / oldWidth * width));
      let y = port.side === 'TOP' ? 0 : port.side === 'BOTTOM' ? height : Math.min(height, Math.max(0, port.y / oldHeight * height));
      // Legacy Person ports were anchored to the UML actor's arm. They must move
      // to the card's ordinary edge positions when the old glyph is migrated.
      if (nodeGeometryChanged && node.type === 'person' && (port.side === 'LEFT' || port.side === 'RIGHT')) {
        const group = portsBySide.get(port.side) ?? [];
        const index = group.findIndex(candidate => candidate.id === port.id);
        y = height * (index + 1) / (group.length + 1);
      }
      return { ...port, x, y };
    });
    layout[node.id] = { ...old, x: oldX, y: oldY, width, height, ...(ports.length || sourcePorts.length ? { ports } : {}) };
  }

  const document: DiagramDocument = {
    ...input,
    nodes: input.nodes.map((node) => ({ ...node })),
    relations: input.relations.map((relation) => {
      if (!resizedNodeIds.has(relation.sourceId) && !resizedNodeIds.has(relation.targetId)) return { ...relation };
      // Routes calculated against legacy node bounds no longer attach to current port positions.
      const { waypoints: _obsoleteWaypoints, ...semanticRelation } = relation;
      return semanticRelation;
    }),
    layout,
  };
  // Schema-v1 remains compatible; this adjusts stale geometry and reconstructs C4 boundaries where absent.
  return ensureDiagramBoundaries(document);
}

export function isDiagramKind(value: unknown): value is DiagramKind {
  return value === 'c4-context' || value === 'c4-container' || value === 'c4-component' || value === 'sequence';
}
