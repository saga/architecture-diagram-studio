import { describe, expect, it } from "vitest";
import { nodeVisualStyleFromDrawio, relationVisualStyleFromDrawio } from "./drawio";
import { diagramPalette } from "../design/render-spec";

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
