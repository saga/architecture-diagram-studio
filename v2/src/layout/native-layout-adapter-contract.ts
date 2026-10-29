import type { NativeAutoLayoutAlgorithm, NativeAutoLayoutDirection, NativeAutoLayoutEdgeRouting, NativeAutoLayoutEngine } from "./native-layout";

export type NativeLayoutCapability = "hierarchy" | "compound-nodes" | "edge-routing" | "deterministic-seed" | "preserve-fixed-nodes";

export interface NativeLayoutAdapterDescriptor {
  engine: NativeAutoLayoutEngine;
  algorithms: readonly NativeAutoLayoutAlgorithm[];
  capabilities: readonly NativeLayoutCapability[];
  supportedDirections: readonly NativeAutoLayoutDirection[];
  supportedEdgeRouting: readonly NativeAutoLayoutEdgeRouting[];
  /** Options not supported by an adapter must be reported, never silently implied. */
  unsupportedOptions: readonly ("randomSeed" | "iterations" | "margin" | "nodeSpacing" | "layerSpacing")[];
  unsupportedOptionsByAlgorithm?: Partial<Record<NativeAutoLayoutAlgorithm, readonly ("randomSeed" | "iterations" | "margin" | "nodeSpacing" | "layerSpacing")[]>>;
}

export interface NativeLayoutOptionDiagnostics {
  applied: string[];
  unsupported: string[];
  notes: string[];
}

export function diagnoseNativeLayoutOptions(
  descriptor: NativeLayoutAdapterDescriptor,
  input: {
    algorithm: NativeAutoLayoutAlgorithm;
    direction: NativeAutoLayoutDirection;
    edgeRouting: NativeAutoLayoutEdgeRouting;
    options?: Partial<Record<"randomSeed" | "iterations" | "margin" | "nodeSpacing" | "layerSpacing", number>>;
  }
): NativeLayoutOptionDiagnostics {
  const unsupported: string[] = [];
  const applied: string[] = [];
  const notes: string[] = [];
  if (!descriptor.algorithms.includes(input.algorithm)) unsupported.push("algorithm:" + input.algorithm);
  else applied.push("algorithm:" + input.algorithm);
  if (!descriptor.supportedDirections.includes(input.direction)) unsupported.push("direction:" + input.direction);
  else applied.push("direction:" + input.direction);
  if (!descriptor.supportedEdgeRouting.includes(input.edgeRouting)) {
    unsupported.push("edgeRouting:" + input.edgeRouting);
  } else applied.push("edgeRouting:" + input.edgeRouting);
  const unsupportedForAlgorithm = descriptor.unsupportedOptionsByAlgorithm?.[input.algorithm] ?? descriptor.unsupportedOptions;
  for (const [key, value] of Object.entries(input.options ?? {})) {
    if (value === undefined) continue;
    if (unsupportedForAlgorithm.includes(key as NativeLayoutAdapterDescriptor["unsupportedOptions"][number])) {
      unsupported.push(key);
    } else applied.push(key);
  }
  if (unsupported.length) notes.push("The selected engine does not support every requested option; review unsupported options before applying the layout.");
  return { applied, unsupported, notes };
}
