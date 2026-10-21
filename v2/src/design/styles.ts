import type { DiagramNode, DiagramRelation } from "../model/types";
import { tokens } from "./tokens";

export interface NodePaint {
  fill: string;
  stroke: string;
  text: string;
  muted: string;
  accent: string;
  shape: "rect" | "pill" | "diamond";
}

export function nodePaint(node: DiagramNode): NodePaint {
  const base: NodePaint = {
    fill: tokens.surface, stroke: tokens.border, text: tokens.ink,
    muted: tokens.inkSecondary, accent: tokens.accent, shape: "rect"
  };
  if (node.role === "actor" || node.role === "source") {
    return { ...base, fill: "#E7EDF7", stroke: "#6E819C", accent: "#3F5570", shape: "pill" };
  }
  if (node.role === "external" || node.role === "vendor" || node.visualRole === "external") {
    return { ...base, fill: tokens.external, stroke: tokens.externalBorder, accent: tokens.amber };
  }
  if (node.role === "storage" || node.role === "data") {
    return { ...base, fill: tokens.tealSoft, stroke: "#6E9C99", accent: tokens.teal };
  }
  if (node.role === "infra") return { ...base, fill: "#E9EDF4", stroke: "#7E8CA1", accent: "#45566D" };
  if (node.role === "decision") return { ...base, fill: tokens.amberSoft, stroke: "#A97E3C", accent: tokens.amber, shape: "diamond" };
  if (node.role === "start" || node.role === "end") return { ...base, fill: tokens.accentSoft, stroke: tokens.accentBorder, accent: tokens.accent, shape: "pill" };
  if (node.visualRole === "highlight") return { ...base, fill: tokens.accentSoft, stroke: tokens.accentBorder };
  if (node.role === "domain" || node.role === "ui") return { ...base, fill: "#EDF1F9", stroke: "#7C8DA6", accent: tokens.accent };
  return base;
}

export function relationPaint(relation: DiagramRelation) {
  if (relation.kind === "return") return { stroke: "#4C5C72", width: 1.3, dash: relation.dashed === false ? "" : "5 5", marker: "arrow-open" };
  if (relation.kind === "async" || relation.kind === "event") return { stroke: "#3A4F63", width: 1.45, dash: relation.dashed ? "5 5" : "", marker: "arrow-open" };
  return {
    stroke: relation.kind === "dependency" ? "#57687D" : "#33475F",
    width: relation.kind === "dependency" ? 1.25 : 1.5,
    dash: relation.dashed ? "5 5" : "",
    marker: "arrow"
  };
}

export function mxNodeStyle(node: DiagramNode): string {
  const paint = nodePaint(node);
  const shape = paint.shape === "pill" ? "rounded=1;arcSize=50;" : paint.shape === "diamond" ? "rhombus;" : "rounded=1;arcSize=8;";
  return shape + "whiteSpace=wrap;html=1;fillColor=" + paint.fill +
    ";strokeColor=" + paint.stroke + ";strokeWidth=1.4;fontColor=" + paint.text +
    ";fontSize=13;fontFamily=Arial;align=left;verticalAlign=middle;spacingLeft=13;spacingRight=10;" +
    "spacingTop=8;spacingBottom=8;shadow=0;studioRole=" + node.role + ";studioVisualRole=" + node.visualRole + ";";
}

export function mxEdgeStyle(relation: DiagramRelation, routing: string): string {
  const paint = relationPaint(relation);
  const edgeRouting = relation.routing || routing;
  // Explicit Studio waypoints are authoritative. Letting mxGraph run its own router over those
  // points can override the path and make exported connectors diverge from the Studio canvas.
  const route = relation.points?.length ? "edgeStyle=none;" : edgeRouting === "orthogonal" ? "edgeStyle=orthogonalEdgeStyle;orthogonalLoop=1;jettySize=auto;" : "edgeStyle=none;";
  const curve = edgeRouting === "curved" ? "curved=1;rounded=1;" : "rounded=0;";
  const shouldDash = relation.dashed ?? (relation.kind === "return");
  const dashed = shouldDash ? "dashed=1;dashPattern=5 5;" : "";
  const arrow = relation.kind === "return" || relation.kind === "async" || relation.kind === "event" ? "endArrow=open;endFill=0;" : "endArrow=block;endFill=1;";
  return route + curve + dashed + arrow + "html=1;strokeColor=" + paint.stroke + ";strokeWidth=" + paint.width + ";fontColor=" + tokens.inkSecondary + ";fontSize=13;labelBackgroundColor=" + tokens.canvas + ";";
}