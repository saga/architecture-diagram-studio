export const PINNED_DRAWIO_VERSION = "v32.0.2";
export const DRAWIO_RUNTIME_BRIDGE_VERSION = "studio-native-runtime/3";

export const PINNED_RUNTIME_CAPABILITY_REQUIREMENTS = {
  graph: ["getModel", "getDefaultParent", "getChildCells", "setCellStyles", "insertVertex", "insertEdge", "removeCells", "refresh", "convertValueToString"],
  model: ["getRoot", "getChildCount", "getChildAt", "getCell", "getStyle", "setStyle", "setValue", "setGeometry", "setTerminal", "beginUpdate", "endUpdate"],
  view: ["getState", "validate"]
} as const;

export const RUNTIME_INSPECTION_LIMITS = {
  cells: 60,
  renderedEdges: 24,
  methodsPerObject: 180,
  geometryPoints: 8,
  renderedPoints: 12,
  jsShapeClassNames: 40,
  jsShapeClassNameLength: 160
} as const;

export type RuntimeCapabilityGroup = "ui" | "editor" | "graph" | "model" | "view" | "vertexCell" | "edgeCell";

export interface RuntimeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  relative: boolean;
  points: Array<{ x: number; y: number }>;
}

export interface DrawioRuntimeCell {
  id: string;
  parentId: string | null;
  kind: "vertex" | "edge" | "cell";
  label: string;
  style: string;
  sourceId: string | null;
  targetId: string | null;
  connectable: boolean | null;
  visible: boolean | null;
  collapsed: boolean | null;
  childCount: number;
  geometry: RuntimeGeometry | null;
}

export interface DrawioJavaScriptShapeClassManifest {
  /** Names queried against mxCellRenderer.defaultShapes in the live iframe. */
  requested: string[];
  /** One explicit registration result for each requested shape name. */
  registered: Record<string, boolean>;
}

export interface DrawioRuntimeInspection {
  schemaVersion: 1;
  capabilityManifest: {
    scriptSupported: boolean;
    required: Partial<Record<RuntimeCapabilityGroup, string[]>>;
    missing: Partial<Record<RuntimeCapabilityGroup, string[]>>;
    jsShapeClasses: DrawioJavaScriptShapeClassManifest;
  };
  bridgeVersion: string;
  drawioVersion: string;
  documentRevision: string;
  pageId: string | null;
  capabilities: Record<RuntimeCapabilityGroup, string[]>;
  counts: { cells: number; vertices: number; edges: number };
  cells: DrawioRuntimeCell[];
  renderedEdges: Array<{
    id: string;
    stateAvailable: boolean;
    absolutePoints: Array<{ x: number; y: number }>;
    collinear: boolean | null;
  }>;
  truncated: boolean;
}

export interface RuntimeInspectionExpectation {
  documentRevision?: string;
  pageId?: string | null;
  drawioVersion?: string;
}

const CAPABILITY_GROUPS: RuntimeCapabilityGroup[] = [
  "ui", "editor", "graph", "model", "view", "vertexCell", "edgeCell"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown, maxLength: number): string | null {
  return typeof value === "string" ? value.slice(0, maxLength) : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizePoints(value: unknown, limit: number): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, limit).flatMap((point) => {
    if (!isRecord(point) || typeof point.x !== "number" || !Number.isFinite(point.x) ||
        typeof point.y !== "number" || !Number.isFinite(point.y)) return [];
    return [{ x: point.x, y: point.y }];
  });
}

function normalizeGeometry(value: unknown): RuntimeGeometry | null {
  if (!isRecord(value)) return null;
  return {
    x: finiteNumber(value.x),
    y: finiteNumber(value.y),
    width: finiteNumber(value.width),
    height: finiteNumber(value.height),
    relative: value.relative === true,
    points: normalizePoints(value.points, RUNTIME_INSPECTION_LIMITS.geometryPoints)
  };
}

/**
 * Validate and bound iframe-provided inspection data before including it in an Agent prompt.
 * This is a context-quality check, not a security boundary or authorization decision.
 */
