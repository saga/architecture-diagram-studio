import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

interface MockCell {
  id: string;
  vertex: boolean;
  edge: boolean;
  style: string | null;
  value: any;
  geometry: any;
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

function mockGeometry(x: number, y: number, width: number, height: number) {
  return { x, y, width, height, clone() { return mockGeometry(this.x, this.y, this.width, this.height); } };
}

function mockElement() {
  const attributes: Record<string, string> = {};
  return {
    nodeType: 1,
    nodeName: "object",
    setAttribute(name: string, value: string) { attributes[name] = String(value); },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name); },
    cloneNode() {
      const cloned = mockElement();
      Object.entries(attributes).forEach(([name, value]) => cloned.setAttribute(name, value));
      return cloned;
    }
  };
}

function createHarness(options: { personShapeAvailable?: boolean } = {}) {
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
    getStyle: (cell: MockCell) => cell.style,
    beginUpdate: () => undefined,
    endUpdate: () => undefined,
    addListener: () => undefined,
    setStyle: (cell: MockCell, style: string | null) => { cell.style = style; },
    setValue: (cell: MockCell, value: any) => { cell.value = value; },
    setGeometry: (cell: MockCell, geometry: any) => { cell.geometry = geometry; },
    setTerminal: (cell: MockCell, terminal: MockCell | null, source: boolean) => {
      if (source) cell.source = terminal;
      else cell.target = terminal;
    },
    setVisible: (cell: MockCell, visible: boolean) => { cell.visible = visible; },
    setCollapsed: (cell: MockCell, collapsed: boolean) => { cell.collapsed = collapsed; },
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
    mxUtils: { createXmlDocument: () => ({ createElement: () => mockElement() }) },
    mxCellRenderer: { defaultShapes: options.personShapeAvailable === false ? {} : { "mxgraph.c4.person2": function () { return undefined; } } },
    addEventListener: (_name: string, callback: (event: Record<string, any>) => void) => { messageHandler = callback; },
    setTimeout: () => undefined
  };

  const source = readFileSync(new URL("./studio-selection-plugin.js", import.meta.url), "utf8");
  runInNewContext(source, { window: windowMock, console });
  if (!messageHandler) throw new Error("Draw.io bridge did not register its message listener");

  function runOperations(operations: Array<{ cellId: string; path: string; value: string }>) {
    messages.length = 0;
    const request = {
      event: "studioPropertyEditRequest",
      requestId: "test-request",
      cellId: "__batch__",
      path: "cell:batch",
      value: JSON.stringify(operations)
    };
    messageHandler!({
      source: parent,
      origin: "http://studio.test",
      data: JSON.stringify(request)
    });
    return messages.find((message) => message.event === "studioPropertyEditResult");
  }

  function runOperation(cellId: string, path: string, value: string) {
    return runOperations([{ cellId, path, value }]);
  }

  function runScript(script: string) {
    return runOperation("__active_page__", "cell:execute-script", script);
  }

  function runRuntimeInspect() {
    messages.length = 0;
    messageHandler!({
      source: parent,
      origin: "http://studio.test",
      data: JSON.stringify({
        event: "studioRuntimeInspectRequest",
        requestId: "inspect-request",
        documentRevision: "a".repeat(64),
        drawioVersion: "v32.0.2",
        maxCells: 60,
        maxRenderedEdges: 24
      })
    });
    return messages.find((message) => message.event === "studioRuntimeInspectResult");
  }

  return { rootEdge, nestedEdge, service, runScript, runOperation, runOperations, runRuntimeInspect };
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
  "  graph.setCellStyles('edgeStyle', 'orthogonalEdgeStyle', edges);",
  "  graph.setCellStyles('curved', '1', edges);",
  "  graph.refresh();",
  "  return { affectedEdges: edges.length, checkedApiOwner: typeof graph.getDefaultParent === 'function' && typeof model.getDefaultParent === 'undefined' };",
  "}"
].join("\n");

