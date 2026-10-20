import type { DiagramDocument, DiagramNode, DiagramRelation, NodeRole, Point } from "../model/types";

function plainLabel(value: string): string {
  const container = document.createElement("div");
  container.innerHTML = value;
  return (container.textContent || container.innerText || value).replace(/\s+/g, " ").trim();
}
function roleFromStyle(style: string): NodeRole {
  const explicit = style.match(/(?:^|;)studioRole=([^;]+)/)?.[1];
  const allowed: NodeRole[] = ["actor", "source", "entry", "ui", "domain", "business", "api", "worker", "data", "storage", "external", "vendor", "infra", "decision", "start", "end", "service"];
  if (explicit && allowed.includes(explicit as NodeRole)) return explicit as NodeRole;
  if (style.includes("rhombus")) return "decision";
  if (style.includes("ellipse") || style.includes("arcSize=50")) return "service";
  if (style.includes("database") || style.includes("cylinder")) return "storage";
  return "domain";
}
function visualRoleFromStyle(style: string): DiagramNode["visualRole"] {
  const explicit = style.match(/(?:^|;)studioVisualRole=([^;]+)/)?.[1];
  const allowed: DiagramNode["visualRole"][] = ["primary", "secondary", "muted", "external", "highlight"];
  return explicit && allowed.includes(explicit as DiagramNode["visualRole"]) ? explicit as DiagramNode["visualRole"] : "secondary";
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
  const importedBoundaries = [...previous.boundaries];
  for (const cell of cells) {
    const id = cell.getAttribute("id") || "";
    if (!id || id === "0" || id === "1" || id.endsWith("__lifelineEnd") ||
        id.endsWith("__messageSourceAnchor") || id.endsWith("__messageTargetAnchor") ||
        id.endsWith("__lifeline") || boundaryIds.has(id)) continue;
    const value = plainLabel(cell.getAttribute("value") || "");
    const style = cell.getAttribute("style") || "";
    if (cell.getAttribute("vertex") === "1") {
      if (style.includes("studioBoundary=1")) {
        const members = style.match(/(?:^|;)studioMembers=([^;]+)/)?.[1]?.split(",").filter(Boolean) || [];
        importedBoundaries.push({ id, name: value || "SYSTEM BOUNDARY", members });
        continue;
      }
      const geometry = cell.querySelector(":scope > mxGeometry");
      const old = previousNodes.get(id);
      if (!geometry) continue;
      nodes.push({
        ...(old || { id, name: value || "New node", role: roleFromStyle(style), visualRole: visualRoleFromStyle(style), width: 180, height: 78, x: 0, y: 0, layoutHints: {} }),
        name: value || (old ? old.name : "New node"),
        x: Number(geometry.getAttribute("x") || 0), y: Number(geometry.getAttribute("y") || 0),
        width: Number(geometry.getAttribute("width") || 180), height: Number(geometry.getAttribute("height") || 78),
        layoutHints: { ...((old && old.layoutHints) || {}), locked: true }
      });
    } else if (cell.getAttribute("edge") === "1") {
      if (id.endsWith("__lifeline")) continue;
      const rawSource = cell.getAttribute("source") || "";
      const rawTarget = cell.getAttribute("target") || "";
      const styleSource = style.match(/(?:^|;)studioSource=([^;]+)/)?.[1];
      const styleTarget = style.match(/(?:^|;)studioTarget=([^;]+)/)?.[1];
      const old = previousRelations.get(id);
      const source = styleSource || (rawSource.includes("__messageSourceAnchor") ? old?.source || rawSource : rawSource);
      const target = styleTarget || (rawTarget.includes("__messageTargetAnchor") ? old?.target || rawTarget : rawTarget);
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
  return { ...previous, nodes, relations: relationList, boundaries: importedBoundaries };
}