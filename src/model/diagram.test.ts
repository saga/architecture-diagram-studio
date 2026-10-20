import { describe, expect, it } from 'vitest';
import { initialDiagram } from './diagram';
import { createDiagramTemplate } from './templates';
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

  it('uses compatible node shapes, two-level labels, explicit edge routes and anchors', () => {
    const xml = exportDrawio(initialDiagram);
    expect(xml).toContain('fillColor=#08427b;strokeColor=#052c52;fontColor=#ffffff;');
    expect(xml).toContain('fillColor=#438dd5;strokeColor=#2d6fae;fontColor=#ffffff;');
    expect(xml).toContain('fontSize=12');
    expect(xml).toContain('&lt;div style=&quot;font-family:Arial,sans-serif;text-align:center;color:inherit;');
    expect(xml).toContain('font-size:11px;font-weight:400;line-height:1.2;');
    expect(xml).toContain('edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#334e68;strokeWidth=1.5;');
    expect(xml).toContain('exitX=1;exitY=');
    expect(xml).toContain('entryX=0;entryY=');
    expect(xml).toContain('<Array as="points">');
  });

  it('exports C4 semantic roles as C4 cards rather than UML stick figures or database cylinders', () => {
    const xml = exportDrawio(initialDiagram);
    expect(xml).toContain('&#171;Person&#187;');
    expect(xml).toContain('&#171;Container&#187;');
    expect(xml).toContain('&#171;Container · Database&#187;');
    expect(xml).not.toContain('shape=umlActor');
    expect(xml).not.toContain('shape=cylinder3');
  });

  it('exports a sequence diagram with lifelines, ordered messages, activations and fragments', () => {
    const sequence = createDiagramTemplate('sequence');
    expect(validateDiagram(sequence).filter(issue => issue.severity === 'error')).toEqual([]);
    const xml = exportDrawio(sequence);
    expect(xml).toContain('UML Sequence Diagram');
    expect(xml).toContain('lifeline-customer');
    expect(xml).toContain('dashed=1;dashPattern=3 4');
    expect(xml).toContain('msg-1');
    expect(xml).toContain('1. Place order');
    expect(xml).toContain('activation-api-msg-2');
    expect(xml).toContain('fragment-fragment-payment');
    expect(xml).toContain('opt');
    expect(xml).toContain('as="sourcePoint"');
    expect(xml).toContain('as="targetPoint"');
  });

  it('rejects sequence messages whose participant references are missing', () => {
    const sequence = createDiagramTemplate('sequence');
    sequence.sequence!.messages[0].toParticipantId = 'missing-participant';
    expect(validateDiagram(sequence).some(issue => issue.code === 'SEQUENCE_TARGET_NOT_FOUND')).toBe(true);
    expect(() => exportDrawio(sequence)).toThrow(/missing target participant/);
  });

  it('produces stable XML for the same document snapshot', () => {
    expect(exportDrawio(initialDiagram)).toBe(exportDrawio(initialDiagram));
  });

  it('escapes user-provided labels', () => {
    const doc = { ...initialDiagram, title: 'A & B <Platform>' };
    expect(exportDrawio(doc)).toContain('name="A &amp; B &lt;Platform&gt;"');
  });
});
