import { describe, expect, it } from "vitest";
import { NATIVE_EDIT_OPERATION_ITEM_SCHEMA } from "./native-edit-tool-schema";

type OperationBranch = {
  properties: {
    op: { enum: readonly string[] };
    target?: unknown;
    newLabel?: { type?: string; minLength?: number; maxLength?: number };
    key?: { type?: string; enum?: readonly string[]; default?: string };
    engine?: { enum?: readonly string[]; default?: string };
    iterations?: { type?: string; minimum?: number; maximum?: number; default?: number };
    kind?: { enum?: readonly string[] };
    script?: { type?: string; minLength?: number; maxLength?: number };
    summary?: { type?: string; minLength?: number; maxLength?: number };
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
      set_style: ["op", "target", "color"],
      run_drawio_script: ["op", "target", "summary", "script"],
      move: ["op", "target", "dx", "dy"],
      resize: ["op", "target", "width", "height"],
      delete: ["op", "target"],
      add_node_after: ["op", "target", "newLabel"],
      add_node_below: ["op", "target", "newLabel"],
      set_c4_type: ["op", "target", "kind"],
      auto_layout: ["op", "target"]
    };

    for (const [op, required] of Object.entries(requiredByOperation)) {
      const branch = branches.find((candidate) => candidate.properties.op.enum.includes(op));
      expect(branch, "schema branch for " + op).toBeTruthy();
      expect(branch?.required).toEqual(required);
      expect(branch?.additionalProperties).toBe(false);
    }
    const styleBranch = branches.find((candidate) => candidate.properties.op.enum.includes("set_style"));
    expect(styleBranch?.properties.key).toMatchObject({ enum: ["fillColor", "strokeColor", "fontColor"], default: "fillColor" });
    const scriptBranch = branches.find((candidate) => candidate.properties.op.enum.includes("run_drawio_script"));
    expect(scriptBranch?.required).toEqual(["op", "target", "summary", "script"]);
    expect(scriptBranch?.properties.target).toMatchObject({ enum: ["active_page"] });
    expect(scriptBranch?.properties.script).toMatchObject({ type: "string", minLength: 1, maxLength: 50000 });
    const layoutBranch = branches.find((candidate) => candidate.properties.op.enum.includes("auto_layout"));
    expect(layoutBranch?.properties.engine).toMatchObject({ enum: ["elk", "dagre"], default: "elk" });
    expect(layoutBranch?.properties.iterations).toMatchObject({ type: "integer", minimum: 20, maximum: 3000, default: 300 });
    const c4Branch = branches.find((candidate) => candidate.properties.op.enum.includes("set_c4_type"));
    expect(c4Branch?.properties.kind).toMatchObject({ enum: ["person", "system", "external"] });
  });
});
