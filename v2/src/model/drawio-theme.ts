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
