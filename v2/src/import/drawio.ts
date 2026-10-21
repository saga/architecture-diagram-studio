import { inflateSync } from "fflate";
import type { DiagramDocument, DiagramNode, DiagramRelation, NodeRole, Point, SequenceFragment } from "../model/types";

function plainLabel(value: string): string {
  const container = document.createElement("div");
  container.innerHTML = value;
  // Studio-exported labels contain title, technology and description in separate divs.
  // Editing a Draw.io node should update its title without concatenating those fields.
  const firstBlock = container.querySelector("div");
  const text = firstBlock ? (firstBlock.textContent || firstBlock.innerText || "") : (container.textContent || container.innerText || value);
  return text.replace(/\s+/g, " ").trim();
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
function parseDrawioXml(xml: string): XMLDocument | null {
  const parser = new DOMParser();
  let parsed = parser.parseFromString(xml, "application/xml");
  if (parsed.querySelector("parsererror")) return null;
  if (parsed.querySelector("mxGraphModel")) return parsed;

  const diagram = parsed.querySelector("mxfile > diagram");
  const compressed = diagram?.textContent?.trim();
  if (!compressed) return null;
  try {
    const binary = atob(compressed);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const inflated = inflateSync(bytes);
    const decoded = new TextDecoder().decode(inflated);
    const decodedXml = decodeURIComponent(decoded);
    parsed = parser.parseFromString(decodedXml, "application/xml");
    return parsed.querySelector("parsererror") ? null : parsed;
  } catch {
    return null;
  }
}

export function fromDrawioXml(xml: string, previous: DiagramDocument): DiagramDocument {
  const parsed = parseDrawioXml(xml);
  if (!parsed) return previous;
  const cells = Array.from(parsed.querySelectorAll("mxGraphModel root mxCell"));
  const currentCellIds = new Set(cells.map((cell) => cell.getAttribute("id") || ""));
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const previousRelations = new Map(previous.relations.map((relation) => [relation.id, relation]));
  const nodes: DiagramNode[] = [];
  const relations: DiagramRelation[] = [];
  const importedBoundaries = new Map(previous.boundaries
    .filter((boundary) => currentCellIds.has(boundary.id))
    .map((boundary) => [boundary.id, { ...boundary, members: [...boundary.members] }]));
  const importedFragments = new Map<string, SequenceFragment>((previous.sequence?.fragments || [])
    .filter((fragment) => currentCellIds.has(fragment.id + "__sequenceFragment"))
    .map((fragment) => [fragment.id, { ...fragment }]));
  for (const cell of cells) {
    const id = cell.getAttribute("id") || "";
    if (!id || id === "0" || id === "1" || id.endsWith("__lifelineEnd") ||
        id.endsWith("__messageSourceAnchor") || id.endsWith("__messageTargetAnchor") ||
        id.endsWith("__lifeline") || id.endsWith("__sequenceActivation")) continue;
    const value = plainLabel(cell.getAttribute("value") || "");
    const style = cell.getAttribute("style") || "";
    if (cell.getAttribute("vertex") === "1") {
      if (style.includes("studioBoundary=1")) {
        const members = style.match(/(?:^|;)studioMembers=([^;]+)/)?.[1]?.split(",").filter(Boolean) || [];
        importedBoundaries.set(id, { id, name: value || "SYSTEM BOUNDARY", members });
        continue;
      }
      if (id.endsWith("__sequenceFragment")) {
        const fragmentId = id.slice(0, -"__sequenceFragment".length);
        if (style.includes("studioSequenceFragment=1")) {
          const fragmentKind = style.match(/(?:^|;)studioFragmentKind=(alt|opt|loop)(?:;|$)/)?.[1];
          const startOrder = Number(style.match(/(?:^|;)studioStartOrder=(\d+)(?:;|$)/)?.[1]);
          const endOrder = Number(style.match(/(?:^|;)studioEndOrder=(\d+)(?:;|$)/)?.[1]);
          if (fragmentKind && Number.isFinite(startOrder) && Number.isFinite(endOrder) && endOrder >= startOrder) {
            const label = value.replace(/^(ALT|OPT|LOOP)\s*[·:-]?\s*/i, "").trim();
            importedFragments.set(fragmentId, { id: fragmentId, kind: fragmentKind as SequenceFragment["kind"], label, startOrder, endOrder });
          }
        }
        continue;
      }
      const geometry = cell.querySelector(":scope > mxGeometry");
      const old = previousNodes.get(id);
      if (!geometry) continue;
      const x = Number(geometry.getAttribute("x") || 0);
      const y = Number(geometry.getAttribute("y") || 0);
      const width = Number(geometry.getAttribute("width") || 180);
      const height = Number(geometry.getAttribute("height") || 78);
      const positionChanged = Boolean(old && (Math.abs(old.x - x) > 1 || Math.abs(old.y - y) > 1));
      nodes.push({
        ...(old || { id, name: value || "New node", role: roleFromStyle(style), visualRole: visualRoleFromStyle(style), width: 180, height: 78, x: 0, y: 0, layoutHints: {} }),
        name: value || (old ? old.name : "New node"),
        x, y, width, height,
        layoutHints: {
          ...((old && old.layoutHints) || {}),
          locked: old ? Boolean(old.layoutHints?.locked) || positionChanged : false
        }
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
      const explicitKind = style.match(/(?:^|;)studioKind=(flow|call|return|async|event|dependency)(?:;|$)/)?.[1] as DiagramRelation["kind"] | undefined;
      const explicitSequenceOrder = style.match(/(?:^|;)studioSequenceOrder=(\d+)(?:;|$)/)?.[1];
      relations.push({
        ...(old || { id, source, target, label: value, kind: explicitKind || "flow" }),
        source, target, label: value,
        kind: explicitKind || old?.kind || "flow",
        sequenceOrder: explicitSequenceOrder === undefined ? old?.sequenceOrder : Number(explicitSequenceOrder),
        dashed: style.includes("dashed=1"),
        routing: style.includes("curved=1") ? "curved" : style.includes("edgeStyle=orthogonalEdgeStyle") ? "orthogonal" : "polyline",
        points
      });
    }
  }
  if (nodes.length === 0) return previous;
  const relationList = relations.length ? relations : previous.relations.filter((relation) => nodes.some((node) => node.id === relation.source) && nodes.some((node) => node.id === relation.target));
  const importedNodeIds = new Set(nodes.map((node) => node.id));
  const boundaries = [...importedBoundaries.values()].map((boundary) => ({
    ...boundary,
    members: boundary.members.filter((id) => importedNodeIds.has(id))
  }));
  const isSequenceDiagram = previous.kind === "sequence" || cells.some((cell) => {
    const cellId = cell.getAttribute("id") || "";
    return cellId.endsWith("__lifelineEnd") || cellId.endsWith("__messageSourceAnchor");
  }) || importedFragments.size > 0;
  const declaredParticipants = previous.sequence?.participants || [];
  const sequence = isSequenceDiagram ? {
    participants: [
      ...declaredParticipants.filter((id) => importedNodeIds.has(id)),
      ...nodes.map((node) => node.id).filter((id) => !declaredParticipants.includes(id))
    ],
    fragments: [...importedFragments.values()]
  } : previous.sequence;
  const imported: DiagramDocument = {
    ...previous,
    kind: isSequenceDiagram ? "sequence" : previous.kind,
    layout: isSequenceDiagram ? { ...previous.layout, direction: "RIGHT", routing: "polyline" } : previous.layout,
    nodes, relations: relationList, boundaries, sequence
  };
  return imported;
}