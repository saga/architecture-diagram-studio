import { describe, expect, it } from "vitest";
import { parseNativeEditOperations } from "../../src/model/native-edit-operations";
import { resolveNativeEditTargets } from "./native-edit-tool";

const CONTEXT = { cells: [
  { id: "db", name: "Database", cellType: "vertex" },
  { id: "api", name: "API Service", cellType: "vertex" },
  { id: "cache", name: "Cache", cellType: "vertex" }
] };

describe("resolveNativeEditTargets", () => {
  it("resolves the anchor for add_node_after without losing the new label", () => {
    const resolved = resolveNativeEditTargets(CONTEXT, [{ op: "add_node_after", target: "Database", newLabel: "bbb" }]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.operations[0]).toMatchObject({ op: "add_node_after", cellId: "db", targetLabel: "Database", newLabel: "bbb" });
  });

  it("resolves bulk style scope to the active native page without guessing a cell", () => {
    const parsed = parseNativeEditOperations([{
      op: "set_cells_style", target: "active_page", kinds: ["edge"],
      add: { edgeStyle: "orthogonalEdgeStyle", curved: "1" }, remove: []
    }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = resolveNativeEditTargets(CONTEXT, parsed.operations);
    expect(resolved).toMatchObject({
      ok: true,
      operations: [{
        op: "set_cells_style", target: "active_page", cellId: "__active_page__", targetLabel: "active Draw.io page"
      }]
    });
  });

  it("resolves an exact id and an exact label to the same cell", () => {
    const byId = resolveNativeEditTargets(CONTEXT, [{ op: "select", target: "db" }]);
    const byLabel = resolveNativeEditTargets(CONTEXT, [{ op: "select", target: "database" }]);
    expect(byId.ok && byId.operations[0].cellId).toBe("db");
    expect(byLabel.ok && byLabel.operations[0].cellId).toBe("db");
  });

  it("keeps the canonical label on the resolved operation", () => {
    const resolved = resolveNativeEditTargets(CONTEXT, [
      { op: "select", target: "Database" },
      { op: "set_style", target: "Database", key: "fillColor", color: "#ff0000" }
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.operations).toHaveLength(2);
    expect(resolved.operations.every((operation) => operation.cellId === "db" && operation.targetLabel === "Database")).toBe(true);
  });

  it("rejects add-after targets that are connectors", () => {
    const context = { cells: [{ id: "edge1", name: "calls", cellType: "edge" }] };
    const result = resolveNativeEditTargets(context, [{ op: "add_node_after", target: "calls", newLabel: "Worker" }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("must resolve to a vertex");
  });

  it("rejects moving or resizing a connector until routing geometry has its own operation", () => {
    const context = { cells: [{ id: "edge1", name: "calls", cellType: "edge" }] };
    const move = resolveNativeEditTargets(context, [{ op: "move", target: "calls", dx: 10, dy: 0 }]);
    const resize = resolveNativeEditTargets(context, [{ op: "resize", target: "calls", width: 200, height: 80 }]);
    expect(move.ok).toBe(false);
    expect(resize.ok).toBe(false);
    if (!move.ok) expect(move.error).toContain("not a vertex");
    if (!resize.ok) expect(resize.error).toContain("not a vertex");
  });

  it("checks duplicate labels beyond the prompt-visible first 200 cells", () => {
    const cells = Array.from({ length: 200 }, (_, index) => ({ id: "cell-" + index, name: "Node " + index, cellType: "vertex" as const }));
    cells.push({ id: "last-duplicate", name: "Database", cellType: "vertex" as const });
    cells[3] = { id: "first-duplicate", name: "Database", cellType: "vertex" as const };
    const resolved = resolveNativeEditTargets({ cells }, [{ op: "delete", target: "Database" }]);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error).toContain("ambiguous");
  });

  it("rejects unknown labels with an actionable message", () => {
    const resolved = resolveNativeEditTargets(CONTEXT, [{ op: "select", target: "Missing" }]);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("was not found");
    expect(resolved.error).toContain("Operation 1");
  });

  it("does not overwrite a requested rename label while resolving the target cell", () => {
    const resolved = resolveNativeEditTargets({ cells: [{ id: "db", name: "Database", cellType: "vertex" }] }, [
      { op: "set_label", target: "Database", label: "Data Store" }
    ]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.operations[0]).toMatchObject({
      op: "set_label", cellId: "db", targetLabel: "Database", label: "Data Store"
    });
  });

  it("rejects ambiguous labels instead of guessing", () => {
    const resolved = resolveNativeEditTargets({ cells: [{ id: "a", name: "Queue", cellType: "vertex" }, { id: "b", name: "queue", cellType: "vertex" }] }, [{ op: "select", target: "Queue" }]);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("ambiguous");
  });

  it("prefers a cell id over a label collision", () => {
    const resolved = resolveNativeEditTargets({ cells: [{ id: "Queue", name: "One", cellType: "vertex" }, { id: "other", name: "Queue", cellType: "vertex" }] }, [{ op: "select", target: "Queue" }]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.operations[0].cellId).toBe("Queue");
  });

  it("rejects a context without elements", () => {
    expect(resolveNativeEditTargets({}, [{ op: "select", target: "db" }]).ok).toBe(false);
    expect(resolveNativeEditTargets(null, [{ op: "select", target: "db" }]).ok).toBe(false);
  });

  it("resolves a general native script against the active page, including an empty diagram", () => {
    const emptyDiagramScript = parseNativeEditOperations([{
      op: "run_drawio_script", target: "active_page", summary: "Create an initial node",
      script: 'graph.insertVertex(graph.getDefaultParent(), null, "Start", 100, 100, 120, 60);'
    }]);
    if (!emptyDiagramScript.ok) throw new Error(emptyDiagramScript.error);
    expect(resolveNativeEditTargets({ cells: [] }, emptyDiagramScript.operations)).toMatchObject({
      ok: true, operations: [{ op: "run_drawio_script", cellId: "__active_page__", targetLabel: "active Draw.io page" }]
    });
  });

  it("keeps typed target lookup strict while scripts use the live graph API", () => {
    const typed = parseNativeEditOperations([{ op: "set_label", target: "missing", label: "X" }]);
    if (!typed.ok) throw new Error(typed.error);
    expect(resolveNativeEditTargets(CONTEXT, typed.operations)).toMatchObject({
      ok: false, error: expect.stringContaining("was not found")
    });
    const script = parseNativeEditOperations([{
      op: "run_drawio_script", target: "active_page", summary: "Curve all connectors",
      script: [
        "var edges = [];",
        "function collectEdges(parent) {",
        "  var count = model.getChildCount(parent);",
        "  for (var i = 0; i < count; i += 1) {",
        "    var cell = model.getChildAt(parent, i);",
        "    if (cell && cell.edge) edges.push(cell);",
        "    collectEdges(cell);",
        "  }",
        "}",
        "collectEdges(model.getRoot());",
        "if (edges.length) {",
        "  graph.setCellStyles('edgeStyle', 'orthogonalEdgeStyle', edges);",
        "  graph.setCellStyles('curved', '1', edges);",
        "  graph.setCellStyles('curveGeometry', '1', edges);",
        "  graph.setCellStyles('labelOnCurve', '1', edges);",
        "  graph.refresh();",
        "  if (graph.view && typeof graph.view.validate === 'function') graph.view.validate();",
        "}"
      ].join("\n")
    }]);
    if (!script.ok) throw new Error(script.error);
    expect(resolveNativeEditTargets(CONTEXT, script.operations)).toMatchObject({
      ok: true, operations: [{ op: "run_drawio_script", cellId: "__active_page__" }]
    });
  });
});
