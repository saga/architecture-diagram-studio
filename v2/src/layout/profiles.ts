export type ElkLayoutProfile = "elk-layered" | "elk-mrtree" | "elk-radial" | "elk-stress" | "elk-force";
export type LayoutProfile = ElkLayoutProfile | "dagre-layered";

export interface LayoutProfileOption {
  value: LayoutProfile;
  label: string;
  description: string;
}

/**
 * Single source of truth for layout engines exposed by the UI and accepted by
 * the layout dispatcher. Direction is a separate option shared by all engines.
 */
export const LAYOUT_PROFILES: LayoutProfileOption[] = [
  { value: "elk-layered", label: "ELK · 层级", description: "适用于 C4 与流程图，支持语义分层和边路由" },
  { value: "dagre-layered", label: "Dagre · 层级", description: "轻量快速的有向图布局，支持横向和纵向" },
  { value: "elk-mrtree", label: "ELK · 树形", description: "适用于树状依赖与层次结构" },
  { value: "elk-radial", label: "ELK · 放射", description: "围绕中心节点组织关系" },
  { value: "elk-stress", label: "ELK · 应力", description: "按图结构分布节点，适合网状关系" },
  { value: "elk-force", label: "ELK · 力导向", description: "适用于探索式关系网络" },
];

export function resolveLayoutProfile(value: string): LayoutProfile {
  return LAYOUT_PROFILES.some((profile) => profile.value === value)
    ? value as LayoutProfile
    : "elk-layered";
}
