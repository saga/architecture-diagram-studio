/**
 * Draw.io XML remains the single source of truth. Theme-managed cell colours keep
 * their original values in ignored Studio metadata so switching to Editorial is lossless.
 * A colour differing from the last theme-applied value is treated as a user override.
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

/** Update explicit mxGraphModel backgrounds without reserializing or normalizing XML. */
export function applyDrawioThemeBackground(xml: string, background: string): string {
  const color = safeColor(background);
  if (!color) return xml;
  return xml.replace(/<mxGraphModel\b([^<>]*?)(\/?)>/g, (_tag, attributes: string, selfClosing: string) => {
    const withoutBackground = attributes.replace(/\s+background=(["'])[^"']*\1/i, "").replace(/\s+$/, "");
    return '<mxGraphModel' + withoutBackground + ' background="' + color + '"' + selfClosing + '>';
  });
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

type ThemeName = "editorial" | "youth" | "warm" | "midnight";
const COLOR_KEYS = ["fillColor", "strokeColor", "fontColor", "startFillColor", "endFillColor"] as const;
const ORIGINAL_PREFIX = "studioThemeOriginal";
const APPLIED_PREFIX = "studioThemeApplied";
const OVERRIDE_PREFIX = "studioThemeOverride";

function styleEntries(style: string): Map<string, string> {
  return new Map(style.split(";").filter(Boolean).map((entry) => {
    const index = entry.indexOf("=");
    return index < 0 ? [entry, "1"] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
}
function setStyleValue(style: Map<string, string>, key: string, value: string | null) {
  if (value === null) style.delete(key); else style.set(key, value);
}
function styleString(style: Map<string, string>): string {
  return [...style].map(([key, value]) => key + "=" + value).join(";") + ";";
}
function decodeXmlAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function encodeXmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function themedColor(key: typeof COLOR_KEYS[number], edge: boolean, palette: DrawioThemePalette): string {
  if (key === "fontColor") return palette.text;
  if (key === "fillColor" || key === "startFillColor" || key === "endFillColor") return edge ? palette.canvas : palette.soft;
  return edge ? palette.accent : palette.border;
}

/**
 * Applies theme colours to uncompressed native mxGraphModel cell styles.
 * Original values and last-applied values are stored as ignored style keys. If
 * a user/property/Copilot edit changes a managed colour, that colour becomes an
 * explicit override and is never recoloured by subsequent theme changes.
 */
export function applyDrawioThemeStyles(xml: string, theme: ThemeName, palette: DrawioThemePalette): string {
  if (!/<mxGraphModel\b/.test(xml) || /<diagram\b[^>]*>\s*[A-Za-z0-9+/]{80,}={0,2}\s*<\/diagram>/i.test(xml)) return xml;
  const color = (value: string) => safeColor(value) ?? value;
  return xml.replace(/<mxCell\b[^<>]*>/g, (cellTag) => {
    const attr = /\bstyle=(["\'])([\s\S]*?)\1/.exec(cellTag);
    const edge = /\bedge=(["\'])1\1/.test(cellTag);
    const vertex = /\bvertex=(["\'])1\1/.test(cellTag);
    if (!attr && (!edge && !vertex || theme === "editorial")) return cellTag;
    const rawStyle = attr ? decodeXmlAttribute(attr[2]) : "";
    const values = styleEntries(rawStyle);
    let changed = !attr;
    for (const key of COLOR_KEYS) {
      const originalKey = ORIGINAL_PREFIX + key[0].toUpperCase() + key.slice(1);
      const appliedKey = APPLIED_PREFIX + key[0].toUpperCase() + key.slice(1);
      const overrideKey = OVERRIDE_PREFIX + key[0].toUpperCase() + key.slice(1);
      const current = values.get(key) ?? null;
      const previousApplied = values.get(appliedKey) ?? null;
      const originalStored = values.has(originalKey);
      const overridden = values.get(overrideKey) === "1" ||
        (previousApplied !== null && current !== previousApplied);
      if (overridden) {
        if (values.get(overrideKey) !== "1") { values.set(overrideKey, "1"); changed = true; }
        values.delete(originalKey); values.delete(appliedKey);
        continue;
      }
      if (theme === "editorial") {
        if (originalStored) {
          setStyleValue(values, key, values.get(originalKey) === "__none__" ? null : values.get(originalKey)!);
          values.delete(originalKey); values.delete(appliedKey); changed = true;
        }
        continue;
      }
      if (!originalStored) {
        values.set(originalKey, current ?? "__none__");
        changed = true;
      }
      const next = color(themedColor(key, edge, palette));
      if (current !== next) { values.set(key, next); changed = true; }
      if (previousApplied !== next) { values.set(appliedKey, next); changed = true; }
    }
    if (!changed) return cellTag;
    const replacement = encodeXmlAttribute(styleString(values));
    if (!attr) return cellTag.slice(0, -1) + ' style="' + replacement + '">';
    if (!attr) return cellTag.slice(0, -1) + ' style="' + replacement + '">';
    return cellTag.slice(0, attr.index) + 'style="' + replacement + '"' + cellTag.slice(attr.index + attr[0].length);
  });
}

/** Reversible background theme adapter; explicit user changes are preserved as overrides. */
export function applyDrawioThemeBackgroundReversible(xml: string, background: string, theme: ThemeName): string {
  const color = safeColor(background);
  if (!color) return xml;
  return xml.replace(/<mxGraphModel\b([^<>]*?)(\/?)>/g, (_tag, attributes: string, selfClosing: string) => {
    const read = (key: string) => {
      const match = new RegExp("\\b" + key + '="([^"]*)"').exec(attributes);
      return match?.[2] ?? null;
    };
    const write = (attrs: string, key: string, value: string | null) => {
      const pattern = new RegExp("\\s+" + key + '="[^"]*"', "i");
      return value === null ? attrs.replace(pattern, "") : pattern.test(attrs)
        ? attrs.replace(pattern, " " + key + '="' + value + '"')
        : attrs + " " + key + '="' + value + '"';
    };
    let nextAttrs = attributes;
    const current = read("background");
    const original = read("studioThemeOriginalBackground");
    const applied = read("studioThemeAppliedBackground");
    const overridden = read("studioThemeOverrideBackground") === "1" || (applied !== null && current !== applied);
    if (overridden) {
      nextAttrs = write(nextAttrs, "studioThemeOverrideBackground", "1");
      nextAttrs = write(nextAttrs, "studioThemeOriginalBackground", null);
      nextAttrs = write(nextAttrs, "studioThemeAppliedBackground", null);
    } else if (theme === "editorial") {
      if (original !== null) {
        nextAttrs = write(nextAttrs, "background", original === "__none__" ? null : original);
        nextAttrs = write(nextAttrs, "studioThemeOriginalBackground", null);
        nextAttrs = write(nextAttrs, "studioThemeAppliedBackground", null);
      }
    } else {
      if (original === null) nextAttrs = write(nextAttrs, "studioThemeOriginalBackground", current ?? "__none__");
      if (current !== color) nextAttrs = write(nextAttrs, "background", color);
      if (applied !== color) nextAttrs = write(nextAttrs, "studioThemeAppliedBackground", color);
    }
    return '<mxGraphModel' + nextAttrs + selfClosing + '>';
  });
}