export function normalizeDrawioRuntimeInspection(
  value: unknown,
  expected: RuntimeInspectionExpectation = {}
): DrawioRuntimeInspection | null {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      value.bridgeVersion !== DRAWIO_RUNTIME_BRIDGE_VERSION ||
      value.drawioVersion !== PINNED_DRAWIO_VERSION) return null;

  const documentRevision = typeof value.documentRevision === "string" ? value.documentRevision : "";
  if (!/^[a-f0-9]{64}$/i.test(documentRevision)) return null;
  if (expected.documentRevision && documentRevision !== expected.documentRevision) return null;

  const pageId = stringOrNull(value.pageId, 200);
  if (expected.pageId !== undefined && pageId !== expected.pageId) return null;

  const rawCapabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const capabilities = {} as Record<RuntimeCapabilityGroup, string[]>;
  for (const group of CAPABILITY_GROUPS) {
    const methods = rawCapabilities[group];
    capabilities[group] = Array.isArray(methods)
      ? [...new Set(methods.filter((method): method is string =>
          typeof method === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(method)
        ).slice(0, RUNTIME_INSPECTION_LIMITS.methodsPerObject))]
      : [];
  }

  const rawManifest = isRecord(value.capabilityManifest) ? value.capabilityManifest : {};
  const normalizeMethodGroups = (candidate: unknown): Partial<Record<RuntimeCapabilityGroup, string[]>> => {
    const source = isRecord(candidate) ? candidate : {};
    const output: Partial<Record<RuntimeCapabilityGroup, string[]>> = {};
    for (const group of CAPABILITY_GROUPS) {
      const methods = source[group];
      if (Array.isArray(methods)) {
        output[group] = [...new Set(methods.filter((method): method is string =>
          typeof method === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(method)
        ).slice(0, RUNTIME_INSPECTION_LIMITS.methodsPerObject))];
      }
    }
    return output;
  };
  const rawCounts = isRecord(value.counts) ? value.counts : {};
  const count = (key: "cells" | "vertices" | "edges") => {
    const number = rawCounts[key];
    return typeof number === "number" && Number.isFinite(number) ? Math.max(0, Math.min(1_000_000, Math.floor(number))) : 0;
  };

  const cells: DrawioRuntimeCell[] = Array.isArray(value.cells)
    ? value.cells.slice(0, RUNTIME_INSPECTION_LIMITS.cells).flatMap((cell): DrawioRuntimeCell[] => {
        if (!isRecord(cell) || typeof cell.id !== "string" || !cell.id || cell.id.length > 200) return [];
        const kind = cell.kind === "vertex" || cell.kind === "edge" ? cell.kind : "cell";
        return [{
          id: cell.id,
          parentId: stringOrNull(cell.parentId, 200),
          kind,
          label: typeof cell.label === "string" ? cell.label.slice(0, 250) : "",
          style: typeof cell.style === "string" ? cell.style.slice(0, 400) : "",
          sourceId: stringOrNull(cell.sourceId, 200),
          targetId: stringOrNull(cell.targetId, 200),
          connectable: booleanOrNull(cell.connectable),
          visible: booleanOrNull(cell.visible),
          collapsed: booleanOrNull(cell.collapsed),
          childCount: Math.max(0, Math.min(100_000, Math.floor(finiteNumber(cell.childCount)))),
          geometry: normalizeGeometry(cell.geometry)
        }];
      })
    : [];

  const renderedEdges: DrawioRuntimeInspection["renderedEdges"] = Array.isArray(value.renderedEdges)
    ? value.renderedEdges.slice(0, RUNTIME_INSPECTION_LIMITS.renderedEdges).flatMap((edge) => {
        if (!isRecord(edge) || typeof edge.id !== "string" || !edge.id || edge.id.length > 200) return [];
        return [{
          id: edge.id,
          stateAvailable: edge.stateAvailable === true,
          absolutePoints: normalizePoints(edge.absolutePoints, RUNTIME_INSPECTION_LIMITS.renderedPoints),
          collinear: booleanOrNull(edge.collinear)
        }];
      })
    : [];

  const requiredGroups = normalizeMethodGroups(rawManifest.required);
  const missingGroups = normalizeMethodGroups(rawManifest.missing);
  const rawJsShapeClasses = isRecord(rawManifest.jsShapeClasses) ? rawManifest.jsShapeClasses : {};
  const requestedJsShapeClassNames = Array.isArray(rawJsShapeClasses.requested)
    ? [...new Set(rawJsShapeClasses.requested.slice(0, RUNTIME_INSPECTION_LIMITS.jsShapeClassNames * 4).filter((name): name is string =>
        typeof name === "string" &&
        name.length <= RUNTIME_INSPECTION_LIMITS.jsShapeClassNameLength &&
        /^[A-Za-z0-9_$:.-]{1,160}$/.test(name) &&
        !["__proto__", "constructor", "prototype"].includes(name)
      ))].slice(0, RUNTIME_INSPECTION_LIMITS.jsShapeClassNames)
    : [];
  const rawRegisteredShapes = isRecord(rawJsShapeClasses.registered) ? rawJsShapeClasses.registered : {};
  const registeredJsShapeClasses: Record<string, boolean> = {};
  for (const name of requestedJsShapeClassNames) registeredJsShapeClasses[name] = rawRegisteredShapes[name] === true;
  const manifestMatchesContract = (Object.keys(PINNED_RUNTIME_CAPABILITY_REQUIREMENTS) as Array<keyof typeof PINNED_RUNTIME_CAPABILITY_REQUIREMENTS>)
    .every((group) => {
      const advertisedRequired = requiredGroups[group] ?? [];
      const missing = missingGroups[group] ?? [];
      const actuallyAvailable = capabilities[group] ?? [];
      return PINNED_RUNTIME_CAPABILITY_REQUIREMENTS[group].every((method) =>
        advertisedRequired.includes(method) && actuallyAvailable.includes(method) && !missing.includes(method)
      );
    });
  return {
    schemaVersion: 1,
    capabilityManifest: {
      scriptSupported: rawManifest.scriptSupported === true && manifestMatchesContract,
      required: requiredGroups,
      missing: missingGroups,
      jsShapeClasses: { requested: requestedJsShapeClassNames, registered: registeredJsShapeClasses }
    },
    bridgeVersion: DRAWIO_RUNTIME_BRIDGE_VERSION,
    drawioVersion: PINNED_DRAWIO_VERSION,
    documentRevision,
    pageId,
    capabilities,
    counts: { cells: count("cells"), vertices: count("vertices"), edges: count("edges") },
    cells,
    renderedEdges,
    truncated: value.truncated === true ||
      (Array.isArray(value.cells) && value.cells.length > RUNTIME_INSPECTION_LIMITS.cells) ||
      (Array.isArray(value.renderedEdges) && value.renderedEdges.length > RUNTIME_INSPECTION_LIMITS.renderedEdges)
  };
}
