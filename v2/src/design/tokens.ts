export const tokens = {
  canvas: "#F6F7F9",
  canvasGrid: "#E7EAF0",
  surface: "#FFFFFF",
  surfaceMuted: "#F8FAFC",
  border: "#D8DEE8",
  borderStrong: "#AEB9C9",
  ink: "#1A2738",
  inkSecondary: "#536276",
  inkMuted: "#8995A6",
  accent: "#425BC7",
  accentSoft: "#EEF1FF",
  accentBorder: "#B8C4FF",
  teal: "#2E7778",
  tealSoft: "#EAF5F3",
  amber: "#9B6B25",
  amberSoft: "#FBF4E8",
  external: "#F7F4EE",
  externalBorder: "#D9CBB4",
  danger: "#B74E4E",
  success: "#35745E",
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