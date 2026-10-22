import { describe, expect, it } from "vitest";
import { nodePaint, relationPaint, mxNodeStyle, mxEdgeStyle } from "./design/styles";
import { diagramPalette, RENDER_METRICS, sequenceActivationGeometry, sequenceLifelineBottom } from "./design/render-spec";
import { deriveSequenceActivations } from "./layout/sequence";
import { createSequenceFixture, createC4Fixture } from "./model/fixtures";
import { toDrawioXml } from "./export/drawio";

describe("native Draw.io style and geometry contract", () => {
  it("serializes sequence activation geometry and theme fill into native XML", () => {
    const document = createSequenceFixture();
    document.renderTheme = "warm";
    const activation = deriveSequenceActivations(document)[0];
    if (!activation) throw new Error("The sequence fixture must expose at least one activation bar.");
    const participant = document.nodes.find((node) => node.id === activation.participantId);
    if (!participant) throw new Error("The activation participant must exist in the sequence document.");
    const centerX = participant.x + participant.width / 2;
    const geometry = sequenceActivationGeometry(activation.startOrder, activation.endOrder, centerX);
    const palette = diagramPalette(document.renderTheme);
    const xml = toDrawioXml(document);
    const roundedXmlGeometry = `x="${Math.round(geometry.x)}" y="${Math.round(geometry.y)}" width="${geometry.width}" height="${Math.round(geometry.height)}"`;

    expect(xml).toContain(roundedXmlGeometry);
    expect(xml).toContain(`fillColor=${palette.activationFill};strokeColor=${palette.activationStroke};strokeWidth=1;`);
  });

  it("serializes lifeline position, dash pattern and stroke width", () => {
    const document = createSequenceFixture();
    document.renderTheme = "youth";
    const palette = diagramPalette(document.renderTheme);
    const xml = toDrawioXml(document);
    const bottom = sequenceLifelineBottom(document.relations.length);

    expect(xml).toContain(`y2=${bottom}`);
    expect(xml).toContain(`dashPattern=${RENDER_METRICS.relation.lifelineDashPattern};strokeColor=${palette.lifelineStroke};strokeWidth=${RENDER_METRICS.relation.lifelineStrokeWidth};`);
  });

  it("uses the active theme palette and label-placement contract for relations", () => {
    const document = createSequenceFixture();
    document.renderTheme = "midnight";
    const palette = diagramPalette(document.renderTheme);
    const relation = document.relations[0];
    const edgeStyle = mxEdgeStyle(relation, document.layout.routing, document.renderTheme);
    const xml = toDrawioXml(document);

    expect(xml).toContain(`labelBackgroundColor=${palette.relationLabelBackground}`);
    expect(edgeStyle).toContain(`labelBackgroundColor=${palette.relationLabelBackground}`);
    expect(edgeStyle).toContain("verticalLabelPosition=top;align=center;verticalAlign=bottom;spacing=8;");
  });

  it("serializes transparent sequence fragments with their native dash style", () => {
    const document = createSequenceFixture();
    document.renderTheme = "warm";
    document.sequence = {
      ...document.sequence!,
      fragments: [{ id: "alt-auth", kind: "alt", label: "Authentication branch", startOrder: 1, endOrder: 4, participants: ["web", "identity"] }]
    };
    const palette = diagramPalette(document.renderTheme);
    const xml = toDrawioXml(document);

    expect(xml).toContain(`fillColor=${palette.fragmentFill};fillOpacity=0;strokeColor=${palette.fragmentStroke};`);
    expect(xml).toContain("dashPattern=5 4");
  });

  it("preserves theme-aware native node and edge styles for C4 diagrams", () => {
    const document = createC4Fixture();
    document.renderTheme = "warm";
    const relation = document.relations[0];
    const paint = relationPaint(relation, document.renderTheme);
    const xml = toDrawioXml(document);

    expect(xml).toContain(`strokeColor=${paint.stroke};strokeWidth=${paint.width};`);
    expect(xml).toContain(`labelBackgroundColor=${paint.labelBackground}`);
    expect(xml).toContain("verticalLabelPosition=top;align=center;verticalAlign=bottom;spacing=8;");
  });

  it("retains capsule geometry and accent styling in native XML", () => {
    const document = createC4Fixture();
    document.renderTheme = "editorial";
    const actor = document.nodes.find((node) => node.role === "actor")!;
    const paint = nodePaint(actor, document.renderTheme);
    const style = mxNodeStyle(actor, document.renderTheme);
    const xml = toDrawioXml(document);

    expect(style).toContain(`arcSize=${RENDER_METRICS.node.pillArcSize};`);
    expect(style).toContain(`studioAccentColor=${paint.accent};`);
    expect(xml).toContain(`id="${actor.id}__studioAccent"`);
    expect(xml).toContain(`rounded=1;arcSize=${RENDER_METRICS.node.pillArcSize};whiteSpace=wrap;html=1;fillColor=${paint.accent}`);
  });
}
