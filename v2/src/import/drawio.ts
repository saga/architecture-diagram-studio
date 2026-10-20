import type { DiagramDocument, DiagramNode, DiagramRelation, NodeRole, Point } from "../model/types";

function plainLabel(value: string): string {
  const container = document.createElement("div");
  container.innerHTML = value;
  return (container.textContent || container.innerText || value).replace(/\s+/g, " ").trim();
}
function roleFromStyle(style: string): NodeRole {
  if (style.includes("rhombus")) return "decision";
  if (style.includes("ellipse") || style.includes("arcSize=50")) return "service";
  if (style.includes("database") || style.includes("cylinder")) return "storage";
  return "domain";
}
export function fromDrawioXml(xml: string, previous: DiagramDocument): DiagramDocument {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  if (parsed.querySelector("parsererror")) return previous;
  const cells = Array.from(parsed.querySelectorAll("mxGraphModel root mxCell"));
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const previousRelations = new Map(previous.relations.map((relation) => [relation.id, relation]));
  const boundaryIds = new Set(previous.boundaries.map((boundary) => boundary.id));
  const nodes: DiagramNode[] = [];
  const relations: DiagramRelation[] = [];
  for (const cell of cells) {
    const id = cell.getAttribute("id") || "";
    if (!id || id === "0" || id === "1" || id.endsWith("__lifelineEnd") ||
        id.endsWith("__messageSourceAnchor") || id.endsWith("__messageTargetAnchor") ||
        id.endsWith("__lifeline") || boundaryIds.has(id)) continue;
    const value = plainLabel(cell.getAttribute("value") || "");
    const style = cell.getAttribute("style") || "";
    if (cell.getAttribute("vertex") === "1") {
      const geometry = cell.querySelector(":scope > mxGeometry");
      const old = previousNodes.get(id);
      if (!geometry) continue;
      nodes.push({
        ...(old || { id, name: value || "New node", role: roleFromStyle(style), visualRole: "secondary", width: 180, height: 78, x: 0, y: 0, layoutHints: {} }),
        name: value || (old ? old.name : "New node"),
        x: Number(geometry.getAttribute("x") || 0), y: Number(geometry.getAttribute("y") || 0),
        width: Number(geometry.getAttribute("width") || 180), height: Number(geometry.getAttribute("height") || 78),
        layoutHints: { ...((old && old.layoutHints) || {}), locked: true }
      });
    } else if (cell.getAttribute("edge") === "1") {
      if (id.endsWith("__lifeline")) continue;
      const rawSource = cell.getAttribute("source") || "";
      const rawTarget = cell.getAttribute("target") || "";
      const old = previousRelations.get(id);
      const source = rawSource.includes("__messageSourceAnchor") ? (old?.source || rawSource.replace("__messageSourceAnchor", "")) : rawSource;
      const target = rawTarget.includes("__messageTargetAnchor") ? (old?.target || rawTarget.replace("__messageTargetAnchor", "")) : rawTarget;
      if (!previousNodes.has(source) && !nodes.some((node) => node.id === source)) continue;
      if (!previousNodes.has(target) && !nodes.some((node) => node.id === target)) continue;
      const geometry = cell.querySelector(":scope > mxGeometry");
      const pointElements = geometry ? Array.from(geometry.querySelectorAll("Array[as='points'] mxPoint")) : [];
      const points: Point[] = pointElements.map((point) => ({ x: Number(point.getAttribute("x") || 0), y: Number(point.getAttribute("y") || 0) }));
      relations.push({
        ...(old || { id, source, target, label: value, kind: "flow" }),
        source, target, label: value,
        dashed: style.includes("dashed=1"),
        routing: style.includes("curved=1") ? "curved" : style.includes("edgeStyle=orthogonalEdgeStyle") ? "orthogonal" : "polyline",
        points
      });
    }
  }
  if (nodes.length === 0) return previous;
  const relationList = relations.length ? relations : previous.relations.filter((relation) => nodes.some((node) => node.id === relation.source) && nodes.some((node) => node.id === relation.target));
  return { ...previous, nodes, relations: relationList };
}