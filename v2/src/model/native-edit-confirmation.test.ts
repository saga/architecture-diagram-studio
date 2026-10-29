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
      beforeXml: before, xml: labelEdited, cellId: "__active_page__", pageId: "", path: "cell:unsupported-operation", value: "not-supported"
    })).toBe(false);
  });

  it("confirms a native selection without expecting selection state in XML", () => {
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: before, cellId: "api", pageId: "p1", path: "cell:select", value: "true"
    })).toBe(true);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: unrelatedEdited, cellId: "api", pageId: "p1", path: "cell:select", value: "true"
    })).toBe(false);
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
