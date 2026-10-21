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
  { value: "elk-layered", label: "ELK · Layered", description: "Layered layout for C4 and flowcharts, with semantic ranks and edge routing" },
  { value: "dagre-layered", label: "Dagre · Layered", description: "Lightweight directed layout, horizontal or vertical" },
  { value: "elk-mrtree", label: "ELK · Tree", description: "For tree-shaped dependencies and hierarchies" },
  { value: "elk-radial", label: "ELK · Radial", description: "Organizes relations around a central node" },
  { value: "elk-stress", label: "ELK · Stress", description: "Distributes nodes by graph structure, suited to meshes" },
  { value: "elk-force", label: "ELK · Force", description: "For exploratory relation networks" },
];

export function resolveLayoutProfile(value: string): LayoutProfile {
  return LAYOUT_PROFILES.some((profile) => profile.value === value)
    ? value as LayoutProfile
    : "elk-layered";
}
