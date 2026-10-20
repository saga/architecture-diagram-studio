export type DiagramKind = "c4" | "flowchart" | "sequence";
export type Direction = "RIGHT" | "DOWN";
export type Routing = "orthogonal" | "polyline" | "curved";
export type NodeRole =
  | "actor" | "source" | "entry" | "ui" | "domain" | "business"
  | "api" | "worker" | "data" | "storage" | "external" | "vendor"
  | "infra" | "decision" | "start" | "end" | "service";
export type VisualRole = "primary" | "secondary" | "muted" | "external" | "highlight";
export type EdgeKind = "flow" | "call" | "return" | "async" | "event" | "dependency";

export interface Point { x: number; y: number; }
export interface LayoutHints {
  locked?: boolean;
  preferredRank?: number;
  preferredSide?: "LEFT" | "RIGHT" | "TOP" | "BOTTOM";
  preferredLane?: string;
}
export interface DiagramNode {
  id: string;
  name: string;
  description?: string;
  technology?: string;
  role: NodeRole;
  visualRole: VisualRole;
  x: number;
  y: number;
  width: number;
  height: number;
  layoutHints?: LayoutHints;
}
export interface DiagramRelation {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: EdgeKind;
  dashed?: boolean;
  routing?: Routing;
  points?: Point[];
  sequenceOrder?: number;
}
export interface DiagramBoundary {
  id: string;
  name: string;
  members: string[];
  description?: string;
}
export interface DiagramDocument {
  schemaVersion: 2;
  id: string;
  title: string;
  kind: DiagramKind;
  variant?: "context" | "container" | "component";
  theme: "studio-editorial";
  nodes: DiagramNode[];
  relations: DiagramRelation[];
  boundaries: DiagramBoundary[];
  layout: {
    profile: string;
    direction: Direction;
    routing: Routing;
    nodeSpacing: number;
    layerSpacing: number;
    boundaryPadding: number;
    externalSide: "LEFT" | "RIGHT";
    storageSide: "BOTTOM" | "RIGHT";
  };
  flow?: { primaryPath: string[] };
  sequence?: { participants: string[] };
}
export interface QualityIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  nodeIds?: string[];
  relationIds?: string[];
}
export interface LayoutQualityReport {
  score: number;
  errors: QualityIssue[];
  warnings: QualityIssue[];
  metrics: {
    nodeOverlaps: number;
    edgeNodeIntersections: number;
    edgeCrossings: number;
    labelCollisions: number;
    disconnectedComponents: number;
    alignmentScore: number;
    whitespaceScore: number;
    densityScore: number;
  };
}
export interface IntentResult {
  document: DiagramDocument;
  summary: string;
  requiresLayout: boolean;
  changed: boolean;
}