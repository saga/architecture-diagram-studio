import { parseDrawioXml, serializeDrawioXml, findDrawioElements } from "../../src/model/drawio-xml-dom";
import { validateDrawioXmlDocument } from "../../src/model/drawio-xml-schema";

export type DrawioXmlPatch =
  | { op: "set-cell-attributes"; cellId: string; attributes: Record<string, string | null> }
  | { op: "set-geometry"; cellId: string; geometry: { x?: number; y?: number; width?: number; height?: number } }
  | { op: "set-geometry-xml"; cellId: string; geometryXml: string }
  | { op: "delete-cell"; cellId: string }
  | { op: "insert-cell-xml"; parentId: string; cellXml: string };

export interface DrawioXmlPatchResult {
  drawioXml: string;
  changedCellIds: string[];
  operationCount: number;
}

/**
 * Applies explicit, cell-scoped edits to native Draw.io XML without rebuilding the document.
 * Unknown XML elements/attributes remain in the parsed tree; no parallel diagram model is used.
 */
export function applyDrawioXmlPatch(sourceXml: string, patch: DrawioXmlPatch[], pageId?: string | null): DrawioXmlPatchResult {
  if (!Array.isArray(patch) || patch.length === 0 || patch.length > 100) {
    throw new Error("A Draw.io XML patch must contain between 1 and 100 operations.");
  }
  if (!validateDrawioXmlDocument(sourceXml).success) {
    throw new Error("The source is not a valid Draw.io XML document.");
  }

  const document = parseDrawioXml(sourceXml);
  const rootElement = document.documentElement;
  let selectedDiagram: Element | null = null;
  if (rootElement.tagName === "mxfile") {
    const diagrams = Array.from(rootElement.childNodes).filter(
      (node): node is Element => node.nodeType === 1 && (node as Element).tagName === "diagram"
    );
    if (pageId) {
      selectedDiagram = diagrams.find((diagram) => diagram.getAttribute("id") === pageId) ?? null;
      if (!selectedDiagram) throw new Error(`Draw.io page "${pageId}" was not found in the current XML.`);
    } else if (diagrams.length === 1) {
      selectedDiagram = diagrams[0] ?? null;
    } else {
      throw new Error("A pageId is required to patch a multi-page Draw.io document.");
    }
    if (!selectedDiagram?.getElementsByTagName("mxGraphModel").length) {
      throw new Error("The selected Draw.io page is not expanded native XML. Re-export the active page as XML and retry.");
    }
  } else if (pageId) {
    throw new Error("The selected XML is not an mxfile with addressable page IDs.");
  }
  const cells = findDrawioElements(document, "mxCell").filter((cell) => {
    if (!selectedDiagram) return true;
    let node: Node | null = cell;
    while (node && node !== selectedDiagram) node = node.parentNode;
    return node === selectedDiagram;
  });
  type NativeCellRef = { cell: Element; owner: Element; id: string };
  const byId = new Map<string, NativeCellRef>();
  const duplicateIds = new Set<string>();
  for (const cell of cells) {
    const parent = cell.parentNode;
    const wrapper = parent?.nodeType === 1 &&
      ((parent as Element).tagName === "object" || (parent as Element).tagName === "UserObject")
      ? parent as Element
      : null;
    // Draw.io UserObject/object wrappers often own the native ID and label while
    // their child mxCell owns style, geometry, vertex/edge and terminal attributes.
    const id = wrapper?.getAttribute("id") || cell.getAttribute("id");
    if (!id) continue;
    if (byId.has(id)) duplicateIds.add(id);
    else byId.set(id, { cell, owner: wrapper ?? cell, id });
  }
  if (duplicateIds.size) {
    throw new Error("The document contains duplicate native cell IDs; XML patching requires unambiguous IDs: " + [...duplicateIds].slice(0, 5).join(", "));
  }
  const changed = new Set<string>();

  for (const operation of patch) {
    if (!operation || typeof operation !== "object") throw new Error("Every XML patch operation must be an object.");
    if (operation.op === "insert-cell-xml") {
      const parentId = operation.parentId;
      if (typeof parentId !== "string" || !parentId.trim() || typeof operation.cellXml !== "string" || !operation.cellXml.trim()) {
        throw new Error("insert-cell-xml requires an exact parentId and a native cell XML fragment.");
      }
      const parentCell = byId.get(parentId);
      if (!parentCell) throw new Error(`Draw.io parent cell "${parentId}" was not found.`);
      const fragmentDocument = parseDrawioXml(operation.cellXml);
      const fragment = fragmentDocument.documentElement;
      const insertedCell = fragment.tagName === "mxCell"
        ? fragment
        : Array.from(fragment.getElementsByTagName("mxCell")).find((node) => node.parentNode === fragment) as Element | undefined;
      const insertedWrapper = fragment.tagName === "object" || fragment.tagName === "UserObject" ? fragment : null;
      const insertedId = insertedWrapper?.getAttribute("id") || insertedCell?.getAttribute("id");
      if (!insertedCell || !insertedId) throw new Error("The inserted XML must be an mxCell or wrapper containing a direct mxCell with an ID.");
      if (insertedCell.getAttribute("parent") !== parentId) {
        throw new Error(`Inserted cell "${insertedId}" must declare parent="${parentId}" to match the patch target.`);
      }
      if (byId.has(insertedId)) throw new Error(`Inserted cell ID "${insertedId}" already exists in the document.`);
      let model: Node | null = parentCell.cell;
      while (model && (model as Element).tagName !== "mxGraphModel") model = model.parentNode;
      const root = model && (model as Element).getElementsByTagName("root").item(0);
      if (!root) throw new Error("The target parent is not inside a native mxGraphModel root.");
      const imported = document.importNode(fragment, true);
      root.appendChild(imported);
      const importedCell = imported.nodeName === "mxCell"
        ? imported as Element
        : (imported as Element).getElementsByTagName("mxCell").item(0) as Element | null;
      if (importedCell) {
        const wrapper = (imported as Element).tagName === "object" || (imported as Element).tagName === "UserObject"
          ? imported as Element
          : null;
        byId.set(insertedId, { cell: importedCell, owner: wrapper ?? importedCell, id: insertedId });
      }
      changed.add(insertedId);
      continue;
    }
    if (typeof operation.cellId !== "string" || !operation.cellId.trim()) {
      throw new Error("Every XML patch operation must identify a cell by its exact ID.");
    }
    const target = byId.get(operation.cellId);
    if (!target) throw new Error(`Draw.io cell "${operation.cellId}" was not found.`);
    const cell = target.cell;

    if (operation.op === "set-cell-attributes") {
      for (const [name, value] of Object.entries(operation.attributes)) {
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) || name === "id") {
          throw new Error(`Unsupported or immutable native cell attribute: ${name}`);
        }
        const targetElement = target.owner !== cell && ["label", "value", "placeholders"].includes(name)
          ? target.owner
          : cell;
        const attributeName = targetElement === target.owner && target.owner !== cell && name === "value" && target.owner.hasAttribute("label")
          ? "label"
          : name;
        if (value === null) targetElement.removeAttribute(attributeName);
        else if (typeof value === "string") targetElement.setAttribute(attributeName, value);
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

    if (operation.op === "set-geometry-xml") {
      if (typeof operation.geometryXml !== "string" || !operation.geometryXml.trim() || operation.geometryXml.length > 100_000) {
        throw new Error("set-geometry-xml requires a non-empty mxGeometry fragment up to 100 KB.");
      }
      const fragmentDocument = parseDrawioXml(operation.geometryXml);
      const fragment = fragmentDocument.documentElement;
      if (fragment.tagName !== "mxGeometry") {
        throw new Error("set-geometry-xml must contain one mxGeometry root element.");
      }
      if (!fragment.hasAttribute("as")) fragment.setAttribute("as", "geometry");
      const imported = document.importNode(fragment, true);
      const previous = Array.from(cell.childNodes).find(
        (node): node is Element => node.nodeType === 1 && (node as Element).tagName === "mxGeometry"
      );
      if (previous?.parentNode) previous.parentNode.replaceChild(imported, previous);
      else cell.appendChild(imported);
      changed.add(operation.cellId);
      continue;
    }

    if (operation.op === "delete-cell") {
      // Remove a UserObject/object wrapper when the mxCell is nested inside one;
      // otherwise remove only the mxCell from its native root layer.
      let owner: Node = cell;
      owner = target.owner;
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
