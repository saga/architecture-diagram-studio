import dagre from "@dagrejs/dagre";
import ELK from "elkjs/lib/elk.bundled.js";
import { calculateAdditionalNativeLayout, type AdditionalLayoutEngine } from "./additional-layout-engines";
import { parseDrawioXml } from "../model/drawio-xml-dom";
import { decodeDrawioPageXml } from "../model/drawio-xml-schema";
import { detectSpatialRegionsForLayout, type SpatialRegionLayoutCandidate } from "./spatial-region-analysis";
import { isOrthogonalRouteClear, routeOrthogonalAvoidingObstacles } from "./orthogonal-router";

export const NATIVE_AUTO_LAYOUT_ENGINES = ["elk", "dagre", "graphviz", "msagl", "cytoscape", "d3"] as const;
export type NativeAutoLayoutEngine = (typeof NATIVE_AUTO_LAYOUT_ENGINES)[number];
export const NATIVE_AUTO_LAYOUT_ALGORITHMS = [
  "layered", "mrtree", "radial", "stress", "force", "box", "fixed", "rectpacking", "random", "sporeCompaction", "sporeOverlap",
  "dot", "neato", "fdp", "sfdp", "circo", "twopi",
  "mds", "ipsepcola",
  "breadthfirst", "circle", "concentric", "grid", "cose", "fcose",
  "tree", "cluster"
] as const;
export type NativeAutoLayoutAlgorithm = (typeof NATIVE_AUTO_LAYOUT_ALGORITHMS)[number];

// These algorithms depend on graph connectivity; with zero source connectors they otherwise
// arbitrarily repack isolated components. Explicit spatial/packing algorithms still run.
const NO_EDGE_GRAPH_LAYOUT_ALGORITHMS = new Set<NativeAutoLayoutAlgorithm>(["layered", "dot", "tree", "cluster", "breadthfirst"]);

export const NATIVE_LAYOUT_ALGORITHMS_BY_ENGINE: Record<NativeAutoLayoutEngine, Array<{ value: NativeAutoLayoutAlgorithm; label: string }>> = {
  elk: [
    { value: "layered", label: "Layered · flow" }, { value: "mrtree", label: "Mr. Tree" },
    { value: "radial", label: "Radial" }, { value: "stress", label: "Stress · relationships" },
    { value: "force", label: "Force · organic" },
    { value: "box", label: "Box packing" }, { value: "fixed", label: "Fixed · retain node positions" },
    { value: "rectpacking", label: "Rectangle packing" },
    { value: "random", label: "Randomizer" },
    { value: "sporeCompaction", label: "SPOrE · compact" },
    { value: "sporeOverlap", label: "SPOrE · remove overlap" }
  ],
  dagre: [{ value: "layered", label: "Layered · flow" }],
  graphviz: [
    { value: "dot", label: "dot · hierarchical" }, { value: "neato", label: "neato · spring model" },
    { value: "fdp", label: "fdp · force-directed" }, { value: "sfdp", label: "sfdp · large graphs" },
    { value: "circo", label: "circo · circular" }, { value: "twopi", label: "twopi · radial" }
  ],
  msagl: [
    { value: "layered", label: "Sugiyama · layered" }, { value: "mds", label: "MDS · distance-based" },
    { value: "ipsepcola", label: "IPSepCola · separation" }
  ],
  cytoscape: [
    { value: "breadthfirst", label: "Breadth-first" }, { value: "circle", label: "Circle" },
    { value: "concentric", label: "Concentric" }, { value: "grid", label: "Grid" },
    { value: "random", label: "Random" }, { value: "cose", label: "CoSE force-directed" },
    { value: "fcose", label: "fCoSE · fast compound force" }
  ],
  d3: [
    { value: "tree", label: "Tree" }, { value: "cluster", label: "Cluster" },
    { value: "force", label: "Force simulation" }
  ]
};

export function nativeLayoutAlgorithmsForEngine(engine: NativeAutoLayoutEngine) {
  return NATIVE_LAYOUT_ALGORITHMS_BY_ENGINE[engine];
}

export function defaultNativeLayoutAlgorithm(engine: NativeAutoLayoutEngine): NativeAutoLayoutAlgorithm {
  switch (engine) {
    case "dagre": return "layered";
    case "graphviz": return "dot";
    case "msagl": return "layered";
    case "cytoscape": return "breadthfirst";
    case "d3": return "tree";
    case "elk": return "layered";
  }
}

export function nativeLayoutSupportsAlgorithm(engine: NativeAutoLayoutEngine, algorithm: NativeAutoLayoutAlgorithm): boolean {
  return NATIVE_LAYOUT_ALGORITHMS_BY_ENGINE[engine].some((item) => item.value === algorithm);
}

export function nativeLayoutSupportsDirection(engine: NativeAutoLayoutEngine, algorithm: NativeAutoLayoutAlgorithm): boolean {
  if (engine === "elk") return !["box", "fixed", "rectpacking", "random", "sporeCompaction", "sporeOverlap"].includes(algorithm);
  // Non-layered adapters without a native direction setting use the shared coordinate transform.
  return true;
}
export type NativeAutoLayoutDirection = "RIGHT" | "LEFT" | "DOWN" | "UP";
export type NativeAutoLayoutEdgeRouting = "ORTHOGONAL" | "POLYLINE" | "SPLINES";

export interface NativeAutoLayoutOptions {
  engine: NativeAutoLayoutEngine;
  algorithm: NativeAutoLayoutAlgorithm;
  direction: NativeAutoLayoutDirection;
  /** Keep confidently adjacent, uncontained nodes together as a transient layout cluster. */
  preserveLocalGrouping: boolean;
  /** Keep the final native content bounding box anchored to the source bounding box's top-left. */
  preserveCanvasOrigin: boolean;
  /** Preserve relative geometry among the explicitly selected anchor cells while allowing the set to move. */
  preserveRelativeAnchors: boolean;
  nodeSpacing: number;
  layerSpacing: number;
  edgeRouting: NativeAutoLayoutEdgeRouting;
  iterations: number;
  randomSeed: number;
  margin: number;
}

export const DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS: NativeAutoLayoutOptions = {
  engine: "elk",
  algorithm: "layered",
  direction: "RIGHT",
  preserveLocalGrouping: true,
  preserveCanvasOrigin: false,
  preserveRelativeAnchors: true,
  nodeSpacing: 64,
  layerSpacing: 90,
  edgeRouting: "ORTHOGONAL",
  iterations: 300,
  randomSeed: 1,
  margin: 30
};

/** Named spacing presets map to the existing engine-independent spacing controls. */
export const NATIVE_LAYOUT_DENSITY_PRESETS = {
  COMPACT: { nodeSpacing: 40, layerSpacing: 60 },
  BALANCED: { nodeSpacing: 64, layerSpacing: 90 },
  SPACIOUS: { nodeSpacing: 96, layerSpacing: 140 }
} as const;
export type NativeLayoutDensity = keyof typeof NATIVE_LAYOUT_DENSITY_PRESETS;
export type NativeLayoutDensitySelection = NativeLayoutDensity | "CUSTOM";

export function nativeLayoutDensityForSpacing(nodeSpacing: number, layerSpacing: number): NativeLayoutDensitySelection {
  const preset = Object.entries(NATIVE_LAYOUT_DENSITY_PRESETS).find(([, spacing]) =>
    spacing.nodeSpacing === nodeSpacing && spacing.layerSpacing === layerSpacing
  );
  return (preset?.[0] as NativeLayoutDensity | undefined) ?? "CUSTOM";
}

export interface NativeLayoutPosition {
  cellId: string;
  x: number;
  y: number;
}

export interface NativeLayoutEdgeRoute {
  cellId: string;
  points: Array<{ x: number; y: number }>;
}

export interface NativeLayoutExpectedCell {
  cellId: string;
  kind: "vertex" | "edge";
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
  sourceId: string | null;
  targetId: string | null;
}

export interface NativeLayoutCoverage {
  sourceVertexCount: number;
  plannedVertexCount: number;
  untouchedVertexCount: number;
  nestedVertexCount: number;
  verticesInOtherLayersCount: number;
  hiddenVertexCount: number;
  verticesWithoutGeometryCount: number;
  sourceEdgeCount: number;
  plannedEdgeCount: number;
  untouchedEdgeCount: number;
  edgesOutsideLayoutLayerCount: number;
  hiddenEdgeCount: number;
  edgesWithoutGeometryCount: number;
  edgesMissingTerminalsCount: number;
  edgesWithEndpointsOutsideTargetVerticesCount: number;
  connectorsAttachedToNestedChildrenCount: number;
  edgesWithinSameGroupUntouchedCount: number;
  spatialRegionCount: number;
  spatialRegionMemberCount: number;
  spatialRegionBoundaryVertexCount: number;
  spatialRegionCandidatesSkippedCount: number;
  spatialRegionInternalEdgeCount: number;
  spatialRegionInternalEdgesTranslatedCount: number;
  /** Transient proximity clusters used to preserve non-container local groupings. */
  spatialAdjacencyClusterCount: number;
  spatialAdjacencyClusterMemberCount: number;
  spatialAdjacencyInternalEdgeCount: number;
  spatialAdjacencyInternalEdgesTranslatedCount: number;
  /** Vertices fully enclosed by a container that was not recognised as a region, so containment is not preserved. */
  spatialRegionUnownedContainedVertexCount: number;
  /** Non-zero when the page had no connectors at all and the plan therefore retained the source
   * coordinates instead of letting an engine pack isolated components in an arbitrary order. */
  sourceCoordinatesRetainedVertexCount: number;
}

export type NativeRelativeAnchorOutcome = "not-requested" | "applied" | "degraded";
export interface NativeRelativeAnchorDiagnostics {
  outcome: NativeRelativeAnchorOutcome;
  requestedAnchorCount: number;
  resolvedAnchorCount: number;
  effectiveAnchorUnitCount: number;
  evaluatedPairCount: number;
  maximumVectorDrift: number;
  meanVectorDrift: number;
  toleranceBandPx: number;
  toleranceViolationCount: number;
  directionalOrderViolations: number;
  refinementIterations: number;
  collisionAdjustments: number;
}

export interface NativeLayoutPlan extends NativeAutoLayoutOptions {
  /** Per-run native cell IDs selected for relative anchoring; never stored as user preferences. */
  anchorCellIds: string[];
  /** Measured result of the relative-anchor stability pass. */
  anchorDiagnostics: NativeRelativeAnchorDiagnostics;
  /** Native page scope so the UI can report what will change and what remains untouched. */
  coverage: NativeLayoutCoverage;
  documentRevision: string;
  pageId: string | null;
  /** The single visible native layer targeted by this plan, resolved from the native cell tree. */
  layoutLayerId: string | null;
  /** True when only an unambiguous populated fallback layer could be selected. */
  layoutLayerFallback: boolean;
  /** Every native cell ID on the source page, used for an optimistic stale-page check. */
  expectedPageCellIds: string[];
  /** Vertices that a container geometrically encloses but no region owns, so the plan is free to
   * move them out. Surfaced separately from the coverage counter so a diagnostic can name them. */
  unownedContainedVertexCellIds: string[];
  /** Pre-mutation geometry and terminals for all cells used by this plan. */
  expectedCells: NativeLayoutExpectedCell[];
  positions: NativeLayoutPosition[];
  edgeRoutes: NativeLayoutEdgeRoute[];
}

interface ProjectedCell {
  id: string;
  parentId: string | null;
  sourceId: string | null;
  targetId: string | null;
  /** Layout-only terminal proxies; sourceId/targetId always retain native XML terminals. */
  layoutSourceId?: string | null;
  layoutTargetId?: string | null;
  kind: "vertex" | "edge" | "other";
  x: number;
  y: number;
  width: number;
  height: number;
  hasGeometry: boolean;
  visible: boolean;
  points: Point[];
}

interface SpatialAdjacencyAxisTransform {
  axis: "X_TO_Y" | "Y_TO_X";
  /** Source and target centre coordinates for piecewise mapping along the group row/column. */
  anchors: Array<{ source: number; target: number }>;
  sourceCrossCenter: number;
  targetCrossCenter: number;
  /** Sign of the cross-axis coordinate when mapping the source row/column to the target axis. */
  crossSign: 1 | -1;
}

interface SpatialAdjacencyLayoutCluster {
  /** Layout-only proxy; it is never a native Draw.io cell or a plan mutation target. */
  proxy: ProjectedCell;
  memberCellIds: string[];
  /** Member top-left offsets in the cluster's direction-oriented local coordinate space. */
  memberOffsets: Array<{ cellId: string; x: number; y: number }>;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Present only when a clearly linear row/column is reflowed for the requested axis. */
  axisTransform: SpatialAdjacencyAxisTransform | null;
}

interface NativePageProjection {
  pageId: string | null;
  pageTitle: string | null;
  allCellIds: string[];
  rootCellId: string | null;
  layoutLayerId: string | null;
  layoutLayerFallback: boolean;
  visibleLayerSummaries: Array<{ id: string; vertexCount: number; edgeCount: number }>;
  sourceVertexCount: number;
  sourceVertexWithGeometryCount: number;
  verticesWithNonLayerParents: number;
  nestedVertexCount: number;
  verticesInOtherLayersCount: number;
  hiddenVertexCount: number;
  sourceEdgeCount: number;
  sourceEdgeWithGeometryCount: number;
  edgesOutsideLayoutLayerCount: number;
  hiddenEdgeCount: number;
  edgesMissingTerminalsCount: number;
  edgesWithEndpointsOutsideTargetVerticesCount: number;
  /** Native vertices whose own positions are written to the Draw.io geometry plan. */
  vertices: ProjectedCell[];
  /** Solver input: native vertices plus any transient geometry-only grouping proxies. */
  layoutVertices: ProjectedCell[];
  /** Eligible geometry-only regions are transient proxy nodes; their member cells move by the same delta. */
  spatialRegions: SpatialRegionLayoutCandidate[];
  /** Nearby siblings grouped for this layout only; source XML ancestry is never modified. */
  spatialAdjacencyClusters: SpatialAdjacencyLayoutCluster[];
  spatialAdjacencyClusterMemberCount: number;
  adjacencyInternalEdges: ProjectedCell[];
  spatialRegionCandidateCount: number;
  spatialRegionCandidatesSkippedCount: number;
  spatialRegionMemberCount: number;
  spatialRegionBoundaryVertexCount: number;
  spatialRegionUnownedContainedVertexCount: number;
  /** The vertices behind that count, so a diagnostic can name them instead of only counting them. */
  spatialRegionUnownedContainedVertexCellIds: string[];
  /** All source cells are transient input to resolve native and inferred nested terminals. */
  allCells: ProjectedCell[];
  edges: ProjectedCell[];
  regionInternalEdges: ProjectedCell[];
  connectorsAttachedToNestedChildrenCount: number;
  edgesWithinSameGroupUntouchedCount: number;
}

