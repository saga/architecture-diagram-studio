import { readFileSync } from "node:fs";
import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
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

function createHarness(options: { customShapeAvailable?: boolean } = {}) {
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
    execute: (change: { execute: () => void }) => { change.execute(); },
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

  let editorModifiedCalls = 0;
  let graphRefreshCalls = 0;
  let generatedCellCount = 0;
  const graph: Record<string, any> = {
    gridSize: 10,
    background: null as string | null,
    view: { validateBackground() {} },
    insertVertex: (parent: MockCell, _id: string | null, value: string, x: number, y: number, width: number, height: number, style?: string | null) => {
      const created = makeCell("created-" + (++generatedCellCount), { vertex: true, style: style ?? "drawio-default-vertex-style;" });
      created.value = value;
      created.geometry = mockGeometry(x, y, width, height);
      append(parent, created);
      return created;
    },
    insertEdge: (parent: MockCell, _id: string | null, value: string, source: MockCell, target: MockCell, style?: string | null) => {
      const created = makeCell("created-" + (++generatedCellCount), { edge: true, style: style ?? "" });
      created.value = value;
      created.source = source;
      created.target = target;
      append(parent, created);
      return created;
    },
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
    refresh: () => { graphRefreshCalls += 1; }
  };

  const shapeRegistry: Record<string, () => undefined> = {};
  shapeRegistry["mxgraph.c4.person2"] = () => undefined;
  if (options.customShapeAvailable !== false) shapeRegistry["mxgraph.test.cloud"] = () => undefined;

  const messages: Array<Record<string, any>> = [];
  const parent = {
    postMessage: (message: string) => messages.push(JSON.parse(message) as Record<string, any>)
  };
  let messageHandler: ((event: Record<string, any>) => void) | null = null;
  const windowMock = {
    Draw: { loadPlugin: (callback: (ui: Record<string, any>) => void) => callback({
      editor: { graph, setModified: () => { editorModifiedCalls += 1; } },
      addListener: () => undefined
    }) },
    parent,
    location: { origin: "http://studio.test" },
    mxUtils: {
      createXmlDocument: () => ({ createElement: () => mockElement() }),
      decompress: (payload: string) => decodeURIComponent(strFromU8(inflateSync(Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)))))
    },
    mxCellRenderer: { defaultShapes: shapeRegistry },
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

  function runRuntimeInspect(jsShapeClassNames: string[] = []) {
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
        maxRenderedEdges: 24,
        jsShapeClassNames
      })
    });
    return messages.find((message) => message.event === "studioRuntimeInspectResult");
  }

  function runPalette(plan: Record<string, any>) {
    messages.length = 0;
    messageHandler!({
      source: parent,
      origin: "http://studio.test",
      data: JSON.stringify({ event: "studioNativePaletteRequest", requestId: "palette-request", plan })
    });
    return messages.find((message) => message.event === "studioNativePaletteResult");
  }

  return { rootEdge, nestedEdge, service, runScript, runOperation, runOperations, runRuntimeInspect, runPalette,
    getBackground: () => graph.background,
    setBackground: (value: string | null) => { graph.background = value; },
    getCreatedCells: () => [...byId.values()].filter((cell) => cell.id.startsWith("created-")),
    getEditorModifiedCalls: () => editorModifiedCalls, getGraphRefreshCalls: () => graphRefreshCalls };
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
  it("rejects the removed in-place C4 conversion path without changing the original cell", () => {
    const harness = createHarness();
    harness.service.value = "Payment API";
    harness.service.geometry = mockGeometry(10, 20, 120, 60);
    const before = { style: harness.service.style, value: harness.service.value, geometry: harness.service.geometry.clone() };
    const result = harness.runOperation("service", "cell:set-c4-type", JSON.stringify({ kind: "system" }));

    expect(result).toMatchObject({ event: "studioPropertyEditResult", success: false, batchRolledBack: true });
    expect(result.error).toContain("Unsupported cell property: set-c4-type");
    expect(harness.service.style).toBe(before.style);
    expect(harness.service.value).toBe(before.value);
    expect(harness.service.geometry).toMatchObject({ x: before.geometry.x, y: before.geometry.y, width: before.geometry.width, height: before.geometry.height });
  });


  it("adds a node with Draw.io default styling and source-derived dimensions without inventing edge styling or rewriting its label", () => {
    const harness = createHarness();
    harness.service.geometry = mockGeometry(10, 20, 180, 90);
    harness.service.style = "shape=hexagon;fillColor=#f0f0f0;strokeColor=#444444;";
    const result = harness.runOperation("service", "cell:add-node-after", JSON.stringify({ label: " Cache " }));

    expect(result).toMatchObject({ event: "studioPropertyEditResult", success: true });
    const [node, edge] = harness.getCreatedCells();
    expect(node).toBeTruthy();
    expect(node.value).toBe(" Cache ");
    expect(node.style).toBe("drawio-default-vertex-style;");
    expect(node.style).not.toContain("shape=hexagon");
    expect(node.geometry).toMatchObject({ x: 200, y: 20, width: 180, height: 90 });
    expect(edge).toMatchObject({ edge: true, source: harness.service, target: node, style: "" });
    expect(edge.style).not.toContain("endArrow=");
    expect(edge.style).not.toContain("edgeStyle=");
  });

  it("returns values from IIFE expression scripts to the host", () => {
    const harness = createHarness();
    const result = harness.runScript('(function () { return { ok: true, postconditions: { edgePresent: true } }; })();');

    expect(result).toMatchObject({
      success: true,
      scriptResult: {
        available: true,
        value: { ok: true, postconditions: { edgePresent: true } }
      }
    });
  });

  it("does not execute a script twice when execution itself throws SyntaxError", () => {
    const harness = createHarness();
    const result = harness.runOperations([{
      cellId: "__active_page__",
      path: "cell:execute-script",
      value: '(function () { graph.insertVertex(graph.getDefaultParent(), null, "Created once", 1, 2, 30, 20); throw new SyntaxError("runtime syntax error"); })();'
    }]);

    expect(result).toMatchObject({ success: false, batchRolledBack: true, rollbackErrors: [] });
    expect(harness.getCreatedCells()).toHaveLength(0);
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

  it("rejects timer-based deferred edits before they can escape the native transaction", () => {
    const harness = createHarness();
    const beforeStyle = harness.rootEdge.style;
    const result = harness.runScript(
      "window.setTimeout(function () { graph.setCellStyles('curved', '1', [model.getCell('edge-root')]); }, 1); return { ok: true };"
    );
    expect(result).toMatchObject({ success: false, batchRolledBack: true });
    expect(String(result.error)).toMatch(/synchronous|asynchronous|deferred/i);
    expect(harness.rootEdge.style).toBe(beforeStyle);
    expect(harness.getGraphRefreshCalls()).toBe(0);
  });

  it("rejects async/await continuations before running script code", () => {
    const harness = createHarness();
    const beforeStyle = harness.rootEdge.style;
    const result = harness.runScript(
      "var changeLater = async function () { await Promise.resolve(); graph.setCellStyles('curved', '1', [model.getCell('edge-root')]); }; changeLater(); return { ok: true };"
    );
    expect(result).toMatchObject({ success: false, batchRolledBack: true });
    expect(String(result.error)).toContain("async functions and await");
    expect(harness.rootEdge.style).toBe(beforeStyle);
  });

  it("rejects unbalanced nested model transactions and unwinds them for rollback", () => {
    const harness = createHarness();
    const beforeStyle = harness.rootEdge.style;
    const result = harness.runScript(
      "model.beginUpdate(); graph.setCellStyles('curved', '1', [model.getCell('edge-root')]); return { ok: true };"
    );
    expect(result).toMatchObject({ success: false, batchRolledBack: true, rollbackErrors: [] });
    expect(String(result.error)).toContain("left 1 nested beginUpdate call(s) unbalanced");
    expect(harness.rootEdge.style).toBe(beforeStyle);
  });

  it("does not let a script close the bridge-owned outer model transaction", () => {
    const harness = createHarness();
    const result = harness.runScript("model.endUpdate(); return { ok: true };");
    expect(result).toMatchObject({ success: false, batchRolledBack: true });
    expect(String(result.error)).toContain("must not close the bridge-owned outer model transaction");
  });

  it("allows a script to use a balanced nested native transaction", () => {
    const harness = createHarness();
    const result = harness.runScript(
      "model.beginUpdate(); try { graph.setCellStyles('curved', '1', [model.getCell('edge-root')]); } finally { model.endUpdate(); } return { ok: true, postconditions: { updated: true }, xmlAssertions: [{ cellId: 'edge-root', exists: true, kind: 'edge', style: { curved: '1' } }] };"
    );
    expect(result).toMatchObject({ success: true });
    expect(harness.rootEdge.style).toContain("curved=1");
  });

  it("inspects native runtime capabilities and cells recursively, including edges inside groups", () => {
    const harness = createHarness();
    const result = harness.runRuntimeInspect();
    expect(result).toMatchObject({
      event: "studioRuntimeInspectResult",
      success: true,
      inspection: {
        schemaVersion: 1,
        bridgeVersion: "studio-native-runtime/3",
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

  it("queries registered mxGraph shapes without confusing them with stencils", () => {
    const harness = createHarness();
    const result = harness.runRuntimeInspect(["mxgraph.c4.person2", "mxgraph.test.cloud", "mxgraph.not.registered"]);
    expect(result).toMatchObject({
      success: true,
      inspection: {
        capabilityManifest: {
          jsShapeClasses: {
            requested: ["mxgraph.c4.person2", "mxgraph.test.cloud", "mxgraph.not.registered"],
            registered: {
              "mxgraph.c4.person2": true,
              "mxgraph.test.cloud": true,
              "mxgraph.not.registered": false
            }
          }
        }
      }
    });
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


describe("native Draw.io palette bridge", () => {
  it("allows theme colors on existing gradients and labels while preserving other native style keys", () => {
    const harness = createHarness();
    // Switching from an older preset must clear its colored canvas back to Draw.io's default.
    harness.setBackground("#C5DDE7");
    const originalStyle = "shape=rect;rounded=1;fillColor=#ffffff;gradientColor=#eeeeee;labelBackgroundColor=#ffffff;labelBorderColor=#000000;swimlaneFillColor=#ffffff;indicatorColor=#000000;indicatorGradientColor=#eeeeee;separatorColor=#000000;dashed=1;";
    harness.service.style = originalStyle;
    const expectedIds = ["0", "1", "service", "database", "edge-root", "group", "nested-service", "edge-nested"].sort();
    const nextStyle = "shape=rect;rounded=1;fillColor=#B7DDEB;gradientColor=#B7DDEB;labelBackgroundColor=#C6E0EB;labelBorderColor=#176B85;swimlaneFillColor=#B7DDEB;indicatorColor=#176B85;indicatorGradientColor=#B7DDEB;separatorColor=#176B85;dashed=1;strokeColor=#176B85;fontColor=#153548;studioColorRole=category-1;";
    const result = harness.runPalette({
      theme: "ocean-depths", documentRevision: "a".repeat(64), pageId: null,
      expectedBackground: "#C5DDE7", background: null,
      expectedPageCellIds: expectedIds,
      changes: [{ cellId: "service", kind: "vertex", expectedStyle: originalStyle, style: nextStyle }]
    });
    expect(result).toMatchObject({ event: "studioNativePaletteResult", success: true, changedCells: 1 });
    expect(harness.service.style).toContain("gradientColor=#B7DDEB");
    expect(harness.service.style).toContain("labelBackgroundColor=#C6E0EB");
    expect(harness.service.style).toContain("labelBorderColor=#176B85");
    expect(harness.service.style).toContain("dashed=1");
    expect(harness.service.style).toContain("studioColorRole=category-1");
    expect(result).toMatchObject({ changedBackground: true });
    expect(harness.getBackground()).toBeNull();
  });
});


describe("native Draw.io palette bridge stencil safety", () => {
  function encodeStencil(xml: string): string {
    const compressed = deflateSync(strToU8(encodeURIComponent(xml)));
    let binary = "";
    for (const byte of compressed) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function stencilXml(fillColor: string, extraColor = ""): string {
    return '<shape w="400" h="300" aspect="variable" strokewidth="inherit"><foreground>' +
      '<strokecolor color="#ffffff"/><fillcolor color="' + fillColor + '"/>' +
      extraColor + '<path><move x="0" y="0"/><line x="400" y="0"/><line x="400" y="300"/><close/></path>' +
      '</foreground></shape>';
  }
  function makePlan(harness: ReturnType<typeof createHarness>, beforeStencil: string, afterStencil: string) {
    harness.service.geometry = mockGeometry(0, 0, 400, 300);
    const originalStyle = "shape=stencil(" + encodeStencil(beforeStencil) + ");";
    harness.service.style = originalStyle;
    const nextStyle = "shape=stencil(" + encodeStencil(afterStencil) + ");fillColor=#C6E0EB;strokeColor=#1F617A;fontColor=#153548;studioColorRole=base;";
    return {
      theme: "ocean-depths", documentRevision: "a".repeat(64), pageId: null,
      expectedBackground: null, background: "#C5DDE7",
      expectedPageCellIds: ["0", "1", "service", "database", "edge-root", "group", "nested-service", "edge-nested"].sort(),
      changes: [{ cellId: "service", kind: "vertex", expectedStyle: originalStyle, style: nextStyle }]
    };
  }

  it("accepts a neutral grayscale stencil fill recolor while retaining path geometry", () => {
    const harness = createHarness();
    const before = stencilXml("#e6e7e8");
    const after = stencilXml("#C6E0EB");
    const result = harness.runPalette(makePlan(harness, before, after));
    expect(result).toMatchObject({ event: "studioNativePaletteResult", success: true, changedCells: 1 });
    expect(harness.service.style).toContain("studioColorRole=base");
  });

  it("rejects theme recoloring for a small stencil even when its XML contains only neutral colors", () => {
    const harness = createHarness();
    const before = stencilXml("#e6e7e8");
    const after = stencilXml("#C6E0EB");
    const plan = makePlan(harness, before, after);
    harness.service.geometry = mockGeometry(0, 0, 100, 100);
    const originalStyle = harness.service.style;
    const result = harness.runPalette(plan);
    expect(result).toMatchObject({ event: "studioNativePaletteResult", success: false, rollbackConfirmed: true });
    expect(harness.service.style).toBe(originalStyle);
  });

  it("rejects stencil mutations that touch a chromatic brand asset", () => {
    const harness = createHarness();
    const before = stencilXml("#e6e7e8", '<strokecolor color="#4286c5"/>');
    const after = stencilXml("#C6E0EB", '<strokecolor color="#4286c5"/>');
    const result = harness.runPalette(makePlan(harness, before, after));
    expect(result).toMatchObject({ event: "studioNativePaletteResult", success: false, rollbackConfirmed: true });
    expect(harness.service.style).toBe("shape=stencil(" + encodeStencil(before) + ");");
  });
});
