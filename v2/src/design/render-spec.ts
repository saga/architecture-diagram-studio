import type { DiagramNode, DiagramRenderTheme, SequenceFragment } from "../model/types";

export const DIAGRAM_FONT = "Arial";
export const DIAGRAM_FONT_STACK = "Arial, Helvetica, sans-serif";

export const RENDER_METRICS = {
  title: { size: 13, weight: 600 },
  secondary: { size: 10, weight: 400 },
  relationLabel: { size: 13, weight: 400 },
  boundaryLabel: { size: 10, weight: 400 },
  fragmentLabel: { size: 11, weight: 400 },
  node: { strokeWidth: 1.4, radius: 8, pillArcSize: 50, accentWidth: 3.4, accentInsetX: 9, accentInsetY: 13 },
  relation: {
    strokeWidth: 1.5, dependencyStrokeWidth: 1.25, returnStrokeWidth: 1.3, asyncStrokeWidth: 1.45,
    dashPattern: "5 5", lifelineDashPattern: "3 5", lifelineStrokeWidth: 1,
    labelOffsetY: 8, labelGap: 8, labelBackgroundOffsetY: 14, labelBackgroundHeight: 22, labelTextBaselineOffsetY: 2, arrowSize: 7
  },
  boundary: { radius: 8, strokeWidth: 1, dashPattern: "3 5", titleSize: 10 },
  fragment: { radius: 5, strokeWidth: 1, dashPattern: "5 4", tagRadius: 4, tagHeight: 24 },
  sequence: {
    timelineY: 148, messageSpacing: 72, lifelineBottomPadding: 62,
    activationWidth: 14, activationStartInset: 5, activationEndInset: 5, activationMinHeight: 12
  }
} as const;

export interface DiagramPalette {
  canvas: string;
  grid: string;
  surface: string;
  ink: string;
  inkSecondary: string;
  inkMuted: string;
  accent: string;
  selected: string;
  border: string;
  borderStrong: string;
  actorFill: string;
  actorStroke: string;
  actorAccent: string;
  normalFill: string;
  normalStroke: string;
  normalAccent: string;
  applicationFill: string;
  applicationStroke: string;
  applicationAccent: string;
  storageFill: string;
  storageStroke: string;
  storageAccent: string;
  externalFill: string;
  externalStroke: string;
  externalAccent: string;
  infraFill: string;
  infraStroke: string;
  infraAccent: string;
  decisionFill: string;
  decisionStroke: string;
  decisionText: string;
  startFill: string;
  startStroke: string;
  startText: string;
  boundaryFill: string;
  boundaryOpacity: number;
  boundaryStroke: string;
  boundaryText: string;
  fragmentFill: string;
  fragmentOpacity: number;
  fragmentStroke: string;
  fragmentTagFill: string;
  fragmentTagStroke: string;
  fragmentText: string;
  lifelineStroke: string;
  activationFill: string;
  activationStroke: string;
  relationStroke: string;
  returnRelationStroke: string;
  asyncRelationStroke: string;
  dependencyStroke: string;
  relationLabelBackground: string;
  relationLabelText: string;
}