interface Point { x: number; y: number }

interface ElkLayoutResult {
  children?: Array<{ id: string; x?: number; y?: number }>;
  edges?: Array<{ id: string; sections?: Array<{ bendPoints?: Point[] }> }>;
}

// Explicitly register optional algorithms verified in the bundled elkjs build.
// Box, Fixed and Random are always included; SPOrE and Rectangle Packing require registration.
const elk = new ELK({
  algorithms: ["layered", "stress", "mrtree", "radial", "force", "rectpacking", "sporeCompaction", "sporeOverlap"]
});

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

function parseGraphModel(xml: string, requestedPageId: string | null): { model: Document; pageId: string | null; pageTitle: string | null; bareModel: boolean } {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  // A bare mxGraphModel has no <diagram> envelope, so its page ID exists only in the live
  // Draw.io runtime. Callers resolve it with inspectRuntime before requesting a plan; echo
  // the requested ID back so the native plugin's plan.pageId check matches the live page.
  // Passing null stays unchanged for callers that have not confirmed a runtime page ID.
  if (root.nodeName === "mxGraphModel") return { model: document, pageId: requestedPageId, pageTitle: null, bareModel: true };
  if (root.nodeName !== "mxfile") throw new Error("Auto layout only supports native Draw.io mxfile or mxGraphModel documents.");

  const diagrams = Array.from(document.getElementsByTagName("diagram"));
  // A missing page ID is only resolvable when the document has exactly one page.
  // Never treat XML order as a substitute for the active page selected in Draw.io.
  const page = requestedPageId !== null
    ? diagrams.find((candidate) => candidate.getAttribute("id") === requestedPageId)
    : diagrams.length === 1 ? diagrams[0] : undefined;
  if (!page) {
    throw new Error(requestedPageId !== null
      ? "The selected Draw.io page no longer exists. Select the page again before laying it out."
      : diagrams.length > 1
        ? "The Draw.io document has multiple pages but no active page ID; refusing to lay out the first page."
        : "The Draw.io document has no pages to lay out.");
  }

  const inlineModel = page.getElementsByTagName("mxGraphModel").item(0);
  if (inlineModel) {
    return {
      model: inlineModel as unknown as Document,
      pageId: page.getAttribute("id") || null,
      pageTitle: page.getAttribute("name") || null,
      bareModel: false
    };
  }

  const payload = (page.textContent || "").trim();
  if (!payload) throw new Error("The selected Draw.io page has no readable graph model.");
  try {
    const nested = parseDrawioXml(decodeDrawioPageXml(payload));
    if (nested.documentElement.nodeName === "mxGraphModel") {
      return { model: nested, pageId: page.getAttribute("id") || null, pageTitle: page.getAttribute("name") || null, bareModel: false };
    }
  } catch {
    // The shared decoder enforces XML validity and the decompressed-page size limit.
  }
  throw new Error("The selected Draw.io page could not be decoded for layout. Open and save it with the bundled Draw.io editor, then retry.");
}

function spatialAdjacencyPairKey(first: string, second: string): string {
  return first < second
    ? first + String.fromCharCode(0) + second
    : second + String.fromCharCode(0) + first;
}

/**
 * Finds conservative spatial-neighbour clusters. A connector does not rule out a local
 * grouping when its endpoints were already very close; however, larger gaps are left to the
 * graph layout so ordinary directed flows can be rearranged. Complete-link merging prevents
 * a chain of individually close nodes from collapsing an entire flow into one cluster.
 */
