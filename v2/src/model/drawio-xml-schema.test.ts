import { describe, expect, it } from "vitest";
import { deflateSync } from "fflate";
import { FIXTURES } from "./fixtures";
import { toDrawioXml } from "../export/drawio";
import {
  validateDrawioXmlDocument,
  validateDrawioXmlFile
} from "./drawio-xml-schema";

function encodeRawDeflatePayload(xml: string): string {
  const encoded = encodeURIComponent(xml);
  const compressed = deflateSync(new TextEncoder().encode(encoded));
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function extractModel(xml: string): string {
  const match = xml.match(/<mxGraphModel\b[\s\S]*?<\/mxGraphModel>/);
  if (!match) throw new Error("The fixture does not contain an mxGraphModel");
  return match[0];
}

describe("Zod Draw.io XML schema", () => {
  it("accepts mxfile and the legacy bare mxGraphModel root", () => {
    const xml = toDrawioXml(FIXTURES.c4());
    const model = extractModel(xml);
    expect(validateDrawioXmlDocument(xml).success).toBe(true);
    expect(validateDrawioXmlDocument(model).success).toBe(true);
  });

  it("accepts mixed compressed and plain pages in the same mxfile", () => {
    const model = extractModel(toDrawioXml(FIXTURES.c4()));
    const payload = encodeRawDeflatePayload(model);
    const xml = '<mxfile compressed="true" pages="2">' +
      '<diagram id="overview" name="Overview">' + payload + '</diagram>' +
      '<diagram id="details" name="Details">' + model + '</diagram>' +
      '</mxfile>';
    const result = validateDrawioXmlDocument(xml);
    expect(result.success).toBe(true);
  });

  it("accepts plaintext XML nested as a page payload as well as inline mxGraphModel children", () => {
    const model = extractModel(toDrawioXml(FIXTURES.c4()));
    const xml = '<mxfile><diagram id="plain" name="Plain page"><![CDATA[' + model + ']]></diagram></mxfile>';
    expect(validateDrawioXmlDocument(xml)).toMatchObject({ success: true, format: "mxfile" });
  });

  it("accepts defs/style compression, custom attributes and unknown cell extensions", () => {
    const xml = '<mxfile host="app.diagrams.net" customFileFlag="keep">' +
      '<diagram id="main" name="Main">' +
      '<mxGraphModel customModelFlag="keep">' +
      '<defs><def data="data:image/png;base64,AA=="/></defs>' +
      '<root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0" visible="0"/>' +
      '<UserObject id="custom-user-object" label="Web %project%" owner="ops" placeholders="1">' +
      '<mxCell style="shape=custom.enterpriseStencil;customStyleKey=keep;" vertex="1" parent="1" collapsed="1">' +
      '<mxGeometry x="30" y="40" width="200" height="100" as="geometry">' +
      '<mxRectangle x="10" y="20" width="240" height="160" as="alternateBounds"/>' +
      '</mxGeometry></mxCell><CustomData source="external" revision="3"/>' +
      '</UserObject>' +
      '<mxCell id="edge" edge="1" parent="1" source="custom-user-object">' +
      '<mxGeometry relative="1" as="geometry"><mxPoint x="240" y="200" as="targetPoint"/>' +
      '<Array as="points"><mxPoint x="180" y="150"/></Array></mxGeometry></mxCell>' +
      '<mxCell id="edge-label" value="request" vertex="1" connectable="0" parent="edge">' +
      '<mxGeometry x="0.4" relative="1" as="geometry"><mxPoint x="-10" y="6" as="offset"/></mxGeometry></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    expect(validateDrawioXmlDocument(xml)).toMatchObject({ success: true, format: "mxfile" });
  });

  it("rejects duplicate page IDs and duplicate effective cell IDs", () => {
    const base = toDrawioXml(FIXTURES.c4());
    const firstPage = base.match(/<diagram\b[^>]*>[\s\S]*?<\/diagram>/)?.[0];
    if (!firstPage) throw new Error("The fixture has no diagram page");
    const duplicatePageIds = base.replace("</mxfile>", firstPage + "</mxfile>");
    expect(validateDrawioXmlDocument(duplicatePageIds).success).toBe(false);

    const duplicateCellId = base.replace(
      "</root>",
      '<UserObject id="1" label="duplicate"><mxCell vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></UserObject></root>'
    );
    expect(validateDrawioXmlDocument(duplicateCellId).success).toBe(false);
  });

  it("rejects invalid compressed payloads and malformed XML", () => {
    expect(validateDrawioXmlDocument('<mxfile><diagram id="p1">not-base64-@@@</diagram></mxfile>').success).toBe(false);
    expect(validateDrawioXmlDocument("<mxfile><diagram></mxfile>").success).toBe(false);
    expect(validateDrawioXmlDocument('<!DOCTYPE mxfile [<!ENTITY boom "x">]><mxfile><diagram id="p1"><mxGraphModel><root/></mxGraphModel></diagram></mxfile>').success).toBe(false);
  });

  it("distinguishes editable diagram XML from the custom shape-library XML format", () => {
    const library = '<mxlibrary title="Samples" tags="box example">[{"xml":"&lt;mxGraphModel/&gt;","w":120,"h":60,"title":"Box"},{"data":"data:image/png;base64,AA==","w":48,"h":48}]</mxlibrary>';
    expect(validateDrawioXmlFile(library)).toMatchObject({ success: true, format: "mxlibrary" });
    expect(validateDrawioXmlDocument(library).success).toBe(false);
  });
});