const PALETTES: Record<DiagramRenderTheme, DiagramPalette> = {
  editorial: {
    canvas: "#F3F5FA", grid: "#C7D1E0", surface: "#FFFFFF",
    ink: "#0C1626", inkSecondary: "#2E4056", inkMuted: "#53637A",
    accent: "#2A42B4", selected: "#2A42B4", border: "#7E8EA6", borderStrong: "#5A6B84",
    actorFill: "#E7EDF7", actorStroke: "#6E819C", actorAccent: "#3F5570",
    normalFill: "#EDF1F9", normalStroke: "#5A6B84", normalAccent: "#2A42B4",
    applicationFill: "#FFFFFF", applicationStroke: "#7E8EA6", applicationAccent: "#2A42B4",
    storageFill: "#DCF0EE", storageStroke: "#1D6667", storageAccent: "#1D6667",
    externalFill: "#FAF0DC", externalStroke: "#8A5610", externalAccent: "#8A5610",
    infraFill: "#E9EDF4", infraStroke: "#53637A", infraAccent: "#45566D",
    decisionFill: "#F8E9CB", decisionStroke: "#8A5610", decisionText: "#0C1626",
    startFill: "#E1E7FF", startStroke: "#4B60C4", startText: "#0C1626",
    boundaryFill: "#E8EDF6", boundaryOpacity: 0.85, boundaryStroke: "#5A6B84", boundaryText: "#0C1626",
    fragmentFill: "#EDF1F9", fragmentOpacity: 0, fragmentStroke: "#5A6B84",
    fragmentTagFill: "#DCE3F0", fragmentTagStroke: "#5A6B84", fragmentText: "#0C1626",
    lifelineStroke: "#5A6B84", activationFill: "#E7EDF7", activationStroke: "#5A6B84",
    relationStroke: "#33475F", returnRelationStroke: "#4C5C72", asyncRelationStroke: "#3A4F63", dependencyStroke: "#57687D",
    relationLabelBackground: "#F3F5FA", relationLabelText: "#0C1626"
  },
  youth: {
    canvas: "#fffaff", grid: "#f1d4e8", surface: "#FFFFFF",
    ink: "#0C1626", inkSecondary: "#66334E", inkMuted: "#79405F",
    accent: "#df2d85", selected: "#df2d85", border: "#A05580", borderStrong: "#A05580",
    actorFill: "#fff7df", actorStroke: "#A05580", actorAccent: "#A05580",
    normalFill: "#fff0f8", normalStroke: "#A05580", normalAccent: "#A05580",
    applicationFill: "#fff0f8", applicationStroke: "#A05580", applicationAccent: "#A05580",
    storageFill: "#e8fbf4", storageStroke: "#A05580", storageAccent: "#A05580",
    externalFill: "#fff2d6", externalStroke: "#A05580", externalAccent: "#A05580",
    infraFill: "#ecf2ff", infraStroke: "#A05580", infraAccent: "#A05580",
    decisionFill: "#fff3c7", decisionStroke: "#A05580", decisionText: "#0C1626",
    startFill: "#ffe1f0", startStroke: "#A05580", startText: "#0C1626",
    boundaryFill: "#fff0f7", boundaryOpacity: 1, boundaryStroke: "#e4a4c5", boundaryText: "#9a3c6a",
    fragmentFill: "#fff5fb", fragmentOpacity: 0, fragmentStroke: "#dfabcb",
    fragmentTagFill: "#f9deee", fragmentTagStroke: "#dfabcb", fragmentText: "#79405f",
    lifelineStroke: "#d9a9c5", activationFill: "#fbe0ef", activationStroke: "#d79abf",
    relationStroke: "#8b5476", returnRelationStroke: "#8b5476", asyncRelationStroke: "#8b5476", dependencyStroke: "#8b5476",
    relationLabelBackground: "#fffaff", relationLabelText: "#66334e"
  },
  warm: {
    canvas: "#fffcf6", grid: "#e9ddcc", surface: "#FFFFFF",
    ink: "#0C1626", inkSecondary: "#5c4533", inkMuted: "#6e5039",
    accent: "#ad4d32", selected: "#ad4d32", border: "#9A7550", borderStrong: "#9A7550",
    actorFill: "#fffdf5", actorStroke: "#9A7550", actorAccent: "#9A7550",
    normalFill: "#fff5e7", normalStroke: "#9A7550", normalAccent: "#9A7550",
    applicationFill: "#fff5e7", applicationStroke: "#9A7550", applicationAccent: "#9A7550",
    storageFill: "#eef4e7", storageStroke: "#9A7550", storageAccent: "#9A7550",
    externalFill: "#f7e8d8", externalStroke: "#9A7550", externalAccent: "#9A7550",
    infraFill: "#eeece4", infraStroke: "#9A7550", infraAccent: "#9A7550",
    decisionFill: "#f8ebd1", decisionStroke: "#9A7550", decisionText: "#0C1626",
    startFill: "#f8e4d3", startStroke: "#9A7550", startText: "#0C1626",
    boundaryFill: "#f5e9d9", boundaryOpacity: 1, boundaryStroke: "#d2b89a", boundaryText: "#76583f",
    fragmentFill: "#fff5e8", fragmentOpacity: 0, fragmentStroke: "#d3b79b",
    fragmentTagFill: "#f2dfc8", fragmentTagStroke: "#cfad87", fragmentText: "#6e5039",
    lifelineStroke: "#bca58f", activationFill: "#eee0ce", activationStroke: "#bea184",
    relationStroke: "#8b6c57", returnRelationStroke: "#8b6c57", asyncRelationStroke: "#8b6c57", dependencyStroke: "#8b6c57",
    relationLabelBackground: "#fffaf2", relationLabelText: "#5c4533"
  },
  midnight: {
    canvas: "#101a2b", grid: "#2a3950", surface: "#FFFFFF",
    ink: "#26364a", inkSecondary: "#26364a", inkMuted: "#53637A",
    accent: "#91a5ff", selected: "#91a5ff", border: "#7E8EA6", borderStrong: "#667792",
    actorFill: "#E7EDF7", actorStroke: "#6E819C", actorAccent: "#3F5570",
    normalFill: "#FFFFFF", normalStroke: "#5A6B84", normalAccent: "#2A42B4",
    applicationFill: "#FFFFFF", applicationStroke: "#7E8EA6", applicationAccent: "#2A42B4",
    storageFill: "#DCF0EE", storageStroke: "#1D6667", storageAccent: "#1D6667",
    externalFill: "#FAF0DC", externalStroke: "#8A5610", externalAccent: "#8A5610",
    infraFill: "#E9EDF4", infraStroke: "#53637A", infraAccent: "#45566D",
    decisionFill: "#26334a", decisionStroke: "#8293b1", decisionText: "#eef3ff",
    startFill: "#2b3d5b", startStroke: "#8198d2", startText: "#eef3ff",
    boundaryFill: "#202d42", boundaryOpacity: 1, boundaryStroke: "#667792", boundaryText: "#c1cde2",
    fragmentFill: "#1e2b40", fragmentOpacity: 0, fragmentStroke: "#71819d",
    fragmentTagFill: "#34455f", fragmentTagStroke: "#7f91b0", fragmentText: "#d4def2",
    lifelineStroke: "#72829c", activationFill: "#354660", activationStroke: "#95a8c7",
    relationStroke: "#8796b2", returnRelationStroke: "#8796b2", asyncRelationStroke: "#8796b2", dependencyStroke: "#8796b2",
    relationLabelBackground: "#f0f3fa", relationLabelText: "#26364a"
  }
};

