import { describe, expect, it } from "vitest";
import { parseDrawioXml } from "../model/drawio-xml-dom";
import { decodeDrawioPageXml, validateDrawioXmlDocument } from "../model/drawio-xml-schema";
import { calculateNativeAutoLayout, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS } from "../layout/native-layout";

const API = "https://api.github.com/repos/jgraph/drawio-diagrams/contents/examples?ref=dev";
const RAW_PREFIX = "https://raw.githubusercontent.com/jgraph/drawio-diagrams/dev/";
const REVISION = "a".repeat(64);

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

function activePageId(xml: string): string | null {
  const page = xml.match(/<diagram\b([^>]*)>/);
  return page?.[1].match(/\bid=["']([^"']+)["']/)?.[1] ?? null;
}

function activeModel(xml: string, pageId: string | null): Element {
  const document = parseDrawioXml(xml);
  if (document.documentElement.nodeName === "mxGraphModel") return document.documentElement;
  const pages = Array.from(document.getElementsByTagName("diagram"));
  const page = pageId ? pages.find((candidate) => candidate.getAttribute("id") === pageId) : pages[0];
  if (!page) throw new Error("No active page in sample");
  const inline = page.getElementsByTagName("mxGraphModel").item(0);
  if (inline) return inline;
  return parseDrawioXml(decodeDrawioPageXml(page.textContent || "")).documentElement;
}

function cellId(cell: Element): string {
  const wrapper = cell.parentElement;
  if (wrapper && !["root", "mxGraphModel", "diagram", "mxfile"].includes(wrapper.nodeName)) {
    const id = wrapper.getAttribute("id");
    if (id) return id;
  }
  return cell.getAttribute("id") || "";
}

describe("temporary upstream Draw.io examples audit", () => {
  it("validates upstream diagrams and inventories the exact layout scope", async () => {
    const response = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error("GitHub examples directory returned HTTP " + response.status);
    const entries = await response.json() as Array<{ name: string; path: string; type: string; download_url: string | null }>;
    const examples = entries.filter((entry) => entry.type === "file" && /\.(drawio|xml)$/i.test(entry.name));
    const results = await mapLimit(examples, 5, async (entry) => {
      try {
        const source = await fetch(RAW_PREFIX + entry.path);
        if (!source.ok) throw new Error("raw source returned HTTP " + source.status);
        const xml = await source.text();
        const validation = validateDrawioXmlDocument(xml);
        if (!validation.success) return { name: entry.name, valid: false, issues: validation.issues.slice(0, 5) };
        const pageId = activePageId(xml);
        const model = activeModel(xml, pageId);
        const cells = Array.from(model.getElementsByTagName("mxCell")) as Element[];
        const vertices = cells.filter((cell) => cell.getAttribute("vertex") === "1");
        const edges = cells.filter((cell) => cell.getAttribute("edge") === "1");
        const geometry = (cell: Element) => Array.from(cell.children).find((child) => child.nodeName === "mxGeometry");
        const layers = cells.filter((cell) => {
          const id = cellId(cell);
          return cell.getAttribute("vertex") !== "1" && cell.getAttribute("edge") !== "1" &&
            !geometry(cell) && id && cells.some(candidate => cellId(candidate) !== id && candidate.getAttribute("parent") === id);
        });
        let layout: Record<string, unknown>;
        try {
          const plan = await calculateNativeAutoLayout(xml, pageId, REVISION, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS);
          layout = {
            status: "planned", vertices: plan.positions.length, edges: plan.edgeRoutes.length,
            layerId: plan.layoutLayerId, layerFallback: plan.layoutLayerFallback
          };
        } catch (error) {
          layout = { status: "not-planned", reason: error instanceof Error ? error.message : String(error) };
        }
        const shapes = [...new Set(vertices.map(cell => {
          const style = cell.getAttribute("style") || "";
          return style.split(";").find(part => part.trim().startsWith("shape="))?.split("=", 2)[1]?.trim();
        }).filter((shape): shape is string => Boolean(shape)))];
        const selectedLayer = (layout.layerId as string | null) ?? null;
        const eligibleInSelectedLayer = vertices.filter(cell => {
          const g = geometry(cell);
          return Boolean(g) && cell.getAttribute("parent") === selectedLayer &&
            cell.getAttribute("visible") !== "0" &&
            Number(g?.getAttribute("width")) > 0 && Number(g?.getAttribute("height")) > 0;
        }).length;
        return {
          name: entry.name, valid: true, format: validation.format,
          pages: (xml.match(/<diagram\b/g) ?? []).length || 1,
          vertexCells: vertices.length, verticesWithGeometry: vertices.filter(cell => Boolean(geometry(cell))).length,
          eligibleTopLevel: eligibleInSelectedLayer, plannedVertices: (layout.vertices as number | undefined) ?? 0,
          verticesOutsideChosenLayer: vertices.length - eligibleInSelectedLayer,
          edgeCells: edges.length, selectedLayer, groupOrLayerCells: layers.length,
          shapeFamilies: [...new Set(shapes.map(shape => shape.split(".").slice(0, 2).join(".")))].slice(0, 20),
          warningDetails: validation.warnings.slice(0, 30),
          warningCount: validation.warnings.length, layout
        };
      } catch (error) {
        return { name: entry.name, valid: false, issues: [error instanceof Error ? error.message : String(error)] };
      }
    });
    const invalid = results.filter((row) => !row.valid);
    const layoutFailures = results.filter((row) => row.valid && row.layout && (row.layout as Record<string, unknown>).status !== "planned");
    const layoutLossCandidates = results.filter((row) => row.valid && row.vertexCells &&
      ((row.plannedVertices as number) < Math.min(5, Math.floor((row.vertexCells as number) / 3))));
    const summary = {
      upstreamDirectory: "jgraph/drawio-diagrams/examples@dev",
      examined: results.length, validXml: results.length - invalid.length,
      invalidSamples: invalid, successfulLayouts: results.length - invalid.length - layoutFailures.length,
      layoutNotPlanned: layoutFailures, lowTopLevelCoverageCandidates: layoutLossCandidates,
      warnings: results.filter(row => row.valid && row.warningCount).map(row => ({name:row.name,count:row.warningCount,details:row.warningDetails})),
      inventory: results.filter(row => row.valid).map(row => ({
        name: row.name, pages: row.pages, vertices: row.vertexCells, planned: row.plannedVertices,
        outsideLayoutLayer: row.verticesOutsideChosenLayer, edges: row.edgeCells,
        layer: row.selectedLayer, warnings: row.warningCount, layout: row.layout
      }))
    };
    console.log("[upstream-samples-audit] " + JSON.stringify(summary));
    expect(invalid, "Invalid official samples or fetch failures: " + JSON.stringify(invalid)).toEqual([]);
  }, 180_000);
});
