import { parseDrawioXml, serializeDrawioXml, findDrawioElements } from "../../src/model/drawio-xml-dom";
import { validateDrawioXmlDocument } from "../../src/model/drawio-xml-schema";

export type DrawioXmlPatch =
  | { op: "set-cell-attributes"; cellId: string; attributes: Record<string, string | null> }
  | { op: "set-geometry"; cellId: string; geometry: { x?: number; y?: number; width?: number; height?: number } }
  | { op: "delete-cell"; cellId: string };

export interface DrawioXmlPatchResult {
  drawioXml: string;
  changedCellIds: string[];
  operationCount: number;
}

/**
 * Applies explicit, cell-scoped edits to native Draw.io XML without rebuilding the document.
 * Unknown XML elements/attributes remain in the parsed tree; no parallel diagram model is used.
 */
export function applyDrawioXmlPatch(sourceXml: string, patch: DrawioXmlPatch[]): DrawioXmlPatchResult {
  if (!Array.isArray(patch) || patch.length === 0 || patch.length > 100) {
    throw new Error("A Draw.io XML patch must contain between 1 and 100 operations.");
  }
  if (!validateDrawioXmlDocument(sourceXml).success) {
    throw new Error("The source is not a valid Draw.io XML document.");
  }

  const document = parseDrawioXml(sourceXml);
  const cells = findDrawioElements(document, "mxCell");
  const byId = new Map<string, Element>();
  for (const cell of cells) {
    const id = cell.getAttribute("id");
    if (id) byId.set(id, cell);
  }
  const changed = new Set<string>();

  for (const operation of patch) {
    if (!operation || typeof operation.cellId !== "string" || !operation.cellId.trim()) {
      throw new Error("Every XML patch operation must identify a cell by its exact ID.");
    }
    const cell = byId.get(operation.cellId);
    if (!cell) throw new Error(`Draw.io cell "${operation.cellId}" was not found.`);

    if (operation.op === "set-cell-attributes") {
      for (const [name, value] of Object.entries(operation.attributes)) {
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || name === "id") {
          throw new Error(`Unsupported or immutable mxCell attribute: ${name}`);
        }
        if (value === null) cell.removeAttribute(name);
        else if (typeof value === "string") cell.setAttribute(name, value);
        else throw new Error(`Attribute ${name} must be a string or null.`);
      }
      changed.add(operation.cellId);
      continue;
    }

    if (operation.op === "set-geometry") {
      let geometry = Array.from(cell.childNodes).find(
        (node): node is Element => node.nodeType === 1 && (node as Element).tagName === "mxGeometry"
      );
      if (!geometry) {
        geometry = document.createElement("mxGeometry");
        geometry.setAttribute("as", "geometry");
        cell.appendChild(geometry);
      }
      for (const [name, value] of Object.entries(operation.geometry)) {
        if (value === undefined) continue;
        if (!["x", "y", "width", "height"].includes(name) || !Number.isFinite(value)) {
          throw new Error(`Invalid geometry field/value: ${name}=${String(value)}`);
        }
        geometry.setAttribute(name, String(value));
      }
      changed.add(operation.cellId);
      continue;
    }

    if (operation.op === "delete-cell") {
      // Delete the wrapper/user object containing the mxCell, not just its inner mxCell.
      let owner: Node = cell;
      while (owner.parentNode && owner.parentNode !== document) {
        if (owner.parentNode.nodeType === 1) {
          const parent = owner.parentNode as Element;
          if (parent.tagName === "object" || parent.tagName === "UserObject") {
            owner = parent;
            break;
          }
        }
        owner = owner.parentNode;
        if ((owner as Element).tagName === "root") break;
      }
      const parent = owner.parentNode;
      if (!parent) throw new Error(`Cannot remove detached cell "${operation.cellId}".`);
      parent.removeChild(owner);
      byId.delete(operation.cellId);
      changed.add(operation.cellId);
      continue;
    }

    const unreachable: never = operation;
    throw new Error(`Unsupported XML patch operation: ${JSON.stringify(unreachable)}`);
  }

  const drawioXml = serializeDrawioXml(document);
  if (!validateDrawioXmlDocument(drawioXml).success) {
    throw new Error("The patch result failed Draw.io XML validation; no result may be persisted.");
  }
  return { drawioXml, changedCellIds: [...changed], operationCount: patch.length };
}
