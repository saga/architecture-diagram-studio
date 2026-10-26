import type {
  NativeDiagramAnalysisProvider,
  NativeDiagramCapabilityContext,
  NativeDiagramFinding,
  NativeDiagramAnalysisResponse
} from "../model/native-diagram-capabilities";
import { parseDrawioXml } from "../model/drawio-xml-dom";
import { decodeDrawioPageXml } from "../model/drawio-xml-schema";

export const SPATIAL_REGION_ANALYSIS_ID = "quality.spatial-region-boundaries";

export const spatialRegionAnalysisProvider = {
  descriptor: {
    id: SPATIAL_REGION_ANALYSIS_ID,
    apiVersion: 1 as const,
    kind: "quality" as const,
    title: "Detect geometry-only regions",
    description: "Read-only detection of large rectangular boundaries, likely members, boundary nodes and ambiguous overlaps."
  },
  analyze
} satisfies NativeDiagramAnalysisProvider;

interface CellBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SpatialCell extends CellBounds {
  id: string;
  parentId: string | null;
  kind: "vertex" | "edge" | "other";
  value: string;
  style: string;
  visible: boolean;
  hasGeometry: boolean;
  sourceId: string | null;
  targetId: string | null;
}

interface RegionCandidate {
  cell: SpatialCell;
  area: number;
  baselineArea: number;
  areaRatio: number;
  explicitRegionEvidence: boolean;
  ownLabel: string;
  nearBoundaryLabels: Array<{ id: string; label: string }>;
  memberCellIds: string[];
  nestedRegionCellIds: string[];
  boundaryCellIds: string[];
  ambiguousCellIds: string[];
  overlapsRegionCellIds: string[];
  confidence: "high" | "medium" | "low";
}

const MIN_REGION_AREA = 16_000;
const MIN_REGION_AREA_RATIO = 5;
const MIN_ENCLOSED_MEMBERS = 3;
const FULL_CONTAINMENT_RATIO = 0.85;
const MIN_OVERLAP_RATIO = 0.15;
const MAX_FINDING_CELL_IDS = 200;

function elementChildren(element: Element): Element[] {
  const result: Element[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child?.nodeType === 1) result.push(child as Element);
  }
  return result;
}

function directChild(element: Element, name: string): Element | null {
  return elementChildren(element).find((child) => child.nodeName === name) ?? null;
}

function effectiveCellId(cell: Element): string {
  const wrapper = cell.parentElement;
  if (wrapper && !["root", "mxGraphModel", "diagram", "mxfile"].includes(wrapper.nodeName)) {
    const wrappedId = wrapper.getAttribute("id");
    if (wrappedId) return wrappedId;
  }
  return cell.getAttribute("id") || "";
}

function plainLabel(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function cellValue(cell: Element): string {
  const wrapper = cell.parentElement;
  if (wrapper?.hasAttribute("label")) return plainLabel(wrapper.getAttribute("label") ?? "");
  if (wrapper?.hasAttribute("value")) return plainLabel(wrapper.getAttribute("value") ?? "");
  if (cell.hasAttribute("value")) return plainLabel(cell.getAttribute("value") ?? "");
  return plainLabel(cell.getAttribute("label") ?? "");
}

function cellStyle(cell: Element): string {
  const wrapper = cell.parentElement;
  return cell.getAttribute("style") || wrapper?.getAttribute("style") || "";
}

function styleProperties(style: string): { shape: string; values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const parts = style.split(";").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) flags.add(part);
    else values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const declaredShape = values.get("shape");
  const firstFlag = parts.find((part) => !part.includes("="));
  return {
    shape: (declaredShape || firstFlag || "").toLowerCase(),
    values,
    flags
  };
}

function isTextLike(cell: SpatialCell): boolean {
  const properties = styleProperties(cell.style);
  return properties.shape === "text" ||
    properties.shape === "label" ||
    properties.flags.has("text") ||
    properties.values.get("text") === "1" ||
    properties.values.get("shape") === "label";
}

