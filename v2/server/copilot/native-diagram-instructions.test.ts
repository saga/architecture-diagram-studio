import { describe, expect, it } from "vitest";
import { NATIVE_DIAGRAM_CORE_INSTRUCTIONS } from "./native-diagram-instructions";

describe("native diagram always-on instructions", () => {
  it("keeps rare runtime recipes out of the permanent prompt", () => {
    // The budget covers always-on correctness rules (target resolution, evidence budget); API
    // recipes still belong in the on-demand reference.
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS.length).toBeLessThan(2800);
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("Never silently replace the original shape");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("set_c4_type");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("search_drawio_shapes");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("get_drawio_reference");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("serialized resulting XML");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("mxCell has no getSource/getTarget");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("style must be a non-empty key/value object");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).not.toContain("curveGeometry");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("model.getChildCount counts direct children only");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("one xmlAssertion per created/changed cell");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("fail edits changing undeclared cells");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("graph.convertValueToString(cell)");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("UserObject DOM Element");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("independently of postconditions");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("typed set_label; that fails closed");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("diagram.cells");
    expect(NATIVE_DIAGRAM_CORE_INSTRUCTIONS).toContain("no reference lookup");
  });
});
