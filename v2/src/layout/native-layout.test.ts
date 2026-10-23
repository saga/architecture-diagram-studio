import { describe, expect, it } from "vitest";
import { calculateNativeAutoLayout, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, type NativeAutoLayoutOptions } from "./native-layout";

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
