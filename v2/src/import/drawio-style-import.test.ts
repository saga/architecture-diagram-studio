import { describe, expect, it } from "vitest";
import { nodeVisualStyleFromDrawio, relationVisualStyleFromDrawio } from "./drawio";
import { diagramPalette } from "../design/render-spec";
import { fromDrawioXml } from "./drawio";
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
