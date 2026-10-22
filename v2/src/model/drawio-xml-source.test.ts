import { describe, expect, it } from "vitest";
import { FIXTURES } from "./fixtures";
import { toDrawioXml } from "../export/drawio";
import { canEditInStudio, patchDrawioXml } from "./drawio-xml-source";

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
    expect(canEditInStudio(source, toDrawioXml(document), document)).toBe(true);

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
    expect(canEditInStudio(legacyXml, projection, document)).toBe(true);
    expect(patchDrawioXml(legacyXml, projection, document)).toContain("studioLayoutProfile=");
  });

  it("allows editing the minimum XML document with two self-closing root cells", () => {
    const document = {
      ...FIXTURES.c4(), nodes: [], relations: [], boundaries: [], sequence: undefined
    };
    const xml = '<mxfile><diagram id="page-1" name="Minimal"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

    expect(canEditInStudio(xml, xml, document)).toBe(true);
    expect(patchDrawioXml(xml, xml, document)).not.toBeNull();
  });

  it("refuses Studio edits when the source contains an opaque cell", () => {
    const document = FIXTURES.c4();
    const source = addOpaqueCell(toDrawioXml(document));
    expect(canEditInStudio(source, toDrawioXml(document), document)).toBe(false);
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

    expect(canEditInStudio(multiPage, singlePage, document)).toBe(false);
    expect(patchDrawioXml(multiPage, singlePage, document)).toBeNull();
  });
});
