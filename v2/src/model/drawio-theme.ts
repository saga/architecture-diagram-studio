import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { findDrawioElements, parseDrawioXml, serializeDrawioXml, type DrawioDomDocument, type DrawioDomElement } from "./drawio-xml-dom";
import { decodeDrawioPageXml } from "./drawio-xml-schema";

export type DrawioDiagramTheme =
  | "ocean-depths" | "sunset-boulevard" | "forest-canopy" | "modern-minimalist" | "golden-hour"
  | "arctic-frost" | "desert-rose" | "tech-innovation" | "botanical-garden" | "midnight-galaxy";
export type DrawioCategoryRole = "category-1" | "category-2" | "category-3" | "category-4" | "category-5" | "category-6" | "category-7" | "category-8";
export type DrawioColorRole = "base" | "text" | DrawioCategoryRole;
export const DRAWIO_COLOR_ROLE_STYLE_KEY = "studioColorRole";
export const MAX_DRAWIO_COLOR_CATEGORIES = 8;
export interface NativePaletteChange { cellId: string; kind: "vertex" | "edge"; expectedStyle: string; style: string; }
export interface NativePalettePlan { theme: DrawioDiagramTheme; documentRevision: string; pageId: string | null; expectedBackground: string | null; background: string | null; expectedPageCellIds: string[]; changes: NativePaletteChange[]; }
export interface DiagramCategoryColor { fill: string; stroke: string; }
export interface DiagramThemePalette { background: string | null; baseFill: string; baseStroke: string; ink: string; edgeStroke: string; edgeFont: string; categories: readonly DiagramCategoryColor[]; }
const category = (fill: string, stroke: string): DiagramCategoryColor => ({ fill, stroke });
export const DRAWIO_DIAGRAM_THEMES: Record<DrawioDiagramTheme, DiagramThemePalette> = {
  "ocean-depths": {
    background: null, baseFill: "#9AC8D8", baseStroke: "#1F617A", ink: "#153548", edgeStroke: "#1B5368", edgeFont: "#153548",
    categories: [category("#8EC6D8", "#176B85"), category("#86CDBB", "#146D59"), category("#B6CC75", "#51741A"), category("#E5BB68", "#8E5B00"), category("#E7A8C2", "#9B315B"), category("#BEA6DC", "#6742A2"), category("#A8B9CD", "#49627E"), category("#ECAF8B", "#A64A1B")]
  },
  "sunset-boulevard": {
    background: null, baseFill: "#E9AA8F", baseStroke: "#A5432B", ink: "#542619", edgeStroke: "#9A3F29", edgeFont: "#542619",
    categories: [category("#EBA184", "#A2391B"), category("#E3BC67", "#9A5B00"), category("#E099AE", "#A32855"), category("#E8B18A", "#A04C15"), category("#C3A7DD", "#6542B8"), category("#EC8F82", "#A22620"), category("#A8C78B", "#49701A"), category("#82C8C5", "#126F74")]
  },
  "forest-canopy": {
    background: null, baseFill: "#A6C58E", baseStroke: "#315A3B", ink: "#193A29", edgeStroke: "#2D573A", edgeFont: "#193A29",
    categories: [category("#9FC28E", "#285C38"), category("#91C8A9", "#1D704C"), category("#D7BD70", "#826018"), category("#ACC88C", "#536F32"), category("#8FB9D7", "#2B5C8B"), category("#B69AD2", "#6B4192"), category("#D69F83", "#8A432D"), category("#86C4B4", "#286C5E")]
  },
  "modern-minimalist": {
    background: null, baseFill: "#B8C0CA", baseStroke: "#4B5563", ink: "#111827", edgeStroke: "#374151", edgeFont: "#1F2937",
    categories: [category("#B5BDC8", "#4B5563"), category("#A7B8CB", "#475569"), category("#A6B8D7", "#3B5B84"), category("#E5A0A3", "#A52A35"), category("#8FC4B0", "#176B52"), category("#E3BE69", "#8B5B0A"), category("#BCA7D8", "#6741A5"), category("#DBA5C4", "#963C6D")]
  },
  "golden-hour": {
    background: null, baseFill: "#E1BE6A", baseStroke: "#8A5A05", ink: "#49320F", edgeStroke: "#815607", edgeFont: "#49320F",
    categories: [category("#E6BD55", "#8C5200"), category("#E3AC7C", "#9C4913"), category("#DBA095", "#9B3D2B"), category("#BFC176", "#5F6A2B"), category("#A5C68D", "#3F6A42"), category("#8EB9D4", "#2E5D7D"), category("#B89ECF", "#66487F"), category("#D9A1B4", "#904159")]
  },
  "arctic-frost": {
    background: null, baseFill: "#9DC9DE", baseStroke: "#2D647D", ink: "#18384A", edgeStroke: "#2A5D73", edgeFont: "#18384A",
    categories: [category("#8CC6E2", "#1E6A91"), category("#82CDC6", "#087276"), category("#9EABE0", "#414EB7"), category("#B79EDB", "#6A439E"), category("#A8BDC9", "#4A647C"), category("#8BC7D6", "#1D6C7F"), category("#9FCFA2", "#347445"), category("#EDB77A", "#A0560C")]
  },
  "desert-rose": {
    background: null, baseFill: "#D8A3B2", baseStroke: "#8A4258", ink: "#4A2934", edgeStroke: "#7E3D51", edgeFont: "#4A2934",
    categories: [category("#D69BB0", "#8F2F4D"), category("#DCA18F", "#933E2F"), category("#D2BA83", "#7E5E26"), category("#A8BF9D", "#4D6B4F"), category("#9FB0D3", "#4A5C8D"), category("#BEA3C8", "#704C72"), category("#DDBE78", "#816217"), category("#88C1B6", "#2C6B67")]
  },
  "tech-innovation": {
    background: null, baseFill: "#AABBE7", baseStroke: "#2D4DB0", ink: "#172B58", edgeStroke: "#2342A0", edgeFont: "#172B58",
    categories: [category("#91AFE5", "#1746B5"), category("#83C5D6", "#086E88"), category("#A4A3E0", "#4745C7"), category("#E0A0C8", "#A52D75"), category("#94C7A9", "#147347"), category("#BCA2E5", "#6A3EB2"), category("#E4BE67", "#8D5C00"), category("#E79A9E", "#A5273D")]
  },
  "botanical-garden": {
    background: null, baseFill: "#B6C980", baseStroke: "#4E6D2C", ink: "#2D411F", edgeStroke: "#4B652B", edgeFont: "#2D411F",
    categories: [category("#B1CC7A", "#4F7029"), category("#9EC8A8", "#316F46"), category("#C4C97A", "#5E7128"), category("#E2BF65", "#7F6211"), category("#84C3B8", "#2B6B67"), category("#9EB7DF", "#3F5E92"), category("#DDA48A", "#92482E"), category("#B9A2D0", "#6D4B7D")]
  },
  "midnight-galaxy": {
    // A moonlit, indigo-led palette for the standard light canvas: no dark canvas or pale connector strokes.
    background: null, baseFill: "#ADBCE1", baseStroke: "#35436D", ink: "#1D2745", edgeStroke: "#34436F", edgeFont: "#243352",
    categories: [category("#A1B4E4", "#40558C"), category("#93C8BE", "#276B65"), category("#B8CB87", "#5A702B"), category("#E3BE7B", "#89611F"), category("#D9A3C3", "#8B426A"), category("#B4A0D8", "#604D88"), category("#D6A4A0", "#8D4B44"), category("#A3BED2", "#3E6587")]
  }
};
function directThemeChild(element: Element, name: string): Element | null {
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child?.nodeType === 1 && child.nodeName === name) return child as Element;
  }
  return null;
}
function decodeStencilXml(payload: string): string | null {
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const inflated = strFromU8(inflateSync(bytes));
    return decodeURIComponent(inflated);
  } catch {
    return null;
  }
}
function isTransparentStencilColor(value: string): boolean {
  return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)$/i.test(value.trim());
}
function neutralStencilRgb(value: string): [number, number, number] | null {
  const color = safeColor(value);
  if (!color) return null;
  let hex = color.slice(1);
  if (hex.length === 3) hex = hex.split("").map((part) => part + part).join("");
  const rgb: [number, number, number] = [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16)
  ];
  return Math.max(...rgb) - Math.min(...rgb) <= 8 ? rgb : null;
}
function isNeutralStencilMidtone(value: string): boolean {
  const rgb = neutralStencilRgb(value);
  if (!rgb) return false;
  const brightness = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return brightness >= 120 && brightness <= 245;
}
function stencilColorsAreNeutralOrCurrentFill(xml: string, currentFill: string | null, hasStableRole: boolean): boolean {
  const colors = Array.from(xml.matchAll(/\bcolor="([^"]+)"/gi), (match) => match[1]);
  if (colors.length === 0) return false;
  return colors.every((color) => isTransparentStencilColor(color) ||
    neutralStencilRgb(color) !== null ||
    (hasStableRole && Boolean(currentFill) && color.toLowerCase() === currentFill!.toLowerCase()));
}
function themedNeutralStencilShape(
  cell: DrawioDomElement,
  style: string,
  palette: DiagramThemePalette,
  role: DrawioColorRole
): string | null {
  if (cell.getAttribute("vertex") !== "1") return null;
  const geometry = directThemeChild(cell, "mxGeometry");
  const width = Number(geometry?.getAttribute("width") ?? 0);
  const height = Number(geometry?.getAttribute("height") ?? 0);
  // Only theme large, neutral stencil areas such as room/region backplates.
  // Small stencil icons, logos and other branded artwork are left byte-for-byte unchanged.
  if (!Number.isFinite(width) || !Number.isFinite(height) || width * height < 20000) return null;
  const shapeValue = styleProperty(style, "shape");
  const match = shapeValue?.match(/^stencil\(([^)]+)\)$/i);
  if (!match) return null;
  const sourceXml = decodeStencilXml(match[1]);
  if (!sourceXml) return null;
  const sourceFill = styleProperty(style, "fillColor");
  const hasStableRole = roleFromStyle(style) !== null;
  if (!stencilColorsAreNeutralOrCurrentFill(sourceXml, sourceFill, hasStableRole)) return null;
  const categoryColor = isCategoryRole(role) ? palette.categories[Number(role.slice("category-".length)) - 1] : null;
  const targetFill = categoryColor?.fill ?? palette.baseFill;
  let changed = false;
  let recolorableFills = 0;
  const nextXml = sourceXml.replace(/(<fillcolor\b[^>]*?\bcolor=")([^"]+)(")/gi, (whole, prefix: string, color: string, suffix: string) => {
    const sourceCategoryFill = hasStableRole && Boolean(sourceFill) && color.toLowerCase() === sourceFill!.toLowerCase();
    if (!isNeutralStencilMidtone(color) && !sourceCategoryFill) return whole;
    recolorableFills += 1;
    if (color.toLowerCase() === targetFill.toLowerCase()) return whole;
    changed = true;
    return prefix + targetFill + suffix;
  });
  if (recolorableFills === 0) return null;
  // An already-themed neutral backplate remains eligible, even when this palette leaves it unchanged.
  if (!changed) return "stencil(" + match[1] + ")";
  return "stencil(" + encodeBase64(deflateSync(strToU8(encodeURIComponent(nextXml)))) + ")";
}
function safeColor(value: string): string | null { const color = value.trim(); return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : null; }
function parseXml(xml: string): DrawioDomDocument | null { try { return parseDrawioXml(xml); } catch { return null; } }
export function readDrawioModelBackground(xml: string, pageId: string | null = null): string | null {
  try {
    const { model } = parseNativePageModel(xml, pageId);
    return model.getAttribute("background")?.trim() || null;
  } catch {
    return null;
  }
}
export function applyDrawioThemeBackground(xml: string, background: string): string { const color = safeColor(background); const parsed = parseXml(xml); if (!color || !parsed) return xml; const models = parsed.documentElement?.nodeName === "mxGraphModel" ? [parsed.documentElement as DrawioDomElement] : findDrawioElements(parsed, "mxGraphModel"); let changed = false; for (const model of models) { if (model.getAttribute("background") !== color) { model.setAttribute("background", color); changed = true; } } return changed ? serializeDrawioXml(parsed) : xml; }
function updateStyleProperties(style: string, values: Record<string, string>): string { const updatedKeys = new Set<string>(); const parts = style.split(";").map((part) => { const equalsAt = part.indexOf("="); if (equalsAt <= 0) return part; const key = part.slice(0, equalsAt).trim(); if (!(key in values)) return part; updatedKeys.add(key); return part.slice(0, equalsAt + 1) + values[key]; }); let result = parts.join(";"); const missing = Object.entries(values).filter(([key]) => !updatedKeys.has(key)); if (missing.length) { if (result && !result.endsWith(";")) result += ";"; result += missing.map(([key, value]) => key + "=" + value).join(";") + ";"; } return result; }
function isTextOnlyVertex(style: string): boolean { const shape = style.split(";").find((part) => part.trim().startsWith("shape="))?.split("=", 2)[1]?.trim(); if (shape === "text") return true; return style.split(";").some((part) => part.trim() === "text"); }
function styleProperty(style: string, key: string): string | null { let found: string | null = null; for (const part of String(style || "").split(";")) { const equalsAt = part.indexOf("="); if (equalsAt <= 0) continue; if (part.slice(0, equalsAt).trim() === key) found = part.slice(equalsAt + 1).trim(); } return found; }
function roleFromStyle(style: string): DrawioColorRole | null { const values = String(style || "").split(";").flatMap((part) => { const equalsAt = part.indexOf("="); return equalsAt > 0 && part.slice(0, equalsAt).trim() === DRAWIO_COLOR_ROLE_STYLE_KEY ? [part.slice(equalsAt + 1).trim()] : []; }); if (values.length === 0) return null; if (values.length !== 1) throw new Error("A Draw.io cell contains duplicate Studio color-role markers."); const value = values[0]; if (value === "base" || value === "text") return value; if (/^category-[1-8]$/.test(value)) return value as DrawioCategoryRole; throw new Error("The Draw.io cell contains an unsupported Studio color-role marker: " + value); }
function sourceColorKey(style: string, kind: "vertex" | "edge"): string | null {
  const fill = styleProperty(style, "fillColor");
  const gradient = styleProperty(style, "gradientColor");
  const stroke = styleProperty(style, "strokeColor");
  const visibleFill = fill && fill.toLowerCase() !== "none" ? fill : null;
  const visibleStroke = stroke && stroke.toLowerCase() !== "none" ? stroke : null;
  const fillKey = visibleFill ?? (fill === null && safeColor(gradient || "") ? gradient : null);
  const value = kind === "edge" ? visibleStroke : fillKey ?? visibleStroke;
  return value ? "color:" + value.trim().toLowerCase() : null;
}
function isCategoryRole(role: DrawioColorRole): role is DrawioCategoryRole { return role.startsWith("category-"); }
function assignColorRoles(cells: DrawioDomElement[]): Map<DrawioDomElement, DrawioColorRole> { const roles = new Map<DrawioDomElement, DrawioColorRole>(); const usedCategoryRoles = new Set<DrawioCategoryRole>(); const colorKeyToRole = new Map<string, DrawioColorRole>(); for (const cell of cells) { const kind = cell.getAttribute("vertex") === "1" ? "vertex" : cell.getAttribute("edge") === "1" ? "edge" : null; if (!kind) continue; const style = cell.getAttribute("style") ?? ""; const existingRole = roleFromStyle(style); if (existingRole === null) continue; const textOnly = kind === "vertex" && isTextOnlyVertex(style); if ((textOnly && existingRole !== "text") || (!textOnly && existingRole === "text")) throw new Error("A Draw.io cell has a conflicting Studio color-role marker for its native type."); roles.set(cell, existingRole); if (isCategoryRole(existingRole)) usedCategoryRoles.add(existingRole); const colorKey = sourceColorKey(style, kind); if (colorKey && !colorKeyToRole.has(colorKey)) colorKeyToRole.set(colorKey, existingRole); } const allRoles: DrawioCategoryRole[] = ["category-1", "category-2", "category-3", "category-4", "category-5", "category-6", "category-7", "category-8"]; const availableRoles = allRoles.filter((role) => !usedCategoryRoles.has(role)); for (const cell of cells) { const kind = cell.getAttribute("vertex") === "1" ? "vertex" : cell.getAttribute("edge") === "1" ? "edge" : null; if (!kind || roles.has(cell)) continue; const style = cell.getAttribute("style") ?? ""; if (kind === "vertex" && isTextOnlyVertex(style)) { roles.set(cell, "text"); continue; } const colorKey = sourceColorKey(style, kind); if (!colorKey) { roles.set(cell, "base"); continue; } const knownRole = colorKeyToRole.get(colorKey); if (knownRole) { roles.set(cell, knownRole); continue; } const nextRole = availableRoles.shift(); if (!nextRole) throw new Error("This page contains more than " + MAX_DRAWIO_COLOR_CATEGORIES + " distinct original color categories. No colors were changed; simplify or explicitly merge categories first."); usedCategoryRoles.add(nextRole); colorKeyToRole.set(colorKey, nextRole); roles.set(cell, nextRole); } return roles; }
function secondaryThemeColorValues(style: string, palette: DiagramThemePalette, role: DrawioColorRole): Record<string, string> {
  const categoryColor = isCategoryRole(role) ? palette.categories[Number(role.slice("category-".length)) - 1] : null;
  const roleFill = categoryColor?.fill ?? palette.baseFill;
  const roleStroke = categoryColor?.stroke ?? palette.baseStroke;
  const candidates: Record<string, string> = {
    gradientColor: roleFill,
    labelBackgroundColor: palette.baseFill,
    labelBorderColor: roleStroke,
    swimlaneFillColor: roleFill,
    indicatorColor: roleStroke,
    indicatorGradientColor: roleFill,
    separatorColor: roleStroke,
    fontColor2: palette.ink
  };
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidates)) {
    const existing = styleProperty(style, key);
    // Preserve absence, explicit none, and CSS expressions such as light-dark(...).
    if (existing && existing.toLowerCase() !== "none" && safeColor(existing)) result[key] = value;
  }
  return result;
}
function themeStyleValues(style: string, kind: "vertex" | "edge", palette: DiagramThemePalette, role: DrawioColorRole, cell?: DrawioDomElement): Record<string, string> | null {
  const shapeValue = styleProperty(style, "shape");
  const isInlineStencil = /^stencil\(([^)]+)\)$/i.test(shapeValue ?? "");
  const themedShape = isInlineStencil && cell ? themedNeutralStencilShape(cell, style, palette, role) : null;
  // Inline stencil assets are skipped completely unless they pass the neutral-backplate checks.
  // Recoloring only the outer style can still overwrite a logo's inherited brand colors.
  if (isInlineStencil && themedShape === null) return null;
  const categoryColor = isCategoryRole(role) ? palette.categories[Number(role.slice("category-".length)) - 1] : null;
  const secondary = secondaryThemeColorValues(style, palette, role);
  if (kind === "vertex" && (role === "text" || isTextOnlyVertex(style))) {
    return { fillColor: "none", strokeColor: "none", fontColor: palette.ink, [DRAWIO_COLOR_ROLE_STYLE_KEY]: "text", ...secondary };
  }
  if (kind === "edge") {
    return { strokeColor: categoryColor?.stroke ?? palette.edgeStroke, fontColor: categoryColor ? palette.ink : palette.edgeFont, [DRAWIO_COLOR_ROLE_STYLE_KEY]: role, ...secondary };
  }
  const fillColor = styleProperty(style, "fillColor")?.toLowerCase() === "none" ? "none" : categoryColor?.fill ?? palette.baseFill;
  return { fillColor, strokeColor: categoryColor?.stroke ?? palette.baseStroke, fontColor: palette.ink,
    [DRAWIO_COLOR_ROLE_STYLE_KEY]: role, ...secondary, ...(themedShape ? { shape: themedShape } : {}) };
}
function applyThemeToGraphModel(documentOrModel: DrawioDomDocument | DrawioDomElement, theme: DrawioDiagramTheme): number {
  const model = documentOrModel.nodeType === 9 ? (documentOrModel as DrawioDomDocument).documentElement : documentOrModel as DrawioDomElement;
  if (!model || model.nodeName !== "mxGraphModel") return 0;
  const cells = Array.from(model.getElementsByTagName("mxCell")) as DrawioDomElement[];
  const roles = assignColorRoles(cells);
  const palette = DRAWIO_DIAGRAM_THEMES[theme];
  let changed = 0;
  for (const cell of cells) {
    const kind = cell.getAttribute("vertex") === "1" ? "vertex" : cell.getAttribute("edge") === "1" ? "edge" : null;
    if (!kind) continue;
    const originalStyle = cell.getAttribute("style") ?? "";
    const role = roles.get(cell);
    if (!role) throw new Error("A colorable Draw.io cell had no stable color role.");
    const values = themeStyleValues(originalStyle, kind, palette, role, cell);
    if (!values) continue;
    const nextStyle = updateStyleProperties(originalStyle, values);
    if (nextStyle !== originalStyle) { cell.setAttribute("style", nextStyle); changed += 1; }
  }
  const currentBackground = model.getAttribute("background");
  if (palette.background === null) {
    // A neutral, unpainted canvas is the default for every curated palette.
    // Remove an existing custom/legacy theme background instead of replacing it with another tint.
    if (currentBackground !== null) {
      model.removeAttribute("background");
      changed += 1;
    }
  } else if (currentBackground !== palette.background) {
    model.setAttribute("background", palette.background);
    changed += 1;
  }
  return changed;
}
function decodeCompressedPage(page: DrawioDomElement): DrawioDomDocument | null { const payload = page.textContent?.trim() ?? ""; if (!payload) return null; try { const document = parseDrawioXml(decodeDrawioPageXml(payload)); return document.documentElement?.nodeName === "mxGraphModel" ? document : null; } catch { return null; } }
function nativeXmlCellId(cell: DrawioDomElement): string { const wrapper = cell.parentElement as DrawioDomElement | null; const wrapperId = wrapper && (wrapper.nodeName === "object" || wrapper.nodeName === "UserObject") ? wrapper.getAttribute("id") : null; return wrapperId || cell.getAttribute("id") || ""; }
function parseNativePageModel(xml: string, pageId: string | null): { model: DrawioDomElement; pageId: string | null } { const parsed = parseXml(xml); const root = parsed?.documentElement; if (!root) throw new Error("The Draw.io XML has no document element."); if (root.nodeName === "mxGraphModel") return { model: root as DrawioDomElement, pageId: null }; if (root.nodeName !== "mxfile") throw new Error("Color presets only support native Draw.io mxfile or mxGraphModel documents."); const pages = findDrawioElements(parsed as DrawioDomDocument, "diagram"); const page = pageId !== null ? pages.find((candidate) => candidate.getAttribute("id") === pageId) : pages.length === 1 ? pages[0] : undefined; if (!page) throw new Error(pageId !== null ? "The active Draw.io page no longer exists. Select the page again before applying colors." : "The Draw.io document has multiple pages but no active page ID; refusing to color the first page."); const inlineModels = Array.from(page.getElementsByTagName("mxGraphModel")) as DrawioDomElement[]; const decodedModel = inlineModels[0] ?? decodeCompressedPage(page)?.documentElement as DrawioDomElement | undefined; if (!decodedModel || decodedModel.nodeName !== "mxGraphModel") throw new Error("The active Draw.io page could not be decoded safely. No colors were changed."); return { model: decodedModel, pageId: page.getAttribute("id") || null }; }
export function calculateNativePalettePlan(xml: string, pageId: string | null, documentRevision: string, theme: DrawioDiagramTheme): NativePalettePlan { if (!/^[a-f0-9]{64}$/i.test(documentRevision)) throw new Error("Diagram colors require the revision of the exact native Draw.io XML snapshot."); const palette = DRAWIO_DIAGRAM_THEMES[theme]; if (!palette) throw new Error("Unsupported Draw.io diagram color preset."); const parsed = parseNativePageModel(xml, pageId); const cells = Array.from(parsed.model.getElementsByTagName("mxCell")) as DrawioDomElement[]; const ids = cells.map(nativeXmlCellId); if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("The active page has missing or duplicate cell IDs; no color changes were planned."); const roles = assignColorRoles(cells); const changes: NativePaletteChange[] = []; for (const cell of cells) { const kind = cell.getAttribute("vertex") === "1" ? "vertex" : cell.getAttribute("edge") === "1" ? "edge" : null; if (!kind) continue; const cellId = nativeXmlCellId(cell); const expectedStyle = cell.getAttribute("style") ?? ""; const role = roles.get(cell); if (!role) throw new Error("A colorable Draw.io cell had no stable color role."); const values = themeStyleValues(expectedStyle, kind, palette, role, cell); if (!values) continue; const style = updateStyleProperties(expectedStyle, values); if (style !== expectedStyle) changes.push({ cellId, kind, expectedStyle, style }); } return {
    theme, documentRevision, pageId: parsed.pageId,
    expectedBackground: parsed.model.getAttribute("background")?.trim() || null,
    background: palette.background,
    expectedPageCellIds: ids.sort(), changes
  }; }
