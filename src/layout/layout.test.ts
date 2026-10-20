import { describe, expect, it } from 'vitest';
import { applyLayout, LAYOUT_ENGINES } from './layout';
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
