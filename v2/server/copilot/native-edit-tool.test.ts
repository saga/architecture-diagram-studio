import { describe, expect, it } from "vitest";
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
    expect(result.error).toContain("requires a vertex");
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
});
