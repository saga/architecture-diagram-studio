import type { NativeAutoLayoutDirection, NativeAutoLayoutEdgeRouting } from "./native-layout";

export type AdditionalLayoutEngine = "graphviz" | "msagl" | "cytoscape" | "d3";
export interface LayoutPoint { x: number; y: number }
export interface LayoutVertex {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LayoutEdge {
  id: string;
  sourceId: string;
  targetId: string;
}
export interface AdditionalLayoutOptions {
  engine: AdditionalLayoutEngine;
  algorithm: string;
  direction: NativeAutoLayoutDirection;
  nodeSpacing: number;
  layerSpacing: number;
  edgeRouting: NativeAutoLayoutEdgeRouting;
  iterations: number;
  randomSeed: number;
  margin: number;
}
export interface AdditionalLayoutResult {
  positions: Map<string, LayoutPoint>;
  routes: Map<string, LayoutPoint[]>;
}

function requirePosition(
  positions: Map<string, LayoutPoint>,
  vertex: LayoutVertex,
  center: LayoutPoint
): void {
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    throw new Error("The selected layout engine returned a non-finite position for " + vertex.id + ".");
  }
  positions.set(vertex.id, { x: center.x - vertex.width / 2, y: center.y - vertex.height / 2 });
}

function graphvizTokens(line: string): string[] {
  return line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g)?.map((token) =>
    token.startsWith('"') && token.endsWith('"')
      ? token.slice(1, -1).replace(/\\(["\\])/g, "$1")
      : token
  ) ?? [];
}

function quoteDot(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n") + '"';
}

type GraphvizInstance = {
  layout(source: string, outputFormat?: string, layoutEngine?: string): string;
};
let graphvizPromise: Promise<GraphvizInstance> | undefined;

async function getGraphviz(): Promise<GraphvizInstance> {
  graphvizPromise ??= import("@hpcc-js/wasm-graphviz").then(async ({ Graphviz }) =>
    await Graphviz.load() as unknown as GraphvizInstance
  );
  return graphvizPromise;
}

async function runGraphviz(
  vertices: LayoutVertex[],
  edges: LayoutEdge[],
  options: AdditionalLayoutOptions
): Promise<AdditionalLayoutResult> {
  const graphviz = await getGraphviz();
  const names = new Map(vertices.map((vertex, index) => [vertex.id, "n" + index] as const));
  const edgeKey = (source: string, target: string) => source + "\u0000" + target;
  const layoutDirection: Record<NativeAutoLayoutDirection, string> = {
    RIGHT: "LR", LEFT: "RL", DOWN: "TB", UP: "BT"
  };
  const edgeRouting = options.edgeRouting === "ORTHOGONAL" ? "ortho" : options.edgeRouting === "SPLINES" ? "true" : "polyline";
  const dot: string[] = [
    "digraph StudioLayout {",
    "graph [rankdir=" + quoteDot(layoutDirection[options.direction]) +
      ", nodesep=" + Math.max(0.05, options.nodeSpacing / 72) +
      ", ranksep=" + Math.max(0.05, options.layerSpacing / 72) +
      ", margin=" + Math.max(0, options.margin / 72) +
      ", splines=" + quoteDot(edgeRouting) +
      ", start=" + options.randomSeed + "];",
    "node [shape=box, fixedsize=true, label=\"\", margin=0];",
    "edge [label=\"\"];"
  ];
  for (const vertex of vertices) {
    dot.push(names.get(vertex.id) + " [width=" + Math.max(0.03, vertex.width / 72) +
      ", height=" + Math.max(0.03, vertex.height / 72) + "];");
  }
  for (const edge of edges) {
    const source = names.get(edge.sourceId);
    const target = names.get(edge.targetId);
    if (!source || !target) continue;
    dot.push(source + " -> " + target + ";");
  }
  dot.push("}");

  const output = graphviz.layout(dot.join("\n"), "plain", options.algorithm);
  const positions = new Map<string, LayoutPoint>();
  const routes = new Map<string, LayoutPoint[]>();
  let graphHeight = 0;
  let scale = 1;
  const pendingEdges: Array<{ source: string; target: string; points: LayoutPoint[] }> = [];
  for (const line of output.split(/\r?\n/)) {
    const token = graphvizTokens(line.trim());
    if (token[0] === "graph") {
      scale = Number(token[1]) || 1;
      graphHeight = Number(token[3]) || 0;
      continue;
    }
    if (token[0] === "node" && token.length >= 6) {
      const alias = token[1];
      const vertex = vertices.find((item) => names.get(item.id) === alias);
      if (!vertex) continue;
      const center = {
        x: Number(token[2]) * 72 * scale,
        y: (graphHeight - Number(token[3])) * 72 * scale
      };
      requirePosition(positions, vertex, center);
      continue;
    }
    if (token[0] === "edge" && token.length >= 4) {
      const count = Number(token[3]);
      if (!Number.isInteger(count) || count < 2 || token.length < 4 + count * 2) continue;
      const points: LayoutPoint[] = [];
      for (let index = 0; index < count; index += 1) {
        const x = Number(token[4 + index * 2]);
        const y = Number(token[5 + index * 2]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        points.push({ x: x * 72 * scale, y: (graphHeight - y) * 72 * scale });
      }
      pendingEdges.push({ source: token[1], target: token[2], points });
    }
  }

  const edgeIdsByAlias = new Map<string, string[]>();
  for (const edge of edges) {
    const source = names.get(edge.sourceId);
    const target = names.get(edge.targetId);
    if (!source || !target) continue;
    const key = edgeKey(source, target);
    const queue = edgeIdsByAlias.get(key) ?? [];
    queue.push(edge.id);
    edgeIdsByAlias.set(key, queue);
  }
  for (const edge of pendingEdges) {
    const ids = edgeIdsByAlias.get(edgeKey(edge.source, edge.target));
    const id = ids?.shift();
    if (id) routes.set(id, edge.points.slice(1, -1));
  }
  if (positions.size !== vertices.length) {
    throw new Error("Graphviz did not return positions for every native Draw.io node.");
  }
  return { positions, routes };
}

async function runMsagl(
  vertices: LayoutVertex[],
  edges: LayoutEdge[],
  options: AdditionalLayoutOptions
): Promise<AdditionalLayoutResult> {
  if (options.algorithm === "mds" && vertices.length > 1000) {
    throw new Error("MSAGL MDS is quadratic for its refinement stage. Use MSAGL Layered or IPSepCola for diagrams above 1,000 nodes.");
  }
  const msagl = await import("@msagl/core");
  const graph = new msagl.Graph("studio-native-layout");
  const nodes = new Map<string, InstanceType<typeof msagl.Node>>();
  for (const vertex of vertices) {
    const node = graph.addNode(new msagl.Node(vertex.id));
    nodes.set(vertex.id, node);
  }

  for (const edge of edges) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) continue;
    // Edge registers itself with both endpoints; GeomEdge creates its native geometry.
    new msagl.GeomEdge(new msagl.Edge(source, target));
  }

  const geomGraph = new msagl.GeomGraph(graph);
  for (const vertex of vertices) {
    const node = nodes.get(vertex.id);
    if (!node) continue;
    const geomNode = new msagl.GeomNode(node);
    geomNode.boundaryCurve = msagl.CurveFactory.mkRectangleWithRoundedCorners(
      Math.max(3, vertex.width), Math.max(2, vertex.height), 4, 4, new msagl.Point(0, 0)
    );
  }

  if (options.algorithm === "layered") {
    const settings = new msagl.SugiyamaLayoutSettings();
    const directionMap = {
      RIGHT: msagl.LayerDirectionEnum.LR,
      LEFT: msagl.LayerDirectionEnum.RL,
      DOWN: msagl.LayerDirectionEnum.TB,
      UP: msagl.LayerDirectionEnum.BT
    };
    settings.layerDirection = directionMap[options.direction];
    settings.LayerSeparation = options.layerSpacing;
    settings.commonSettings.NodeSeparation = options.nodeSpacing;
    geomGraph.layoutSettings = settings;
  } else if (options.algorithm === "mds") {
    const settings = new msagl.MdsLayoutSettings();
    settings.IterationsWithMajorization = Math.min(options.iterations, 100);
    geomGraph.layoutSettings = settings;
  } else {
    const settings = new msagl.FastIncrementalLayoutSettings();
    settings.MaxIterations = options.iterations;
    settings.NodeSeparation = options.nodeSpacing;
    geomGraph.layoutSettings = settings;
  }

  // Use the supported core-layout entry point for all settings. Renderer-specific
  // convenience functions are not part of the core geometry contract.
  msagl.layoutGeomGraph(geomGraph);

  const positions = new Map<string, LayoutPoint>();
  for (const vertex of vertices) {
    const node = nodes.get(vertex.id);
    if (!node) continue;
    const geomNode = msagl.GeomNode.getGeom(node);
    requirePosition(positions, vertex, { x: geomNode.center.x, y: geomNode.center.y });
  }
  if (positions.size !== vertices.length) {
    throw new Error("MSAGL did not return positions for every native Draw.io node.");
  }

  // MSAGL represents routes as geometric curves. Keep the adapter on public, stable node
  // geometry APIs until curve flattening has a tested contract; Draw.io recalculates routes.
  return { positions, routes: new Map() };
}

async function runCytoscape(
  vertices: LayoutVertex[],
  edges: LayoutEdge[],
  options: AdditionalLayoutOptions
): Promise<AdditionalLayoutResult> {
  const cytoscapeModule = await import("cytoscape");
  const cytoscape = cytoscapeModule.default;
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements: [
      ...vertices.map((vertex) => ({ data: { id: vertex.id, width: vertex.width, height: vertex.height } })),
      ...edges.map((edge) => ({ data: { id: edge.id, source: edge.sourceId, target: edge.targetId } }))
    ],
    style: [{ selector: "node", style: { width: "data(width)", height: "data(height)" } }]
  });
  try {
    const spacing = Math.max(options.nodeSpacing, options.layerSpacing);
    const layoutOptions = {
      name: options.algorithm,
      animate: false,
      fit: false,
      padding: options.margin,
      spacingFactor: Math.max(1, spacing / 60),
      nodeDimensionsIncludeLabels: false,
      directed: true,
      avoidOverlap: true,
      nodeRepulsion: () => spacing * spacing * 4,
      idealEdgeLength: () => spacing + Math.max(...vertices.map((vertex) => Math.max(vertex.width, vertex.height))),
      numIter: options.iterations,
      roots: (() => { const candidates = cy.nodes().filter((node) => !edges.some((edge) => edge.targetId === node.id())); return candidates.length ? candidates : cy.nodes().first(); })()
    } as unknown as cytoscape.LayoutOptions;
    const layout = cy.layout(layoutOptions as never);
    // Some Cytoscape layouts (notably CoSE) finish asynchronously even when animation is off.
    // Waiting for layoutstop prevents reading the untouched starting positions.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Cytoscape layout did not finish within 30 seconds.")), 30_000);
      layout.one("layoutstop", () => {
        clearTimeout(timeout);
        resolve();
      });
      layout.run();
    });

    const positions = new Map<string, LayoutPoint>();
    for (const vertex of vertices) {
      const node = cy.getElementById(vertex.id);
      const point = node.position();
      requirePosition(positions, vertex, { x: point.x, y: point.y });
    }
    return { positions, routes: new Map() };
  } finally {
    cy.destroy();
  }
}

