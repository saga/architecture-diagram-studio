import { describe, expect, it } from "vitest";
import { calculateNativeAutoLayout, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, defaultNativeLayoutAlgorithm } from "../layout/native-layout";
import {
  describeNativeEditOperation,
  extractNativeEditTargets,
  getNativeDiagramPageInfo,
  isBareNativeGraphModel,
  MAX_NATIVE_EDIT_OPERATIONS,
  MAX_NATIVE_DRAWIO_SCRIPT_LENGTH,
  NativeEditOperationSchema,
  NativeEditOperationBatchSchema,
  parseNativeEditOperations,
  toNativeCellEdits,
  type ResolvedNativeEditOperation
} from "./native-edit-operations";

const XML = `<mxfile><diagram id="p1" name="Page-1"><mxGraphModel><root>
  <mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="db" value="Database" style="rounded=1;fillColor=#ffffff;" vertex="1" parent="1">
    <mxGeometry x="120" y="80" width="160" height="60" as="geometry"/>
  </mxCell>
</root></mxGraphModel></diagram></mxfile>`;


describe("native Draw.io root detection", () => {
  it("distinguishes a single graph model from a multi-page mxfile", () => {
    expect(isBareNativeGraphModel('<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>')).toBe(true);
    expect(isBareNativeGraphModel(XML)).toBe(false);
  });
});


