import { describe, expect, it } from "vitest";
import { isAutoConfirmableCreationScript } from "./native-script-auto-confirm";

const EXACT_USER_SCRIPT = [
  "var parent = graph.getDefaultParent();",
  "var bbb = model.getCell('bbb');",
  "var xxx = model.getCell('xxx');",
  "if (!bbb || !xxx) { throw new Error('source cells not found'); }",
  "var vStyle = 'rounded=0;whiteSpace=wrap;html=1;';",
  "var eStyle = 'rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;curved=1;';",
  "var ddd = null, eee = null, e1 = null, e2 = null;",
  "model.beginUpdate();",
  "try {",
  "  ddd = graph.insertVertex(parent, null, 'ddd', 632, 520, 120, 60, vStyle);",
  "  eee = graph.insertVertex(parent, null, 'eee', 360, 520, 120, 60, vStyle);",
  "  e1 = graph.insertEdge(parent, null, '', bbb, ddd, eStyle);",
  "  e2 = graph.insertEdge(parent, null, '', xxx, eee, eStyle);",
  "} finally { model.endUpdate(); }",
  "graph.refresh();",
  "graph.view.validate();",
  "function pt(c) { var g = model.getGeometry(c); return g ? { x: g.x, y: g.y, w: g.width, h: g.height } : null; }",
  "function rendered(edge) { var st = graph.view.getState(edge); if (!st || !st.absolutePoints) { return null; } var out = []; for (var i = 0; i < st.absolutePoints.length; i++) { out.push({ x: st.absolutePoints[i].x, y: st.absolutePoints[i].y }); } return out; }",
  "var dddCell = model.getCell(ddd.id);",
  "var eeeCell = model.getCell(eee.id);",
  "return { ddd: { id: ddd.id, label: graph.convertValueToString(dddCell), geometry: pt(dddCell), style: model.getStyle(dddCell) }, eee: { id: eee.id, label: graph.convertValueToString(eeeCell), geometry: pt(eeeCell), style: model.getStyle(eeeCell) }, edges: [{id:e1.id,source:model.getTerminal(e1,true)?model.getTerminal(e1,true).id:null,target:model.getTerminal(e1,false)?model.getTerminal(e1,false).id:null,style:model.getStyle(e1),points:rendered(e1)}, {id:e2.id,source:model.getTerminal(e2,true)?model.getTerminal(e2,true).id:null,target:model.getTerminal(e2,false)?model.getTerminal(e2,false).id:null,style:model.getStyle(e2),points:rendered(e2)}] };"
].join("\n");

const SMALL_SAFE_CREATION_SCRIPT = [
  "var parent = graph.getDefaultParent();",
  "var source = model.getCell('db');",
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
  it("accepts the requested insertion-only script with bounded read-only verification", () => {
    expect(isAutoConfirmableCreationScript(EXACT_USER_SCRIPT)).toBe(true);
  });

  it("accepts a small insertion-only script with a protected update transaction", () => {
    expect(isAutoConfirmableCreationScript(SMALL_SAFE_CREATION_SCRIPT)).toBe(true);
  });

  it.each([
    ["a script that only reports a value", "return { checked: true };"],
    ["a script that deletes a cell", "model.beginUpdate(); try { graph.removeCells([model.getCell('db')]); } finally { model.endUpdate(); } graph.refresh(); return { ok: true };"],
    ["a script that changes an existing cell", "model.beginUpdate(); try { model.setValue(model.getCell('db'), 'changed'); } finally { model.endUpdate(); } graph.refresh(); return { ok: true };"],
    ["a script that uses a browser global", "model.beginUpdate(); try { graph.insertVertex(graph.getDefaultParent(), null, window.location.href, 0, 0, 120, 60); } finally { model.endUpdate(); } graph.refresh(); return { ok: true };"],
    ["a script that performs network access", "fetch('/unexpected'); model.beginUpdate(); try { graph.insertVertex(graph.getDefaultParent(), null, 'x', 0, 0, 120, 60); } finally { model.endUpdate(); } graph.refresh(); return { node: graph.convertValueToString(model.getCell('db')) };"],
    ["a script with an unbounded loop", "model.beginUpdate(); try { graph.insertVertex(graph.getDefaultParent(), null, 'x', 0, 0, 120, 60); } finally { model.endUpdate(); } while (true) {} graph.refresh(); return { ok: true };"],
    ["a script that inserts cells without a rollback-safe transaction", "graph.insertVertex(graph.getDefaultParent(), null, 'x', 0, 0, 120, 60); return { ok: true };"]
  ])("does not auto-confirm %s", (_label, script) => {
    expect(isAutoConfirmableCreationScript(script)).toBe(false);
  });

  it("rejects scripts over the automatic execution size cap", () => {
    expect(isAutoConfirmableCreationScript(" ".repeat(12_001))).toBe(false);
  });
});
