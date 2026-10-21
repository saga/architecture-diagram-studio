import type { DiagramDocument } from "./types";

interface ParsedPage {
  document: XMLDocument;
  model: Element;
  root: Element;
  diagram: Element | null;
}

function directChildren(element: Element, localName: string): Element[] {
  return Array.from(element.children).filter((child) => child.localName === localName);
}

function parseSinglePlainPage(xml: string): ParsedPage | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.querySelector("parsererror")) return null;
  const documentRoot = parsed.documentElement;
  if (documentRoot.localName === "mxGraphModel") {
    const root = directChildren(documentRoot, "root")[0];
    return root ? { document: parsed, model: documentRoot, root, diagram: null } : null;
  }
  if (documentRoot.localName !== "mxfile") return null;

  const diagrams = directChildren(documentRoot, "diagram");
  // Semantic editing deliberately declines multi-page and compressed files. They remain
  // fully editable in Draw.io, while their complete original mxfile remains authoritative.
  if (diagrams.length !== 1) return null;
  const diagram = diagrams[0];
  const model = directChildren(diagram, "mxGraphModel")[0];
  if (!model) return null;
  const root = directChildren(model, "root")[0];
  return root ? { document: parsed, model, root, diagram } : null;
}

function cells(root: Element): Element[] {
  return Array.from(root.children).filter((child) => child.localName === "mxCell");
}

function cellMap(root: Element): Map<string, Element> | null {
  const direct = Array.from(root.children);
  if (direct.some((child) => child.localName !== "mxCell")) return null;
  const result = new Map<string, Element>();
  for (const cell of direct) {
    const id = cell.getAttribute("id");
    if (!id || result.has(id)) return null;
    result.set(id, cell);
  }
  return result;
}

function attributeSignature(element: Element): string {
  return Array.from(element.attributes)
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => name + "=" + value)
    .join("\u0000");
}

function subtreeSignature(element: Element): string {
  const attributes = attributeSignature(element);
  const children = Array.from(element.children).map(subtreeSignature).join("\u0001");
  return element.localName + "[" + attributes + "]{" + children + "}";
}

function hasStudioMarker(cell: Element): boolean {
  const id = cell.getAttribute("id") || "";
  const style = cell.getAttribute("style") || "";
  return /(?:^|;)studio(?:Role|VisualRole|Kind|Boundary|SequenceFragment|Members|SequenceOrder|StartOrder|EndOrder|FragmentKind|Source|Target|Theme|AccentColor|FragmentParticipants)=?/.test(style) ||
    /__(?:studioAccent|sequenceActivation|sequenceFragment|lifeline|lifelineEnd|messageSourceAnchor|messageTargetAnchor)$/.test(id);
}

function managedCellIds(document: DiagramDocument): Set<string> {
  const ids = new Set<string>(["0", "1"]);
  for (const node of document.nodes) {
    ids.add(node.id);
    ids.add(node.id + "__studioAccent");
    ids.add(node.id + "__lifeline");
    ids.add(node.id + "__lifelineEnd");
  }
  for (const relation of document.relations) {
    ids.add(relation.id);
    ids.add(relation.id + "__sequenceActivation");
    ids.add(relation.id + "__messageSourceAnchor");
    ids.add(relation.id + "__messageTargetAnchor");
  }
  for (const boundary of document.boundaries) ids.add(boundary.id);
  for (const fragment of document.sequence?.fragments || []) ids.add(fragment.id + "__sequenceFragment");
  return ids;
}

/**
 * Returns true only when the current projection accounts for every cell and preserves
 * each cell's full structure. This is a safety gate, not a diagram-type classifier.
 */