describe("extractNativeEditTargets", () => {
  it("returns every native target for large pages without an implicit 200-cell cap", () => {
    const cells = Array.from({ length: 260 }, (_, index) =>
      '<mxCell id="node-' + index + '" value="Node ' + index + '" vertex="1" parent="1">' +
      '<mxGeometry x="' + index + '" y="0" width="80" height="40" as="geometry"/></mxCell>'
    ).join("");
    const xml = XML.replace("</root>", cells + "</root>");
    const targets = extractNativeEditTargets(xml);
    // The base XML contributes one vertex (db) plus the 260 generated nodes.
    expect(targets).toHaveLength(261);
    expect(targets.some((target) => target.id === "node-259")).toBe(true);
  });

  it("reads real vertex and edge ids from native XML without a DiagramDocument", () => {
    const xml = XML.replace(
      '</root>',
      '<mxCell id="api" value="API &amp; Service" style="shape=custom.shape;customFlag=preserve;" vertex="1" parent="1"><mxGeometry x="350" y="80" width="160" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="db-to-api" value="calls" edge="1" parent="1" source="db" target="api"><mxGeometry relative="1" as="geometry"/></mxCell></root>'
    );
    expect(extractNativeEditTargets(xml)).toEqual([
      { id: "db", name: "Database", cellType: "vertex" },
      { id: "api", name: "API & Service", cellType: "vertex" },
      { id: "db-to-api", name: "calls", cellType: "edge" }
    ]);
  });

  it("includes native shape, geometry, rotation and parent only when requested", () => {
    const furnitureXml = XML.replace(
      "</root>",
      '<mxCell id="table" value="" style="shape=mxgraph.floorplan.table;rotation=90;" vertex="1" parent="1"><mxGeometry x="320.4" y="140.7" width="90" height="42" as="geometry"/></mxCell></root>'
    );
    expect(extractNativeEditTargets(furnitureXml).find((cell) => cell.id === "table"))
      .toEqual({ id: "table", name: "", cellType: "vertex" });
    expect(extractNativeEditTargets(furnitureXml, "p1", { includeGeometry: true }).find((cell) => cell.id === "table"))
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
    expect(() => extractNativeEditTargets(multiPage, "missing-page"))
      .toThrow("refusing to inspect cells from another page");
  });

  it("does not expose root/layer cells as editable targets", () => {
    expect(extractNativeEditTargets(XML).map((target) => target.id)).toEqual(["db"]);
  });

  it("does not reserve cell IDs 0 and 1 for root/layer roles", () => {
    const noncanonicalRootAndLayer = `<mxfile><diagram id="custom-page"><mxGraphModel><root>
      <mxCell id="root-cell"/>
      <mxCell id="layer-cell" parent="root-cell"/>
      <mxCell id="0" value="Node zero" vertex="1" parent="layer-cell"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="1" value="Node one" vertex="1" parent="layer-cell"><mxGeometry x="120" y="10" width="80" height="40" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    expect(extractNativeEditTargets(noncanonicalRootAndLayer, "custom-page")).toEqual([
      { id: "0", name: "Node zero", cellType: "vertex" },
      { id: "1", name: "Node one", cellType: "vertex" }
    ]);
  });

  it("keeps an empty visible label empty instead of substituting the native cell id", () => {
    const xml = '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="TwsH19o86vvnPf4LDGem-1" value="" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>';
    expect(extractNativeEditTargets(xml)).toEqual([{ id: "TwsH19o86vvnPf4LDGem-1", name: "", cellType: "vertex" }]);
  });


  it("preserves an explicitly empty wrapper label instead of falling through to internal cell text", () => {
    const xml = '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><object label="" value="Wrapper fallback"><mxCell id="opaque-wrapper-id" value="Inner fallback" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></object></root></mxGraphModel></diagram></mxfile>';
    expect(extractNativeEditTargets(xml)).toEqual([{ id: "opaque-wrapper-id", name: "", cellType: "vertex" }]);
  });

  it("uses native C4 name metadata instead of exposing the placeholder template", () => {
    const xml = '<mxfile><diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><object placeholders="1" c4Name="" c4Type="Software System" label="&amp;lt;b&amp;gt;%c4Name%&amp;lt;/b&amp;gt; &amp;lt;div&amp;gt;[%c4Type%]&amp;lt;/div&amp;gt;"><mxCell id="opaque-c4-id" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell></object></root></mxGraphModel></diagram></mxfile>';
    expect(extractNativeEditTargets(xml)).toEqual([{ id: "opaque-c4-id", name: "", cellType: "vertex" }]);
    const namedXml = xml.replace('c4Name=""', 'c4Name="Orders API"');
    expect(extractNativeEditTargets(namedXml)).toEqual([{ id: "opaque-c4-id", name: "Orders API", cellType: "vertex" }]);
  });
});

describe("native style input", () => {
  it("requires an explicit style key and a concrete hexadecimal color", () => {
    expect(NativeEditOperationSchema.safeParse({ op: "set_style", target: "db", color: "#f00" }).success).toBe(false);
    expect(NativeEditOperationSchema.safeParse({ op: "set_style", target: "db", key: "fillColor", color: "red" }).success).toBe(false);
    expect(NativeEditOperationSchema.safeParse({ op: "set_style", target: "db", key: "fillColor", color: "#f00" }).success).toBe(true);
  });

  it("preserves the supplied hexadecimal value instead of rewriting it through a color-name map", () => {
    expect(parseNativeEditOperations([{ op: "set_style", target: "db", key: "fillColor", color: "#F00" }]))
      .toMatchObject({ ok: true, operations: [{ op: "set_style", target: "db", key: "fillColor", color: "#F00" }] });
  });
});

describe("Zod native-edit contract", () => {
  it("accepts valid operations and rejects unexpected fields at the source schema", () => {
    expect(NativeEditOperationSchema.safeParse({ op: "add_node_after", target: "db", newLabel: "Cache" }).success).toBe(true);
    expect(NativeEditOperationSchema.safeParse({ op: "set_style", target: "db", key: "strokeColor", color: "#fff" }).success).toBe(true);
    expect(NativeEditOperationSchema.safeParse({ op: "add_node_after", target: "db", newLabel: "Cache", arbitrary: true }).success).toBe(false);
    expect(NativeEditOperationBatchSchema.safeParse([]).success).toBe(false);
  });
});

describe("parseNativeEditOperations", () => {
  it("does not describe an unnamed target by leaking its native id", () => {
    expect(describeNativeEditOperation({ op: "select", target: "TwsH19o86vvnPf4LDGem-1", cellId: "TwsH19o86vvnPf4LDGem-1", targetLabel: "" }))
      .toBe("Select “unnamed element”");
  });
  it("accepts a native add-after operation with an explicit label", () => {
    const parsed = parseNativeEditOperations([{ op: "add_node_after", target: "xxx", newLabel: "bbb" }]);
    expect(parsed).toEqual({ ok: true, operations: [{ op: "add_node_after", target: "xxx", newLabel: "bbb" }] });
  });

  it("does not expose an in-place C4 conversion as a typed edit", () => {
    expect(parseNativeEditOperations([{ op: "set_c4_type", target: "Database", kind: "system" }])).toMatchObject({ ok: false });
  });


  it("plans bounded below-and-connect operations without native script code", () => {
    const parsed = parseNativeEditOperations([
      { op: "add_node_below", target: "Database", newLabel: "ddd" },
      { op: "add_node_below", target: "API Service", newLabel: "eee" }
    ]);
    expect(parsed).toMatchObject({ ok: true, operations: [
      { op: "add_node_below", target: "Database", newLabel: "ddd" },
      { op: "add_node_below", target: "API Service", newLabel: "eee" }
    ] });
    if (!parsed.ok) return;
    const resolved = parsed.operations.map((operation) => ({
      ...operation,
      cellId: operation.target === "Database" ? "db" : "api",
      targetLabel: operation.target
    })) as ResolvedNativeEditOperation[];
    const xmlWithApi = XML.replace("</root>",
      '<mxCell id="api" value="API Service" vertex="1" parent="1"><mxGeometry x="320" y="80" width="160" height="60" as="geometry"/></mxCell></root>');
    expect(toNativeCellEdits(resolved, xmlWithApi, "p1")).toMatchObject({
      ok: true,
      edits: [
        { cellId: "db", path: "cell:add-node-below", value: JSON.stringify({ label: "ddd" }) },
        { cellId: "api", path: "cell:add-node-below", value: JSON.stringify({ label: "eee" }) }
      ]
    });
    expect(describeNativeEditOperation(resolved[0])).toBe('Add “ddd” below “Database” and connect it');
  });

  it("accepts a configurable Studio auto-layout operation and keeps it as a single-operation batch", () => {
    const parsed = parseNativeEditOperations([{
      op: "auto_layout", target: "active_page", engine: "elk", algorithm: "stress",
      direction: "LEFT", preserveLocalGrouping: false, preserveCanvasOrigin: true, nodeSpacing: 72, layerSpacing: 108, edgeRouting: "SPLINES",
      iterations: 600, randomSeed: 42, margin: 24
    }]);
    expect(parsed).toMatchObject({
      ok: true,
      operations: [{
        op: "auto_layout", target: "active_page", engine: "elk", algorithm: "stress",
        direction: "LEFT", preserveLocalGrouping: false, preserveCanvasOrigin: true, nodeSpacing: 72, layerSpacing: 108, edgeRouting: "SPLINES",
        iterations: 600, randomSeed: 42, margin: 24
      }]
    });
    if (!parsed.ok) return;
    expect(describeNativeEditOperation(parsed.operations[0])).toContain("ELK stress");
    expect(parseNativeEditOperations([
      { op: "auto_layout", target: "active_page", engine: "dagre" },
      { op: "select", target: "db" }
    ])).toMatchObject({ ok: false, error: expect.stringContaining("only operation") });
  });

  it.each([
    ["elk", "layered"], ["dagre", "layered"], ["graphviz", "dot"],
    ["msagl", "layered"], ["cytoscape", "breadthfirst"], ["d3", "tree"]
  ] as const)("chooses an engine-specific default algorithm for %s when omitted", (engine, algorithm) => {
    const parsed = parseNativeEditOperations([{ op: "auto_layout", target: "active_page", engine }]);
    expect(parsed).toMatchObject({ ok: true, operations: [{
      engine, algorithm, preserveLocalGrouping: true, preserveCanvasOrigin: false,
      preserveRelativeAnchors: false, anchorCellIds: []
    }] });
    expect(defaultNativeLayoutAlgorithm(engine)).toBe(algorithm);
  });

  it("accepts relative-anchor IDs only when relative-anchor preservation is enabled", () => {
    expect(parseNativeEditOperations([{
      op: "auto_layout", target: "active_page", engine: "elk",
      preserveRelativeAnchors: true, anchorCellIds: ["anchor-b", "anchor-a", "anchor-a"]
    }])).toMatchObject({
      ok: true,
      operations: [{
        op: "auto_layout",
        preserveRelativeAnchors: true,
        anchorCellIds: ["anchor-a", "anchor-b"]
      }]
    });
    expect(parseNativeEditOperations([{
      op: "auto_layout", target: "active_page", engine: "elk", preserveRelativeAnchors: true
    }])).toMatchObject({ ok: false, error: expect.stringContaining("requires at least two") });
    expect(parseNativeEditOperations([{
      op: "auto_layout", target: "active_page", engine: "elk", anchorCellIds: ["anchor-a", "anchor-b"]
    }])).toMatchObject({ ok: false, error: expect.stringContaining("require preserveRelativeAnchors=true") });
  });

  it("rejects an unsupported Dagre algorithm rather than silently mapping it to layered", () => {
    expect(parseNativeEditOperations([{ op: "auto_layout", target: "active_page", engine: "dagre", algorithm: "radial" }]))
      .toMatchObject({ ok: false, error: expect.stringContaining("does not support") });
    expect(parseNativeEditOperations([{ op: "auto_layout", target: "active_page", engine: "dagre", algorithm: "layered" }]))
      .toMatchObject({ ok: true, operations: [{ engine: "dagre", algorithm: "layered" }] });
  });

  it("serializes a calculated Dagre plan as a native bridge layout operation", async () => {
    const parsed = parseNativeEditOperations([{ op: "auto_layout", target: "active_page", engine: "dagre", direction: "DOWN" }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = parsed.operations.map((operation) => ({
      ...operation, cellId: "__active_page__", targetLabel: "active Draw.io page"
    })) as ResolvedNativeEditOperation[];
    const plan = await calculateNativeAutoLayout(XML, "p1", "a".repeat(64), {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "dagre", direction: "DOWN",
      // The operation schema defaults this option to false; the toolbar default is intentionally independent.
      preserveRelativeAnchors: false
    });
    expect(toNativeCellEdits(resolved, XML, "p1", plan)).toMatchObject({
      ok: true,
      edits: [{ cellId: "__active_page__", path: "cell:auto-layout" }]
    });
  });

  it("rejects a layout plan calculated with a different local-grouping option", async () => {
    const parsed = parseNativeEditOperations([{ op: "auto_layout", target: "active_page", engine: "dagre", direction: "DOWN" }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = parsed.operations.map((operation) => ({
      ...operation, cellId: "__active_page__", targetLabel: "active Draw.io page"
    })) as ResolvedNativeEditOperation[];
    const mismatchedPlan = await calculateNativeAutoLayout(XML, "p1", "a".repeat(64), {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
      engine: "dagre",
      algorithm: "layered",
      direction: "DOWN",
      preserveLocalGrouping: false
    });
    expect(toNativeCellEdits(resolved, XML, "p1", mismatchedPlan)).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not match")
    });
  });

  it("rejects a layout plan calculated with a different canvas-origin option", async () => {
    const parsed = parseNativeEditOperations([{
      op: "auto_layout", target: "active_page", engine: "dagre", direction: "DOWN", preserveCanvasOrigin: false
    }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = parsed.operations.map((operation) => ({
      ...operation, cellId: "__active_page__", targetLabel: "active Draw.io page"
    })) as ResolvedNativeEditOperation[];
    const mismatchedPlan = await calculateNativeAutoLayout(XML, "p1", "a".repeat(64), {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "dagre", direction: "DOWN", preserveCanvasOrigin: true
    });
    expect(toNativeCellEdits(resolved, XML, "p1", mismatchedPlan)).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not match")
    });
  });

  it("preserves intentional leading and trailing whitespace in labels", () => {
    const rename = parseNativeEditOperations([{ op: "set_label", target: "Database", label: "  Primary Database  " }]);
    expect(rename).toMatchObject({ ok: true, operations: [{ op: "set_label", label: "  Primary Database  " }] });

    const addAfter = parseNativeEditOperations([{ op: "add_node_after", target: "Database", newLabel: "  Cache  " }]);
    expect(addAfter).toMatchObject({ ok: true, operations: [{ op: "add_node_after", newLabel: "  Cache  " }] });
    expect(parseNativeEditOperations([{ op: "set_label", target: "Database", label: "   " }]).ok).toBe(false);
    expect(parseNativeEditOperations([{ op: "add_node_after", target: "Database", newLabel: "   " }]).ok).toBe(false);
  });

  it("requires newLabel for add_node_after", () => {
    const parsed = parseNativeEditOperations([{ op: "add_node_after", target: "xxx" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("newLabel");
  });

  it("accepts general Draw.io code and requires it to be the only operation", () => {
    const script = "const cells = graph.getChildCells(graph.getDefaultParent(), true, true); return { inspected: cells.length };";
    expect(parseNativeEditOperations([{
      op: "run_drawio_script", target: "active_page", summary: "Inspect and restyle the diagram", script
    }])).toEqual({
      ok: true, operations: [{ op: "run_drawio_script", target: "active_page", summary: "Inspect and restyle the diagram", script }]
    });
    expect(parseNativeEditOperations([
      { op: "run_drawio_script", target: "active_page", summary: "Script", script },
      { op: "set_label", target: "db", label: "Renamed" }
    ])).toMatchObject({ ok: false, error: expect.stringContaining("only operation") });
    expect(parseNativeEditOperations([{
      op: "run_drawio_script", target: "active_page", summary: "Script", script: "x".repeat(MAX_NATIVE_DRAWIO_SCRIPT_LENGTH + 1)
    }])).toMatchObject({ ok: false, error: expect.stringContaining("exceeds") });
  });

  it.each([
    ["Rename the Database to Data Store", "Data Store"],
    ["把 Database 改名为数据仓库", "数据仓库"]
  ])("validates the same typed rename operation for localized label value %s", (requestLabel, newLabel) => {
    expect(requestLabel.length).toBeGreaterThan(0);
    const parsed = parseNativeEditOperations([{ op: "set_label", target: "Database", label: newLabel }]);
    expect(parsed).toMatchObject({ ok: true, operations: [{ op: "set_label", target: "Database", label: newLabel }] });
  });

  it.each([
    ["up", 0, -10],
    ["down", 0, 10],
    ["left", -10, 0],
    ["right", 10, 0]
  ] as const)("preserves a bounded numeric move delta for %s", (_direction, dx, dy) => {
    const parsed = parseNativeEditOperations([{ op: "move", target: "Database", dx, dy }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = toNativeCellEdits(parsed.operations.map((operation) => ({
      ...operation, cellId: "db", targetLabel: "Database"
    } as ResolvedNativeEditOperation)), XML);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toEqual([{ cellId: "db", path: "geometry:translate", value: dx + "," + dy }]);
  });

  it("preserves an explicit color key and hex value without a name lookup or rewrite", () => {
    const parsed = parseNativeEditOperations([
      { op: "select", target: "Database" },
      { op: "set_style", target: "Database", key: "fillColor", color: "#f00" }
    ]);
    expect(parsed).toMatchObject({ ok: true, operations: [
      { op: "select", target: "Database" },
      { op: "set_style", target: "Database", key: "fillColor", color: "#f00" }
    ] });
  });

  it("keeps an explicit whitelisted style key", () => {
    const parsed = parseNativeEditOperations([{ op: "set_style", target: "db", key: "strokeColor", color: "#0f0" }]);
    expect(parsed.ok && parsed.operations[0]).toEqual({ op: "set_style", target: "db", key: "strokeColor", color: "#0f0" });
  });

  it("rejects style keys outside the whitelist", () => {
    const parsed = parseNativeEditOperations([{ op: "set_style", target: "db", key: "opacity", color: "red" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Style key");
  });

  it("rejects an unsupported color", () => {
    const parsed = parseNativeEditOperations([{ op: "set_style", target: "db", key: "fillColor", color: "chartreuse" }]);
    expect(parsed.ok).toBe(false);
  });

  it("rejects zero-distance moves and out-of-range geometry", () => {
    expect(parseNativeEditOperations([{ op: "move", target: "db", dx: 0, dy: 0 }]).ok).toBe(false);
    expect(parseNativeEditOperations([{ op: "resize", target: "db", width: 0, height: 10 }]).ok).toBe(false);
    expect(parseNativeEditOperations([{ op: "resize", target: "db", width: 10, height: 20000 }]).ok).toBe(false);
  });

  it("keeps unsupported alignment, grouping and relation actions outside the native allowlist", () => {
    for (const op of ["align", "group", "create_relation", "set_edge_endpoints"]) {
      expect(parseNativeEditOperations([{ op, target: "Database" }])).toMatchObject({ ok: false });
    }
  });

  it("rejects unknown operations, empty lists and oversized batches", () => {
    expect(parseNativeEditOperations([{ op: "recolor", target: "db" }]).ok).toBe(false);
    expect(parseNativeEditOperations([]).ok).toBe(false);
    expect(parseNativeEditOperations("select db").ok).toBe(false);
    const tooMany = Array.from({ length: MAX_NATIVE_EDIT_OPERATIONS + 1 }, () => ({ op: "select", target: "db" }));
    const parsed = parseNativeEditOperations(tooMany);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain(String(MAX_NATIVE_EDIT_OPERATIONS));
  });

  it("rejects empty and oversized targets", () => {
    expect(parseNativeEditOperations([{ op: "select", target: "   " }]).ok).toBe(false);
    expect(parseNativeEditOperations([{ op: "select", target: "x".repeat(201) }]).ok).toBe(false);
  });

  it("reports the failing operation position", () => {
    const parsed = parseNativeEditOperations([{ op: "select", target: "db" }, { op: "set_label", target: "db" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.startsWith("Operation 2:")).toBe(true);
  });
});

describe("toNativeCellEdits", () => {
  it("maps operations onto bridge paths", () => {
    const operations: ResolvedNativeEditOperation[] = [
      { op: "select", target: "Database", cellId: "db", targetLabel: "Database" },
      { op: "set_style", target: "Database", cellId: "db", targetLabel: "Database", key: "fillColor", color: "#ff0000" },
      { op: "add_node_after", target: "Database", cellId: "db", targetLabel: "Database", newLabel: "bbb" }
    ];
    const plan = toNativeCellEdits(operations, XML);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toEqual([
      { cellId: "db", path: "cell:select", value: "true" },
      { cellId: "db", path: "style:fillColor", value: "#ff0000" },
      { cellId: "db", path: "cell:add-node-after", value: JSON.stringify({ label: "bbb" }) }
    ]);
  });

  it("maps rename, delete and resize directly to native-cell bridge operations", () => {
    const xmlWithObsolete = XML.replace('</root>', '<mxCell id="obsolete" value="Obsolete" vertex="1" parent="1"><mxGeometry x="320" y="80" width="120" height="60" as="geometry"/></mxCell></root>');
    const operations: ResolvedNativeEditOperation[] = [
      { op: "set_label", target: "Database", cellId: "db", targetLabel: "Database", label: "Data Store" },
      { op: "delete", target: "Obsolete", cellId: "obsolete", targetLabel: "Obsolete" },
      { op: "resize", target: "Database", cellId: "db", targetLabel: "Database", width: 220, height: 90 }
    ];
    const plan = toNativeCellEdits(operations, xmlWithObsolete);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toEqual([
      { cellId: "db", path: "label", value: "Data Store" },
      { cellId: "obsolete", path: "cell:delete", value: "true" },
      { cellId: "db", path: "geometry:size", value: "220,90" }
    ]);
  });

  it("maps general native Draw.io code to the active-page execution bridge", () => {
    const script = 'graph.getChildCells(graph.getDefaultParent(), false, true).forEach((edge) => graph.setCellStyles("curved", "1", [edge]));';
    const plan = toNativeCellEdits([{
      op: "run_drawio_script", target: "active_page", summary: "Curve all connectors", script,
      cellId: "__active_page__", targetLabel: "active Draw.io page"
    }], XML);
    expect(plan).toEqual({
      ok: true,
      edits: [{
        cellId: "__active_page__", path: "cell:execute-script",
        value: JSON.stringify({ mode: "mutate", script })
      }]
    });
    const readOnlyPlan = toNativeCellEdits([{
      op: "run_drawio_script", target: "active_page", summary: "Inspect furniture",
      mode: "read", script: "return { tables: 3 };",
      cellId: "__active_page__", targetLabel: "active Draw.io page"
    }], XML);
    expect(readOnlyPlan).toEqual({
      ok: true,
      edits: [{
        cellId: "__active_page__", path: "cell:execute-script",
        value: JSON.stringify({ mode: "read", script: "return { tables: 3 };" })
      }]
    });
  });

  it("passes a move delta to the native editor for live-coordinate execution", () => {
    const plan = toNativeCellEdits([{ op: "move", target: "Database", cellId: "db", targetLabel: "Database", dx: -20, dy: 15 }], XML);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toEqual([
      { cellId: "db", path: "geometry:translate", value: "-20,15" }
    ]);
  });

  it("uses the selected page when duplicate cell IDs exist in a multi-page file", () => {
    const twoPages = '<mxfile>' +
      '<diagram id="p1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '<diagram id="p2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="500" y="600" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram>' +
      '</mxfile>';
    const plan = toNativeCellEdits([
      { op: "move", target: "Database", cellId: "db", targetLabel: "Database", dx: 5, dy: 7 }
    ], twoPages, "p2");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toEqual([
      { cellId: "db", path: "geometry:translate", value: "5,7" }
    ]);
  });

  it("fails when the cell is missing from the XML", () => {
    const plan = toNativeCellEdits([{ op: "move", target: "Gone", cellId: "gone", targetLabel: "Gone", dx: 1, dy: 1 }], XML);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error).toContain("Gone");
  });

  it("rejects an empty plan", () => {
    expect(toNativeCellEdits([], XML).ok).toBe(false);
  });
});

describe("describeNativeEditOperation", () => {
  it("describes each operation for the chat transcript", () => {
    expect(describeNativeEditOperation({ op: "set_style", target: "db", key: "fillColor", color: "#ff0000" }))
      .toBe("Set fillColor of “db” to #ff0000");
    expect(describeNativeEditOperation({ op: "select", target: "db" })).toBe("Select “db”");
    expect(describeNativeEditOperation({
      op: "run_drawio_script", target: "active_page", summary: "Rework layout", script: "return true;"
    })).toBe("Rework layout");
    expect(describeNativeEditOperation({ op: "add_node_after", target: "xxx", newLabel: "bbb" })).toBe("Add “bbb” to the right of “xxx” and connect it");
    expect(describeNativeEditOperation({
      op: "add_node_after", target: "MRDE1TfU6mpqhOhdJKLE-1", targetLabel: "xxx", newLabel: "bbb"
    })).toBe("Add “bbb” to the right of “xxx” and connect it");
  });
});
