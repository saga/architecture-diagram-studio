import type { NativeEditOperation, ResolvedNativeEditOperation } from "../../src/model/native-edit-operations";

/** Native Draw.io cell index sent with each request; only ids, labels and cell kinds are needed for targeting. */
export interface NativeEditContextNode {
  id?: unknown;
  name?: unknown;
  cellType?: unknown;
}

export type NativeEditResolution =
  | { ok: true; operations: ResolvedNativeEditOperation[] }
  | { ok: false; error: string };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Resolves operation targets against native mxCells supplied for the active Draw.io page.
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
        name: typeof node.name === "string" ? node.name.trim() : "",
        cellType: node.cellType === "vertex" || node.cellType === "edge" ? node.cellType : undefined
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
      return { ok: false, error: `Operation ${index + 1}: native Draw.io cell “${target}” was not found among the ${nodes.length} cells indexed on the active page. Use an exact cell id or exact label from the supplied diagram context.` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `Operation ${index + 1}: label “${target}” is ambiguous (${matches.length} elements match). Use the exact cell id instead.` };
    }
    const node = matches[0];
    if (operation.op === "add_node_after" && node.cellType === "edge") {
      return { ok: false, error: `Operation ${index + 1}: “${target}” resolves to a connector; add_node_after requires a vertex cell.` };
    }
    resolved.push({ ...operation, target, cellId: node.id, label: node.name || node.id });
  }
  return { ok: true, operations: resolved };
}
