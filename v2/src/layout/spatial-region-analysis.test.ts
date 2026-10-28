import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NativeDiagramCapabilityContext } from "../model/native-diagram-capabilities";
import {
  SPATIAL_REGION_ANALYSIS_ID,
  spatialRegionAnalysisProvider,
  detectSpatialRegionsForLayout
} from "./spatial-region-analysis";

const revision = "r".repeat(64);
const industrialIotXml = readFileSync(new URL("./fixtures/industrial-iot-example.drawio", import.meta.url), "utf8");

function context(documentXml: string, pageId: string | null = "page-1", documentRevision = revision): NativeDiagramCapabilityContext {
  return { documentXml, documentRevision, pageId, selectedCellId: null, cells: [] };
}

function request(pageId: string | null = "page-1", documentRevision = revision) {
  return { pageId, documentRevision };
}

function page(contents: string, id = "page-1") {
  return `<mxfile host="app.diagrams.net"><diagram id="${id}" name="Page"><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    ${contents}
  </root></mxGraphModel></diagram></mxfile>`;
}

const regionCells = `
  <mxCell id="region-it" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
    <mxGeometry x="0" y="0" width="500" height="400" as="geometry"/>
  </mxCell>
  <mxCell id="region-title" value="IT Network" vertex="1" parent="1" style="text;html=1;align=left;strokeColor=none;fillColor=none;">
    <mxGeometry x="20" y="8" width="100" height="24" as="geometry"/>
  </mxCell>
  <mxCell id="switch-a" value="Switch A" vertex="1" parent="1" style="rounded=1;fillColor=#ffffff;">
    <mxGeometry x="50" y="80" width="80" height="40" as="geometry"/>
  </mxCell>
  <mxCell id="server-b" value="Server B" vertex="1" parent="1">
    <mxGeometry x="180" y="120" width="80" height="40" as="geometry"/>
  </mxCell>
  <mxCell id="plc-c" value="PLC C" vertex="1" parent="1">
    <mxGeometry x="300" y="220" width="80" height="40" as="geometry"/>
  </mxCell>
  <mxCell id="outside" value="Outside node" vertex="1" parent="1">
    <mxGeometry x="700" y="500" width="80" height="40" as="geometry"/>
  </mxCell>
`;

function analyze(xml: string, pageId: string | null = "page-1", ctxRevision = revision, req = request(pageId, ctxRevision)) {
  return spatialRegionAnalysisProvider.analyze(context(xml, pageId, ctxRevision), req);
}

