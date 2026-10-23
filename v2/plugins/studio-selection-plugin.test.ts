import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface MockCell {
  id: string;
  vertex: boolean;
  edge: boolean;
  style: string | null;
  value: string;
  geometry: null;
  parent: MockCell | null;
  children: MockCell[];
  source: MockCell | null;
  target: MockCell | null;
  visible: boolean;
  collapsed: boolean;
  connectable: boolean;
}

function makeCell(id: string, options: Partial<Pick<MockCell, "vertex" | "edge" | "style">> = {}): MockCell {
  return {
    id,
    vertex: options.vertex ?? false,
    edge: options.edge ?? false,
    style: options.style ?? "",
    value: "",
    geometry: null,
    parent: null,
    children: [],
    source: null,
    target: null,
    visible: true,
    collapsed: false,
    connectable: true
  };
}

function createHarness() {
  const root = makeCell("0");
  const layer = makeCell("1");
  const service = makeCell("service", { vertex: true, style: "rounded=1;fillColor=#ffffff;" });
  const database = makeCell("database", { vertex: true });
  const rootEdge = makeCell("edge-root", { edge: true, style: "edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;endArrow=block;" });
  const group = makeCell("group", { vertex: true });
  const nestedService = makeCell("nested-service", { vertex: true });
  const nestedEdge = makeCell("edge-nested", { edge: true, style: "edgeStyle=elbowEdgeStyle;html=1;endArrow=block;" });
  const byId = new Map<string, MockCell>();

  function append(parent: MockCell, child: MockCell): void {
    parent.children.push(child);
    child.parent = parent;
    byId.set(child.id, child);
  }
  byId.set(root.id, root);
  append(root, layer);
  append(layer, service);
  append(layer, database);
  append(layer, rootEdge);
  append(layer, group);
  append(group, nestedService);
  append(group, nestedEdge);
  rootEdge.source = service;
  rootEdge.target = database;
  nestedEdge.source = nestedService;
  nestedEdge.target = database;

  const model: Record<string, any> = {
    getRoot: () => root,
    getChildCount: (parent: MockCell) => parent.children.length,
    getChildAt: (parent: MockCell, index: number) => parent.children[index],
    getCell: (id: string) => byId.get(id) ?? null,
    beginUpdate: () => undefined,
    endUpdate: () => undefined,
    addListener: () => undefined,
    setStyle: (cell: MockCell, style: string | null) => { cell.style = style; },
    setValue: (cell: MockCell, value: string) => { cell.value = value; },
    setGeometry: (cell: MockCell, geometry: null) => { cell.geometry = geometry; },
    setTerminal: (cell: MockCell, terminal: MockCell | null, source: boolean) => {
      if (source) cell.source = terminal;
      else cell.target = terminal;
    },
    setVisible: (cell: MockCell, visible: boolean) => { cell.visible = visible; },
    setCollapsed: (cell: MockCell, collapsed: boolean) => { cell.collapsed = collapsed; },
    setConnectable: (cell: MockCell, connectable: boolean) => { cell.connectable = connectable; },
    add: (parent: MockCell, cell: MockCell, index: number) => {
      if (cell.parent) {
        const oldIndex = cell.parent.children.indexOf(cell);
        if (oldIndex >= 0) cell.parent.children.splice(oldIndex, 1);
      }
      parent.children.splice(Math.max(0, Math.min(index, parent.children.length)), 0, cell);
      cell.parent = parent;
      byId.set(cell.id, cell);
    },
    remove: (cell: MockCell) => {
      if (cell.parent) {
        const index = cell.parent.children.indexOf(cell);
        if (index >= 0) cell.parent.children.splice(index, 1);
      }
      byId.delete(cell.id);
      cell.parent = null;
    }
  };

  function styleKey(entry: string): string {
    const separator = entry.indexOf("=");
    return separator < 0 ? entry : entry.slice(0, separator);
  }

  const graph: Record<string, any> = {
    getModel: () => model,
    getSelectionModel: () => ({ addListener: () => undefined }),
    getSelectionCells: () => [],
    getDefaultParent: () => layer,
    setCellStyles: (key: string, value: string | null, cells: MockCell[]) => {
      for (const cell of cells) {
        const entries = (cell.style || "").split(";").filter(Boolean).filter((entry) => styleKey(entry) !== key);
        if (value !== null && value !== undefined) entries.push(key + "=" + value);
        model.setStyle(cell, entries.length ? entries.join(";") + ";" : null);
      }
    },
    refresh: () => undefined
  };

  const messages: Array<Record<string, any>> = [];
  const parent = {
    postMessage: (message: string) => messages.push(JSON.parse(message) as Record<string, any>)
  };
  let messageHandler: ((event: Record<string, any>) => void) | null = null;
  const windowMock = {
    Draw: { loadPlugin: (callback: (ui: Record<string, any>) => void) => callback({
      editor: { graph, setModified: () => undefined },
      addListener: () => undefined
    }) },
    parent,
    location: { origin: "http://studio.test" },
    addEventListener: (_name: string, callback: (event: Record<string, any>) => void) => { messageHandler = callback; },
    setTimeout: () => undefined
  };

  const source = readFileSync(new URL("./studio-selection-plugin.js", import.meta.url), "utf8");
  runInNewContext(source, { window: windowMock, console });
  if (!messageHandler) throw new Error("Draw.io bridge did not register its message listener");

  function runScript(script: string) {
    messages.length = 0;
    const request = {
      event: "studioPropertyEditRequest",
      requestId: "test-request",
      cellId: "__batch__",
      path: "cell:batch",
      value: JSON.stringify([{
        cellId: "__active_page__",
        path: "cell:execute-script",
        value: script
      }])
    };
    messageHandler!({
      source: parent,
      origin: "http://studio.test",
      data: JSON.stringify(request)
    });
    return messages.find((message) => message.event === "studioPropertyEditResult");
  }

  return { rootEdge, nestedEdge, service, runScript };
}

const curveAllConnectorsScript = [
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
  "  graph.setCellStyles('edgeStyle', null, edges);",
  "  graph.setCellStyles('curved', '1', edges);",
  "}"
].join("\n");

describe("native Draw.io script bridge", () => {
  it("executes whole-page curved-edge changes including connectors inside groups", () => {
    const harness = createHarness();
    const result = harness.runScript(curveAllConnectorsScript);

    expect(result).toMatchObject({ success: true });
    expect(harness.rootEdge.style).not.toContain("edgeStyle=");
    expect(harness.rootEdge.style).toContain("curved=1");
    expect(harness.rootEdge.style).toContain("dashed=1");
    expect(harness.rootEdge.style).toContain("endArrow=block");
    expect(harness.nestedEdge.style).not.toContain("edgeStyle=");
    expect(harness.nestedEdge.style).toContain("curved=1");
    expect(harness.nestedEdge.style).toContain("endArrow=block");
    expect(harness.service.style).toContain("fillColor=#ffffff");
    expect(harness.service.style).not.toContain("curved=1");
  });

  it("reports a bad Model API call and rolls back without changing the diagram", () => {
    const harness = createHarness();
    const beforeRootEdge = harness.rootEdge.style;
    const beforeNestedEdge = harness.nestedEdge.style;
    const result = harness.runScript("graph.getChildCells(model.getDefaultParent(), false, true);");

    expect(result).toMatchObject({
      success: false,
      batchRolledBack: true
    });
    expect(result.error).toContain("model.getDefaultParent is not a function");
    expect(harness.rootEdge.style).toBe(beforeRootEdge);
    expect(harness.nestedEdge.style).toBe(beforeNestedEdge);
  });
});
