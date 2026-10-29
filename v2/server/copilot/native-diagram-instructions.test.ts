import { describe, expect, it } from "vitest";
import { NATIVE_DIAGRAM_CORE_INSTRUCTIONS } from "./native-diagram-instructions";

describe("native diagram always-on instructions", () => {
  it("uses the XML-first editing contract and does not instruct the model to execute scripts", () => {
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS.length).toBeLessThan(2800);
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("Native Draw.io XML is the only source of truth");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("server-side document-editing capability");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("current document revision/hash");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("Preserve unrelated cells");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("Never execute or generate JavaScript");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("automatic-layout capability");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("run_drawio_script");
  });
});
