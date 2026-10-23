import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { nativeEditIsReflectedInXml } from "./native-edit-confirmation";

const before = '<mxfile><diagram id="p1" name="Overview"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="api" value="Old API" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="200" y="20" width="100" height="40" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

const labelEdited = before.replace('value="Old API"', 'value="New API"');
const unrelatedEdited = before.replace('value="Database"', 'value="Warehouse"');
const styleAndGeometryEdited = before
  .replace('style="rounded=0;"', 'style="rounded=0;fillColor=#ffffff;"')
  .replace('x="10" y="20" width="100" height="40"', 'x="40" y="20" width="140" height="50"');

describe("native edit XML confirmation", () => {
  it("confirms the requested label value in the targeted cell", () => {
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: labelEdited, cellId: "api", pageId: "p1", path: "label", value: "New API"
    })).toBe(true);
  });

  it("does not confirm a changed XML snapshot when only an unrelated cell changed", () => {
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: unrelatedEdited, cellId: "api", pageId: "p1", path: "label", value: "New API"
    })).toBe(false);
  });

  it("confirms every operation in a Copilot batch rather than just any document change", () => {
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: styleAndGeometryEdited, cellId: "__batch__", pageId: "p1", path: "cell:batch",
      value: JSON.stringify([
        { cellId: "api", path: "style:fillColor", value: "#ffffff" },
        { cellId: "api", path: "geometry:x", value: "40" },
        { cellId: "api", path: "geometry:size", value: "140,50" }
      ])
    })).toBe(true);

    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: styleAndGeometryEdited, cellId: "__batch__", pageId: "p1", path: "cell:batch",
      value: JSON.stringify([
        { cellId: "api", path: "style:fillColor", value: "#ffffff" },
        { cellId: "db", path: "label", value: "Missing change" }
      ])
    })).toBe(false);
  });

  it("validates the intended edit inside a compressed native Draw.io page", () => {
    const model = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="api" value="After" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>' +
      '</root></mxGraphModel>';
    const compressed = Buffer.from(deflateSync(new TextEncoder().encode(model))).toString("base64");
    const xml = '<mxfile compressed="true"><diagram id="compressed-page" name="Overview">' + compressed + '</diagram></mxfile>';
    const oldModel = model.replace('value="After"', 'value="Before"');
    const oldCompressed = Buffer.from(deflateSync(new TextEncoder().encode(oldModel))).toString("base64");
    const oldXml = '<mxfile compressed="true"><diagram id="compressed-page" name="Overview">' + oldCompressed + '</diagram></mxfile>';
    expect(nativeEditIsReflectedInXml({
      beforeXml: oldXml, xml, cellId: "api", pageId: "compressed-page", path: "label", value: "After"
    })).toBe(true);
  });
});
