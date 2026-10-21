import { describe, expect, it } from "vitest";
import { createC4Fixture } from "../model/fixtures";
import { countPortSpacingViolations, routeRelations } from "./routing";

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

  it("does not invent attachment ports for sequence messages", () => {
    const document = createC4Fixture();
    document.kind = "sequence";
    document.relations = [];
    expect(countPortSpacingViolations(document)).toBe(0);
  });
});
