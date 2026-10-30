import { describe, expect, it } from "vitest";
import {
  extractNativeEditTargets,
  nativePageAccepts,
  resolveNativePageIdentity
} from "./native-edit-operations";

const XML = `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="db" value="Database" style="rounded=1;fillColor=#ffffff;" vertex="1" parent="1">
    <mxGeometry x="120" y="80" width="160" height="60" as="geometry"/>
  </mxCell>
</root></mxGraphModel></diagram></mxfile>`;

describe("native Draw.io root and page identity", () => {
  const bare = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const envelope = '<mxfile><diagram id="page-1" name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

  it("separates editor identity from document identity for a bare graph model", () => {
    const identity = resolveNativePageIdentity(bare, "editor-page-uuid");
    expect(identity).toMatchObject({
      bare: true, declaredPageId: null, documentPageId: null,
      runtimePageId: "editor-page-uuid", pageExists: true
    });
    expect(nativePageAccepts(identity, "editor-page-uuid")).toBe(true);
    expect(nativePageAccepts(identity, "another-editor-uuid")).toBe(true);
    expect(nativePageAccepts(identity, null)).toBe(true);
  });

  it("uses the declared page ID for an mxfile", () => {
    const identity = resolveNativePageIdentity(envelope, "page-1");
    expect(identity).toMatchObject({
      bare: false, declaredPageId: "page-1", documentPageId: "page-1",
      runtimePageId: "page-1", title: "Page", pageExists: true
    });
    expect(nativePageAccepts(identity, "page-1")).toBe(true);
    expect(nativePageAccepts(identity, "page-2")).toBe(false);
    expect(nativePageAccepts(identity, null)).toBe(true);
  });

  it("fails closed when an mxfile page is missing", () => {
    const identity = resolveNativePageIdentity(envelope, "missing-page");
    expect(identity.pageExists).toBe(false);
    expect(identity.documentPageId).toBeNull();
    expect(nativePageAccepts(identity, "missing-page")).toBe(false);
  });

  it("resolves the only page when no runtime page ID is known", () => {
    expect(resolveNativePageIdentity(envelope, null)).toMatchObject({
      declaredPageId: "page-1", runtimePageId: "page-1", pageExists: true
    });
  });

});

describe("extractNativeEditTargets", () => {
  it("returns all native targets without an implicit cell-count cap", () => {
    const cells = Array.from({ length: 260 }, (_, index) =>
      '<mxCell id="node-' + index + '" value="Node ' + index + '" vertex="1" parent="1">' +
      '<mxGeometry x="' + index + '" y="0" width="80" height="40" as="geometry"/></mxCell>'
    ).join("");
    const targets = extractNativeEditTargets(XML.replace("</root>", cells + "</root>"));
    expect(targets).toHaveLength(261);
    expect(targets.some((target) => target.id === "node-259")).toBe(true);
  });

  it("reads vertex and edge IDs from native XML without a semantic document", () => {
    const xml = XML.replace("</root>",
      '<mxCell id="api" value="API &amp; Service" style="shape=custom.shape;customFlag=preserve;" vertex="1" parent="1"><mxGeometry x="350" y="80" width="160" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="db-to-api" value="calls" edge="1" parent="1" source="db" target="api"><mxGeometry relative="1" as="geometry"/></mxCell></root>');
    expect(extractNativeEditTargets(xml)).toEqual([
      { id: "db", name: "Database", cellType: "vertex" },
      { id: "api", name: "API & Service", cellType: "vertex" },
      { id: "db-to-api", name: "calls", cellType: "edge" }
    ]);
  });

  it("includes shape, geometry, rotation and parent only when requested", () => {
    const xml = XML.replace("</root>",
      '<mxCell id="table" value="" style="shape=mxgraph.floorplan.table;rotation=90;" vertex="1" parent="1"><mxGeometry x="320.4" y="140.7" width="90" height="42" as="geometry"/></mxCell></root>');
    expect(extractNativeEditTargets(xml).find((cell) => cell.id === "table"))
      .toEqual({ id: "table", name: "", cellType: "vertex" });
    expect(extractNativeEditTargets(xml, "p1", { includeGeometry: true }).find((cell) => cell.id === "table"))
      .toEqual({
        id: "table", name: "", cellType: "vertex", shape: "mxgraph.floorplan.table",
        geometry: { x: 320, y: 141, width: 90, height: 42 }, rotation: 90, parentId: "1"
      });
  });

  it("does not fall back to the first page when the requested page ID is stale", () => {
    const secondPage = '<diagram id="p2" name="Other"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="other" value="Other page cell" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram>';
    const multiPage = XML.replace("</mxfile>", secondPage + "</mxfile>");
    expect(getNativeDiagramPageInfo(multiPage, "missing-page")).toEqual({ id: null, title: null });
    expect(extractNativeEditTargets(multiPage, "p2")).toEqual([{ id: "other", name: "Other page cell", cellType: "vertex" }]);
    expect(() => extractNativeEditTargets(multiPage, "missing-page")).toThrow("refusing to inspect cells from another page");
  });

  it("does not expose root/layer cells as editable targets", () => {
    expect(extractNativeEditTargets(XML).map((target) => target.id)).toEqual(["db"]);
  });

  it("does not reserve IDs 0 and 1 for root/layer roles", () => {
    const xml = `<mxfile><diagram id="custom-page"><mxGraphModel><root>
      <mxCell id="root-cell"/>
      <mxCell id="layer-cell" parent="root-cell"/>
      <mxCell id="0" value="Node zero" vertex="1" parent="layer-cell"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="1" value="Node one" vertex="1" parent="layer-cell"><mxGeometry x="120" y="10" width="80" height="40" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    expect(extractNativeEditTargets(xml, "custom-page")).toEqual([
      { id: "0", name: "Node zero", cellType: "vertex" },
      { id: "1", name: "Node one", cellType: "vertex" }
    ]);
  });

  it("keeps empty wrapper and C4 metadata labels instead of substituting inner values", () => {
    const wrapped = '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><object label="" value="Wrapper fallback"><mxCell id="opaque-wrapper-id" value="Inner fallback" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></object></root></mxGraphModel></diagram></mxfile>';
    expect(extractNativeEditTargets(wrapped)).toEqual([{ id: "opaque-wrapper-id", name: "", cellType: "vertex" }]);
    const c4 = '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><object placeholders="1" c4Name="" c4Type="Software System" label="placeholder"><mxCell id="opaque-c4-id" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></object></root></mxGraphModel></diagram></mxfile>';
    expect(extractNativeEditTargets(c4)).toEqual([{ id: "opaque-c4-id", name: "", cellType: "vertex" }]);
    expect(extractNativeEditTargets(c4.replace('c4Name=""', 'c4Name="Orders API"'))).toEqual([
      { id: "opaque-c4-id", name: "Orders API", cellType: "vertex" }
    ]);
  });
});
