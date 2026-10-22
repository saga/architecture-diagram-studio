import { describe, expect, it } from "vitest";
import {
  applyDrawioCellThemeReversible,
  applyDrawioThemeBackground,
  applyDrawioThemeBackgroundReversible,
  drawioFrameThemeCss,
  readDrawioModelBackground
} from "./drawio-theme";

describe("native Draw.io theme adapter", () => {
  it("supports explicit background edits through an XML DOM", () => {
    const source = '<mxfile host="app.diagrams.net"><diagram id="p1"><mxGraphModel dx="1200" background="#ffffff"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="service" value="API" style="fillColor=#ff0000;strokeColor=#990000;" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>';
    const result = applyDrawioThemeBackground(source, "#101a2b");
    expect(readDrawioModelBackground(result)).toBe("#101a2b");
    expect(result).toContain('host="app.diagrams.net"');
    expect(result).toContain('value="API"');
    expect(result).toContain('id="service"');
  });

  it("does not serialize or mutate XML when the background is unchanged", () => {
    const source = '<mxfile><diagram><mxGraphModel background="#fff"><root/></mxGraphModel></diagram></mxfile>';
    expect(applyDrawioThemeBackground(source, "#fff")).toBe(source);
  });

  it("leaves malformed XML and invalid colors untouched", () => {
    const malformed = '<mxfile><diagram><mxGraphModel><root></mxfile>';
    expect(applyDrawioThemeBackground(malformed, "#101a2b")).toBe(malformed);
    const valid = '<mxfile><diagram><mxGraphModel><root/></mxGraphModel></diagram></mxfile>';
    expect(applyDrawioThemeBackground(valid, "var(--theme-canvas)")).toBe(valid);
    expect(readDrawioModelBackground(malformed)).toBeNull();
  });

  it("makes UI theme adapters no-ops for authoritative diagram XML", () => {
    const source = '<mxfile><diagram><mxGraphModel background="#fefefe"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n1" value="API" style="fillColor=#ff0000;strokeColor=#990000;fontColor=#111111;" vertex="1" parent="1"/></root></mxGraphModel></diagram></mxfile>';
    expect(applyDrawioThemeBackgroundReversible(source, "#101a2b", "youth")).toBe(source);
    expect(applyDrawioCellThemeReversible(source, "youth")).toBe(source);
  });

  it("reads only the graph model's actual background attribute", () => {
    const source = '<mxfile><diagram><mxGraphModel background="#123456"><root><mxCell id="x" value="background=&quot;#abcdef&quot;"/></root></mxGraphModel></diagram></mxfile>';
    expect(readDrawioModelBackground(source)).toBe("#123456");
    expect(readDrawioModelBackground('<mxfile><diagram>compressed</diagram></mxfile>')).toBeNull();
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
