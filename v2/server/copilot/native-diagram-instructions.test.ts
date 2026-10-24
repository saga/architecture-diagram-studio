import { describe, expect, it } from "vitest";
import { NATIVE_DIAGRAM_CORE_INSTRUCTIONS } from "./native-diagram-instructions";

describe("native diagram always-on instructions", () => {
  it("keeps rare runtime recipes out of the permanent prompt", () => {
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS.length).toBeLessThan(2500);
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("create an additional native C4 element");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("set_c4_type");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("search_drawio_shapes");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("get_drawio_reference");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("serialized the resulting XML");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("curveGeometry");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("model.getChildCount(parent)");
  });
});
