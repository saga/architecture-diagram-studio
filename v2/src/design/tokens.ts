export const tokens = {
  // Diagram palette. Node borders and label ink are deliberately dark: the canvas is a dense
  // technical drawing, so a 1.2px hairline in #D8DEE8 disappeared against a near-white page.
  canvas: "#F3F5FA",
  canvasGrid: "#C7D1E0",
  surface: "#FFFFFF",
  surfaceMuted: "#EFF3F9",
  border: "#7E8EA6",
  borderStrong: "#5A6B84",
  ink: "#0C1626",
  inkSecondary: "#2E4056",
  inkMuted: "#53637A",
  accent: "#2A42B4",
  accentSoft: "#E1E7FF",
  accentBorder: "#8497EC",
  teal: "#1D6667",
  tealSoft: "#DCF0EE",
  amber: "#8A5610",
  amberSoft: "#F8E9CB",
  external: "#FAF0DC",
  externalBorder: "#B08A52",
  danger: "#A63B3B",
  success: "#25624C",
  radius: 10,
  nodeRadius: 9,
  grid: 8,
  nodeSpacing: 52,
  layerSpacing: 104,
  font: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
} as const;

export const roleLabels: Record<string, string> = {
  actor: "Actor", source: "Source", entry: "Entry",
  ui: "UI", domain: "Domain", business: "Business",
  api: "API", worker: "Worker", data: "Data",
  storage: "Storage", external: "External", vendor: "Vendor",
  infra: "Infra", decision: "Decision",
  start: "Start", end: "End", service: "Service"
};