function detectSpatialAdjacencyClusters(
  vertices: ProjectedCell[],
  allCells: ProjectedCell[],
  protectedCellIds: Set<string>,
  nodeSpacing: number,
  direction: NativeAutoLayoutDirection | null,
  preserveInternalGeometryCellIds: ReadonlySet<string>
): SpatialAdjacencyLayoutCluster[] {
  const candidates = vertices.filter((cell) =>
    !protectedCellIds.has(cell.id) && cell.kind === "vertex" && cell.visible &&
    cell.hasGeometry && cell.width > 0 && cell.height > 0
  );
  if (candidates.length < 2) return [];

  const existingIds = new Set(allCells.map((cell) => cell.id));
  const directlyConnectedPairs = new Set<string>();
  for (const edge of allCells) {
    if (edge.kind === "edge" && edge.sourceId && edge.targetId && edge.sourceId !== edge.targetId) {
      directlyConnectedPairs.add(spatialAdjacencyPairKey(edge.sourceId, edge.targetId));
    }
  }
  const gapBetween = (first: ProjectedCell, second: ProjectedCell): number => {
    const overlapX = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
    const overlapY = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
    // Existing overlap is a defect for the layout engine to repair, not evidence of a group.
    if (overlapX > 1 && overlapY > 1) return Number.POSITIVE_INFINITY;
    const gapX = Math.max(0, Math.max(first.x, second.x) - Math.min(first.x + first.width, second.x + second.width));
    const gapY = Math.max(0, Math.max(first.y, second.y) - Math.min(first.y + first.height, second.y + second.height));
    return Math.hypot(gapX, gapY);
  };
  const pairThreshold = (first: ProjectedCell, second: ProjectedCell): number =>
    Math.min(
      44,
      Math.max(12, nodeSpacing * 0.7),
      Math.max(12, Math.min(Math.max(first.width, first.height), Math.max(second.width, second.height)) * 0.5)
    );

  const pairDistances = new Map<string, number>();
  const candidatePairs: Array<{ first: number; second: number; gap: number }> = [];
  // Sweep in x order so distant node pairs are skipped instead of checking every O(n²) pair
  // on larger architecture diagrams. The threshold cap below matches pairThreshold's maximum.
  const candidatesByX = candidates.map((_, index) => index)
    .sort((first, second) => candidates[first].x - candidates[second].x || first - second);
  for (let firstPosition = 0; firstPosition < candidatesByX.length; firstPosition += 1) {
    const first = candidatesByX[firstPosition];
    const a = candidates[first];
    for (let secondPosition = firstPosition + 1; secondPosition < candidatesByX.length; secondPosition += 1) {
      const second = candidatesByX[secondPosition];
      const b = candidates[second];
      if (b.x - (a.x + a.width) > 44) break;
      const gap = gapBetween(a, b);
      if (!Number.isFinite(gap) || gap > pairThreshold(a, b)) continue;
      const directlyConnected = directlyConnectedPairs.has(spatialAdjacencyPairKey(a.id, b.id));
      if (directlyConnected && gap > Math.min(18, pairThreshold(a, b) * 0.75)) continue;
      pairDistances.set(spatialAdjacencyPairKey(a.id, b.id), gap);
      candidatePairs.push({ first: Math.min(first, second), second: Math.max(first, second), gap });
    }
  }
  if (candidatePairs.length === 0) return [];
  candidatePairs.sort((a, b) => a.gap - b.gap || a.first - b.first || a.second - b.second);

  // Complete-link clustering: every cross-pair must itself be a high-confidence neighbour.
  const components: number[][] = candidates.map((_, index) => [index]);
  for (const pair of candidatePairs) {
    const firstComponent = components.findIndex((component) => component.includes(pair.first));
    const secondComponent = components.findIndex((component) => component.includes(pair.second));
    if (firstComponent < 0 || secondComponent < 0 || firstComponent === secondComponent) continue;
    const left = components[firstComponent];
    const right = components[secondComponent];
    if (left.length + right.length > 8) continue;
    let canMerge = true;
    for (const leftIndex of left) {
      for (const rightIndex of right) {
        if (!pairDistances.has(spatialAdjacencyPairKey(candidates[leftIndex].id, candidates[rightIndex].id))) {
          canMerge = false;
          break;
        }
      }
      if (!canMerge) break;
    }
    if (!canMerge) continue;
    components[firstComponent] = left.concat(right).sort((a, b) => a - b);
    components.splice(secondComponent, 1);
  }

  const grouped = components.filter((component) => component.length >= 2)
    .sort((a, b) => a[0] - b[0]);
  const reservedIds = new Set(existingIds);
  const clusters: SpatialAdjacencyLayoutCluster[] = [];
  grouped.forEach((component, index) => {
    const members = component.map((memberIndex) => candidates[memberIndex]);
    const sourceLeft = Math.min(...members.map((member) => member.x));
    const sourceTop = Math.min(...members.map((member) => member.y));
    const sourceRight = Math.max(...members.map((member) => member.x + member.width));
    const sourceBottom = Math.max(...members.map((member) => member.y + member.height));
    const sourceWidth = sourceRight - sourceLeft;
    const sourceHeight = sourceBottom - sourceTop;
    const sourceCenterX = (sourceLeft + sourceRight) / 2;
    const sourceCenterY = (sourceTop + sourceBottom) / 2;
    const targetVertical = direction === "DOWN" || direction === "UP";
    const clearlyWide = sourceWidth > sourceHeight * 1.15;
    const clearlyTall = sourceHeight > sourceWidth * 1.15;
    const maxMemberWidth = Math.max(...members.map((member) => member.width));
    const maxMemberHeight = Math.max(...members.map((member) => member.height));
    const centerXValues = members.map((member) => member.x + member.width / 2);
    const centerYValues = members.map((member) => member.y + member.height / 2);
    const horizontalCenterCoordinatesAreDistinct = new Set(centerXValues.map((value) => Math.round(value * 1000))).size === members.length;
    const verticalCenterCoordinatesAreDistinct = new Set(centerYValues.map((value) => Math.round(value * 1000))).size === members.length;
    // Explicitly anchored members retain their local offsets for this run; rotating/reflowing
    // the inferred cluster would contradict the user's selected relative-geometry constraint.
    const hasAnchoredMember = members.some((member) => preserveInternalGeometryCellIds.has(member.id));
    const reflowRowToColumn = !hasAnchoredMember && direction !== null && targetVertical && clearlyWide &&
      sourceHeight <= maxMemberHeight * 1.3 && horizontalCenterCoordinatesAreDistinct;
    const reflowColumnToRow = !hasAnchoredMember && direction !== null && !targetVertical && clearlyTall &&
      sourceWidth <= maxMemberWidth * 1.3 && verticalCenterCoordinatesAreDistinct;
    let oriented: Array<{ cellId: string; x: number; y: number; width: number; height: number }>;
    let axisTransform: SpatialAdjacencyAxisTransform | null = null;

    if (reflowRowToColumn) {
      const ordered = [...members].sort((a, b) => {
        const difference = (a.x + a.width / 2) - (b.x + b.width / 2);
        return (direction === "DOWN" ? difference : -difference) || a.id.localeCompare(b.id);
      });
      const gaps = ordered.slice(1).map((member, index) => Math.max(0, gapBetween(ordered[index], member)));
      const totalHeight = ordered.reduce((sum, member) => sum + member.height, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
      let top = sourceCenterY - totalHeight / 2;
      oriented = ordered.map((member, index) => {
        const result = { cellId: member.id, x: sourceCenterX - member.width / 2, y: top, width: member.width, height: member.height };
        top += member.height + (gaps[index] ?? 0);
        return result;
      });
      axisTransform = {
        axis: "X_TO_Y",
        anchors: members.map((member) => ({
          source: member.x + member.width / 2,
          target: oriented.find((item) => item.cellId === member.id)!.y + member.height / 2
        })).sort((a, b) => a.source - b.source),
        sourceCrossCenter: sourceCenterY,
        targetCrossCenter: sourceCenterX,
        crossSign: direction === "DOWN" ? -1 : 1
      };
    } else if (reflowColumnToRow) {
      const ordered = [...members].sort((a, b) => {
        const difference = (a.y + a.height / 2) - (b.y + b.height / 2);
        return (direction === "RIGHT" ? difference : -difference) || a.id.localeCompare(b.id);
      });
      const gaps = ordered.slice(1).map((member, index) => Math.max(0, gapBetween(ordered[index], member)));
      const totalWidth = ordered.reduce((sum, member) => sum + member.width, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
      let left = sourceCenterX - totalWidth / 2;
      oriented = ordered.map((member, index) => {
        const result = { cellId: member.id, x: left, y: sourceCenterY - member.height / 2, width: member.width, height: member.height };
        left += member.width + (gaps[index] ?? 0);
        return result;
      });
      axisTransform = {
        axis: "Y_TO_X",
        anchors: members.map((member) => ({
          source: member.y + member.height / 2,
          target: oriented.find((item) => item.cellId === member.id)!.x + member.width / 2
        })).sort((a, b) => a.source - b.source),
        sourceCrossCenter: sourceCenterX,
        targetCrossCenter: sourceCenterY,
        crossSign: direction === "RIGHT" ? -1 : 1
      };
    } else {
      oriented = members.map((member) => ({
        cellId: member.id, x: member.x, y: member.y, width: member.width, height: member.height
      }));
    }
    const x = Math.min(...oriented.map((member) => member.x));
    const y = Math.min(...oriented.map((member) => member.y));
    const right = Math.max(...oriented.map((member) => member.x + member.width));
    const bottom = Math.max(...oriented.map((member) => member.y + member.height));
    const width = right - x;
    const height = bottom - y;
    let proxyId = "__studio_spatial_cluster_" + (index + 1) + "__";
    while (reservedIds.has(proxyId)) proxyId += "_";
    reservedIds.add(proxyId);
    const proxy: ProjectedCell = {
      ...members[0],
      id: proxyId,
      sourceId: null,
      targetId: null,
      layoutSourceId: null,
      layoutTargetId: null,
      x, y, width, height,
      kind: "vertex",
      hasGeometry: true,
      visible: true,
      points: []
    };
    clusters.push({
      proxy,
      memberCellIds: members.map((member) => member.id),
      memberOffsets: oriented.map((member) => ({ cellId: member.cellId, x: member.x - x, y: member.y - y })),
      x, y, width, height, axisTransform
    });
  });
  return clusters;
}

function mapSpatialAdjacencyPoint(cluster: SpatialAdjacencyLayoutCluster, point: Point): Point {
  const transform = cluster.axisTransform;
  if (!transform) return point;
  const anchors = transform.anchors;
  if (anchors.length === 0) return point;
  const value = transform.axis === "X_TO_Y" ? point.x : point.y;
  let left = anchors[0];
  let right = anchors[anchors.length - 1];
  if (value <= anchors[0].source) {
    left = anchors[0];
    right = anchors.find((anchor) => anchor.source > left.source) ?? left;
  } else if (value >= anchors[anchors.length - 1].source) {
    right = anchors[anchors.length - 1];
    left = [...anchors].reverse().find((anchor) => anchor.source < right.source) ?? right;
  } else {
    for (let index = 1; index < anchors.length; index += 1) {
      if (value <= anchors[index].source) {
        left = anchors[index - 1];
        right = anchors[index];
        break;
      }
    }
  }
  const span = right.source - left.source;
  const ratio = Math.abs(span) < 1e-6 ? 0.5 : (value - left.source) / span;
  const along = left.target + (right.target - left.target) * ratio;
  if (transform.axis === "X_TO_Y") {
    return {
      x: transform.targetCrossCenter + transform.crossSign * (point.y - transform.sourceCrossCenter),
      y: along
    };
  }
  return {
    x: along,
    y: transform.targetCrossCenter + transform.crossSign * (point.x - transform.sourceCrossCenter)
  };
}

function projectNativePage(
  xml: string,
  requestedPageId: string | null,
  preserveLocalGrouping: boolean,
  nodeSpacing: number,
  direction: NativeAutoLayoutDirection | null,
  preserveInternalGeometryCellIds: ReadonlySet<string>
): NativePageProjection {
  const parsed = parseGraphModel(xml, requestedPageId);
  const cells = Array.from(parsed.model.getElementsByTagName("mxCell")) as Element[];
  const byId = new Map<string, ProjectedCell>();
  const seenCellIds = new Set<string>();

  for (const cell of cells) {
    const id = effectiveCellId(cell);
    if (!id) continue;
    const vertex = cell.getAttribute("vertex") === "1";
    const edge = cell.getAttribute("edge") === "1";
    const geometry = directChild(cell, "mxGeometry");
    const x = Number(geometry?.getAttribute("x") ?? 0);
    const y = Number(geometry?.getAttribute("y") ?? 0);
    const width = Number(geometry?.getAttribute("width") ?? 0);
    const height = Number(geometry?.getAttribute("height") ?? 0);
    const pointsArray = geometry ? directChild(geometry, "Array") : null;
    const points = pointsArray?.getAttribute("as") === "points"
      ? elementChildren(pointsArray).filter((point) => point.nodeName === "mxPoint").map((point) => ({
          x: Number(point.getAttribute("x") ?? 0),
          y: Number(point.getAttribute("y") ?? 0)
        })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : [];
    const projected: ProjectedCell = {
      id,
      parentId: cell.getAttribute("parent") || null,
      sourceId: cell.getAttribute("source") || null,
      targetId: cell.getAttribute("target") || null,
      kind: vertex ? "vertex" : edge ? "edge" : "other",
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
      hasGeometry: Boolean(geometry),
      visible: cell.getAttribute("visible") !== "0",
      points
    };
    // Draw.io wrappers may expose both a wrapper ID and an mxCell ID. The active mxGraph
    // model resolves a cell by its effective ID, which is the wrapper ID when present.
    byId.set(id, projected);
    seenCellIds.add(id);
  }

  const all = Array.from(byId.values());

  // IDs are opaque references, not semantic roles. Root and layer roles come only from
  // the native parent/child structure; ambiguous structures must not be resolved by ID or XML order.
  const rootCellCandidates = all.filter((cell) =>
    cell.parentId === null && cell.kind === "other" && !cell.hasGeometry
  );
  const rootCell = rootCellCandidates.length === 1 ? rootCellCandidates[0] : null;
  const rootCellId = rootCell?.id ?? null;
  const rootLayers = rootCellId
    ? all.filter((cell) =>
        cell.parentId === rootCellId &&
        cell.kind === "other" &&
        !cell.hasGeometry &&
        cell.visible
      )
    : [];

  // Use a sole visible layer when unambiguous. If there are several layers, a sole populated
  // layer may be selected below; never prefer a layer because its ID is "1".
  let layoutLayer = rootLayers.length === 1 ? rootLayers[0] : null;
  let layoutLayerFallback = false;

  const eligibleVerticesForLayer = (layerId: string | null): ProjectedCell[] => {
    if (!layerId) return [];
    return all.filter((cell) =>
      cell.kind === "vertex" &&
      cell.hasGeometry &&
      cell.parentId === layerId &&
      cell.visible &&
      cell.width > 0 &&
      cell.height > 0
    );
  };
  const visibleLayerSummaries = rootLayers.map((layer) => ({
    id: layer.id,
    vertexCount: eligibleVerticesForLayer(layer.id).length,
    edgeCount: all.filter((cell) =>
      cell.kind === "edge" && cell.hasGeometry && cell.parentId === layer.id && cell.visible
    ).length
  }));

  let vertices = eligibleVerticesForLayer(layoutLayer?.id ?? null);
  if (vertices.length === 0) {
    // Some valid files keep the default layer empty and place the entire diagram on one
    // named layer. Supporting that unambiguous case avoids a false "no vertices" failure,
    // while refusing to guess when multiple other layers contain independent content.
    const populatedLayers = rootLayers.filter((layer) => eligibleVerticesForLayer(layer.id).length > 0);
    if (populatedLayers.length === 1 && populatedLayers[0].id !== layoutLayer?.id) {
      layoutLayer = populatedLayers[0];
      vertices = eligibleVerticesForLayer(layoutLayer.id);
      layoutLayerFallback = true;
    }
  }

  const layoutLayerId = layoutLayer?.id ?? null;
  const allById = new Map(all.map((cell) => [cell.id, cell] as const));
  const rawVertexIds = new Set(vertices.map((cell) => cell.id));
  // Spatial region detection keeps the null page convention for a bare mxGraphModel:
  // it reads the model directly and has no envelope page to resolve.
  const regionDetection = detectSpatialRegionsForLayout(xml, parsed.bareModel ? null : parsed.pageId);
  const candidatesForLayer = regionDetection.candidates.filter((candidate) =>
    allById.get(candidate.regionCellId)?.parentId === layoutLayerId
  );
  const spatialRegions = candidatesForLayer.filter((candidate) =>
    candidate.eligible &&
    rawVertexIds.has(candidate.regionCellId) &&
    candidate.memberCellIds.every((memberId) =>
      rawVertexIds.has(memberId) && allById.get(memberId)?.parentId === layoutLayerId
    )
  );
  const spatialRegionMemberIds = new Set(spatialRegions.flatMap((region) => region.memberCellIds));
  const regionOwnerByMemberId = new Map<string, string>();
  for (const region of spatialRegions) {
    for (const memberId of region.memberCellIds) regionOwnerByMemberId.set(memberId, region.regionCellId);
  }
  // Region boundaries and all candidate members are protected from proximity inference; region
  // recognition remains the stronger, more explicit grouping signal.
  const protectedRegionCellIds = new Set(candidatesForLayer.flatMap((candidate) => [
    candidate.regionCellId, ...candidate.boundaryCellIds, ...candidate.memberCellIds
  ]));
  // Region members are removed from the outer graph. The native siblings remain untouched in XML.
  vertices = vertices.filter((cell) => !spatialRegionMemberIds.has(cell.id));
  const hasSourceEdges = all.some((cell) => cell.kind === "edge");
  const spatialAdjacencyClusters = preserveLocalGrouping
    ? detectSpatialAdjacencyClusters(vertices, all, protectedRegionCellIds, nodeSpacing, hasSourceEdges ? direction : null, preserveInternalGeometryCellIds)
    : [];
  const spatialAdjacencyMemberIds = new Set(spatialAdjacencyClusters.flatMap((cluster) => cluster.memberCellIds));
  const adjacencyOwnerByMemberId = new Map<string, string>();
  for (const cluster of spatialAdjacencyClusters) {
    for (const memberId of cluster.memberCellIds) adjacencyOwnerByMemberId.set(memberId, cluster.proxy.id);
  }
  // Replace members with transient bounding-box proxies for the solver. The proxies are never
  // returned in NativeLayoutPlan.positions and can never be written into native Draw.io XML.
  vertices = vertices.filter((cell) => !spatialAdjacencyMemberIds.has(cell.id));
  const layoutVertices = [...vertices, ...spatialAdjacencyClusters.map((cluster) => cluster.proxy)];
  const vertexIds = new Set(layoutVertices.map((cell) => cell.id));
  const layoutOwnerForTerminal = (terminalId: string | null): string | null => {
    if (!terminalId) return null;
    let current = allById.get(terminalId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (!current.visible) return null;
      const inferredRegionOwner = regionOwnerByMemberId.get(current.id);
      if (inferredRegionOwner) return inferredRegionOwner;
      const inferredAdjacencyOwner = adjacencyOwnerByMemberId.get(current.id);
      if (inferredAdjacencyOwner) return inferredAdjacencyOwner;
      if (vertexIds.has(current.id)) return current.id;
      if (current.kind !== "vertex" || !current.hasGeometry || current.width <= 0 || current.height <= 0) return null;
      current = current.parentId ? allById.get(current.parentId) : undefined;
    }
    return null;
  };

  const rootLayerIds = new Set(rootLayers.map((layer) => layer.id));
  const sourceVertices = all.filter((cell) => cell.kind === "vertex");
  const sourceVertexIds = new Set(sourceVertices.map((cell) => cell.id));
  const sourceEdges = all.filter((cell) => cell.kind === "edge");
  const candidateEdges = sourceEdges.filter((cell) =>
    cell.hasGeometry &&
    cell.parentId === layoutLayerId &&
    cell.visible &&
    Boolean(cell.sourceId && cell.targetId)
  ).map((cell) => ({
    cell,
    layoutSourceId: layoutOwnerForTerminal(cell.sourceId),
    layoutTargetId: layoutOwnerForTerminal(cell.targetId)
  }));
  const regionInternalEdges = candidateEdges
    .filter(({ cell }) => {
      if (!cell.sourceId || !cell.targetId) return false;
      const sourceRegion = regionOwnerByMemberId.get(cell.sourceId);
      const targetRegion = regionOwnerByMemberId.get(cell.targetId);
      return Boolean(sourceRegion && targetRegion && sourceRegion === targetRegion);
    })
    .map(({ cell, layoutSourceId, layoutTargetId }) => ({ ...cell, layoutSourceId, layoutTargetId }));
  const regionInternalEdgeIds = new Set(regionInternalEdges.map((edge) => edge.id));
  const adjacencyInternalEdges = candidateEdges
    .filter(({ cell }) => {
      if (!cell.sourceId || !cell.targetId || regionInternalEdgeIds.has(cell.id)) return false;
      const sourceCluster = adjacencyOwnerByMemberId.get(cell.sourceId);
      const targetCluster = adjacencyOwnerByMemberId.get(cell.targetId);
      return Boolean(sourceCluster && targetCluster && sourceCluster === targetCluster);
    })
    .map(({ cell, layoutSourceId, layoutTargetId }) => ({ ...cell, layoutSourceId, layoutTargetId }));
  const adjacencyInternalEdgeIds = new Set(adjacencyInternalEdges.map((edge) => edge.id));
  const edgesWithinSameGroup = sourceEdges.filter((cell) => {
    if (regionInternalEdgeIds.has(cell.id) || adjacencyInternalEdgeIds.has(cell.id) || !cell.sourceId || !cell.targetId) return false;
    const sourceOwner = layoutOwnerForTerminal(cell.sourceId);
    const targetOwner = layoutOwnerForTerminal(cell.targetId);
    return Boolean(sourceOwner && targetOwner && sourceOwner === targetOwner) &&
      (cell.sourceId !== sourceOwner || cell.targetId !== targetOwner);
  });
  const edges: ProjectedCell[] = candidateEdges
    .filter(({ layoutSourceId, layoutTargetId, cell }) =>
      Boolean(layoutSourceId && layoutTargetId) &&
      !(layoutSourceId === layoutTargetId &&
        (cell.sourceId !== layoutSourceId || cell.targetId !== layoutTargetId)) &&
      !regionInternalEdgeIds.has(cell.id) &&
      !adjacencyInternalEdgeIds.has(cell.id)
    )
    .map(({ cell, layoutSourceId, layoutTargetId }) => ({
      ...cell,
      layoutSourceId,
      layoutTargetId
    }));
  const connectorsAttachedToNestedChildrenCount = edges.filter((edge) =>
    (edge.sourceId !== edge.layoutSourceId && !adjacencyOwnerByMemberId.has(edge.sourceId ?? "")) ||
    (edge.targetId !== edge.layoutTargetId && !adjacencyOwnerByMemberId.has(edge.targetId ?? ""))
  ).length;
  const spatialRegionBoundaryVertexCount = new Set(
    spatialRegions.flatMap((region) => region.boundaryCellIds).filter((id) => rawVertexIds.has(id))
  ).size;
  const unownedContainedVertexCellIds = regionDetection.unownedContainedVertexCellIds
    .filter((id) => rawVertexIds.has(id));
  return {
    pageId: parsed.pageId,
    pageTitle: parsed.pageTitle,
    allCellIds: Array.from(seenCellIds).sort(),
    rootCellId,
    layoutLayerId,
    layoutLayerFallback,
    visibleLayerSummaries,
    sourceVertexCount: sourceVertices.length,
    sourceVertexWithGeometryCount: sourceVertices.filter((cell) => cell.hasGeometry).length,
    verticesWithNonLayerParents: sourceVertices.filter((cell) => !rootLayerIds.has(cell.parentId ?? "")).length,
    nestedVertexCount: sourceVertices.filter((cell) => Boolean(cell.parentId && sourceVertexIds.has(cell.parentId))).length,
    verticesInOtherLayersCount: sourceVertices.filter((cell) =>
      rootLayerIds.has(cell.parentId ?? "") && cell.parentId !== layoutLayerId
    ).length,
    hiddenVertexCount: sourceVertices.filter((cell) => !cell.visible).length,
    sourceEdgeCount: sourceEdges.length,
    sourceEdgeWithGeometryCount: sourceEdges.filter((cell) => cell.hasGeometry).length,
    edgesOutsideLayoutLayerCount: sourceEdges.filter((cell) => cell.parentId !== layoutLayerId).length,
    hiddenEdgeCount: sourceEdges.filter((cell) => !cell.visible).length,
    edgesMissingTerminalsCount: sourceEdges.filter((cell) => !cell.sourceId || !cell.targetId).length,
    edgesWithEndpointsOutsideTargetVerticesCount: sourceEdges.filter((cell) => {
      if (!cell.sourceId || !cell.targetId) return false;
      if (cell.parentId !== layoutLayerId || !cell.visible || !cell.hasGeometry) return false;
      return !layoutOwnerForTerminal(cell.sourceId) || !layoutOwnerForTerminal(cell.targetId);
    }).length,
    vertices,
    layoutVertices,
    spatialRegions,
    spatialAdjacencyClusters,
    spatialAdjacencyClusterMemberCount: spatialAdjacencyMemberIds.size,
    adjacencyInternalEdges,
    spatialRegionCandidateCount: candidatesForLayer.length,
    spatialRegionCandidatesSkippedCount: candidatesForLayer.length - spatialRegions.length,
    spatialRegionMemberCount: spatialRegionMemberIds.size,
    spatialRegionBoundaryVertexCount,
    spatialRegionUnownedContainedVertexCount: unownedContainedVertexCellIds.length,
    spatialRegionUnownedContainedVertexCellIds: unownedContainedVertexCellIds,
    allCells: all,
    edges,
    regionInternalEdges,
    connectorsAttachedToNestedChildrenCount,
    edgesWithinSameGroupUntouchedCount: edgesWithinSameGroup.length
  };
}

function mapDirection(direction: NativeAutoLayoutDirection): "RIGHT" | "LEFT" | "DOWN" | "UP" {
  return direction;
}

// Layered and Mr.Tree honor "elk.direction" natively. The compiled elkjs STRESS/FORCE
// engines ignore it entirely (verified against the bundled ELK), and Radial is root-centric
// with no meaningful edge direction, so Stress and Force get a deterministic post-layout
// orientation emulation: align the dominant spread axis with the requested flow axis and
// mirror the result until the aggregated edge flow matches the selected direction.
const ELK_DIRECTION_AWARE_ALGORITHMS: ReadonlySet<NativeAutoLayoutAlgorithm> = new Set(["layered", "mrtree"]);

const ANISOTROPY_ROTATION_THRESHOLD = 2.5;

/** Deterministically orient an organic embedding toward the requested flow direction:
 * rotate the principal spread axis onto the flow axis when the embedding is clearly
 * anisotropic (e.g. a chain that STRESS lays out as a diagonal), then mirror until the
 * aggregated edge flow matches the direction. A pure coordinate transform on the plan:
 * node positions and connector bend points are transformed together; no model is rebuilt. */
export function emulateEmbeddedFlowDirection(
  positions: Map<string, Point>,
  routes: Map<string, Point[]>,
  vertices: ProjectedCell[],
  edges: ProjectedCell[],
  direction: NativeAutoLayoutDirection
): void {
  if (vertices.length === 0) return;
  const sizes = new Map<string, { width: number; height: number }>();
  const centers = new Map<string, Point>();
  for (const vertex of vertices) {
    const point = positions.get(vertex.id);
    if (!point) return; // The engine skipped a vertex; leave the raw embedding untouched.
    sizes.set(vertex.id, { width: vertex.width, height: vertex.height });
    centers.set(vertex.id, { x: point.x + vertex.width / 2, y: point.y + vertex.height / 2 });
  }

  const centerValues = Array.from(centers.values());
  const centroidX = centerValues.reduce((sum, point) => sum + point.x, 0) / centerValues.length;
  const centroidY = centerValues.reduce((sum, point) => sum + point.y, 0) / centerValues.length;
  const relOf = (point: Point): Point => ({ x: point.x - centroidX, y: point.y - centroidY });

  // Covariance of the node centers around their centroid: 0.5*atan2(2Cxy, Cxx-Cyy) is the
  // angle of the dominant eigenvector of this 2x2 symmetric matrix (the principal axis).
  const cXX = centerValues.reduce((sum, point) => sum + relOf(point).x ** 2, 0);
  const cYY = centerValues.reduce((sum, point) => sum + relOf(point).y ** 2, 0);
  const cXY = centerValues.reduce((sum, point) => sum + relOf(point).x * relOf(point).y, 0);
  const eigenRadius = Math.hypot((cXX - cYY) / 2, cXY);
  const lambda1 = (cXX + cYY) / 2 + eigenRadius;
  const lambda2 = (cXX + cYY) / 2 - eigenRadius;
  const horizontalFlow = direction === "RIGHT" || direction === "LEFT";
  const anisotropic = lambda1 > 0 && (lambda2 <= 0 || lambda1 / lambda2 >= ANISOTROPY_ROTATION_THRESHOLD);
  // Organic shapes without a dominant axis are only mirrored, never arbitrarily rotated.
  const rotation = anisotropic
    ? horizontalFlow
      ? -0.5 * Math.atan2(2 * cXY, cXX - cYY)
      : Math.PI / 2 - 0.5 * Math.atan2(2 * cXY, cXX - cYY)
    : 0;
  const rotateOnly = (point: Point): Point => ({
    x: point.x * Math.cos(rotation) - point.y * Math.sin(rotation),
    y: point.x * Math.sin(rotation) + point.y * Math.cos(rotation)
  });

  // The aggregated edge flow, measured in the rotated space, decides the mirroring signs.
  let flowX = 0;
  let flowY = 0;
  for (const edge of edges) {
    const sourceId = edge.layoutSourceId ?? edge.sourceId;
    const targetId = edge.layoutTargetId ?? edge.targetId;
    const source = sourceId ? centers.get(sourceId) : undefined;
    const target = targetId ? centers.get(targetId) : undefined;
    if (!source || !target) continue;
    const rotatedSource = rotateOnly(relOf(source));
    const rotatedTarget = rotateOnly(relOf(target));
    flowX += rotatedTarget.x - rotatedSource.x;
    flowY += rotatedTarget.y - rotatedSource.y;
  }
  const mirrorX = (direction === "RIGHT" && flowX < 0) || (direction === "LEFT" && flowX > 0);
  const mirrorY = (direction === "DOWN" && flowY < 0) || (direction === "UP" && flowY > 0);
  const signX = mirrorX ? -1 : 1;
  const signY = mirrorY ? -1 : 1;
  if (rotation === 0 && !mirrorX && !mirrorY) return;

  for (const [vertexId, center] of centers) {
    const transformed = rotateOnly(relOf(center));
    const size = sizes.get(vertexId)!;
    positions.set(vertexId, {
      x: centroidX + transformed.x * signX - size.width / 2,
      y: centroidY + transformed.y * signY - size.height / 2
    });
  }
  for (const [edgeId, points] of routes) {
    routes.set(edgeId, points.map((point) => {
      const transformed = rotateOnly(relOf(point));
      return { x: centroidX + transformed.x * signX, y: centroidY + transformed.y * signY };
    }));
  }
}

function describeEmptyLayoutScope(projection: NativePageProjection): string {
  const layers = projection.visibleLayerSummaries.length
    ? projection.visibleLayerSummaries.map((layer) =>
        layer.id + " (" + layer.vertexCount + " eligible vertices, " + layer.edgeCount + " edges)"
      ).join(", ")
    : "none";
  return "No top-level native Draw.io vertices with geometry were found on the active page. " +
    "XML inventory: " + projection.sourceVertexCount + " vertex cells, " +
    projection.sourceVertexWithGeometryCount + " with geometry, " +
    projection.verticesWithNonLayerParents + " with a parent outside visible root layers. " +
    "Nested Group children remain fixed relative to their parent and are not flattened into the outer layout. " +
    "Detected root cell: " + (projection.rootCellId ?? "none") + ". " +
    "Visible root layers: " + layers + ". Layout does not guess between multiple populated layers.";
}

function normalizePlan(
  projection: NativePageProjection,
  options: NativeAutoLayoutOptions,
  documentRevision: string,
  positions: Map<string, Point>,
  routes: Map<string, Point[]>,
  retainSourceCoordinates: boolean,
  anchorCellIds: string[],
  anchorDiagnostics: NativeRelativeAnchorDiagnostics
): NativeLayoutPlan {
  if (projection.layoutVertices.length === 0) {
    throw new Error("No top-level native Draw.io vertices with geometry were found on the active page. Nested group contents and nonstandard cells are intentionally left untouched.");
  }
  if (positions.size !== projection.layoutVertices.length ||
      projection.layoutVertices.some((vertex) => !positions.has(vertex.id))) {
    throw new Error("The layout engine did not return a position for every target vertex; no changes were applied.");
  }

  const minX = Math.min(...projection.layoutVertices.map((cell) => positions.get(cell.id)!.x));
  const minY = Math.min(...projection.layoutVertices.map((cell) => positions.get(cell.id)!.y));
  const preserveNativePositions = options.engine === "elk" && options.algorithm === "fixed";
  const cellsById = new Map(projection.allCells.map((cell) => [cell.id, cell] as const));

  // Compute bounds from actual native vertices, not just solver proxies. Region members and local
  // group members are written separately; boundary titles may also sit outside a container.
  const sourceNativePositionById = new Map<string, Point>();
  const finalNativePositionById = new Map<string, Point>();
  for (const cell of projection.vertices) {
    const point = positions.get(cell.id);
    if (!point) throw new Error("A native vertex was missing while normalizing the layout origin: " + cell.id);
    sourceNativePositionById.set(cell.id, { x: cell.x, y: cell.y });
    finalNativePositionById.set(cell.id, { x: point.x, y: point.y });
  }
  for (const cluster of projection.spatialAdjacencyClusters) {
    const proxyPosition = positions.get(cluster.proxy.id);
    if (!proxyPosition) throw new Error("A spatial adjacency cluster was missing while normalizing the layout origin.");
    for (const memberOffset of cluster.memberOffsets) {
      const member = cellsById.get(memberOffset.cellId);
      if (!member || member.kind !== "vertex" || !member.hasGeometry) {
        throw new Error("A spatial adjacency member was missing while normalizing the layout origin: " + memberOffset.cellId);
      }
      sourceNativePositionById.set(member.id, { x: member.x, y: member.y });
      finalNativePositionById.set(member.id, {
        x: proxyPosition.x + memberOffset.x,
        y: proxyPosition.y + memberOffset.y
      });
    }
  }
  for (const region of projection.spatialRegions) {
    const sourceRegion = cellsById.get(region.regionCellId);
    const finalRegion = positions.get(region.regionCellId);
    if (!sourceRegion || !finalRegion) {
      throw new Error("A detected spatial region was missing while normalizing the layout origin: " + region.regionCellId);
    }
    const delta = { x: finalRegion.x - sourceRegion.x, y: finalRegion.y - sourceRegion.y };
    for (const memberId of region.memberCellIds) {
      const member = cellsById.get(memberId);
      if (!member || member.kind !== "vertex" || !member.hasGeometry) {
        throw new Error("A spatial region member was missing while normalizing the layout origin: " + memberId);
      }
      sourceNativePositionById.set(member.id, { x: member.x, y: member.y });
      finalNativePositionById.set(member.id, { x: member.x + delta.x, y: member.y + delta.y });
    }
  }
  const sourceNativePoints = Array.from(sourceNativePositionById.values());
  const finalNativePoints = Array.from(finalNativePositionById.values());
  if (sourceNativePoints.length === 0 || finalNativePoints.length === 0) {
    throw new Error("No native content bounds were available while normalizing the layout origin.");
  }
  const nativeSourceMinX = Math.min(...sourceNativePoints.map((point) => point.x));
  const nativeSourceMinY = Math.min(...sourceNativePoints.map((point) => point.y));
  const nativeTargetMinX = Math.min(...finalNativePoints.map((point) => point.x));
  const nativeTargetMinY = Math.min(...finalNativePoints.map((point) => point.y));
  const preserveSourceCoordinates = retainSourceCoordinates || preserveNativePositions;
  // Default mode retains existing margin-based normalization. The opt-in mode keeps the source
  // content's top-left anchor while allowing relative node positions to change.
  const dx = preserveSourceCoordinates ? 0 : options.preserveCanvasOrigin
    ? nativeSourceMinX - nativeTargetMinX
    : options.margin - minX;
  const dy = preserveSourceCoordinates ? 0 : options.preserveCanvasOrigin
    ? nativeSourceMinY - nativeTargetMinY
    : options.margin - minY;
  const finiteCoordinate = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1_000_000;
  const routeAxisEpsilon = 0.5;
  const orthogonalizeRoute = (sourcePoints: Point[]): Point[] => {
    const result: Point[] = [];
    const append = (rawPoint: Point) => {
      const point = { x: rawPoint.x, y: rawPoint.y };
      const previous = result[result.length - 1];
      if (previous) {
        if (Math.abs(point.x - previous.x) <= routeAxisEpsilon) point.x = previous.x;
        if (Math.abs(point.y - previous.y) <= routeAxisEpsilon) point.y = previous.y;
        if (Math.abs(point.x - previous.x) <= routeAxisEpsilon &&
            Math.abs(point.y - previous.y) <= routeAxisEpsilon) return;
        if (result.length >= 2) {
          const before = result[result.length - 2];
          const middle = result[result.length - 1];
          const collinearHorizontally =
            Math.abs(before.y - middle.y) <= routeAxisEpsilon &&
            Math.abs(middle.y - point.y) <= routeAxisEpsilon &&
            (middle.x - before.x) * (point.x - middle.x) > 0;
          const collinearVertically =
            Math.abs(before.x - middle.x) <= routeAxisEpsilon &&
            Math.abs(middle.x - point.x) <= routeAxisEpsilon &&
            (middle.y - before.y) * (point.y - middle.y) > 0;
          if (collinearHorizontally || collinearVertically) result.pop();
        }
      }
      result.push(point);
    };

    for (const sourcePoint of sourcePoints) {
      const previous = result[result.length - 1];
      if (!previous) {
        append(sourcePoint);
        continue;
      }
      let point = { x: sourcePoint.x, y: sourcePoint.y };
      if (Math.abs(point.x - previous.x) <= routeAxisEpsilon) point.x = previous.x;
      if (Math.abs(point.y - previous.y) <= routeAxisEpsilon) point.y = previous.y;
      const deltaX = point.x - previous.x;
      const deltaY = point.y - previous.y;
      if (Math.abs(deltaX) > routeAxisEpsilon && Math.abs(deltaY) > routeAxisEpsilon) {
        // Keep the dominant axis as the long run and add only one right-angle bend.
        const elbow = Math.abs(deltaX) >= Math.abs(deltaY)
          ? { x: point.x, y: previous.y }
          : { x: previous.x, y: point.y };
        append(elbow);
      }
      append(point);
    }
    return result;
  };
  const nativePositions = projection.vertices.map((cell) => {
    const point = positions.get(cell.id)!;
    const x = point.x + dx;
    const y = point.y + dy;
    if (!finiteCoordinate(x) || !finiteCoordinate(y)) throw new Error("The layout engine returned an invalid node coordinate.");
    return { cellId: cell.id, x, y };
  });
  const finalTopLevelPositionById = new Map(nativePositions.map((position) => [
    position.cellId, { x: position.x, y: position.y }
  ] as const));
  const adjacencyFinalOriginByProxyId = new Map<string, Point>();
  for (const cluster of projection.spatialAdjacencyClusters) {
    const proxyPosition = positions.get(cluster.proxy.id);
    if (!proxyPosition) throw new Error("A spatial adjacency cluster was missing from the outer layout result.");
    const finalOrigin = { x: proxyPosition.x + dx, y: proxyPosition.y + dy };
    adjacencyFinalOriginByProxyId.set(cluster.proxy.id, finalOrigin);
    for (const memberOffset of cluster.memberOffsets) {
      const member = cellsById.get(memberOffset.cellId);
      if (!member || member.kind !== "vertex" || !member.hasGeometry || member.parentId !== projection.layoutLayerId) {
        throw new Error("A spatial adjacency member changed scope during layout planning: " + memberOffset.cellId);
      }
      const x = finalOrigin.x + memberOffset.x;
      const y = finalOrigin.y + memberOffset.y;
      if (!finiteCoordinate(x) || !finiteCoordinate(y)) throw new Error("The layout engine returned invalid local-group coordinates.");
      nativePositions.push({ cellId: memberOffset.cellId, x, y });
    }
  }
  const regionDeltaById = new Map<string, Point>();
  for (const region of projection.spatialRegions) {
    const sourceRegion = cellsById.get(region.regionCellId);
    const finalRegion = finalTopLevelPositionById.get(region.regionCellId);
    if (!sourceRegion || !finalRegion) throw new Error("A detected spatial region was missing from the outer layout result.");
    const delta = { x: finalRegion.x - sourceRegion.x, y: finalRegion.y - sourceRegion.y };
    regionDeltaById.set(region.regionCellId, delta);
    for (const memberId of region.memberCellIds) {
      const member = cellsById.get(memberId);
      if (!member || member.kind !== "vertex" || !member.hasGeometry || member.parentId !== projection.layoutLayerId) {
        throw new Error("A spatial region member changed scope during layout planning: " + memberId);
      }
      const x = member.x + delta.x;
      const y = member.y + delta.y;
      if (!finiteCoordinate(x) || !finiteCoordinate(y)) throw new Error("The layout engine returned invalid region-member coordinates.");
      nativePositions.push({ cellId: memberId, x, y });
    }
  }
  const finalPositionById = new Map(nativePositions.map((position) => [
    position.cellId, { x: position.x, y: position.y }
  ] as const));
  const adjacencyOwnerByMemberId = new Map<string, string>();
  for (const cluster of projection.spatialAdjacencyClusters) {
    for (const memberId of cluster.memberCellIds) adjacencyOwnerByMemberId.set(memberId, cluster.proxy.id);
  }
  const absoluteBoundsForCell = (cellId: string): { x: number; y: number; width: number; height: number } | null => {
    let current = cellsById.get(cellId);
    if (!current || current.kind !== "vertex" || !current.hasGeometry) return null;
    const width = current.width;
    const height = current.height;
    let x = 0;
    let y = 0;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const finalPosition = finalPositionById.get(current.id);
      x += finalPosition?.x ?? current.x;
      y += finalPosition?.y ?? current.y;
      if (current.parentId === projection.layoutLayerId) return { x, y, width, height };
      current = current.parentId ? cellsById.get(current.parentId) : undefined;
    }
    return null;
  };
  const groupBoundaryPoint = (nestedTerminalId: string, ownerId: string, oppositeTerminalId: string): Point | null => {
    const owner = absoluteBoundsForCell(ownerId);
    const nested = absoluteBoundsForCell(nestedTerminalId);
    const opposite = absoluteBoundsForCell(oppositeTerminalId);
    if (!owner || !nested || !opposite) return null;
    const ownerCenter = { x: owner.x + owner.width / 2, y: owner.y + owner.height / 2 };
    const nestedCenter = { x: nested.x + nested.width / 2, y: nested.y + nested.height / 2 };
    const oppositeCenter = { x: opposite.x + opposite.width / 2, y: opposite.y + opposite.height / 2 };
    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
    const dx = oppositeCenter.x - ownerCenter.x;
    const dy = oppositeCenter.y - ownerCenter.y;
    // Exit through the group's side facing the opposite endpoint, aligned with the nested
    // terminal as far as the group bounds allow. The child keeps its local geometry unchanged.
    if (Math.abs(dx) >= Math.abs(dy)) {
      return {
        x: dx >= 0 ? owner.x + owner.width : owner.x,
        y: clamp(nestedCenter.y, owner.y + Math.min(8, owner.height / 2), owner.y + owner.height - Math.min(8, owner.height / 2))
      };
    }
    return {
      x: clamp(nestedCenter.x, owner.x + Math.min(8, owner.width / 2), owner.x + owner.width - Math.min(8, owner.width / 2)),
      y: dy >= 0 ? owner.y + owner.height : owner.y
    };
  };

  const nativeRoutes: NativeLayoutEdgeRoute[] = [];
  const routeClearance = 12;
  const terminalEscapeDistance = 16;
  const centerOf = (bounds: { x: number; y: number; width: number; height: number }): Point => ({
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  });
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const terminalEscapeOnSide = (
    bounds: { x: number; y: number; width: number; height: number },
    side: "left" | "right" | "top" | "bottom"
  ): { port: Point; escape: Point } => {
    const center = centerOf(bounds);
    if (side === "left" || side === "right") {
      const port = {
        x: side === "right" ? bounds.x + bounds.width : bounds.x,
        y: center.y
      };
      return { port, escape: { x: port.x + (side === "right" ? terminalEscapeDistance : -terminalEscapeDistance), y: port.y } };
    }
    const port = { x: center.x, y: side === "bottom" ? bounds.y + bounds.height : bounds.y };
    return { port, escape: { x: port.x, y: port.y + (side === "bottom" ? terminalEscapeDistance : -terminalEscapeDistance) } };
  };
  const terminalEscape = (
    bounds: { x: number; y: number; width: number; height: number },
    toward: Point
  ): { port: Point; escape: Point } => {
    const center = centerOf(bounds);
    const dx = toward.x - center.x;
    const dy = toward.y - center.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const y = clamp(toward.y, bounds.y + Math.min(12, bounds.height / 2), bounds.y + bounds.height - Math.min(12, bounds.height / 2));
      const direction = dx >= 0 ? 1 : -1;
      const port = { x: direction > 0 ? bounds.x + bounds.width : bounds.x, y };
      return { port, escape: { x: port.x + direction * terminalEscapeDistance, y } };
    }
    const x = clamp(toward.x, bounds.x + Math.min(12, bounds.width / 2), bounds.x + bounds.width - Math.min(12, bounds.width / 2));
    const direction = dy >= 0 ? 1 : -1;
    const port = { x, y: direction > 0 ? bounds.y + bounds.height : bounds.y };
    return { port, escape: { x, y: port.y + direction * terminalEscapeDistance } };
  };
  const terminalEscapeCandidates = (
    bounds: { x: number; y: number; width: number; height: number },
    toward: Point,
    selfLoopSide?: "left" | "right" | "top" | "bottom"
  ): Array<{ port: Point; escape: Point }> => {
    const preferred = selfLoopSide
      ? terminalEscapeOnSide(bounds, selfLoopSide)
      : terminalEscape(bounds, toward);
    const alternatives = (["right", "left", "bottom", "top"] as const).map((side) =>
      terminalEscapeOnSide(bounds, side)
    );
    const result: Array<{ port: Point; escape: Point }> = [];
    for (const candidate of [preferred, ...alternatives]) {
      if (!result.some((item) =>
        Math.abs(item.escape.x - candidate.escape.x) <= routeAxisEpsilon &&
        Math.abs(item.escape.y - candidate.escape.y) <= routeAxisEpsilon
      )) result.push(candidate);
    }
    return result;
  };
  const escapeFromBoundary = (
    ownerId: string,
    boundary: Point
  ): { boundary: Point; escape: Point } | null => {
    const owner = absoluteBoundsForCell(ownerId);
    if (!owner) return null;
    let direction: Point | null = null;
    if (Math.abs(boundary.x - owner.x) <= routeAxisEpsilon) direction = { x: -1, y: 0 };
    else if (Math.abs(boundary.x - (owner.x + owner.width)) <= routeAxisEpsilon) direction = { x: 1, y: 0 };
    else if (Math.abs(boundary.y - owner.y) <= routeAxisEpsilon) direction = { x: 0, y: -1 };
    else if (Math.abs(boundary.y - (owner.y + owner.height)) <= routeAxisEpsilon) direction = { x: 0, y: 1 };
    if (!direction) return null;
    return {
      boundary,
      escape: {
        x: boundary.x + direction.x * terminalEscapeDistance,
        y: boundary.y + direction.y * terminalEscapeDistance
      }
    };
  };
  const isDescendantOrSelf = (cellId: string, ancestorId: string): boolean => {
    let current = cellsById.get(cellId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.id === ancestorId) return true;
      seen.add(current.id);
      current = current.parentId ? cellsById.get(current.parentId) : undefined;
    }
    return false;
  };
  const belongsToRegionOwner = (cellId: string, ownerId: string): boolean => {
    if (isDescendantOrSelf(cellId, ownerId)) return true;
    return projection.spatialRegions.some((region) =>
      region.regionCellId === ownerId && region.memberCellIds.includes(cellId)
    );
  };
  const isInsideVisibleLayoutLayer = (cellId: string): boolean => {
    let current = cellsById.get(cellId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (!current.visible) return false;
      seen.add(current.id);
      if (current.parentId === projection.layoutLayerId) return true;
      current = current.parentId ? cellsById.get(current.parentId) : undefined;
    }
    return false;
  };
  const routingObstaclesFor = (edge: ProjectedCell) => {
    const endpointIds = new Set([edge.sourceId, edge.targetId].filter((id): id is string => Boolean(id)));
    const ownerIds = [edge.layoutSourceId, edge.layoutTargetId]
      .filter((id): id is string => Boolean(id));
    return projection.allCells
      .filter((cell) => cell.kind === "vertex" && cell.hasGeometry && cell.width > 0 && cell.height > 0 &&
        isInsideVisibleLayoutLayer(cell.id) &&
        !endpointIds.has(cell.id) &&
        !ownerIds.includes(cell.id) &&
        !ownerIds.some((ownerId) => belongsToRegionOwner(cell.id, ownerId)))
      .map((cell) => {
        const bounds = absoluteBoundsForCell(cell.id);
        return bounds ? { ...bounds, cellId: cell.id } : null;
      })
      .filter((obstacle): obstacle is { x: number; y: number; width: number; height: number; cellId: string } => obstacle !== null);
  };
  const routeInsideOwner = (
    terminalId: string,
    ownerId: string,
    boundary: Point,
    oppositeTerminalId: string
  ): Point[] => {
    const terminalBounds = absoluteBoundsForCell(terminalId);
    const ownerBounds = absoluteBoundsForCell(ownerId);
    if (!terminalBounds || !ownerBounds) {
      throw new Error("The route through group " + ownerId + " is missing terminal geometry.");
    }
    const port = terminalEscape(terminalBounds, boundary);
    const insideBounds = (point: Point) =>
      point.x >= ownerBounds.x - routeAxisEpsilon &&
      point.x <= ownerBounds.x + ownerBounds.width + routeAxisEpsilon &&
      point.y >= ownerBounds.y - routeAxisEpsilon &&
      point.y <= ownerBounds.y + ownerBounds.height + routeAxisEpsilon;
    const start = insideBounds(port.escape) ? port.escape : port.port;
    if (!insideBounds(start)) {
      throw new Error("The connector has no safe escape point inside group " + ownerId + ".");
    }
    const internalObstacles = projection.allCells
      .filter((cell) => cell.kind === "vertex" && cell.hasGeometry && cell.width > 0 && cell.height > 0 &&
        isInsideVisibleLayoutLayer(cell.id) && cell.id !== ownerId && cell.id !== terminalId &&
        cell.id !== oppositeTerminalId && belongsToRegionOwner(cell.id, ownerId))
      .map((cell) => absoluteBoundsForCell(cell.id))
      .filter((bounds): bounds is { x: number; y: number; width: number; height: number } => bounds !== null);
    const innerClearance = 6;
    const preferred = orthogonalizeRoute([start, boundary]);
    if (isOrthogonalRouteClear(preferred, internalObstacles, innerClearance, ownerBounds)) return preferred;
    for (const clearance of [innerClearance, 3, 0]) {
      const routed = routeOrthogonalAvoidingObstacles(start, boundary, internalObstacles, {
        clearance,
        bendPenalty: 18,
        maxPoints: 60,
        bounds: ownerBounds
      });
      if (routed && isOrthogonalRouteClear(routed, internalObstacles, clearance, ownerBounds)) {
        return orthogonalizeRoute(routed);
      }
    }
    // A dense pre-existing group can have no corridor with the requested clearance. Keep
    // layout usable and emit the shortest right-angle transition instead of aborting all nodes.
    return preferred;
  };

  for (const edge of projection.edges) {
    // The outer solver routes cluster-to-node edges against the cluster proxy; those waypoints
    // cannot be applied to the real native terminal. Recompute from actual member geometry instead.
    const usesAdjacencyProxy = adjacencyOwnerByMemberId.has(edge.sourceId ?? "") ||
      adjacencyOwnerByMemberId.has(edge.targetId ?? "");
    // The solver waypoints are retained when safe; obstacle routing only replaces a path
    // when a segment would overlap another visible node or its clearance envelope.
    const translated = (usesAdjacencyProxy ? [] : routes.get(edge.id) ?? [])
      .map((point) => ({ x: point.x + dx, y: point.y + dy }));
    if (translated.some((point) => !finiteCoordinate(point.x) || !finiteCoordinate(point.y))) {
      throw new Error("The layout engine returned an invalid connector route.");
    }

    const sourceBounds = edge.sourceId ? absoluteBoundsForCell(edge.sourceId) : null;
    const targetBounds = edge.targetId ? absoluteBoundsForCell(edge.targetId) : null;
    const hasResolvableTerminals = Boolean(edge.sourceId && edge.targetId && sourceBounds && targetBounds);
    if (options.edgeRouting === "ORTHOGONAL" && hasResolvableTerminals) {
      const sourceCenter = centerOf(sourceBounds!);
      const targetCenter = centerOf(targetBounds!);
      const selfLoop = edge.sourceId === edge.targetId;
      const sourceBoundary = !selfLoop && edge.sourceId && edge.layoutSourceId && edge.sourceId !== edge.layoutSourceId && edge.targetId
        ? groupBoundaryPoint(edge.sourceId, edge.layoutSourceId, edge.targetId)
        : null;
      const targetBoundary = !selfLoop && edge.targetId && edge.layoutTargetId && edge.targetId !== edge.layoutTargetId && edge.sourceId
        ? groupBoundaryPoint(edge.targetId, edge.layoutTargetId, edge.sourceId)
        : null;
      const sourceGroupExit = sourceBoundary && edge.layoutSourceId
        ? escapeFromBoundary(edge.layoutSourceId, sourceBoundary)
        : null;
      const targetGroupExit = targetBoundary && edge.layoutTargetId
        ? escapeFromBoundary(edge.layoutTargetId, targetBoundary)
        : null;
      const sourceCandidates = sourceGroupExit
        ? [{ port: sourceGroupExit.boundary, escape: sourceGroupExit.escape }]
        : terminalEscapeCandidates(sourceBounds!, translated[0] ?? targetCenter, selfLoop ? "right" : undefined);
      const targetCandidates = targetGroupExit
        ? [{ port: targetGroupExit.boundary, escape: targetGroupExit.escape }]
        : terminalEscapeCandidates(targetBounds!, translated[translated.length - 1] ?? sourceCenter, selfLoop ? "top" : undefined);
      const sourcePort = sourceCandidates[0];
      const targetPort = targetCandidates[0];
      const sourceInnerRoute = sourceGroupExit && edge.sourceId && edge.layoutSourceId && edge.targetId
        ? routeInsideOwner(edge.sourceId, edge.layoutSourceId, sourceGroupExit.boundary, edge.targetId)
        : [];
      const targetInnerRoute = targetGroupExit && edge.targetId && edge.layoutTargetId && edge.sourceId
        ? routeInsideOwner(edge.targetId, edge.layoutTargetId, targetGroupExit.boundary, edge.sourceId)
        : [];
      const obstacles = routingObstaclesFor(edge);
      const reversedTargetInnerRoute = targetInnerRoute.slice().reverse();
      const preferred = orthogonalizeRoute([
        ...sourceInnerRoute,
        sourcePort.escape,
        ...translated,
        targetPort.escape,
        ...reversedTargetInnerRoute
      ]);
      let points = isOrthogonalRouteClear(preferred, obstacles, routeClearance) ? preferred : null;
      if (!points) {
        const seenPairs = new Set<string>();
        for (const clearance of [routeClearance, 8, 4, 0]) {
          for (const sourceCandidate of sourceCandidates) {
            for (const targetCandidate of targetCandidates) {
              const pairKey = [sourceCandidate.escape.x, sourceCandidate.escape.y, targetCandidate.escape.x, targetCandidate.escape.y].join(":");
              if (seenPairs.has(pairKey)) continue;
              seenPairs.add(pairKey);
              const routed = routeOrthogonalAvoidingObstacles(
                sourceCandidate.escape,
                targetCandidate.escape,
                obstacles,
                { clearance, bendPenalty: 32, maxPoints: 90 }
              );
              if (!routed) continue;
              const candidate = orthogonalizeRoute([
                ...sourceInnerRoute,
                ...routed,
                ...reversedTargetInnerRoute
              ]);
              if (isOrthogonalRouteClear(candidate, obstacles, clearance)) {
                points = candidate;
                break;
              }
            }
            if (points) break;
          }
          if (points) break;
        }
      }
      // Overlapping node bounds can make a fully clear route mathematically impossible.
      // Keep the layout operation usable with its orthogonalized solver path in that case.
      if (!points) points = preferred;
      if (points.length > 100 ||
          points.some((point) => !finiteCoordinate(point.x) || !finiteCoordinate(point.y)) ||
          points.some((point, index) => index > 0 &&
            Math.abs(point.x - points[index - 1].x) > routeAxisEpsilon &&
            Math.abs(point.y - points[index - 1].y) > routeAxisEpsilon)) {
        throw new Error("The connector route failed orthogonal geometry validation: " + edge.id);
      }
      nativeRoutes.push({ cellId: edge.id, points });
      continue;
    }

    // Polyline and spline modes keep the selected engine's point geometry. Group proxy
    // transitions remain explicit, but are not rewritten as orthogonal routes.
    if (!(options.engine === "elk" && options.algorithm === "fixed")) {
      if (edge.sourceId && edge.layoutSourceId && edge.sourceId !== edge.layoutSourceId && edge.targetId) {
        const exit = groupBoundaryPoint(edge.sourceId, edge.layoutSourceId, edge.targetId);
        if (exit) translated.unshift(exit);
      }
      if (edge.targetId && edge.layoutTargetId && edge.targetId !== edge.layoutTargetId && edge.sourceId) {
        const exit = groupBoundaryPoint(edge.targetId, edge.layoutTargetId, edge.sourceId);
        if (exit) translated.push(exit);
      }
    }
    nativeRoutes.push({ cellId: edge.id, points: translated });
  }
  // Internal connectors bypass the outer solver because region members move atomically.
  // Explicit routes are translated with the region; if that route collides with a member node,
  // the same orthogonal obstacle router repairs it inside the region boundary.
  for (const edge of projection.regionInternalEdges) {
    if (edge.points.length === 0) continue;
    const regionId = edge.layoutSourceId;
    const delta = regionId ? regionDeltaById.get(regionId) : undefined;
    if (!delta) throw new Error("An internal region connector had no corresponding region translation: " + edge.id);
    const translated = edge.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y }));
    if (translated.some((point) => !finiteCoordinate(point.x) || !finiteCoordinate(point.y))) {
      throw new Error("The layout engine returned an invalid internal region connector route.");
    }
    if (options.edgeRouting !== "ORTHOGONAL" || !edge.sourceId || !edge.targetId || !regionId) {
      nativeRoutes.push({ cellId: edge.id, points: translated });
      continue;
    }

    const regionBounds = absoluteBoundsForCell(regionId);
    const sourceBounds = absoluteBoundsForCell(edge.sourceId);
    const targetBounds = absoluteBoundsForCell(edge.targetId);
    if (!regionBounds || !sourceBounds || !targetBounds) {
      throw new Error("An internal region connector was missing terminal or region bounds: " + edge.id);
    }
    const region = projection.spatialRegions.find((candidate) => candidate.regionCellId === regionId);
    const memberIds = new Set(region?.memberCellIds ?? []);
    const internalObstacles = projection.allCells
      .filter((cell) => memberIds.has(cell.id) && cell.kind === "vertex" && cell.hasGeometry &&
        cell.width > 0 && cell.height > 0 && cell.visible &&
        cell.id !== edge.sourceId && cell.id !== edge.targetId)
      .map((cell) => absoluteBoundsForCell(cell.id))
      .filter((bounds): bounds is { x: number; y: number; width: number; height: number } => bounds !== null);
    const sourcePort = terminalEscape(sourceBounds, translated[0] ?? centerOf(targetBounds));
    const targetPort = terminalEscape(targetBounds, translated[translated.length - 1] ?? centerOf(sourceBounds));
    const withinRegion = (point: Point) =>
      point.x >= regionBounds.x - routeAxisEpsilon &&
      point.x <= regionBounds.x + regionBounds.width + routeAxisEpsilon &&
      point.y >= regionBounds.y - routeAxisEpsilon &&
      point.y <= regionBounds.y + regionBounds.height + routeAxisEpsilon;
    const sourceEscape = withinRegion(sourcePort.escape) ? sourcePort.escape : sourcePort.port;
    const targetEscape = withinRegion(targetPort.escape) ? targetPort.escape : targetPort.port;
    const preferred = orthogonalizeRoute([sourceEscape, ...translated, targetEscape]);
    const innerClearance = 6;
    let points = isOrthogonalRouteClear(preferred, internalObstacles, innerClearance, regionBounds)
      ? orthogonalizeRoute(translated)
      : null;
    if (!points) {
      const routed = routeOrthogonalAvoidingObstacles(sourceEscape, targetEscape, internalObstacles, {
        clearance: innerClearance,
        bendPenalty: 18,
        maxPoints: 80,
        bounds: regionBounds
      });
      if (routed && isOrthogonalRouteClear(routed, internalObstacles, innerClearance, regionBounds)) {
        points = orthogonalizeRoute(routed);
      }
    }
    if (!points) {
      // Keep the translated waypoints in difficult, overlapping regions rather than failing
      // the entire layout; the planner still enforces orthogonality before returning the plan.
      points = orthogonalizeRoute(translated);
    }
    nativeRoutes.push({ cellId: edge.id, points });
  }

  // Local-group edges bypass the outer solver because their endpoints move atomically.
  // Explicit waypoints undergo the same local axis reflow as their member centres and then
  // follow the translated cluster; absent waypoints stay absent for native Draw.io routing.
  for (const edge of projection.adjacencyInternalEdges) {
    if (edge.points.length === 0) continue;
    const proxyId = edge.layoutSourceId;
    const cluster = proxyId
      ? projection.spatialAdjacencyClusters.find((candidate) => candidate.proxy.id === proxyId)
      : undefined;
    const finalOrigin = proxyId ? adjacencyFinalOriginByProxyId.get(proxyId) : undefined;
    if (!cluster || !finalOrigin) throw new Error("An internal local-group connector had no corresponding cluster translation: " + edge.id);
    const translated = edge.points.map((point) => {
      const oriented = mapSpatialAdjacencyPoint(cluster, point);
      return { x: finalOrigin.x + oriented.x - cluster.x, y: finalOrigin.y + oriented.y - cluster.y };
    });
    if (translated.some((point) => !finiteCoordinate(point.x) || !finiteCoordinate(point.y))) {
      throw new Error("The layout engine returned invalid local-group connector waypoints.");
    }
    nativeRoutes.push({
      cellId: edge.id,
      points: options.edgeRouting === "ORTHOGONAL" ? orthogonalizeRoute(translated) : translated
    });
  }

  const cellsToGuard = new Map<string, NativeLayoutExpectedCell>();
  for (const vertex of projection.vertices) cellsToGuard.set(vertex.id, {
    cellId: vertex.id, kind: "vertex", x: vertex.x, y: vertex.y,
    width: vertex.width, height: vertex.height, parentId: vertex.parentId,
    sourceId: null, targetId: null
  });
  for (const region of projection.spatialRegions) {
    for (const memberId of region.memberCellIds) {
      const member = cellsById.get(memberId);
      if (!member) throw new Error("A spatial region member disappeared before plan generation: " + memberId);
      cellsToGuard.set(member.id, {
        cellId: member.id, kind: "vertex", x: member.x, y: member.y,
        width: member.width, height: member.height, parentId: member.parentId,
        sourceId: null, targetId: null
      });
    }
  }
  for (const cluster of projection.spatialAdjacencyClusters) {
    for (const memberId of cluster.memberCellIds) {
      const member = cellsById.get(memberId);
      if (!member) throw new Error("A spatial adjacency member disappeared before plan generation: " + memberId);
      cellsToGuard.set(member.id, {
        cellId: member.id, kind: "vertex", x: member.x, y: member.y,
        width: member.width, height: member.height, parentId: member.parentId,
        sourceId: null, targetId: null
      });
    }
  }
  for (const edge of projection.edges) cellsToGuard.set(edge.id, {
    cellId: edge.id, kind: "edge", x: edge.x, y: edge.y,
    width: edge.width, height: edge.height, parentId: edge.parentId,
    sourceId: edge.sourceId, targetId: edge.targetId
  });
  for (const edge of projection.adjacencyInternalEdges.filter((item) => item.points.length > 0)) {
    cellsToGuard.set(edge.id, {
      cellId: edge.id, kind: "edge", x: edge.x, y: edge.y,
      width: edge.width, height: edge.height, parentId: edge.parentId,
      sourceId: edge.sourceId, targetId: edge.targetId
    });
  }
  for (const edge of projection.regionInternalEdges.filter((item) => item.points.length > 0)) {
    cellsToGuard.set(edge.id, {
      cellId: edge.id, kind: "edge", x: edge.x, y: edge.y,
      width: edge.width, height: edge.height, parentId: edge.parentId,
      sourceId: edge.sourceId, targetId: edge.targetId
    });
  }

  return {
    ...options,
    anchorCellIds,
    anchorDiagnostics,
    direction: mapDirection(options.direction),
    documentRevision,
    pageId: projection.pageId,
    layoutLayerId: projection.layoutLayerId,
    layoutLayerFallback: projection.layoutLayerFallback,
    coverage: {
      sourceVertexCount: projection.sourceVertexCount,
      plannedVertexCount: projection.vertices.length + projection.spatialRegionMemberCount + projection.spatialAdjacencyClusterMemberCount,
      untouchedVertexCount: Math.max(0, projection.sourceVertexCount - projection.vertices.length - projection.spatialRegionMemberCount - projection.spatialAdjacencyClusterMemberCount),
      nestedVertexCount: projection.nestedVertexCount,
      verticesInOtherLayersCount: projection.verticesInOtherLayersCount,
      hiddenVertexCount: projection.hiddenVertexCount,
      verticesWithoutGeometryCount: Math.max(0, projection.sourceVertexCount - projection.sourceVertexWithGeometryCount),
      sourceEdgeCount: projection.sourceEdgeCount,
      plannedEdgeCount: projection.edges.length +
        projection.regionInternalEdges.filter((edge) => edge.points.length > 0).length +
        projection.adjacencyInternalEdges.filter((edge) => edge.points.length > 0).length,
      untouchedEdgeCount: Math.max(0, projection.sourceEdgeCount - projection.edges.length -
        projection.regionInternalEdges.filter((edge) => edge.points.length > 0).length -
        projection.adjacencyInternalEdges.filter((edge) => edge.points.length > 0).length),
      edgesOutsideLayoutLayerCount: projection.edgesOutsideLayoutLayerCount,
      hiddenEdgeCount: projection.hiddenEdgeCount,
      edgesWithoutGeometryCount: Math.max(0, projection.sourceEdgeCount - projection.sourceEdgeWithGeometryCount),
      edgesMissingTerminalsCount: projection.edgesMissingTerminalsCount,
      edgesWithEndpointsOutsideTargetVerticesCount: projection.edgesWithEndpointsOutsideTargetVerticesCount,
      connectorsAttachedToNestedChildrenCount: projection.connectorsAttachedToNestedChildrenCount,
      edgesWithinSameGroupUntouchedCount: projection.edgesWithinSameGroupUntouchedCount,
      spatialRegionCount: projection.spatialRegions.length,
      spatialRegionMemberCount: projection.spatialRegionMemberCount,
      spatialRegionBoundaryVertexCount: projection.spatialRegionBoundaryVertexCount,
      spatialRegionCandidatesSkippedCount: projection.spatialRegionCandidatesSkippedCount,
      spatialRegionInternalEdgeCount: projection.regionInternalEdges.length,
      spatialRegionInternalEdgesTranslatedCount: projection.regionInternalEdges.filter((edge) => edge.points.length > 0).length,
      spatialAdjacencyClusterCount: projection.spatialAdjacencyClusters.length,
      spatialAdjacencyClusterMemberCount: projection.spatialAdjacencyClusterMemberCount,
      spatialAdjacencyInternalEdgeCount: projection.adjacencyInternalEdges.length,
      spatialAdjacencyInternalEdgesTranslatedCount: projection.adjacencyInternalEdges.filter((edge) => edge.points.length > 0).length,
      spatialRegionUnownedContainedVertexCount: projection.spatialRegionUnownedContainedVertexCount,
      sourceCoordinatesRetainedVertexCount: retainSourceCoordinates ? nativePositions.length : 0
    },
    expectedPageCellIds: projection.allCellIds,
    unownedContainedVertexCellIds: projection.spatialRegionUnownedContainedVertexCellIds,
    expectedCells: Array.from(cellsToGuard.values()),
    positions: nativePositions,
    edgeRoutes: nativeRoutes
  };
}


