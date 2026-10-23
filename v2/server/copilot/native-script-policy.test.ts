import { describe, expect, it } from "vitest";
import { getNativeScriptPolicyViolation } from "./native-script-policy";

describe("native Draw.io script policy", () => {
  it("rejects stencil registry probing as a universal shape lookup", () => {
    expect(getNativeScriptPolicyViolation('var shape = mxStencilRegistry.getStencil("mxgraph.c4.person2");'))
      .toContain("Do not use mxStencilRegistry.getStencil()");
  });
  it("rejects scripted C4 recreation in favour of the typed postcondition gate", () => {
    expect(getNativeScriptPolicyViolation('graph.insertVertex(parent, null, "%c4Name%", 0, 0, 200, 180, "shape=mxgraph.c4.person2;");'))
      .toContain("typed set_c4_type");
    expect(getNativeScriptPolicyViolation("return { value: model.getCell('db').value };")).toBeNull();
  });
});
