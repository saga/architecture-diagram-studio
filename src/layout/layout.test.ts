import { describe, expect, it } from 'vitest';
import { applyLayout, DEFAULT_LAYOUT_CONFIG, LAYOUT_ENGINES } from './layout';
import { initialDiagram, type DiagramDocument } from '../model/diagram';

describe('layout engines', () => {
  it.each(LAYOUT_ENGINES.map((engine) => [engine.value, engine.label] as const))(
    '%s returns finite geometry for every node',
    async (engine) => {
      const result = await applyLayout(initialDiagram, engine);
      expect(result.nodes.map((node) => node.id)).toEqual(initialDiagram.nodes.map((node) => node.id));
      for (const node of result.nodes) {
        const geometry = result.layout[node.id];
        expect(geometry).toBeDefined();
        expect(Number.isFinite(geometry.x)).toBe(true);
        expect(Number.isFinite(geometry.y)).toBe(true);
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.height).toBeGreaterThan(0);
      }
      expect(result.relations).toEqual(initialDiagram.relations);
    },
  );


  it('accepts per-engine custom configuration without losing nodes or relations', async () => {
    const config = {
      ...DEFAULT_LAYOUT_CONFIG,
      elk: { ...DEFAULT_LAYOUT_CONFIG.elk, direction: 'DOWN' as const, nodeSpacing: 96, layerSpacing: 140 },
      dagre: { ...DEFAULT_LAYOUT_CONFIG.dagre, direction: 'TB' as const, nodeSpacing: 72, layerSpacing: 120, margin: 18 },
      hierarchy: { ...DEFAULT_LAYOUT_CONFIG.hierarchy, nodeSpacingX: 160, nodeSpacingY: 280, componentSpacing: 110, margin: 20 },
      force: { ...DEFAULT_LAYOUT_CONFIG.force, linkDistance: 280, linkStrength: 0.8, repulsion: 900, collisionScale: 0.8, collisionIterations: 4, simulationTicks: 280, margin: 24 },
    };
    for (const engine of LAYOUT_ENGINES) {
      const result = await applyLayout(initialDiagram, engine.value, config);
      expect(result.nodes.map((node) => node.id)).toEqual(initialDiagram.nodes.map((node) => node.id));
      expect(result.relations).toEqual(initialDiagram.relations);
      for (const node of result.nodes) {
        expect(Number.isFinite(result.layout[node.id].x)).toBe(true);
        expect(Number.isFinite(result.layout[node.id].y)).toBe(true);
      }
    }
  });

  it('keeps isolated nodes and cyclic components in hierarchy layout', async () => {
    const diagram: DiagramDocument = {
      ...initialDiagram,
      nodes: [
        { id: 'a', type: 'service', label: 'A' },
        { id: 'b', type: 'service', label: 'B' },
        { id: 'isolated', type: 'service', label: 'Isolated' },
      ],
      relations: [
        { id: 'ab', sourceId: 'a', targetId: 'b', label: 'A to B' },
        { id: 'ba', sourceId: 'b', targetId: 'a', label: 'B to A' },
      ],
      layout: {
        a: { x: 0, y: 0, width: 180, height: 80 },
        b: { x: 0, y: 0, width: 180, height: 80 },
        isolated: { x: 0, y: 0, width: 180, height: 80 },
      },
    };
    const result = await applyLayout(diagram, 'hierarchy');
    expect(Object.keys(result.layout).filter((id) => diagram.nodes.some((node) => node.id === id)).sort())
      .toEqual(['a', 'b', 'isolated']);
  });
});
