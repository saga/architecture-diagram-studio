import dagre from "@dagrejs/dagre";
import ELK from "elkjs/lib/elk.bundled.js";
import { inflateSync, unzlibSync } from "fflate";
import { parseDrawioXml } from "../model/drawio-xml-dom";

export type NativeAutoLayoutEngine = "elk" | "dagre";
export type NativeAutoLayoutAlgorithm = "layered" | "mrtree" | "radial" | "stress" | "force";
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

export interface NativeLayoutPlan {
  engine: NativeAutoLayoutEngine;
  algorithm: NativeAutoLayoutAlgorithm;
  direction: NativeAutoLayoutDirection;
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

const elk = new ELK();

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
  if (payload.startsWith("<")) {
    const nested = parseDrawioXml(payload);
    if (nested.documentElement.nodeName === "mxGraphModel") {
      return { model: nested, pageId: page.getAttribute("id") || null, pageTitle: page.getAttribute("name") || null };
    }
  }

  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let inflated: Uint8Array | null = null;
    try { inflated = inflateSync(bytes); } catch { /* Try a zlib-wrapped payload next. */ }
    if (!inflated) {
      try { inflated = unzlibSync(bytes); } catch { /* The payload may not be compressed XML. */ }
    }
    if (inflated) {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
      const candidates = [decoded];
      try {
        const uriDecoded = decodeURIComponent(decoded);
        if (uriDecoded !== decoded) candidates.push(uriDecoded);
      } catch { /* Plain XML does not need URI decoding. */ }
      for (const candidate of candidates) {
        try {
          const nested = parseDrawioXml(candidate);
          if (nested.documentElement.nodeName === "mxGraphModel") {
            return { model: nested, pageId: page.getAttribute("id") || null, pageTitle: page.getAttribute("name") || null };
          }
        } catch { /* Try the next supported representation. */ }
      }
    }
  } catch { /* Report one actionable error below. */ }
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
  const layerIds = new Set(all
    .filter((cell) => cell.parentId === "0" && cell.kind === "other" && cell.visible)
    .map((cell) => cell.id));
  const vertices = all.filter((cell) =>
    cell.kind === "vertex" &&
    cell.hasGeometry &&
    layerIds.has(cell.parentId || "") &&
    cell.visible &&
    cell.width > 0 &&
    cell.height > 0
  );
  const vertexIds = new Set(vertices.map((cell) => cell.id));
  const edges = all.filter((cell) =>
    cell.kind === "edge" &&
    cell.hasGeometry &&
    layerIds.has(cell.parentId || "") &&
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
    engine: options.engine,
    algorithm: options.algorithm,
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
  const projection = projectNativePage(xml, pageId);
  if (projection.vertices.length === 0) {
    throw new Error("No top-level native Draw.io vertices with geometry were found on the active page.");
  }

  const nodeById = new Map(projection.vertices.map((node) => [node.id, node] as const));
  const positions = new Map<string, Point>();
  const routes = new Map<string, Point[]>();

  if (options.engine === "dagre") {
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
    const graphInput = {
      id: "studio-native-layout",
      layoutOptions: {
        "elk.algorithm": options.algorithm,
        "elk.direction": options.direction,
        "elk.spacing.nodeNode": String(options.nodeSpacing),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(options.layerSpacing),
        "elk.edgeRouting": options.edgeRouting,
        "elk.separateConnectedComponents": "true",
        "elk.randomSeed": String(options.randomSeed),
        "elk.stress.iterationLimit": String(options.iterations),
        "elk.force.iterations": String(options.iterations)
      },
      children: projection.vertices.map((node) => ({ id: node.id, width: node.width, height: node.height })),
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
  }

  return normalizePlan(projection, options, documentRevision, positions, routes);
}
