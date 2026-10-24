import { describe, expect, it } from "vitest";
import {
  calculateNativeAutoLayout,
  DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
  emulateEmbeddedFlowDirection,
  type NativeAutoLayoutOptions
} from "./native-layout";

const xml = `<mxfile host="app.diagrams.net">
  <diagram id="page-1" name="Architecture"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10">
    <root>
      <mxCell id="0"/>
      <mxCell id="1" parent="0"/>
      <object id="api" label="API" owner="studio" custom="preserve-me"><mxCell vertex="1" parent="1" style="rounded=1;fillColor=#ffffff;"><mxGeometry x="40" y="40" width="140" height="70" as="geometry"/></mxCell></object>
      <object id="worker" label="Worker"><mxCell vertex="1" parent="1"><mxGeometry x="260" y="200" width="160" height="80" as="geometry"/></mxCell></object>
      <object id="db" label="Database"><mxCell vertex="1" parent="1"><mxGeometry x="500" y="360" width="150" height="90" as="geometry"/></mxCell></object>
      <object id="edge-api-worker" label=""><mxCell edge="1" parent="1" source="api" target="worker" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;"><mxGeometry relative="1" as="geometry"/></mxCell></object>
      <object id="edge-worker-db" label=""><mxCell edge="1" parent="1" source="worker" target="db"><mxGeometry relative="1" as="geometry"/></mxCell></object>
    </root>
  </mxGraphModel></diagram>
  <diagram id="page-2" name="Other page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="untouched" value="Keep" vertex="1" parent="1"><mxGeometry x="1" y="2" width="30" height="30" as="geometry"/></mxCell></root></mxGraphModel></diagram>
</mxfile>`;

const revision = "a".repeat(64);

describe("Studio-owned native-cell layout", () => {
  it("rejects non-layered algorithms for Dagre rather than silently ignoring the selection", async () => {
    await expect(calculateNativeAutoLayout(xml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "dagre", algorithm: "radial"
    })).rejects.toThrow("Dagre supports only the layered algorithm");
  });

  it("uses Dagre for directed layout and returns revision-bound native cell positions", async () => {
    const beforeXml = xml;
    const options: NativeAutoLayoutOptions = { ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "dagre", direction: "RIGHT" };
    const plan = await calculateNativeAutoLayout(xml, "page-1", revision, options);

    expect(plan).toMatchObject({ engine: "dagre", algorithm: "layered", direction: "RIGHT", pageId: "page-1", documentRevision: revision });
    expect(plan.positions.map((item) => item.cellId).sort()).toEqual(["api", "db", "worker"]);
    expect(new Set(plan.positions.map((item) => item.x)).size).toBeGreaterThan(1);
    expect(plan.edgeRoutes.map((item) => item.cellId).sort()).toEqual(["edge-api-worker", "edge-worker-db"]);
    expect(plan.positions.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
    expect(xml).toBe(beforeXml);
  });

  it.each(["layered", "mrtree", "radial", "stress", "force"] as const)(
    "supports the ELK %s algorithm without rebuilding or normalizing the source XML",
    async (algorithm) => {
      const plan = await calculateNativeAutoLayout(xml, "page-1", revision, {
        ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm
      });
      expect(plan.engine).toBe("elk");
      expect(plan.algorithm).toBe(algorithm);
      expect(plan.positions).toHaveLength(3);
      expect(plan.positions.map((item) => item.cellId).sort()).toEqual(["api", "db", "worker"]);
      expect(plan.edgeRoutes).toHaveLength(2);
      expect(plan.positions.every((item) => Math.abs(item.x) <= 1_000_000 && Math.abs(item.y) <= 1_000_000)).toBe(true);
      expect(xml).toContain('custom="preserve-me"');
      expect(xml).toContain('id="page-2"');
    }
  );

  it("only lays out the selected page's default layer and leaves a second page outside the plan", async () => {
    const plan = await calculateNativeAutoLayout(xml, "page-1", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS);
    expect(plan.pageId).toBe("page-1");
    expect(plan.expectedPageCellIds).toContain("edge-api-worker");
    expect(plan.expectedPageCellIds).not.toContain("untouched");
    expect(plan.positions.map((item) => item.cellId)).not.toContain("untouched");
  });

  it("rejects an invalid revision and a page without layout vertices", async () => {
    await expect(calculateNativeAutoLayout(xml, "page-1", "not-a-revision", DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS))
      .rejects.toThrow(/revision/i);
    await expect(calculateNativeAutoLayout(xml, "missing-page", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS))
      .rejects.toThrow(/page/i);
  });
});

