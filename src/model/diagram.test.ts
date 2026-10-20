import { describe, expect, it } from 'vitest';
import { initialDiagram, isNodeTypeAllowedForDiagramKind } from './diagram';
import { createDiagramTemplate } from './templates';
import { validateDiagram } from './validate';
import { exportDrawio } from '../export/drawio';

describe('diagram-kind element vocabulary', () => {
  it('keeps C4 Context, Container, and Component element types distinct', () => {
    expect(isNodeTypeAllowedForDiagramKind('c4-context', 'person')).toBe(true);
    expect(isNodeTypeAllowedForDiagramKind('c4-context', 'service')).toBe(false);
    expect(isNodeTypeAllowedForDiagramKind('c4-container', 'database')).toBe(true);
    expect(isNodeTypeAllowedForDiagramKind('c4-container', 'component')).toBe(false);
    expect(isNodeTypeAllowedForDiagramKind('c4-component', 'component')).toBe(true);
    expect(isNodeTypeAllowedForDiagramKind('c4-component', 'service')).toBe(false);
    expect(isNodeTypeAllowedForDiagramKind('c4-container', 'boundary')).toBe(false);
    expect(isNodeTypeAllowedForDiagramKind('sequence', 'service')).toBe(false);
  });
});

describe('diagram validation', () => {
  it('accepts the bundled example', () => {
    expect(validateDiagram(initialDiagram).filter(issue => issue.severity === 'error')).toEqual([]);
  });

  it('rejects invalid node and port geometry before export', () => {
    const invalid = {
      ...initialDiagram,
      layout: {
        ...initialDiagram.layout,
        api: {
          ...initialDiagram.layout.api,
          width: 0,
          ports: [{ id: 'out-r4', side: 'RIGHT' as const, x: 240, y: 80 }],
        },
      },
    };
    const codes = validateDiagram(invalid).map(issue => issue.code);
    expect(codes).toContain('NODE_GEOMETRY_INVALID');
    expect(codes).toContain('PORT_GEOMETRY_INVALID');
    expect(() => exportDrawio(invalid)).toThrow(/invalid or non-positive geometry|outside its node bounds/);
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
          ports: [{ id: 'out-r1', side: 'RIGHT' as const, x: 220, y: 56 }],
        },
        web: {
          ...initialDiagram.layout.web,
          ports: [{ id: 'in-r1', side: 'LEFT' as const, x: 0, y: 56 }],
        },
      },
    };
    const xml = exportDrawio(doc);
    expect(xml).toContain('exitX=1;exitY=0.5;exitPerimeter=1;');
    expect(xml).toContain('entryX=0;entryY=0.5;entryPerimeter=1;');
  });

  it('uses compatible node shapes, two-level labels, explicit edge routes and anchors', () => {
    const routedFixture = { ...initialDiagram, relations: initialDiagram.relations.map(relation => relation.id === 'r1' ? { ...relation, waypoints: [{ x: 300, y: 206 }, { x: 320, y: 206 }] } : relation) };
    const xml = exportDrawio(routedFixture);
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

  it('exports the C4 system boundary as an editable dashed frame behind the elements', () => {
    const xml = exportDrawio(initialDiagram);
    expect(xml).toContain('id="diagram-boundary-order-platform-boundary"');
    expect(xml).toContain('fillColor=none;strokeColor=#1168bd;strokeWidth=1.5;dashed=1;verticalAlign=top;');
    expect(xml).toContain('name="Order Platform — Container View"');
  });

  it('uses semantic green database and dashed amber external-system styles in native C4 export', () => {
    const xml = exportDrawio(initialDiagram);
    expect(xml).toContain('fillColor=#e6f5ec;strokeColor=#39805b;fontColor=#214b37;');
    expect(xml).toContain('fillColor=#fff4e5;strokeColor=#c7832e;dashed=1;fontColor=#6e4714;');
  });

  it('exports C4 semantic roles as C4 cards rather than UML stick figures or database cylinders', () => {
    const xml = exportDrawio(initialDiagram);
    expect(xml).toContain('«Person»');
    expect(xml).toContain('«Container»');
    expect(xml).toContain('«Container · Database»');
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
    expect(xml).toContain('activation-%5B%22api%22%2C%22msg-2%22%2C%22msg-7%22%5D');
    expect(xml).toContain('fragment-fragment-payment');
    expect(xml).toContain('opt');
    expect(xml).toContain('as="sourcePoint"');
    expect(xml).toContain('as="targetPoint"');
  });

  it('rejects mixed graph content in a UML Sequence document', () => {
    const sequence = createDiagramTemplate('sequence');
    sequence.nodes = [initialDiagram.nodes[0]];
    expect(validateDiagram(sequence).some(issue => issue.code === 'SEQUENCE_GRAPH_DATA_PRESENT')).toBe(true);
  });

  it('rejects duplicate activation ranges', () => {
    const sequence = createDiagramTemplate('sequence');
    const activation = sequence.sequence!.activations![0];
    sequence.sequence!.activations!.push({ ...activation });
    expect(validateDiagram(sequence).some(issue => issue.code === 'SEQUENCE_ACTIVATION_DUPLICATE')).toBe(true);
    expect(() => exportDrawio(sequence)).toThrow(/Activation range .* is duplicated/);
  });

  it('rejects activation ranges that end before they start', () => {
    const sequence = createDiagramTemplate('sequence');
    const messages = [...sequence.sequence!.messages].sort((a, b) => a.order - b.order);
    sequence.sequence!.activations = [{
      participantId: sequence.sequence!.participants[0].id,
      startMessageId: messages[messages.length - 1].id,
      endMessageId: messages[0].id,
    }];
    expect(validateDiagram(sequence).some(issue => issue.code === 'SEQUENCE_ACTIVATION_ORDER_INVALID')).toBe(true);
  });

  it('places sequence message labels above the arrow and exports orthogonal self calls', () => {
    const sequence = createDiagramTemplate('sequence');
    const message = sequence.sequence!.messages[0];
    message.fromParticipantId = message.toParticipantId;
    const xml = exportDrawio(sequence);
    expect(xml).toContain('verticalLabelPosition=top;verticalAlign=bottom;');
    expect(xml).toContain('<mxPoint x="140" y="186" as="sourcePoint"/><Array as="points"><mxPoint x="180" y="186"/><mxPoint x="180" y="164"/></Array><mxPoint x="140" y="164" as="targetPoint"/>');
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