export function canEditInStudio(sourceXml: string, projectionXml: string, document: DiagramDocument): boolean {
  const source = parseSinglePlainPage(sourceXml);
  const projection = parseSinglePlainPage(projectionXml);
  if (!source || !projection) return false;

  const sourceCells = cellMap(source.root);
  const projectedCells = cellMap(projection.root);
  if (!sourceCells || !projectedCells || sourceCells.size !== projectedCells.size) return false;
  if ([...sourceCells.keys()].some((id) => !projectedCells.has(id))) return false;

  for (const node of document.nodes) {
    const cell = sourceCells.get(node.id);
    if (!cell || cell.getAttribute("vertex") !== "1" || !/(?:^|;)studioRole=/.test(cell.getAttribute("style") || "")) return false;
  }
  for (const relation of document.relations) {
    const cell = sourceCells.get(relation.id);
    if (!cell || cell.getAttribute("edge") !== "1" || !/(?:^|;)studioKind=/.test(cell.getAttribute("style") || "")) return false;
  }

  // Every cell must match the current semantic projection structurally and visually.
  // If a custom shape, wrapper, unknown style key, custom attribute, or unmodeled label
  // exists, keep the document in native mode instead of silently normalizing it away.
  for (const [id, sourceCell] of sourceCells) {
    const projectedCell = projectedCells.get(id);
    if (!projectedCell) return false;
    if (attributeSignature(sourceCell) !== attributeSignature(projectedCell)) return false;
    const sourceGeometry = directChildren(sourceCell, "mxGeometry")[0];
    const projectedGeometry = directChildren(projectedCell, "mxGeometry")[0];
    if (Boolean(sourceGeometry) !== Boolean(projectedGeometry)) return false;
    if (sourceGeometry && projectedGeometry && subtreeSignature(sourceGeometry) !== subtreeSignature(projectedGeometry)) return false;
  }
  return true;
}

/**
 * Applies a generated semantic projection to the authoritative plain, single-page XML.
 * The enclosing mxfile, diagram attributes, mxGraphModel settings and any opaque cells
 * are retained. Existing cells are matched by ID; generated support cells are added or
 * removed by identity. Returns null when the XML cannot be patched safely.
 */
export function patchDrawioXml(sourceXml: string, nextProjectionXml: string, previousDocument: DiagramDocument): string | null {
  const source = parseSinglePlainPage(sourceXml);
  const next = parseSinglePlainPage(nextProjectionXml);
  if (!source || !next) return null;
  const sourceCells = cellMap(source.root);
  const nextCells = cellMap(next.root);
  if (!sourceCells || !nextCells) return null;

  const retainedIds = managedCellIds(previousDocument);
  const generatedIds = new Set([...nextCells.keys()].filter((id) => id !== "0" && id !== "1"));
  for (const [id, oldCell] of sourceCells) {
    if (id === "0" || id === "1") continue;
    const nextCell = nextCells.get(id);
    if (nextCell) {
      oldCell.replaceWith(source.document.importNode(nextCell, true));
    } else if (retainedIds.has(id) || hasStudioMarker(oldCell)) {
      oldCell.remove();
    }
  }

  const refreshed = cellMap(source.root);
  if (!refreshed) return null;
  for (const id of generatedIds) {
    if (refreshed.has(id)) continue;
    const cell = nextCells.get(id);
    if (cell) source.root.appendChild(source.document.importNode(cell, true));
  }
  return new XMLSerializer().serializeToString(source.document);
}

/** Checks the XML envelope only; it does not require every cell to be understood by Studio. */
export function isDrawioXmlDocument(xml: string): boolean {
  if (!xml.trim() || typeof DOMParser === "undefined") return false;
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.querySelector("parsererror")) return false;
  const root = parsed.documentElement;
  if (root.localName === "mxGraphModel") return Boolean(directChildren(root, "root").length);
  if (root.localName !== "mxfile") return false;
  const pages = directChildren(root, "diagram");
  return pages.length > 0 && pages.every((page) =>
    directChildren(page, "mxGraphModel").length > 0 || Boolean(page.textContent?.trim())
  );
}
