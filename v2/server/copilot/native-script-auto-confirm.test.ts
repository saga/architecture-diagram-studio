import { describe, expect, it } from "vitest";
import { isAutoConfirmableCreationScript } from "./native-script-auto-confirm";

const SAFE_CREATION_SCRIPT = [
  "var parent = graph.getDefaultParent();",
  "var source = model.getCell('db');",
  "if (!source) { throw new Error('source cell not found'); }",
  "var target = null;",
  "var edge = null;",
  "model.beginUpdate();",
  "try {",
  "  target = graph.insertVertex(parent, null, 'ddd', 100, 160, 120, 60, 'rounded=0;whiteSpace=wrap;html=1;');",
  "  edge = graph.insertEdge(parent, null, '', source, target, 'endArrow=block;endFill=1;curved=1;');",
  "} finally { model.endUpdate(); }",
  "graph.refresh();",
  "return { nodeId: target.id, edgeId: edge.id, sourceId: model.getTerminal(edge, true).id, targetId: model.getTerminal(edge, false).id };"
].join("\n");

describe("native script auto-confirm gate", () => {
  it("accepts an insert-only script with a protected update transaction and read-only postcondition", () => {
    expect(isAutoConfirmableCreationScript(SAFE_CREATION_SCRIPT)).toBe(true);
  });

  it.each([
    ["a script with no insertion", "return { checked: true };"],
    ["a script that deletes cells", "var source = model.getCell('db'); if (!source) throw new Error('missing'); model.beginUpdate(); try { graph.removeCells([source]); } finally { model.endUpdate(); } graph.refresh(); return { ok: true };"],
    ["a script that edits an existing cell", "var source = model.getCell('db'); if (!source) throw new Error('missing'); model.beginUpdate(); try { model.setValue(source, 'changed'); } finally { model.endUpdate(); } graph.refresh(); return { value: graph.convertValueToString(source) };"],
    ["a script that uses browser globals", "var parent = graph.getDefaultParent(); var source = model.getCell('db'); if (!source) throw new Error('missing'); model.beginUpdate(); try { graph.insertVertex(parent, null, window.location.href, 0, 0, 120, 60); } finally { model.endUpdate(); } graph.refresh(); return { ok: true };"],
    ["a script that performs network calls", "fetch('/unexpected'); return { checked: true };"],
    ["a script that contains a loop", "while (true) {} return { checked: true };"],
    ["a script without a rollback-safe transaction", "var parent = graph.getDefaultParent(); var target = graph.insertVertex(parent, null, 'ddd', 0, 0, 120, 60); graph.refresh(); return { label: graph.convertValueToString(target) };"]
  ])("rejects %s", (_label, script) => {
    expect(isAutoConfirmableCreationScript(script)).toBe(false);
  });

  it("rejects scripts over the size cap", () => {
    expect(isAutoConfirmableCreationScript(" ".repeat(12_001))).toBe(false);
  });
});
