import { describe, expect, it } from "vitest";
import { applyDrawioThemeBackground, applyDrawioThemeStyles, drawioFrameThemeCss } from "./drawio-theme";

describe("native Draw.io theme adapter", () => {
  it("updates only the mxGraphModel background and preserves cell styles and XML metadata", () => {
    const source = '<mxfile host="app.diagrams.net"><diagram id="p1"><mxGraphModel dx="1200" background="#ffffff"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="service" value="API" style="fillColor=#ff0000;strokeColor=#990000;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
    const result = applyDrawioThemeBackground(source, "#101a2b");

    expect(result).toContain('background="#101a2b"');
    expect(result).toContain('host="app.diagrams.net"');
    expect(result).toContain('style="fillColor=#ff0000;strokeColor=#990000;"');
    expect(result).toContain('dx="1200"');
    expect(result).not.toContain('background="#ffffff"');
  });

  it("updates every uncompressed page without normalizing unrelated XML", () => {
    const source = '<mxfile><diagram id="one"><mxGraphModel background="#fff"><root/></mxGraphModel></diagram><diagram id="two"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
    const result = applyDrawioThemeBackground(source, "#fffaff");
    expect((result.match(/background="#fffaff"/g) || [])).toHaveLength(2);
    expect(result).toContain('id="one"');
    expect(result).toContain('id="two"');
  });

  it("preserves self-closing mxGraphModel elements", () => {
    const source = '<mxfile><diagram><mxGraphModel dx="10" /></diagram></mxfile>';
    expect(applyDrawioThemeBackground(source, "#101a2b")).toBe(
      '<mxfile><diagram><mxGraphModel dx="10" background="#101a2b"/></diagram></mxfile>'
    );
  });

  it("leaves invalid colors and compressed pages unchanged", () => {
    const compressed = '<mxfile><diagram id="page">YWJjZA==</diagram></mxfile>';
    expect(applyDrawioThemeBackground(compressed, "#101a2b")).toBe(compressed);
    const xml = '<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
    expect(applyDrawioThemeBackground(xml, "var(--theme-canvas)")).toBe(xml);
  });

  it("creates CSS scoped to the native editor iframe", () => {
    const css = drawioFrameThemeCss({
      canvas: "#101a2b", panel: "#172235", text: "#f0f4fc", secondary: "#d1dbeb",
      muted: "#a7b7ce", border: "#35435a", accent: "#91a5ff", soft: "#263555"
    });
    expect(css).toContain("background-color: #101a2b !important");
    expect(css).toContain("background-color: #172235 !important");
    expect(css).toContain("outline-color: #91a5ff !important");
  });
});
