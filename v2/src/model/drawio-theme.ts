import { deflateSync, strToU8 } from "fflate";
import { findDrawioElements, parseDrawioXml, serializeDrawioXml, type DrawioDomDocument, type DrawioDomElement } from "./drawio-xml-dom";
import { decodeDrawioPageXml } from "./drawio-xml-schema";

export type DrawioDiagramTheme = "editorial" | "youth" | "warm" | "midnight";
export interface NativePaletteChange {
  cellId: string;
  kind: "vertex" | "edge";
  expectedStyle: string;
  style: string;
}

/** A revision- and active-page-bound style transaction for the live Draw.io model. */
export interface NativePalettePlan {
  theme: DrawioDiagramTheme;
  documentRevision: string;
  pageId: string | null;
  /** Complete sorted cell-ID set, used by the iframe to reject stale or cross-page plans. */
  expectedPageCellIds: string[];
  changes: NativePaletteChange[];
}


interface DiagramThemePalette {
  vertexFill: string;
  vertexStroke: string;
  vertexFont: string;
  edgeStroke: string;
  edgeFont: string;
}

export const DRAWIO_DIAGRAM_THEMES: Record<DrawioDiagramTheme, DiagramThemePalette> = {
  editorial: {
    vertexFill: "#F1F5F9",
    vertexStroke: "#64748B",
    vertexFont: "#1E293B",
    edgeStroke: "#475569",
    edgeFont: "#334155"
  },
  youth: {
    vertexFill: "#FCE7F3",
    vertexStroke: "#BE185D",
    vertexFont: "#831843",
    edgeStroke: "#DB2777",
    edgeFont: "#9D174D"
  },
  warm: {
    vertexFill: "#FFF1E6",
    vertexStroke: "#C2410C",
    vertexFont: "#7C2D12",
    edgeStroke: "#9A3412",
    edgeFont: "#7C2D12"
  },
  midnight: {
    vertexFill: "#27364E",
    vertexStroke: "#93C5FD",
    vertexFont: "#F8FAFC",
    edgeStroke: "#64748B",
    edgeFont: "#334155"
  }
};

function safeColor(value: string): string | null {
  const color = value.trim();
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : null;
}

function parseXml(xml: string): DrawioDomDocument | null {
  try { return parseDrawioXml(xml); } catch { return null; }
}

/** Read the actual graph-model background without editing or normalizing the source XML. */
export function readDrawioModelBackground(xml: string): string | null {
  const parsed = parseXml(xml);
  if (!parsed) return null;
  const models = parsed.documentElement?.nodeName === "mxGraphModel"
    ? [parsed.documentElement as DrawioDomElement]
    : findDrawioElements(parsed, "mxGraphModel");
  if (!models.length) return null;
  const background = models[0]?.getAttribute("background");
  return background?.trim() || null;
}

/**
 * Explicit document-background utility. Theme-preset application must not call this function.
 * Invalid XML/colors and unchanged values are returned byte-for-byte as supplied.
 */
export function applyDrawioThemeBackground(xml: string, background: string): string {
  const color = safeColor(background);
  const parsed = parseXml(xml);
  if (!color || !parsed) return xml;
  const models = parsed.documentElement?.nodeName === "mxGraphModel"
    ? [parsed.documentElement as DrawioDomElement]
    : findDrawioElements(parsed, "mxGraphModel");
  let changed = false;
  for (const model of models) {
    if (model.getAttribute("background") !== color) {
      model.setAttribute("background", color);
      changed = true;
    }
  }
  return changed ? serializeDrawioXml(parsed) : xml;
}

function updateStyleProperties(style: string, values: Record<string, string>): string {
  const updatedKeys = new Set<string>();
  const parts = style.split(";").map((part) => {
    const equalsAt = part.indexOf("=");
    if (equalsAt <= 0) return part;
    const key = part.slice(0, equalsAt).trim();
    if (!(key in values)) return part;
    updatedKeys.add(key);
    return part.slice(0, equalsAt + 1) + values[key];
  });

  let result = parts.join(";");
  const missing = Object.entries(values).filter(([key]) => !updatedKeys.has(key));
  if (missing.length) {
    if (result && !result.endsWith(";")) result += ";";
    result += missing.map(([key, value]) => key + "=" + value).join(";") + ";";
  }
  return result;
}

