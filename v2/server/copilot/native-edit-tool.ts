import type { NativeEditOperation, ResolvedNativeEditOperation } from "../../src/model/native-edit-operations";

/** The partial projection the client sends with each request; only ids and labels are needed for targeting. */
export interface NativeEditContextNode {
  id?: unknown;
  name?: unknown;
}

export type NativeEditResolution =
  | { ok: true; operations: ResolvedNativeEditOperation[] }
  | { ok: false; error: string };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Resolves operation targets against the request's projected elements.
 *
 * The server never guesses: a target must be an exact cell id or a unique, case-insensitive
 * label. Ambiguous labels are rejected so the model has to disambiguate instead of the
 * browser silently editing the wrong cell.
 */
export function resolveNativeEditTargets(context: unknown, operations: NativeEditOperation[]): NativeEditResolution {
  const source = context && typeof context === "object" ? context as { nodes?: unknown } : {};
  const nodes = Array.isArray(source.nodes)
    ? source.nodes
      .filter((node): node is NativeEditContextNode => Boolean(node) && typeof node === "object")
      .map((node) => ({
        id: typeof node.id === "string" ? node.id : "",
        name: typeof node.name === "string" ? node.name.trim() : ""
      }))
      .filter((node) => node.id)
    : [];
  if (nodes.length === 0) return { ok: false, error: "The request did not include any diagram elements to target" };

  const resolved: ResolvedNativeEditOperation[] = [];
  for (const [index, operation] of operations.entries()) {
    const target = operation.target.trim();
    const byId = nodes.filter((node) => node.id === target);
    const matches = byId.length ? byId : nodes.filter((node) => node.name && normalize(node.name) === normalize(target));
    if (matches.length === 0) {
      return { ok: false, error: `Operation ${index + 1}: element “${target}” was not found among the ${nodes.length} projected elements. Use an exact id or an exact label from the supplied diagram context.` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `Operation ${index + 1}: label “${target}” is ambiguous (${matches.length} elements match). Use the exact cell id instead.` };
    }
    const node = matches[0];
    resolved.push({ ...operation, target, cellId: node.id, label: node.name || node.id });
  }
  return { ok: true, operations: resolved };
}