// The bundled elkjs STRESS/FORCE engines ignore "elk.direction"; the plan builder must emulate
// the direction itself (rotate anisotropic embeddings onto the flow axis, mirror until the
// aggregated edge flow matches) and keep connector bend points in the same transformed space.

function chainPageXml(cells: Array<{ id: string; width: number; height: number }>, links: Array<{ id: string; source: string; target: string }>) {
  const vertices = cells
    .map((cell) => `<mxCell id="${cell.id}" value="${cell.id}" vertex="1" parent="1"><mxGeometry x="0" y="0" width="${cell.width}" height="${cell.height}" as="geometry"/></mxCell>`)
    .join("");
  const edges = links
    .map((link) => `<mxCell id="${link.id}" edge="1" parent="1" source="${link.source}" target="${link.target}"><mxGeometry relative="1" as="geometry"/></mxCell>`)
    .join("");
  return `<mxfile host="test"><diagram id="page-1" name="Chain"><mxGraphModel dx="1" dy="1"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertices}${edges}</root></mxGraphModel></diagram></mxfile>`;
}

const box = { width: 120, height: 60 };
const chainCells = [
  { id: "ddd", ...box },
  { id: "bbb", ...box },
  { id: "aaa", ...box },
  { id: "eee", ...box }
];
const chainLinks = [
  { id: "e-aaa-bbb", source: "aaa", target: "bbb" },
  { id: "e-aaa-eee", source: "aaa", target: "eee" },
  { id: "e-bbb-ddd", source: "bbb", target: "ddd" }
];

function chainFlowStatistics(plan: Awaited<ReturnType<typeof calculateNativeAutoLayout>>, vertices: Array<{ id: string; width: number; height: number }>, links: typeof chainLinks) {
  const centerById = new Map(plan.positions.map((position) => {
    const cell = vertices.find((vertex) => vertex.id === position.cellId)!;
    return [position.cellId, { x: position.x + cell.width / 2, y: position.y + cell.height / 2 }];
  }));
  const flow = links.reduce(
    (sum, link) => ({ x: sum.x + centerById.get(link.target)!.x - centerById.get(link.source)!.x, y: sum.y + centerById.get(link.target)!.y - centerById.get(link.source)!.y }),
    { x: 0, y: 0 }
  );
  const centerXs = Array.from(centerById.values(), (center) => center.x);
  const centerYs = Array.from(centerById.values(), (center) => center.y);
  return {
    flow,
    xSpread: Math.max(...centerXs) - Math.min(...centerXs),
    ySpread: Math.max(...centerYs) - Math.min(...centerYs),
    minAdjacentPitch: Math.min(...links.map((link) => Math.hypot(centerById.get(link.target)!.x - centerById.get(link.source)!.x, centerById.get(link.target)!.y - centerById.get(link.source)!.y)))
  };
}

describe("ELK organic algorithm direction emulation", () => {
  it.each(["LEFT", "RIGHT"] as const)("aligns the STRESS chain flow with direction %s and lays it out horizontally", async (direction) => {
    const plan = await calculateNativeAutoLayout(chainPageXml(chainCells, chainLinks), "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "stress", direction
    });
    const stats = chainFlowStatistics(plan, chainCells, chainLinks);
    expect(direction === "LEFT" ? stats.flow.x : -stats.flow.x).toBeLessThanOrEqual(0);
    expect(stats.xSpread).toBeGreaterThan(stats.ySpread);
    expect(stats.minAdjacentPitch).toBeGreaterThanOrEqual(150);
  });

  it("lays the STRESS chain out vertically for direction DOWN/UP", async () => {
    const down = await calculateNativeAutoLayout(chainPageXml(chainCells, chainLinks), "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "stress", direction: "DOWN"
    });
    const downStats = chainFlowStatistics(down, chainCells, chainLinks);
    expect(downStats.flow.y).toBeGreaterThanOrEqual(0);
    expect(downStats.ySpread).toBeGreaterThan(downStats.xSpread);
    const up = await calculateNativeAutoLayout(chainPageXml(chainCells, chainLinks), "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "stress", direction: "UP"
    });
    expect(chainFlowStatistics(up, chainCells, chainLinks).flow.y).toBeLessThanOrEqual(0);
  });

  it("orients the FORCE embedding with the selected direction", async () => {
    const plan = await calculateNativeAutoLayout(chainPageXml(chainCells, chainLinks), "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "force", direction: "LEFT"
    });
    expect(chainFlowStatistics(plan, chainCells, chainLinks).flow.x).toBeLessThanOrEqual(0);
  });

  it("does not rebuild the source XML while orienting an organic layout", async () => {
    const beforeXml = chainPageXml(chainCells, chainLinks);
    await calculateNativeAutoLayout(beforeXml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "stress", direction: "LEFT"
    });
    expect(beforeXml).toContain('id="e-aaa-bbb"');
  });
});

