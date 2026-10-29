import { describe, expect, it } from "vitest";
import { readDrawioAgentReference, selectDrawioReferenceSections } from "./drawio-agent-reference";

describe("on-demand Draw.io reference", () => {
  it("returns only the requested section", async () => {
    const content = await readDrawioAgentReference("shape_discovery");
    expect(content).toContain("jsShapeClasses.registered");
    expect(content).toContain("not exhaustive");
    expect(content).not.toContain("### Enumerate all cells");
  });
  it("includes C4 one-query style recipes in shape discovery and recipes references", async () => {
    const shapeDiscovery = await readDrawioAgentReference("shape_discovery");
    const recipes = await readDrawioAgentReference("recipes");
    expect(shapeDiscovery).toContain("C4 shape recipes");
    expect(shapeDiscovery).toContain("shape=mxgraph.c4.person2");
    expect(shapeDiscovery).toContain("C4 Software System");
    expect(shapeDiscovery).toContain("C4 Container");
    expect(recipes).toContain("C4 shape recipes");
    expect(recipes).toContain("fontColor=#ffffff");
  });
  it("bounds full-reference responses", () => {
    const huge = "# Reference\n" + "x".repeat(20_000);
    expect(selectDrawioReferenceSections(huge, "all").length).toBeLessThanOrEqual(18_100);
  });
  it("bounds requested sections and the composed overview as well as the full reference", () => {
    const hugeSection = "x".repeat(20_000);
    const markdown = [
      "## API ownership", hugeSection,
      "## Contract and trust boundaries", hugeSection,
      "## Shape discovery", hugeSection,
      "## Validation and postconditions", hugeSection,
      "## Recipes", hugeSection,
    ].join("\n");
    for (const topic of ["api_ownership", "shape_discovery", "postconditions", "recipes", "overview", "all"] as const) {
      expect(selectDrawioReferenceSections(markdown, topic).length, topic).toBeLessThanOrEqual(18_100);
    }
  });

});
