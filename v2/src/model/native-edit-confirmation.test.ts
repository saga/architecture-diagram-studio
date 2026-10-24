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

  it("confirms only the real C4 palette styles and placeholder-backed labels, never UML/swimlane fallbacks", () => {
    const oldNode = '<mxCell id="api" value="Old API" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>';
    const template = '&lt;font style=&quot;font-size: 16px&quot;&gt;&lt;b&gt;%c4Name%&lt;/b&gt;&lt;/font&gt;&lt;div&gt;[%c4Type%]&lt;/div&gt;&lt;br&gt;&lt;div&gt;&lt;font style=&quot;font-size: 11px&quot;&gt;&lt;font color=&quot;#cccccc&quot;&gt;%c4Description%&lt;/font&gt;&lt;/div&gt;';
    const styles = {
      person: 'html=1;fontSize=11;dashed=0;whiteSpace=wrap;fillColor=#083F75;strokeColor=#06315C;fontColor=#ffffff;shape=mxgraph.c4.person2;align=center;metaEdit=1;points=[[0.5,0,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0]];resizable=0;',
      system: 'rounded=1;whiteSpace=wrap;html=1;labelBackgroundColor=none;fillColor=#1061B0;fontColor=#ffffff;align=center;arcSize=10;strokeColor=#0D5091;metaEdit=1;resizable=0;points=[[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0.25,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0],[0,0.25,0]];',
      external: 'rounded=1;whiteSpace=wrap;html=1;labelBackgroundColor=none;fillColor=#8C8496;fontColor=#ffffff;align=center;arcSize=10;strokeColor=#736782;metaEdit=1;resizable=0;points=[[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0.25,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0],[0,0.25,0]];'
    } as const;
    const c4Xml = (kind: "person" | "system" | "external") => before.replace(oldNode,
      '<object placeholders="1" c4Name="Old API" c4Type="' + (kind === "person" ? "Person" : "Software System") +
      '" c4Description="" label="' + template + '"><mxCell id="api" vertex="1" parent="1" style="' + styles[kind] +
      '"><mxGeometry x="10" y="20" width="' + (kind === "person" ? 200 : 240) + '" height="' +
      (kind === "person" ? 180 : 120) + '" as="geometry"/></mxCell></object>');
    for (const kind of ["person", "system", "external"] as const) {
      expect(nativeEditIsReflectedInXml({
        beforeXml: before, xml: c4Xml(kind), cellId: "api", pageId: "p1",
        path: "cell:set-c4-type", value: JSON.stringify({ kind })
      }), "Expected canonical serialized C4 kind: " + kind).toBe(true);
    }
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: c4Xml("person").replace("shape=mxgraph.c4.person2", "shape=umlActor"),
      cellId: "api", pageId: "p1", path: "cell:set-c4-type", value: JSON.stringify({ kind: "person" })
    })).toBe(false);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: c4Xml("system").replace("rounded=1;", "shape=swimlane;"),
      cellId: "api", pageId: "p1", path: "cell:set-c4-type", value: JSON.stringify({ kind: "system" })
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

  it("confirms a script only when native diagram content changes", () => {
    const renamed = before.replace('value="Old API"', 'value="New API"');
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.insertVertex(graph.getDefaultParent(), null, "New", 10, 10, 100, 40);'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: renamed, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch,
      scriptResult: { available: true, value: { verified: true, checks: [{ name: "requested change", passed: true, expected: "New API", actual: "New API" }] } }
    })).toBe(true);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: renamed, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
    const whitespaceOnly = before.replace("</root>", "\n  </root>");
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: whitespaceOnly, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("confirms a script only when native diagram content changes", () => {
    const renamed = before.replace('value="Old API"', 'value="New API"');
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.insertVertex(graph.getDefaultParent(), null, "New", 10, 10, 100, 40);'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: renamed, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch,
      scriptResult: { available: true, value: { verified: true, checks: [{ name: "requested change", passed: true, expected: "New API", actual: "New API" }] } }
    })).toBe(true);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: renamed, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
    const whitespaceOnly = before.replace("</root>", "\n  </root>");
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: whitespaceOnly, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("does not confirm a script that also changes a non-target page", () => {
    const secondPage = '<diagram id="p2" name="Other"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="other" value="Before" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram>';
    const multiPageBefore = before.replace("</mxfile>", secondPage + "</mxfile>");
    const activeAndOtherChanged = multiPageBefore
      .replace('value="Old API"', 'value="New API"')
      .replace('value="Before"', 'value="After"');
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.setCellStyles("curved", "1", graph.getChildCells(graph.getDefaultParent(), false, true));'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: multiPageBefore, xml: activeAndOtherChanged, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("does not confirm a script when active-page metadata changes with the cell model", () => {
    const withMetadata = before.replace('id="p1" name="Overview"', 'id="p1" name="Overview" customPageFlag="before"');
    const changedMetadataAndCell = withMetadata
      .replace('customPageFlag="before"', 'customPageFlag="after"')
      .replace('value="Old API"', 'value="New API"');
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.setCellStyles("curved", "1", graph.getChildCells(graph.getDefaultParent(), false, true));'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: withMetadata, xml: changedMetadataAndCell, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("does not confirm a script when metadata on a non-target page changes", () => {
    const secondPage = '<diagram id="p2" name="Other" customPageFlag="before"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="other" value="Before" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram>';
    const multiPageBefore = before.replace("</mxfile>", secondPage + "</mxfile>");
    const activeCellAndOtherMetadataChanged = multiPageBefore
      .replace('value="Old API"', 'value="New API"')
      .replace('customPageFlag="before"', 'customPageFlag="after"');
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.setCellStyles("curved", "1", graph.getChildCells(graph.getDefaultParent(), false, true));'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: multiPageBefore, xml: activeCellAndOtherMetadataChanged, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("does not confirm a script after deleting the active page or its default layer", () => {
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.removeCells([model.getCell("1")]);'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: "<mxfile></mxfile>", cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);

    const withoutDefaultLayer = before.replace('<mxCell id="1" parent="0"/>', "");
    const activeContentAlsoChanged = withoutDefaultLayer.replace('value="Old API"', 'value="New API"');
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: activeContentAlsoChanged, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("accepts a bare mxGraphModel when the editor page ID is not present in the source XML", () => {
    const bareBefore = before.replace('<mxfile><diagram id="p1" name="Overview">', '').replace('</diagram></mxfile>', '');
    const bareAfter = bareBefore.replace('value="Old API"', 'value="New API"');
    expect(nativeEditIsReflectedInXml({
      beforeXml: bareBefore, xml: bareAfter, cellId: "api", pageId: "p1", path: "label", value: "New API"
    })).toBe(true);
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

});