interface ResolvedRelativeAnchor {
  cellId: string;
  unitId: string;
  sourceCenter: Point;
  offsetFromUnit: Point;
}

/**
 * Refines a base engine layout with engine-independent relative anchor constraints.
 * The optimizer changes movable layout-unit positions jointly; it never pins anchors to
 * absolute source coordinates. All constraints use source geometry from this revision.
 */
function optimizeRelativeAnchorPositions(
  projection: NativePageProjection,
  positions: Map<string, Point>,
  anchorCellIds: string[],
  enabled: boolean
): { diagnostics: NativeRelativeAnchorDiagnostics; changed: boolean } {
  const emptyDiagnostics: NativeRelativeAnchorDiagnostics = {
    outcome: "not-requested", requestedAnchorCount: 0, resolvedAnchorCount: 0,
    effectiveAnchorUnitCount: 0, evaluatedPairCount: 0, maximumVectorDrift: 0,
    meanVectorDrift: 0, toleranceBandPx: 0, toleranceViolationCount: 0, directionalOrderViolations: 0,
    refinementIterations: 0, collisionAdjustments: 0
  };
  if (!enabled) {
    if (anchorCellIds.length > 0) {
      throw new Error("Relative anchor cell IDs were supplied while relative-anchor mode is disabled.");
    }
    return { diagnostics: emptyDiagnostics, changed: false };
  }

  const selectedIds = Array.from(new Set(anchorCellIds.map((id) => String(id).trim()).filter(Boolean))).sort();
  // Relative anchoring is the default UI preference, but it is meaningful only when the
  // current selection contains 2–32 anchors. An empty list is an intentional no-anchor run:
  // perform ordinary layout rather than making the global Auto Layout command unusable.
  if (selectedIds.length === 0) return { diagnostics: emptyDiagnostics, changed: false };
  if (selectedIds.length < 2) {
    throw new Error("Preserve relative positions requires at least two selected vertex cells on the active Draw.io page.");
  }
  if (selectedIds.length > 32) {
    throw new Error("Relative anchoring supports at most 32 selected cells per layout run.");
  }

  const allById = new Map(projection.allCells.map((cell) => [cell.id, cell] as const));
  const unitsById = new Map(projection.layoutVertices.map((unit) => [unit.id, unit] as const));
  const regionOwnerByMemberId = new Map<string, string>();
  for (const region of projection.spatialRegions) {
    for (const memberId of region.memberCellIds) regionOwnerByMemberId.set(memberId, region.regionCellId);
  }
  const adjacencyOwnerByMemberId = new Map<string, string>();
  for (const cluster of projection.spatialAdjacencyClusters) {
    for (const memberId of cluster.memberCellIds) adjacencyOwnerByMemberId.set(memberId, cluster.proxy.id);
  }

  const sourceAbsoluteCenter = (cellId: string): Point | null => {
    let current = allById.get(cellId);
    if (!current || current.kind !== "vertex" || !current.hasGeometry || !current.visible ||
        current.width <= 0 || current.height <= 0) return null;
    let x = 0;
    let y = 0;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      x += current.x;
      y += current.y;
      if (current.parentId === projection.layoutLayerId) {
        return { x: x + current.width / 2, y: y + current.height / 2 };
      }
      current = current.parentId ? allById.get(current.parentId) : undefined;
    }
    return null;
  };

  const resolveUnitId = (cellId: string): string | null => {
    let current = allById.get(cellId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (unitsById.has(current.id)) return current.id;
      const regionOwner = regionOwnerByMemberId.get(current.id);
      if (regionOwner && unitsById.has(regionOwner)) return regionOwner;
      const adjacencyOwner = adjacencyOwnerByMemberId.get(current.id);
      if (adjacencyOwner && unitsById.has(adjacencyOwner)) return adjacencyOwner;
      current = current.parentId ? allById.get(current.parentId) : undefined;
    }
    return null;
  };

  const resolved: ResolvedRelativeAnchor[] = [];
  for (const cellId of selectedIds) {
    const cell = allById.get(cellId);
    if (!cell || cell.kind !== "vertex" || !cell.hasGeometry || !cell.visible) {
      throw new Error("Relative anchor “" + cellId + "” is missing, hidden, non-vertex or has no geometry on the active page.");
    }
    const unitId = resolveUnitId(cellId);
    const center = sourceAbsoluteCenter(cellId);
    const unit = unitId ? unitsById.get(unitId) : undefined;
    if (!unitId || !unit || !center) {
      throw new Error("Relative anchor “" + cellId + "” cannot be mapped unambiguously to a movable layout unit. Select visible top-level vertices or cells inside an eligible group/container.");
    }
    resolved.push({
      cellId, unitId, sourceCenter: center,
      offsetFromUnit: { x: center.x - unit.x, y: center.y - unit.y }
    });
  }

  // Several selected children may belong to one atomic region or local cluster. Such a unit
  // already preserves those children internally; choose one stable representative for its
  // external pair constraints instead of counting redundant pairs as independent constraints.
  const representativeByUnitId = new Map<string, ResolvedRelativeAnchor>();
  for (const anchor of resolved) {
    if (!representativeByUnitId.has(anchor.unitId)) representativeByUnitId.set(anchor.unitId, anchor);
  }
  const anchors = Array.from(representativeByUnitId.values()).sort((a, b) => a.unitId.localeCompare(b.unitId));
  if (anchors.length < 2) {
    throw new Error("The selected cells belong to fewer than two movable layout units. Select cells from at least two independent groups or nodes.");
  }
  const anchorUnitIds = new Set(anchors.map((anchor) => anchor.unitId));
  const pairs: Array<{ a: ResolvedRelativeAnchor; b: ResolvedRelativeAnchor; dx: number; dy: number; tolerance: number }> = [];
  for (let i = 0; i < anchors.length; i += 1) {
    for (let j = i + 1; j < anchors.length; j += 1) {
      const a = anchors[i];
      const b = anchors[j];
      const dx = b.sourceCenter.x - a.sourceCenter.x;
      const dy = b.sourceCenter.y - a.sourceCenter.y;
      const distance = Math.hypot(dx, dy);
      pairs.push({ a, b, dx, dy, tolerance: Math.min(24, Math.max(8, distance * 0.03)) });
    }
  }
  const sourceByUnitId = new Map(projection.layoutVertices.map((unit) => [unit.id, { x: unit.x, y: unit.y }] as const));
  let refinementIterations = 0;
  let collisionAdjustments = 0;
  let stableIterations = 0;
  let changed = false;

  const overlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => ({
    x: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    y: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  });
  const hasAreaOverlap = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => {
    const amount = overlap(a, b);
    return amount.x > 1 && amount.y > 1;
  };

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const before = new Map(Array.from(positions, ([id, point]) => [id, { x: point.x, y: point.y }] as const));
    const correctionByUnit = new Map<string, { x: number; y: number; count: number }>();
    const addCorrection = (unitId: string, x: number, y: number) => {
      const previous = correctionByUnit.get(unitId) ?? { x: 0, y: 0, count: 0 };
      previous.x += x; previous.y += y; previous.count += 1;
      correctionByUnit.set(unitId, previous);
    };

    // All pair constraints are translation-invariant. Their equal-and-opposite corrections
    // preserve the anchor-set centroid unless collision avoidance needs to move surrounding units.
    for (const pair of pairs) {
      const positionA = positions.get(pair.a.unitId);
      const positionB = positions.get(pair.b.unitId);
      if (!positionA || !positionB) throw new Error("A relative anchor unit disappeared from the layout result.");
      const currentAX = positionA.x + pair.a.offsetFromUnit.x;
      const currentAY = positionA.y + pair.a.offsetFromUnit.y;
      const currentBX = positionB.x + pair.b.offsetFromUnit.x;
      const currentBY = positionB.y + pair.b.offsetFromUnit.y;
      const errorX = currentBX - currentAX - pair.dx;
      const errorY = currentBY - currentAY - pair.dy;
      const drift = Math.hypot(errorX, errorY);
      if (drift <= pair.tolerance) continue;
      const scale = ((drift - pair.tolerance) / drift) * 0.55 * 0.5;
      addCorrection(pair.a.unitId, errorX * scale, errorY * scale);
      addCorrection(pair.b.unitId, -errorX * scale, -errorY * scale);
    }
    for (const [unitId, correction] of correctionByUnit) {
      const point = positions.get(unitId)!;
      const next = {
        x: point.x + correction.x / correction.count,
        y: point.y + correction.y / correction.count
      };
      if (Math.abs(next.x - point.x) > 0.001 || Math.abs(next.y - point.y) > 0.001) changed = true;
      positions.set(unitId, next);
    }

    // Collision projection is shared across engines. Sweep by x and cap pathological dense
    // candidate sets; it moves unselected units first and leaves source overlaps alone.
    const orderedUnits = [...projection.layoutVertices].sort((a, b) =>
      positions.get(a.id)!.x - positions.get(b.id)!.x || a.id.localeCompare(b.id)
    );
    let candidateCount = 0;
    for (let i = 0; i < orderedUnits.length && candidateCount < 25000; i += 1) {
      const a = orderedUnits[i];
      const pa = positions.get(a.id)!;
      const sourceA = sourceByUnitId.get(a.id)!;
      for (let j = i + 1; j < orderedUnits.length && candidateCount < 25000; j += 1) {
        const b = orderedUnits[j];
        const pb = positions.get(b.id)!;
        if (pb.x >= pa.x + a.width - 1) break;
        candidateCount += 1;
        const currentA = { ...pa, width: a.width, height: a.height };
        const currentB = { ...pb, width: b.width, height: b.height };
        if (!hasAreaOverlap(currentA, currentB)) continue;
        const sourceB = sourceByUnitId.get(b.id)!;
        if (hasAreaOverlap(
          { ...sourceA, width: a.width, height: a.height },
          { ...sourceB, width: b.width, height: b.height }
        )) continue;
        const aAnchored = anchorUnitIds.has(a.id);
        const bAnchored = anchorUnitIds.has(b.id);
        if (aAnchored && bAnchored) continue;

        const amounts = overlap(currentA, currentB);
        const horizontalSeparation = amounts.x <= amounts.y;
        const centerA = horizontalSeparation ? pa.x + a.width / 2 : pa.y + a.height / 2;
        const centerB = horizontalSeparation ? pb.x + b.width / 2 : pb.y + b.height / 2;
        const negativeOnA = centerA < centerB || (Math.abs(centerA - centerB) < 0.001 && a.id.localeCompare(b.id) < 0);
        const direction = negativeOnA ? 1 : -1;
        const push = (horizontalSeparation ? amounts.x : amounts.y) + 4;
        if (aAnchored) {
          positions.set(b.id, horizontalSeparation ? { x: pb.x + direction * push, y: pb.y } : { x: pb.x, y: pb.y + direction * push });
        } else if (bAnchored) {
          positions.set(a.id, horizontalSeparation ? { x: pa.x - direction * push, y: pa.y } : { x: pa.x, y: pa.y - direction * push });
        } else {
          const half = push / 2;
          positions.set(a.id, horizontalSeparation ? { x: pa.x - direction * half, y: pa.y } : { x: pa.x, y: pa.y - direction * half });
          positions.set(b.id, horizontalSeparation ? { x: pb.x + direction * half, y: pb.y } : { x: pb.x, y: pb.y + direction * half });
        }
        collisionAdjustments += 1;
        changed = true;
      }
    }

    let maxMovement = 0;
    for (const [id, point] of positions) {
      const previous = before.get(id);
      if (previous) maxMovement = Math.max(maxMovement, Math.hypot(point.x - previous.x, point.y - previous.y));
    }
    refinementIterations = iteration + 1;
    stableIterations = maxMovement < 0.5 ? stableIterations + 1 : 0;
    if (stableIterations >= 5) break;
  }

  let maximumVectorDrift = 0;
  let totalVectorDrift = 0;
  let directionalOrderViolations = 0;
  let toleranceViolationCount = 0;
  let toleranceBandPx = 0;
  for (const pair of pairs) {
    const positionA = positions.get(pair.a.unitId)!;
    const positionB = positions.get(pair.b.unitId)!;
    const currentAX = positionA.x + pair.a.offsetFromUnit.x;
    const currentAY = positionA.y + pair.a.offsetFromUnit.y;
    const currentBX = positionB.x + pair.b.offsetFromUnit.x;
    const currentBY = positionB.y + pair.b.offsetFromUnit.y;
    const currentDx = currentBX - currentAX;
    const currentDy = currentBY - currentAY;
    const drift = Math.hypot(currentDx - pair.dx, currentDy - pair.dy);
    maximumVectorDrift = Math.max(maximumVectorDrift, drift);
    totalVectorDrift += drift;
    toleranceBandPx = Math.max(toleranceBandPx, pair.tolerance);
    // Each pair has its own scale-derived tolerance. Comparing every pair with the largest
    // tolerance in the whole anchor set would let a distant pair mask a local relation failure.
    if (drift > pair.tolerance + 0.5) toleranceViolationCount += 1;
    const reversedX = Math.abs(pair.dx) > 8 && (pair.dx > 0 ? currentDx <= 0 : currentDx >= 0);
    const reversedY = Math.abs(pair.dy) > 8 && (pair.dy > 0 ? currentDy <= 0 : currentDy >= 0);
    if (reversedX || reversedY) directionalOrderViolations += 1;
  }
  const meanVectorDrift = pairs.length ? totalVectorDrift / pairs.length : 0;
  const degraded = toleranceViolationCount > 0 || directionalOrderViolations > 0;
  return {
    changed,
    diagnostics: {
      outcome: degraded ? "degraded" : "applied",
      requestedAnchorCount: selectedIds.length,
      resolvedAnchorCount: resolved.length,
      effectiveAnchorUnitCount: anchors.length,
      evaluatedPairCount: pairs.length,
      maximumVectorDrift: Math.round(maximumVectorDrift * 100) / 100,
      meanVectorDrift: Math.round(meanVectorDrift * 100) / 100,
      toleranceBandPx: Math.round(toleranceBandPx * 100) / 100,
      toleranceViolationCount,
      directionalOrderViolations,
      refinementIterations,
      collisionAdjustments
    }
  };
}

