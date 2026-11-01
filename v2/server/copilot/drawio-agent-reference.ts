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
const XML_FIRST_CONTRACT = [
  "# Direct Native Draw.io XML Editing",
  "",
  "The active diagram is a normal file exposed at $active-diagram. Use read to inspect it, edit the native XML itself, and use write to replace it with the complete resulting XML. Large files support chunked reads. Read and write repeatedly as needed; the latest complete XML is saved after the model turn.",
  "",
  "Use read and write for workspace files and write_code for source code. Workspace paths are relative to the configured root; absolute paths, traversal and symlink escapes are rejected. Standalone mode exposes only $active-diagram.",
  "",
  "There is no XML Patch DSL, cell-operation list, or per-cell mutation API. Preserve unrelated pages, cells, wrappers, custom shapes, unknown attributes, styles, geometry, groups, layers, labels and edge relationships. Do not rebuild the document from a reduced model. Keep HTML labels and nested markup intact.",
  "",
  "The server validates the complete XML, checks the source revision and persists workspace diagram writes through the versioned document-save transaction. Standalone writes are returned to the browser for persistence through the selected File System Access handle. Report success only after the appropriate persistence receipt.",
  "",
  "Never generate or execute JavaScript for the Draw.io iframe. Use Studio automatic layout for layout requests; do not reimplement or alter layout engines as part of XML editing."
].join("\\n");

const XML_DIRECT_RECIPES = [
  "## Direct XML editing examples",
  "",
  "Rename a normal cell by changing its native value attribute:",
  "",
  "```xml",
  '<mxCell id="database" value="Data Store" vertex="1" parent="1"><mxGeometry x="240" y="120" width="120" height="60" as="geometry"/></mxCell>',
  "```",
  "",
  "Change the native style string directly. Preserve every existing token that is unrelated to the requested change:",
  "",
  "```xml",
  '<mxCell id="database" value="Database" style="rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;" vertex="1" parent="1"><mxGeometry x="240" y="120" width="120" height="60" as="geometry"/></mxCell>',
  "```",
  "",
  "Create a native cell by adding an mxCell element under the appropriate existing root, using a unique ID and the correct native parent relationship. For edges, preserve valid source and target IDs and their native geometry. For UserObject/object cells, keep the wrapper and inner mxCell together.",
  "",
  "These are ordinary XML examples, not tool arguments or an operation schema. Use the actual source document as the basis for every edit."
].join("\\n");
export function selectDrawioReferenceSections(markdown: string, topic: DrawioReferenceTopic): string {
  const shapeDiscovery = (getSection(markdown, "Shape discovery").split("### C4 shape recipes")[0] ?? "").trim();
  const safeOverview = [
    XML_FIRST_CONTRACT,
    "Server responsibilities: resolve targets against the active revision, apply complete native XML documents, validate the result, and persist through the existing versioned document-save transaction.",
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
    selected = XML_DIRECT_RECIPES;
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
