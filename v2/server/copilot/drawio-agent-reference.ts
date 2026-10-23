import { readFile } from "node:fs/promises";

export const DRAWIO_REFERENCE_TOPICS = [
  "overview", "api_ownership", "shape_discovery", "script_safety", "postconditions", "recipes", "all"
] as const;
export type DrawioReferenceTopic = (typeof DRAWIO_REFERENCE_TOPICS)[number];
const REFERENCE_URL = new URL("../../../docs/DRAWIO-AGENT-API-CONTRACT.md", import.meta.url);
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
  if (topic === "all") return bounded(markdown.trim());
  if (topic === "api_ownership") return getSection(markdown, "API ownership");
  if (topic === "shape_discovery") return getSection(markdown, "Shape discovery");
  if (topic === "script_safety") return getSection(markdown, "Contract and trust boundaries");
  if (topic === "postconditions") return getSection(markdown, "Validation and postconditions");
  if (topic === "recipes") return getSection(markdown, "Recipes");
  return [
    "# Draw.io Agent Reference (overview)",
    getSection(markdown, "Contract and trust boundaries"),
    getSection(markdown, "Shape discovery"),
    getSection(markdown, "Validation and postconditions")
  ].filter(Boolean).join("\n\n");
}
export async function readDrawioAgentReference(topic: DrawioReferenceTopic): Promise<string> {
  const markdown = await readFile(REFERENCE_URL, "utf8");
  return selectDrawioReferenceSections(markdown, topic);
}
export function isDrawioReferenceTopic(value: unknown): value is DrawioReferenceTopic {
  return typeof value === "string" && (DRAWIO_REFERENCE_TOPICS as readonly string[]).includes(value);
}
