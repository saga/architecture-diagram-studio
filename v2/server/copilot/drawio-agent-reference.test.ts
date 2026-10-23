import { describe, expect, it } from "vitest";
import { readDrawioAgentReference, selectDrawioReferenceSections } from "./drawio-agent-reference";

describe("on-demand Draw.io reference", () => {
  it("returns only the requested section", async () => {
    const content = await readDrawioAgentReference("shape_discovery");
    expect(content).toContain("jsShapeClasses.registered");
    expect(content).toContain("not exhaustive");
    expect(content).not.toContain("### Enumerate all cells");
  });
  it("bounds full-reference responses", () => {
    const huge = "# Reference\n" + "x".repeat(20_000);
    expect(selectDrawioReferenceSections(huge, "all").length).toBeLessThanOrEqual(18_100);
  });
});
