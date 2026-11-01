import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The Draw.io plugin is a plain script that never goes through `tsc`, so a renamed or deleted
 * helper only fails when the iframe evaluates the call. This harness loads the real plugin against
 * a minimal mock of the Draw.io runtime and drives the paths Studio depends on: registration, the
 * host handshake, and publishing the current selection.
 */
const PLUGIN_SOURCE = readFileSync(new URL("../plugins/studio-selection-plugin.js", import.meta.url), "utf8");

interface MockCell {
  id: string;
  vertex: boolean;
  edge: boolean;
  style: string;
  value: string;
  geometry: { x: number; y: number; width: number; height: number; relative: boolean; points: unknown[] } | null;
  parent: MockCell | null;
  children: MockCell[];
  source: MockCell | null;
  target: MockCell | null;
  getId(): string;
}

function makeCell(id: string, options: { vertex?: boolean; edge?: boolean } = {}): MockCell {
  const cell: MockCell = {
    id,
    vertex: options.vertex ?? true,
    edge: options.edge ?? false,
    style: "rounded=1;",
    value: id,
    geometry: { x: 0, y: 0, width: 80, height: 40, relative: false, points: [] },
    parent: null,
    children: [],
    source: null,
    target: null,
    getId() { return id; }
  };
  return cell;
}

function createHarness() {
  const posted: Array<Record<string, unknown>> = [];
  const windowListeners: Array<(event: Record<string, unknown>) => void> = [];
  const selectionListeners: Array<() => void> = [];
  const modelListeners: Array<() => void> = [];

  const layer = makeCell("1", { vertex: false });
  const cellA = makeCell("cell-a");
  const cellB = makeCell("cell-b");
  cellA.parent = layer;
  cellB.parent = layer;
  layer.children = [cellA, cellB];
  const byId: Record<string, MockCell> = { "1": layer, "cell-a": cellA, "cell-b": cellB };

  const model = {
    getRoot: () => layer,
    getChildCount: (cell: MockCell) => cell.children.length,
    getChildAt: (cell: MockCell, index: number) => cell.children[index] ?? null,
    getCell: (id: string) => byId[id] ?? null,
    getStyle: () => "rounded=1;",
    addListener: (_name: string, listener: () => void) => { modelListeners.push(listener); }
  };
  const selectionModel = {
    addListener: (_name: string, listener: () => void) => { selectionListeners.push(listener); },
    cells: [cellA]
  };
  const graph = {
    getModel: () => model,
    getSelectionModel: () => selectionModel,
    getSelectionCells: () => [cellA],
    background: "#ffffff",
    view: { getState: () => null, validate: () => undefined },
    refresh: () => undefined
  };
  const ui = {
    editor: { graph, undoManager: { canUndo: () => false, canRedo: () => false, addListener: () => undefined }, setModified: () => undefined },
    currentPage: { getId: () => "page-1" },
    addListener: () => undefined
  };

  const parentWindow = { postMessage: (raw: string) => { posted.push(JSON.parse(raw) as Record<string, unknown>); } };
  const windowMock: Record<string, unknown> = {
    parent: parentWindow,
    Draw: { loadPlugin: (callback: (ui: unknown) => void) => callback(ui) },
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => {
      if (name === "message") windowListeners.push(listener);
    },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined
  };

  runInNewContext(PLUGIN_SOURCE, {
    window: windowMock,
    console: { error: () => undefined, warn: () => undefined, log: () => undefined },
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    DOMParser: class { parseFromString() { return { body: { firstElementChild: null } }; } }
  });

  return {
    posted,
    /** Delivers the host handshake the real Studio frame sends after the iframe announces itself. */
    handshake() {
      const listener = windowListeners[0];
      if (!listener) throw new Error("The plugin did not register a message listener");
      listener({ source: parentWindow, origin: "http://127.0.0.1:4173", data: JSON.stringify({ event: "studioDrawioWelcome" }) });
    },
    publishSelectionChange() {
      for (const listener of selectionListeners) listener();
    },
    publishModelChange() {
      for (const listener of modelListeners) listener();
    }
  };
}

describe("Draw.io embed plugin runtime", () => {
  it("registers against the native runtime without referencing undeclared helpers", () => {
    expect(() => createHarness()).not.toThrow();
  });

  it("publishes the selection and history state after the host handshake", () => {
    const harness = createHarness();
    harness.handshake();

    const bridgeReady = harness.posted.find((message) => message.event === "studioBridgeReady");
    expect(bridgeReady).toMatchObject({ event: "studioBridgeReady", drawioVersion: "v32.0.2" });

    const selection = harness.posted.find((message) => message.event === "studioSelectionChanged");
    expect(selection).toMatchObject({ event: "studioSelectionChanged", cellId: "cell-a", cellIds: ["cell-a"], pageId: "page-1" });
  });

  it("keeps publishing after a later model change", () => {
    const harness = createHarness();
    harness.handshake();
    expect(() => harness.publishSelectionChange()).not.toThrow();
    expect(() => harness.publishModelChange()).not.toThrow();
    expect(harness.posted.filter((message) => message.event === "studioHistoryState").length).toBeGreaterThan(0);
  });
});
