import { describe, expect, it } from "vitest";
import { getDrawioXmlDiagnostics, isDrawioXmlDocument } from "./drawio-xml-source";

const XML = '<mxfile host="app.diagrams.net"><diagram id="page-1" name="Overview"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="API" vertex="1" parent="1"><mxGeometry x="20" y="30" width="120" height="50" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';

describe("native Draw.io XML validation", () => {
  it("accepts native XML without projecting it into a semantic graph", () => {
    expect(isDrawioXmlDocument(XML)).toBe(true);
    expect(getDrawioXmlDiagnostics(XML)).toMatchObject({ pageCount: 1, warnings: [], issues: [] });
  });

  it("preserves and counts every page in a multi-page file", () => {
    const xml = XML.replace("</mxfile>", '<diagram id="page-2" name="Details"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>');
    expect(isDrawioXmlDocument(xml)).toBe(true);
    expect(getDrawioXmlDiagnostics(xml).pageCount).toBe(2);
  });

  it("distinguishes custom shape libraries from editable diagrams", () => {
    const diagnostics = getDrawioXmlDiagnostics('<mxlibrary>[{"title":"Shape","xml":"&lt;mxGraphModel/&gt;"}]</mxlibrary>');
    expect(diagnostics.pageCount).toBe(0);
    expect(diagnostics.issues[0]).toContain("shape library");
    expect(isDrawioXmlDocument('<mxlibrary/>')).toBe(false);
  });

  it("rejects malformed XML and DTD/entity declarations", () => {
    expect(isDrawioXmlDocument("<mxfile><diagram></mxfile>")).toBe(false);
    expect(getDrawioXmlDiagnostics('<!DOCTYPE mxfile [<!ENTITY x "bad">]><mxfile/>').issues.length).toBeGreaterThan(0);
  });
});
