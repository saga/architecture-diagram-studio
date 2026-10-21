import type { DiagramDocument, DiagramNode, DiagramRelation, Point } from "../model/types";
import { mxEdgeStyle, mxNodeStyle, nodePaint } from "../design/styles";
import { deriveSequenceActivations, sequenceMessageGeometry } from "../layout/sequence";
import { tokens } from "../design/tokens";
import { diagramPalette, normalizeRenderTheme, RENDER_METRICS, sequenceActivationGeometry, sequenceLifelineBottom, sequenceFragmentVerticalGeometry } from "../design/render-spec";

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function htmlLabel(node: DiagramNode, theme: string): string {
  const palette = diagramPalette(theme);
  const titleStyle = node.visualStyle;
  const fontFamily = esc(titleStyle?.fontFamily || "Arial, Helvetica, sans-serif");
  const titleSize = titleStyle?.fontSize || RENDER_METRICS.title.size;
  const titleWeight = titleStyle?.fontStyle !== undefined ? ((titleStyle.fontStyle & 1) ? 700 : 400) : RENDER_METRICS.title.weight;
  const titleColor = esc(titleStyle?.fontColor || palette.ink);
  const secondaryColor = esc(titleStyle?.fontColor || palette.inkMuted);
  const title = "<div style='font-family:" + fontFamily + ";font-size:" + titleSize + "px;font-weight:" + titleWeight + ";color:" + titleColor + ";line-height:1.35'>" + esc(node.name) + "</div>";
  const technology = node.technology ? "<div style='font-family:" + fontFamily + ";font-size:" + RENDER_METRICS.secondary.size + "px;font-weight:" + RENDER_METRICS.secondary.weight + ";color:" + secondaryColor + ";margin-top:4px'>" + esc(node.technology) + "</div>" : "";
  const description = node.description ? "<div style='font-family:" + fontFamily + ";font-size:" + RENDER_METRICS.secondary.size + "px;font-weight:" + RENDER_METRICS.secondary.weight + ";color:" + secondaryColor + ";margin-top:5px;line-height:1.35'>" + esc(node.description) + "</div>" : "";
  return title + technology + description;
}
function pointXml(points: Point[]): string {
  if (points.length === 0) return "";
  return "<Array as=\"points\">" + points.map((p) => "<mxPoint x=\"" + Math.round(p.x) + "\" y=\"" + Math.round(p.y) + "\"/>").join("") + "</Array>";
}
function vertexXml(node: DiagramNode, theme: string): string {
  return "<mxCell id=\"" + esc(node.id) + "\" value=\"" + esc(htmlLabel(node, theme)) + "\" style=\"" +
    esc(mxNodeStyle(node, theme)) + "\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"" + Math.round(node.x) +
    "\" y=\"" + Math.round(node.y) + "\" width=\"" + Math.round(node.width) + "\" height=\"" +
    Math.round(node.height) + "\" as=\"geometry\"/></mxCell>";
}
function accentXml(node: DiagramNode, theme: string): string {
  if (["decision", "start", "end"].includes(node.role)) return "";
  const paint = nodePaint(node, theme);
  const insetX = RENDER_METRICS.node.accentInsetX;
  const insetY = RENDER_METRICS.node.accentInsetY;
  const opacity = node.role === "actor" || node.role === "source" ? 60 : 100;
  const halfWidth = RENDER_METRICS.node.accentWidth / 2;
  const id = node.id + "__studioAccent";
  const style = "rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=" + paint.accent +
    ";strokeColor=none;strokeWidth=0;opacity=" + opacity + ";connectable=0;studioAccentFor=" + esc(node.id) + ";";
  // Round the accent cell into the same capsule produced by the SVG stroke's round line caps.
  return "<mxCell id=\"" + esc(id) + "\" value=\"\" style=\"" + esc(style) +
    "\" vertex=\"1\" parent=\"" + esc(node.id) + "\"><mxGeometry x=\"" + (insetX - halfWidth) + "\" y=\"" + (insetY - halfWidth) +
    "\" width=\"" + RENDER_METRICS.node.accentWidth + "\" height=\"" + Math.max(0, node.height - insetY * 2 + RENDER_METRICS.node.accentWidth) +
    "\" as=\"geometry\"/></mxCell>";
}
function edgeXml(relation: DiagramRelation, routing: string, doc: DiagramDocument, theme: string, source = relation.source, target = relation.target): string {
  const label = relation.label ? esc(relation.label) : "";
  const metadata = [
    source !== relation.source || target !== relation.target ? "studioSource=" + esc(relation.source) + ";studioTarget=" + esc(relation.target) : "",
    "studioKind=" + relation.kind,
    relation.sequenceOrder === undefined ? "" : "studioSequenceOrder=" + relation.sequenceOrder
  ].filter(Boolean).join(";");
  const sourceNode = doc.nodes.find((node) => node.id === source);
  const targetNode = doc.nodes.find((node) => node.id === target);
  const portStyle = relation.sourcePort && relation.targetPort && sourceNode && targetNode
    ? "exitX=" + ((relation.sourcePort.x - sourceNode.x) / Math.max(1, sourceNode.width)) +
      ";exitY=" + ((relation.sourcePort.y - sourceNode.y) / Math.max(1, sourceNode.height)) +
      ";exitDx=0;exitDy=0;exitPerimeter=0;entryX=" +
      ((relation.targetPort.x - targetNode.x) / Math.max(1, targetNode.width)) +
      ";entryY=" + ((relation.targetPort.y - targetNode.y) / Math.max(1, targetNode.height)) +
      ";entryDx=0;entryDy=0;entryPerimeter=0;"
    : "";
  const style = mxEdgeStyle(relation, routing, theme) + portStyle + (metadata ? ";" + metadata + ";" : "");
  return "<mxCell id=\"" + esc(relation.id) + "\" value=\"" + label + "\" style=\"" +
    esc(style) + "\" edge=\"1\" parent=\"1\" source=\"" + esc(source) +
    "\" target=\"" + esc(target) + "\"><mxGeometry relative=\"1\" as=\"geometry\">" +
    pointXml(relation.points || []) + "</mxGeometry></mxCell>";
}
function boundaryXml(doc: DiagramDocument, boundary: DiagramDocument["boundaries"][number], theme: string): string {
  const members = doc.nodes.filter((node) => boundary.members.includes(node.id));
  if (members.length === 0) return "";
  const padding = doc.layout.boundaryPadding;
  const minX = Math.min(...members.map((n) => n.x)) - padding;
  const minY = Math.min(...members.map((n) => n.y)) - padding - 14;
  const maxX = Math.max(...members.map((n) => n.x + n.width)) + padding;
  const maxY = Math.max(...members.map((n) => n.y + n.height)) + padding;
  const membersAttribute = boundary.members.join(",");
  const palette = diagramPalette(theme);
  const style = "rounded=1;arcSize=" + RENDER_METRICS.boundary.radius + ";whiteSpace=wrap;html=1;fillColor=" + palette.boundaryFill +
    ";fillOpacity=" + Math.round(palette.boundaryOpacity * 100) + ";strokeColor=" + palette.boundaryStroke +
    ";strokeWidth=" + RENDER_METRICS.boundary.strokeWidth + ";dashed=1;dashPattern=" + RENDER_METRICS.boundary.dashPattern +
    ";fontColor=" + palette.boundaryText + ";fontSize=" + RENDER_METRICS.boundary.titleSize + ";fontFamily=Arial;align=left;verticalAlign=top;spacingLeft=10;spacingTop=7;studioBoundary=1;studioMembers=" + membersAttribute + ";";
  return "<mxCell id=\"" + esc(boundary.id) + "\" value=\"" + esc(boundary.name.toUpperCase()) + "\" style=\"" + esc(style) +
    "\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"" + Math.round(minX) + "\" y=\"" + Math.round(minY) + "\" width=\"" +
    Math.round(maxX - minX) + "\" height=\"" + Math.round(maxY - minY) + "\" as=\"geometry\"/></mxCell>";
}
function invisiblePoint(id: string, x: number, y: number): string {
  return "<mxCell id=\"" + esc(id) + "\" value=\"\" style=\"ellipse;opacity=0;fillColor=none;strokeColor=none;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"" +
    Math.round(x) + "\" y=\"" + Math.round(y) + "\" width=\"1\" height=\"1\" as=\"geometry\"/></mxCell>";
}
function sequenceSupport(doc: DiagramDocument, theme: string): { vertices: string; edges: string } {
  if (doc.kind !== "sequence") return { vertices: "", edges: "" };
  const palette = diagramPalette(theme);
  const maxY = sequenceLifelineBottom(doc.relations.length);
  const vertices: string[] = [];
  const edges: string[] = [];
  for (const node of doc.nodes) {
    const x = node.x + node.width / 2;
    vertices.push(invisiblePoint(node.id + "__lifelineEnd", x, maxY));
    const lifeline: DiagramRelation = { id: node.id + "__lifeline", source: node.id, target: node.id + "__lifelineEnd", label: "", kind: "dependency", dashed: true };
    edges.push("<mxCell id=\"" + esc(lifeline.id) + "\" value=\"\" style=\"edgeStyle=none;dashed=1;dashPattern=" + RENDER_METRICS.relation.lifelineDashPattern + ";strokeColor=" + palette.lifelineStroke + ";strokeWidth=" + RENDER_METRICS.relation.lifelineStrokeWidth + ";endArrow=none;startArrow=none;\" edge=\"1\" parent=\"1\" source=\"" +
      esc(node.id) + "\" target=\"" + esc(node.id + "__lifelineEnd") + "\"><mxGeometry relative=\"1\" as=\"geometry\"/></mxCell>");
  }
  const participantNodes = doc.nodes.filter((node) => (doc.sequence?.participants || []).includes(node.id));
  for (const fragment of doc.sequence?.fragments || []) {
    if (!participantNodes.length) continue;
    const fragmentParticipants = fragment.participants?.length
      ? participantNodes.filter((node) => fragment.participants?.includes(node.id))
      : participantNodes;
    if (!fragmentParticipants.length) continue;
    const minX = Math.round(Math.min(...fragmentParticipants.map((node) => node.x)) - 12);
    const maxX = Math.round(Math.max(...fragmentParticipants.map((node) => node.x + node.width)) + 12);
    const fragmentGeometry = sequenceFragmentVerticalGeometry(fragment);
    const top = Math.round(fragmentGeometry.top);
    const bottom = Math.round(fragmentGeometry.bottom);
    const id = fragment.id + "__sequenceFragment";
    // mxGraph paints edges below vertices. A filled fragment vertex would cover every
    // message/lifeline behind it, so keep the fragment interior transparent and only draw its frame.
    const style = "rounded=1;arcSize=" + RENDER_METRICS.fragment.radius + ";whiteSpace=wrap;html=1;fillColor=" + palette.fragmentFill +
      ";fillOpacity=" + Math.round(palette.fragmentOpacity * 100) + ";strokeColor=" + palette.fragmentStroke +
      ";strokeWidth=" + RENDER_METRICS.fragment.strokeWidth + ";dashed=1;dashPattern=" + RENDER_METRICS.fragment.dashPattern +
      ";fontColor=" + palette.fragmentText + ";fontSize=" + RENDER_METRICS.fragmentLabel.size + ";fontFamily=Arial;align=left;verticalAlign=top;spacingLeft=58;spacingTop=5;studioSequenceFragment=1;studioFragmentKind=" + fragment.kind + ";studioStartOrder=" + fragment.startOrder + ";studioEndOrder=" + fragment.endOrder + ";studioFragmentParticipants=" + (fragment.participants || []).join(",") + ";";
    const label = fragment.kind.toUpperCase() + " · " + fragment.label;
    vertices.push("<mxCell id=\"" + esc(id) + "\" value=\"" + esc(label) + "\" style=\"" + esc(style) + "\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"" +
      minX + "\" y=\"" + top + "\" width=\"" + (maxX - minX) + "\" height=\"" + (bottom - top) + "\" as=\"geometry\"/></mxCell>");
  }
  for (const activation of deriveSequenceActivations(doc)) {
    const participant = doc.nodes.find((node) => node.id === activation.participantId);
    if (!participant) continue;
    const geometry = sequenceActivationGeometry(activation.startOrder, activation.endOrder, participant.x + participant.width / 2);
    const activationId = activation.id + "__sequenceActivation";
    vertices.push("<mxCell id=\"" + esc(activationId) + "\" value=\"\" style=\"rounded=0;whiteSpace=wrap;html=1;fillColor=" + palette.activationFill + ";strokeColor=" + palette.activationStroke + ";strokeWidth=1;\" vertex=\"1\" parent=\"1\"><mxGeometry x=\"" +
      Math.round(geometry.x) + "\" y=\"" + Math.round(geometry.y) + "\" width=\"" + geometry.width + "\" height=\"" + Math.round(geometry.height) + "\" as=\"geometry\"/></mxCell>");
  }
  for (const relation of doc.relations) {
    const source = doc.nodes.find((n) => n.id === relation.source);
    const target = doc.nodes.find((n) => n.id === relation.target);
    if (!source || !target) continue;
    const geometry = sequenceMessageGeometry(doc, relation);
    if (!geometry) continue;
    const style = mxEdgeStyle({ ...relation, points: geometry.points, routing: "polyline" }, "polyline", theme) +
      ";studioSource=" + esc(relation.source) + ";studioTarget=" + esc(relation.target) +
      ";studioKind=" + relation.kind +
      (relation.sequenceOrder === undefined ? "" : ";studioSequenceOrder=" + relation.sequenceOrder) + ";";
    // Floating endpoints keep the message on the shared timeline. Self-calls
    // additionally carry waypoints so Draw.io paints the same loop as Studio.
    edges.push("<mxCell id=\"" + esc(relation.id) + "\" value=\"" + esc(relation.label) +
      "\" style=\"" + esc(style) + "\" edge=\"1\" parent=\"1\"><mxGeometry relative=\"1\" as=\"geometry\">" +
      "<mxPoint x=\"" + Math.round(geometry.start.x) + "\" y=\"" + Math.round(geometry.start.y) + "\" as=\"sourcePoint\"/>" +
      pointXml(geometry.points) +
      "<mxPoint x=\"" + Math.round(geometry.end.x) + "\" y=\"" + Math.round(geometry.end.y) + "\" as=\"targetPoint\"/>" +
      "</mxGeometry></mxCell>");
  }
  return { vertices: vertices.join(""), edges: edges.join("") };
}

