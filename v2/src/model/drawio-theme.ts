/**
 * Maps the Studio's resolved CSS theme tokens to Draw.io's native presentation.
 *
 * The mxfile remains the only document source of truth. Only the mxGraphModel
 * background attribute is theme-managed; cell styles are deliberately untouched
 * so business-semantic colours and user-authored shape styling remain intact.
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