function isRectangular(cell: SpatialCell): boolean {
  const properties = styleProperties(cell.style);
  if (properties.values.get("container") === "1") return true;
  return properties.shape === "" ||
    properties.shape === "rect" ||
    properties.shape === "rectangle" ||
    properties.shape === "swimlane";
}

function hasExplicitRegionSemantics(cell: SpatialCell): boolean {
  const properties = styleProperties(cell.style);
  return properties.values.get("container") === "1" ||
    properties.shape === "swimlane" ||
    properties.values.get("collapsible") === "1";
}

function parseNativePage(xml: string, requestedPageId: string | null): { model: Document; actualPageId: string | null } {
  const document = parseDrawioXml(xml);
  if (document.documentElement.nodeName === "mxGraphModel") {
    if (requestedPageId !== null) throw new Error("A bare mxGraphModel has no page ID; the request must use pageId null.");
    return { model: document, actualPageId: null };
  }
  if (document.documentElement.nodeName !== "mxfile") {
    throw new Error("Spatial region analysis only supports native Draw.io mxfile or mxGraphModel documents.");
  }
  const pages = Array.from(document.getElementsByTagName("diagram"));
  const page = requestedPageId === null
    ? pages[0]
    : pages.find((candidate) => candidate.getAttribute("id") === requestedPageId);
  if (!page) {
    throw new Error(requestedPageId === null
      ? "The Draw.io document has no pages to analyze."
      : "The requested Draw.io page was not found; refusing to analyze a different page.");
  }
  const inlineModel = page.getElementsByTagName("mxGraphModel").item(0);
  if (inlineModel) return { model: inlineModel as unknown as Document, actualPageId: page.getAttribute("id") || null };
  const payload = (page.textContent || "").trim();
  if (!payload) throw new Error("The requested Draw.io page has no graph model.");
  const decoded = parseDrawioXml(decodeDrawioPageXml(payload));
  if (decoded.documentElement.nodeName !== "mxGraphModel") throw new Error("The selected Draw.io page did not decode to mxGraphModel.");
  return { model: decoded, actualPageId: page.getAttribute("id") || null };
}

function readCells(model: Document): SpatialCell[] {
  const result: SpatialCell[] = [];
  const seen = new Set<string>();
  const cells = Array.from(model.getElementsByTagName("mxCell")) as Element[];
  for (const cell of cells) {
    const id = effectiveCellId(cell);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const geometry = directChild(cell, "mxGeometry");
    const parseNumber = (name: string) => {
      const value = Number(geometry?.getAttribute(name) ?? 0);
      return Number.isFinite(value) ? value : 0;
    };
    const vertex = cell.getAttribute("vertex") === "1";
    const edge = cell.getAttribute("edge") === "1";
    const wrapper = cell.parentElement;
    result.push({
      id,
      parentId: cell.getAttribute("parent") || null,
      sourceId: cell.getAttribute("source") || null,
      targetId: cell.getAttribute("target") || null,
      kind: vertex ? "vertex" : edge ? "edge" : "other",
      x: parseNumber("x"),
      y: parseNumber("y"),
      width: parseNumber("width"),
      height: parseNumber("height"),
      hasGeometry: Boolean(geometry),
      visible: cell.getAttribute("visible") !== "0" && wrapper?.getAttribute("visible") !== "0",
      value: cellValue(cell),
      style: cellStyle(cell)
    });
  }
  return result;
}

function area(bounds: CellBounds): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

function intersectionArea(a: CellBounds, b: CellBounds): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function containmentRatio(container: CellBounds, child: CellBounds): number {
  const childArea = area(child);
  return childArea > 0 ? intersectionArea(container, child) / childArea : 0;
}