export function detectDrawioDiagramTheme(xml: string, pageId: string | null): DrawioDiagramTheme | "" {
  try {
    const { model } = parseNativePageModel(xml, pageId);
    const cells = (Array.from(model.getElementsByTagName("mxCell")) as DrawioDomElement[])
      .map((cell) => ({
        cell,
        kind: cell.getAttribute("vertex") === "1" ? "vertex" as const : cell.getAttribute("edge") === "1" ? "edge" as const : null,
        style: cell.getAttribute("style") ?? ""
      }))
      .filter((cell): cell is { cell: DrawioDomElement; kind: "vertex" | "edge"; style: string } => cell.kind !== null);
    if (cells.length === 0) return "";
    const assignedRoles = assignColorRoles(cells.map((cell) => cell.cell));
    const eligibilityPalette = DRAWIO_DIAGRAM_THEMES["ocean-depths"];
    const themeable = cells.flatMap((cell) => {
      const storedRole = roleFromStyle(cell.style);
      const role = storedRole ?? assignedRoles.get(cell.cell);
      if (!role) return [];
      const values = themeStyleValues(cell.style, cell.kind, eligibilityPalette, role, cell.cell);
      // Inline stencils that fail safety checks are intentionally excluded; all other cells
      // must carry persisted roles before the current theme can be reported as known.
      if (!values) return [];
      return [{ ...cell, role, storedRole }];
    });
    if (themeable.length === 0 || themeable.some((cell) => cell.storedRole === null)) return "";
    for (const theme of Object.keys(DRAWIO_DIAGRAM_THEMES) as DrawioDiagramTheme[]) {
      const palette = DRAWIO_DIAGRAM_THEMES[theme];
      if ((model.getAttribute("background")?.trim() || null) !== palette.background) continue;
      if (themeable.every((cell) => {
        const values = themeStyleValues(cell.style, cell.kind, palette, cell.role, cell.cell);
        return values !== null && updateStyleProperties(cell.style, values) === cell.style;
      })) return theme;
    }
    return "";
  } catch {
    return "";
  }
}
function encodeBase64(bytes: Uint8Array): string { let binary = ""; const chunkSize = 0x8000; for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))); return btoa(binary); }
function encodeCompressedPage(document: DrawioDomDocument): string { const encodedXml = encodeURIComponent(serializeDrawioXml(document)); return encodeBase64(deflateSync(strToU8(encodedXml))); }
export function applyDrawioDiagramTheme(xml: string, theme: DrawioDiagramTheme): string { const palette = DRAWIO_DIAGRAM_THEMES[theme]; const parsed = parseXml(xml); if (!palette || !parsed) return xml; let changed = 0; const rootName = parsed.documentElement?.nodeName; if (rootName === "mxGraphModel") changed += applyThemeToGraphModel(parsed, theme); else if (rootName === "mxfile") { changed += findDrawioElements(parsed, "mxGraphModel").reduce((count, model) => count + applyThemeToGraphModel(model, theme), 0); for (const page of findDrawioElements(parsed, "diagram")) { if (findDrawioElements(page.ownerDocument as DrawioDomDocument, "mxGraphModel").some((model) => isDescendantOf(model, page))) continue; const decoded = decodeCompressedPage(page); if (!decoded) continue; const pageChanges = applyThemeToGraphModel(decoded, theme); if (pageChanges > 0) { page.textContent = encodeCompressedPage(decoded); changed += pageChanges; } } } return changed > 0 ? serializeDrawioXml(parsed) : xml; }
function isDescendantOf(node: Node, ancestor: Node): boolean { let current: Node | null = node; while (current) { if (current === ancestor) return true; current = current.parentNode; } return false; }
