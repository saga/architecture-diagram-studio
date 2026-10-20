import { describe, expect, it } from 'vitest';
import { initialDiagram } from './diagram';
import { createDiagramTemplate } from './templates';
import { normalizeDiagramDocument } from './migrations';
import { validateDiagram } from './validate';
import { addNodeToBoundary, fitDiagramBoundaries, ensureDiagramBoundaries, removeNodesFromBoundaries, syncNodeBoundaryMembership } from './boundaries';

describe('diagram rendering migration', () => {
  it('enlarges legacy C4 nodes without moving their saved positions', () => {
    const legacy = {
      ...initialDiagram,
      boundaries: undefined,
      layout: {
        customer: { x: 12, y: 34, width: 170, height: 84 },
        web: { x: 220, y: 34, width: 190, height: 84 },
        api: { x: 480, y: 34, width: 190, height: 84 },
        db: { x: 740, y: 34, width: 190, height: 84 },
        payment: { x: 1000, y: 34, width: 190, height: 84 },
      },
    };
    const upgraded = normalizeDiagramDocument(legacy);
    expect(upgraded.layout.customer).toMatchObject({ x: 12, y: 34, width: 220, height: 112 });
    expect(upgraded.layout.web).toMatchObject({ x: 220, y: 34, width: 220, height: 112 });
    expect(upgraded.boundaries).toHaveLength(1);
    expect(upgraded.boundaries?.[0].memberNodeIds).toEqual(['web', 'api', 'db']);
  });

  it('repairs zero-sized nodes and malformed saved port collections before rendering', () => {
    const damaged = {
      ...initialDiagram,
      layout: {
        ...initialDiagram.layout,
        api: {
          x: Number.NaN,
          y: Number.POSITIVE_INFINITY,
          width: 0,
          height: -1,
          ports: { invalid: true },
        } as unknown as typeof initialDiagram.layout.api,
      },
    };
    const normalized = normalizeDiagramDocument(damaged);
    expect(normalized.layout.api).toMatchObject({ x: 50, y: 50, width: 220, height: 112, ports: [] });
    expect(() => validateDiagram(normalized).filter(issue => issue.severity === 'error')).not.toThrow();
  });

  it('moves legacy UML actor anchors to the center of the new C4 Person card', () => {
    const legacy = {
      ...initialDiagram,
      layout: {
        ...initialDiagram.layout,
        customer: { x: 25, y: 40, width: 170, height: 84, ports: [{ id: 'out-r1', side: 'RIGHT' as const, x: 170, y: 28 }] },
      },
      relations: [
        { ...initialDiagram.relations[0], waypoints: [{ x: 270, y: 68 }, { x: 300, y: 68 }] },
        { ...initialDiagram.relations[1], waypoints: [{ x: 600, y: 196 }, { x: 640, y: 196 }] },
        ...initialDiagram.relations.slice(2),
      ],
    };
    const upgraded = normalizeDiagramDocument(legacy);
    expect(upgraded.layout.customer.ports?.[0]).toMatchObject({ x: 220, y: 56 });
    expect(upgraded.relations[0].waypoints).toBeUndefined();
    expect(upgraded.relations[1].waypoints).toEqual([{ x: 600, y: 196 }, { x: 640, y: 196 }]);
  });

  it('resizes a system boundary around member nodes after layout changes', () => {
    const moved = {
      ...initialDiagram,
      layout: {
        ...initialDiagram.layout,
        web: { ...initialDiagram.layout.web, x: 500, y: 140 },
        api: { ...initialDiagram.layout.api, x: 850, y: 160 },
        db: { ...initialDiagram.layout.db, x: 850, y: 360 },
      },
    };
    const fitted = fitDiagramBoundaries(moved);
    const boundary = fitted.boundaries?.[0];
    expect(boundary).toBeDefined();
    expect(boundary!.x).toBeLessThan(fitted.layout.web.x);
    expect(boundary!.y).toBeLessThan(fitted.layout.web.y);
    expect(boundary!.x + boundary!.width).toBeGreaterThan(fitted.layout.api.x + fitted.layout.api.width);
    expect(boundary!.y + boundary!.height).toBeGreaterThan(fitted.layout.db.y + fitted.layout.db.height);
  });

  it('repairs stale and duplicate C4 boundary membership in persisted documents', () => {
    const legacy = {
      ...initialDiagram,
      boundaries: [{
        ...initialDiagram.boundaries![0],
        memberNodeIds: ['web', 'api', 'db', 'db', 'deleted-node', 'payment'],
      }],
    };
    const normalized = normalizeDiagramDocument(legacy);
    expect(normalized.boundaries?.[0].memberNodeIds).toEqual(['web', 'api', 'db']);
    expect(normalized.boundaries?.[0].memberNodeIds).not.toContain('deleted-node');
    expect(normalized.boundaries?.[0].memberNodeIds).not.toContain('payment');
  });

  it('removes empty stale system boundary frames when no members remain', () => {
    const legacy = {
      ...initialDiagram,
      nodes: initialDiagram.nodes.filter(node => node.id !== 'web' && node.id !== 'api' && node.id !== 'db'),
      relations: initialDiagram.relations.filter(relation => !['web', 'api', 'db'].includes(relation.sourceId) && !['web', 'api', 'db'].includes(relation.targetId)),
      layout: Object.fromEntries(Object.entries(initialDiagram.layout).filter(([id]) => !['web', 'api', 'db'].includes(id))),
    };
    const normalized = normalizeDiagramDocument(legacy);
    expect(normalized.boundaries ?? []).toEqual([]);
  });

  it('creates the correct system scope for the component template', () => {
    const doc = ensureDiagramBoundaries(createDiagramTemplate('c4-component'));
    expect(doc.boundaries?.[0].label).toBe('Order API');
    expect(doc.boundaries?.[0].memberNodeIds).toEqual(['controller', 'service', 'payment-adapter', 'repository']);
  });

  it('keeps new C4 elements inside the right boundary and removes the frame when empty', () => {
    const addedNode = { id: 'new-service', type: 'service' as const, label: 'Notification Service' };
    const added = {
      ...initialDiagram,
      nodes: [...initialDiagram.nodes, addedNode],
      layout: { ...initialDiagram.layout, 'new-service': { x: 1200, y: 180, width: 220, height: 112 } },
    };
    const scoped = addNodeToBoundary(added, 'new-service');
    expect(scoped.boundaries?.[0].memberNodeIds).toContain('new-service');

    const withoutMembers = removeNodesFromBoundaries({
      ...scoped,
      nodes: scoped.nodes.filter(node => !scoped.boundaries?.[0].memberNodeIds.includes(node.id)),
      relations: scoped.relations.filter(relation => !scoped.boundaries?.[0].memberNodeIds.includes(relation.sourceId) && !scoped.boundaries?.[0].memberNodeIds.includes(relation.targetId)),
      layout: Object.fromEntries(Object.entries(scoped.layout).filter(([id]) => !scoped.boundaries?.[0].memberNodeIds.includes(id))),
    }, scoped.boundaries?.[0].memberNodeIds ?? []);
    expect(withoutMembers.boundaries ?? []).toEqual([]);
  });

  it('does not duplicate the first member when rebuilding a missing C4 boundary', () => {
    const kept = initialDiagram.nodes.filter(node => !['system', 'service', 'component', 'database'].includes(node.type));
    const keepIds = new Set(kept.map(node => node.id));
    const base = {
      ...initialDiagram,
      nodes: kept,
      relations: initialDiagram.relations.filter(relation => keepIds.has(relation.sourceId) && keepIds.has(relation.targetId)),
      layout: Object.fromEntries(Object.entries(initialDiagram.layout).filter(([id]) => keepIds.has(id))),
      boundaries: [],
    };
    const node = { id: 'first-container', type: 'service' as const, label: 'First Container' };
    const next = addNodeToBoundary({
      ...base,
      nodes: [...base.nodes, node],
      layout: { ...base.layout, [node.id]: { x: 300, y: 100, width: 220, height: 112 } },
    }, node.id);
    expect(next.boundaries?.[0].memberNodeIds.filter(id => id === node.id)).toHaveLength(1);
  });

  it('removes elements from a C4 boundary after their type changes out of scope', () => {
    const changed = {
      ...initialDiagram,
      nodes: initialDiagram.nodes.map(node => node.id === 'api' ? { ...node, type: 'external' as const } : node),
    };
    const synced = syncNodeBoundaryMembership(changed, 'api');
    expect(synced.boundaries?.[0].memberNodeIds).not.toContain('api');
  });

  it('does not crash when legacy sequence optional collections are malformed', () => {
    const sequence = createDiagramTemplate('sequence');
    const malformed = {
      ...sequence,
      sequence: {
        ...sequence.sequence!,
        activations: { corrupt: true } as unknown as NonNullable<typeof sequence.sequence>['activations'],
        fragments: 'corrupt' as unknown as NonNullable<typeof sequence.sequence>['fragments'],
      },
    };
    const normalized = normalizeDiagramDocument(malformed);
    expect(normalized.sequence?.activations).toBeUndefined();
    expect(normalized.sequence?.fragments).toBeUndefined();
  });

  it('does not add graph boundaries to sequence diagrams', () => {
    const doc = normalizeDiagramDocument(createDiagramTemplate('sequence'));
    expect(doc.boundaries ?? []).toEqual([]);
    expect(doc.nodes).toEqual([]);
    expect(doc.relations).toEqual([]);
  });
});
