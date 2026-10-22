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