interface HierarchyDatum {
  id: string | null;
  children?: HierarchyDatum[];
}

function buildHierarchy(vertices: LayoutVertex[], edges: LayoutEdge[]): HierarchyDatum {
  const outgoing = new Map(vertices.map((vertex) => [vertex.id, [] as string[]]));
  const incoming = new Set<string>();
  for (const edge of edges) {
    if (!outgoing.has(edge.sourceId) || !outgoing.has(edge.targetId) || edge.sourceId === edge.targetId) continue;
    outgoing.get(edge.sourceId)!.push(edge.targetId);
    incoming.add(edge.targetId);
  }
  for (const children of outgoing.values()) children.sort((a, b) => a.localeCompare(b));
  const visited = new Set<string>();
  const build = (id: string): HierarchyDatum => {
    visited.add(id);
    const children = (outgoing.get(id) ?? [])
      .filter((child) => !visited.has(child))
      .map((child) => build(child));
    return children.length ? { id, children } : { id };
  };
  const roots = [
    ...vertices.filter((vertex) => !incoming.has(vertex.id)).map((vertex) => vertex.id).sort((a, b) => a.localeCompare(b)),
    ...vertices.map((vertex) => vertex.id).sort((a, b) => a.localeCompare(b))
  ];
  const forest: HierarchyDatum[] = [];
  for (const id of roots) if (!visited.has(id)) forest.push(build(id));
  return { id: null, children: forest };
}

