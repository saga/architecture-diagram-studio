import type { DiagramDocument } from "../src/model/types";
import { LAYOUT_PROFILES, resolveLayoutProfile } from "../src/layout/profiles";

export function validateDiagramSemantics(document: DiagramDocument): string[] {
  const errors: string[] = [];
  if (document.id.length > 128 || document.title.length > 300) errors.push("Diagram id or title is too long");
  if (document.nodes.length > 500 || document.relations.length > 2000 || document.boundaries.length > 300) errors.push("Diagram exceeds the server-side size limits");
  const nodeIds = new Set<string>(), relationIds = new Set<string>(), boundaryIds = new Set<string>();
  const nodeRoles = new Set(["actor","source","entry","ui","domain","business","api","worker","data","storage","external","vendor","infra","decision","start","end","service"]);
  const visualRoles = new Set(["primary","secondary","muted","external","highlight"]);
  const relationKinds = new Set(["flow","call","return","async","event","dependency"]);
  for (const node of document.nodes) {
    if (!node.id || node.id.length > 128 || nodeIds.has(node.id)) errors.push("Node id is empty, too long or duplicated: " + node.id);
    nodeIds.add(node.id);
    if (!nodeRoles.has(node.role) || !visualRoles.has(node.visualRole)) errors.push("Invalid node role: " + node.id);
    if (![node.x,node.y,node.width,node.height].every(Number.isFinite) || Math.abs(node.x) > 100000 || Math.abs(node.y) > 100000 || node.width <= 0 || node.width > 5000 || node.height <= 0 || node.height > 5000) errors.push("Invalid node geometry: " + node.id);
    if (node.name.length > 500 || (node.description || "").length > 4000 || (node.technology || "").length > 500) errors.push("Node text is too long: " + node.id);
  }
  for (const relation of document.relations) {
    if (!relation.id || relation.id.length > 128 || relationIds.has(relation.id)) errors.push("Relation id is empty, too long or duplicated: " + relation.id);
    relationIds.add(relation.id);
    if (!nodeIds.has(relation.source) || !nodeIds.has(relation.target)) errors.push("Relation endpoint does not exist: " + relation.id);
    if (!relationKinds.has(relation.kind) || relation.label.length > 1000) errors.push("Invalid relation kind or label: " + relation.id);
    if ((relation.points || []).some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 100000 || Math.abs(point.y) > 100000)) errors.push("Invalid relation path coordinates: " + relation.id);
  }
  for (const boundary of document.boundaries) {
    if (!boundary.id || boundary.id.length > 128 || boundaryIds.has(boundary.id)) errors.push("Boundary id is empty, too long or duplicated: " + boundary.id);
    boundaryIds.add(boundary.id);
    if (boundary.name.length > 500 || (boundary.description || "").length > 4000 || boundary.members.some((id) => !nodeIds.has(id))) errors.push("Boundary text is too long or references a missing node: " + boundary.id);
  }
  if (![document.layout.nodeSpacing, document.layout.layerSpacing, document.layout.boundaryPadding].every((value) => Number.isFinite(value) && value >= 0 && value <= 5000)) errors.push("Invalid layout spacing");
  if (document.kind !== "sequence" && !LAYOUT_PROFILES.some((profile) => profile.value === resolveLayoutProfile(document.layout.profile))) errors.push("Unsupported layout algorithm: " + document.layout.profile);
  if (document.flow && document.flow.primaryPath.some((id) => !nodeIds.has(id))) errors.push("The primary path references a missing node");
  if (document.sequence && document.sequence.participants.some((id) => !nodeIds.has(id))) errors.push("A sequence participant references a missing node");
  return [...new Set(errors)].slice(0, 100);
}

export type DiagramTemplateKey = "c4-context" | "service-queue-database" | "sequence-request";
export function createDiagramTemplate(key: DiagramTemplateKey): DiagramDocument {
  const sequence = key === "sequence-request";
  const c4 = key === "c4-context";
  const doc: DiagramDocument = {
    schemaVersion: 2, id: "template-" + key, title: c4 ? "System Context" : sequence ? "Request Sequence" : "Service with Queue and Database",
    kind: sequence ? "sequence" : c4 ? "c4" : "flowchart", ...(c4 ? { variant: "context" as const } : {}),
    theme: "studio-editorial", nodes: [], relations: [], boundaries: [],
    layout: { profile: sequence ? "sequence-standard" : "elk-layered", direction: "RIGHT", routing: sequence ? "polyline" : "orthogonal", nodeSpacing: 52, layerSpacing: 104, boundaryPadding: 34, externalSide: "RIGHT", storageSide: "BOTTOM" }
  };
  const node = (id: string, name: string, role: DiagramDocument["nodes"][number]["role"], visualRole: DiagramDocument["nodes"][number]["visualRole"]) => ({ id, name, role, visualRole, x: 0, y: 0, width: 190, height: 82, layoutHints: {} });
  const relation = (id: string, source: string, target: string, label: string, kind: DiagramDocument["relations"][number]["kind"], sequenceOrder?: number) => ({ id, source, target, label, kind, sequenceOrder, points: [] });
  if (c4) {
    doc.nodes = [node("person", "Person", "actor", "secondary"), node("system", "Software System", "service", "primary"), node("external-system", "External System", "external", "external")];
    doc.relations = [relation("person-system", "person", "system", "Uses", "call"), relation("system-external", "system", "external-system", "Integrates with", "dependency")];
  } else if (sequence) {
    doc.nodes = [node("client", "Client", "actor", "secondary"), node("api", "API", "api", "primary"), node("service", "Service", "service", "primary"), node("store", "Data Store", "storage", "secondary")];
    doc.sequence = { participants: ["client", "api", "service", "store"] };
    doc.relations = [relation("request", "client", "api", "Request", "call", 1), relation("invoke", "api", "service", "Invoke", "call", 2), relation("read", "service", "store", "Read / Write", "call", 3), relation("response", "api", "client", "Response", "return", 4)];
  } else {
    doc.nodes = [node("client", "Client", "actor", "secondary"), node("api", "API Service", "api", "primary"), node("worker", "Background Worker", "worker", "secondary"), node("queue", "Message Queue", "infra", "muted"), node("database", "Database", "storage", "secondary")];
    doc.relations = [relation("request", "client", "api", "Request", "call"), relation("enqueue", "api", "queue", "Publish event", "async"), relation("consume", "queue", "worker", "Consume event", "event"), relation("persist", "worker", "database", "Persist result", "dependency")];
    doc.boundaries = [{ id: "application-boundary", name: "Application", members: ["api", "worker"], description: "Application services" }];
  }
  return doc;
}
