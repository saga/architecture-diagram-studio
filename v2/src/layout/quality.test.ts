import { describe, expect, it } from "vitest";
import { createC4Fixture, createSequenceFixture } from "../model/fixtures";
import { evaluateLayout } from "./quality";
import { layoutDiagram } from "./layout";

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

  it("reports 4px alignment and CJK text overflow as diagnosable warnings", () => {
    const document = createC4Fixture();
    document.nodes[0] = { ...document.nodes[0], x: 23, y: 25, width: 60, height: 48, name: "非常长的中文架构节点名称" };
    const report = evaluateLayout(document);
    expect(report.metrics.gridAlignmentScore).toBeLessThan(1);
    expect(report.metrics.labelOverflowCount).toBeGreaterThan(0);
    expect(report.metrics.cjkWidthViolations).toBeGreaterThan(0);
    expect(report.warnings.some((issue) => issue.code === "cjk-text-overflow" && issue.nodeIds?.includes(document.nodes[0].id))).toBe(true);
  });

  it("uses the canonical sequence message coordinates when checking intersections", async () => {
    const document = await layoutDiagram(createSequenceFixture());
    const report = evaluateLayout(document);
    expect(report.metrics.edgeNodeIntersections).toBe(0);
    expect(report.metrics.connectorRoutingViolations).toBe(0);
  });

  it("advises about dense diagrams without turning style budgets into errors", () => {
    const document = createC4Fixture();
    document.nodes = Array.from({ length: 26 }, (_, index) => ({
      ...document.nodes[index % 3], id: "node-" + index, name: "Node " + index,
      x: 20 + index * 220, y: 60, width: 160, height: 70
    }));
    document.relations = [];
    const report = evaluateLayout(document);
    expect(report.warnings.some((issue) => issue.code === "complexity-nodes")).toBe(true);
    expect(report.errors.some((issue) => issue.code.startsWith("complexity-"))).toBe(false);
    expect(report.metrics.complexityWarnings).toBeGreaterThan(0);
  });
});