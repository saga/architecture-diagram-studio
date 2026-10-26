import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectSpatialRegionsForLayout } from "./spatial-region-analysis";
import {
  calculateNativeAutoLayout,
  DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
  emulateEmbeddedFlowDirection,
  nativeLayoutAlgorithmsForEngine,
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
const bpmnChoreographyXml = readFileSync(
  new URL("./fixtures/bpmn-choreography-model.drawio", import.meta.url),
  "utf8"
);
const industrialIotXml = readFileSync(
  new URL("./fixtures/industrial-iot-example.drawio", import.meta.url),
  "utf8"
);
const industrialIotPageId = "SXgX17sldJI9QkPeDldp";

describe("Studio-owned native-cell layout", () => {
  it("moves spatial region members as one atomic block and translates explicit internal waypoints", async () => {
    const regionXml = `<mxfile host="test"><diagram id="region-page" name="Region"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="region-it" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
        <mxGeometry x="100" y="100" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="region-title" value="IT Network" vertex="1" parent="1" style="shape=text;html=1;align=left;strokeColor=none;fillColor=none;">
        <mxGeometry x="120" y="102" width="130" height="24" as="geometry"/>
      </mxCell>
      <mxCell id="switch-a" value="Switch A" vertex="1" parent="1"><mxGeometry x="150" y="160" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="server-b" value="Server B" vertex="1" parent="1"><mxGeometry x="270" y="180" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="plc-c" value="PLC C" vertex="1" parent="1"><mxGeometry x="390" y="280" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="outside-node" value="Outside" vertex="1" parent="1"><mxGeometry x="760" y="180" width="100" height="50" as="geometry"/></mxCell>
      <mxCell id="edge-inside-region" edge="1" parent="1" source="switch-a" target="server-b" style="edgeStyle=orthogonalEdgeStyle;">
        <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="245" y="170"/><mxPoint x="245" y="200"/></Array></mxGeometry>
      </mxCell>
      <mxCell id="edge-across-region" edge="1" parent="1" source="plc-c" target="outside-node" style="edgeStyle=orthogonalEdgeStyle;">
        <mxGeometry relative="1" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const plan = await calculateNativeAutoLayout(regionXml, "region-page", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "layered", direction: "RIGHT"
    });
    const positions = new Map(plan.positions.map((position) => [position.cellId, position] as const));
    const original = new Map([
      ["region-it", { x: 100, y: 100 }],
      ["region-title", { x: 120, y: 102 }],
      ["switch-a", { x: 150, y: 160 }],
      ["server-b", { x: 270, y: 180 }],
      ["plc-c", { x: 390, y: 280 }]
    ]);
    const regionPosition = positions.get("region-it");
    expect(regionPosition).toBeDefined();
    expect(plan.coverage.spatialRegionCount).toBe(1);
    expect(plan.coverage.spatialRegionMemberCount).toBe(4);
    expect(plan.coverage.spatialRegionInternalEdgeCount).toBe(1);
    expect(plan.coverage.spatialRegionInternalEdgesTranslatedCount).toBe(1);
    expect(plan.coverage.connectorsAttachedToNestedChildrenCount).toBe(1);
    expect(positions.size).toBe(6);

    const delta = { x: regionPosition!.x - 100, y: regionPosition!.y - 100 };
    for (const id of ["region-title", "switch-a", "server-b", "plc-c"]) {
      const position = positions.get(id);
      expect(position).toBeDefined();
      expect(position!.x).toBeCloseTo(original.get(id)!.x + delta.x, 4);
      expect(position!.y).toBeCloseTo(original.get(id)!.y + delta.y, 4);
      expect(position!.x - regionPosition!.x).toBeCloseTo(original.get(id)!.x - 100, 4);
      expect(position!.y - regionPosition!.y).toBeCloseTo(original.get(id)!.y - 100, 4);
    }

    const internalRoute = plan.edgeRoutes.find((route) => route.cellId === "edge-inside-region");
    expect(internalRoute?.points).toEqual([
      { x: 245 + delta.x, y: 170 + delta.y },
      { x: 245 + delta.x, y: 200 + delta.y }
    ]);
    const externalRoute = plan.edgeRoutes.find((route) => route.cellId === "edge-across-region");
    expect(externalRoute?.points.some((point) =>
      Math.abs(point.x - (regionPosition!.x + 500)) < 0.02
    )).toBe(true);
    expect(plan.expectedCells.filter((cell) => cell.kind === "vertex").map((cell) => cell.cellId).sort())
      .toEqual(["outside-node", "plc-c", "region-it", "region-title", "server-b", "switch-a"].sort());
    // Planning uses a transient region proxy. The native terminal IDs and source XML stay unchanged.
    expect(regionXml).toContain('source="plc-c" target="outside-node"');
    expect(regionXml).toContain('source="switch-a" target="server-b"');
  });

  it("routes a connector between two spatial regions through both native region boundaries", async () => {
    const twoRegionXml = `<mxfile host="test"><diagram id="two-regions" name="Two Regions"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/>
      <mxCell id="region-left" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
        <mxGeometry x="0" y="0" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="region-left-title" value="IT Network" vertex="1" parent="1" style="shape=text;html=1;strokeColor=none;fillColor=none;">
        <mxGeometry x="20" y="8" width="130" height="24" as="geometry"/>
      </mxCell>
      <mxCell id="left-a" value="Switch A" vertex="1" parent="1"><mxGeometry x="40" y="80" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="left-b" value="Server B" vertex="1" parent="1"><mxGeometry x="150" y="80" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="left-c" value="PLC C" vertex="1" parent="1"><mxGeometry x="260" y="180" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="region-right" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
        <mxGeometry x="600" y="0" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="region-right-title" value="OT Network" vertex="1" parent="1" style="shape=text;html=1;strokeColor=none;fillColor=none;">
        <mxGeometry x="620" y="8" width="130" height="24" as="geometry"/>
      </mxCell>
      <mxCell id="right-a" value="Switch D" vertex="1" parent="1"><mxGeometry x="650" y="80" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="right-b" value="Server E" vertex="1" parent="1"><mxGeometry x="760" y="80" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="right-c" value="PLC F" vertex="1" parent="1"><mxGeometry x="870" y="180" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="edge-between-regions" edge="1" parent="1" source="left-c" target="right-c" style="edgeStyle=orthogonalEdgeStyle;">
        <mxGeometry relative="1" as="geometry"/>
      </mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const plan = await calculateNativeAutoLayout(twoRegionXml, "two-regions", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "layered", direction: "RIGHT"
    });
    const positions = new Map(plan.positions.map((position) => [position.cellId, position] as const));
    const left = positions.get("region-left");
    const right = positions.get("region-right");
    const route = plan.edgeRoutes.find((item) => item.cellId === "edge-between-regions");
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(plan.coverage.spatialRegionCount).toBe(2);
    expect(plan.coverage.spatialRegionMemberCount).toBe(8);
    expect(route?.points.length).toBeGreaterThanOrEqual(2);
    expect(route?.points[0].x).toBeCloseTo(left!.x + 500, 2);
    expect(route?.points[route.points.length - 1].x).toBeCloseTo(right!.x, 2);
    expect(plan.expectedCells.find((cell) => cell.cellId === "edge-between-regions"))
      .toMatchObject({ sourceId: "left-c", targetId: "right-c", parentId: "1" });
    expect(twoRegionXml).toContain('source="left-c" target="right-c"');
  });

  it("applies atomic region projection to the real Industrial IoT example", async () => {
    const detection = detectSpatialRegionsForLayout(industrialIotXml, industrialIotPageId);
    expect(detection.eligibleCandidates.length).toBeGreaterThan(0);
    const plan = await calculateNativeAutoLayout(industrialIotXml, industrialIotPageId, revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "layered", direction: "RIGHT"
    });
    const plannedIds = new Set(plan.positions.map((position) => position.cellId));
    for (const region of detection.eligibleCandidates) {
      expect(plannedIds.has(region.regionCellId)).toBe(true);
      for (const memberId of region.memberCellIds) expect(plannedIds.has(memberId)).toBe(true);
    }
    expect(plan.coverage.spatialRegionCount).toBe(detection.eligibleCandidates.length);
    expect(plan.coverage.spatialRegionMemberCount).toBeGreaterThan(0);
    expect(plan.coverage.spatialRegionBoundaryVertexCount).toBeGreaterThan(0);
  });

  it.each([
    ["dagre", "layered"],
    ["elk", "layered"],
    ["graphviz", "dot"],
    ["msagl", "layered"],
    ["cytoscape", "breadthfirst"],
    ["d3", "tree"]
  ] as const)(
    "shares atomic spatial-region projection across all supported layout engines (%s / %s)",
    async (engine, algorithm) => {
      const regionXml = `<mxfile host="test"><diagram id="engine-matrix" name="Engine matrix"><mxGraphModel><root>
        <mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="region" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
          <mxGeometry x="100" y="100" width="500" height="400" as="geometry"/>
        </mxCell>
        <mxCell id="region-title" value="IT Network" vertex="1" parent="1" style="shape=text;html=1;align=left;strokeColor=none;fillColor=none;">
          <mxGeometry x="120" y="102" width="130" height="24" as="geometry"/>
        </mxCell>
        <mxCell id="switch" value="Switch" vertex="1" parent="1"><mxGeometry x="150" y="160" width="80" height="40" as="geometry"/></mxCell>
        <mxCell id="server" value="Server" vertex="1" parent="1"><mxGeometry x="270" y="180" width="80" height="40" as="geometry"/></mxCell>
        <mxCell id="plc" value="PLC" vertex="1" parent="1"><mxGeometry x="390" y="280" width="80" height="40" as="geometry"/></mxCell>
        <mxCell id="outside" value="Outside" vertex="1" parent="1"><mxGeometry x="760" y="180" width="100" height="50" as="geometry"/></mxCell>
        <mxCell id="internal-edge" edge="1" parent="1" source="switch" target="server">
          <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="245" y="170"/><mxPoint x="245" y="200"/></Array></mxGeometry>
        </mxCell>
        <mxCell id="internal-edge-no-waypoints" edge="1" parent="1" source="server" target="plc">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
        <mxCell id="cross-edge" edge="1" parent="1" source="plc" target="outside">
          <mxGeometry relative="1" as="geometry"/>
        </mxCell>
      </root></mxGraphModel></diagram></mxfile>`;
      const plan = await calculateNativeAutoLayout(regionXml, "engine-matrix", revision, {
        ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine, algorithm, direction: "RIGHT"
      } as NativeAutoLayoutOptions);
      const positions = new Map(plan.positions.map((position) => [position.cellId, position] as const));
      const region = positions.get("region");
      expect(region).toBeDefined();
      expect(plan.coverage.spatialRegionCount).toBe(1);
      expect(plan.coverage.spatialRegionMemberCount).toBe(4);
      expect(plan.coverage.spatialRegionInternalEdgeCount).toBe(2);
      expect(plan.coverage.spatialRegionInternalEdgesTranslatedCount).toBe(1);
      expect(positions.size).toBe(6);

      const originalPositions = new Map([
        ["region-title", { x: 120, y: 102 }],
        ["switch", { x: 150, y: 160 }],
        ["server", { x: 270, y: 180 }],
        ["plc", { x: 390, y: 280 }]
      ]);
      const delta = { x: region!.x - 100, y: region!.y - 100 };
      for (const id of ["region-title", "switch", "server", "plc"]) {
        const position = positions.get(id);
        expect(position).toBeDefined();
        expect(position!.x).toBeCloseTo(originalPositions.get(id)!.x + delta.x, 4);
        expect(position!.y).toBeCloseTo(originalPositions.get(id)!.y + delta.y, 4);
      }

      const internalRoute = plan.edgeRoutes.find((route) => route.cellId === "internal-edge");
      expect(internalRoute?.points).toEqual([
        { x: 245 + delta.x, y: 170 + delta.y },
        { x: 245 + delta.x, y: 200 + delta.y }
      ]);
      expect(plan.edgeRoutes.some((route) => route.cellId === "internal-edge-no-waypoints")).toBe(false);
      const crossRoute = plan.edgeRoutes.find((route) => route.cellId === "cross-edge");
      expect(crossRoute).toBeDefined();
      expect(crossRoute!.points.some((point) =>
        Math.abs(point.x - region!.x) < 0.02 ||
        Math.abs(point.x - (region!.x + 500)) < 0.02 ||
        Math.abs(point.y - region!.y) < 0.02 ||
        Math.abs(point.y - (region!.y + 400)) < 0.02
      )).toBe(true);
      expect(plan.expectedCells.find((cell) => cell.cellId === "cross-edge"))
        .toMatchObject({ sourceId: "plc", targetId: "outside", parentId: "1" });
    }
  );

  it("lays out the BPMN choreography example when root and layer IDs are generated", async () => {
    const plan = await calculateNativeAutoLayout(
      bpmnChoreographyXml,
      "HCq9DOm8jIu3lRLJQ98l",
      revision,
      { ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "graphviz", algorithm: "dot" }
    );

    expect(plan.layoutLayerId).toBe("VR5IMITfkwXBvMDUpB2b-1");
    expect(plan.layoutLayerFallback).toBe(false);
    expect(plan.positions).toHaveLength(26);
    // Includes cross-boundary connectors attached to nested BPMN choreography cells.
    expect(plan.edgeRoutes).toHaveLength(24);
  });

  it("reports nodes and edges outside the selected layout scope instead of claiming full-page coverage", async () => {
    const scopedXml = `<mxfile host="test"><diagram id="scope" name="Mixed scope"><mxGraphModel><root>
      <mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Overlay" parent="0"/>
      <mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="0" y="0" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry x="100" y="0" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="overlay-node" value="Other layer node" vertex="1" parent="2"><mxGeometry x="200" y="0" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="group" value="Group" vertex="1" parent="1"><mxGeometry x="0" y="100" width="120" height="80" as="geometry"/></mxCell>
      <mxCell id="nested" value="Nested child" vertex="1" parent="group"><mxGeometry x="10" y="10" width="40" height="20" as="geometry"/></mxCell>
      <mxCell id="nested-2" value="Nested child 2" vertex="1" parent="group"><mxGeometry x="65" y="10" width="40" height="20" as="geometry"/></mxCell>
      <mxCell id="edge-inside-group" edge="1" parent="group" source="nested" target="nested-2"><mxGeometry relative="1" as="geometry"/></mxCell>
      <mxCell id="legacy" value="No geometry" vertex="1" parent="1"/>
      <mxCell id="hidden" value="Hidden" vertex="1" parent="1" visible="0"><mxGeometry x="0" y="200" width="40" height="20" as="geometry"/></mxCell>
      <mxCell id="edge-ab" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
      <mxCell id="edge-overlay" edge="1" parent="2" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>
      <mxCell id="edge-no-geometry" edge="1" parent="1" source="a" target="b"/>
      <mxCell id="edge-missing-target" edge="1" parent="1" source="a"><mxGeometry relative="1" as="geometry"/></mxCell>
      <mxCell id="edge-nested-target" edge="1" parent="1" source="a" target="nested"><mxGeometry relative="1" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    const plan = await calculateNativeAutoLayout(scopedXml, "scope", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
      engine: "dagre"
    });

    expect(plan.coverage).toEqual({
      sourceVertexCount: 8,
      plannedVertexCount: 3,
      untouchedVertexCount: 5,
      nestedVertexCount: 2,
      verticesInOtherLayersCount: 1,
      hiddenVertexCount: 1,
      verticesWithoutGeometryCount: 1,
      sourceEdgeCount: 6,
      plannedEdgeCount: 2,
      untouchedEdgeCount: 4,
      edgesOutsideLayoutLayerCount: 2,
      hiddenEdgeCount: 0,
      edgesWithoutGeometryCount: 1,
      edgesMissingTerminalsCount: 1,
      edgesWithEndpointsOutsideTargetVerticesCount: 0,
      connectorsAttachedToNestedChildrenCount: 1,
      edgesWithinSameGroupUntouchedCount: 1,
      spatialRegionCount: 0,
      spatialRegionMemberCount: 0,
      spatialRegionBoundaryVertexCount: 0,
      spatialRegionCandidatesSkippedCount: 0,
      spatialRegionInternalEdgeCount: 0,
      spatialRegionInternalEdgesTranslatedCount: 0
    });
    expect(plan.positions.map((position) => position.cellId).sort()).toEqual(["a", "b", "group"]);
    expect(plan.edgeRoutes.map((route) => route.cellId).sort()).toEqual(["edge-ab", "edge-nested-target"]);
    expect(plan.edgeRoutes.find((route) => route.cellId === "edge-nested-target")?.points.length).toBeGreaterThan(0);
    expect(plan.edgeRoutes.some((route) => route.cellId === "edge-inside-group")).toBe(false);
    // Layout calculation is read-only: neither child-local geometry nor the native edge terminal is rewritten.
    expect(scopedXml).toContain('id="nested" value="Nested child" vertex="1" parent="group"');
    expect(scopedXml).toContain('id="edge-inside-group" edge="1" parent="group" source="nested" target="nested-2"');
    expect(scopedXml).toContain('id="edge-nested-target" edge="1" parent="1" source="a" target="nested"');
  });

  it("keeps honest coverage for the upstream multi-page BPMN example", async () => {
    const fixture = readFileSync(new URL("./fixtures/bpmn-example.drawio", import.meta.url), "utf8");
    const plan = await calculateNativeAutoLayout(fixture, null, revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
      engine: "dagre",
      algorithm: "layered"
    });

    expect(plan.coverage).toMatchObject({
      sourceVertexCount: 45,
      plannedVertexCount: 3,
      untouchedVertexCount: 42,
      sourceEdgeCount: 32
    });
    expect(plan.coverage.plannedEdgeCount).toBe(plan.edgeRoutes.length);
    expect(plan.coverage.untouchedEdgeCount).toBe(plan.coverage.sourceEdgeCount - plan.coverage.plannedEdgeCount);
    expect(plan.pageId).toBe("L4GpW-EUjeUzysb4IhCQ");
  });

  it("reports excluded links for the upstream bus topology example", async () => {
    const fixture = readFileSync(new URL("./fixtures/bus-topology-example.drawio", import.meta.url), "utf8");
    const plan = await calculateNativeAutoLayout(fixture, null, revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
      engine: "dagre",
      algorithm: "layered"
    });

    expect(plan.coverage).toMatchObject({
      sourceVertexCount: 54,
      plannedVertexCount: 54,
      untouchedVertexCount: 0,
      sourceEdgeCount: 17
    });
    expect(plan.coverage.plannedEdgeCount).toBe(plan.edgeRoutes.length);
    expect(plan.coverage.untouchedEdgeCount).toBe(plan.coverage.sourceEdgeCount - plan.coverage.plannedEdgeCount);
  });

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

  it("prefers Draw.io's conventional default layer ID 1 even when another layer appears first in XML", async () => {
    const reorderedLayers = xml.replace(
      '<mxCell id="0"/>',
      '<mxCell id="0"/><mxCell id="overlay" value="Overlay" parent="0"/>'
    );
    const plan = await calculateNativeAutoLayout(reorderedLayers, "page-1", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS);

    expect(plan.layoutLayerId).toBe("1");
    expect(plan.layoutLayerFallback).toBe(false);
    expect(plan.positions.map((item) => item.cellId).sort()).toEqual(["api", "db", "worker"]);
  });

  it("uses a sole populated visible layer when the default layer is empty", async () => {
    const pageOneEnd = xml.indexOf('  <diagram id="page-2"');
    const pageOne = xml.slice(0, pageOneEnd)
      .replace(
        '<mxCell id="1" parent="0"/>',
        '<mxCell id="1" parent="0"/><mxCell id="content-layer" value="Content" parent="0"/>'
      )
      .replaceAll('parent="1"', 'parent="content-layer"');
    const nonDefaultContent = pageOne + xml.slice(pageOneEnd);
    const plan = await calculateNativeAutoLayout(nonDefaultContent, "page-1", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS);

    expect(plan.layoutLayerId).toBe("content-layer");
    expect(plan.layoutLayerFallback).toBe(true);
    expect(plan.positions.map((item) => item.cellId).sort()).toEqual(["api", "db", "worker"]);
    expect(plan.edgeRoutes).toHaveLength(2);
  });

  it("reports per-layer counts rather than hiding why a diagram has no unambiguous layout scope", async () => {
    const emptyDefault = xml
      .replace(
        '<mxCell id="1" parent="0"/>',
        '<mxCell id="1" parent="0"/><mxCell id="content-layer" parent="0"/><mxCell id="overlay-layer" parent="0"/>'
      )
      .replace('parent="1" style="rounded=1;fillColor=#ffffff;"', 'parent="content-layer" style="rounded=1;fillColor=#ffffff;"')
      .replace('<mxCell vertex="1" parent="1"><mxGeometry x="260"', '<mxCell vertex="1" parent="content-layer"><mxGeometry x="260"')
      .replace('<mxCell vertex="1" parent="1"><mxGeometry x="500"', '<mxCell vertex="1" parent="overlay-layer"><mxGeometry x="500"');
    await expect(calculateNativeAutoLayout(emptyDefault, "page-1", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS))
      .rejects.toThrow(/Visible root layers:.*content-layer.*overlay-layer/);
  });

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
      { id: "a", parentId: "1", sourceId: null, targetId: null, kind: "vertex", x: 0, y: 0, width: 40, height: 40, hasGeometry: true, visible: true, points: [] },
      { id: "b", parentId: "1", sourceId: null, targetId: null, kind: "vertex", x: 200, y: 40, width: 40, height: 40, hasGeometry: true, visible: true, points: [] }
    ];
    const edges: FlowEdge[] = [
      { id: "e", parentId: "1", sourceId: "a", targetId: "b", kind: "edge", x: 0, y: 0, width: 0, height: 0, hasGeometry: true, visible: true, points: [] }
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

describe("additional native layout engines", () => {
  it.each([
    ["graphviz", "dot"], ["graphviz", "neato"], ["graphviz", "fdp"],
    ["graphviz", "sfdp"], ["graphviz", "circo"], ["graphviz", "twopi"],
    ["msagl", "layered"], ["msagl", "mds"], ["msagl", "ipsepcola"],
    ["cytoscape", "breadthfirst"], ["cytoscape", "circle"], ["cytoscape", "concentric"],
    ["cytoscape", "grid"], ["cytoscape", "random"], ["cytoscape", "cose"], ["cytoscape", "fcose"],
    ["d3", "tree"], ["d3", "cluster"], ["d3", "force"],
    ["elk", "random"], ["elk", "sporeCompaction"], ["elk", "sporeOverlap"], ["elk", "fixed"]
  ] as const)("calculates native geometry with %s / %s", async (engine, algorithm) => {
    const plan = await calculateNativeAutoLayout(xml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS,
      engine,
      algorithm,
      direction: "RIGHT"
    } as NativeAutoLayoutOptions);
    expect(plan.engine).toBe(engine);
    expect(plan.algorithm).toBe(algorithm);
    expect(plan.positions).toHaveLength(3);
    expect(plan.positions.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
  });

  it.each(["box", "rectpacking"] as const)("supports ELK %s for unconnected native cells", async (algorithm) => {
    const disconnectedXml = xml.replace(/<object id="edge-api-worker"[\s\S]*?<\/object>\s*<object id="edge-worker-db"[\s\S]*?<\/object>/, "");
    const plan = await calculateNativeAutoLayout(disconnectedXml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm
    });
    expect(plan.positions).toHaveLength(3);
  });

  it("keeps absolute native positions with ELK Fixed", async () => {
    const plan = await calculateNativeAutoLayout(xml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "fixed", margin: 100
    });
    expect(plan.positions.find((position) => position.cellId === "api")).toEqual({ cellId: "api", x: 40, y: 40 });
    expect(plan.positions.find((position) => position.cellId === "worker")).toEqual({ cellId: "worker", x: 260, y: 200 });
    expect(plan.positions.find((position) => position.cellId === "db")).toEqual({ cellId: "db", x: 500, y: 360 });
  });

  it("rejects ELK packing algorithms for connected diagrams", async () => {
    await expect(calculateNativeAutoLayout(xml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "box"
    })).rejects.toThrow(/unconnected nodes/i);
    await expect(calculateNativeAutoLayout(xml, "page-1", revision, {
      ...DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, engine: "elk", algorithm: "rectpacking"
    })).rejects.toThrow(/unconnected nodes/i);
  });

  it("exposes algorithm choices only for their matching engines", () => {
    expect(nativeLayoutAlgorithmsForEngine("dagre").map((item) => item.value)).toEqual(["layered"]);
    expect(nativeLayoutAlgorithmsForEngine("elk").map((item) => item.value)).toEqual([
      "layered", "mrtree", "radial", "stress", "force", "box", "fixed", "rectpacking", "random", "sporeCompaction", "sporeOverlap"
    ]);
    expect(nativeLayoutAlgorithmsForEngine("graphviz").map((item) => item.value)).toContain("sfdp");
    expect(nativeLayoutAlgorithmsForEngine("msagl").map((item) => item.value)).toContain("mds");
    expect(nativeLayoutAlgorithmsForEngine("cytoscape").map((item) => item.value)).toEqual(["breadthfirst", "circle", "concentric", "grid", "random", "cose", "fcose"]);
    expect(nativeLayoutAlgorithmsForEngine("d3").map((item) => item.value)).toContain("tree");
  });
});


describe("native layout identity resolution", () => {
  const noncanonicalIdsXml = `<mxfile><diagram id="custom-page" name="Custom IDs"><mxGraphModel><root>
    <mxCell id="graph-root"/>
    <mxCell id="main-layer" parent="graph-root"/>
    <mxCell id="node-a" value="A" vertex="1" parent="main-layer"><mxGeometry x="20" y="30" width="100" height="40" as="geometry"/></mxCell>
    <mxCell id="node-b" value="B" vertex="1" parent="main-layer"><mxGeometry x="220" y="30" width="100" height="40" as="geometry"/></mxCell>
    <mxCell id="edge-a-b" edge="1" parent="main-layer" source="node-a" target="node-b"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;

  it("resolves root and the sole layer by structure regardless of their IDs", async () => {
    const plan = await calculateNativeAutoLayout(noncanonicalIdsXml, "custom-page", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS);
    expect(plan.layoutLayerId).toBe("main-layer");
    expect(plan.positions.map((position) => position.cellId).sort()).toEqual(["node-a", "node-b"]);
  });

  it("does not prefer a layer because its ID is 1 when multiple populated layers exist", async () => {
    const ambiguous = `<mxfile><diagram id="custom-page"><mxGraphModel><root>
      <mxCell id="graph-root"/>
      <mxCell id="1" parent="graph-root"/>
      <mxCell id="other-layer" parent="graph-root"/>
      <mxCell id="in-default" value="Default layer node" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="in-other" value="Other layer node" vertex="1" parent="other-layer"><mxGeometry x="200" y="10" width="80" height="40" as="geometry"/></mxCell>
    </root></mxGraphModel></diagram></mxfile>`;
    await expect(calculateNativeAutoLayout(ambiguous, "custom-page", revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS))
      .rejects.toThrow(/no top-level native Draw\.io vertices/i);
  });

  it("does not infer an active page from XML order in a multi-page file", async () => {
    const secondPage = noncanonicalIdsXml
      .replace('id="custom-page"', 'id="second-page"')
      .replaceAll('id="graph-root"', 'id="second-root"')
      .replaceAll('parent="graph-root"', 'parent="second-root"')
      .replaceAll('id="main-layer"', 'id="second-layer"')
      .replaceAll('parent="main-layer"', 'parent="second-layer"')
      .replaceAll('id="node-a"', 'id="second-node-a"')
      .replaceAll('id="node-b"', 'id="second-node-b"')
      .replaceAll('id="edge-a-b"', 'id="second-edge-a-b"')
      .replaceAll('source="node-a"', 'source="second-node-a"')
      .replaceAll('target="node-b"', 'target="second-node-b"');
    const secondPageContents = secondPage.slice("<mxfile>".length, -"</mxfile>".length);
    const multipage = noncanonicalIdsXml.replace("</mxfile>", secondPageContents + "</mxfile>");
    await expect(calculateNativeAutoLayout(multipage, null, revision, DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS))
      .rejects.toThrow(/multiple pages but no active page ID/i);
  });
});