describe("emulateEmbeddedFlowDirection", () => {
  type FlowVertex = Parameters<typeof emulateEmbeddedFlowDirection>[2][number];
  type FlowEdge = Parameters<typeof emulateEmbeddedFlowDirection>[3][number];

  function flowFixture() {
    const vertices: FlowVertex[] = [
      { id: "a", parentId: "1", sourceId: null, targetId: null, kind: "vertex", x: 0, y: 0, width: 40, height: 40, hasGeometry: true, visible: true },
      { id: "b", parentId: "1", sourceId: null, targetId: null, kind: "vertex", x: 200, y: 40, width: 40, height: 40, hasGeometry: true, visible: true }
    ];
    const edges: FlowEdge[] = [
      { id: "e", parentId: "1", sourceId: "a", targetId: "b", kind: "edge", x: 0, y: 0, width: 0, height: 0, hasGeometry: true, visible: true }
    ];
    return { vertices, edges };
  }

  it("rotates a diagonal embedding onto the flow axis and keeps bend points on the same line", () => {
    const { vertices, edges } = flowFixture();
    const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 200, y: 40 }]]);
    // Bend points sitting exactly on the a→b line stay on it after the rotation.
    const routes = new Map([["e", [{ x: 120, y: 40 }, { x: 170, y: 50 }]]]);
    emulateEmbeddedFlowDirection(positions, routes, vertices, edges, "RIGHT");
    const centers = Array.from(positions.values(), (point) => ({ x: point.x + 20, y: point.y + 20 }));
    // Both centers live on one horizontal line after the dominant axis was rotated onto X.
    expect(Math.abs(centers[0].y - centers[1].y)).toBeLessThan(1e-6);
    expect(centers[1].x).toBeGreaterThan(centers[0].x);
    for (const bend of routes.get("e") ?? []) expect(Math.abs(bend.y - centers[0].y)).toBeLessThan(1e-6);
  });

  it("mirrors the embedding when the aggregated flow contradicts the selected direction", () => {
    const { vertices, edges } = flowFixture();
    const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 200, y: 40 }]]);
    const routes = new Map([["e", [{ x: 120, y: 40 }, { x: 170, y: 50 }]]]);
    emulateEmbeddedFlowDirection(positions, routes, vertices, edges, "LEFT");
    const centerById = new Map(Array.from(positions, ([id, point]) => [id, point.x + 20]));
    // The source must sit to the right of the target for a right-to-left selection.
    expect(centerById.get("a")!).toBeGreaterThan(centerById.get("b")!);
    const minCenterX = Math.min(centerById.get("a")!, centerById.get("b")!);
    const maxCenterX = Math.max(centerById.get("a")!, centerById.get("b")!);
    for (const bend of routes.get("e") ?? []) {
      expect(Math.abs(bend.y - centersY(positions))).toBeLessThan(1e-6);
      expect(bend.x).toBeGreaterThanOrEqual(minCenterX);
      expect(bend.x).toBeLessThanOrEqual(maxCenterX);
    }
  });

  function centersY(positions: Map<string, { x: number; y: number }>): number {
    return Array.from(positions.values(), (point) => point.y + 20)[0];
  }

  it("mirrors vertically for UP when the flow points downward", () => {
    const { vertices, edges } = flowFixture();
    const positions = new Map([["a", { x: 0, y: 0 }], ["b", { x: 0, y: 200 }]]);
    const routes = new Map([["e", []]]);
    emulateEmbeddedFlowDirection(positions, routes, vertices, edges, "UP");
    const centerYs = Array.from(positions.values(), (point) => point.y + 20);
    // The vertical chain is mirrored so the flow now runs bottom-to-top.
    expect(Array.from(positions, ([, point]) => point.y + 20)[0] - Array.from(positions, ([, point]) => point.y + 20)[1])
      .toBeGreaterThan(0);
    expect(Math.max(...centerYs) - Math.min(...centerYs)).toBeGreaterThanOrEqual(200);
  });
});