async function runD3(
  vertices: LayoutVertex[],
  edges: LayoutEdge[],
  options: AdditionalLayoutOptions
): Promise<AdditionalLayoutResult> {
  if (options.algorithm === "force") {
    const d3 = await import("d3-force");
    type ForceNode = { id: string; width: number; height: number; x: number; y: number; vx?: number; vy?: number; index?: number };
    type ForceLink = { source: string | ForceNode; target: string | ForceNode };
    let randomState = (options.randomSeed >>> 0) || 1;
    const random = () => {
      randomState = (1664525 * randomState + 1013904223) >>> 0;
      return randomState / 4294967296;
    };
    const scale = Math.max(options.nodeSpacing, options.layerSpacing);
    const nodes: ForceNode[] = vertices.map((vertex, index) => ({
      id: vertex.id,
      width: vertex.width,
      height: vertex.height,
      x: (random() - 0.5) * scale * Math.sqrt(vertices.length) + index * 0.001,
      y: (random() - 0.5) * scale * Math.sqrt(vertices.length)
    }));
    const links: ForceLink[] = edges
      .filter((edge) => vertices.some((vertex) => vertex.id === edge.sourceId) && vertices.some((vertex) => vertex.id === edge.targetId))
      .map((edge) => ({ source: edge.sourceId, target: edge.targetId }));
    const simulation = d3.forceSimulation<ForceNode>(nodes)
      .randomSource(random)
      .force("link", d3.forceLink<ForceNode, ForceLink>(links)
        .id((node) => node.id)
        .distance(scale + Math.max(...vertices.map((vertex) => Math.max(vertex.width, vertex.height)))))
      .force("charge", d3.forceManyBody<ForceNode>().strength(-scale * 4))
      .force("center", d3.forceCenter<ForceNode>(0, 0))
      .force("collide", d3.forceCollide<ForceNode>()
        .radius((node) => Math.max(node.width, node.height) / 2 + options.nodeSpacing / 2))
      .stop();
    for (let iteration = 0; iteration < options.iterations; iteration += 1) simulation.tick();
    const positions = new Map<string, LayoutPoint>();
    for (const node of nodes) {
      const vertex = vertices.find((item) => item.id === node.id);
      if (vertex) requirePosition(positions, vertex, { x: node.x, y: node.y });
    }
    return { positions, routes: new Map() };
  }

  const hierarchyLib = await import("d3-hierarchy");
  const data = buildHierarchy(vertices, edges);
  const hierarchy = hierarchyLib.hierarchy(data);
  const maxWidth = Math.max(...vertices.map((vertex) => vertex.width));
  const maxHeight = Math.max(...vertices.map((vertex) => vertex.height));
  const layout = options.algorithm === "cluster"
    ? hierarchyLib.cluster<HierarchyDatum>().nodeSize([maxWidth + options.nodeSpacing, maxHeight + options.layerSpacing])
    : hierarchyLib.tree<HierarchyDatum>().nodeSize([maxWidth + options.nodeSpacing, maxHeight + options.layerSpacing]);
  layout(hierarchy);

  const vertexById = new Map(vertices.map((vertex) => [vertex.id, vertex] as const));
  const positions = new Map<string, LayoutPoint>();
  for (const item of hierarchy.descendants()) {
    if (!item.data.id) continue;
    const vertex = vertexById.get(item.data.id);
    if (!vertex) continue;
    if (typeof item.x !== "number" || typeof item.y !== "number") {
      throw new Error("D3 hierarchy layout returned a node without coordinates.");
    }
    const itemX = item.x;
    const itemY = item.y;
    let center: LayoutPoint;
    switch (options.direction) {
      case "RIGHT": center = { x: itemY, y: itemX }; break;
      case "LEFT": center = { x: -itemY, y: itemX }; break;
      case "DOWN": center = { x: itemX, y: itemY }; break;
      case "UP": center = { x: itemX, y: -itemY }; break;
    }
    requirePosition(positions, vertex, center);
  }
  if (positions.size !== vertices.length) {
    throw new Error("D3 hierarchy layout did not return positions for every native Draw.io node.");
  }
  return { positions, routes: new Map() };
}

export async function calculateAdditionalNativeLayout(
  vertices: LayoutVertex[],
  edges: LayoutEdge[],
  options: AdditionalLayoutOptions
): Promise<AdditionalLayoutResult> {
  switch (options.engine) {
    case "graphviz": return runGraphviz(vertices, edges, options);
    case "msagl": return runMsagl(vertices, edges, options);
    case "cytoscape": return runCytoscape(vertices, edges, options);
    case "d3": return runD3(vertices, edges, options);
  }
}