function isTextOnlyVertex(style: string): boolean {
  const shape = style.split(";").find((part) => part.trim().startsWith("shape="))?.split("=", 2)[1]?.trim();
  if (shape === "text") return true;
  return style.split(";").some((part) => part.trim() === "text");
}

function applyThemeToGraphModel(
  documentOrModel: DrawioDomDocument | DrawioDomElement,
  palette: DiagramThemePalette
): number {
  const model = documentOrModel.nodeType === 9
    ? (documentOrModel as DrawioDomDocument).documentElement
    : documentOrModel as DrawioDomElement;
  if (!model || model.nodeName !== "mxGraphModel") return 0;
  let changed = 0;
  const cells = model.getElementsByTagName("mxCell");
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells.item(index) as DrawioDomElement | null;
    if (!cell) continue;
    const isVertex = cell.getAttribute("vertex") === "1";
    const isEdge = cell.getAttribute("edge") === "1";
    if (!isVertex && !isEdge) continue;

    const originalStyle = cell.getAttribute("style") ?? "";
    const values: Record<string, string> = isEdge
      ? { strokeColor: palette.edgeStroke, fontColor: palette.edgeFont }
      : isTextOnlyVertex(originalStyle)
        ? { fillColor: "none", strokeColor: "none", fontColor: palette.vertexFont }
        : { fillColor: palette.vertexFill, strokeColor: palette.vertexStroke, fontColor: palette.vertexFont };
    const nextStyle = updateStyleProperties(originalStyle, values);
    if (nextStyle !== originalStyle) {
      cell.setAttribute("style", nextStyle);
      changed += 1;
    }
  }
  return changed;
}

/** Decode through the shared bounded Draw.io page decoder used by XML validation. */
function decodeCompressedPage(page: DrawioDomElement): DrawioDomDocument | null {
  const payload = page.textContent?.trim() ?? "";
  if (!payload) return null;
  try {
    const document = parseDrawioXml(decodeDrawioPageXml(payload));
    return document.documentElement?.nodeName === "mxGraphModel" ? document : null;
  } catch {
    return null;
  }
}


function parseNativePageModel(xml: string, pageId: string | null): { model: DrawioDomElement; pageId: string | null } {
  const parsed = parseXml(xml);
  const root = parsed?.documentElement;
  if (!root) throw new Error("The Draw.io XML has no document element.");
  if (root.nodeName === "mxGraphModel") return { model: root as DrawioDomElement, pageId: null };
  if (root.nodeName !== "mxfile") throw new Error("Color presets only support native Draw.io mxfile or mxGraphModel documents.");

  const pages = findDrawioElements(parsed as DrawioDomDocument, "diagram");
  const page = pageId ? pages.find((candidate) => candidate.getAttribute("id") === pageId) : pages[0];
  if (!page) throw new Error(pageId
    ? "The active Draw.io page no longer exists. Select the page again before applying colors."
    : "The Draw.io document does not contain a page to color.");
  const inlineModels = Array.from(page.getElementsByTagName("mxGraphModel")) as DrawioDomElement[];
  const model = inlineModels[0] ?? decodeCompressedPage(page)?.documentElement as DrawioDomElement | undefined;
  if (!model || model.nodeName !== "mxGraphModel") {
    throw new Error("The active Draw.io page could not be decoded safely. No colors were changed.");
  }
  return { model, pageId: page.getAttribute("id") || null };
}

function themeStyleValues(style: string, kind: "vertex" | "edge", palette: DiagramThemePalette): Record<string, string> {
  if (kind === "edge") return { strokeColor: palette.edgeStroke, fontColor: palette.edgeFont };
  return isTextOnlyVertex(style)
    ? { fillColor: "none", strokeColor: "none", fontColor: palette.vertexFont }
    : { fillColor: palette.vertexFill, strokeColor: palette.vertexStroke, fontColor: palette.vertexFont };
}

/**
 * Build a plan for the active page. This function only projects XML: live mutation is performed
 * by the Draw.io plugin in one native model transaction so the operation shares native Undo/Redo.
 */
