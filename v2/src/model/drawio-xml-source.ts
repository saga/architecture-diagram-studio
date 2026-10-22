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

function stripThemeMetadata(raw: string): string {
  return raw.replace(/(\sstyle=(["']))([\s\S]*?)\2/, (_match, prefix: string, _quote: string, style: string) =>
    prefix + style.replace(/(?:^|;)studioTheme(?:Original|Applied|Override)[A-Za-z]+=[^;]*/g, "").replace(/^;+|;+$/g, "") + '"'
  );
}

function mergeThemeMetadata(sourceCell: string, nextCell: string): string {
  const sourceStyle = /\bstyle=(["'])([\s\S]*?)\1/.exec(sourceCell);
  const nextStyle = /\bstyle=(["'])([\s\S]*?)\1/.exec(nextCell);
  if (!sourceStyle || !nextStyle || !/studioTheme(?:Original|Applied|Override)/.test(sourceStyle[2])) return nextCell;
  const parse = (raw: string) => new Map(raw.split(";").filter(Boolean).map((entry) => {
    const index = entry.indexOf("=");
    return index < 0 ? [entry, "1"] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
  const source = parse(sourceStyle[2]);
  const next = parse(nextStyle[2]);
  const keys = ["fillColor", "strokeColor", "fontColor", "startFillColor", "endFillColor"];
  for (const key of keys) {
    const suffix = key[0].toUpperCase() + key.slice(1);
    const originalKey = "studioThemeOriginal" + suffix;
    const appliedKey = "studioThemeApplied" + suffix;
    const overrideKey = "studioThemeOverride" + suffix;
    if (source.get(overrideKey) === "1") {
      next.set(overrideKey, "1");
      continue;
    }
    if (!source.has(appliedKey)) continue;
    if ((next.get(key) ?? null) !== source.get(appliedKey)) {
      next.set(overrideKey, "1");
      continue;
    }
    if (source.has(originalKey)) next.set(originalKey, source.get(originalKey)!);
    next.set(appliedKey, source.get(appliedKey)!);
  }
  const mergedStyle = [...next].map(([key, value]) => key + "=" + value).join(";") + ";";
  const escaped = mergedStyle.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return nextCell.slice(0, nextStyle.index) + 'style="' + escaped + '"' + nextCell.slice(nextStyle.index + nextStyle[0].length);
}

function styleOf(raw: string): string {
  return attribute(raw, "style") || "";
}

function isLegacyLayerCellMigration(id: string, sourceCell: string, projectionCell: string | undefined): boolean {
  if (id !== "1" || !projectionCell || attribute(sourceCell, "style") !== null) return false;
  // Old Studio exports used this exact default layer cell. Permit the new layout
  // metadata to be introduced there without relaxing checks for arbitrary native cells.
  return sourceCell === '<mxCell id="1" parent="0"/>' &&
    projectionCell.replace(/\sstyle=(["'])[^"']*\1(?=\s*\/>)/, "") === sourceCell;
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
  if (!source || !projection) return false;
  // The common lossless case is byte-identical root content. Metadata changes on <mxfile>
  // or <mxGraphModel> must not force Freeform-only mode when every cell is unchanged.
  // Since the entire cell payload equals the generated projection, no per-cell checks are needed.
  if (source.inner === projection.inner) return true;
  if (source.cellMap.size !== projection.cellMap.size) return false;
  for (const [id, raw] of source.cellMap) {
    const projectedCell = projection.cellMap.get(id);
    if (projectedCell === undefined) return false;\n    if (projectedCell !== raw && stripThemeMetadata(projectedCell) !== stripThemeMetadata(raw) && !isLegacyLayerCellMigration(id, raw, projectedCell)) return false;
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
    if (replacement !== undefined) merged.push(mergeThemeMetadata(old.raw, replacement));
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

export interface DrawioXmlDiagnostics {
  pageCount: number;
  warnings: string[];
  issues: string[];
}

/** Return actionable import diagnostics without replacing or normalizing the authoritative XML. */
export function getDrawioXmlDiagnostics(xml: string): DrawioXmlDiagnostics {
  const trimmed = xml.trimStart();
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<mxlibrary\b/i.test(trimmed)) {
    return { pageCount: 0, warnings: [], issues: ["This is a Draw.io custom shape library (<mxlibrary>), not a diagram file. Open a .drawio or diagram XML file instead."] };
  }
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<templates\b/i.test(trimmed)) {
    return { pageCount: 0, warnings: [], issues: ["This is a Draw.io template index (<templates>), not a diagram file. Open an individual .drawio template instead."] };
  }
  const validation = validateDrawioXmlDocument(xml);
  if (!validation.success) {
    return { pageCount: 0, warnings: [], issues: validation.issues.length ? validation.issues : ["This XML is not a supported Draw.io diagram."] };
  }
  const pageCount = validation.format === "mxfile"
    ? validation.root.children.filter((child) => child.name === "diagram").length
    : validation.format === "mxGraphModel" ? 1 : 0;
  // Page-count scope is an intentional integration constraint (LeanIX consumes the
  // first page); do not present it as a compatibility defect. Keep pageCount available
  // to callers that need informational UI, while surfacing only actual schema warnings.
  const warnings = [...validation.warnings];
  return { pageCount, warnings: [...new Set(warnings)], issues: [] };
}
