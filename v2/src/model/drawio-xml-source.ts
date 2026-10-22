import type { DiagramDocument } from "./types";
import { validateDrawioXmlDocument } from "./drawio-xml-schema";
export { DrawioXmlElementSchema, MxCellSchema, MxGeometrySchema, MxGraphModelSchema, MxLibrarySchema, MxLibraryEntrySchema, MxRootSchema, MxfileSchema, DrawioDiagramPageSchema, DrawioXmlRootSchema, DrawioDiagramXmlSchema, validateDrawioXmlDocument, validateDrawioXmlFile } from "./drawio-xml-schema";

interface RootSlice {
  start: number;
  end: number;
  inner: string;
  cellMap: Map<string, string>;
  cells: Array<{ id: string; raw: string }>;
}

function attribute(raw: string, name: string): string | null {
  const match = new RegExp("\\b" + name + "=(['\"])([\\s\\S]*?)\\1").exec(raw);
  return match?.[2] ?? null;
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function hasTagBoundary(source: string, index: number, nameLength: number): boolean {
  const next = source[index + nameLength];
  return next === undefined || next === ">" || next === "/" || /\s/.test(next);
}

/** Scan direct mxCell children without confusing a slash or `>` inside a quoted attribute with tag syntax. */
function scanMxCells(inner: string): string[] | null {
  const cells: string[] = [];
  let cursor = 0;
  while (cursor < inner.length) {
    while (cursor < inner.length && /\s/.test(inner[cursor])) cursor += 1;
    if (cursor === inner.length) break;
    if (!inner.startsWith("<mxCell", cursor) || !hasTagBoundary(inner, cursor, 7)) return null;

    const openingEnd = tagEnd(inner, cursor);
    if (openingEnd < 0) return null;
    const opening = inner.slice(cursor, openingEnd + 1);
    const selfClosing = opening.slice(0, -1).trimEnd().endsWith("/");
    let cellEnd = openingEnd + 1;
    if (!selfClosing) {
      const closingStart = inner.indexOf("</mxCell", cellEnd);
      if (closingStart < 0 || !hasTagBoundary(inner, closingStart, 8)) return null;
      const closingEnd = tagEnd(inner, closingStart);
      if (closingEnd < 0) return null;
      cellEnd = closingEnd + 1;
    }
    cells.push(inner.slice(cursor, cellEnd));
    cursor = cellEnd;
  }
  return cells;
}

function parseRootSlice(xml: string): RootSlice | null {
  const roots: Array<{ contentStart: number; closeStart: number }> = [];
  let searchFrom = 0;
  while (searchFrom < xml.length) {
    const openStart = xml.indexOf("<root", searchFrom);
    if (openStart < 0) break;
    if (!hasTagBoundary(xml, openStart, 5)) {
      searchFrom = openStart + 5;
      continue;
    }
    const openEnd = tagEnd(xml, openStart);
    if (openEnd < 0) return null;
    const closeStart = xml.indexOf("</root", openEnd + 1);
    if (closeStart < 0 || !hasTagBoundary(xml, closeStart, 6)) return null;
    const closeEnd = tagEnd(xml, closeStart);
    if (closeEnd < 0) return null;
    roots.push({ contentStart: openEnd + 1, closeStart });
    searchFrom = closeEnd + 1;
  }
  if (roots.length !== 1) return null;

  const mxfile = /<mxfile\b/.test(xml);
  const modelCount = (xml.match(/<mxGraphModel\b/g) || []).length;
  const pageCount = (xml.match(/<diagram\b/g) || []).length;
  if (mxfile ? pageCount !== 1 || modelCount !== 1 : modelCount !== 1 || pageCount !== 0) return null;

  const root = roots[0];
  const inner = xml.slice(root.contentStart, root.closeStart);
  const rawCells = scanMxCells(inner);
  if (!rawCells) return null;

  const parsedCells: Array<{ id: string; raw: string }> = [];
  const cellMap = new Map<string, string>();
  for (const raw of rawCells) {
    const id = attribute(raw, "id");
    if (!id || cellMap.has(id)) return null;
    cellMap.set(id, raw);
    parsedCells.push({ id, raw });
  }
  if (!cellMap.has("0") || !cellMap.has("1")) return null;
  return { start: root.contentStart, end: root.closeStart, inner, cellMap, cells: parsedCells };
}

function styleOf(raw: string): string {
  return attribute(raw, "style") || "";
}

function isStudioManagedCell(id: string, raw: string): boolean {
  return /(?:^|;)studio(?:Role|VisualRole|Kind|Boundary|SequenceFragment|Members|SequenceOrder|StartOrder|EndOrder|FragmentKind|Source|Target|Theme|AccentColor|FragmentParticipants)=?/.test(styleOf(raw)) ||
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
 * True only if the entire single-page XML cell inventory is represented byte-for-byte
 * by the current Studio projection. This intentionally has false negatives: a native
 * document with custom structure stays in Draw.io instead of risking a lossy edit.
 */
export function canEditInStudio(sourceXml: string, projectionXml: string, document: DiagramDocument): boolean {
  const source = parseRootSlice(sourceXml);
  const projection = parseRootSlice(projectionXml);
  if (!source || !projection || source.cellMap.size !== projection.cellMap.size) return false;
  for (const [id, raw] of source.cellMap) {
    if (projection.cellMap.get(id) !== raw) return false;
  }

  for (const node of document.nodes) {
    const cell = source.cellMap.get(node.id);
    if (!cell || attribute(cell, "vertex") !== "1" || !/(?:^|;)studioRole=/.test(styleOf(cell))) return false;
  }
  for (const relation of document.relations) {
    const cell = source.cellMap.get(relation.id);
    if (!cell || attribute(cell, "edge") !== "1" || !/(?:^|;)studioKind=/.test(styleOf(cell))) return false;
  }
  return true;
}

/**
 * Patch the authoritative XML by cell identity. The caller must first verify
 * canEditInStudio(source, currentProjection, currentDocument). This function retains
 * the source XML outside <root>, and preserves the order and bytes of unchanged cells.
 */
export function patchDrawioXml(sourceXml: string, nextProjectionXml: string, previousDocument: DiagramDocument): string | null {
  const source = parseRootSlice(sourceXml);
  const next = parseRootSlice(nextProjectionXml);
  if (!source || !next) return null;

  const managedIds = managedCellIds(previousDocument);
  const nextIds = new Set(next.cells.map((cell) => cell.id));
  const merged: string[] = [];
  for (const old of source.cells) {
    if (old.id === "0" || old.id === "1") {
      merged.push(next.cellMap.get(old.id) || old.raw);
      continue;
    }
    const replacement = next.cellMap.get(old.id);
    if (replacement !== undefined) merged.push(replacement);
    else if (!(managedIds.has(old.id) || isStudioManagedCell(old.id, old.raw))) merged.push(old.raw);
  }

  const included = new Set(source.cells.filter((cell) => nextIds.has(cell.id)).map((cell) => cell.id));
  const newVertices: string[] = [];
  const newEdges: string[] = [];
  for (const cell of next.cells) {
    if (included.has(cell.id)) continue;
    if (attribute(cell.raw, "edge") === "1") newEdges.push(cell.raw);
    else newVertices.push(cell.raw);
  }
  // mxGraph paints edges behind vertices, so newly created vertices must be inserted
  // before the first edge while newly created edges are appended after all vertices.
  const firstEdge = merged.findIndex((raw) => attribute(raw, "edge") === "1");
  if (newVertices.length) merged.splice(firstEdge < 0 ? merged.length : firstEdge, 0, ...newVertices);
  merged.push(...newEdges);
  return sourceXml.slice(0, source.start) + merged.join("") + sourceXml.slice(source.end);
}

/** XML validation is based on the extensible Zod Draw.io schema, including compressed pages. */
export function isDrawioXmlDocument(xml: string): boolean {
  return validateDrawioXmlDocument(xml).success;
}
