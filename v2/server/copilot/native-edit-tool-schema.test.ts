import { describe, expect, it } from "vitest";
import { NATIVE_EDIT_OPERATION_ITEM_SCHEMA } from "./native-edit-tool-schema";

type OperationBranch = {
  properties: {
    op: { enum: readonly string[] };
    target?: unknown;
    newLabel?: { type?: string; minLength?: number; maxLength?: number };
    key?: { type?: string; enum?: readonly string[]; default?: string };
    color?: { type?: string; pattern?: string };
    engine?: { enum?: readonly string[]; default?: string };
    iterations?: { type?: string; minimum?: number; maximum?: number; default?: number };
    kind?: { enum?: readonly string[] };
    script?: { type?: string; minLength?: number; maxLength?: number };
    summary?: { type?: string; minLength?: number; maxLength?: number };
  };
  required: readonly string[];
  additionalProperties: boolean;
};

const branches = NATIVE_EDIT_OPERATION_ITEM_SCHEMA.anyOf as unknown as readonly OperationBranch[];

describe("native edit tool parameter schema", () => {
  it("requires newLabel on add_node_after instead of leaving the field optional", () => {
    const addNode = branches.find((branch) => branch.properties.op.enum.includes("add_node_after"));
    expect(addNode).toBeTruthy();
    expect(addNode?.required).toEqual(["op", "target", "newLabel"]);
    expect(addNode?.properties.newLabel).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(addNode?.additionalProperties).toBe(false);
    const addBelow = branches.find((branch) => branch.properties.op.enum.includes("add_node_below"));
    expect(addBelow?.required).toEqual(["op", "target", "newLabel"]);
    expect(addBelow?.properties.target).toMatchObject({ description: expect.stringContaining("beneath") });
    expect(addBelow?.additionalProperties).toBe(false);
  });

  it("documents vertex-only semantics for move and resize", () => {
    const move = branches.find((branch) => branch.properties.op.enum.includes("move"));
    const resize = branches.find((branch) => branch.properties.op.enum.includes("resize"));
    expect(move?.properties.target).toMatchObject({ description: expect.stringContaining("vertex") });
    expect(resize?.properties.target).toMatchObject({ description: expect.stringContaining("vertex") });
  });

  it("makes operation-specific fields mandatory for every edit type", () => {
    const requiredByOperation: Record<string, string[]> = {
      select: ["op", "target"],
      set_label: ["op", "target", "label"],
      set_style: ["op", "target", "key", "color"],
      move: ["op", "target", "dx", "dy"],
      resize: ["op", "target", "width", "height"],
      delete: ["op", "target"],
      add_node_after: ["op", "target", "newLabel"],
      add_node_below: ["op", "target", "newLabel"],
      auto_layout: ["op", "target"]
    };

    for (const [op, required] of Object.entries(requiredByOperation)) {
      const branch = branches.find((candidate) => candidate.properties.op.enum.includes(op));
      expect(branch, "schema branch for " + op).toBeTruthy();
      expect(branch?.required).toEqual(required);
      expect(branch?.additionalProperties).toBe(false);
    }
    const styleBranch = branches.find((candidate) => candidate.properties.op.enum.includes("set_style"));
    expect(styleBranch?.properties.key).toMatchObject({ enum: ["fillColor", "strokeColor", "fontColor"] });
    expect(styleBranch?.required).toContain("key");
    expect(styleBranch?.properties.color?.pattern).toContain("#");
    expect(styleBranch?.properties.color?.pattern).not.toContain("red");
    expect(branches.some((candidate) => candidate.properties.op.enum.includes("run_drawio_script"))).toBe(false);
    const layoutBranch = branches.find((candidate) => candidate.properties.op.enum.includes("auto_layout"));
    expect(layoutBranch?.properties.engine).toMatchObject({ enum: ["elk", "dagre"], default: "elk" });
    expect(layoutBranch?.properties.iterations).toMatchObject({ type: "integer", minimum: 20, maximum: 3000, default: 300 });
  });
});


describe("AI-first script tool separation", () => {
  it("does not advertise raw script execution as a typed edit operation", () => {
    expect(branches.flatMap((branch) => branch.properties.op.enum)).not.toContain("run_drawio_script");
  });
});
