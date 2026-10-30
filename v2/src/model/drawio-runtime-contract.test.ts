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
    liveShapeClasses: ["mxgraph.c4.person2", "mxgraph.flowchart.start", "constructor", "invalid name"],
    liveShapeClassesTruncated: false,
    ...overrides
  };
}

describe("Draw.io runtime inspection contract", () => {
  it("accepts a matching observation and keeps only identity plus the shape registry", () => {
    const result = normalizeDrawioRuntimeInspection(inspection(), { documentRevision: revision, pageId: "page-1" });
    expect(result).toEqual({
      schemaVersion: 1,
      bridgeVersion: DRAWIO_RUNTIME_BRIDGE_VERSION,
      drawioVersion: PINNED_DRAWIO_VERSION,
      documentRevision: revision,
      pageId: "page-1",
      liveShapeClasses: ["mxgraph.c4.person2", "mxgraph.flowchart.start"],
      liveShapeClassesTruncated: false
    });
  });

  it("drops the retired cell, capability and rendered-edge payloads", () => {
    const result = normalizeDrawioRuntimeInspection(inspection({
      cells: [{ id: "svc", kind: "vertex", label: "Service" }],
      renderedEdges: [{ id: "e1", stateAvailable: true, absolutePoints: [{ x: 1, y: 2 }] }],
      capabilities: { graph: ["insertVertex"], model: [], view: [] },
      capabilityManifest: { required: {}, missing: {}, jsShapeClasses: { requested: [], registered: {} } },
      counts: { cells: 1, vertices: 1, edges: 0 },
      truncated: true
    }));
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("cells");
    expect(result).not.toHaveProperty("renderedEdges");
    expect(result).not.toHaveProperty("capabilities");
    expect(result).not.toHaveProperty("capabilityManifest");
    expect(result).not.toHaveProperty("truncated");
  });

  it("discovers the active page when the caller has not resolved a page ID yet", () => {
    const result = normalizeDrawioRuntimeInspection(inspection({ pageId: "live-page-2" }), {
      documentRevision: revision,
      pageId: null
    });
    expect(result?.pageId).toBe("live-page-2");
  });

  it("bounds the registry and reports truncation inferred from the payload", () => {
    const classes = Array.from(
      { length: RUNTIME_INSPECTION_LIMITS.liveShapeClasses + 1 },
      (_, index) => "mxgraph.test.shape" + index
    );
    const inferred = normalizeDrawioRuntimeInspection(inspection({ liveShapeClasses: classes }));
    expect(inferred?.liveShapeClasses).toHaveLength(RUNTIME_INSPECTION_LIMITS.liveShapeClasses);
    expect(inferred?.liveShapeClassesTruncated).toBe(true);

    const explicit = normalizeDrawioRuntimeInspection(inspection({
      liveShapeClasses: ["mxgraph.c4.person2"],
      liveShapeClassesTruncated: true
    }));
    expect(explicit?.liveShapeClassesTruncated).toBe(true);
  });

  it("rejects observations from a stale document, page, bridge, or Draw.io version", () => {
    expect(normalizeDrawioRuntimeInspection(inspection(), { documentRevision: "b".repeat(64), pageId: "page-1" })).toBeNull();
    expect(normalizeDrawioRuntimeInspection(inspection(), { documentRevision: revision, pageId: "page-2" })).toBeNull();
    expect(normalizeDrawioRuntimeInspection(inspection({ bridgeVersion: "studio-native-runtime/4" }))).toBeNull();
    expect(normalizeDrawioRuntimeInspection(inspection({ drawioVersion: "v32.2.1" }))).toBeNull();
  });
});
