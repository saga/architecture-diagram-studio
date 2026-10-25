import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { findDrawioElements, parseDrawioXml, serializeDrawioXml, type DrawioDomDocument, type DrawioDomElement } from "./drawio-xml-dom";

export type DrawioDiagramTheme = "editorial" | "youth" | "warm" | "midnight";

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
        ? { fontColor: palette.vertexFont }
        : { fillColor: palette.vertexFill, strokeColor: palette.vertexStroke, fontColor: palette.vertexFont };
    const nextStyle = updateStyleProperties(originalStyle, values);
    if (nextStyle !== originalStyle) {
      cell.setAttribute("style", nextStyle);
      changed += 1;
    }
  }
  return changed;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Draw.io compressed pages use base64(raw-deflate(UTF-8(encodeURIComponent(xml)))). */
function decodeCompressedPage(page: DrawioDomElement): DrawioDomDocument | null {
  const payload = page.textContent?.trim() ?? "";
  if (!payload) return null;
  try {
    const encodedXml = strFromU8(inflateSync(decodeBase64(payload)));
    const xml = decodeURIComponent(encodedXml);
    const document = parseDrawioXml(xml);
    return document.documentElement?.nodeName === "mxGraphModel" ? document : null;
  } catch {
    return null;
  }
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
