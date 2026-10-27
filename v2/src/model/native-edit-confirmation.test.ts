import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  declaredNativeScriptCellIds, findUndeclaredNativeScriptChanges, nativeEditIsReflectedInXml,
  nativeScriptResultMatchesXml, summarizeNativeDiagramXmlDiff, validateNativeScriptResultAgainstXml
} from "./native-edit-confirmation";

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

  it("accepts script execution without requiring predeclared cell-level postconditions", () => {
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'graph.insertVertex(graph.getDefaultParent(), null, "New", 10, 10, 100, 40);'
    }]);
    const renamed = before.replace('value="Old API"', 'value="New API"');
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: renamed, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(true);
    // The script may be a read-only inspection or a no-op; successful execution and valid native
    // XML serialization are enough to acknowledge it.
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: before, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(true);
    const whitespaceOnly = before.replace("</root>", "\\n  </root>");
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: whitespaceOnly, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(true);
  });

  it("allows scripts to change pages and page metadata as long as the serialized Draw.io document remains structurally valid", () => {
    const secondPage = '<diagram id="p2" name="Other"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="other" value="Before" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram>';
    const multiPageBefore = before.replace("</mxfile>", secondPage + "</mxfile>");
    const activeCellAndOtherMetadataChanged = multiPageBefore
      .replace('id="p1" name="Overview"', 'id="p1" name="Renamed"')
      .replace('value="Old API"', 'value="New API"')
      .replace('name="Other"', 'name="Other - Renamed"');
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'ui.pages.push(ui.currentPage);'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: multiPageBefore, xml: activeCellAndOtherMetadataChanged,
      cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(true);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: "<mxfile></mxfile>",
      cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
    const withoutDefaultLayer = before.replace('<mxCell id="1" parent="0"/>', "");
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: withoutDefaultLayer,
      cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("validates prefixed root and layer IDs without assuming the literal IDs 0 and 1", () => {
    const prefixedPage = '<diagram id="p2" name="Duplicated page"><mxGraphModel><root>' +
      '<mxCell id="copy-prefix-0"/><mxCell id="copy-prefix-1" parent="copy-prefix-0"/>' +
      '<mxCell id="other" value="Before" vertex="1" parent="copy-prefix-1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram>';
    const multiPage = before.replace("</mxfile>", prefixedPage + "</mxfile>");
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script",
      value: 'return { ok: true, postconditions: { changed: true } };'
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: multiPage, xml: multiPage, cellId: "__batch__", pageId: "p2", path: "cell:batch", value: scriptBatch
    })).toBe(true);
    // An unrelated page's ID convention must not veto an edit scoped to p1.
    expect(nativeEditIsReflectedInXml({
      beforeXml: multiPage, xml: multiPage, cellId: "__batch__", pageId: "p1", path: "cell:batch", value: scriptBatch
    })).toBe(true);
  });

  it("rejects a missing script target page instead of falling back to unrelated pages", () => {
    const scriptBatch = JSON.stringify([{
      cellId: "__active_page__", path: "cell:execute-script", value: "return { ok: true };"
    }]);
    expect(nativeEditIsReflectedInXml({
      beforeXml: before, xml: before, cellId: "__batch__", pageId: "missing-page", path: "cell:batch", value: scriptBatch
    })).toBe(false);
  });

  it("verifies script-declared cell, edge terminal, style and geometry assertions against serialized XML", () => {
    const serialized = labelEdited.replace("</root>", 
      '<mxCell id="read-results" value="readResults()" edge="1" parent="1" source="api" target="db" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell></root>');
    const result = {
      available: true,
      value: {
        ok: true,
        postconditions: { messageCreated: true, terminalsVerified: true },
        xmlAssertions: [
          { cellId: "api", exists: true, kind: "vertex", label: "New API", parentId: "1",
            style: { rounded: "0" }, geometry: { x: 10, y: 20, width: 100, height: 40 } },
          { cellId: "read-results", exists: true, kind: "edge", label: "readResults()",
            parentId: "1", sourceId: "api", targetId: "db",
            style: { edgeStyle: "orthogonalEdgeStyle", endArrow: "block" }, geometry: { relative: true } },
          { cellId: "removed-cell", exists: false }
        ]
      }
    };
    expect(nativeScriptResultMatchesXml(result, serialized, "p1")).toBe(true);
    expect(nativeScriptResultMatchesXml(result, before, "p1")).toBe(false);
    expect(nativeScriptResultMatchesXml({
      ...result,
      value: { ...result.value, xmlAssertions: [
        { cellId: "read-results", exists: true, kind: "edge", sourceId: "db", targetId: "api" }
      ] }
    }, serialized, "p1")).toBe(false);
    expect(nativeScriptResultMatchesXml({
      ...result,
      value: { ...result.value, xmlAssertions: [{ cellId: "api", exists: true, kind: "vertex", label: "Wrong label" }] }
    }, serialized, "p1")).toBe(false);
    expect(nativeScriptResultMatchesXml({
      available: true, value: { ok: true, postconditions: { complete: true } }
    }, serialized, "p1")).toBe(false);
  });

  it("reports malformed style assertion shape instead of a generic XML mismatch", () => {
    const serialized = labelEdited.replace("</root>",
      '<mxCell id="read-results" value="readResults()" edge="1" parent="1" source="api" target="db" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell></root>');
    const result = {
      available: true,
      value: {
        ok: true,
        postconditions: { messageCreated: true },
        xmlAssertions: [{ cellId: "read-results", exists: true, kind: "edge", style: "edgeStyle=orthogonalEdgeStyle;endArrow=block;" }]
      }
    };
    const validation = validateNativeScriptResultAgainstXml(result, serialized, "p1");
    expect(validation.ok).toBe(false);
    expect(validation.failures).toContainEqual(expect.objectContaining({
      kind: "invalid-assertion",
      cellId: "read-results",
      field: "style",
      reason: expect.stringContaining("non-empty object")
    }));
    expect(nativeScriptResultMatchesXml(result, serialized, "p1")).toBe(false);
  });

  it("reports non-object assertion rows without masking the schema error", () => {
    const result = {
      available: true,
      value: { ok: true, postconditions: { checked: true }, xmlAssertions: [null] }
    };
    const validation = validateNativeScriptResultAgainstXml(result, before, "p1");
    expect(validation.ok).toBe(false);
    expect(validation.failures).toContainEqual(expect.objectContaining({
      kind: "invalid-assertion", index: 0, field: "assertion", reason: expect.stringContaining("JSON object")
    }));
  });

  it("rejects empty style and geometry assertions because they prove no property", () => {
    const serialized = labelEdited.replace("</root>",
      '<mxCell id="read-results" value="readResults()" edge="1" parent="1" source="api" target="db" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell></root>');
    const base = {
      available: true,
      value: { ok: true, postconditions: { messageCreated: true }, xmlAssertions: [] as Array<Record<string, unknown>> }
    };
    const emptyStyle = {
      ...base,
      value: { ...base.value, xmlAssertions: [{ cellId: "read-results", exists: true, style: {} }] }
    };
    const emptyGeometry = {
      ...base,
      value: { ...base.value, xmlAssertions: [{ cellId: "read-results", exists: true, geometry: {} }] }
    };
    expect(validateNativeScriptResultAgainstXml(emptyStyle, serialized, "p1")).toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ field: "style", reason: expect.stringContaining("empty style object") })]
    });
    expect(validateNativeScriptResultAgainstXml(emptyGeometry, serialized, "p1")).toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ field: "geometry", reason: expect.stringContaining("empty geometry object") })]
    });
  });

  it("reports the exact field and expected/actual values when valid assertions contradict serialized XML", () => {
    const serialized = labelEdited.replace("</root>",
      '<mxCell id="read-results" value="readResults()" edge="1" parent="1" source="api" target="db" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell></root>');
    const result = {
      available: true,
      value: {
        ok: true,
        postconditions: { messageCreated: true },
        xmlAssertions: [{ cellId: "read-results", exists: true, kind: "edge", sourceId: "db", targetId: "api", style: { endArrow: "block" } }]
      }
    };
    const validation = validateNativeScriptResultAgainstXml(result, serialized, "p1");
    expect(validation.ok).toBe(false);
    expect(validation.failures).toContainEqual(expect.objectContaining({
      kind: "mismatch", index: 0, field: "sourceId", expected: "db", actual: "api"
    }));
    expect(validation.failures).toContainEqual(expect.objectContaining({
      kind: "mismatch", index: 0, field: "targetId", expected: "api", actual: "db"
    }));
    expect(validation.failures).not.toContainEqual(expect.objectContaining({ field: "style.endArrow" }));
  });

  it("compares the effective last occurrence of duplicated style keys", () => {
    const serialized = labelEdited.replace("</root>",
      '<mxCell id="read-results" value="readResults()" edge="1" parent="1" source="api" target="db" style="endArrow=block;endArrow=none;">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell></root>');
    const makeResult = (value: string) => ({
      available: true,
      value: {
        ok: true,
        postconditions: { edgeChecked: true },
        xmlAssertions: [{ cellId: "read-results", exists: true, kind: "edge", style: { endArrow: value } }]
      }
    });
    expect(validateNativeScriptResultAgainstXml(makeResult("block"), serialized, "p1").ok).toBe(false);
    expect(validateNativeScriptResultAgainstXml(makeResult("none"), serialized, "p1").ok).toBe(true);
  });

  it("accepts a bare mxGraphModel when the editor page ID is not present in the source XML", () => {
    const bareBefore = before.replace('<mxfile><diagram id="p1" name="Overview">', '').replace('</diagram></mxfile>', '');
    const bareAfter = bareBefore.replace('value="Old API"', 'value="New API"');
    expect(nativeEditIsReflectedInXml({
      beforeXml: bareBefore, xml: bareAfter, cellId: "api", pageId: "p1", path: "label", value: "New API"
    })).toBe(true);
  });

  it("does not let a missing page pass an assertion for an absent cell", () => {
    const result = {
      available: true,
      value: {
        ok: true,
        postconditions: { removed: true },
        xmlAssertions: [{ cellId: "removed-cell", exists: false }]
      }
    };
    const validation = validateNativeScriptResultAgainstXml(result, before, "missing-page");
    expect(validation.ok).toBe(false);
    expect(validation.failures).toContainEqual(expect.objectContaining({
      kind: "invalid-document", field: "document"
    }));
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

  describe("undeclared script changes", () => {
    const added = '<mxCell id="ddd" value="ddd" vertex="1" parent="1"><mxGeometry x="10" y="120" width="100" height="40" as="geometry"/></mxCell>' +
      '<mxCell id="api-ddd" edge="1" parent="1" source="api" target="ddd"><mxGeometry relative="1" as="geometry"/></mxCell>';
    const insertionOnly = before.replace("</root>", added + "</root>");
    const scriptResult = (assertions: unknown[]) => ({ available: true, value: { ok: true, postconditions: { inserted: true }, xmlAssertions: assertions } });

    it("accepts a script whose existing cells are untouched", () => {
      const result = findUndeclaredNativeScriptChanges(before, insertionOnly, scriptResult([
        { cellId: "ddd", exists: true, kind: "vertex", label: "ddd" },
        { cellId: "api-ddd", exists: true, kind: "edge", sourceId: "api", targetId: "ddd" }
      ]));
      expect(result).toMatchObject({ ok: true, available: true });
      expect(result.violations).toEqual([]);
    });

    it("rejects an accidental edit to a cell the script never declared", () => {
      const withStrayRename = insertionOnly.replace('value="Database"', 'value="Warehouse"');
      const result = findUndeclaredNativeScriptChanges(before, withStrayRename, scriptResult([
        { cellId: "ddd", exists: true, kind: "vertex", label: "ddd" }
      ]));
      expect(result.ok).toBe(false);
      expect(result.available).toBe(true);
      expect(result.violations).toContainEqual(expect.objectContaining({ kind: "changed", cellId: "db", changedFields: expect.arrayContaining(["label"]) }));
    });

    it("treats a declared removal as intended and an undeclared one as a violation", () => {
      const withoutDatabase = before.replace(/<mxCell id="db"[^\n]*?<\/mxCell>/, "");
      expect(findUndeclaredNativeScriptChanges(before, withoutDatabase, scriptResult([
        { cellId: "db", exists: false }
      ]))).toMatchObject({ ok: true, violations: [] });
      const undeclared = findUndeclaredNativeScriptChanges(before, withoutDatabase, scriptResult([
        { cellId: "api", exists: true, label: "Old API" }
      ]));
      expect(undeclared.ok).toBe(false);
      expect(undeclared.violations).toContainEqual(expect.objectContaining({ kind: "removed", cellId: "db" }));
    });

    it("ignores cells that disappeared with a removed page", () => {
      const twoPages = before.replace("</mxfile>",
        '<diagram id="p2" name="Second"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
        '<mxCell id="solo" value="Solo" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>' +
        '</root></mxGraphModel></diagram></mxfile>');
      const pageRemoved = before;
      const pageDiff = summarizeNativeDiagramXmlDiff(twoPages, pageRemoved);
      expect(pageDiff.pagesRemoved).toContain("p2");
      expect(pageDiff.cellsRemoved?.some((cell) => cell.id === "solo")).toBe(true);
      const result = findUndeclaredNativeScriptChanges(twoPages, pageRemoved, scriptResult([
        { cellId: "api", exists: true, label: "Old API" }
      ]));
      expect(result.ok).toBe(true);
    });

    it("fails closed when the comparison itself is unavailable", () => {
      const result = findUndeclaredNativeScriptChanges(before, "not xml", scriptResult([{ cellId: "api", exists: true, label: "Old API" }]));
      expect(result).toMatchObject({ ok: false, available: false });
      expect(result.error).toBeTruthy();
    });

    it("reads declared cell IDs only from well-formed assertions", () => {
      expect(declaredNativeScriptCellIds(scriptResult([
        { cellId: "ddd" }, { cellId: " ddd " }, { cellId: "" }, { nope: true }, "junk"
      ]))).toEqual(["ddd"]);
      expect(declaredNativeScriptCellIds(null)).toEqual([]);
      expect(declaredNativeScriptCellIds({ available: true, value: { ok: true } })).toEqual([]);
    });
  });

});