describe("read-only spatial region analysis", () => {
  it("detects at least one region in the real public Industrial IoT Draw.io example", () => {
    const pageId = "SXgX17sldJI9QkPeDldp";
    const response = analyze(industrialIotXml, pageId);
    expect(response.status).toBe("analyzed");
    if (response.status === "analyzed") {
      const candidates = response.result.findings.filter((finding) => finding.ruleId === "spatial-region.candidate");
      expect(candidates.length).toBeGreaterThan(0);
      const labels = candidates.map((finding) => String(finding.details?.label ?? ""));
      const nearbyLabels = candidates.map((finding) => String(finding.details?.probableBoundaryLabels ?? "")).join(" ");
      expect([...labels, nearbyLabels].join(" ")).toContain("IT Network");
      expect([...labels, nearbyLabels].join(" ")).toContain("OT Network");
    }
  });

  it("detects a large rectangular sibling boundary and probable title without modifying XML", () => {
    const xml = page(regionCells);
    const before = xml;
    const response = analyze(xml);
    expect(response.status).toBe("analyzed");
    if (response.status !== "analyzed") return;
    expect(response.result.capabilityId).toBe(SPATIAL_REGION_ANALYSIS_ID);
    const candidate = response.result.findings.find((finding) => finding.ruleId === "spatial-region.candidate");
    expect(candidate).toBeDefined();
    expect(candidate?.cellIds).toContain("region-it");
    expect(candidate?.cellIds).toContain("switch-a");
    expect(candidate?.cellIds).toContain("server-b");
    expect(candidate?.cellIds).toContain("plc-c");
    expect(candidate?.details?.probableBoundaryLabels).toContain("IT Network");
    expect(candidate?.details?.enclosedMemberCount).toBe(3);
    expect(xml).toBe(before);
  });

  it("treats a connected container that dominates its members as a region", () => {
    const xml = page(`
      <mxCell id="large-node" value="Large subsystem" vertex="1" parent="1" style="shape=rect;fillColor=#fff;">
        <mxGeometry x="0" y="0" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="40" y="50" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="b" value="B" vertex="1" parent="1"><mxGeometry x="140" y="50" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="c" value="C" vertex="1" parent="1"><mxGeometry x="240" y="50" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="edge" edge="1" parent="1" source="large-node" target="a"><mxGeometry relative="1" as="geometry"/></mxCell>
    `);
    const response = analyze(xml);
    expect(response.status).toBe("analyzed");
    if (response.status === "analyzed") {
      const candidates = response.result.findings.filter((finding) => finding.ruleId === "spatial-region.candidate");
      expect(candidates).toHaveLength(1);
      expect(candidates[0].cellIds).toContain("large-node");
      expect(candidates[0].details?.enclosedMemberCount).toBe(3);
    }
  });

  it("keeps a connected node that does not dominate its contents out of the region set", () => {
    const xml = page(`
      <mxCell id="wrapper" value="Wrapper" vertex="1" parent="1" style="shape=rect;fillColor=#fff;">
        <mxGeometry x="0" y="0" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="almost-as-large" value="Almost as large" vertex="1" parent="1">
        <mxGeometry x="40" y="30" width="420" height="340" as="geometry"/>
      </mxCell>
      <mxCell id="edge" edge="1" parent="1" source="wrapper" target="almost-as-large"><mxGeometry relative="1" as="geometry"/></mxCell>
    `);
    const response = analyze(xml);
    expect(response.status).toBe("analyzed");
    if (response.status === "analyzed") {
      expect(response.result.findings.filter((finding) => finding.ruleId === "spatial-region.candidate")).toHaveLength(0);
    }
  });

  it("treats a labelled connected container with a single member as a region", () => {
    const xml = page(`
      <mxCell id="order-service" value="Order Service" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
        <mxGeometry x="0" y="0" width="400" height="300" as="geometry"/>
      </mxCell>
      <mxCell id="cart" value="Cart" vertex="1" parent="1"><mxGeometry x="60" y="80" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="outside" value="Outside" vertex="1" parent="1"><mxGeometry x="600" y="80" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="edge" edge="1" parent="1" source="order-service" target="outside"><mxGeometry relative="1" as="geometry"/></mxCell>
    `);
    const detection = detectSpatialRegionsForLayout(xml, "page-1");
    const region = detection.candidates.find((candidate) => candidate.regionCellId === "order-service");
    expect(region).toBeDefined();
    expect(region?.memberCellIds).toEqual(["cart"]);
    expect(region?.eligible).toBe(true);
    expect(detection.unownedContainedVertexCellIds).toEqual([]);
  });

  it("treats a container titled by a separate text cell with a single member as a region", () => {
    const xml = page(`
      <mxCell id="billing" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
        <mxGeometry x="0" y="0" width="400" height="300" as="geometry"/>
      </mxCell>
      <mxCell id="billing-title" value="Billing" vertex="1" parent="1" style="text;html=1;strokeColor=none;fillColor=none;">
        <mxGeometry x="12" y="6" width="130" height="24" as="geometry"/>
      </mxCell>
      <mxCell id="invoice" value="Invoice" vertex="1" parent="1"><mxGeometry x="60" y="90" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="outside" value="Outside" vertex="1" parent="1"><mxGeometry x="600" y="90" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="edge" edge="1" parent="1" source="billing" target="outside"><mxGeometry relative="1" as="geometry"/></mxCell>
    `);
    const detection = detectSpatialRegionsForLayout(xml, "page-1");
    const region = detection.candidates.find((candidate) => candidate.regionCellId === "billing");
    expect(region).toBeDefined();
    expect(region?.memberCellIds).toEqual(["invoice", "billing-title"]);
    expect(region?.label).toBe("Billing");
    expect(region?.eligible).toBe(true);
  });

  it("reports fully contained vertices whose container is not recognised as a region", () => {
    const xml = page(`
      <mxCell id="unlabelled-box" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;">
        <mxGeometry x="0" y="0" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="lonely-child" value="Lonely" vertex="1" parent="1"><mxGeometry x="60" y="80" width="80" height="40" as="geometry"/></mxCell>
    `);
    const detection = detectSpatialRegionsForLayout(xml, "page-1");
    expect(detection.candidates).toHaveLength(0);
    expect(detection.unownedContainedVertexCellIds).toEqual(["lonely-child"]);
  });

  it("does not classify a plain rectangle with too few enclosed members as a region", () => {
    const xml = page(`
      <mxCell id="large-node" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;">
        <mxGeometry x="0" y="0" width="500" height="400" as="geometry"/>
      </mxCell>
      <mxCell id="a" value="A" vertex="1" parent="1"><mxGeometry x="40" y="50" width="40" height="30" as="geometry"/></mxCell>
    `);
    const response = analyze(xml);
    expect(response.status).toBe("analyzed");
    if (response.status === "analyzed") {
      expect(response.result.findings.filter((finding) => finding.ruleId === "spatial-region.candidate")).toHaveLength(0);
    }
  });

  it("reports a node that straddles the boundary rather than counting it as a contained member", () => {
    const xml = page(regionCells + `
      <mxCell id="boundary-firewall" value="Firewall" vertex="1" parent="1">
        <mxGeometry x="470" y="350" width="80" height="70" as="geometry"/>
      </mxCell>
    `);
    const response = analyze(xml);
    expect(response.status).toBe("analyzed");
    if (response.status === "analyzed") {
      const boundary = response.result.findings.find((finding) => finding.ruleId === "spatial-region.boundary-elements");
      expect(boundary?.cellIds).toContain("boundary-firewall");
    }
  });

  it("reports non-nested overlapping rectangles as ambiguous instead of silently selecting a hierarchy", () => {
    const xml = page(`
      <mxCell id="region-a" value="Area A" vertex="1" parent="1" style="shape=rect;fillColor=none;"><mxGeometry x="0" y="0" width="500" height="400" as="geometry"/></mxCell>
      <mxCell id="region-b" value="Area B" vertex="1" parent="1" style="shape=rect;fillColor=none;"><mxGeometry x="350" y="100" width="500" height="400" as="geometry"/></mxCell>
      <mxCell id="a1" value="A1" vertex="1" parent="1"><mxGeometry x="40" y="50" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="a2" value="A2" vertex="1" parent="1"><mxGeometry x="140" y="50" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="a3" value="A3" vertex="1" parent="1"><mxGeometry x="240" y="50" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="b1" value="B1" vertex="1" parent="1"><mxGeometry x="620" y="150" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="b2" value="B2" vertex="1" parent="1"><mxGeometry x="680" y="230" width="40" height="30" as="geometry"/></mxCell>
      <mxCell id="b3" value="B3" vertex="1" parent="1"><mxGeometry x="740" y="310" width="40" height="30" as="geometry"/></mxCell>
    `);
    const response = analyze(xml);
    expect(response.status).toBe("analyzed");
    if (response.status === "analyzed") {
      const overlap = response.result.findings.find((finding) => finding.ruleId === "spatial-region.overlap-ambiguous");
      expect(overlap).toBeDefined();
      expect(overlap?.cellIds).toContain("region-a");
      expect(overlap?.cellIds).toContain("region-b");
    }
  });

  it("does not auto-group overlapping region candidates", () => {
    const xml = page([
      '<mxCell id="region-a" value="Area A" vertex="1" parent="1" style="shape=rect;fillColor=none;"><mxGeometry x="0" y="0" width="500" height="400" as="geometry"/></mxCell>',
      '<mxCell id="region-b" value="Area B" vertex="1" parent="1" style="shape=rect;fillColor=none;"><mxGeometry x="350" y="100" width="500" height="400" as="geometry"/></mxCell>',
      '<mxCell id="a1" value="A1" vertex="1" parent="1"><mxGeometry x="40" y="50" width="40" height="30" as="geometry"/></mxCell>',
      '<mxCell id="a2" value="A2" vertex="1" parent="1"><mxGeometry x="140" y="50" width="40" height="30" as="geometry"/></mxCell>',
      '<mxCell id="a3" value="A3" vertex="1" parent="1"><mxGeometry x="240" y="50" width="40" height="30" as="geometry"/></mxCell>',
      '<mxCell id="b1" value="B1" vertex="1" parent="1"><mxGeometry x="620" y="150" width="40" height="30" as="geometry"/></mxCell>',
      '<mxCell id="b2" value="B2" vertex="1" parent="1"><mxGeometry x="680" y="230" width="40" height="30" as="geometry"/></mxCell>',
      '<mxCell id="b3" value="B3" vertex="1" parent="1"><mxGeometry x="740" y="310" width="40" height="30" as="geometry"/></mxCell>'
    ].join(""));
    const detection = detectSpatialRegionsForLayout(xml, "page-1");
    const candidates = detection.candidates.filter((candidate) =>
      candidate.regionCellId === "region-a" || candidate.regionCellId === "region-b"
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) =>
      !candidate.eligible && candidate.skipReason === "low-confidence-or-overlap"
    )).toBe(true);
    expect(detection.eligibleCandidates).toHaveLength(0);
    expect(detection.skippedCandidateCount).toBe(2);
  });

  it("reports nested region candidates as skipped by the atomic layout projection", () => {
    const xml = page([
      '<mxCell id="outer-region" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;"><mxGeometry x="0" y="0" width="800" height="650" as="geometry"/></mxCell>',
      '<mxCell id="outer-title" value="OT Network" vertex="1" parent="1" style="shape=text;html=1;strokeColor=none;fillColor=none;"><mxGeometry x="20" y="8" width="130" height="24" as="geometry"/></mxCell>',
      '<mxCell id="inner-region" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;"><mxGeometry x="180" y="140" width="400" height="300" as="geometry"/></mxCell>',
      '<mxCell id="inner-title" value="IT Network" vertex="1" parent="1" style="shape=text;html=1;strokeColor=none;fillColor=none;"><mxGeometry x="195" y="145" width="130" height="24" as="geometry"/></mxCell>',
      '<mxCell id="inner-a" value="A" vertex="1" parent="1"><mxGeometry x="220" y="210" width="80" height="40" as="geometry"/></mxCell>',
      '<mxCell id="inner-b" value="B" vertex="1" parent="1"><mxGeometry x="340" y="220" width="80" height="40" as="geometry"/></mxCell>',
      '<mxCell id="inner-c" value="C" vertex="1" parent="1"><mxGeometry x="460" y="320" width="80" height="40" as="geometry"/></mxCell>',
      '<mxCell id="outer-a" value="D" vertex="1" parent="1"><mxGeometry x="50" y="470" width="80" height="40" as="geometry"/></mxCell>',
      '<mxCell id="outer-b" value="E" vertex="1" parent="1"><mxGeometry x="170" y="530" width="80" height="40" as="geometry"/></mxCell>',
      '<mxCell id="outer-c" value="F" vertex="1" parent="1"><mxGeometry x="660" y="480" width="80" height="40" as="geometry"/></mxCell>'
    ].join(""));
    const detection = detectSpatialRegionsForLayout(xml, "page-1");
    const candidates = detection.candidates.filter((candidate) =>
      candidate.regionCellId === "outer-region" || candidate.regionCellId === "inner-region"
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) =>
      !candidate.eligible && candidate.skipReason === "nested-region"
    )).toBe(true);
    expect(detection.eligibleCandidates).toHaveLength(0);
  });

  it("only analyzes the requested active page", () => {
    const xml = `<mxfile host="app.diagrams.net">
      <diagram id="page-1" name="With region"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${regionCells}</root></mxGraphModel></diagram>
      <diagram id="page-2" name="Without region"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
        <mxCell id="plain" value="Only node" vertex="1" parent="1"><mxGeometry x="10" y="10" width="80" height="40" as="geometry"/></mxCell>
      </root></mxGraphModel></diagram>
    </mxfile>`;
    const first = analyze(xml, "page-1");
    const second = analyze(xml, "page-2");
    expect(first.status).toBe("analyzed");
    expect(second.status).toBe("analyzed");
    if (first.status === "analyzed" && second.status === "analyzed") {
      expect(first.result.findings.some((finding) => finding.ruleId === "spatial-region.candidate")).toBe(true);
      expect(second.result.findings.some((finding) => finding.ruleId === "spatial-region.candidate")).toBe(false);
    }
  });

  it("rejects malformed requests and stale document/page contexts", () => {
    const xml = page(regionCells);
    expect(spatialRegionAnalysisProvider.analyze(context(xml), null).status).toBe("invalid");
    expect(spatialRegionAnalysisProvider.analyze(context(xml), { pageId: "page-1" }).status).toBe("invalid");
    expect(spatialRegionAnalysisProvider.analyze(context(xml, null), request(null)).status).toBe("invalid");
    expect(spatialRegionAnalysisProvider.analyze(context(xml), request("page-1", "stale")).status).toBe("stale");
    expect(spatialRegionAnalysisProvider.analyze(context(xml), request("page-2")).status).toBe("stale");
  });

  it("fails closed for a missing page and does not infer a fallback page", () => {
    const xml = page(regionCells);
    const response = analyze(xml, "not-a-page");
    expect(response.status).toBe("invalid");
  });
});
