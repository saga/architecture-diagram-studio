import dagre from "@dagrejs/dagre";
import ELK from "elkjs/lib/elk.bundled.js";
import { calculateAdditionalNativeLayout, type AdditionalLayoutEngine } from "./additional-layout-engines";
import { parseDrawioXml } from "../model/drawio-xml-dom";
import { decodeDrawioPageXml } from "../model/drawio-xml-schema";

export const NATIVE_AUTO_LAYOUT_ENGINES = ["elk", "dagre", "graphviz", "msagl", "cytoscape", "d3"] as const;
export type NativeAutoLayoutEngine = (typeof NATIVE_AUTO_LAYOUT_ENGINES)[number];
export const NATIVE_AUTO_LAYOUT_ALGORITHMS = [
  "layered", "mrtree", "radial", "stress", "force", "box", "rectpacking", "random", "disco", "sporeCompaction", "sporeOverlap",
  "dot", "neato", "fdp", "sfdp", "circo", "twopi",
  "mds", "ipsepcola",
  "breadthfirst", "circle", "concentric", "grid", "cose",
  "tree", "cluster"
] as const;
export type NativeAutoLayoutAlgorithm = (typeof NATIVE_AUTO_LAYOUT_ALGORITHMS)[number];

export const NATIVE_LAYOUT_ALGORITHMS_BY_ENGINE: Record<NativeAutoLayoutEngine, Array<{ value: NativeAutoLayoutAlgorithm; label: string }>> = {
  elk: [
    { value: "layered", label: "Layered · flow" }, { value: "mrtree", label: "Mr. Tree" },
    { value: "radial", label: "Radial" }, { value: "stress", label: "Stress · relationships" },
    { value: "force", label: "Force · organic" }, { value: "disco", label: "DisCo · connected components" },
    { value: "box", label: "Box packing" }, { value: "rectpacking", label: "Rectangle packing" },
    { value: "random", label: "Randomizer" }, { value: "sporeCompaction", label: "SPOrE · compact" },
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
  if (engine === "elk") return !["box", "rectpacking", "random", "sporeCompaction", "sporeOverlap"].includes(algorithm);
  // Non-layered adapters without a native direction setting use the shared coordinate transform.
  return true;
}
export type NativeAutoLayoutDirection = "RIGHT" | "LEFT" | "DOWN" | "UP";
export type NativeAutoLayoutEdgeRouting = "ORTHOGONAL" | "POLYLINE" | "SPLINES";

export interface NativeAutoLayoutOptions {
  engine: NativeAutoLayoutEngine;
  algorithm: NativeAutoLayoutAlgorithm;
  direction: NativeAutoLayoutDirection;
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
  nodeSpacing: 64,
  layerSpacing: 90,
  edgeRouting: "ORTHOGONAL",
  iterations: 300,
  randomSeed: 1,
  margin: 30
};

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

export interface NativeLayoutPlan extends NativeAutoLayoutOptions {
  documentRevision: string;
  pageId: string | null;
  /** Every native cell ID on the source page, used for an optimistic stale-page check. */
  expectedPageCellIds: string[];
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
  kind: "vertex" | "edge" | "other";
  x: number;
  y: number;
  width: number;
  height: number;
  hasGeometry: boolean;
  visible: boolean;
}

interface NativePageProjection {
  pageId: string | null;
  pageTitle: string | null;
  allCellIds: string[];
  vertices: ProjectedCell[];
  edges: ProjectedCell[];
}

interface Point { x: number; y: number }

interface ElkLayoutResult {
  children?: Array<{ id: string; x?: number; y?: number }>;
  edges?: Array<{ id: string; sections?: Array<{ bendPoints?: Point[] }> }>;
}

// Explicitly register algorithms shipped in the bundled ELK build. Box, Random and Fixed
// are always included by elkjs; DisCo, Rectpacking and SPOrE are opt-in registrations.
const elk = new ELK({
  algorithms: ["layered", "stress", "mrtree", "radial", "force", "disco", "rectpacking", "sporeCompaction", "sporeOverlap"]
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

function parseGraphModel(xml: string, requestedPageId: string | null): { model: Document; pageId: string | null; pageTitle: string | null } {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  if (root.nodeName === "mxGraphModel") return { model: document, pageId: null, pageTitle: null };
  if (root.nodeName !== "mxfile") throw new Error("Auto layout only supports native Draw.io mxfile or mxGraphModel documents.");

  const diagrams = Array.from(document.getElementsByTagName("diagram"));
  const page = requestedPageId
    ? diagrams.find((candidate) => candidate.getAttribute("id") === requestedPageId)
    : diagrams[0];
  if (!page) {
    throw new Error(requestedPageId
      ? "The selected Draw.io page no longer exists. Select the page again before laying it out."
      : "The Draw.io document has no pages to lay out.");
  }

  const inlineModel = page.getElementsByTagName("mxGraphModel").item(0);
  if (inlineModel) {
    return {
      model: inlineModel as unknown as Document,
      pageId: page.getAttribute("id") || null,
      pageTitle: page.getAttribute("name") || null
    };
  }

  const payload = (page.textContent || "").trim();
  if (!payload) throw new Error("The selected Draw.io page has no readable graph model.");
  try {
    const nested = parseDrawioXml(decodeDrawioPageXml(payload));
    if (nested.documentElement.nodeName === "mxGraphModel") {
      return { model: nested, pageId: page.getAttribute("id") || null, pageTitle: page.getAttribute("name") || null };
    }
  } catch {
    // The shared decoder enforces XML validity and the decompressed-page size limit.
  }
  throw new Error("The selected Draw.io page could not be decoded for layout. Open and save it with the bundled Draw.io editor, then retry.");
}

function projectNativePage(xml: string, requestedPageId: string | null): NativePageProjection {
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
      visible: cell.getAttribute("visible") !== "0"
    };
    // Draw.io wrappers may expose both a wrapper ID and an mxCell ID. The active mxGraph
    // model resolves a cell by its effective ID, which is the wrapper ID when present.
    byId.set(id, projected);
    seenCellIds.add(id);
  }

  const all = Array.from(byId.values());
  // Lay out one native layer at a time. The first root-level layer in mxGraphModel is Draw.io's
  // default layer (normally ID "1"); cells in other layers and nested groups remain untouched.
  const defaultLayer = all.find((cell) => cell.parentId === "0" && cell.kind === "other" && cell.visible);
  const defaultLayerId = defaultLayer?.id ?? null;
  const vertices = all.filter((cell) =>
    cell.kind === "vertex" &&
    cell.hasGeometry &&
    cell.parentId === defaultLayerId &&
    cell.visible &&
    cell.width > 0 &&
    cell.height > 0
  );
  const vertexIds = new Set(vertices.map((cell) => cell.id));
  const edges = all.filter((cell) =>
    cell.kind === "edge" &&
    cell.hasGeometry &&
    cell.parentId === defaultLayerId &&
    cell.visible &&
    cell.sourceId &&
    cell.targetId &&
    vertexIds.has(cell.sourceId) &&
    vertexIds.has(cell.targetId)
  );

  return {
    pageId: parsed.pageId,
    pageTitle: parsed.pageTitle,
    allCellIds: Array.from(seenCellIds).sort(),
    vertices,
    edges
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
    const source = edge.sourceId ? centers.get(edge.sourceId) : undefined;
    const target = edge.targetId ? centers.get(edge.targetId) : undefined;
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

function normalizePlan(
  projection: NativePageProjection,
  options: NativeAutoLayoutOptions,
  documentRevision: string,
  positions: Map<string, Point>,
  routes: Map<string, Point[]>
): NativeLayoutPlan {
  if (projection.vertices.length === 0) {
    throw new Error("No top-level native Draw.io vertices with geometry were found on the active page. Nested group contents and nonstandard cells are intentionally left untouched.");
  }
  if (positions.size !== projection.vertices.length ||
      projection.vertices.some((vertex) => !positions.has(vertex.id))) {
    throw new Error("The layout engine did not return a position for every target vertex; no changes were applied.");
  }

  const minX = Math.min(...projection.vertices.map((cell) => positions.get(cell.id)!.x));
  const minY = Math.min(...projection.vertices.map((cell) => positions.get(cell.id)!.y));
  const dx = options.margin - minX;
  const dy = options.margin - minY;
  const finiteCoordinate = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1_000_000;
  const nativePositions = projection.vertices.map((cell) => {
    const point = positions.get(cell.id)!;
    const x = point.x + dx;
    const y = point.y + dy;
    if (!finiteCoordinate(x) || !finiteCoordinate(y)) throw new Error("The layout engine returned an invalid node coordinate.");
    return { cellId: cell.id, x, y };
  });
  const nativeRoutes: NativeLayoutEdgeRoute[] = [];
  for (const edge of projection.edges) {
    // An empty route explicitly clears stale waypoints left by a prior manual/automatic layout.
    const points = routes.get(edge.id) ?? [];
    const translated = points.map((point) => ({ x: point.x + dx, y: point.y + dy }));
    if (translated.some((point) => !finiteCoordinate(point.x) || !finiteCoordinate(point.y))) {
      throw new Error("The layout engine returned an invalid connector route.");
    }
    nativeRoutes.push({ cellId: edge.id, points: translated });
  }

  const cellsToGuard = new Map<string, NativeLayoutExpectedCell>();
  for (const vertex of projection.vertices) cellsToGuard.set(vertex.id, {
    cellId: vertex.id, kind: "vertex", x: vertex.x, y: vertex.y,
    width: vertex.width, height: vertex.height, parentId: vertex.parentId,
    sourceId: null, targetId: null
  });
  for (const edge of projection.edges) cellsToGuard.set(edge.id, {
    cellId: edge.id, kind: "edge", x: edge.x, y: edge.y,
    width: edge.width, height: edge.height, parentId: edge.parentId,
    sourceId: edge.sourceId, targetId: edge.targetId
  });

  return {
    ...options,
    direction: mapDirection(options.direction),
    documentRevision,
    pageId: projection.pageId,
    expectedPageCellIds: projection.allCellIds,
    expectedCells: Array.from(cellsToGuard.values()),
    positions: nativePositions,
    edgeRoutes: nativeRoutes
  };
}

/** Calculate geometry from a disposable projection of native Draw.io mxCells. This never
 * creates a persisted graph model or serializes XML; only the returned plan is sent back
 * to the live Draw.io editor for a revision/page checked native mutation. */
export async function calculateNativeAutoLayout(
  xml: string,
  pageId: string | null,
  documentRevision: string,
  options: NativeAutoLayoutOptions
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
  const projection = projectNativePage(xml, pageId);
  if (projection.vertices.length === 0) {
    throw new Error("No top-level native Draw.io vertices with geometry were found on the active page.");
  }

  if (options.engine === "elk" && (options.algorithm === "box" || options.algorithm === "rectpacking") && projection.edges.length > 0) {
    throw new Error("ELK Box and Rectangle packing are intended for unconnected nodes. Choose a graph layout algorithm for diagrams with connectors.");
  }

  const nodeById = new Map(projection.vertices.map((node) => [node.id, node] as const));
  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();

  if (options.engine === "graphviz" || options.engine === "msagl" || options.engine === "cytoscape" || options.engine === "d3") {
    const result = await calculateAdditionalNativeLayout(
      projection.vertices,
      projection.edges.filter((edge) => edge.sourceId && edge.targetId).map((edge) => ({
        id: edge.id, sourceId: edge.sourceId!, targetId: edge.targetId!
      })),
      { ...options, engine: options.engine as AdditionalLayoutEngine }
    );
    for (const [id, point] of result.positions) positions.set(id, point);
    for (const [id, points] of result.routes) routes.set(id, points);
    if (options.engine === "cytoscape" ||
        (options.engine === "graphviz" && options.algorithm !== "dot") ||
        (options.engine === "d3" && options.algorithm === "force") ||
        (options.engine === "msagl" && options.algorithm !== "layered")) {
      emulateEmbeddedFlowDirection(positions, routes, projection.vertices, projection.edges, options.direction);
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
    for (const node of projection.vertices) graph.setNode(node.id, { width: node.width, height: node.height });
    for (const edge of projection.edges) {
      if (edge.sourceId && edge.targetId) graph.setEdge(edge.sourceId, edge.targetId, {}, edge.id);
    }
    dagre.layout(graph);
    for (const node of projection.vertices) {
      const point = graph.node(node.id) as { x: number; y: number } | undefined;
      if (!point) throw new Error("Dagre did not return a position for native cell " + node.id + ".");
      positions.set(node.id, { x: point.x - node.width / 2, y: point.y - node.height / 2 });
    }
    for (const edge of projection.edges) {
      if (!edge.sourceId || !edge.targetId) continue;
      const result = graph.edge({ v: edge.sourceId, w: edge.targetId, name: edge.id }) as { points?: Point[] } | undefined;
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
      const maxVertexWidth = Math.max(...projection.vertices.map((vertex) => vertex.width));
      const maxVertexHeight = Math.max(...projection.vertices.map((vertex) => vertex.height));
      layoutOptions["elk.stress.desiredEdgeLength"] = String(
        Math.max(options.nodeSpacing, options.layerSpacing) + (maxVertexWidth + maxVertexHeight) / 2
      );
    }
    if (options.algorithm === "disco") {
      // DisCo packs components but does not lay out their contents by default. Use Layered
      // within each component, then let DisCo arrange the component outlines.
      layoutOptions["elk.disco.componentCompaction.componentLayoutAlgorithm"] = "org.eclipse.elk.layered";
      layoutOptions["elk.spacing.componentComponent"] = String(options.layerSpacing);
    }
    if (options.algorithm === "sporeCompaction" || options.algorithm === "sporeOverlap") {
      layoutOptions["elk.spacing.nodeNode"] = String(options.nodeSpacing);
    }
    const graphInput = {
      id: "studio-native-layout",
      layoutOptions,
      children: projection.vertices.map((node) => ({
        id: node.id, width: node.width, height: node.height,
        // SPOrE is a post-layout optimizer; seed it with the existing native positions.
        ...(["sporeCompaction", "sporeOverlap"].includes(options.algorithm) ? { x: node.x, y: node.y } : {})
      })),
      edges: projection.edges
        .filter((edge) => edge.sourceId && edge.targetId)
        .map((edge) => ({ id: edge.id, sources: [edge.sourceId!], targets: [edge.targetId!] }))
    };
    const result = await elk.layout(graphInput as never) as unknown as ElkLayoutResult;
    for (const node of result.children ?? []) {
      if (!nodeById.has(node.id) || !Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      positions.set(node.id, { x: Number(node.x), y: Number(node.y) });
    }
    for (const edge of result.edges ?? []) {
      const points = (edge.sections ?? []).flatMap((section) => section.bendPoints ?? []);
      if (projection.edges.some((candidate) => candidate.id === edge.id)) routes.set(edge.id, points);
    }
    if (!ELK_DIRECTION_AWARE_ALGORITHMS.has(options.algorithm) &&
        !["box", "rectpacking", "random", "sporeCompaction", "sporeOverlap"].includes(options.algorithm)) {
      emulateEmbeddedFlowDirection(positions, routes, projection.vertices, projection.edges, options.direction);
    }
  }

  return normalizePlan(projection, options, documentRevision, positions, routes);
}
