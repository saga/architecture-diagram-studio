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
