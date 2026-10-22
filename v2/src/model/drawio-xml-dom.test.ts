import { describe, expect, it } from "vitest";
import { encodeDrawioXmlAttribute, parseDrawioXml, serializeDrawioXml } from "./drawio-xml-dom";

describe("shared Draw.io XML adapter", () => {
  it("parses and serializes XML through the common DOM boundary", () => {
    const document = parseDrawioXml('<mxfile><diagram id="p"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>');
    expect(document.documentElement.nodeName).toBe("mxfile");
    expect(serializeDrawioXml(document)).toContain('<mxCell id="0"/>');
  });

  it("rejects DTD and custom entity declarations", () => {
    expect(() => parseDrawioXml('<!DOCTYPE mxfile [<!ENTITY x "unsafe">]><mxfile/>')).toThrow(/DTD and custom entity/);
  });

  it("does not mistake declaration-like text inside comments or CDATA for a DTD", () => {
    expect(() => parseDrawioXml('<mxfile><!-- <!DOCTYPE x> --><diagram><![CDATA[<!ENTITY x>]]></diagram></mxfile>')).not.toThrow();
  });

  it("uses one XML attribute escaping implementation", () => {
    expect(encodeDrawioXmlAttribute('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });
});