export function normalizeRenderTheme(value: unknown): DiagramRenderTheme {
  return value === "youth" || value === "warm" || value === "midnight" ? value : "editorial";
}

export function diagramPalette(theme?: DiagramRenderTheme | string): DiagramPalette {
  return PALETTES[normalizeRenderTheme(theme)];
}

export function sequenceLifelineBottom(relationCount: number): number {
  const sequence = RENDER_METRICS.sequence;
  return sequence.timelineY + Math.max(0, relationCount - 1) * sequence.messageSpacing + sequence.lifelineBottomPadding;
}

export function sequenceActivationGeometry(startOrder: number, endOrder: number, centerX: number) {
  const sequence = RENDER_METRICS.sequence;
  const height = Math.max(
    sequence.activationMinHeight,
    (endOrder - startOrder) * sequence.messageSpacing - sequence.activationStartInset - sequence.activationEndInset
  );
  return {
    // Draw.io XML geometry is integer-based in the exporter; round in the shared helper so the
    // Studio SVG doesn't paint activation bars at sub-pixel positions that native Draw.io rounds away.
    x: Math.round(centerX - sequence.activationWidth / 2),
    y: Math.round(sequence.timelineY + startOrder * sequence.messageSpacing + sequence.activationStartInset),
    width: sequence.activationWidth,
    height: Math.round(height)
  };
}

export function sequenceFragmentVerticalGeometry(fragment: SequenceFragment) {
  const sequence = RENDER_METRICS.sequence;
  return {
    top: sequence.timelineY + fragment.startOrder * sequence.messageSpacing - 22,
    bottom: sequence.timelineY + fragment.endOrder * sequence.messageSpacing + 22
  };
}

