import { describe, expect, it } from "vitest";
import {
  calculateNativeAutoLayout,
  DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS
} from "../layout/native-layout";
import { validateDrawioXmlDocument } from "../model/drawio-xml-schema";

const API = "https://api.github.com/repos/jgraph/drawio-diagrams/contents/examples?ref=dev";
const RAW_PREFIX = "https://raw.githubusercontent.com/jgraph/drawio-diagrams/dev/";
const REVISION = "a".repeat(64);

async function mapLimit<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function activePageId(xml: string): string | null {
  const page = xml.match(/<diagram\b([^>]*)>/);
  const id = page?.[1].match(/\bid=["']([^"']+)["']/);
  return id?.[1] ?? null;
}

describe("temporary upstream Draw.io examples audit", () => {
  it("validates all diagram files and reports layout capability across the sample corpus", async () => {
    const indexResponse = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!indexResponse.ok) throw new Error("GitHub examples directory returned HTTP " + indexResponse.status);
    const entries = await indexResponse.json() as Array<{ name: string; path: string; type: string; download_url: string | null }>;
    const examples = entries.filter((entry) => entry.type === "file" && /\.(drawio|xml)$/i.test(entry.name));
    const results = await mapLimit(examples, 5, async (entry) => {
      try {
        if (!entry.download_url) throw new Error("Missing raw download URL");
        const response = await fetch(RAW_PREFIX + entry.path.replace(/^examples\//, "examples/"));
        if (!response.ok) throw new Error("raw source returned HTTP " + response.status);
        const xml = await response.text();
        const validation = validateDrawioXmlDocument(xml);
        if (!validation.success) {
          return { name: entry.name, bytes: xml.length, validXml: false, issues: validation.issues.slice(0, 4) };
        }
        let layout: Record<string, unknown>;
        try {
          const plan = await calculateNativeAutoLayout(
            xml, activePageId(xml), REVISION, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS
          );
          layout = {
            status: "planned",
            vertices: plan.positions.length,
            edges: plan.edgeRoutes.length,
            layerId: plan.layoutLayerId,
            layerFallback: plan.layoutLayerFallback
          };
        } catch (error) {
          layout = { status: "not-planned", reason: error instanceof Error ? error.message : String(error) };
        }
        return {
          name: entry.name,
          bytes: xml.length,
          validXml: true,
          format: validation.format,
          warnings: validation.warnings.length,
          pageCount: (xml.match(/<diagram\b/g) ?? []).length || (validation.format === "mxGraphModel" ? 1 : 0),
          layout
        };
      } catch (error) {
        return { name: entry.name, validXml: false, issues: [error instanceof Error ? error.message : String(error)] };
      }
    });
    const invalid = results.filter((row) => !row.validXml);
    const layoutFailures = results.filter((row) => row.validXml && row.layout && (row.layout as Record<string, unknown>).status !== "planned");
    const summary = {
      upstreamDirectory: "jgraph/drawio-diagrams/examples@dev",
      examined: results.length,
      validXml: results.length - invalid.length,
      invalidXmlOrFetchFailures: invalid,
      successfulLayouts: results.length - invalid.length - layoutFailures.length,
      layoutNotPlanned: layoutFailures,
      layouts: results.filter((row) => row.validXml).map((row) => ({ name: row.name, layout: row.layout, warnings: row.warnings }))
    };
    console.log("[upstream-samples-audit] " + JSON.stringify(summary));
    expect(invalid, "Invalid official samples or fetch failures: " + JSON.stringify(invalid)).toEqual([]);
  }, 180_000);
});
