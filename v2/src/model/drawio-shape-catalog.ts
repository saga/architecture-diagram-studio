/**
 * Curated, local shape catalogue for common native Draw.io primitives.
 * This intentionally is not a complete inventory of the thousands of Draw.io shapes.
 * A search miss is inconclusive and must never be treated as an availability result.
 */
export interface DrawioShapeCatalogEntry {
  id: string;
  title: string;
  category: string;
  kind: "vertex" | "edge";
  style: string;
  width: number;
  height: number;
  tags: string[];
}
export interface DrawioShapeSearchResult extends Omit<DrawioShapeCatalogEntry, "tags"> {
  matchedTags: string[];
}
const SHAPE_CATALOG: readonly DrawioShapeCatalogEntry[] = [
  { id: "c4.person", title: "C4 Person (person2)", category: "C4", kind: "vertex", style: "shape=mxgraph.c4.person2;whiteSpace=wrap;html=1;align=center;metaEdit=1;points=[[0.5,0,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0]];fillColor=#08427b;fontColor=#ffffff;strokeColor=#073763;fontSize=11;", width: 200, height: 180, tags: ["c4", "directory", "c4 directory", "c4 diagram", "c4 notation", "person", "person2", "actor", "user", "customer", "人员", "用户", "人物", "c4 person"] },
  { id: "c4.software-system", title: "C4 Software System", category: "C4", kind: "vertex", style: "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontColor=#ffffff;fillColor=#1168bd;strokeColor=#0D5091;fontSize=11;", width: 240, height: 120, tags: ["c4", "directory", "c4 directory", "c4 diagram", "c4 notation", "software system", "system", "application", "internal system", "软件系统", "系统", "应用", "内部系统"] },
  { id: "c4.container", title: "C4 Container", category: "C4", kind: "vertex", style: "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontColor=#ffffff;fillColor=#23a2d9;strokeColor=#0E7DAD;fontSize=11;", width: 240, height: 120, tags: ["c4", "directory", "c4 directory", "c4 diagram", "c4 notation", "container", "web app", "api", "service", "database", "容器", "应用容器", "服务"] },
  { id: "c4.relationship", title: "C4 Relationship (edge)", category: "C4", kind: "edge", style: "edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#707070;fontColor=#404040;fontSize=10;", width: 0, height: 0, tags: ["c4", "directory", "c4 directory", "c4 diagram", "c4 notation", "relationship", "relationships", "edge", "connector", "arrow", "关系", "连线", "依赖"] },
  { id: "basic.rectangle", title: "Rectangle / Process", category: "Basic", kind: "vertex", style: "whiteSpace=wrap;html=1;", width: 140, height: 60, tags: ["rectangle", "rect", "box", "process", "service", "component", "矩形", "方框", "流程", "流程节点"] },
  { id: "basic.rounded-rectangle", title: "Rounded Rectangle", category: "Basic", kind: "vertex", style: "rounded=1;whiteSpace=wrap;html=1;", width: 140, height: 60, tags: ["rounded", "rounded rectangle", "application", "service", "圆角矩形", "圆角", "服务", "应用"] },
  { id: "basic.ellipse", title: "Ellipse / Circle", category: "Basic", kind: "vertex", style: "ellipse;whiteSpace=wrap;html=1;", width: 80, height: 80, tags: ["ellipse", "circle", "oval", "start", "end", "椭圆", "圆形", "开始", "结束"] },
  { id: "flowchart.decision", title: "Flowchart Decision / Diamond", category: "Flowchart", kind: "vertex", style: "rhombus;whiteSpace=wrap;html=1;", width: 120, height: 80, tags: ["decision", "diamond", "condition", "gateway", "判断", "菱形", "条件", "网关"] },
  { id: "flowchart.database", title: "Database Cylinder", category: "Flowchart", kind: "vertex", style: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;", width: 100, height: 70, tags: ["database", "cylinder", "data store", "storage", "db", "数据库", "存储", "圆柱"] },
  { id: "flowchart.document", title: "Flowchart Document", category: "Flowchart", kind: "vertex", style: "shape=mxgraph.flowchart.document;whiteSpace=wrap;html=1;", width: 120, height: 80, tags: ["document", "file", "paper", "report", "文档", "文件", "报告"] },
  { id: "network.cloud", title: "Cloud", category: "Network", kind: "vertex", style: "shape=cloud;whiteSpace=wrap;html=1;", width: 120, height: 80, tags: ["cloud", "network", "internet", "云", "云端", "网络", "互联网"] },
  { id: "uml.actor", title: "UML Actor", category: "UML", kind: "vertex", style: "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;", width: 30, height: 60, tags: ["uml", "actor", "participant", "stick figure", "参与者", "演员", "用例"] },
  { id: "uml.lifeline", title: "UML Lifeline", category: "UML", kind: "vertex", style: "shape=umlLifeline;perimeter=lifelinePerimeter;size=16;", width: 20, height: 100, tags: ["uml", "lifeline", "sequence", "participant", "生命线", "时序", "参与者"] },
  { id: "connector.orthogonal-arrow", title: "Orthogonal Arrow Connector", category: "Connector", kind: "edge", style: "edgeStyle=orthogonalEdgeStyle;html=1;endArrow=block;endFill=1;", width: 0, height: 0, tags: ["connector", "edge", "arrow", "orthogonal", "link", "连接线", "连线", "箭头", "直角"] }
];
function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}
function tokenize(query: string): string[] {
  return [...new Set(normalize(query).split(/[^\p{L}\p{N}]+/u).filter((part) => part.length > 0))];
}
export interface DrawioShapeSearchPage {
  results: DrawioShapeSearchResult[];
  /** Exact number of matching entries before applying the requested limit. */
  matchCount: number;
  returnedCount: number;
  truncated: boolean;
}

