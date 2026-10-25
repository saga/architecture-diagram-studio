import { describe, expect, it } from "vitest";
import { drawioFrameThemeCss } from "./drawio-theme";

describe("Draw.io chrome theme adapter", () => {
  it("styles editor chrome without overriding the native document page, SVG or grid", () => {
    const css = drawioFrameThemeCss({
      canvas: "#101a2b", panel: "#172235", text: "#f0f4fc",
      muted: "#a7b7ce", border: "#35435a", accent: "#91a5ff", soft: "#263555"
    });

    expect(css).toContain("body { background-color: #101a2b !important; }");
    expect(css).toContain("background-color: #172235 !important");
    expect(css).toContain("outline-color: #91a5ff !important");
    expect(css).not.toContain(".geDiagramContainer svg");
    expect(css).not.toContain("#geDiagramContainer");
    expect(css).not.toContain("geBackgroundPage");
  });
});
