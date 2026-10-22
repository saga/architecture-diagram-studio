import { describe, expect, it } from "vitest";
import { resolveNativeEditTargets } from "./native-edit-tool";

const CONTEXT = { nodes: [{ id: "db", name: "Database" }, { id: "api", name: "API Service" }, { id: "cache", name: "Cache" }] };

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

  it("rejects unknown labels with an actionable message", () => {
    const resolved = resolveNativeEditTargets(CONTEXT, [{ op: "select", target: "Missing" }]);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("was not found");
    expect(resolved.error).toContain("Operation 1");
  });

  it("rejects ambiguous labels instead of guessing", () => {
    const resolved = resolveNativeEditTargets({ nodes: [{ id: "a", name: "Queue" }, { id: "b", name: "queue" }] }, [{ op: "select", target: "Queue" }]);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("ambiguous");
  });

  it("prefers a cell id over a label collision", () => {
    const resolved = resolveNativeEditTargets({ nodes: [{ id: "Queue", name: "One" }, { id: "other", name: "Queue" }] }, [{ op: "select", target: "Queue" }]);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.operations[0].cellId).toBe("Queue");
  });

  it("rejects a context without elements", () => {
    expect(resolveNativeEditTargets({}, [{ op: "select", target: "db" }]).ok).toBe(false);
    expect(resolveNativeEditTargets(null, [{ op: "select", target: "db" }]).ok).toBe(false);
  });
});
