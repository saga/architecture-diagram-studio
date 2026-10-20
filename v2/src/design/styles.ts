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
    return { ...base, fill: "#F7F9FC", stroke: "#C9D3E0", accent: "#617A9B", shape: "pill" };
  }
  if (node.role === "external" || node.role === "vendor" || node.visualRole === "external") {
    return { ...base, fill: tokens.external, stroke: tokens.externalBorder, accent: tokens.amber };
  }
  if (node.role === "storage" || node.role === "data") {
    return { ...base, fill: "#F7F9FB", stroke: "#D1D8E3", accent: tokens.teal };
  }
  if (node.role === "infra") return { ...base, fill: "#F4F6F9", stroke: "#D4DBE5", accent: "#768396" };
  if (node.role === "decision") return { ...base, fill: "#FBFCFE", stroke: "#C6CFDC", accent: tokens.amber, shape: "diamond" };
  if (node.role === "start" || node.role === "end") return { ...base, fill: tokens.accentSoft, stroke: tokens.accentBorder, accent: tokens.accent, shape: "pill" };
  if (node.visualRole === "highlight") return { ...base, fill: tokens.accentSoft, stroke: tokens.accentBorder };
  if (node.role === "domain" || node.role === "ui") return { ...base, stroke: "#BAC6D7", accent: tokens.accent };
  return base;
}

export function relationPaint(relation: DiagramRelation) {
  if (relation.kind === "return") return { stroke: "#778496", width: 1.2, dash: "5 5", marker: "arrow-open" };
  if (relation.kind === "async" || relation.kind === "event") return { stroke: "#536D85", width: 1.35, dash: relation.dashed ? "5 5" : "", marker: "arrow-open" };
  return {
    stroke: relation.kind === "dependency" ? "#8A97A8" : "#64748B",
    width: relation.kind === "dependency" ? 1.15 : 1.4,
    dash: relation.dashed ? "5 5" : "",
    marker: "arrow"
  };
}

export function mxNodeStyle(node: DiagramNode): string {
  const paint = nodePaint(node);
  const shape = paint.shape === "pill" ? "rounded=1;arcSize=50;" : paint.shape === "diamond" ? "rhombus;" : "rounded=1;arcSize=10;";
  return shape + "whiteSpace=wrap;html=1;fillColor=" + paint.fill +
    ";strokeColor=" + paint.stroke + ";strokeWidth=1;fontColor=" + paint.text +
    ";fontSize=13;fontFamily=Arial;align=left;verticalAlign=middle;spacingLeft=13;spacingRight=10;" +
    "spacingTop=8;spacingBottom=8;shadow=0;studioRole=" + node.role + ";studioVisualRole=" + node.visualRole + ";";
}

export function mxEdgeStyle(relation: DiagramRelation, routing: string): string {
  const paint = relationPaint(relation);
  const edgeRouting = relation.routing || routing;
  const route = edgeRouting === "orthogonal" ? "edgeStyle=orthogonalEdgeStyle;orthogonalLoop=1;jettySize=auto;" : "edgeStyle=none;";
  const curve = edgeRouting === "curved" ? "curved=1;rounded=1;" : "rounded=0;";
  const dashed = relation.dashed || relation.kind === "return" ? "dashed=1;dashPattern=5 5;" : "";
  const arrow = relation.kind === "return" || relation.kind === "async" || relation.kind === "event" ? "endArrow=open;endFill=0;" : "endArrow=block;endFill=1;";
  return route + curve + dashed + arrow + "html=1;strokeColor=" + paint.stroke + ";strokeWidth=" + paint.width + ";fontColor=#536276;fontSize=11;labelBackgroundColor=#FFFFFF;";
}