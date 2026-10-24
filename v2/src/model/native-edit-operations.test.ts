import { describe, expect, it } from "vitest";
import { calculateNativeAutoLayout, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS } from "../layout/native-layout";
import {
  describeNativeEditOperation,
  extractNativeEditTargets,
  MAX_NATIVE_EDIT_OPERATIONS,
  MAX_NATIVE_DRAWIO_SCRIPT_LENGTH,
  NativeEditOperationSchema,
  NativeEditOperationBatchSchema,
  normalizeNativeColor,
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


describe("extractNativeEditTargets", () => {
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

  it("does not expose root/layer cells as editable targets", () => {
    expect(extractNativeEditTargets(XML).map((target) => target.id)).toEqual(["db"]);
  });
});

describe("normalizeNativeColor", () => {
  it("expands short hex and lowercases long hex", () => {
    expect(normalizeNativeColor("#f00")).toBe("#ff0000");
    expect(normalizeNativeColor("#FF0000")).toBe("#ff0000");
    expect(normalizeNativeColor(" #0a0B0c ")).toBe("#0a0b0c");
  });

  it("maps English and Chinese color names", () => {
    expect(normalizeNativeColor("red")).toBe("#ff0000");
    expect(normalizeNativeColor("红色")).toBe("#ff0000");
    expect(normalizeNativeColor("绿色")).toBe("#008000");
  });

  it("accepts a color name embedded in a phrase", () => {
    expect(normalizeNativeColor("红色背景色")).toBe("#ff0000");
  });

  it("rejects unsupported values", () => {
    expect(normalizeNativeColor("chartreuse")).toBeNull();
    expect(normalizeNativeColor("rgb(255,0,0)")).toBeNull();
    expect(normalizeNativeColor("")).toBeNull();
  });
});

describe("Zod native-edit contract", () => {
  it("accepts valid operations and rejects unexpected fields at the source schema", () => {
    expect(NativeEditOperationSchema.safeParse({ op: "add_node_after", target: "db", newLabel: "Cache" }).success).toBe(true);
    expect(NativeEditOperationSchema.safeParse({ op: "add_node_after", target: "db", newLabel: "Cache", arbitrary: true }).success).toBe(false);
    expect(NativeEditOperationBatchSchema.safeParse([]).success).toBe(false);
  });
});

describe("parseNativeEditOperations", () => {
  it("accepts a native add-after operation with an explicit label", () => {
    const parsed = parseNativeEditOperations([{ op: "add_node_after", target: "xxx", newLabel: "bbb" }]);
    expect(parsed).toEqual({ ok: true, operations: [{ op: "add_node_after", target: "xxx", newLabel: "bbb" }] });
  });

  it("uses a typed native C4 operation with the canonical type instead of an arbitrary style script", () => {
    const parsed = parseNativeEditOperations([{ op: "set_c4_type", target: "Database", kind: "system" }]);
    expect(parsed).toMatchObject({ ok: true, operations: [{ op: "set_c4_type", target: "Database", kind: "system" }] });
    expect(describeNativeEditOperation({ op: "set_c4_type", target: "Database", targetLabel: "Database", kind: "system" }))
      .toContain("C4 Software System style");
    if (!parsed.ok) return;
    const resolved = parsed.operations.map((operation) => ({
      ...operation, cellId: "db", targetLabel: "Database"
    })) as ResolvedNativeEditOperation[];
    expect(toNativeCellEdits(resolved, XML, "p1")).toMatchObject({
      ok: true,
      edits: [{ cellId: "db", path: "cell:set-c4-type", value: JSON.stringify({ kind: "system" }) }]
    });
    expect(parseNativeEditOperations([{ op: "set_c4_type", target: "Database", kind: "swimlane" }]))
      .toMatchObject({ ok: false, error: expect.stringContaining("kind must be") });
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
      direction: "LEFT", nodeSpacing: 72, layerSpacing: 108, edgeRouting: "SPLINES",
      iterations: 600, randomSeed: 42, margin: 24
    }]);
    expect(parsed).toMatchObject({
      ok: true,
      operations: [{
        op: "auto_layout", target: "active_page", engine: "elk", algorithm: "stress",
        direction: "LEFT", nodeSpacing: 72, layerSpacing: 108, edgeRouting: "SPLINES",
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

  it("serializes a calculated Dagre plan as a native bridge layout operation", async () => {
    const parsed = parseNativeEditOperations([{ op: "auto_layout", target: "active_page", engine: "dagre", direction: "DOWN" }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = parsed.operations.map((operation) => ({
      ...operation, cellId: "__active_page__", targetLabel: "active Draw.io page"
    })) as ResolvedNativeEditOperation[];
    const plan = await calculateNativeAutoLayout(XML, "p1", "a".repeat(64), {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "dagre", direction: "DOWN"
    });
    expect(toNativeCellEdits(resolved, XML, "p1", plan)).toMatchObject({
      ok: true,
      edits: [{ cellId: "__active_page__", path: "cell:auto-layout" }]
    });
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

  it("accepts a compound select + recolor request", () => {
    const parsed = parseNativeEditOperations([
      { op: "select", target: "Database" },
      { op: "set_style", target: "Database", color: "红色背景色" }
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.operations).toEqual([
      { op: "select", target: "Database" },
      { op: "set_style", target: "Database", key: "fillColor", color: "#ff0000" }
    ]);
  });

  it("keeps an explicit whitelisted style key", () => {
    const parsed = parseNativeEditOperations([{ op: "set_style", target: "db", key: "strokeColor", color: "#0f0" }]);
    expect(parsed.ok && parsed.operations[0]).toEqual({ op: "set_style", target: "db", key: "strokeColor", color: "#00ff00" });
  });

  it("rejects style keys outside the whitelist", () => {
    const parsed = parseNativeEditOperations([{ op: "set_style", target: "db", key: "opacity", color: "red" }]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Style key");
  });

  it("rejects an unsupported color", () => {
    const parsed = parseNativeEditOperations([{ op: "set_style", target: "db", color: "chartreuse" }]);
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
    expect(plan).toEqual({ ok: true, edits: [{ cellId: "__active_page__", path: "cell:execute-script", value: script }] });
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
