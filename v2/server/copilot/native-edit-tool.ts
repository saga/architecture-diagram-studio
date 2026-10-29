import type { NativeEditOperation, ResolvedNativeEditOperation } from "../../src/model/native-edit-operations";

/** Native Draw.io cell index sent with each request; only ids, labels and cell kinds are needed for targeting. */
export interface NativeEditContextCell {
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
  const source = context && typeof context === "object" ? context as { cells?: unknown } : {};
  const cells = Array.isArray(source.cells)
    ? source.cells
      .filter((cell): cell is NativeEditContextCell => Boolean(cell) && typeof cell === "object")
      .map((cell) => ({
        id: typeof cell.id === "string" ? cell.id : "",
        name: typeof cell.name === "string" ? cell.name.trim() : "",
        cellType: cell.cellType === "vertex" || cell.cellType === "edge" ? cell.cellType : undefined
      }))
      .filter((node) => node.id)
    : [];
  if (cells.length === 0 && !operations.some((operation) => operation.op === "auto_layout")) {
    return { ok: false, error: "The request did not include any native Draw.io cells to target" };
  }

  const resolved: ResolvedNativeEditOperation[] = [];
  for (const [index, operation] of operations.entries()) {
    const target = operation.target.trim();
    if (operation.op === "auto_layout") {
      if (target !== "active_page") {
        return { ok: false, error: 'Operation ' + (index + 1) + ': auto_layout target must be "active_page".' };
      }
      resolved.push({ ...operation, target: "active_page", cellId: "__active_page__", targetLabel: "active Draw.io page" });
      continue;
    }
    const byId = cells.filter((cell) => cell.id === target);
    const matches = byId.length ? byId : cells.filter((cell) => cell.name && normalize(cell.name) === normalize(target));
    if (matches.length === 0) {
      return { ok: false, error: `Operation ${index + 1}: native Draw.io cell “${target}” was not found among the ${cells.length} cells indexed on the active page. Use an exact cell id or exact label from the supplied diagram context.` };
    }
    if (matches.length > 1) {
      return { ok: false, error: `Operation ${index + 1}: label “${target}” is ambiguous (${matches.length} elements match). Use the exact cell id instead.` };
    }
    const cell = matches[0];
    if ((operation.op === "add_node_after" || operation.op === "add_node_below") && cell.cellType !== "vertex") {
      return { ok: false, error: `Operation ${index + 1}: “${target}” must resolve to a vertex; ${operation.op} cannot target a connector or an unknown cell type.` };
    }
    if ((operation.op === "move" || operation.op === "resize") && cell.cellType !== "vertex") {
      return { ok: false, error: `Operation ${index + 1}: “${target}” is not a vertex. Move/resize applies to node geometry; use a dedicated connector-routing operation for edges.` };
    }
    resolved.push({ ...operation, target, cellId: cell.id, targetLabel: cell.name });
  }
  return { ok: true, operations: resolved };
}
