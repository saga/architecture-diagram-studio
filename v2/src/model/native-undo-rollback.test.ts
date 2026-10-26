import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const pluginSource = readFileSync(new URL("../../plugins/studio-selection-plugin.js", import.meta.url), "utf8");

type NativeCell = {
  id: string;
  style: string;
  vertex?: boolean;
  edge?: boolean;
  parent: NativeCell | null;
  children: NativeCell[];
  getIndex(child: NativeCell): number;
};

function createCell(id: string, style = "", kind: "vertex" | "edge" | "cell" = "cell"): NativeCell {
  return {
    id, style, vertex: kind === "vertex", edge: kind === "edge", parent: null, children: [],
    getIndex(child) { return this.children.indexOf(child); }
  };
}

function createBridge(options: { failFirstStyleWriteTo?: string } = {}) {
  let messageListener: ((event: { source: unknown; origin: string; data: string }) => void) | null = null;
  let failStyleOnce = options.failFirstStyleWriteTo ?? null;
  const postedMessages: Array<Record<string, unknown>> = [];
  const parent = {
    postMessage(data: string | Record<string, unknown>) {
      postedMessages.push(typeof data === "string" ? JSON.parse(data) as Record<string, unknown> : data);
    }
  };

  const root = createCell("0");
  const layer = createCell("1");
  const a = createCell("a", "fillColor=#FFFFFF;strokeColor=#000000;", "vertex");
  const b = createCell("b", "fillColor=#FFFFFF;strokeColor=#000000;", "vertex");
  root.children.push(layer);
  layer.parent = root;
  layer.children.push(a, b);
  a.parent = layer;
  b.parent = layer;
  const cells = new Map<string, NativeCell>();
  [root, layer, a, b].forEach((cell) => cells.set(cell.id, cell));

  const undoEntries: unknown[] = [{ id: "pre-existing-undo" }];
  const redoEntries: unknown[] = [{ id: "pre-existing-redo" }];
  const listeners = new Map<string, Array<() => void>>();
  const undoManager = {
    addListener(event: string, listener: () => void) {
      const values = listeners.get(event) ?? [];
      values.push(listener);
      listeners.set(event, values);
    },
    removeListener(eventOrListener: string | (() => void), possibleListener?: () => void) {
      // The production bridge passes a listener object to removeListener for each manager event.
      const eventName = typeof eventOrListener === "string" ? eventOrListener : "";
      const listener = typeof eventOrListener === "function" ? eventOrListener : possibleListener;
      if (!listener) return;
      const values = listeners.get(eventName) ?? [];
      listeners.set(eventName, values.filter((value) => value !== listener));
    },
    canUndo: () => undoEntries.length > 0,
    canRedo: () => redoEntries.length > 0,
    undo() {},
    redo() {},
    undoableEditHappened(edit: unknown) {
      undoEntries.push(edit);
      redoEntries.length = 0;
      for (const listener of listeners.get("add") ?? []) listener();
    }
  };

  let updateLevel = 0;
  const model: Record<string, any> = {
    currentEdit: { changes: [] as unknown[] },
    getRoot: () => root,
    getChildCount: (cell: NativeCell) => cell.children.length,
    getChildAt: (cell: NativeCell, index: number) => cell.children[index],
    getCell: (id: string) => cells.get(id) ?? null,
    getStyle: (cell: NativeCell) => cell.style,
    addListener() {},
    removeListener() {},
    beginUpdate() { updateLevel += 1; },
    endUpdate() {
      updateLevel -= 1;
      if (updateLevel !== 0) return;
      const edit = this.currentEdit;
      if (edit.changes.length > 0) undoManager.undoableEditHappened(edit);
      this.currentEdit = { changes: [] as unknown[] };
    },
    setStyle(cell: NativeCell, nextStyle: string) {
      if (failStyleOnce === cell.id) {
        failStyleOnce = null;
        throw new Error("simulated native style mutation failure");
      }
      const before = cell.style;
      if (before === nextStyle) return;
      cell.style = nextStyle;
      if (updateLevel > 0) this.currentEdit.changes.push({ cellId: cell.id, before, after: nextStyle });
    },
    setValue(cell: NativeCell, value: unknown) { (cell as any).value = value; },
    setGeometry() {},
    setTerminal() {},
    setVisible() {},
    setCollapsed() {},
    add(parentCell: NativeCell, cell: NativeCell, index: number) {
      if (cell.parent) {
        const old = cell.parent.children.indexOf(cell);
        if (old >= 0) cell.parent.children.splice(old, 1);
      }
      parentCell.children.splice(index, 0, cell);
      cell.parent = parentCell;
      cells.set(cell.id, cell);
    },
    remove(cell: NativeCell) {
      if (cell.parent) {
        const index = cell.parent.children.indexOf(cell);
        if (index >= 0) cell.parent.children.splice(index, 1);
      }
      cells.delete(cell.id);
      cell.parent = null;
    }
  };

  const selectionModel = { addListener() {} };
  const graph = {
    getModel: () => model,
    getSelectionModel: () => selectionModel,
    getSelectionCells: () => [],
    refresh() {},
    convertValueToString: (cell: NativeCell) => (cell as any).value ?? ""
  };
  const ui = {
    editor: { graph, undoManager, setModified() {} },
    currentPage: { id: "p1" },
    addListener() {}
  };
  const windowObject = {
    Draw: { loadPlugin(callback: (value: typeof ui) => void) { callback(ui); } },
    parent,
    addEventListener(eventName: string, listener: typeof messageListener) {
      if (eventName === "message") messageListener = listener;
    },
    setInterval: () => 1,
    clearInterval() {},
    mxCellRenderer: { defaultShapes: {} }
  };
  runInNewContext(pluginSource, { window: windowObject, console });

  function send(request: Record<string, unknown>) {
    if (!messageListener) throw new Error("Draw.io plugin did not install its message handler");
    messageListener({ source: parent, origin: "http://studio.test", data: JSON.stringify(request) });
  }
  send({ event: "studioDrawioWelcome" });

  return {
    send,
    a,
    b,
    undoEntries,
    redoEntries,
    postedMessages,
    latest(eventName: string, requestId: string) {
      return [...postedMessages].reverse().find((message) =>
        message.event === eventName && String(message.requestId) === requestId
      );
    }
  };
}

