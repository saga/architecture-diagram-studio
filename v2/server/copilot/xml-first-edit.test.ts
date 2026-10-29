import { describe, expect, it } from "vitest";
import { applyDrawioXmlPatch } from "./xml-first-edit";

const source = `<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="node-a" value="Alpha" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>
<mxCell id="edge-a" edge="1" source="node-a" target="node-a" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="3" y="4" as="sourcePoint"/></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>`;

describe("applyDrawioXmlPatch", () => {
  it("changes native cell attributes and geometry while preserving unrelated cells", () => {
    const result = applyDrawioXmlPatch(source, [
      { op: "set-cell-attributes", cellId: "node-a", attributes: { value: "Beta", style: "rounded=1;fillColor=#fff;" } },
      { op: "set-geometry", cellId: "node-a", geometry: { x: 25, y: 30 } }
    ]);
    expect(result.changedCellIds).toEqual(["node-a"]);
    expect(result.operationCount).toBe(2);
    expect(result.drawioXml).toContain('id="node-a"');
    expect(result.drawioXml).toContain('value="Beta"');
    expect(result.drawioXml).toContain('x="25"');
    expect(result.drawioXml).toContain('id="edge-a"');
    expect(result.drawioXml).toContain('sourcePoint');
  });

  it("inserts a native Draw.io cell fragment without rebuilding the surrounding document", () => {
    const result = applyDrawioXmlPatch(source, [{
      op: "insert-cell-xml",
      parentId: "1",
      cellXml: '<mxCell id="node-b" value="Beta" vertex="1" parent="1"><mxGeometry x="220" y="20" width="100" height="40" as="geometry"/></mxCell>'
    }]);
    expect(result.changedCellIds).toEqual(["node-b"]);
    expect(result.drawioXml).toContain('id="node-b"');
    expect(result.drawioXml).toContain('value="Beta"');
    expect(result.drawioXml).toContain('id="edge-a"');
  });

  it("targets UserObject wrappers by their native ID and preserves rich-label wrapper structure", () => {
    const wrapped = `<mxfile><diagram id="p" name="Page-1"><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<object id="user-node" label="Before" placeholders="1"><mxCell style="rounded=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell></object>
</root></mxGraphModel></diagram></mxfile>`;
    const result = applyDrawioXmlPatch(wrapped, [{
      op: "set-cell-attributes", cellId: "user-node", attributes: { value: "After" }
    }]);
    expect(result.changedCellIds).toEqual(["user-node"]);
    expect(result.drawioXml).toContain('<object id="user-node" label="After" placeholders="1">');
    expect(result.drawioXml).toContain('style="rounded=1;"');
    const deleted = applyDrawioXmlPatch(wrapped, [{ op: "delete-cell", cellId: "user-node" }]);
    expect(deleted.drawioXml).not.toContain('id="user-node"');
    expect(deleted.drawioXml).toContain('id="1"');
  });

  it("rejects inserted cells whose IDs already exist", () => {
    expect(() => applyDrawioXmlPatch(source, [{
      op: "insert-cell-xml", parentId: "1",
      cellXml: '<mxCell id="node-a" value="Duplicate" vertex="1" parent="1"/>'
    }])).toThrow(/already exists/);
  });

  it("deletes only the requested cell and preserves the page root and unrelated cells", () => {
    const result = applyDrawioXmlPatch(source, [{ op: "delete-cell", cellId: "node-a" }]);
    expect(result.drawioXml).not.toContain('id="node-a"');
    expect(result.drawioXml).toContain('id="edge-a"');
    expect(result.drawioXml).toContain('<root>');
    expect(result.drawioXml).toContain('id="1"');
  });

  it("scopes repeated cell IDs to the explicitly selected page", () => {
    const multiPage = `<mxfile>
<diagram id="page-1" name="One"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node-a" value="First" vertex="1" parent="1"/></root></mxGraphModel></diagram>
<diagram id="page-2" name="Two"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node-a" value="Second" vertex="1" parent="1"/></root></mxGraphModel></diagram>
</mxfile>`;
    const result = applyDrawioXmlPatch(multiPage, [
      { op: "set-cell-attributes", cellId: "node-a", attributes: { value: "Updated" } }
    ], "page-2");
    const firstPage = result.drawioXml.match(/<diagram\b[^>]*id="page-1"[^>]*>([\s\S]*?)<\/diagram>/)?.[1] ?? "";
    const secondPage = result.drawioXml.match(/<diagram\b[^>]*id="page-2"[^>]*>([\s\S]*?)<\/diagram>/)?.[1] ?? "";
    expect(firstPage).toContain('value="First"');
    expect(firstPage).not.toContain('value="Updated"');
    expect(secondPage).toContain('value="Updated"');
  });

  it("requires an explicit page ID for multi-page XML", () => {
    const multiPage = `<mxfile>
<diagram id="page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
<diagram id="page-2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
</mxfile>`;
    expect(() => applyDrawioXmlPatch(multiPage, [
      { op: "set-cell-attributes", cellId: "1", attributes: { value: "Layer" } }
    ])).toThrow(/pageId is required/);
  });

  it("rejects missing cell IDs instead of guessing a target", () => {
    expect(() => applyDrawioXmlPatch(source, [
      { op: "set-cell-attributes", cellId: "missing", attributes: { value: "Beta" } }
    ])).toThrow(/not found/);
  });

  it("does not permit changing a cell ID through an attribute patch", () => {
    expect(() => applyDrawioXmlPatch(source, [
      { op: "set-cell-attributes", cellId: "node-a", attributes: { id: "node-b" } }
    ])).toThrow(/immutable/);
  });

  it("rejects invalid XML before patching", () => {
    expect(() => applyDrawioXmlPatch("<mxfile><broken>", [
      { op: "set-cell-attributes", cellId: "node-a", attributes: { value: "Beta" } }
    ])).toThrow();
  });
});
