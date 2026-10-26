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
export interface NativePalettePlan { theme: DrawioDiagramTheme; documentRevision: string; pageId: string | null; expectedBackground: string | null; background: string; expectedPageCellIds: string[]; changes: NativePaletteChange[]; }
export interface DiagramCategoryColor { fill: string; stroke: string; }
export interface DiagramThemePalette { background: string; baseFill: string; baseStroke: string; ink: string; edgeStroke: string; edgeFont: string; categories: readonly DiagramCategoryColor[]; }
const category = (fill: string, stroke: string): DiagramCategoryColor => ({ fill, stroke });
export const DRAWIO_DIAGRAM_THEMES: Record<DrawioDiagramTheme, DiagramThemePalette> = {
  "ocean-depths": {
    background: "#C5DDE7", baseFill: "#D9EDF6", baseStroke: "#1F617A", ink: "#153548", edgeStroke: "#1B5368", edgeFont: "#153548",
    categories: [category("#B7DDEB", "#176B85"), category("#B7E6D9", "#146D59"), category("#D8E8A4", "#557A1B"), category("#FFE0A1", "#956000"), category("#F4C4D6", "#9B315B"), category("#D9C9F0", "#6742A2"), category("#CAD8E7", "#49627E"), category("#FFD0B2", "#A64A1B")]
  },
  "sunset-boulevard": {
    background: "#F3C9B3", baseFill: "#FFE0CF", baseStroke: "#A5432B", ink: "#542619", edgeStroke: "#9A3F29", edgeFont: "#542619",
    categories: [category("#FFC2A4", "#B33F1D"), category("#FFD778", "#9A5B00"), category("#F6B6CC", "#A32855"), category("#FFD2A3", "#A85016"), category("#D7C7FF", "#6542B8"), category("#FFB4A6", "#B42A24"), category("#C8E5A1", "#4D761B"), category("#A8E7E6", "#126F74")]
  },
  "forest-canopy": {
    background: "#C3D8B7", baseFill: "#D5E7C8", baseStroke: "#315A3B", ink: "#193A29", edgeStroke: "#2D573A", edgeFont: "#193A29",
    categories: [category("#B4D7A8", "#285C38"), category("#A9DFC1", "#1E7650"), category("#E7D58D", "#826018"), category("#C2D7A1", "#536F32"), category("#BCD8F0", "#2B5C8B"), category("#D8B9EF", "#71449A"), category("#EBC0AB", "#91462F"), category("#A9D9D0", "#286C5E")]
  },
  "modern-minimalist": {
    background: "#D4D8DE", baseFill: "#E4E7EB", baseStroke: "#4B5563", ink: "#111827", edgeStroke: "#374151", edgeFont: "#1F2937",
    categories: [category("#D1D5DB", "#4B5563"), category("#CBD5E1", "#475569"), category("#D9E2F2", "#3B5B84"), category("#F6D0D0", "#A52A35"), category("#BFE7D6", "#176B52"), category("#F9E0A6", "#8B5B0A"), category("#D9CEF3", "#6741A5"), category("#F0CDE0", "#963C6D")]
  },
  "golden-hour": {
    background: "#EAD18A", baseFill: "#FCE6A6", baseStroke: "#8A5A05", ink: "#49320F", edgeStroke: "#815607", edgeFont: "#49320F",
    categories: [category("#FFD76D", "#8C5200"), category("#F7C38B", "#A44D14"), category("#F0B8A4", "#9B3D2B"), category("#D7D98E", "#64702D"), category("#BBDD9E", "#3F6A42"), category("#B8D9F0", "#2E5D7D"), category("#D8C4EF", "#71508D"), category("#EBC2D2", "#98445E")]
  },
  "arctic-frost": {
    background: "#C1DFEC", baseFill: "#D9EDF7", baseStroke: "#2D647D", ink: "#18384A", edgeStroke: "#2A5D73", edgeFont: "#18384A",
    categories: [category("#B8DFF2", "#1E6A91"), category("#A7E6E2", "#087E83"), category("#C4D4FF", "#414EB7"), category("#D9C7F8", "#7046A6"), category("#CFDFED", "#4A647C"), category("#AEDBE5", "#1F7286"), category("#C6E9C8", "#377A49"), category("#FFE0B5", "#A85A0D")]
  },
  "desert-rose": {
    background: "#E3B9C4", baseFill: "#F1D5DA", baseStroke: "#8A4258", ink: "#4A2934", edgeStroke: "#7E3D51", edgeFont: "#4A2934",
    categories: [category("#E8B9C5", "#8F2F4D"), category("#F1C3B5", "#A34434"), category("#E8D1A7", "#8C682A"), category("#CBDDBF", "#4D6B4F"), category("#C7D2E9", "#4A5C8D"), category("#D9C3E3", "#765078"), category("#F4DEA0", "#8F6C19"), category("#B8DBD4", "#2E716C")]
  },
  "tech-innovation": {
    background: "#C0CDF2", baseFill: "#DAE6FF", baseStroke: "#2D4DB0", ink: "#172B58", edgeStroke: "#2342A0", edgeFont: "#172B58",
    categories: [category("#B7CDFE", "#1746B5"), category("#A9E7F3", "#087A96"), category("#C7CEFF", "#4745C7"), category("#F5C5E0", "#A52D75"), category("#B9E8CE", "#15794B"), category("#DDC5FF", "#7041BB"), category("#FFE092", "#946100"), category("#FFC4C8", "#B72B43")]
  },
  "botanical-garden": {
    background: "#C7D894", baseFill: "#DCE9B8", baseStroke: "#4E6D2C", ink: "#2D411F", edgeStroke: "#4B652B", edgeFont: "#2D411F",
    categories: [category("#C8E09D", "#53762B"), category("#B6DFC0", "#34754A"), category("#D8E2A0", "#687D2C"), category("#F2D98B", "#8D6C13"), category("#A9DBD4", "#2F7772"), category("#BFD2EF", "#42639A"), category("#F0C6AC", "#AA5435"), category("#D9C9E8", "#79538B")]
  },
  "midnight-galaxy": {
    background: "#10172A", baseFill: "#1D2540", baseStroke: "#A9BDF7", ink: "#F5F7FF", edgeStroke: "#B8C7FF", edgeFont: "#DCE4FF",
    categories: [category("#27375A", "#6AC7FF"), category("#1F403D", "#67E8C7"), category("#3D4028", "#D9F775"), category("#4B3923", "#FFD166"), category("#4B2D44", "#FF9BD2"), category("#30264D", "#BEA4FF"), category("#4B2932", "#FFB4A2"), category("#263D51", "#A9D2FF")]
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
  if (model.getAttribute("background") !== palette.background) {
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
