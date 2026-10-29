import { describe, expect, it } from "vitest";
import { diagnoseNativeLayoutOptions, type NativeLayoutAdapterDescriptor } from "./native-layout-adapter-contract";

const descriptor: NativeLayoutAdapterDescriptor = {
  engine: "dagre",
  algorithms: ["layered"],
  capabilities: ["hierarchy"],
  supportedDirections: ["RIGHT", "LEFT", "DOWN", "UP"],
  supportedEdgeRouting: ["ORTHOGONAL", "POLYLINE"],
  unsupportedOptions: ["randomSeed", "iterations"]
};

describe("native layout adapter contract", () => {
  it("reports unsupported algorithms, routing and options instead of implying they were applied", () => {
    const diagnostics = diagnoseNativeLayoutOptions(descriptor, {
      algorithm: "layered", direction: "RIGHT", edgeRouting: "SPLINES",
      options: { randomSeed: 1, nodeSpacing: 64 }
    });
    expect(diagnostics.applied).toContain("algorithm:layered");
    expect(diagnostics.unsupported).toEqual(expect.arrayContaining(["edgeRouting:SPLINES", "randomSeed"]));
    expect(diagnostics.applied).toContain("nodeSpacing");
    expect(diagnostics.notes).toHaveLength(1);
  });
});
