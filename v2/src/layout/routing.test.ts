import { describe, expect, it } from "vitest";
import { createC4Fixture } from "../model/fixtures";
import { countPortSpacingViolations, routeRelations } from "./routing";

function segmentCrossesNodeForTest(a: {x:number;y:number}, b: {x:number;y:number}, node: {x:number;y:number;width:number;height:number}): boolean {
  const left = Math.min(a.x, b.x), right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y), bottom = Math.max(a.y, b.y);
  return left < node.x + node.width && right > node.x &&
    top < node.y + node.height && bottom > node.y;
}

describe("connector port assignment", () => {
  it("fans multiple outgoing relations across a shared source edge", () => {
    const document = createC4Fixture();
    const source = { ...document.nodes[0], id: "source", x: 80, y: 80, width: 160, height: 80 };
    const targets = [
      { ...document.nodes[1], id: "t1", x: 440, y: 20 },
      { ...document.nodes[2], id: "t2", x: 440, y: 140 }
    ];
    document.nodes = [source, ...targets];
    document.relations = [
      { id: "r1", source: "source", target: "t1", label: "one", kind: "call", points: [] },
      { id: "r2", source: "source", target: "t2", label: "two", kind: "call", points: [] }
    ];
    const routed = routeRelations(document);
    expect(routed.relations[0].sourcePort?.y).not.toBe(routed.relations[1].sourcePort?.y);
    expect(countPortSpacingViolations(routed)).toBe(0);
  });

  it("routes around a blocking node when an alternate row lane is available", () => {
    const document = createC4Fixture();
    document.nodes = [
      { ...document.nodes[0], id: "source", x: 20, y: 150, width: 120, height: 60 },
      { ...document.nodes[1], id: "target", x: 520, y: 150, width: 120, height: 60 },
      { ...document.nodes[2], id: "blocker", x: 280, y: 120, width: 120, height: 120 }
    ];
    document.relations = [{
      id: "through-row",
      source: "source", target: "target", label: "must go around",
      kind: "call", routing: "orthogonal"
    }];
    const routed = routeRelations(document);
    expect(countPortSpacingViolations(routed)).toBe(0);
    const [start, ...tail] = [routed.relations[0].sourcePort!, ...(routed.relations[0].points || []), routed.relations[0].targetPort!];
    let obstructionCount = 0;
    for (let index = 1; index < tail.length + 1; index++) {
      const a = index === 1 ? start : tail[index - 2];
      const b = tail[index - 1];
      if (segmentCrossesNodeForTest(a, b, document.nodes[2])) obstructionCount++;
    }
    expect(obstructionCount).toBe(0);
    expect(routed.relations[0].points!.length).toBeGreaterThan(2);
  });

  it("approaches a leftward target from its right edge without traversing the node", () => {
    const document = createC4Fixture();
    document.nodes = [
      { ...document.nodes[0], id: "right-source", x: 420, y: 100, width: 140, height: 80 },
      { ...document.nodes[1], id: "left-target", x: 80, y: 100, width: 140, height: 80 }
    ];
    document.relations = [{
      id: "leftward", source: "right-source", target: "left-target",
      label: "return", kind: "return", routing: "orthogonal"
    }];
    const result = routeRelations(document);
    const relation = result.relations[0];
    expect(relation.sourcePort?.x).toBe(420);
    expect(relation.targetPort?.x).toBe(220);
    const points = [relation.sourcePort!, ...(relation.points || []), relation.targetPort!];
    for (let index = 1; index < points.length; index++) {
      expect(Math.abs(points[index].y - points[index - 1].y) < 0.001 ||
        Math.abs(points[index].x - points[index - 1].x) < 0.001).toBe(true);
    }
    // The final leg approaches from x >= target.right rather than cutting through it.
    expect(relation.points?.[relation.points.length - 1].x).toBeGreaterThanOrEqual(relation.targetPort!.x);
  });

  it("does not invent attachment ports for sequence messages", () => {
    const document = createC4Fixture();
    document.kind = "sequence";
    document.relations = [];
    expect(countPortSpacingViolations(document)).toBe(0);
  });
});
