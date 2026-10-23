import { describe, expect, it } from "vitest";
import {
  DRAWIO_RUNTIME_BRIDGE_VERSION,
  PINNED_DRAWIO_VERSION,
  normalizeDrawioRuntimeInspection,
  RUNTIME_INSPECTION_LIMITS
} from "./drawio-runtime-contract";

const revision = "a".repeat(64);

function inspection(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    bridgeVersion: DRAWIO_RUNTIME_BRIDGE_VERSION,
    drawioVersion: PINNED_DRAWIO_VERSION,
    documentRevision: revision,
    pageId: "page-1",
    capabilities: { graph: ["getModel", "insertVertex"], model: ["getRoot"] },
    counts: { cells: 1, vertices: 1, edges: 0 },
    cells: [{
      id: "svc", parentId: "1", kind: "vertex", label: "Service", style: "rounded=1;",
      sourceId: null, targetId: null, connectable: true, visible: true, collapsed: false,
      childCount: 0, geometry: { x: 10, y: 20, width: 100, height: 60, relative: false, points: [] }
    }],
    renderedEdges: [],
    truncated: false,
    ...overrides
  };
}

describe("Draw.io runtime inspection contract", () => {
  it("accepts matching observations and normalizes missing capability groups", () => {
    const result = normalizeDrawioRuntimeInspection(inspection(), { documentRevision: revision, pageId: "page-1" });
    expect(result).not.toBeNull();
    expect(result?.capabilities.graph).toEqual(["getModel", "insertVertex"]);
    expect(result?.capabilities.view).toEqual([]);
    expect(result?.cells[0]?.geometry).toMatchObject({ x: 10, y: 20, width: 100, height: 60 });
  });

  it("rejects observations from a stale document, page, bridge, or Draw.io version", () => {
    expect(normalizeDrawioRuntimeInspection(inspection(), { documentRevision: "b".repeat(64), pageId: "page-1" })).toBeNull();
    expect(normalizeDrawioRuntimeInspection(inspection(), { documentRevision: revision, pageId: "page-2" })).toBeNull();
    expect(normalizeDrawioRuntimeInspection(inspection({ bridgeVersion: "unknown" }))).toBeNull();
    expect(normalizeDrawioRuntimeInspection(inspection({ drawioVersion: "v32.2.1" }))).toBeNull();
  });

  it("bounds the cell, edge, and method payload before it reaches the model prompt", () => {
    const manyMethods = Array.from({ length: RUNTIME_INSPECTION_LIMITS.methodsPerObject + 20 }, (_, i) => "method" + i);
    const manyCells = Array.from({ length: RUNTIME_INSPECTION_LIMITS.cells + 20 }, (_, i) => ({
      id: "cell-" + i, kind: "cell", label: "x".repeat(1000), style: "s".repeat(5000)
    }));
    const manyEdges = Array.from({ length: RUNTIME_INSPECTION_LIMITS.renderedEdges + 20 }, (_, i) => ({
      id: "edge-" + i, stateAvailable: true, absolutePoints: [], collinear: null
    }));
    const result = normalizeDrawioRuntimeInspection(inspection({
      capabilities: { graph: manyMethods },
      cells: manyCells,
      renderedEdges: manyEdges,
      truncated: false
    }));
    expect(result?.capabilities.graph).toHaveLength(RUNTIME_INSPECTION_LIMITS.methodsPerObject);
    expect(result?.cells).toHaveLength(RUNTIME_INSPECTION_LIMITS.cells);
    expect(result?.renderedEdges).toHaveLength(RUNTIME_INSPECTION_LIMITS.renderedEdges);
    expect(result?.cells[0]?.label).toHaveLength(250);
    expect(result?.cells[0]?.style).toHaveLength(1200);
    expect(result?.truncated).toBe(true);
  });

  it("drops invalid methods and non-finite rendered coordinates", () => {
    const result = normalizeDrawioRuntimeInspection(inspection({
      capabilities: { graph: ["getModel", "not a method", 3] },
      renderedEdges: [{ id: "edge", stateAvailable: true, absolutePoints: [{ x: 1, y: 2 }, { x: Number.NaN, y: 4 }], collinear: null }]
    }));
    expect(result?.capabilities.graph).toEqual(["getModel"]);
    expect(result?.renderedEdges[0]?.absolutePoints).toEqual([{ x: 1, y: 2 }]);
  });
});