function containsCenter(container: CellBounds, child: CellBounds): boolean {
  const centerX = child.x + child.width / 2;
  const centerY = child.y + child.height / 2;
  return centerX >= container.x && centerX <= container.x + container.width &&
    centerY >= container.y && centerY <= container.y + container.height;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function areDisjointOrNested(a: CellBounds, b: CellBounds): boolean {
  const overlap = intersectionArea(a, b);
  if (overlap === 0) return true;
  const aContainsB = containmentRatio(a, b) >= FULL_CONTAINMENT_RATIO;
  const bContainsA = containmentRatio(b, a) >= FULL_CONTAINMENT_RATIO;
  return aContainsB || bContainsA;
}

function detectRegions(xml: string, pageId: string | null): NativeDiagramFinding[] {
  const { model } = parseNativePage(xml, pageId);
  const cells = readCells(model);
  const rootCandidates = cells.filter((cell) =>
    cell.parentId === null && cell.kind === "other" && !cell.hasGeometry
  );
  const root = rootCandidates.find((cell) => cell.id === "0") ??
    (rootCandidates.length === 1 ? rootCandidates[0] : null);
  if (!root) return [];
  const layers = cells.filter((cell) =>
    cell.parentId === root.id && cell.kind === "other" && !cell.hasGeometry && cell.visible
  );
  const layerIds = new Set(layers.map((layer) => layer.id));
  const verticesByLayer = new Map<string, SpatialCell[]>();
  for (const cell of cells) {
    if (cell.kind !== "vertex" || !cell.visible || !cell.hasGeometry ||
        cell.width <= 0 || cell.height <= 0 || !layerIds.has(cell.parentId ?? "")) continue;
    const layerId = cell.parentId!;
    const entries = verticesByLayer.get(layerId) ?? [];
    entries.push(cell);
    verticesByLayer.set(layerId, entries);
  }
  const connected = new Set<string>();
  for (const edge of cells) {
    if (edge.kind !== "edge") continue;
    if (edge.sourceId) connected.add(edge.sourceId);
    if (edge.targetId) connected.add(edge.targetId);
  }

  const regions: RegionCandidate[] = [];
  for (const [layerId, vertices] of verticesByLayer) {
    const physicalVertices = vertices.filter((cell) => !isTextLike(cell));
    const maxArea = Math.max(0, ...physicalVertices.map(area));
    const baselineCandidates = physicalVertices.map(area).filter((value) => value <= maxArea * 0.35);
    const fallbackAreas = [...physicalVertices.map(area)].sort((a, b) => a - b)
      .slice(0, Math.max(1, Math.ceil(physicalVertices.length * 0.6)));
    const baselineArea = median(baselineCandidates.length ? baselineCandidates : fallbackAreas);

    const preliminary = physicalVertices.filter((cell) => {
      if (connected.has(cell.id) || !isRectangular(cell)) return false;
      const candidateArea = area(cell);
      const explicit = hasExplicitRegionSemantics(cell);
      if (explicit) return true;
      return candidateArea >= MIN_REGION_AREA &&
        candidateArea >= Math.max(MIN_REGION_AREA, baselineArea * MIN_REGION_AREA_RATIO);
    });
    const preliminaryIds = new Set(preliminary.map((cell) => cell.id));
    for (const cell of preliminary) {
      const candidateArea = area(cell);
      const contained = physicalVertices.filter((other) =>
        other.id !== cell.id &&
        !preliminaryIds.has(other.id) &&
        containsCenter(cell, other) &&
        containmentRatio(cell, other) >= FULL_CONTAINMENT_RATIO
      );
      const explicitRegionEvidence = hasExplicitRegionSemantics(cell);
      if (contained.length < MIN_ENCLOSED_MEMBERS && !(explicitRegionEvidence && contained.length >= 2)) continue;
      regions.push({
        cell,
        area: candidateArea,
        baselineArea,
        areaRatio: baselineArea > 0 ? candidateArea / baselineArea : 0,
        explicitRegionEvidence,
        ownLabel: cell.value,
        nearBoundaryLabels: [],
        memberCellIds: contained.map((item) => item.id),
        nestedRegionCellIds: [],
        boundaryCellIds: [],
        ambiguousCellIds: [],
        overlapsRegionCellIds: [],
        confidence: "medium"
      });
    }

    const regionsInLayer = regions.filter((region) => region.cell.parentId === layerId);
    for (const region of regionsInLayer) {
      const regionBounds = region.cell;
      const textLabels = vertices.filter((cell) =>
        cell.id !== region.cell.id &&
        isTextLike(cell) &&
        !connected.has(cell.id) &&
        cell.value.length > 0 &&
        containsCenter(regionBounds, cell) &&
        (() => {
          const verticalPosition = (cell.y + cell.height / 2 - regionBounds.y) / regionBounds.height;
          const horizontalPosition = (cell.x + cell.width / 2 - regionBounds.x) / regionBounds.width;
          const nearTopOrBottom = verticalPosition <= 0.22 || verticalPosition >= 0.78;
          const nearSide = horizontalPosition <= 0.15 || horizontalPosition >= 0.85;
          return (nearTopOrBottom && cell.width >= 50) || (nearSide && cell.height >= 18 && cell.width >= 50);
        })()
      );
      region.nearBoundaryLabels = textLabels.map((cell) => ({ id: cell.id, label: cell.value }));

      for (const other of regionsInLayer) {
        if (other.cell.id === region.cell.id) continue;
        if (containmentRatio(regionBounds, other.cell) >= FULL_CONTAINMENT_RATIO) {
          region.nestedRegionCellIds.push(other.cell.id);
        }
        const overlap = intersectionArea(regionBounds, other.cell);
        const overlapRatio = Math.min(area(regionBounds), area(other.cell)) > 0
          ? overlap / Math.min(area(regionBounds), area(other.cell))
          : 0;
        if (overlapRatio >= MIN_OVERLAP_RATIO && !areDisjointOrNested(regionBounds, other.cell)) {
          region.overlapsRegionCellIds.push(other.cell.id);
        }
      }

      for (const member of vertices) {
        if (member.id === region.cell.id || isTextLike(member) || preliminaryIds.has(member.id)) continue;
        const ratio = containmentRatio(regionBounds, member);
        if (ratio > 0 && ratio < FULL_CONTAINMENT_RATIO &&
            (containsCenter(regionBounds, member) || ratio >= 0.1)) {
          region.boundaryCellIds.push(member.id);
        }
      }
    }
  }

  for (const region of regions) {
    const ownAndNearbyLabel = region.ownLabel || region.nearBoundaryLabels[0]?.label || "";
    if (region.overlapsRegionCellIds.length) region.confidence = "low";
    else if (region.explicitRegionEvidence || (ownAndNearbyLabel.length > 0 && region.memberCellIds.length >= MIN_ENCLOSED_MEMBERS)) {
      region.confidence = "high";
    } else {
      region.confidence = "medium";
    }
  }

  const findings: NativeDiagramFinding[] = [];
  for (const region of regions) {
    // Members under a more specific, nested region are reported there as direct members.
    const directMembers = region.memberCellIds.filter((memberId) => {
      const member = cells.find((cell) => cell.id === memberId);
      if (!member) return false;
      const smallerContainingRegions = regions.filter((inner) =>
        inner.cell.id !== region.cell.id &&
        inner.cell.parentId === region.cell.parentId &&
        containmentRatio(region.cell, inner.cell) >= FULL_CONTAINMENT_RATIO &&
        containsCenter(inner.cell, member) &&
        containmentRatio(inner.cell, member) >= FULL_CONTAINMENT_RATIO
      );
      return smallerContainingRegions.length === 0;
    });
    const relatedIds = [
      region.cell.id,
      ...directMembers,
      ...region.nestedRegionCellIds,
      ...region.nearBoundaryLabels.map((item) => item.id),
      ...region.boundaryCellIds
    ];
    const uniqueRelatedIds = Array.from(new Set(relatedIds));
    const label = region.ownLabel || region.nearBoundaryLabels[0]?.label || "Unlabelled region";
    findings.push({
      ruleId: "spatial-region.candidate",
      severity: region.confidence === "low" ? "warning" : "info",
      message: `Detected a ${region.confidence}-confidence spatial region candidate (“${label}”) with ${directMembers.length} direct member(s). This is a read-only finding; the layout engine will not preserve the region as a unit yet.`,
      pageId,
      cellIds: uniqueRelatedIds.slice(0, MAX_FINDING_CELL_IDS),
      details: {
        label,
        confidence: region.confidence,
        enclosedMemberCount: directMembers.length,
        nestedRegionCount: region.nestedRegionCellIds.length,
        boundaryCellCount: region.boundaryCellIds.length,
        overlappingRegionCount: region.overlapsRegionCellIds.length,
        probableBoundaryLabels: region.nearBoundaryLabels.map((item) => item.label).join(" | "),
        areaToTypicalNodeRatio: Math.round(region.areaRatio * 100) / 100,
        cellIdsTruncated: uniqueRelatedIds.length > MAX_FINDING_CELL_IDS
      }
    });
    if (region.overlapsRegionCellIds.length) {
      findings.push({
        ruleId: "spatial-region.overlap-ambiguous",
        severity: "warning",
        message: "Spatial region candidates overlap without a clear containment hierarchy; automatic membership assignment would be ambiguous.",
        pageId,
        cellIds: [region.cell.id, ...region.overlapsRegionCellIds],
        details: { overlapCount: region.overlapsRegionCellIds.length }
      });
    }
    if (region.boundaryCellIds.length) {
      findings.push({
        ruleId: "spatial-region.boundary-elements",
        severity: "info",
        message: "One or more nodes intersect this region boundary without being fully contained; keep them explicit as boundary elements.",
        pageId,
        cellIds: [region.cell.id, ...region.boundaryCellIds],
        details: { boundaryCellCount: region.boundaryCellIds.length }
      });
    }
  }

  const ambiguousMemberships = new Set<string>();
  for (const cell of cells) {
    if (cell.kind !== "vertex" || isTextLike(cell)) continue;
    const containing = regions.filter((region) =>
      region.cell.parentId === cell.parentId &&
      containsCenter(region.cell, cell) &&
      containmentRatio(region.cell, cell) >= FULL_CONTAINMENT_RATIO
    );
    for (let i = 0; i < containing.length; i += 1) {
      for (let j = i + 1; j < containing.length; j += 1) {
        const a = containing[i];
        const b = containing[j];
        if (!areDisjointOrNested(a.cell, b.cell)) ambiguousMemberships.add(cell.id);
      }
    }
  }
  if (ambiguousMemberships.size) {
    findings.push({
      ruleId: "spatial-region.membership-ambiguous",
      severity: "warning",
      message: "Some nodes are inside overlapping region candidates; no single region assignment should be inferred.",
      pageId,
      cellIds: Array.from(ambiguousMemberships).slice(0, MAX_FINDING_CELL_IDS),
      details: { ambiguousCellCount: ambiguousMemberships.size }
    });
  }
  return findings;
}

function analyze(context: NativeDiagramCapabilityContext, request: unknown): NativeDiagramAnalysisResponse {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return { status: "invalid", message: "Spatial region analysis requires a request object with documentRevision and pageId." };
  }
  const requested = request as { documentRevision?: unknown; pageId?: unknown };
  if (typeof requested.documentRevision !== "string" ||
      !(typeof requested.pageId === "string" || requested.pageId === null)) {
    return { status: "invalid", message: "Spatial region analysis requires a string documentRevision and a string-or-null pageId." };
  }
  if (!context.documentXml.trim()) {
    return { status: "invalid", message: "The source Draw.io XML is empty." };
  }
  if (requested.documentRevision !== context.documentRevision || requested.pageId !== context.pageId) {
    return { status: "stale", message: "Spatial region analysis request no longer matches the document revision or active page." };
  }
  try {
    const findings = detectRegions(context.documentXml, context.pageId);
    return {
      status: "analyzed",
      result: {
        capabilityId: SPATIAL_REGION_ANALYSIS_ID,
        apiVersion: 1,
        documentRevision: context.documentRevision,
        pageId: context.pageId,
        findings
      }
    };
  } catch (error) {
    return {
      status: "invalid",
      message: error instanceof Error ? error.message : "Could not analyze the selected Draw.io page."
    };
  }
}
