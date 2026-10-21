import { describe, expect, it } from "vitest";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "../model/fixtures";
import { layoutDiagram, moveNode } from "./layout";
import { LAYOUT_PROFILES } from "./profiles";
import { evaluateLayout } from "./quality";
import { applyIntent } from "../intent/applyIntent";
import { normalizeSequenceDocument } from "./sequence";
import { deriveSequenceActivations } from "./sequence";
import { toDrawioXml } from "../export/drawio";

async function expectNoNodeOverlap(factory: () => ReturnType<typeof createC4Fixture>) {
  const result = await layoutDiagram(factory());
  expect(evaluateLayout(result).metrics.nodeOverlaps).toBe(0);
}

describe("V2 diagram-specific layouts", () => {
  it("lays out C4 without overlapping nodes", async () => {
    await expectNoNodeOverlap(createC4Fixture);
  });
  it("lays out the main process flow without overlapping nodes", async () => {
    await expectNoNodeOverlap(createFlowFixture);
  });
  it("supports alternate ELK layout profiles without forcing layered semantic lanes", async () => {
    for (const profile of ["elk-layered", "elk-mrtree", "elk-radial", "elk-stress", "elk-force"]) {
      const document = { ...createC4Fixture(), layout: { ...createC4Fixture().layout, profile } };
      const result = await layoutDiagram(document);
      expect(result.nodes).toHaveLength(document.nodes.length);
      expect(result.relations).toHaveLength(document.relations.length);
      expect(result.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    }
  });

  it("registers Dagre and supports horizontal and vertical layouts", async () => {
    expect(LAYOUT_PROFILES.map((profile) => profile.value)).toContain("dagre-layered");
    const horizontalDoc = createC4Fixture();
    horizontalDoc.layout.profile = "dagre-layered";
    horizontalDoc.layout.direction = "RIGHT";
    const verticalDoc = {
      ...createC4Fixture(),
      layout: { ...createC4Fixture().layout, profile: "dagre-layered", direction: "DOWN" as const },
    };
    const horizontal = await layoutDiagram(horizontalDoc);
    const vertical = await layoutDiagram(verticalDoc);

    for (const result of [horizontal, vertical]) {
      expect(result.nodes).toHaveLength(createC4Fixture().nodes.length);
      expect(result.relations).toHaveLength(createC4Fixture().relations.length);
      expect(result.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
      expect(evaluateLayout(result).metrics.nodeOverlaps).toBe(0);
    }

    const horizontalWidth = Math.max(...horizontal.nodes.map((node) => node.x + node.width)) - Math.min(...horizontal.nodes.map((node) => node.x));
    const horizontalHeight = Math.max(...horizontal.nodes.map((node) => node.y + node.height)) - Math.min(...horizontal.nodes.map((node) => node.y));
    const verticalWidth = Math.max(...vertical.nodes.map((node) => node.x + node.width)) - Math.min(...vertical.nodes.map((node) => node.x));
    const verticalHeight = Math.max(...vertical.nodes.map((node) => node.y + node.height)) - Math.min(...vertical.nodes.map((node) => node.y));
    expect(horizontalWidth).toBeGreaterThan(horizontalHeight);
    expect(verticalHeight).toBeGreaterThan(verticalWidth);
  });

  it("lays out sequence participants and keeps the message timeline ordered", async () => {
    const result = await layoutDiagram(createSequenceFixture());
    await expectNoNodeOverlap(createSequenceFixture);
    const orders = result.relations.map((edge) => edge.sequenceOrder ?? -1);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(result.nodes.map((node) => node.x)).toEqual([...result.nodes].map((node) => node.x).sort((a, b) => a - b));
    expect(result.nodes.every((node) => node.y === 54)).toBe(true);
    const activations = deriveSequenceActivations(result);
    expect(activations).toHaveLength(4);
    expect(activations.map((activation) => activation.participantId)).toEqual(["web", "bff", "identity", "session"]);
    expect(toDrawioXml(result)).toContain("__sequenceActivation");
  });

  it("exports every regular relation as a draw.io edge with resolvable source and target", () => {
    const document = createC4Fixture();
    const xml = toDrawioXml(document);
    for (const relation of document.relations) {
      expect(xml).toContain('<mxCell id="' + relation.id + '"');
      expect(xml).toContain('edge="1" parent="1" source="' + relation.source + '" target="' + relation.target + '"');
    }
    expect((xml.match(/edge="1"/g) || []).length).toBe(document.relations.length);
  });

  it("exports editable sequence fragments and retains message semantics", () => {
    const document = createSequenceFixture();
    document.sequence = {
      ...(document.sequence || { participants: [] }),
      fragments: [{ id: "alt-token", kind: "alt", label: "Token valid or expired", startOrder: 1, endOrder: 4 }]
    };
    const xml = toDrawioXml(document);
    expect(xml).toContain("alt-token__sequenceFragment");
    expect(xml).toContain("studioSequenceFragment=1");
    expect(xml).toContain("studioKind=call");
    expect(xml).toContain("studioSequenceOrder=0");
    for (const relation of document.relations) {
      expect(xml).toContain('id="' + relation.id + '"');
      expect(xml).toContain('studioSource=' + relation.source);
      expect(xml).toContain('studioTarget=' + relation.target);
    }
    expect(xml).toContain('as="sourcePoint"');
    expect(xml).toContain('as="targetPoint"');
  });

  it("keeps polyline waypoints after a curve-to-polyline layout intent", async () => {
    const document = createC4Fixture();
    document.layout.routing = "curved";
    document.relations = document.relations.map((edge) => ({ ...edge, routing: "curved", points: [] }));
    const result = await applyIntent(document, "把曲线改成折线");
    expect(result.document.layout.routing).toBe("polyline");
    expect(result.document.relations.some((edge) => (edge.points?.length || 0) > 0)).toBe(true);
  });

  it("snaps a dragged node to an open grid position when dropped on another node", async () => {
    const document = await layoutDiagram(createC4Fixture());
    const [moving, blocker] = document.nodes;
    const result = moveNode(document, moving.id, blocker.x, blocker.y);
    expect(evaluateLayout(result).metrics.nodeOverlaps).toBe(0);
    expect(result.nodes.find((node) => node.id === moving.id)?.layoutHints?.locked).toBe(true);
  });
  it("renumbers sequence messages and clamps fragments after deletions", () => {
    const document = createSequenceFixture();
    document.relations = document.relations.filter((relation) => !["s3", "s4", "s5", "s6", "s7"].includes(relation.id));
    document.relations = document.relations.map((relation, index) => ({ ...relation, sequenceOrder: index * 2 }));
    document.sequence = {
      ...(document.sequence || { participants: [] }),
      fragments: [{ id: "loop-1", kind: "loop", label: "Retry", startOrder: 6, endOrder: 8 }]
    };
    const normalized = normalizeSequenceDocument(document);
    expect(normalized.relations.map((relation) => relation.sequenceOrder)).toEqual([0, 1, 2]);
    expect(normalized.sequence?.fragments?.[0].startOrder).toBe(2);
    expect(normalized.sequence?.fragments?.[0].endOrder).toBe(2);
  });
});