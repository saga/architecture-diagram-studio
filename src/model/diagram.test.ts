import { describe, expect, it } from 'vitest';
import { initialDiagram } from './diagram';
import { validateDiagram } from './validate';
import { exportDrawio } from '../export/drawio';

describe('diagram validation', () => {
  it('accepts the bundled example', () => {
    expect(validateDiagram(initialDiagram).filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('rejects relations that reference missing nodes', () => {
    const invalid = {
      ...initialDiagram,
      relations: [...initialDiagram.relations, { id: 'broken', sourceId: 'missing', targetId: 'api', label: 'broken' }],
    };
    expect(validateDiagram(invalid).some(issue => issue.code === 'SOURCE_NOT_FOUND')).toBe(true);
    expect(() => exportDrawio(invalid)).toThrow(/missing source/);
  });
});

describe('draw.io export', () => {
  it('preserves node geometry and edge waypoints', () => {
    const doc = {
      ...initialDiagram,
      layout: { ...initialDiagram.layout, api: { x: 612.5, y: 177, width: 204, height: 92 } },
      relations: [{ ...initialDiagram.relations[0], waypoints: [{ x: 250, y: 210 }, { x: 280, y: 210 }] }, ...initialDiagram.relations.slice(1)],
    };
    const xml = exportDrawio(doc);
    expect(xml).toContain('x="612.5" y="177" width="204" height="92"');
    expect(xml).toContain('<mxPoint x="250" y="210"/>');
    expect(xml).toContain('<mxPoint x="280" y="210"/>');
  });

  it('exports named handle positions as draw.io edge entry and exit anchors', () => {
    const doc = {
      ...initialDiagram,
      layout: {
        ...initialDiagram.layout,
        customer: {
          ...initialDiagram.layout.customer,
          ports: [{ id: 'out-r1', side: 'RIGHT' as const, x: 170, y: 42 }],
        },
        web: {
          ...initialDiagram.layout.web,
          ports: [{ id: 'in-r1', side: 'LEFT' as const, x: 0, y: 42 }],
        },
      },
    };
    const xml = exportDrawio(doc);
    expect(xml).toContain('exitX=1;exitY=0.5;exitPerimeter=1;');
    expect(xml).toContain('entryX=0;entryY=0.5;entryPerimeter=1;');
  });

  it('produces stable XML for the same document snapshot', () => {
    expect(exportDrawio(initialDiagram)).toBe(exportDrawio(initialDiagram));
  });

  it('escapes user-provided labels', () => {
    const doc = { ...initialDiagram, title: 'A & B <Platform>' };
    expect(exportDrawio(doc)).toContain('name="A &amp; B &lt;Platform&gt;"');
  });
});
