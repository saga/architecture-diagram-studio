import { describe, expect, it } from 'vitest';
import { initialDiagram } from './diagram';
import { createDiagramTemplate } from './templates';
import { normalizeDiagramDocument } from './migrations';
import { fitDiagramBoundaries, ensureDiagramBoundaries } from './boundaries';

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

  it('creates the correct system scope for the component template', () => {
    const doc = ensureDiagramBoundaries(createDiagramTemplate('c4-component'));
    expect(doc.boundaries?.[0].label).toBe('Order API');
    expect(doc.boundaries?.[0].memberNodeIds).toEqual(['controller', 'service', 'payment-adapter', 'repository']);
  });

  it('does not add graph boundaries to sequence diagrams', () => {
    const doc = normalizeDiagramDocument(createDiagramTemplate('sequence'));
    expect(doc.boundaries ?? []).toEqual([]);
    expect(doc.nodes).toEqual([]);
    expect(doc.relations).toEqual([]);
  });
});
