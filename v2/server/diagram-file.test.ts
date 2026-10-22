import { describe, expect, it } from "vitest";
import { createEmptyDrawioXml, normalizeNewDrawioFileName } from "./diagram-file";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";

describe("new Draw.io file setup", () => {
  it("normalizes simple names to the native Draw.io extension", () => {
    expect(normalizeNewDrawioFileName("  architecture  ")).toBe("architecture.drawio");
    expect(normalizeNewDrawioFileName("architecture.drawio")).toBe("architecture.drawio");
  });

  it("rejects paths, empty names and non-Draw.io extensions", () => {
    expect(() => normalizeNewDrawioFileName("")).toThrow(/file name/i);
    expect(() => normalizeNewDrawioFileName("../architecture.drawio")).toThrow(/file name/i);
    expect(() => normalizeNewDrawioFileName("subfolder\\architecture.drawio")).toThrow(/file name/i);
    expect(() => normalizeNewDrawioFileName(".drawio")).toThrow(/name before/i);
    expect(() => normalizeNewDrawioFileName("architecture.xml")).toThrow(/\.drawio/i);
  });

  it("creates a valid empty native Draw.io XML document without a semantic model", () => {
    const first = createEmptyDrawioXml("payments-platform.drawio");
    const second = createEmptyDrawioXml("payments-platform.drawio");
    expect(validateDrawioXmlDocument(first).success).toBe(true);
    expect(first).toContain('name="payments platform"');
    expect(first).toContain('<mxCell id="0"/>');
    expect(first).toContain('<mxCell id="1" parent="0"/>');
    expect(first).toBe(second);
  });

  it("escapes XML attributes in the created page title", () => {
    const xml = createEmptyDrawioXml('orders"&amp;.drawio');
    expect(xml).toContain('name="orders&quot;&amp;amp;"');
    expect(validateDrawioXmlDocument(xml).success).toBe(true);
  });
});
