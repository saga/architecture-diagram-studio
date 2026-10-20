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
  actor: "Actor / 用户", source: "Source / 来源", entry: "Entry / 入口",
  ui: "UI / 界面", domain: "Domain / 领域", business: "Business / 业务",
  api: "API / 服务接口", worker: "Worker / 集成", data: "Data / 数据",
  storage: "Storage / 存储", external: "External / 外部", vendor: "Vendor / 供应商",
  infra: "Infra / 基础设施", decision: "Decision / 决策",
  start: "Start / 开始", end: "End / 结束", service: "Service / 处理步骤"
};