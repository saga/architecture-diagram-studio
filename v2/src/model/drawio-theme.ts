import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

/**
 * The application theme is presentation-only. Draw.io XML remains the user's document
 * and is never rewritten just because the Studio chrome theme changed.
 */
export interface DrawioThemePalette {
  canvas: string;
  panel: string;
  text: string;
  secondary: string;
  muted: string;
  border: string;
  accent: string;
  soft: string;
}

function safeColor(value: string): string | null {
  const color = value.trim();
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : null;
}

function parseXml(xml: string): Document | null {
  const errors: string[] = [];
  const parsed = new DOMParser({
    onError: (level, message) => { if (level !== "warning") errors.push(message); }
  }).parseFromString(xml, "application/xml");
  return errors.length || !parsed.documentElement ? null : parsed as unknown as Document;
}

/** Read the saved background without editing or normalizing the authoritative XML. */
export function readDrawioModelBackground(xml: string): string | null {
  const parsed = parseXml(xml);
  if (!parsed) return null;
  const models = parsed.getElementsByTagName("mxGraphModel");
  if (!models.length) return null;
  const background = models.item(0)?.getAttribute("background");
  return background && safeColor(background) ? background : null;
}

/**
 * Compatibility utility for explicit document-background edits only. Uses a real XML DOM;
 * callers must not use it for UI theme changes. Invalid XML/colors are returned untouched.
 */
export function applyDrawioThemeBackground(xml: string, background: string): string {
  const color = safeColor(background);
  const parsed = parseXml(xml);
  if (!color || !parsed) return xml;
  const models = parsed.getElementsByTagName("mxGraphModel");
  if (!models.length) return xml;
  let changed = false;
  for (let index = 0; index < models.length; index += 1) {
    const model = models.item(index);
    if (model && model.getAttribute("background") !== color) {
      model.setAttribute("background", color);
      changed = true;
    }
  }
  return changed ? new XMLSerializer().serializeToString(parsed) : xml;
}

/** CSS injected into the same-origin native editor iframe; it does not rewrite cell styles. */
export function drawioFrameThemeCss(palette: DrawioThemePalette): string {
  const canvas = safeColor(palette.canvas) ?? "#ffffff";
  const panel = safeColor(palette.panel) ?? "#ffffff";
  const text = safeColor(palette.text) ?? "#172033";
  const secondary = safeColor(palette.secondary) ?? text;
  const muted = safeColor(palette.muted) ?? secondary;
  const border = safeColor(palette.border) ?? "#d0d7e2";
  const accent = safeColor(palette.accent) ?? "#425bc7";
  const soft = safeColor(palette.soft) ?? "#e8edff";
  return `
    html, body, #geInfo, #geMenubar, #geToolbarContainer, #geSidebar,
    #geFooter, .geToolbarContainer, .geSidebar, .geMenubarContainer {
      background-color: ${panel} !important; color: ${text} !important;
    }
    body, #geDiagramContainer, .geDiagramContainer, .geDiagramContainer svg {
      background-color: ${canvas} !important;
    }
    #geMenubar a, #geToolbarContainer button, #geToolbarContainer .geButton,
    #geSidebar button, #geSidebar .geButton, #geFooter, .geToolbarContainer button {
      color: ${text} !important;
    }
    #geMenubar a:hover, #geToolbarContainer button:hover, #geToolbarContainer .geButton:hover,
    #geSidebar button:hover, #geSidebar .geButton:hover {
      background-color: ${soft} !important;
    }
    #geToolbarContainer button, #geToolbarContainer .geButton, #geSidebar button,
    #geSidebar .geButton { border-color: ${border} !important; }
    #geToolbarContainer button:focus-visible, #geToolbarContainer .geButton:focus-visible {
      outline-color: ${accent} !important;
    }
    #geDiagramContainer, .geDiagramContainer { color: ${secondary} !important; }
    .geHint, .geToolbarHint { color: ${muted} !important; }
  `;
}

/** Kept as a no-op compatibility export: diagram colors are user-authored XML data. */
export function applyDrawioCellThemeReversible(xml: string, _theme: "editorial" | "youth" | "warm" | "midnight"): string {
  return xml;
}

/** Kept as a no-op compatibility export: UI themes must never mutate the source document. */
export function applyDrawioThemeBackgroundReversible(xml: string, _background: string, _theme: "editorial" | "youth" | "warm" | "midnight"): string {
  return xml;
}
