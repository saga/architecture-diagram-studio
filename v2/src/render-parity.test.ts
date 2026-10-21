import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DiagramCanvas from "./components/DiagramCanvas";
import { nodePaint, relationPaint, mxNodeStyle, mxEdgeStyle } from "./design/styles";
import { diagramPalette, RENDER_METRICS, sequenceActivationGeometry, sequenceLifelineBottom } from "./design/render-spec";
import { deriveSequenceActivations } from "./layout/sequence";
import { createSequenceFixture, createC4Fixture } from "./model/fixtures";
import { toDrawioXml } from "./export/drawio";

const noop = () => undefined;

function renderStudioSvg(document: ReturnType<typeof createSequenceFixture>): string {
  return renderToStaticMarkup(createElement(DiagramCanvas, {
    document, zoom: 1, viewResetToken: 0, selectedNodeId: null, selectedRelationId: null,
    onSelectNode: noop, onSelectRelation: noop, onMoveNode: noop, onCreateRelation: noop,
    onReconnectRelation: noop, onRenameNode: noop, onUpdateRelationLabel: noop,
    onUpdateSequenceFragment: noop, onUpdateBoundary: noop, connectionSourceId: null,
    onConnectionSourceChange: noop, onContextMenu: noop
  }));
}

describe("Studio SVG and Draw.io render parity", () => {
  it("uses the same activation geometry and fill in both renderers", () => {
    const document = createSequenceFixture();
    document.renderTheme = "warm";
    const activation = deriveSequenceActivations(document)[0];
    if (!activation) throw new Error("The sequence fixture must expose at least one activation bar.");
    const participant = document.nodes.find((node) => node.id === activation.participantId);
    if (!participant) throw new Error("The activation participant must exist in the sequence document.");
    const centerX = participant!.x + participant!.width / 2;
    const geometry = sequenceActivationGeometry(activation.startOrder, activation.endOrder, centerX);
    const palette = diagramPalette(document.renderTheme);
    const svg = renderStudioSvg(document);
    const xml = toDrawioXml(document);
    const geometryFragment = `x="${geometry.x}" y="${geometry.y}" width="${geometry.width}" height="${geometry.height}"`;
    const roundedXmlGeometry = `x="${Math.round(geometry.x)}" y="${Math.round(geometry.y)}" width="${geometry.width}" height="${Math.round(geometry.height)}"`;

    expect(svg).toContain(geometryFragment);
    expect(svg).toContain(`fill="${palette.activationFill}" stroke="${palette.activationStroke}" stroke-width="1"`);
    expect(xml).toContain(roundedXmlGeometry);
    expect(xml).toContain(`fillColor=${palette.activationFill};strokeColor=${palette.activationStroke};strokeWidth=1;`);
  });

  it("aligns lifeline position, dash pattern and stroke width", () => {
    const document = createSequenceFixture();
    document.renderTheme = "youth";
    const palette = diagramPalette(document.renderTheme);
    const svg = renderStudioSvg(document);
    const xml = toDrawioXml(document);
    const bottom = sequenceLifelineBottom(document.relations.length);

    expect(svg).toContain(`y2="${bottom}" stroke="${palette.lifelineStroke}" stroke-width="${RENDER_METRICS.relation.lifelineStrokeWidth}" stroke-dasharray="${RENDER_METRICS.relation.lifelineDashPattern}"`);
    expect(xml).toContain(`dashPattern=${RENDER_METRICS.relation.lifelineDashPattern};strokeColor=${palette.lifelineStroke};strokeWidth=${RENDER_METRICS.relation.lifelineStrokeWidth};`);
  });

  it("uses one font hierarchy, theme palette and relation-label placement contract", () => {
    const document = createSequenceFixture();
    document.renderTheme = "midnight";
    const palette = diagramPalette(document.renderTheme);
    const relation = document.relations[0];
    const edgeStyle = mxEdgeStyle(relation, document.layout.routing, document.renderTheme);
    const xml = toDrawioXml(document);
    const svg = renderStudioSvg(document);

    expect(svg).toContain(`font-family="Arial, Helvetica, sans-serif" font-size="${RENDER_METRICS.title.size}" font-weight="${RENDER_METRICS.title.weight}"`);
    expect(xml).toContain(`fontFamily=Arial;fontStyle=1;align=left`);
    expect(xml).toContain(`font-size:${RENDER_METRICS.title.size}px;font-weight:${RENDER_METRICS.title.weight};`);
    expect(svg).toContain(`fill="${palette.relationLabelBackground}"`);
    expect(edgeStyle).toContain(`labelBackgroundColor=${palette.relationLabelBackground}`);
    expect(edgeStyle).toContain("verticalLabelPosition=top;align=center;verticalAlign=bottom;spacing=8;");
  });

  it("keeps sequence fragments transparent and aligned across both renderers", () => {
    const document = createSequenceFixture();
    document.renderTheme = "warm";
    document.sequence = {
      ...document.sequence!,
      fragments: [{ id: "alt-auth", kind: "alt", label: "Authentication branch", startOrder: 1, endOrder: 4, participants: ["web", "identity"] }]
    };
    const palette = diagramPalette(document.renderTheme);
    const svg = renderStudioSvg(document);
    const xml = toDrawioXml(document);

    expect(svg).toContain(`fill="${palette.fragmentFill}" fill-opacity="0"`);
    expect(svg).toContain(`stroke="${palette.fragmentStroke}" stroke-width="1" stroke-dasharray="5 4"`);
    expect(xml).toContain(`fillColor=${palette.fragmentFill};fillOpacity=0;strokeColor=${palette.fragmentStroke};`);
    expect(xml).toContain("dashPattern=5 4");
  });

  it("exports non-sequence edges using the active document palette", () => {
    const document = createC4Fixture();
    document.renderTheme = "warm";
    const relation = document.relations[0];
    const paint = relationPaint(relation, document.renderTheme);
    const xml = toDrawioXml(document);
    expect(xml).toContain(`strokeColor=${paint.stroke};strokeWidth=${paint.width};`);
    expect(xml).toContain(`labelBackgroundColor=${paint.labelBackground}`);
    expect(xml).toContain("verticalLabelPosition=top;align=center;verticalAlign=bottom;spacing=8;");
  });

  it("uses the same capsule shape, accent color and native style overrides", () => {
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
});
