import { readFile } from "node:fs/promises";

export const DRAWIO_REFERENCE_TOPICS = [
  "overview", "api_ownership", "shape_discovery", "script_safety", "postconditions", "recipes", "all"
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
export function selectDrawioReferenceSections(markdown: string, topic: DrawioReferenceTopic): string {
  let selected: string;
  if (topic === "all") {
    selected = markdown.trim();
  } else if (topic === "api_ownership") {
    selected = getSection(markdown, "API ownership");
  } else if (topic === "shape_discovery") {
    selected = getSection(markdown, "Shape discovery");
  } else if (topic === "script_safety") {
    selected = getSection(markdown, "Contract and trust boundaries");
  } else if (topic === "postconditions") {
    selected = getSection(markdown, "Validation and postconditions");
  } else if (topic === "recipes") {
    selected = getSection(markdown, "Recipes");
  } else {
    selected = [
      "# Draw.io Agent Reference (overview)",
      getSection(markdown, "Contract and trust boundaries"),
      getSection(markdown, "Shape discovery"),
      getSection(markdown, "Validation and postconditions")
    ].filter(Boolean).join("\n\n");
  }
  // Bound every topic: an individually large section or the composed overview must not
  // bypass the same response-size guard that protects the "all" path.
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
