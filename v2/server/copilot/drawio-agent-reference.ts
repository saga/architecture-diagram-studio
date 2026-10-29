import { readFile } from "node:fs/promises";

export const DRAWIO_REFERENCE_TOPICS = [
  "overview", "api_ownership", "shape_discovery", "postconditions", "recipes", "all"
] as const;
export type DrawioReferenceTopic = (typeof DRAWIO_REFERENCE_TOPICS)[number];
const REFERENCE_URLS = [
  // Source execution (v2/server/copilot) and compiled execution (v2/dist/server/copilot).
  new URL("../../../docs/DRAWIO-AGENT-API-CONTRACT.md", import.meta.url),
  new URL("../../../../docs/DRAWIO-AGENT-API-CONTRACT.md", import.meta.url)
];
const MAX_REFERENCE_CHARS = 18_000;
function getSection(markdown: string, heading: string): string {
  const markers = [...markdown.matchAll(/^## (.+)$/gm)];
  const current = markers.find((match) => match[1]?.trim() === heading);
  if (current?.index === undefined) return "";
  const next = markers.find((match) => (match.index ?? -1) > current.index!);
  return markdown.slice(current.index, next?.index ?? markdown.length).trim();
}
function bounded(value: string): string {
  return value.length <= MAX_REFERENCE_CHARS
    ? value
    : value.slice(0, MAX_REFERENCE_CHARS) + "\n\n[Reference truncated at the configured response limit.]";
}
const XML_FIRST_CONTRACT = `# Draw.io XML-First Editing Contract

Native Draw.io XML is the only source of truth. Copilot mutations for workspace documents use the server-side \`edit_drawio_xml\` tool. Never execute or generate JavaScript for the Draw.io iframe.

Bind each edit to the exact current document revision and active page ID. Resolve targets from revision-bound native cell IDs; reject missing or ambiguous IDs. Preserve unrelated pages, cells, UserObject wrappers, custom shapes, unknown attributes, styles, geometry, and edge relationships.

Supported patch operations:
- \`set-cell-attributes\`: update explicit native mxCell attributes; for UserObject/object wrappers, label/value attributes are applied to the wrapper while geometry/style remain on its child mxCell.
- \`set-geometry\`: update explicit x/y/width/height values. 'set-geometry-xml' replaces the full native mxGeometry fragment, including connector waypoints and control points.
- \`delete-cell\`: remove only the requested cell or its UserObject/object wrapper.
- \`insert-cell-xml\`: insert a native mxCell or UserObject/object XML fragment with a unique ID under the existing page root.

Do not rebuild an existing diagram from a reduced model. Validate the result and report success only after the server returns a successful versioned persistence receipt. If the document revision changed, reload and retry against the new revision. After commit, the frontend must reload the authoritative workspace XML; stale autosave must not overwrite it. Standalone files keep their browser File System Access writeback workflow.

Use Studio's existing automatic-layout capability for layout requests. Do not reimplement or alter layout engines as part of XML editing.
`;

const XML_PATCH_RECIPES = `## Native XML patch recipes

Rename a normal cell:
\`\`\`json
{ "op": "set-cell-attributes", "cellId": "cell-id-from-current-context", "attributes": { "value": "New label" } }
\`\`\`

Change geometry without touching style or terminals:
\`\`\`json
{ "op": "set-geometry", "cellId": "cell-id-from-current-context", "geometry": { "x": 240, "y": 120 } }
\`\`\`

Add a native vertex under an existing page root:
\`\`\`json
{ "op": "insert-cell-xml", "parentId": "1", "cellXml": "<mxCell id=\\"new-unique-id\\" value=\\"New node\\" vertex=\\"1\\" parent=\\"1\\"><mxGeometry x=\\"240\\" y=\\"120\\" width=\\"120\\" height=\\"60\\" as=\\"geometry\\"/></mxCell>" }
\`\`\`

For edges, preserve valid source/target cell IDs and native geometry. For UserObject/object cells, keep the wrapper and inner mxCell together. Never invent IDs from stale context or assume IDs are unique across different pages; every patch must specify the active page ID.
`;

export function selectDrawioReferenceSections(markdown: string, topic: DrawioReferenceTopic): string {
  const shapeDiscovery = (getSection(markdown, "Shape discovery").split("### C4 shape recipes")[0] ?? "")
    .replace(/run_drawio_script/g, "the server-side XML patch capability")
    .trim();
  const safeOverview = [
    XML_FIRST_CONTRACT,
    "Server responsibilities: resolve targets against the active revision, apply cell-scoped patches to native XML, validate the result, and persist through the existing versioned document-save transaction.",
    shapeDiscovery
  ].filter(Boolean).join("\\n\\n");
  let selected: string;
  if (topic === "all" || topic === "overview" || topic === "api_ownership") {
    selected = safeOverview;
  } else if (topic === "shape_discovery") {
    selected = shapeDiscovery;
  } else if (topic === "postconditions") {
    selected = XML_FIRST_CONTRACT + "\\n\\nXML validation is required before persistence. A successful tool call is not a persistence receipt; only the server's successful versioned-save response confirms the commit.";
  } else if (topic === "recipes") {
    selected = XML_PATCH_RECIPES;
  } else {
    selected = XML_FIRST_CONTRACT;
  }
  return bounded(selected.trim());
}

export async function readDrawioAgentReference(topic: DrawioReferenceTopic): Promise<string> {
  let lastError: unknown;
  for (const url of REFERENCE_URLS) {
    try {
      const markdown = await readFile(url, "utf8");
      return selectDrawioReferenceSections(markdown, topic);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to load the local Draw.io Agent API reference.");
}
export function isDrawioReferenceTopic(value: unknown): value is DrawioReferenceTopic {
  return typeof value === "string" && (DRAWIO_REFERENCE_TOPICS as readonly string[]).includes(value);
}