/** Includes completeness metadata so callers cannot mistake a limited result set for the full catalogue match. */
export function searchDrawioShapeCatalogDetailed(query: string, limit = 5): DrawioShapeSearchPage {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { results: [], matchCount: 0, returnedCount: 0, truncated: false };
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(8, Math.floor(limit))) : 5;
  const scored = SHAPE_CATALOG.map((entry) => {
    const searchable = normalize([entry.id, entry.title, entry.category, ...entry.tags].join(" "));
    const matchedTags = entry.tags.filter((tag) => tokens.some((token) => normalize(tag).includes(token) || token.includes(normalize(tag))));
    const allMatched = tokens.every((token) => searchable.includes(token));
    const exactId = normalize(entry.id) === normalize(query);
    const score = tokens.reduce((sum, token) => sum + (searchable.includes(token) ? 1 : 0), 0);
    return { entry, matchedTags, allMatched, exactId, score };
  }).filter((item) => item.exactId || item.allMatched)
    .sort((a, b) => Number(b.exactId) - Number(a.exactId) || b.score - a.score || a.entry.title.localeCompare(b.entry.title));
  const results = scored.slice(0, safeLimit).map(({ entry, matchedTags }) => ({
    id: entry.id, title: entry.title, category: entry.category, kind: entry.kind,
    style: entry.style, width: entry.width, height: entry.height, matchedTags
  }));
  return {
    results,
    matchCount: scored.length,
    returnedCount: results.length,
    truncated: scored.length > results.length
  };
}

/** Compatibility helper for callers that only need the entries, not pagination metadata. */
export function searchDrawioShapeCatalog(query: string, limit = 5): DrawioShapeSearchResult[] {
  return searchDrawioShapeCatalogDetailed(query, limit).results;
}
export const DRAWIO_SHAPE_CATALOG_VERSION = "drawio-v32.0.2-curated-4";

/**
 * `C4 directory` answers a complete C4 creation turn: the three element recipes, the
 * relationship edge recipe, and this script skeleton. A C4 creation request therefore needs one
 * catalogue query and no reference lookup.
 */
export const C4_DIRECTORY_SCRIPT_TEMPLATE = [
  "const parent = graph.getDefaultParent();",
  "const created = [];",
  "const add = (label, style, width, height, x, y) => {",
  "  const cell = graph.insertVertex(parent, null, label, x, y, width, height, style);",
  "  created.push(cell);",
  "  return cell;",
  "};",
  "const link = (source, target, label, style) => {",
  "  const edge = graph.insertEdge(parent, null, label, source, target, style);",
  "  created.push(edge);",
  "  return edge;",
  "};",
  "// Paste the exact style string and dimensions returned for each recipe; do not rewrite them.",
  "const person = add(\"Person\", PERSON_STYLE, 200, 180, 40, 40);",
  "const system = add(\"System\", SYSTEM_STYLE, 240, 120, 320, 60);",
  "// Keep the edge label empty unless the request supplies the protocol or action.",
  "const relationship = link(person, system, \"\", RELATIONSHIP_STYLE);",
  "return {",
  "  ok: true,",
  "  postconditions: { created: created.length > 0 },",
  "  xmlAssertions: [",
  "    { cellId: person.id, exists: true, kind: \"vertex\", label: \"Person\" },",
  "    { cellId: system.id, exists: true, kind: \"vertex\", label: \"System\" },",
  "    { cellId: relationship.id, exists: true, kind: \"edge\", sourceId: person.id, targetId: system.id }",
  "  ]",
  "};"
].join("\n");

export function isC4DirectoryQuery(query: string): boolean {
  const tokens = tokenize(query);
  return tokens.includes("c4") && tokens.includes("directory");
}