export function calculateNativePalettePlan(
  xml: string,
  pageId: string | null,
  documentRevision: string,
  theme: DrawioDiagramTheme
): NativePalettePlan {
  if (!/^[a-f0-9]{64}$/i.test(documentRevision)) {
    throw new Error("Diagram colors require the revision of the exact native Draw.io XML snapshot.");
  }
  const palette = DRAWIO_DIAGRAM_THEMES[theme];
  if (!palette) throw new Error("Unsupported Draw.io diagram color preset.");
  const parsed = parseNativePageModel(xml, pageId);
  const cells = Array.from(parsed.model.getElementsByTagName("mxCell")) as DrawioDomElement[];
  const ids = cells.map((cell) => cell.getAttribute("id") || "").filter(Boolean);
  if (ids.length !== cells.length || new Set(ids).size !== ids.length) {
    throw new Error("The active page has missing or duplicate cell IDs; no color changes were planned.");
  }
  const changes: NativePaletteChange[] = [];
  for (const cell of cells) {
    const kind = cell.getAttribute("vertex") === "1" ? "vertex"
      : cell.getAttribute("edge") === "1" ? "edge" : null;
    if (!kind) continue;
    const cellId = cell.getAttribute("id") || "";
    const expectedStyle = cell.getAttribute("style") ?? "";
    const style = updateStyleProperties(expectedStyle, themeStyleValues(expectedStyle, kind, palette));
    if (style !== expectedStyle) changes.push({ cellId, kind, expectedStyle, style });
  }
  return { theme, documentRevision, pageId: parsed.pageId, expectedPageCellIds: ids.sort(), changes };
}

/** Return a named preset only when every colorable cell on the selected page matches it. */
export function detectDrawioDiagramTheme(xml: string, pageId: string | null): DrawioDiagramTheme | "" {
  try {
    const { model } = parseNativePageModel(xml, pageId);
    const cells = (Array.from(model.getElementsByTagName("mxCell")) as DrawioDomElement[])
      .map((cell) => ({
        kind: cell.getAttribute("vertex") === "1" ? "vertex" as const
          : cell.getAttribute("edge") === "1" ? "edge" as const : null,
        style: cell.getAttribute("style") ?? ""
      }))
      .filter((cell): cell is { kind: "vertex" | "edge"; style: string } => cell.kind !== null);
    if (cells.length === 0) return "";
    for (const theme of Object.keys(DRAWIO_DIAGRAM_THEMES) as DrawioDiagramTheme[]) {
      const palette = DRAWIO_DIAGRAM_THEMES[theme];
      if (cells.every((cell) =>
        updateStyleProperties(cell.style, themeStyleValues(cell.style, cell.kind, palette)) === cell.style
      )) return theme;
    }
    return "";
  } catch {
    return "";
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function encodeCompressedPage(document: DrawioDomDocument): string {
  const encodedXml = encodeURIComponent(serializeDrawioXml(document));
  return encodeBase64(deflateSync(strToU8(encodedXml)));
}

/**
 * Apply a named palette directly to native Draw.io XML. All mxGraphModel pages are handled,
 * including compressed pages. Only cell color properties are changed: page backgrounds/grid,
 * geometry, labels, connectors, non-color style entries and unknown XML remain untouched.
 */
export function applyDrawioDiagramTheme(xml: string, theme: DrawioDiagramTheme): string {
  const palette = DRAWIO_DIAGRAM_THEMES[theme];
  const parsed = parseXml(xml);
  if (!palette || !parsed) return xml;

  let changed = 0;
  const rootName = parsed.documentElement?.nodeName;
  if (rootName === "mxGraphModel") {
    changed += applyThemeToGraphModel(parsed, palette);
  } else if (rootName === "mxfile") {
    // Ordinary (uncompressed) pages are already native mxGraphModel elements in the document.
    changed += findDrawioElements(parsed, "mxGraphModel")
      .reduce((count, model) => count + applyThemeToGraphModel(model, palette), 0);

    // A compressed page has no mxGraphModel child until decoded. Ignore unsupported payloads
    // rather than replacing them with a partial reconstruction.
    for (const page of findDrawioElements(parsed, "diagram")) {
      if (findDrawioElements(page.ownerDocument as DrawioDomDocument, "mxGraphModel")
        .some((model) => isDescendantOf(model, page))) continue;
      const decoded = decodeCompressedPage(page);
      if (!decoded) continue;
      const pageChanges = applyThemeToGraphModel(decoded, palette);
      if (pageChanges > 0) {
        page.textContent = encodeCompressedPage(decoded);
        changed += pageChanges;
      }
    }
  }

  return changed > 0 ? serializeDrawioXml(parsed) : xml;
}

function isDescendantOf(node: Node, ancestor: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode;
  }
  return false;
}
