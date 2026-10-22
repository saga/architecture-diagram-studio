import { describe, expect, it } from "vitest";
import { NATIVE_EDIT_OPERATION_ITEM_SCHEMA } from "./native-edit-tool-schema";

type OperationBranch = {
  properties: {
    op: { enum: readonly string[] };
    target?: unknown;
    newLabel?: { type?: string; minLength?: number; maxLength?: number };
  };
  required: readonly string[];
  additionalProperties: boolean;
};

const branches = NATIVE_EDIT_OPERATION_ITEM_SCHEMA.anyOf as readonly OperationBranch[];

describe("native edit tool parameter schema", () => {
  it("requires newLabel on add_node_after instead of leaving the field optional", () => {
    const addNode = branches.find((branch) => branch.properties.op.enum.includes("add_node_after"));
    expect(addNode).toBeTruthy();
    expect(addNode?.required).toEqual(["op", "target", "newLabel"]);
    expect(addNode?.properties.newLabel).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(addNode?.additionalProperties).toBe(false);
  });

  it("makes operation-specific fields mandatory for every edit type", () => {
    const requiredByOperation: Record<string, string[]> = {
      select: ["op", "target"],
      set_label: ["op", "target", "label"],
      set_style: ["op", "target", "color"],
      move: ["op", "target", "dx", "dy"],
      resize: ["op", "target", "width", "height"],
      delete: ["op", "target"],
      add_node_after: ["op", "target", "newLabel"]
    };

    for (const [op, required] of Object.entries(requiredByOperation)) {
      const branch = branches.find((candidate) => candidate.properties.op.enum.includes(op));
      expect(branch, "schema branch for " + op).toBeTruthy();
      expect(branch?.required).toEqual(required);
      expect(branch?.additionalProperties).toBe(false);
    const styleBranch = branches.find((candidate) => candidate.properties.op.enum.includes("set_style"));
    expect(styleBranch?.properties.key).toMatchObject({ enum: ["fillColor", "strokeColor", "fontColor"], default: "fillColor" });
    }
  });
});