/** Calculate geometry from a disposable projection of native Draw.io mxCells. This never
 * creates a persisted graph model or serializes XML; only the returned plan is sent back
 * to the live Draw.io editor for a revision/page checked native mutation. */
export async function calculateNativeAutoLayout(
  xml: string,
  pageId: string | null,
  documentRevision: string,
  options: NativeAutoLayoutOptions,
  requestedAnchorCellIds: string[] = []
): Promise<NativeLayoutPlan> {
  if (!documentRevision || !/^[a-f0-9]{64}$/i.test(documentRevision)) {
    throw new Error("Auto layout requires the revision of the exact native Draw.io XML snapshot.");
  }
  if (options.engine === "dagre" && options.algorithm !== "layered") {
    throw new Error(`Dagre supports only the layered algorithm; “${options.algorithm}” is not available for this engine. Choose ELK for other algorithms.`);
  }
  if (!nativeLayoutSupportsAlgorithm(options.engine, options.algorithm)) {
    throw new Error("The selected algorithm is not supported by the chosen layout engine.");
  }
  const anchorCellIds = Array.from(new Set(requestedAnchorCellIds.map((id) => String(id).trim()).filter(Boolean))).sort();
  if (!options.preserveRelativeAnchors && anchorCellIds.length > 0) {
    throw new Error("Relative anchor cell IDs were supplied while relative-anchor mode is disabled.");
  }
  if (options.preserveRelativeAnchors && anchorCellIds.length > 0 && anchorCellIds.length < 2) {
    throw new Error("Preserve relative positions requires at least two selected vertex cells.");
  }
  if (anchorCellIds.length > 32) {
    throw new Error("Relative anchoring supports at most 32 selected cells per layout run.");
  }
  // Layouts that explicitly preserve node coordinates or do not support direction must not
  // rotate the local composition as a side effect. Anchored cluster members retain their offsets
  // instead of being internally reflowed to match a new direction.
  const projectionDirection = nativeLayoutSupportsDirection(options.engine, options.algorithm)
    ? options.direction : null;
  const anchorIdsForProjection = options.preserveRelativeAnchors ? new Set(anchorCellIds) : new Set<string>();
  const projection = projectNativePage(xml, pageId, options.preserveLocalGrouping, options.nodeSpacing, projectionDirection, anchorIdsForProjection);
  if (projection.layoutVertices.length === 0) {
    throw new Error(describeEmptyLayoutScope(projection));
  }

  if (options.engine === "elk" && (options.algorithm === "box" || options.algorithm === "rectpacking") && projection.edges.length > 0) {
    throw new Error("ELK Box and Rectangle packing are intended for unconnected nodes. Choose a graph layout algorithm for diagrams with connectors.");
  }

  const nodeById = new Map(projection.layoutVertices.map((node) => [node.id, node] as const));
  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();

  // A graph-structure algorithm cannot infer a useful flow from a page with no source connectors;
  // retaining source coordinates is safer than arbitrarily packing isolated components. The test
  // uses sourceEdgeCount, not projected edges, so internal or otherwise filtered native connectors
  // cannot be mislabeled as a connector-free page. Explicit spatial/packing algorithms remain active.
  const retainSourceCoordinates = projection.sourceEdgeCount === 0 && NO_EDGE_GRAPH_LAYOUT_ALGORITHMS.has(options.algorithm);
  if (retainSourceCoordinates) {
    for (const node of projection.layoutVertices) positions.set(node.id, { x: node.x, y: node.y });
  } else if (options.engine === "graphviz" || options.engine === "msagl" || options.engine === "cytoscape" || options.engine === "d3") {
    const result = await calculateAdditionalNativeLayout(
      projection.layoutVertices,
      projection.edges.filter((edge) => (edge.layoutSourceId ?? edge.sourceId) && (edge.layoutTargetId ?? edge.targetId)).map((edge) => ({
        id: edge.id,
        sourceId: (edge.layoutSourceId ?? edge.sourceId)!,
        targetId: (edge.layoutTargetId ?? edge.targetId)!
      })),
      { ...options, engine: options.engine as AdditionalLayoutEngine }
    );
    for (const [id, point] of result.positions) positions.set(id, point);
    for (const [id, points] of result.routes) routes.set(id, points);
    if (options.engine === "cytoscape" ||
        (options.engine === "graphviz" && options.algorithm !== "dot") ||
        (options.engine === "d3" && options.algorithm === "force") ||
        (options.engine === "msagl" && options.algorithm !== "layered")) {
      emulateEmbeddedFlowDirection(positions, routes, projection.layoutVertices, projection.edges, options.direction);
    }
  } else if (options.engine === "dagre") {
    const graph = new dagre.graphlib.Graph({ multigraph: true });
    graph.setDefaultEdgeLabel(() => ({}));
    const rankdir: Record<NativeAutoLayoutDirection, "LR" | "RL" | "TB" | "BT"> = {
      RIGHT: "LR", LEFT: "RL", DOWN: "TB", UP: "BT"
    };
    graph.setGraph({
      rankdir: rankdir[options.direction],
      nodesep: options.nodeSpacing,
      ranksep: options.layerSpacing,
      marginx: options.margin,
      marginy: options.margin
    });
    for (const node of projection.layoutVertices) graph.setNode(node.id, { width: node.width, height: node.height });
    for (const edge of projection.edges) {
      const sourceId = edge.layoutSourceId ?? edge.sourceId;
      const targetId = edge.layoutTargetId ?? edge.targetId;
      if (sourceId && targetId) graph.setEdge(sourceId, targetId, {}, edge.id);
    }
    dagre.layout(graph);
    for (const node of projection.layoutVertices) {
      const point = graph.node(node.id) as { x: number; y: number } | undefined;
      if (!point) throw new Error("Dagre did not return a position for native cell " + node.id + ".");
      positions.set(node.id, { x: point.x - node.width / 2, y: point.y - node.height / 2 });
    }
    for (const edge of projection.edges) {
      const sourceId = edge.layoutSourceId ?? edge.sourceId;
      const targetId = edge.layoutTargetId ?? edge.targetId;
      if (!sourceId || !targetId) continue;
      const result = graph.edge({ v: sourceId, w: targetId, name: edge.id }) as { points?: Point[] } | undefined;
      // mxGeometry.points contains intermediate routing points; the terminals are represented
      // by Draw.io's source/target cells, not duplicated in the control-point list.
      routes.set(edge.id, (result?.points ?? []).slice(1, -1));
    }
  } else {
    const layoutOptions: Record<string, string> = {
      "elk.algorithm": options.algorithm,
      "elk.direction": options.direction,
      "elk.spacing.nodeNode": String(options.nodeSpacing),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(options.layerSpacing),
      "elk.edgeRouting": options.edgeRouting,
      "elk.separateConnectedComponents": "true",
      "elk.randomSeed": String(options.randomSeed),
      "elk.stress.iterationLimit": String(options.iterations),
      "elk.force.iterations": String(options.iterations)
    };
    if (options.algorithm === "stress") {
      // STRESS overrides most spacing controls; its desired edge length becomes the pitch,
      // so derive it from the requested spacing plus the largest node to guarantee clearance.
      const maxVertexWidth = Math.max(...projection.layoutVertices.map((vertex) => vertex.width));
      const maxVertexHeight = Math.max(...projection.layoutVertices.map((vertex) => vertex.height));
      layoutOptions["elk.stress.desiredEdgeLength"] = String(
        Math.max(options.nodeSpacing, options.layerSpacing) + (maxVertexWidth + maxVertexHeight) / 2
      );
    }
    if (options.algorithm === "sporeCompaction" || options.algorithm === "sporeOverlap") {
      layoutOptions["elk.spacing.nodeNode"] = String(options.nodeSpacing);
    }
    const graphInput = {
      id: "studio-native-layout",
      layoutOptions,
      children: projection.layoutVertices.map((node) => ({
        id: node.id, width: node.width, height: node.height,
        // Fixed retains source coordinates. SPOrE optimizers also need current coordinates
        // as their seed rather than receiving an all-origin graph.
        ...(["fixed", "sporeCompaction", "sporeOverlap"].includes(options.algorithm) ? { x: node.x, y: node.y } : {})
      })),
      edges: projection.edges
        .filter((edge) => (edge.layoutSourceId ?? edge.sourceId) && (edge.layoutTargetId ?? edge.targetId))
        .map((edge) => {
          const sourceId = (edge.layoutSourceId ?? edge.sourceId)!;
          const targetId = (edge.layoutTargetId ?? edge.targetId)!;
          const resultEdge = { id: edge.id, sources: [sourceId], targets: [targetId] };
          if (options.algorithm !== "fixed") return resultEdge;
          // ELK Fixed requires an existing section for each edge. These temporary center-to-center
          // sections satisfy that input contract; no such routes are persisted, and native Draw.io
          // recalculates the actual routes after applying the unchanged node coordinates.
          const source = projection.layoutVertices.find((vertex) => vertex.id === sourceId)!;
          const target = projection.layoutVertices.find((vertex) => vertex.id === targetId)!;
          return {
            ...resultEdge,
            sections: [{
              id: `${edge.id}-layout-section`,
              startPoint: { x: source.x + source.width / 2, y: source.y + source.height / 2 },
              endPoint: { x: target.x + target.width / 2, y: target.y + target.height / 2 },
              bendPoints: []
            }]
          };
        })
    };
    const result = await elk.layout(graphInput as never) as unknown as ElkLayoutResult;
    for (const node of result.children ?? []) {
      if (!nodeById.has(node.id) || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      positions.set(node.id, { x: Number(node.x), y: Number(node.y) });
    }
    if (options.algorithm === "fixed") {
      // Fixed is explicitly position-preserving. Keep exact coordinates from the native snapshot.
      for (const node of projection.layoutVertices) positions.set(node.id, { x: node.x, y: node.y });
    }
    for (const edge of result.edges ?? []) {
      const points = (edge.sections ?? []).flatMap((section) => section.bendPoints ?? []);
      if (projection.edges.some((candidate) => candidate.id === edge.id)) routes.set(edge.id, points);
    }
    if (!ELK_DIRECTION_AWARE_ALGORITHMS.has(options.algorithm) &&
        !["box", "fixed", "rectpacking", "random", "sporeCompaction", "sporeOverlap"].includes(options.algorithm)) {
      emulateEmbeddedFlowDirection(positions, routes, projection.layoutVertices, projection.edges, options.direction);
    }
  }

  const anchorRefinement = optimizeRelativeAnchorPositions(
    projection, positions, anchorCellIds, options.preserveRelativeAnchors
  );
  // Waypoints from the original engine solution can no longer be trusted after a non-orthogonal
  // route's terminals move. Let native Draw.io recalculate those routes rather than applying stale bends.
  if (anchorRefinement.changed && options.edgeRouting !== "ORTHOGONAL") routes.clear();
  return normalizePlan(
    projection, options, documentRevision, positions, routes, retainSourceCoordinates,
    anchorCellIds, anchorRefinement.diagnostics
  );
}
