import { describe, expect, it } from "vitest";
import { readDrawioAgentReference, selectDrawioReferenceSections } from "./drawio-agent-reference";

describe("on-demand Draw.io reference", () => {
  it("returns only the requested section", async () => {
    const content = await readDrawioAgentReference("shape_discovery");
    expect(content).toContain("liveShapeClasses");
    expect(content).toContain("not exhaustive");
    expect(content).not.toContain("### Enumerate all cells");
  });
  it("does not expose retired script recipes through on-demand references", async () => {
    const shapeDiscovery = await readDrawioAgentReference("shape_discovery");
    const recipes = await readDrawioAgentReference("recipes");
    expect(shapeDiscovery).toContain("not exhaustive");
    expect(recipes).toContain("Native XML patch recipes");
    expect(recipes).toContain("insert-cell-xml");
    expect(recipes).not.toContain("run_drawio_script");
    expect(recipes).not.toContain("new Function");
  });
  it("serves only XML-first guidance for every reference topic", () => {
    const markdown = [
      "## API ownership", "legacy run_drawio_script guidance",
      "## Shape discovery", "Catalogue misses are not exhaustive.",
      "### C4 shape recipes", "new Function legacy recipe",
      "## Validation and postconditions", "script execution legacy"
    ].join("\n");
    for (const topic of ["overview", "api_ownership", "shape_discovery", "postconditions", "recipes", "all"] as const) {
      const content = selectDrawioReferenceSections(markdown, topic);
      expect(content, topic).not.toContain("run_drawio_script");
      expect(content, topic).not.toContain("new Function");
    }
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
