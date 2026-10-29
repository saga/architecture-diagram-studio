import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { nativeEditIsReflectedInXml, summarizeNativeDiagramXmlDiff } from "./native-edit-confirmation";

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


  it("does not confirm an edit by reading cells from another page when the requested page ID is missing", () => {
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: labelEdited, cellId: "api", pageId: "missing-page", path: "label", value: "New API"
    })).toBe(false);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: labelEdited, cellId: "api", pageId: "", path: "label", value: "New API"
    })).toBe(false);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: labelEdited, cellId: "__active_page__", pageId: "", path: "cell:execute-script", value: "return true;"
    })).toBe(false);
  });

  it("confirms a mixed selection and document batch without expecting selection in XML", () => {
    const labelAndStyleEdited = before
      .replace('value="Old API"', 'value="Primary API"')
      .replace('style="rounded=0;"', 'style="rounded=0;fillColor=#ff0000;"');
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: labelAndStyleEdited, cellId: "__batch__", pageId: "p1", path: "cell:batch",
      value: JSON.stringify([
        { cellId: "api", path: "cell:select", value: "true" },
        { cellId: "api", path: "label", value: "Primary API" },
        { cellId: "api", path: "style:fillColor", value: "#ff0000" }
      ])
    })).toBe(true);
  });

  it("confirms a selection-only batch only when serialized document content is unchanged", () => {
    const selection = JSON.stringify([{ cellId: "api", path: "cell:select", value: "true" }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: before, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: selection
    })).toBe(true);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: unrelatedEdited, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: selection
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

  it("confirms a new node directly below its vertex only when connected in the requested direction", () => {
    const belowNode = '<mxCell id="ddd" value="ddd" vertex="1" parent="1"><mxGeometry x="190" y="124" width="120" height="60" as="geometry"/></mxCell>';
    const edge = '<mxCell id="db-ddd" edge="1" parent="1" source="db" target="ddd"><mxGeometry relative="1" as="geometry"/></mxCell>';
    const belowAndConnected = before.replace("</root>", belowNode + edge + "</root>");
    const request = { beforeXml: before, xml: belowAndConnected, cellId: "db", pageId: "p1", path: "cell:add-node-below", value: JSON.stringify({ label: "ddd" }) };
    expect(nativeEditIsReflectedInXml(request)).toBe(true);

    const placedBeside = nativeEditIsReflectedInXml({ ...request, xml: belowAndConnected.replace('x="190" y="124"', 'x="364" y="20"') });
    expect(placedBeside).toBe(false);
    const disconnected = nativeEditIsReflectedInXml({ ...request, xml: belowAndConnected.replace(edge, "") });
    expect(disconnected).toBe(false);
    const wrongDirection = nativeEditIsReflectedInXml({ ...request, xml: belowAndConnected.replace('source="db" target="ddd"', 'source="ddd" target="db"') });
    expect(wrongDirection).toBe(false);
  });

  it("ignores viewport-only dx/dy changes in compressed or expanded Draw.io models", () => {
    const beforeViewport = before.replace("<mxGraphModel>", '<mxGraphModel dx="1086" dy="613">');
    const afterViewport = beforeViewport
      .replace('dx="1086"', 'dx="2566"')
      .replace('dy="613"', 'dy="1314"');
    expect(summarizeNativeDiagramXmlDiff(beforeViewport, afterViewport)).toMatchObject({
      available: true,
      changed: false,
      pagesChanged: [],
      cellsAdded: [],
      cellsRemoved: [],
      cellsChanged: []
    });

    const bareBefore = '<mxGraphModel dx="800" dy="400"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="10" y="10" width="30" height="20" as="geometry"/></mxCell>' +
      '</root></mxGraphModel>';
    const bareAfter = bareBefore.replace('dx="800"', 'dx="1600"').replace('dy="400"', 'dy="900"');
    expect(summarizeNativeDiagramXmlDiff(bareBefore, bareAfter)).toMatchObject({
      available: true, changed: false, pagesChanged: [], cellsChanged: []
    });

    const noPageIdBefore = before.replace('<diagram id="p1" name="Overview">', '<diagram name="Overview">')
      .replace("<mxGraphModel>", '<mxGraphModel dx="1086" dy="613">');
    const noPageIdAfter = noPageIdBefore.replace('dx="1086"', 'dx="2566"').replace('dy="613"', 'dy="1314"');
    expect(summarizeNativeDiagramXmlDiff(noPageIdBefore, noPageIdAfter)).toMatchObject({
      available: true, changed: false, pagesChanged: [], cellsAdded: [], cellsRemoved: [], cellsChanged: []
    });
  });

  it("summarizes native Draw.io cell changes and page changes for execution traces", () => {
    const after = before
      .replace('id="p1" name="Overview"', 'id="p1" name="Architecture"')
      .replace('value="Old API"', 'value="Primary API"')
      .replace("</root>", '<mxCell id="api-db" edge="1" parent="1" source="api" target="db"><mxGeometry relative="1" as="geometry"/></mxCell></root>');
    const diff = summarizeNativeDiagramXmlDiff(before, after);
    expect(diff.available).toBe(true);
    expect(diff.changed).toBe(true);
    expect(diff.pagesRenamed).toEqual([{ id: "p1", before: "Overview", after: "Architecture" }]);
    expect(diff.pagesChanged).toContain("p1");
    expect(diff.cellsAdded).toContainEqual(expect.objectContaining({ id: "api-db", kind: "edge", sourceId: "api", targetId: "db" }));
    expect(diff.cellsChanged).toContainEqual(expect.objectContaining({
      id: "api", labelBefore: "Old API", labelAfter: "Primary API", changedFields: expect.arrayContaining(["label"])
    }));
  });
});
