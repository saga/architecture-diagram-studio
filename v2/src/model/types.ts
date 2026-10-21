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
export type DiagramRenderTheme = "editorial" | "youth" | "warm" | "midnight";

export interface NodeVisualStyle {
  fillColor?: string;
  strokeColor?: string;
  fontColor?: string;
  fontFamily?: string;
  fontSize?: number;
  /** Draw.io fontStyle bitmask (1 bold, 2 italic, 4 underline). */
  fontStyle?: number;
  strokeWidth?: number;
  /** "rect", "pill", or "diamond" Studio shape approximation. */
  shape?: "rect" | "pill" | "diamond";
  /** Draw.io arcSize value retained for editing roundness. */
  arcSize?: number;
  accentColor?: string;
}

export interface RelationVisualStyle {
  strokeColor?: string;
  fontColor?: string;
  fontFamily?: string;
  fontSize?: number;
  strokeWidth?: number;
  dashed?: boolean;
  dashPattern?: string;
  startArrow?: string;
  endArrow?: string;
  endFill?: boolean;
  labelBackgroundColor?: string;
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
  /** Optional native Draw.io appearance captured on import and reused on export. */
  visualStyle?: NodeVisualStyle;
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
  /** Explicit attachment points, computed by the router and preserved by Draw.io export. */
  sourcePort?: Point;
  targetPort?: Point;
  sequenceOrder?: number;
  /** Optional native Draw.io edge appearance captured on import and reused on export. */
  visualStyle?: RelationVisualStyle;
}
export interface DiagramBoundary {
  id: string;
  name: string;
  members: string[];
  description?: string;
}
export interface SequenceFragment {
  id: string;
  kind: "alt" | "opt" | "loop";
  label: string;
  startOrder: number;
  endOrder: number;
  /** Optional subset of lifelines enclosed by this fragment; omitted means all participants. */
  participants?: string[];
}

/**
 * Derived partial semantic projection of the authoritative Draw.io XML.
 * Never use this object as the persisted source of truth or regenerate an existing
 * native document wholesale from it. Semantic edits must be patched into the source XML.
 */
export interface DiagramDocument {
  schemaVersion: 2;
  id: string;
  title: string;
  kind: DiagramKind;
  variant?: "context" | "container" | "component";
  theme: "studio-editorial";
  /** Rendering theme for both Studio SVG and the native Draw.io file. */
  renderTheme?: DiagramRenderTheme;
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
  sequence?: { participants: string[]; fragments?: SequenceFragment[] };
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
    gridAlignmentScore: number;
    whitespaceScore: number;
    densityScore: number;
    labelOverflowCount: number;
    edgeLabelOutOfBoundsCount: number;
    connectorRoutingViolations: number;
    portSpacingViolations: number;
    contrastViolations: number;
    cjkWidthViolations: number;
    complexityWarnings: number;
  };
}
export interface IntentResult {
  document: DiagramDocument;
  summary: string;
  requiresLayout: boolean;
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * True when two or more nodes share a top-left corner, which means the document was never laid out.
 * Fixtures describe semantics only and start at the origin, and imported drafts can arrive the same way,
 * so this is the check that decides whether the geometry has to be computed before the document is shown.
 */
export function hasStackedGeometry(document: DiagramDocument): boolean {
  if (document.nodes.length < 2) return false;
  const occupied = new Set<string>();
  for (const node of document.nodes) {
    const key = Math.round(node.x) + ":" + Math.round(node.y);
    if (occupied.has(key)) return true;
    occupied.add(key);
  }
  return false;
}

export function isDiagramDocument(value: unknown): value is DiagramDocument {
  if (!isRecord(value)) return false;
  const valueRecord = value as Record<string, unknown>;
  if (
    valueRecord.schemaVersion !== 2 ||
    typeof valueRecord.id !== "string" ||
    typeof valueRecord.title !== "string" ||
    !["c4", "flowchart", "sequence"].includes(String(valueRecord.kind)) ||
    valueRecord.theme !== "studio-editorial" ||
    !Array.isArray(valueRecord.nodes) ||
    !Array.isArray(valueRecord.relations) ||
    !Array.isArray(valueRecord.boundaries) ||
    !isRecord(valueRecord.layout)
  ) return false;

  const layout = valueRecord.layout;
  if (
    typeof layout.profile !== "string" ||
    !["RIGHT", "DOWN"].includes(String(layout.direction)) ||
    !["orthogonal", "polyline", "curved"].includes(String(layout.routing)) ||
    !["LEFT", "RIGHT"].includes(String(layout.externalSide)) ||
    !["BOTTOM", "RIGHT"].includes(String(layout.storageSide)) ||
    !["nodeSpacing", "layerSpacing", "boundaryPadding"].every((key) => typeof layout[key] === "number")
  ) return false;

  const validNodes = valueRecord.nodes.every((node) => isRecord(node) &&
    typeof node.id === "string" && typeof node.name === "string" &&
    typeof node.role === "string" && typeof node.visualRole === "string" &&
    ["x", "y", "width", "height"].every((key) => typeof node[key] === "number"));
  const validRelations = valueRecord.relations.every((relation) => isRecord(relation) &&
    typeof relation.id === "string" && typeof relation.source === "string" &&
    typeof relation.target === "string" && typeof relation.label === "string" &&
    typeof relation.kind === "string" &&
    (relation.points === undefined || Array.isArray(relation.points)) &&
    (relation.sourcePort === undefined || (isRecord(relation.sourcePort) && typeof relation.sourcePort.x === "number" && typeof relation.sourcePort.y === "number")) &&
    (relation.targetPort === undefined || (isRecord(relation.targetPort) && typeof relation.targetPort.x === "number" && typeof relation.targetPort.y === "number")));
  const validBoundaries = valueRecord.boundaries.every((boundary) => isRecord(boundary) &&
    typeof boundary.id === "string" && typeof boundary.name === "string" &&
    Array.isArray(boundary.members) && boundary.members.every((member) => typeof member === "string"));
  if (!validNodes || !validRelations || !validBoundaries) return false;

  if (valueRecord.variant !== undefined && !["context", "container", "component"].includes(String(valueRecord.variant))) return false;
  if (valueRecord.flow !== undefined && (!isRecord(valueRecord.flow) || !Array.isArray(valueRecord.flow.primaryPath) || !valueRecord.flow.primaryPath.every((id) => typeof id === "string"))) return false;
  if (valueRecord.sequence !== undefined) {
    if (!isRecord(valueRecord.sequence) || !Array.isArray(valueRecord.sequence.participants) || !valueRecord.sequence.participants.every((id) => typeof id === "string")) return false;
    if (valueRecord.sequence.fragments !== undefined && (!Array.isArray(valueRecord.sequence.fragments) || !valueRecord.sequence.fragments.every((fragment) =>
      isRecord(fragment) && typeof fragment.id === "string" &&
      ["alt", "opt", "loop"].includes(String(fragment.kind)) &&
      typeof fragment.label === "string" && typeof fragment.startOrder === "number" &&
      typeof fragment.endOrder === "number" && fragment.startOrder <= fragment.endOrder &&
      (fragment.participants === undefined || (Array.isArray(fragment.participants) && fragment.participants.every((id) => typeof id === "string")))
    ))) return false;
  }
  return true;
}
