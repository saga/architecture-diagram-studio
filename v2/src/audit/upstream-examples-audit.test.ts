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

function pageIds(xml: string): Array<string | null> {
  const document = parseDrawioXml(xml);
  if (document.documentElement.nodeName === "mxGraphModel") return [null];
  return Array.from(document.getElementsByTagName("diagram"))
    .map(page => page.getAttribute("id") || null);
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

interface PageAudit {
  pageIndex: number;
  pageId: string | null;
  sourceVertices: number;
  verticesWithGeometry: number;
  topLevelEligible: number;
  plannedVertices: number;
  sourceEdges: number;
  plannedEdges: number;
  verticesOutsideChosenLayer: number;
  groupOrLayerCells: number;
  shapeFamilies: string[];
  layout: Record<string, unknown>;
}

interface FileAudit {
  name: string;
  valid: boolean;
  issues?: string[];
  pageCount?: number;
  warningCount?: number;
  warningDetails?: string[];
  pages?: PageAudit[];
}

describe("temporary upstream Draw.io examples audit", () => {
  it("validates all upstream samples and inventories every page's native layout scope", async () => {
    const response = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error("GitHub examples directory returned HTTP " + response.status);
    const entries = await response.json() as Array<{ name: string; path: string; type: string; download_url: string | null }>;
    const examples = entries.filter((entry) => entry.type === "file" && /\.(drawio|xml)$/i.test(entry.name));
    const results: FileAudit[] = await mapLimit(examples, 5, async (entry): Promise<FileAudit> => {
      try {
        const source = await fetch(RAW_PREFIX + entry.path);
        if (!source.ok) throw new Error("raw source returned HTTP " + source.status);
        const xml = await source.text();
        const validation = validateDrawioXmlDocument(xml);
        if (!validation.success) return { name: entry.name, valid: false, issues: validation.issues.slice(0, 5) };
        const pages = await Promise.all(pageIds(xml).map(async (pageId, pageIndex) => {
          const model = activeModel(xml, pageId);
          const cells = Array.from(model.getElementsByTagName("mxCell")) as Element[];
          const vertices = cells.filter((cell) => cell.getAttribute("vertex") === "1");
          const edges = cells.filter((cell) => cell.getAttribute("edge") === "1");
          const geometry = (cell: Element) => Array.from(cell.children).find((child) => child.nodeName === "mxGeometry");
          const groupOrLayerCells = cells.filter((cell) => {
            const id = cellId(cell);
            return cell.getAttribute("vertex") !== "1" && cell.getAttribute("edge") !== "1" &&
              !geometry(cell) && id && cells.some(candidate => cellId(candidate) !== id && candidate.getAttribute("parent") === id);
          }).length;
          const shapes = [...new Set(vertices.map(cell => {
            const style = cell.getAttribute("style") || "";
            return style.split(";").find(part => part.trim().startsWith("shape="))?.split("=", 2)[1]?.trim();
          }).filter((shape): shape is string => Boolean(shape)))];
          let layout: Record<string, unknown>;
          try {
            const plan = await calculateNativeAutoLayout(xml, pageId, REVISION, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS);
            layout = { status: "planned", vertices: plan.positions.length, edges: plan.edgeRoutes.length,
              layerId: plan.layoutLayerId, layerFallback: plan.layoutLayerFallback };
          } catch (error) {
            layout = { status: "not-planned", reason: error instanceof Error ? error.message : String(error) };
          }
          const selectedLayer = (layout.layerId as string | null) ?? null;
          const eligibleInSelectedLayer = vertices.filter(cell => {
            const g = geometry(cell);
            return Boolean(g) && cell.getAttribute("parent") === selectedLayer &&
              cell.getAttribute("visible") !== "0" &&
              Number(g?.getAttribute("width")) > 0 && Number(g?.getAttribute("height")) > 0;
          }).length;
          return {
            pageIndex, pageId, sourceVertices: vertices.length,
            verticesWithGeometry: vertices.filter(cell => Boolean(geometry(cell))).length,
            topLevelEligible: eligibleInSelectedLayer,
            plannedVertices: (layout.vertices as number | undefined) ?? 0,
            sourceEdges: edges.length,
            plannedEdges: (layout.edges as number | undefined) ?? 0,
            verticesOutsideChosenLayer: vertices.length - eligibleInSelectedLayer,
            groupOrLayerCells,
            shapeFamilies: [...new Set(shapes.map(shape => shape.split(".").slice(0, 2).join(".")))].slice(0, 10),
            layout
          };
        }));
        return {
          name: entry.name, valid: true,
          pageCount: pages.length,
          warningCount: validation.warnings.length,
          warningDetails: validation.warnings.slice(0, 30),
          pages
        };
      } catch (error) {
        return { name: entry.name, valid: false, issues: [error instanceof Error ? error.message : String(error)] };
      }
    });
    const invalid = results.filter((row) => !row.valid);
    const pageRows = results.filter(row => row.valid).flatMap(row =>
      (row.pages as Array<Record<string, unknown>>).map(page => ({ name: row.name, ...page }))
    );
    const layoutFailures = pageRows.filter((row) => (row.layout as Record<string, unknown>).status !== "planned");
    const coverageCandidates = pageRows.filter(row => Number(row.sourceVertices) >= 12 &&
      (Number(row.plannedVertices) < Number(row.sourceVertices) * 0.5 ||
       (Number(row.sourceEdges) >= 5 && Number(row.plannedEdges) === 0)));
    const warnings = results.filter(row => row.valid && Number(row.warningCount) > 0).map(row => ({
      name: row.name, count: row.warningCount, details: row.warningDetails
    }));
    const summary = {
      upstreamDirectory: "jgraph/drawio-diagrams/examples@dev",
      examinedFiles: results.length,
      examinedPages: pageRows.length,
      validXmlFiles: results.length - invalid.length,
      invalidSamples: invalid,
      pagesWithLayoutPlan: pageRows.length - layoutFailures.length,
      layoutNotPlanned: layoutFailures,
      lowLayoutCoveragePages: coverageCandidates,
      warnings,
      pages: pageRows.map(row => ({
        name: row.name, pageIndex: row.pageIndex, pageId: row.pageId,
        sourceVertices: row.sourceVertices, plannedVertices: row.plannedVertices,
        sourceEdges: row.sourceEdges, plannedEdges: row.plannedEdges,
        outsideLayoutLayer: row.verticesOutsideChosenLayer, layer: row.layout?.layerId,
        status: (row.layout as Record<string, unknown>).status
      }))
    };
    console.log("[upstream-samples-audit] " + JSON.stringify(summary));
    expect(invalid, "Invalid official samples or fetch failures: " + JSON.stringify(invalid)).toEqual([]);
  }, 180_000);
});