describe("native Draw.io script bridge", () => {
  it("applies the pinned Draw.io C4 Person shape and metadata as a typed native operation", () => {
    const harness = createHarness();
    harness.service.value = "Payment API";
    harness.service.geometry = mockGeometry(10, 20, 120, 60);
    const result = harness.runOperation("service", "cell:set-c4-type", JSON.stringify({ kind: "person" }));

    expect(result).toMatchObject({ event: "studioPropertyEditResult", success: true });
    expect(harness.service.style).toContain("shape=mxgraph.c4.person2");
    expect(harness.service.style).toContain("fillColor=#083F75");
    expect(harness.service.value.getAttribute("c4Name")).toBe("Payment API");
    expect(harness.service.value.getAttribute("c4Type")).toBe("Person");
    expect(harness.service.value.getAttribute("placeholders")).toBe("1");
    expect(harness.service.value.getAttribute("label")).toContain("%c4Name%");
    expect(harness.service.geometry).toMatchObject({ width: 200, height: 180 });
  });

  it("rejects C4 Person when the real shape registry is missing and never uses a fallback", () => {
    const harness = createHarness({ personShapeAvailable: false });
    harness.service.value = "Payment API";
    harness.service.geometry = mockGeometry(10, 20, 120, 60);
    const originalStyle = harness.service.style;
    const result = harness.runOperation("service", "cell:set-c4-type", JSON.stringify({ kind: "person" }));

    expect(result).toMatchObject({ event: "studioPropertyEditResult", success: false, batchRolledBack: true });
    expect(result.error).toContain("No UML actor or other approximate fallback");
    expect(harness.service.style).toBe(originalStyle);
    expect(harness.service.value).toBe("Payment API");
    expect(harness.service.geometry).toMatchObject({ width: 120, height: 60 });
  });

  it("executes whole-page curved-edge changes including connectors inside groups", () => {
    const harness = createHarness();
    const result = harness.runScript(curveAllConnectorsScript);

    expect(result).toMatchObject({
      success: true,
      scriptResult: { available: true, value: { affectedEdges: 2, checkedApiOwner: true } }
    });
    expect(harness.rootEdge.style).toContain("edgeStyle=orthogonalEdgeStyle");
    expect(harness.rootEdge.style).toContain("curved=1");
    expect(harness.rootEdge.style).toContain("dashed=1");
    expect(harness.rootEdge.style).toContain("endArrow=block");
    expect(harness.nestedEdge.style).toContain("edgeStyle=orthogonalEdgeStyle");
    expect(harness.nestedEdge.style).toContain("curved=1");
    expect(harness.nestedEdge.style).toContain("endArrow=block");
    expect(harness.service.style).toContain("fillColor=#ffffff");
    expect(harness.service.style).not.toContain("curved=1");
  });

  it("restores an originally undefined connectability field after a failed batch", () => {
    const harness = createHarness();
    harness.service.connectable = undefined as unknown as boolean;
    const result = harness.runOperations([
      { cellId: "service", path: "cell:connectable", value: "false" },
      { cellId: "missing-cell", path: "label", value: "fail after connectability mutation" }
    ]);
    expect(result).toMatchObject({ success: false, batchRolledBack: true, rollbackErrors: [] });
    expect(harness.service.connectable).toBeUndefined();
  });

  it("inspects native runtime capabilities and cells recursively, including edges inside groups", () => {
    const harness = createHarness();
    const result = harness.runRuntimeInspect();
    expect(result).toMatchObject({
      event: "studioRuntimeInspectResult",
      success: true,
      inspection: {
        schemaVersion: 1,
        bridgeVersion: "studio-native-runtime/1",
        drawioVersion: "v32.0.2",
        documentRevision: "a".repeat(64),
        counts: { cells: 6, vertices: 4, edges: 2 },
        capabilityManifest: { scriptSupported: false }
      }
    });
    const inspected = result?.inspection as { cells: Array<{ id: string }>; capabilities: { graph: string[]; model: string[] } };
    expect(inspected.cells.map((cell) => cell.id)).toContain("edge-nested");
    expect(inspected.capabilities.graph).toContain("getDefaultParent");
    expect(inspected.capabilities.model).toContain("getRoot");
    expect(inspected.capabilities.model).not.toContain("getDefaultParent");
  });

  it("does not claim rollback succeeded after a script detaches the default layer", () => {
    const harness = createHarness();
    const result = harness.runScript('model.remove(model.getCell("1")); throw new Error("intentional failure");');
    expect(result).toMatchObject({ success: false, batchRolledBack: false });
    expect(result.rollbackErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({ cellId: "__active_page__", error: expect.stringContaining("cell tree/order") })
    ]));
  });

  it("restores mutations after a script error even when mxGraphModel lacks setConnectable", () => {
    const harness = createHarness();
    const beforeRootEdge = harness.rootEdge.style;
    const beforeNestedEdge = harness.nestedEdge.style;
    const result = harness.runScript("graph.setCellStyles('curved', '1', [graph.getModel().getCell('edge-root')]); model.getDefaultParent();");

    expect(result).toMatchObject({
      success: false,
      batchRolledBack: true,
      rollbackErrors: []
    });
    expect(result.error).toContain("model.getDefaultParent is not a function");
    expect(harness.rootEdge.style).toBe(beforeRootEdge);
    expect(harness.nestedEdge.style).toBe(beforeNestedEdge);
  });

  it("edits connectability without relying on a non-existent mxGraphModel setter", () => {
    const harness = createHarness();
    const result = harness.runOperation("service", "cell:connectable", "false");

    expect(result).toMatchObject({ success: true });
    expect(harness.service.connectable).toBe(false);
  });
});
