import type { DiagramDocument, DiagramNode, DiagramRelation } from "./types";

const node = (
  id: string, name: string, role: DiagramNode["role"], visualRole: DiagramNode["visualRole"],
  description = "", technology = ""
): DiagramNode => ({
  id, name, role, visualRole, description, technology,
  x: 0, y: 0,
  width: role === "decision" ? 156 : role === "actor" || role === "start" || role === "end" ? 154 : 190,
  height: role === "decision" ? 84 : 82,
  layoutHints: {}
});

const edge = (
  id: string, source: string, target: string, label: string,
  kind: DiagramRelation["kind"] = "flow", sequenceOrder?: number
): DiagramRelation => ({ id, source, target, label, kind, sequenceOrder, points: [] });

const base = (id: string, title: string, kind: DiagramDocument["kind"]): DiagramDocument => ({
  schemaVersion: 2, id, title, kind, theme: "studio-editorial",
  nodes: [], relations: [], boundaries: [],
  layout: {
    profile: kind === "c4" ? "architecture-flow" : kind === "flowchart" ? "process-main-path" : "sequence-standard",
    direction: "RIGHT", routing: kind === "sequence" ? "polyline" : "orthogonal",
    nodeSpacing: 52, layerSpacing: 104, boundaryPadding: 34,
    externalSide: "RIGHT", storageSide: "BOTTOM"
  }
});

export function createC4Fixture(): DiagramDocument {
  const doc = base("c4-investment-platform", "Investment research platform", "c4");
  doc.variant = "container";
  doc.nodes = [
    node("analyst", "Investment analyst", "actor", "secondary", "Research and portfolio decisions"),
    node("portal", "Research portal", "ui", "primary", "Portfolio research workspace", "React"),
    node("bff", "Experience API", "entry", "secondary", "Authentication and request shaping", "Node.js"),
    node("domain", "Portfolio domain", "domain", "primary", "Business rules and portfolio context", "Java / Spring"),
    node("query", "Research query", "api", "secondary", "Vendor data access and aggregation", "REST API"),
    node("gateway", "Vendor adapter", "worker", "secondary", "Normalize vendor payloads"),
    node("vendor", "Market data provider", "external", "external", "External research and reference data"),
    node("postgres", "Operational store", "storage", "secondary", "Positions, preferences, workflow", "PostgreSQL"),
    node("snowflake", "Analytics warehouse", "storage", "secondary", "Historical and analytical queries", "Snowflake"),
    node("eks", "Application runtime", "infra", "muted", "Workload, observability and secrets", "AWS EKS")
  ];
  doc.relations = [
    edge("e1", "analyst", "portal", "Research request"),
    edge("e2", "portal", "bff", "HTTPS"),
    edge("e3", "bff", "domain", "Authenticated command"),
    edge("e4", "domain", "query", "Query context"),
    edge("e5", "query", "gateway", "Fetch data"),
    edge("e6", "gateway", "vendor", "Vendor API"),
    edge("e7", "domain", "postgres", "Operational state", "dependency"),
    edge("e8", "query", "snowflake", "Historical analytics", "dependency"),
    edge("e9", "eks", "domain", "Hosts", "dependency")
  ];
  doc.boundaries = [{
    id: "platform-boundary", name: "INVESTMENT RESEARCH PLATFORM",
    members: ["portal", "bff", "domain", "query", "gateway", "postgres", "snowflake", "eks"],
    description: "Internal application and data services"
  }];
  return doc;
}

export function createFlowFixture(): DiagramDocument {
  const doc = base("flow-proxy-vote", "Proxy voting workflow", "flowchart");
  doc.layout.profile = "process-main-path";
  doc.layout.nodeSpacing = 44;
  doc.layout.layerSpacing = 72;
  doc.nodes = [
    node("start", "New ballot", "start", "primary"),
    node("ingest", "Import ballot", "entry", "primary", "Load vendor agenda and resolutions"),
    node("validate", "Validate data", "service", "primary", "Completeness and duplicate checks"),
    node("valid", "Data complete?", "decision", "secondary"),
    node("enrich", "Enrich holdings", "worker", "secondary", "Resolve portfolio and issuer context"),
    node("review", "Manual review", "business", "secondary", "Resolve exceptions"),
    node("policy", "Apply voting policy", "domain", "primary", "Business rules and entitlements"),
    node("approve", "Approval required?", "decision", "secondary"),
    node("approval", "Approver decision", "business", "secondary", "Record rationale and approval"),
    node("submit", "Submit instructions", "api", "primary", "Send approved votes to custodian"),
    node("audit", "Persist audit trail", "storage", "secondary", "Evidence, decisions and timestamps"),
    node("end", "Completed", "end", "primary")
  ];
  doc.nodes = doc.nodes.map((item) => ({
    ...item,
    width: item.role === "decision" ? 156 : item.role === "start" || item.role === "end" ? 154 : 172
  }));
  doc.relations = [
    edge("f1", "start", "ingest", ""),
    edge("f2", "ingest", "validate", ""),
    edge("f3", "validate", "valid", ""),
    edge("f4", "valid", "enrich", "Yes"),
    edge("f5", "valid", "review", "No"),
    edge("f6", "review", "enrich", "Resolved"),
    edge("f7", "enrich", "policy", ""),
    edge("f8", "policy", "approve", ""),
    edge("f9", "approve", "approval", "Yes"),
    edge("f10", "approve", "submit", "No"),
    edge("f11", "approval", "submit", "Approved"),
    edge("f12", "submit", "audit", ""),
    edge("f13", "audit", "end", "")
  ];
  doc.flow = { primaryPath: ["start", "ingest", "validate", "valid", "enrich", "policy", "approve", "submit", "audit", "end"] };
  return doc;
}

export function createSequenceFixture(): DiagramDocument {
  const doc = base("sequence-auth-refresh", "Session renewal", "sequence");
  doc.nodes = [
    node("browser", "Browser", "actor", "secondary"),
    node("web", "Web app", "ui", "primary"),
    node("bff", "Experience API", "entry", "secondary"),
    node("identity", "Identity service", "api", "secondary"),
    node("session", "Session store", "storage", "muted")
  ];
  doc.relations = [
    edge("s1", "browser", "web", "Request protected page", "call", 0),
    edge("s2", "web", "bff", "GET /portfolio", "call", 1),
    edge("s3", "bff", "identity", "Validate access token", "call", 2),
    edge("s4", "identity", "session", "Read session", "call", 3),
    edge("s5", "session", "identity", "Session valid", "return", 4),
    edge("s6", "identity", "bff", "Token accepted", "return", 5),
    edge("s7", "bff", "web", "Portfolio response", "return", 6),
    edge("s8", "web", "browser", "Render page", "return", 7)
  ];
  doc.sequence = { participants: ["browser", "web", "bff", "identity", "session"] };
  return doc;
}

export const FIXTURES = { c4: createC4Fixture, flowchart: createFlowFixture, sequence: createSequenceFixture };