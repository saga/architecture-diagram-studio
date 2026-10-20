import { describe, expect, it } from "vitest";
import { createC4Fixture } from "../model/fixtures";
import { evaluateLayout } from "./quality";

describe("layout quality hard constraints", () => {
  it("reports diagonal links that cut through a third node", () => {
    const document = createC4Fixture();
    document.nodes = [
      { ...document.nodes[0], id: "source", name: "Source", x: 20, y: 20, width: 100, height: 60 },
      { ...document.nodes[1], id: "target", name: "Target", x: 300, y: 200, width: 100, height: 60 },
      { ...document.nodes[2], id: "blocker", name: "Blocker", x: 160, y: 100, width: 100, height: 80 }
    ];
    document.boundaries = [];
    document.relations = [{
      id: "diagonal",
      source: "source",
      target: "target",
      label: "crosses",
      kind: "flow",
      routing: "polyline",
      points: []
    }];
    const report = evaluateLayout(document);
    expect(report.metrics.nodeOverlaps).toBe(0);
    expect(report.metrics.edgeNodeIntersections).toBeGreaterThan(0);
    expect(report.errors.some((issue) => issue.code === "edge-through-node")).toBe(true);
  });

  it("rejects relations to nodes that do not exist", () => {
    const document = createC4Fixture();
    document.relations = [{
      id: "broken",
      source: "missing-source",
      target: "missing-target",
      label: "",
      kind: "flow"
    }];
    const report = evaluateLayout(document);
    expect(report.errors.some((issue) => issue.code === "invalid-relation")).toBe(true);
  });
});