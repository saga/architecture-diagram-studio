import { describe, expect, it } from "vitest";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "./model/fixtures";
import { interpretIntent } from "./intent/applyIntent";
import { mxEdgeStyle, relationPaint } from "./design/styles";

describe("V2 semantic fixtures and intents", () => {
  it("keeps first-class diagram types limited to C4, flowchart and sequence", () => {
    expect(createC4Fixture().kind).toBe("c4");
    expect(createFlowFixture().kind).toBe("flowchart");
    expect(createSequenceFixture().kind).toBe("sequence");
  });

  it("changes line appearance without requiring geometry relayout", () => {
    const result = interpretIntent(createC4Fixture(), "把所有的线换成虚线");
    expect(result.changed).toBe(true);
    expect(result.requiresLayout).toBe(false);
    expect(result.document.relations.every((edge) => edge.dashed)).toBe(true);
  });

  it("reroutes geometry when curves are changed to polyline", () => {
    const document = createC4Fixture();
    document.layout.routing = "curved";
    document.relations = document.relations.map((edge) => ({ ...edge, routing: "curved", points: [{ x: 220, y: 100 }] }));
    const result = interpretIntent(document, "把曲线改成折线");
    expect(result.changed).toBe(true);
    expect(result.requiresLayout).toBe(true);
    expect(result.document.layout.routing).toBe("polyline");
    expect(result.document.relations.every((edge) => edge.points?.length === 0)).toBe(true);
  });

  it("models external placement as a semantic constraint", () => {
    const result = interpretIntent(createC4Fixture(), "把所有 external 放到右侧");
    expect(result.requiresLayout).toBe(true);
    expect(result.document.nodes.find((node) => node.role === "external")?.layoutHints?.preferredSide).toBe("RIGHT");
  });

  it("lets an explicit solid-line command override sequence return defaults", () => {
    const edge = createSequenceFixture().relations.find((relation) => relation.kind === "return")!;
    expect(relationPaint({ ...edge, dashed: false }).dash).toBe("");
    expect(mxEdgeStyle({ ...edge, dashed: false }, "polyline")).not.toContain("dashed=1");
  });
});