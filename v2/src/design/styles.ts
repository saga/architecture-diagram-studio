import type { DiagramNode, DiagramRelation, DiagramRenderTheme } from "../model/types";
import { diagramPalette, nodeVisualDefaults, relationVisualDefaults, normalizeRenderTheme, RENDER_METRICS } from "./render-spec";

export interface NodePaint {
  fill: string;
  stroke: string;
  text: string;
  muted: string;
  accent: string;
  shape: "rect" | "pill" | "diamond";
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  strokeWidth: number;
  radius: number;
}

export function nodePaint(node: DiagramNode, theme?: DiagramRenderTheme | string): NodePaint {
  const defaults = nodeVisualDefaults(node, diagramPalette(theme));
  return {
    fill: defaults.fill, stroke: defaults.stroke, text: defaults.text, muted: defaults.muted,
    accent: defaults.accent, shape: defaults.shape, fontFamily: defaults.fontFamily,
    fontSize: defaults.fontSize, fontWeight: defaults.fontWeight, strokeWidth: defaults.strokeWidth,
    radius: defaults.radius
  };
}

export function relationPaint(relation: DiagramRelation, theme?: DiagramRenderTheme | string) {
  return relationVisualDefaults(relation, diagramPalette(theme));
}

export function mxNodeStyle(node: DiagramNode, theme?: DiagramRenderTheme | string): string {
  const paint = nodePaint(node, theme);
  const sourceArcSize = node.visualStyle?.arcSize;
  const arcSize = sourceArcSize ?? (paint.shape === "pill" ? RENDER_METRICS.node.pillArcSize : RENDER_METRICS.node.radius);
  const shape = paint.shape === "pill"
    ? "rounded=1;arcSize=" + arcSize + ";"
    : paint.shape === "diamond" ? "rhombus;" : "rounded=1;arcSize=" + arcSize + ";";
  const fontStyle = node.visualStyle?.fontStyle ?? (paint.fontWeight >= 600 ? 1 : 0);
  return shape + "whiteSpace=wrap;html=1;fillColor=" + paint.fill +
    ";strokeColor=" + paint.stroke + ";strokeWidth=" + paint.strokeWidth +
    ";fontColor=" + paint.text + ";fontSize=" + paint.fontSize + ";fontFamily=" + paint.fontFamily +
    ";fontStyle=" + fontStyle + ";align=left;verticalAlign=middle;spacingLeft=13;spacingRight=10;" +
    "spacingTop=8;spacingBottom=8;shadow=0;studioRole=" + node.role +
    ";studioVisualRole=" + node.visualRole + ";studioAccentColor=" + paint.accent +
    ";studioTheme=" + normalizeRenderTheme(theme) + ";";
}

export function mxEdgeStyle(relation: DiagramRelation, routing: string, theme?: DiagramRenderTheme | string): string {
  const paint = relationPaint(relation, theme);
  const edgeRouting = relation.routing || routing;
  // Explicit Studio waypoints are authoritative. Letting mxGraph run its own router over those
  // points can override the path and make exported connectors diverge from the Studio canvas.
  const route = relation.points?.length ? "edgeStyle=none;" : edgeRouting === "orthogonal"
    ? "edgeStyle=orthogonalEdgeStyle;orthogonalLoop=1;jettySize=auto;" : "edgeStyle=none;";
  const curve = edgeRouting === "curved" ? "curved=1;rounded=1;" : "rounded=0;";
  const dash = paint.dash ? "dashed=1;dashPattern=" + paint.dash + ";" : "dashed=0;";
  const override = relation.visualStyle;
  const defaultEndArrow = relation.kind === "return" || relation.kind === "async" || relation.kind === "event" ? "open" : "block";
  const endArrow = override?.endArrow || defaultEndArrow;
  const startArrow = override?.startArrow || "none";
  const endFill = override?.endFill ?? endArrow !== "open";
  const arrow = "startArrow=" + startArrow + ";endArrow=" + endArrow + ";endFill=" + (endFill ? "1" : "0") +
    ";startFill=0;startSize=" + RENDER_METRICS.relation.arrowSize + ";endSize=" + RENDER_METRICS.relation.arrowSize + ";";
  return route + curve + dash + arrow + "html=1;strokeColor=" + paint.stroke + ";strokeWidth=" + paint.width +
    ";fontColor=" + paint.fontColor + ";fontSize=" + paint.fontSize + ";fontFamily=" + paint.fontFamily +
    ";labelBackgroundColor=" + paint.labelBackground +
    ";labelPosition=center;verticalLabelPosition=top;align=center;verticalAlign=bottom;spacing=" +
    RENDER_METRICS.relation.labelGap + ";studioTheme=" + normalizeRenderTheme(theme) + ";";
}
