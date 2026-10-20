import type { DiagramDocument, DiagramBoundary, NodeLayout } from './diagram';

const DEFAULT_PADDING = 36;
const BOUNDARY_HEADER = 32;

/** Resize a C4 system boundary around the current positions of its member elements. */
export function fitDiagramBoundaries(doc: DiagramDocument): DiagramDocument {
  if (!doc.boundaries?.length || doc.kind === 'sequence') return doc;
  const boundaries = doc.boundaries.map((boundary) => {
    const members = boundary.memberNodeIds
      .map((id) => {
        const node = doc.nodes.find((candidate) => candidate.id === id);
        const geometry: NodeLayout | undefined = doc.layout[id];
        return node && geometry ? geometry : undefined;
      })
      .filter((geometry): geometry is NodeLayout => !!geometry);
    if (members.length === 0) return boundary;

    const left = Math.min(...members.map((geometry) => geometry.x));
    const top = Math.min(...members.map((geometry) => geometry.y));
    const right = Math.max(...members.map((geometry) => geometry.x + geometry.width));
    const bottom = Math.max(...members.map((geometry) => geometry.y + geometry.height));
    const x = left - DEFAULT_PADDING;
    const y = top - DEFAULT_PADDING - BOUNDARY_HEADER;
    const width = right - left + DEFAULT_PADDING * 2;
    const height = bottom - top + DEFAULT_PADDING * 2 + BOUNDARY_HEADER;
    return { ...boundary, x, y, width, height };
  });
  return { ...doc, boundaries };
}

/** Create a reasonable boundary when upgrading older C4 container/component documents. */
export function ensureDiagramBoundaries(doc: DiagramDocument): DiagramDocument {
  if (doc.kind === 'sequence' || doc.boundaries?.length) return fitDiagramBoundaries(doc);
  if (doc.kind !== 'c4-container' && doc.kind !== 'c4-component') return doc;

  const memberNodeIds = doc.nodes
    .filter((node) => ['system', 'service', 'component', 'database'].includes(node.type))
    .map((node) => node.id);
  if (memberNodeIds.length === 0) return doc;

  const boundary: DiagramBoundary = {
    id: doc.kind === 'c4-component' ? 'component-system-boundary' : 'order-platform-boundary',
    label: doc.kind === 'c4-component' ? 'Order API' : 'Order Platform',
    description: 'Software system boundary',
    memberNodeIds,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  };
  return fitDiagramBoundaries({ ...doc, boundaries: [boundary] });
}

/** Reconcile one element's membership with the current diagram-kind containment rules. */
export function syncNodeBoundaryMembership(doc: DiagramDocument, nodeId: string): DiagramDocument {
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || (doc.kind !== 'c4-container' && doc.kind !== 'c4-component')) return doc;

  const eligible = doc.kind === 'c4-container'
    ? ['system', 'service', 'database'].includes(node.type)
    : node.type === 'component';
  const withoutNode = (doc.boundaries ?? [])
    .map((boundary) => ({ ...boundary, memberNodeIds: boundary.memberNodeIds.filter((id) => id !== nodeId) }))
    .filter((boundary) => boundary.memberNodeIds.length > 0);
  const scoped = { ...doc, boundaries: withoutNode };
  if (!eligible) return fitDiagramBoundaries(scoped);

  const withBoundary = ensureDiagramBoundaries(scoped);
  const firstId = withBoundary.boundaries?.[0]?.id;
  if (!firstId) return withBoundary;
  const boundaries = withBoundary.boundaries!.map((boundary) => boundary.id !== firstId
    ? boundary
    : { ...boundary, memberNodeIds: [...boundary.memberNodeIds, nodeId] });
  return fitDiagramBoundaries({ ...withBoundary, boundaries });
}

/** Add newly created C4 elements to the diagram's active system boundary when appropriate. */
export function addNodeToBoundary(doc: DiagramDocument, nodeId: string): DiagramDocument {
  return syncNodeBoundaryMembership(doc, nodeId);
}

/** Keep boundary membership valid when the user or assistant deletes semantic nodes. */
export function removeNodesFromBoundaries(doc: DiagramDocument, nodeIds: Iterable<string>): DiagramDocument {
  const removed = new Set(nodeIds);
  if (!doc.boundaries?.length) return doc;
  const boundaries = doc.boundaries
    .map((boundary) => ({ ...boundary, memberNodeIds: boundary.memberNodeIds.filter((id) => !removed.has(id)) }))
    .filter((boundary) => boundary.memberNodeIds.length > 0);
  return fitDiagramBoundaries({ ...doc, boundaries });
}
