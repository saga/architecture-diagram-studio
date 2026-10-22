import { describe, expect, it } from "vitest";
import { nodeVisualStyleFromDrawio, relationVisualStyleFromDrawio } from "./drawio";
import { diagramPalette } from "../design/render-spec";
import { fromDrawioXml, roleFromStyle } from "./drawio";
import { toDrawioXml } from "../export/drawio";
import { getDrawioXmlDiagnostics } from "../model/drawio-xml-source";
import { FIXTURES } from "../model/fixtures";
import type { DiagramDocument } from "../model/types";

describe("Draw.io style import parity", () => {
  it("captures explicit native node fills, strokes, fonts and corner radius", () => {
    const imported = nodeVisualStyleFromDrawio(
      "rounded=1;arcSize=18;fillColor=#123456;strokeColor=#654321;strokeWidth=2;fontColor=#112233;fontFamily=Verdana;fontSize=16;fontStyle=0;studioRole=service;studioVisualRole=secondary;",
      "service",
      "secondary",
      "editorial"
    );
    expect(imported).toMatchObject({
      fillColor: "#123456",
      strokeColor: "#654321",
      strokeWidth: 2,
      fontColor: "#112233",
      fontFamily: "Verdana",
      fontSize: 16,
      fontStyle: 0,
      arcSize: 18
    });
  });

  it("captures explicit edge stroke, dash, arrow and label styles", () => {
    const imported = relationVisualStyleFromDrawio(
      "strokeColor=#123456;strokeWidth=2;dashed=1;dashPattern=3 2;fontColor=#112233;fontFamily=Verdana;fontSize=15;labelBackgroundColor=#fefefe;startArrow=none;endArrow=diamond;endFill=0;",
      "flow",
      "editorial"
    );
    expect(imported).toMatchObject({
      strokeColor: "#123456",
      strokeWidth: 2,
      dashPattern: "3 2",
      fontColor: "#112233",
      fontFamily: "Verdana",
      fontSize: 15,
      labelBackgroundColor: "#fefefe",
      endArrow: "diamond",
      endFill: false
    });
  });

  it("projects a Draw.io UserObject wrapper using the wrapper ID and label", () => {
    const base: DiagramDocument = {
      ...FIXTURES.c4(), id: "projection-test", title: "Wrapper test",
      nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined
    };
    const xml = '<mxfile><diagram id="page-1" name="Wrapper test"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<UserObject id="user-object-7" label="Wrapped service" owner="ops" customKey="retain">' +
      '<mxCell style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">' +
      '<mxGeometry x="45" y="70" width="180" height="80" as="geometry"/>' +
      '</mxCell></UserObject></root></mxGraphModel></diagram></mxfile>';
    const imported = fromDrawioXml(xml, base);
    expect(imported.nodes).toHaveLength(1);
    expect(imported.nodes[0]).toMatchObject({ id: "user-object-7", name: "Wrapped service", x: 45, y: 70, width: 180, height: 80 });
  });

  it("imports edges before endpoints, resolves nested absolute coordinates, and omits blank structural cells", () => {
    const base: DiagramDocument = {
      ...FIXTURES.c4(), id: "native-structure", title: "Native structure",
      nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined
    };
    const xml = '<mxfile><diagram id="page-1" name="Native structure"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="edge-1" value="contains" edge="1" parent="1" source="child" target="peer"><mxGeometry relative="1" as="geometry"/></mxCell>' +
      '<mxCell id="container" value="Container" vertex="1" parent="1"><mxGeometry x="400" y="300" width="200" height="100" as="geometry"/></mxCell>' +
      '<mxCell id="child" value="Child" vertex="1" parent="container"><mxGeometry x="10" y="20" width="80" height="40" as="geometry"/></mxCell>' +
      '<mxCell id="peer" value="Peer" vertex="1" parent="1"><mxGeometry x="700" y="300" width="80" height="40" as="geometry"/></mxCell>' +
      '<mxCell id="blank-separator" value="" style="text;strokeColor=none;" vertex="1" parent="container"><mxGeometry x="0" y="45" width="150" height="1" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';

    const imported = fromDrawioXml(xml, base);
    expect(imported.relations).toHaveLength(1);
    expect(imported.relations[0]).toMatchObject({ id: "edge-1", source: "child", target: "peer" });
    expect(imported.nodes.find((node) => node.id === "child")).toMatchObject({
      x: 410, y: 320, parentId: "container"
    });
    expect(imported.nodes.some((node) => node.id === "blank-separator")).toBe(false);
    expect(imported.nodes.some((node) => node.name === "New node")).toBe(false);
    const exported = toDrawioXml(imported);
    expect(exported).toContain('parent="container"><mxGeometry x="10" y="20"');
  });

  it("drops edges whose endpoints exist only in the previous document", () => {
    const previous = FIXTURES.c4();
    const staleSource = previous.nodes[0].id;
    const xml = '<mxfile><diagram id="new-page" name="New page"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="peer" value="Peer" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="300" y="80" width="100" height="50" as="geometry"/></mxCell>' +
      '<mxCell id="edge-from-stale-node" value="stale" edge="1" parent="1" source="' + staleSource + '" target="peer"><mxGeometry relative="1" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const imported = fromDrawioXml(xml, previous);
    expect(imported.nodes.map((node) => node.id)).toEqual(["peer"]);
    expect(imported.relations).toEqual([]);
  });

  it("does not carry sequence classification into a newly imported non-sequence page", () => {
    const previous = FIXTURES.sequence();
    const xml = '<mxfile><diagram id="new-page" name="C4"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="service" value="Service" style="rounded=1;studioRole=service;" vertex="1" parent="1"><mxGeometry x="100" y="100" width="120" height="60" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const imported = fromDrawioXml(xml, previous);
    expect(imported.kind).toBe("c4");
    expect(imported.sequence).toBeUndefined();
    expect(imported.relations).toEqual([]);
  });

  it("imports a valid empty page without retaining the previous document", () => {
    const previous = FIXTURES.c4();
    const xml = '<mxfile><diagram id="empty" name="Empty"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const imported = fromDrawioXml(xml, previous);
    expect(imported.nodes).toEqual([]);
    expect(imported.relations).toEqual([]);
  });

  it("prefers explicit semantic metadata in the current XML over stale projection state", () => {
    const previous = FIXTURES.c4();
    const existing = previous.nodes[0];
    const xml = '<mxfile><diagram id="page-1" name="Updated"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="' + existing.id + '" value="Updated node" style="shape=cylinder;studioRole=storage;studioVisualRole=highlight;" vertex="1" parent="1"><mxGeometry x="240" y="120" width="100" height="60" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const imported = fromDrawioXml(xml, previous);
    expect(imported.nodes).toHaveLength(1);
    expect(imported.nodes[0]).toMatchObject({ id: existing.id, role: "storage", visualRole: "highlight", name: "Updated node" });
  });

  it("maps common Draw.io shapes to coarse semantic roles", () => {
    expect(roleFromStyle("shape=umlActor;")).toBe("actor");
    expect(roleFromStyle("shape=cloud;")).toBe("external");
    expect(roleFromStyle("shape=table;")).toBe("data");
    expect(roleFromStyle("shape=mxgraph.flowchart.decision;")).toBe("decision");
  });

  it("recognizes native UML lifelines as a sequence diagram", () => {
    const base: DiagramDocument = {
      ...FIXTURES.c4(), id: "native-sequence", title: "Native sequence",
      nodes: [], relations: [], boundaries: [], flow: undefined, sequence: undefined
    };
    const xml = '<mxfile><diagram id="seq" name="Sequence"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="participant-a" value="Client" style="shape=umlLifeline;" vertex="1" parent="1"><mxGeometry x="100" y="30" width="90" height="300" as="geometry"/></mxCell>' +
      '<mxCell id="participant-b" value="API" style="shape=umlLifeline;" vertex="1" parent="1"><mxGeometry x="300" y="30" width="90" height="300" as="geometry"/></mxCell>' +
      '<mxCell id="message-1" value="request" edge="1" parent="1" source="participant-a" target="participant-b"><mxGeometry relative="1" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const imported = fromDrawioXml(xml, base);
    expect(imported.kind).toBe("sequence");
    expect(imported.sequence?.participants).toEqual(["participant-a", "participant-b"]);
    expect(imported.nodes.every((node) => node.role === "actor")).toBe(true);
  });

  it("persists Studio layout configuration in the authoritative Draw.io XML", () => {
    const document = FIXTURES.c4();
    document.layout = {
      ...document.layout, profile: "dagre-layered", direction: "DOWN", routing: "curved",
      nodeSpacing: 76, layerSpacing: 132, boundaryPadding: 44, externalSide: "LEFT", storageSide: "RIGHT"
    };
    const xml = toDrawioXml(document);
    const restored = fromDrawioXml(xml, { ...FIXTURES.c4(), layout: { ...FIXTURES.c4().layout } });
    expect(restored.layout).toEqual(document.layout);
  });

  it("treats first-page-only projection as an intentional scope, not a compatibility warning", () => {
    const singlePage = toDrawioXml(FIXTURES.c4());
    const secondPage = '<diagram id="second-page" name="Second page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>';
    const diagnostics = getDrawioXmlDiagnostics(singlePage.replace("</mxfile>", secondPage + "</mxfile>"));
    expect(diagnostics.pageCount).toBe(2);
    expect(diagnostics.warnings.some((warning) => warning.includes("only the first page"))).toBe(false);
    expect(getDrawioXmlDiagnostics("<mxlibrary>[]</mxlibrary>").issues[0]).toContain("custom shape library");
    expect(getDrawioXmlDiagnostics("<templates/>").issues[0]).toContain("template index");
  });

  it("doesn't freeze the generated theme defaults as custom overrides", () => {
    const palette = diagramPalette("warm");
    const node = nodeVisualStyleFromDrawio(
      "rounded=1;arcSize=8;fillColor=" + palette.applicationFill +
      ";strokeColor=" + palette.applicationStroke + ";fontColor=" + palette.ink +
      ";fontFamily=Arial;fontSize=13;fontStyle=1;strokeWidth=1.4;studioAccentColor=" +
      palette.applicationAccent + ";studioRole=service;studioVisualRole=secondary;studioTheme=warm;",
      "service",
      "secondary",
      "editorial"
    );
    const relation = relationVisualStyleFromDrawio(
      "rounded=0;dashed=0;startArrow=none;endArrow=block;endFill=1;strokeColor=" +
      palette.relationStroke + ";strokeWidth=1.5;fontColor=" + palette.inkSecondary +
      ";fontSize=13;fontFamily=Arial;labelBackgroundColor=" + palette.relationLabelBackground +
      ";studioTheme=warm;",
      "flow",
      "editorial"
    );
    expect(node).toBeUndefined();
    expect(relation).toBeUndefined();
  });
});
