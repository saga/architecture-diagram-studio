import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures";
import { toDrawioXml } from "../export/drawio";
import { canApplySemanticEdits, patchDrawioXml } from "./drawio-xml-source";

function addOpaqueCell(xml: string): string {
  const opaque = '<mxCell id="native-custom-blob" value="custom metadata" style="shape=custom.foo;customKey=keep-me;" vertex="1" parent="1"><mxGeometry x="900" y="700" width="80" height="50" as="geometry"/></mxCell>';
  return xml.replace("</root>", opaque + "</root>");
}

describe("Draw.io XML is the authoritative source", () => {
  it("allows cell-level semantic updates while preserving mxfile and model metadata", () => {
    const document = FIXTURES.c4();
    const source = toDrawioXml(document)
      .replace('host="app.diagrams.net"', 'host="app.diagrams.net" sourceCustomMetadata="preserve-me"')
      .replace('<mxGraphModel dx="1200"', '<mxGraphModel customModelFlag="preserve-model" dx="1200"');
    expect(canApplySemanticEdits(source, toDrawioXml(document), document)).toBe(true);

    const next = structuredClone(document);
    next.nodes[0].x += 40;
    const patched = patchDrawioXml(source, toDrawioXml(next), document);

    expect(patched).not.toBeNull();
    expect(patched).toContain('sourceCustomMetadata="preserve-me"');
    expect(patched).toContain('customModelFlag="preserve-model"');
    expect(patched).toContain('x="' + Math.round(next.nodes[0].x) + '"');
    expect(patched).not.toContain("native-custom-blob");
  });

  it("allows legacy Studio XML to adopt layout metadata on its default layer", () => {
    const document = {
      ...FIXTURES.c4(), nodes: [], relations: [], boundaries: [], sequence: undefined
    };
    const legacyXml = '<?xml version="1.0"?><mxfile host="app.diagrams.net"><diagram id="legacy" name="Legacy"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    const projection = toDrawioXml(document);
    expect(canApplySemanticEdits(legacyXml, projection, document)).toBe(true);
    expect(patchDrawioXml(legacyXml, projection, document)).toContain("studioLayoutProfile=");
  });

  it("allows editing the minimum XML document with two self-closing root cells", () => {
    const document = {
      ...FIXTURES.c4(), nodes: [], relations: [], boundaries: [], sequence: undefined
    };
    const xml = '<mxfile><diagram id="page-1" name="Minimal"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

    expect(canApplySemanticEdits(xml, xml, document)).toBe(true);
    expect(patchDrawioXml(xml, xml, document)).not.toBeNull();
  });

  it("refuses Studio edits when the source contains an opaque cell", () => {
    const document = FIXTURES.c4();
    const source = addOpaqueCell(toDrawioXml(document));
    expect(canApplySemanticEdits(source, toDrawioXml(document), document)).toBe(false);
  });

  it("preserves opaque cells if a caller patches an XML source conservatively", () => {
    const document = FIXTURES.c4();
    const source = addOpaqueCell(toDrawioXml(document));
    const next = structuredClone(document);
    next.nodes[0].name += " updated";
    const patched = patchDrawioXml(source, toDrawioXml(next), document);

    expect(patched).not.toBeNull();
    expect(patched).toContain('id="native-custom-blob"');
    expect(patched).toContain('shape=custom.foo;customKey=keep-me;');
    expect(patched).toContain('value="custom metadata"');
  });

  it("refuses semantic editing of multi-page files rather than merging page cell IDs", () => {
    const document = FIXTURES.c4();
    const singlePage = toDrawioXml(document);
    const secondPage = '<diagram id="second-page" name="Second page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>';
    const multiPage = singlePage.replace("</mxfile>", secondPage + "</mxfile>");

    expect(canApplySemanticEdits(multiPage, singlePage, document)).toBe(false);
    expect(patchDrawioXml(multiPage, singlePage, document)).toBeNull();
  });

  it("keeps HTML label styles intact when a semantic edit patches a cell", () => {
    const document = FIXTURES.c4();
    const source = toDrawioXml(document);
    expect(source).toContain("&lt;div style='font-family:Arial, Helvetica, sans-serif;");

    const next = structuredClone(document);
    next.nodes[0].technology = "Rust";
    const patched = patchDrawioXml(source, toDrawioXml(next), document);

    expect(patched).not.toBeNull();
    // The label CSS must survive as text. A `style=` search over the whole tag would
    // read this inline CSS as the cell style and reserialize it as key=1 pairs.
    expect(patched).toContain("&lt;div style='font-family:Arial, Helvetica, sans-serif;");
    expect(patched).not.toContain("&lt;div style=\"");
    expect(patched).not.toContain("sans-serif=1");
    expect(patched).not.toContain("font-size:13px=1");
    expect(patched).toContain("Rust");
  });
});