export function toDrawioXml(doc: DiagramDocument): string {
  const theme = normalizeRenderTheme(doc.renderTheme);
  const support = sequenceSupport(doc, theme);
  const cells = "<mxCell id=\"0\"/><mxCell id=\"1\" parent=\"0\"/>" +
    doc.boundaries.map((boundary) => boundaryXml(doc, boundary, theme)).join("") +
    doc.nodes.map((node) => vertexXml(node, theme) + accentXml(node, theme)).join("") + support.vertices +
    (doc.kind === "sequence" ? support.edges : doc.relations.map((relation) => edgeXml(relation, doc.layout.routing, doc, theme)).join(""));
  const maxX = Math.max(1200, ...doc.nodes.map((n) => n.x + n.width + 120));
  const maxY = Math.max(doc.kind === "sequence" ? 800 : 700,
    doc.kind === "sequence" ? sequenceLifelineBottom(doc.relations.length) + 38 : 0,
    ...doc.nodes.map((n) => n.y + n.height + 120));
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<mxfile host=\"app.diagrams.net\" modified=\"" + new Date().toISOString() + "\" agent=\"Architecture Diagram Studio V2\" version=\"32.0.2\" type=\"device\">" +
    "<diagram id=\"" + esc(doc.id) + "\" name=\"" + esc(doc.title) + "\"><mxGraphModel dx=\"1200\" dy=\"800\" grid=\"1\" gridSize=\"" + tokens.grid + "\" guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"1\" pageScale=\"1\" pageWidth=\"" +
    Math.round(maxX) + "\" pageHeight=\"" + Math.round(maxY) + "\" math=\"0\" shadow=\"0\"><root>" + cells + "</root></mxGraphModel></diagram></mxfile>";
}

export function downloadText(filename: string, content: string, mime = "application/xml;charset=utf-8"): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
export function nodeAccent(node: DiagramNode): string {
  return nodePaint(node).accent;
}