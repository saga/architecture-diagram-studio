import { describe, expect, it } from 'vitest';
import { initialDiagram } from './diagram';
import { ensureEdgeGeometry, orthogonalWaypoints, relationPortIds } from './routing';

describe('shared diagram edge geometry', () => {
  it('creates finite named ports and orthogonal routes for legacy diagrams', () => {
    const routed = ensureEdgeGeometry(initialDiagram, 'RIGHT');
    for (const relation of routed.relations) {
      expect(Array.isArray(relation.waypoints)).toBe(true);
      const ids = relationPortIds(relation);
      const sourceLayout = routed.layout[relation.sourceId];
      const targetLayout = routed.layout[relation.targetId];
      const sourcePort = sourceLayout.ports?.find((port) => port.id === ids.source);
      const targetPort = targetLayout.ports?.find((port) => port.id === ids.target);
      expect(sourcePort).toBeDefined();
      expect(targetPort).toBeDefined();
      for (const port of [sourcePort!, targetPort!]) {
        expect(Number.isFinite(port.x)).toBe(true);
        expect(Number.isFinite(port.y)).toBe(true);
      }

      const source = sourcePort!.side === 'LEFT'
        ? { x: sourceLayout.x, y: sourceLayout.y + sourcePort!.y }
        : sourcePort!.side === 'RIGHT'
          ? { x: sourceLayout.x + sourceLayout.width, y: sourceLayout.y + sourcePort!.y }
          : sourcePort!.side === 'TOP'
            ? { x: sourceLayout.x + sourcePort!.x, y: sourceLayout.y }
            : { x: sourceLayout.x + sourcePort!.x, y: sourceLayout.y + sourceLayout.height };
      const target = targetPort!.side === 'LEFT'
        ? { x: targetLayout.x, y: targetLayout.y + targetPort!.y }
        : targetPort!.side === 'RIGHT'
          ? { x: targetLayout.x + targetLayout.width, y: targetLayout.y + targetPort!.y }
          : targetPort!.side === 'TOP'
            ? { x: targetLayout.x + targetPort!.x, y: targetLayout.y }
            : { x: targetLayout.x + targetPort!.x, y: targetLayout.y + targetLayout.height };
      const points = [source, ...(relation.waypoints ?? []), target];
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1];
        const b = points[index];
        expect(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01).toBe(true);
      }
    }
  });

  it('does not keep orphaned handles after an edge is removed', () => {
    const withoutFirstEdge = {
      ...initialDiagram,
      relations: initialDiagram.relations.slice(1),
      layout: Object.fromEntries(Object.entries(initialDiagram.layout).map(([id, geometry]) => [
        id,
        { ...geometry, ports: [{ id: 'out-r1', side: 'RIGHT' as const, x: geometry.width, y: geometry.height / 2 }] },
      ])),
    };
    const routed = ensureEdgeGeometry(withoutFirstEdge, 'RIGHT');
    expect(routed.layout.customer.ports?.some((port) => port.id === 'out-r1')).toBe(false);
  });

  it('uses a straight segment when facing ports align', () => {
    expect(orthogonalWaypoints({ x: 220, y: 100 }, { x: 310, y: 100 }, 'RIGHT', 'LEFT')).toEqual([]);
  });
});
