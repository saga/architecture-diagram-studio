import { describe, expect, it } from "vitest";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "../model/fixtures";
import { layoutDiagram } from "./layout";
import { evaluateLayout } from "./quality";

async function expectNoNodeOverlap(factory: () => ReturnType<typeof createC4Fixture>) {
  const result = await layoutDiagram(factory());
  expect(evaluateLayout(result).metrics.nodeOverlaps).toBe(0);
}

describe("V2 diagram-specific layouts", () => {
  it("lays out C4 without overlapping nodes", async () => {
    await expectNoNodeOverlap(createC4Fixture);
  });
  it("lays out the main process flow without overlapping nodes", async () => {
    await expectNoNodeOverlap(createFlowFixture);
  });
  it("lays out sequence participants and keeps the message timeline ordered", async () => {
    const result = await layoutDiagram(createSequenceFixture());
    await expectNoNodeOverlap(createSequenceFixture);
    const orders = result.relations.map((edge) => edge.sequenceOrder ?? -1);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(result.nodes.map((node) => node.x)).toEqual([...result.nodes].map((node) => node.x).sort((a, b) => a - b));
    expect(result.nodes.every((node) => node.y === 54)).toBe(true);
  });
});