export function nodeVisualDefaults(node: DiagramNode, palette: DiagramPalette) {
  let fill = palette.surface, stroke = palette.border, accent = palette.accent, shape: "rect" | "pill" | "diamond" = "rect";
  if (node.role === "actor" || node.role === "source") {
    fill = palette.actorFill; stroke = palette.actorStroke; accent = palette.actorAccent; shape = "pill";
  } else if (node.role === "external" || node.role === "vendor" || node.visualRole === "external") {
    fill = palette.externalFill; stroke = palette.externalStroke; accent = palette.externalAccent;
  } else if (node.role === "storage" || node.role === "data") {
    fill = palette.storageFill; stroke = palette.storageStroke; accent = palette.storageAccent;
  } else if (node.role === "infra") {
    fill = palette.infraFill; stroke = palette.infraStroke; accent = palette.infraAccent;
  } else if (node.role === "decision") {
    fill = palette.decisionFill; stroke = palette.decisionStroke; accent = palette.decisionStroke; shape = "diamond";
  } else if (node.role === "start" || node.role === "end") {
    fill = palette.startFill; stroke = palette.startStroke; accent = palette.startStroke; shape = "pill";
  } else if (node.visualRole === "highlight") {
    fill = palette.startFill; stroke = palette.startStroke;
  } else if (node.role === "domain" || node.role === "ui") {
    fill = palette.normalFill; stroke = palette.normalStroke; accent = palette.normalAccent;
  } else if (["entry", "api", "business", "worker", "service"].includes(node.role)) {
    fill = palette.applicationFill; stroke = palette.applicationStroke; accent = palette.applicationAccent;
  }
  const override = node.visualStyle;
  return {
    fill: override?.fillColor || fill,
    stroke: override?.strokeColor || stroke,
    accent: override?.accentColor || accent,
    text: override?.fontColor || ((node.role === "decision" || node.role === "start" || node.role === "end") ? palette.decisionText : palette.ink),
    muted: override?.fontColor || palette.inkMuted,
    shape: override?.shape || shape,
    fontFamily: override?.fontFamily || DIAGRAM_FONT,
    fontSize: override?.fontSize || RENDER_METRICS.title.size,
    fontWeight: override?.fontStyle !== undefined ? ((override.fontStyle & 1) ? 700 : 400) : RENDER_METRICS.title.weight,
    strokeWidth: override?.strokeWidth || RENDER_METRICS.node.strokeWidth,
    radius: override?.arcSize !== undefined ? override.arcSize : (shape === "pill" ? RENDER_METRICS.node.pillArcSize : RENDER_METRICS.node.radius)
  };
}

export function relationVisualDefaults(relation: import("../model/types").DiagramRelation, palette: DiagramPalette) {
  const override = relation.visualStyle;
  const isReturn = relation.kind === "return";
  const isAsync = relation.kind === "async" || relation.kind === "event";
  return {
    stroke: override?.strokeColor || (isReturn ? palette.returnRelationStroke : isAsync ? palette.asyncRelationStroke : relation.kind === "dependency" ? palette.dependencyStroke : palette.relationStroke),
    width: override?.strokeWidth || (isReturn ? RENDER_METRICS.relation.returnStrokeWidth : isAsync ? RENDER_METRICS.relation.asyncStrokeWidth : relation.kind === "dependency" ? RENDER_METRICS.relation.dependencyStrokeWidth : RENDER_METRICS.relation.strokeWidth),
    dash: override?.dashPattern !== undefined ? override.dashPattern
      : override?.dashed !== undefined ? (override.dashed ? RENDER_METRICS.relation.dashPattern : "")
      : relation.dashed !== undefined ? (relation.dashed ? RENDER_METRICS.relation.dashPattern : "")
      : isReturn ? RENDER_METRICS.relation.dashPattern : "",
    marker: override?.endArrow === "none" ? "" : (override?.endArrow === "open" || isReturn || isAsync ? "arrow-open" : "arrow"),
    endArrow: override?.endArrow || (isReturn || isAsync ? "open" : "block"),
    startArrow: override?.startArrow || "none",
    endFill: override?.endFill ?? !(isReturn || isAsync),
    fontFamily: override?.fontFamily || DIAGRAM_FONT,
    fontSize: override?.fontSize || RENDER_METRICS.relationLabel.size,
    fontColor: override?.fontColor || palette.inkSecondary,
    labelBackground: override?.labelBackgroundColor || palette.relationLabelBackground
  };
}
