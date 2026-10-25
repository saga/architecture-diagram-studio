/**
 * Application presentation-only CSS for Draw.io chrome. Diagram XML styling is implemented
 * separately by the native document style library (see ADR-0019).
 */
export interface DrawioThemePalette {
  /** Outer whitespace around the native page; never the document SVG or page itself. */
  canvas: string;
  panel: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  soft: string;
}

function safeColor(value: string, fallback: string): string {
  const color = value.trim();
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) ? color : fallback;
}

/** CSS injected into the native editor iframe. Never target the graph SVG or document page. */
export function drawioFrameThemeCss(palette: DrawioThemePalette): string {
  const canvas = safeColor(palette.canvas, "#ffffff");
  const panel = safeColor(palette.panel, "#ffffff");
  const text = safeColor(palette.text, "#172033");
  const muted = safeColor(palette.muted, "#64748b");
  const border = safeColor(palette.border, "#d0d7e2");
  const accent = safeColor(palette.accent, "#425bc7");
  const soft = safeColor(palette.soft, "#e8edff");
  return `
    html, body, #geInfo, #geMenubar, #geToolbarContainer, #geSidebar,
    #geFooter, .geToolbarContainer, .geSidebar, .geMenubarContainer {
      background-color: ${panel} !important; color: ${text} !important;
    }
    /* Draw.io paints the document page and grid beneath the graph SVG. Keep this rule
       restricted to body whitespace; styling SVG/page surfaces hides user-authored XML. */
    body { background-color: ${canvas} !important; }
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
    .geHint, .geToolbarHint { color: ${muted} !important; }
  `;
}
