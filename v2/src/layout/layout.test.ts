import { describe, expect, it } from "vitest";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "../model/fixtures";
import { layoutDiagram, moveNode } from "./layout";
import { hasStackedGeometry } from "../model/types";
import { LAYOUT_PROFILES } from "./profiles";
import { evaluateLayout } from "./quality";
import { applyIntent } from "../intent/applyIntent";
import { normalizeSequenceDocument } from "./sequence";
import { deriveSequenceActivations, sequenceMessageGeometry } from "./sequence";
import { toDrawioXml } from "../export/drawio";

async function expectNoNodeOverlap(factory: () => ReturnType<typeof createC4Fixture>) {
  const result = await layoutDiagram(factory());
  expect(evaluateLayout(result).metrics.nodeOverlaps).toBe(0);
}

describe("V2 diagram-specific layouts", () => {
  it("lays out C4 without overlapping nodes", async () => {
    await expectNoNodeOverlap(createC4Fixture);
  });

  it("flags a sample that has no geometry yet, so it is laid out before the first paint", async () => {
    const fixture = createC4Fixture();
    expect(hasStackedGeometry(fixture)).toBe(true);
    expect(hasStackedGeometry(await layoutDiagram(fixture))).toBe(false);
  });

  it("keeps every sample on a profile the layout endpoint accepts", () => {
    // Legacy names (architecture-flow / process-main-path) are not in LAYOUT_PROFILES, so the layout
    // endpoint used to reject them as a disabled engine and the sample never got any geometry.
    const available = LAYOUT_PROFILES.map((profile) => profile.value);
    for (const factory of [createC4Fixture, createFlowFixture]) {
      expect(available).toContain(factory().layout.profile);
    }
  });

  it("keeps stacked fixtures distinguishable after a manual move on an unlaid-out document", () => {
    const fixture = createC4Fixture();
    // A drag only moves one node: an unlaid-out document has to be laid out as a whole,
    // otherwise the remaining nodes stay stacked on the origin.
    const moved = moveNode(fixture, "snowflake", 640, 420);
    const placed = moved.nodes.filter((node) => node.x !== 0 || node.y !== 0);
    expect(placed).toHaveLength(1);
    expect(hasStackedGeometry(moved)).toBe(true);
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

  it("honors left and right semantic side constraints after the layered layout", async () => {
    const document = createC4Fixture();
    document.layout.externalSide = "LEFT";
    document.layout.storageSide = "RIGHT";
    const result = await layoutDiagram(document);
    const external = result.nodes.find((node) => node.role === "external" || node.role === "vendor");
    const storage = result.nodes.find((node) => node.role === "storage" || node.role === "data");
    const internal = result.nodes.filter((node) => !["external", "vendor", "storage", "data", "infra"].includes(node.role));
    if (external && internal.length) expect(external.x + external.width).toBeLessThanOrEqual(Math.min(...internal.map((node) => node.x)));
    if (storage && internal.length) expect(storage.x).toBeGreaterThan(Math.max(...internal.map((node) => node.x + node.width)) - 1);
  });

  it("lays out sequence participants and keeps the message timeline ordered", async () => {
    const result = await layoutDiagram(createSequenceFixture());
    await expectNoNodeOverlap(createSequenceFixture);
    const orders = result.relations.map((edge) => edge.sequenceOrder ?? -1);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(result.nodes.map((node) => node.x)).toEqual([...result.nodes].map((node) => node.x).sort((a, b) => a - b));
    expect(result.nodes.every((node) => node.y === 56)).toBe(true);
    const activations = deriveSequenceActivations(result);
    expect(activations).toHaveLength(4);
    expect(activations.map((activation) => activation.participantId)).toEqual(["web", "bff", "identity", "session"]);
    expect(toDrawioXml(result)).toContain("__sequenceActivation");
  });

  it("uses identical sequence geometry for Studio paths and Draw.io XML, including self-calls", () => {
    const document = createSequenceFixture();
    document.relations.push({
      id: "self-call", source: "web", target: "web", label: "Refresh local cache",
      kind: "call", sequenceOrder: document.relations.length
    });
    const selfCall = document.relations[document.relations.length - 1];
    const geometry = sequenceMessageGeometry(document, selfCall);
    expect(geometry).not.toBeNull();
    expect(geometry?.points).toHaveLength(2);
    expect(geometry?.points[0].x).toBeGreaterThan(geometry?.start.x ?? 0);
    expect(geometry?.start.y).toBeLessThan(geometry?.end.y ?? 0);

    const xml = toDrawioXml(document);
    const selfCallCell = xml.slice(xml.indexOf('<mxCell id="self-call"'), xml.indexOf("</mxCell>", xml.indexOf('<mxCell id="self-call"')) + 9);
    expect(selfCallCell).toContain('as="sourcePoint"');
    expect(selfCallCell).toContain('Array as="points"');
    expect(selfCallCell).toContain('as="targetPoint"');
    expect(selfCallCell).toContain('studioSource=web');
    expect(selfCallCell).toContain('studioTarget=web');
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
    expect(xml).toContain("fillColor=none;fillOpacity=0;strokeColor=#B8C4D4");
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

  it("exports explicit connector ports and native Draw.io port-anchor styles", async () => {
    const result = await layoutDiagram(createC4Fixture());
    expect(result.relations.every((relation) => relation.sourcePort && relation.targetPort)).toBe(true);
    const xml = toDrawioXml(result);
    expect(xml).toContain("exitX=");
    expect(xml).toContain("entryX=");
    expect(xml).toContain("exitPerimeter=0");
    expect(xml).toContain("entryPerimeter=0");
  });

  it("limits a combined fragment to the declared participant subset", async () => {
    const document = await layoutDiagram(createSequenceFixture());
    document.sequence = {
      ...(document.sequence || { participants: [] }),
      fragments: [{ id: "subset-fragment", kind: "opt", label: "Cache hit", startOrder: 1, endOrder: 3, participants: ["web", "identity"] }]
    };
    const xml = toDrawioXml(document);
    expect(xml).toContain("studioFragmentParticipants=web,identity");
    const cellStart = xml.indexOf('<mxCell id="subset-fragment__sequenceFragment"');
    const cellEnd = xml.indexOf("</mxCell>", cellStart);
    const cell = xml.slice(cellStart, cellEnd);
    const participants = document.nodes.filter((node) => ["web", "identity"].includes(node.id));
    const expectedWidth = Math.round(Math.max(...participants.map((node) => node.x + node.width)) + 12 -
      (Math.min(...participants.map((node) => node.x)) - 12));
    expect(cell).toContain('width="' + expectedWidth + '"');
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