const themePlan = {
  theme: "ocean-depths",
  documentRevision: "a".repeat(64),
  pageId: "p1",
  expectedPageCellIds: ["0", "1", "a", "b"],
  changes: [
    { cellId: "a", kind: "vertex", expectedStyle: "fillColor=#FFFFFF;strokeColor=#000000;", style: "fillColor=#E0F2FE;strokeColor=#0369A1;fontColor=#17324D;studioColorRole=category-1;" },
    { cellId: "b", kind: "vertex", expectedStyle: "fillColor=#FFFFFF;strokeColor=#000000;", style: "fillColor=#E0F2FE;strokeColor=#0369A1;fontColor=#17324D;studioColorRole=category-1;" }
  ]
};

describe("native Draw.io history rollback", () => {
  it("does not add an Undo entry or clear Redo when a failed palette transaction is fully rolled back", () => {
    const bridge = createBridge({ failFirstStyleWriteTo: "b" });
    const priorUndo = [...bridge.undoEntries];
    const priorRedo = [...bridge.redoEntries];

    bridge.send({ event: "studioNativePaletteRequest", requestId: "palette-failure", plan: themePlan });

    expect(bridge.latest("studioNativePaletteResult", "palette-failure")).toMatchObject({
      success: false, rollbackConfirmed: true
    });
    expect(bridge.a.style).toBe("fillColor=#FFFFFF;strokeColor=#000000;");
    expect(bridge.b.style).toBe("fillColor=#FFFFFF;strokeColor=#000000;");
    expect(bridge.undoEntries).toEqual(priorUndo);
    expect(bridge.redoEntries).toEqual(priorRedo);
  });

  it("preserves the existing Redo stack when a failed atomic batch restores all cell changes", () => {
    const bridge = createBridge();
    const priorUndo = [...bridge.undoEntries];
    const priorRedo = [...bridge.redoEntries];

    bridge.send({
      event: "studioPropertyEditRequest",
      requestId: 41,
      cellId: "__batch__",
      pageId: "p1",
      path: "cell:batch",
      value: JSON.stringify([
        { cellId: "a", path: "style", value: "fillColor=#FCE7F3;strokeColor=#BE185D;" },
        { cellId: "missing-cell", path: "style", value: "fillColor=#FCE7F3;" }
      ])
    });

    expect(bridge.latest("studioPropertyEditResult", "41")).toMatchObject({
      success: false, batchRolledBack: true
    });
    expect(bridge.a.style).toBe("fillColor=#FFFFFF;strokeColor=#000000;");
    expect(bridge.b.style).toBe("fillColor=#FFFFFF;strokeColor=#000000;");
    expect(bridge.undoEntries).toEqual(priorUndo);
    expect(bridge.redoEntries).toEqual(priorRedo);
  });
});
