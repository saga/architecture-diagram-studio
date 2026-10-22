/**
 * The application theme controls editor chrome and graph background only.
 * Cell styles are user-authored diagram data and must never be recoloured by a UI theme.
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

const DIAGRAM_THEME_COLORS: Record<"editorial" | "youth" | "warm" | "midnight", Record<string, string>> = {
  editorial: { fillColor: "#ffffff", strokeColor: "#64748b", fontColor: "#172033", startFillColor: "#ffffff", endFillColor: "#64748b" },
  youth: { fillColor: "#fce7f3", strokeColor: "#b91f6d", fontColor: "#831843", startFillColor: "#fce7f3", endFillColor: "#b91f6d" },
  warm: { fillColor: "#fff7ed", strokeColor: "#ad4d32", fontColor: "#4a2b20", startFillColor: "#fff7ed", endFillColor: "#ad4d32" },
  midnight: { fillColor: "#1e293b", strokeColor: "#818cf8", fontColor: "#f8fafc", startFillColor: "#1e293b", endFillColor: "#818cf8" }
};

/** Recolour explicit mxCell colours with reversible original-value metadata. */
export function applyDrawioCellThemeReversible(xml: string, theme: "editorial" | "youth" | "warm" | "midnight"): string {
  const palette = DIAGRAM_THEME_COLORS[theme];
  return xml.replace(/<mxCell\\b([^<>]*?)\\sstyle=(["\x27])([\\s\\S]*?)\\2([^<>]*?)\\/?\\s*>/g, (tag, before: string, quote: string, style: string, after: string) => {
    const values = new Map(style.split(";").filter(Boolean).map((entry) => { const i = entry.indexOf("="); return i < 0 ? [entry, "1"] : [entry.slice(0, i), entry.slice(i + 1)]; }));
    const next = new Map(values);
    for (const key of ["fillColor", "strokeColor", "fontColor", "startFillColor", "endFillColor"]) {
      const suffix = key[0].toUpperCase() + key.slice(1), originalKey = "studioThemeOriginal" + suffix, appliedKey = "studioThemeApplied" + suffix, overrideKey = "studioThemeOverride" + suffix;
      const current = values.get(key) ?? null, applied = values.get(appliedKey) ?? null;
      if (values.get(overrideKey) === "1" || (applied !== null && current !== applied)) { next.set(overrideKey, "1"); next.delete(originalKey); next.delete(appliedKey); continue; }
      if (theme === "editorial") { if (values.has(originalKey)) { const original = values.get(originalKey)!; if (original === "__none__") next.delete(key); else next.set(key, original); next.delete(originalKey); next.delete(appliedKey); } }
      else if (current && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(current)) { if (!values.has(originalKey)) next.set(originalKey, current); next.set(key, palette[key]); next.set(appliedKey, palette[key]); }
    }
    const nextStyle = [...next].map(([key, value]) => key + "=" + value).join(";") + (next.size ? ";" : "");
    return "<mxCell" + before + "style=" + quote + nextStyle + quote + after + ">";
  });
}

/** Reversible background theme adapter; explicit user changes are preserved as overrides. */
export function applyDrawioThemeBackgroundReversible(xml: string, background: string, theme: "editorial" | "youth" | "warm" | "midnight"): string {
  const color = safeColor(background);
  if (!color) return xml;
  return xml.replace(/<mxGraphModel\b([^<>]*?)(\/?)>/g, (_tag, attributes: string, selfClosing: string) => {
    const read = (key: string) => {
      const match = new RegExp(key + '="([^"]*)"').exec(attributes);
      return match?.[1] ?? null;
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
