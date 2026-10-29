import { findDrawioElements, parseDrawioXml, type DrawioDomDocument } from "./drawio-xml-dom";
import { decodeDrawioPageXml } from "./drawio-xml-schema";
import { z } from "zod";
import { DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, NATIVE_AUTO_LAYOUT_ENGINES, NATIVE_AUTO_LAYOUT_ALGORITHMS, defaultNativeLayoutAlgorithm, nativeLayoutSupportsAlgorithm, type NativeAutoLayoutEngine, type NativeLayoutPlan } from "../layout/native-layout";

/**
 * Shared contract for native Draw.io cell edits.
 *
 * The same operation list is produced by the Copilot agent, validated by the server and
 * executed by the browser through the native bridge. Keeping one schema here prevents the
 * model, the server and the client from drifting into separate vocabularies.
 */
export const NATIVE_EDIT_STYLE_KEYS = ["fillColor", "strokeColor", "fontColor"] as const;
export type NativeEditStyleKey = (typeof NATIVE_EDIT_STYLE_KEYS)[number];

/** The bridge batch caps at 50 steps; typed moves are a single live-geometry delta. */
export const MAX_NATIVE_EDIT_OPERATIONS = 20;

export type NativeEditOperation = z.infer<typeof NativeEditOperationSchema>;

/** An operation whose target label was resolved to a concrete Draw.io cell by the server. */
export type ResolvedNativeEditOperation = NativeEditOperation & { cellId: string; targetLabel: string };

export interface NativeCellEdit {
  cellId: string;
  path: string;
  value: string;
}

export interface NativeBatchStepResult {
  index: number;
  cellId: string;
  path: string;
  value: string;
  success: boolean;
  error?: string;
  stack?: string;
}

/** Outcome of one atomic bridge batch, as reported by the native editor. */
export interface NativeEditExecution {
  ok: boolean;
  error?: string;
  /** Original JavaScript/editor stack trace for a failed operation, bounded by the native bridge. */
  errorStack?: string;
  /** Distinguishes a native editor rejection from a successful edit whose required save failed. */
  failureStage?: "editor" | "persistence";
  /** The local edit may be saved even if its final audit receipt could not be accepted by the server. */
  auditWarning?: string;
  /** Bounded return value from a native Draw.io script, when one was supplied. */
  scriptResult?: unknown;
  /** Semantic before/after XML result for a validated native script. */
  semanticChanged?: boolean;
  /** Bounded field-level XML assertion failures from native script verification. */
  assertionFailures?: NativeScriptXmlAssertionFailure[];
  /** Bounded undeclared/unproven native cell changes from the before/after XML diff. */
  scopeViolations?: NativeScriptScopeViolation[];
  /** Distinguishes a verified edit from a changed document whose requested postconditions remain unknown. */
  applicationState?: "applied-and-verified" | "changed-unverified" | "not-applied" | "unknown";
  rolledBack: boolean;
  steps: NativeBatchStepResult[];
}

export type NativeEditParseResult =
  | { ok: true; operations: NativeEditOperation[] }
  | { ok: false; error: string };

export interface NativeEditTarget {
  id: string;
  name: string;
  cellType: "vertex" | "edge";
  /** Native mxGraph shape style key, e.g. mxgraph.floorplan.table. */
  shape?: string;
  /** Rounded native geometry in the active page coordinate system. */
  geometry?: { x: number; y: number; width: number; height: number };
  rotation?: number;
  parentId?: string;
}

export interface NativeDiagramPageInfo {
  id: string | null;
  title: string | null;
}

/** True only when the XML root is a single graph model, not a multi-page mxfile. */
export function isBareNativeGraphModel(xml: string): boolean {
  try {
    return parseDrawioXml(xml).documentElement.nodeName === "mxGraphModel";
  } catch {
    return false;
  }
}

/**
 * Page identity of the document a caller is addressing.
 *
 * Studio and Draw.io disagree about bare `<mxGraphModel>` documents: the XML holds exactly one
 * page and declares no page ID, while the live editor reports a UUID it generated. Comparing one
 * layer's ID against the other rejects valid work, so callers read the identity for their own
 * layer instead of re-deriving the bare-model exception at each comparison:
 *
 * - `documentPageId` — what the XML declares. Use it for requests, proposals, plans and any
 *   comparison against a document revision. It is null for bare models.
 * - `runtimePageId` — what addresses the page inside the live editor, which is the editor UUID
 *   for bare models and the declared page ID otherwise.
 */
export interface NativePageIdentity {
  /** True when the XML root is a bare `<mxGraphModel>` with one implicit page. */
  bare: boolean;
  /** Page ID declared by the mxfile envelope; null for bare models. */
  declaredPageId: string | null;
  /** Page title declared by the envelope, when the page is known. */
  title: string | null;
  /** Identity to persist or compare against XML: null for bare models. */
  documentPageId: string | null;
  /** Identity the live editor uses: the editor UUID for bare models, the declared ID otherwise. */
  runtimePageId: string | null;
  /** False when an mxfile has no page matching the runtime ID, or several pages and no ID. */
  pageExists: boolean;
}

function readPageInfo(parsed: DrawioDomDocument, pageId: string | null): NativeDiagramPageInfo {
  if (parsed.documentElement.nodeName !== "mxfile") return { id: null, title: null };
  const diagrams = Array.from(parsed.getElementsByTagName("diagram"));
  const page = pageId !== null
    ? diagrams.find((item) => item.getAttribute("id") === pageId)
    : diagrams.length === 1 ? diagrams[0] : undefined;
  if (!page) return { id: null, title: null };
  return {
    id: page.getAttribute("id") || null,
    title: page.getAttribute("name") || null
  };
}

/** Read the current page metadata from the native mxfile envelope without semantic inference. */
export function getNativeDiagramPageInfo(xml: string, pageId?: string | null): NativeDiagramPageInfo {
  return readPageInfo(parseDrawioXml(xml), pageId ?? null);
}

/**
 * Resolve both page identities for a document plus the ID the live editor reported. This is the
 * single place that knows a bare mxGraphModel has one page, no declared ID and an editor-generated
 * runtime ID; every page comparison elsewhere goes through the returned identity.
 */
export function resolveNativePageIdentity(xml: string, runtimePageId: string | null = null): NativePageIdentity {
  const parsed = parseDrawioXml(xml);
  if (parsed.documentElement.nodeName === "mxGraphModel") {
    return {
      bare: true,
      declaredPageId: null,
      title: null,
      documentPageId: null,
      runtimePageId,
      pageExists: true
    };
  }
  const info = readPageInfo(parsed, runtimePageId);
  return {
    bare: false,
    declaredPageId: info.id,
    title: info.title,
    documentPageId: info.id,
    runtimePageId: info.id ?? runtimePageId,
    pageExists: info.id !== null
  };
}

/**
 * Whether a caller-supplied page ID addresses this document's page. A bare model holds exactly one
 * page, so every runtime ID refers to it; an mxfile must name a page the envelope declares.
 */
export function nativePageAccepts(identity: NativePageIdentity, requestedPageId: string | null): boolean {
  if (!requestedPageId) return true;
  return identity.bare || identity.declaredPageId === requestedPageId;
}

function plainNativeLabel(value: string): string {
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

function parseNativeGraphModel(xml: string, pageId?: string | null): Document {
  const parsed = parseDrawioXml(xml);
  if (parsed.documentElement.nodeName === "mxGraphModel") return parsed;
  if (parsed.documentElement.nodeName !== "mxfile") return parsed;
  const diagrams = Array.from(parsed.getElementsByTagName("diagram"));
  const diagram = pageId != null
    ? diagrams.find((page) => page.getAttribute("id") === pageId)
    : diagrams.length === 1 ? diagrams[0] : undefined;
  if (!diagram) {
    if (pageId != null) throw new Error(`Draw.io page “${pageId}” was not found; refusing to inspect cells from another page.`);
    throw new Error("The Draw.io document has multiple pages but no active page ID; refusing to inspect cells from the first page.");
  }
  const model = diagram.getElementsByTagName("mxGraphModel").item(0);
  if (model) return model as unknown as Document;
  const payload = (diagram.textContent || "").trim();
  if (!payload) return parsed;
  try {
    const nested = parseDrawioXml(decodeDrawioPageXml(payload));
    if (nested.documentElement.nodeName === "mxGraphModel") return nested;
  } catch {
    // Malformed compressed pages yield no editable targets; validation reports the detailed issue elsewhere.
  }
  return parsed;
}

/** Read editable targets directly from native mxCells. */
export function extractNativeEditTargets(
  xml: string,
  pageId?: string | null,
  options: { includeGeometry?: boolean } = {}
): NativeEditTarget[] {
  const parsed = parseNativeGraphModel(xml, pageId);
  const cells = findDrawioElements(parsed, "mxCell");
  const result: NativeEditTarget[] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    const wrapper = cell.parentElement;
    const wrapperName = wrapper?.nodeName || "";
    const wrappedId = wrapper && !["root", "mxGraphModel", "diagram", "mxfile"].includes(wrapperName)
      ? wrapper.getAttribute("id")
      : null;
    const id = wrappedId || cell.getAttribute("id") || "";
    const vertex = cell.getAttribute("vertex") === "1";
    const edge = cell.getAttribute("edge") === "1";
    if (!id || seen.has(id) || (!vertex && !edge)) continue;
    seen.add(id);
    const c4Name = wrapper?.getAttribute("c4Name");
    const rawLabel = c4Name !== null && c4Name !== undefined
      ? c4Name
      : wrapper?.hasAttribute("label")
        ? wrapper.getAttribute("label") ?? ""
        : wrapper?.hasAttribute("value")
          ? wrapper.getAttribute("value") ?? ""
          : cell.hasAttribute("value")
            ? cell.getAttribute("value") ?? ""
            : cell.getAttribute("label") ?? "";
    const style = cell.getAttribute("style") || "";
    const styleValue = (key: string): string | null => {
      let value: string | null = null;
      for (const part of style.split(";")) {
        const equalsAt = part.indexOf("=");
        if (equalsAt > 0 && part.slice(0, equalsAt).trim() === key) value = part.slice(equalsAt + 1).trim();
      }
      return value;
    };
    const geometryElement = Array.from(cell.children).find((child) => child.nodeName === "mxGeometry") ?? null;
    const geometryValue = (key: string): number => {
      const raw = geometryElement?.getAttribute(key);
      const value = raw === null || raw === undefined || raw.trim() === "" ? 0 : Number(raw);
      return Number.isFinite(value) ? value : 0;
    };
    const shape = styleValue("shape") || wrapper?.getAttribute("shape") || "";
    const rawRotation = styleValue("rotation") ?? wrapper?.getAttribute("rotation") ?? cell.getAttribute("rotation");
    const rotationValue = rawRotation === null || rawRotation === undefined || rawRotation.trim() === ""
      ? 0 : Number(rawRotation);
    const geometry = geometryElement ? {
      x: Math.round(geometryValue("x")),
      y: Math.round(geometryValue("y")),
      width: Math.round(geometryValue("width")),
      height: Math.round(geometryValue("height"))
    } : undefined;
    result.push({
      id,
      name: plainNativeLabel(rawLabel),
      cellType: vertex ? "vertex" : "edge",
      ...(options.includeGeometry ? {
        ...(shape ? { shape: shape.slice(0, 180) } : {}),
        ...(geometry ? { geometry } : {}),
        ...(Number.isFinite(rotationValue) && rotationValue !== 0 ? { rotation: Math.round(rotationValue) } : {}),
        ...(cell.getAttribute("parent") ? { parentId: cell.getAttribute("parent")! } : {})
      } : {})
    });
  }
  return result;
}

const nativeTargetSchema = z.string().trim().min(1, { message: "target must not be empty" }).max(200, { message: "target exceeds 200 characters" })
  .describe("Exact native cell ID or unique exact visible label.");

const nativeEditOperationOptions = {
  select: z.object({ op: z.literal("select"), target: nativeTargetSchema }).strict(),
  setLabel: z.object({
    op: z.literal("set_label"), target: nativeTargetSchema,
    label: z.string().min(1, { message: "label must not be empty" }).max(500, { message: "label exceeds 500 characters" })
      .refine((value) => value.trim().length > 0, { message: "label must not be empty or whitespace-only" })
      .describe("Required replacement label. Preserve the exact supplied string, including intentional leading and trailing whitespace.")
  }).strict(),
  setStyle: z.object({
    op: z.literal("set_style"), target: nativeTargetSchema,
    key: z.enum(NATIVE_EDIT_STYLE_KEYS, { message: "Style key must be one of fillColor, strokeColor, fontColor" })
      .describe("Required native Draw.io color style key. Do not infer a key when the user did not specify which aspect to change."),
    color: z.string().trim().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, { message: "color must be an explicit 3- or 6-digit hex value such as #f00 or #ff0000" })
      .describe("Explicit 3- or 6-digit hex color. Do not translate color names here; supply the concrete color requested.")
  }).strict(),
  autoLayout: z.object({
    op: z.literal("auto_layout"),
    target: z.literal("active_page").describe("Always target the active native Draw.io page. Auto-layout is a whole-page operation and must be the only item in the batch."),
    engine: z.enum(NATIVE_AUTO_LAYOUT_ENGINES).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.engine)
      .describe("Studio-owned layout engine; never call Draw.io's built-in layout action."),
    algorithm: z.enum(NATIVE_AUTO_LAYOUT_ALGORITHMS).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.algorithm)
      .describe("Algorithm supported by the selected layout engine."),
    direction: z.enum(["RIGHT", "LEFT", "DOWN", "UP"]).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.direction)
      .describe("Layout direction."),
    preserveLocalGrouping: z.boolean().default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.preserveLocalGrouping)
      .describe("Keep confidently close, uncontained nodes together as a temporary cluster while allowing the cluster to move with the new layout direction."),
    preserveCanvasOrigin: z.boolean().default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.preserveCanvasOrigin)
      .describe("Keep the final native content bounding box aligned with its original top-left instead of translating it to the configured canvas margin."),
    preserveRelativeAnchors: z.boolean().default(false)
      .describe("Preserve relative positions among the explicitly identified anchor cells; the anchors may translate together and are not pinned to absolute coordinates. Enable only with 2–32 exact anchorCellIds."),
    anchorCellIds: z.array(z.string().trim().min(1).max(200)).max(32).default([])
      .describe("Exact native vertex cell IDs selected as relative anchors for this layout run; provide 2–32 IDs only when preserveRelativeAnchors is true."),
    nodeSpacing: z.number().min(5).max(500).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.nodeSpacing).describe("Gap between peer nodes."),
    layerSpacing: z.number().min(10).max(800).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.layerSpacing).describe("Gap between ranks/layers."),
    edgeRouting: z.enum(["ORTHOGONAL", "POLYLINE", "SPLINES"]).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.edgeRouting).describe("Connector routing style where supported by the selected engine."),
    iterations: z.number().int().min(20).max(3000).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.iterations).describe("Iteration budget for supported layout algorithms."),
    randomSeed: z.number().int().min(0).max(100000).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.randomSeed).describe("Reproducible seed for algorithms that use randomness."),
    margin: z.number().min(0).max(300).default(DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.margin).describe("Canvas margin after layout normalization.")
  }).strict(),
  move: z.object({
    op: z.literal("move"),
    target: nativeTargetSchema.describe("Exact cell ID or unique exact label of a vertex. Moving connector routing is not supported by this operation."),
    dx: z.number().min(-10000).max(10000).describe("Required horizontal delta."),
    dy: z.number().min(-10000).max(10000).describe("Required vertical delta.")
  }).strict(),
  resize: z.object({
    op: z.literal("resize"),
    target: nativeTargetSchema.describe("Exact cell ID or unique exact label of a vertex. Resizing connector geometry is not supported by this operation."),
    width: z.number().min(1).max(10000).describe("Required width."),
    height: z.number().min(1).max(10000).describe("Required height.")
  }).strict(),
  delete: z.object({ op: z.literal("delete"), target: nativeTargetSchema }).strict(),
  addNodeAfter: z.object({
    op: z.literal("add_node_after"),
    target: nativeTargetSchema.describe("Required exact cell ID or unique exact visible label of a vertex."),
    newLabel: z.string().min(1, { message: "newLabel must not be empty" }).max(500, { message: "newLabel exceeds 500 characters" })
      .refine((value) => value.trim().length > 0, { message: "newLabel must not be empty or whitespace-only" })
      .describe("Required visible label for the newly created node. Preserve the exact supplied string, including intentional leading and trailing whitespace.")
  }).strict(),
  addNodeBelow: z.object({
    op: z.literal("add_node_below"),
    target: nativeTargetSchema.describe("Required exact cell ID or unique exact visible label of a vertex; the new node is placed directly beneath this vertex."),
    newLabel: z.string().min(1, { message: "newLabel must not be empty" }).max(500, { message: "newLabel exceeds 500 characters" })
      .refine((value) => value.trim().length > 0, { message: "newLabel must not be empty or whitespace-only" })
      .describe("Required visible label for the newly created node. Preserve the exact supplied string, including intentional leading and trailing whitespace.")
  }).strict()
} as const;

/** The single runtime contract for all Copilot-visible native edits. */
export const NativeEditOperationSchema = z.discriminatedUnion("op", [
  nativeEditOperationOptions.select, nativeEditOperationOptions.setLabel, nativeEditOperationOptions.setStyle,
  nativeEditOperationOptions.autoLayout,
  nativeEditOperationOptions.move, nativeEditOperationOptions.resize, nativeEditOperationOptions.delete,
  nativeEditOperationOptions.addNodeAfter, nativeEditOperationOptions.addNodeBelow
]);

export const NativeEditOperationBatchSchema = z.array(NativeEditOperationSchema)
  .min(1, { message: "operations must contain at least one operation" })
  .max(MAX_NATIVE_EDIT_OPERATIONS, { message: `operations must contain at most ${MAX_NATIVE_EDIT_OPERATIONS} operations` });

/** Zod owns field contracts; transaction rules and canonicalization remain explicit business logic. */
export function parseNativeEditOperations(input: unknown): NativeEditParseResult {
  if (!Array.isArray(input)) return { ok: false, error: "operations must be an array" };
  if (input.length === 0) return { ok: false, error: "operations must contain at least one operation" };
  if (input.length > MAX_NATIVE_EDIT_OPERATIONS) {
    return { ok: false, error: `operations must contain at most ${MAX_NATIVE_EDIT_OPERATIONS} operations` };
  }
  const isOperation = (raw: unknown): raw is Record<string, unknown> => Boolean(raw) && typeof raw === "object" && !Array.isArray(raw);
  const containsLayout = input.some((raw) => isOperation(raw) && raw.op === "auto_layout");
  if (containsLayout && input.length !== 1) return { ok: false, error: "auto_layout must be the only operation in its batch because it recalculates the active page as one transaction" };

  const normalizedInput = input.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const item = raw as Record<string, unknown>;
    if (item.op !== "auto_layout") return raw;
    const engine = NATIVE_AUTO_LAYOUT_ENGINES.includes(item.engine as NativeAutoLayoutEngine)
      ? item.engine as NativeAutoLayoutEngine
      : DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.engine;
    const anchorCellIds = Array.isArray(item.anchorCellIds) && item.anchorCellIds.every((id) => typeof id === "string")
      ? Array.from(new Set((item.anchorCellIds as string[]).map((id) => id.trim()).filter(Boolean))).sort()
      : item.anchorCellIds;
    return {
      ...item,
      algorithm: typeof item.algorithm === "string" ? item.algorithm : defaultNativeLayoutAlgorithm(engine),
      anchorCellIds
    };
  });
  const parsed = NativeEditOperationBatchSchema.safeParse(normalizedInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const index = typeof issue?.path[0] === "number" ? issue.path[0] + 1 : 1;
    const field = issue?.path.slice(1).map(String).join(".");
    return { ok: false, error: `Operation ${index}: ${field ? field + " " : ""}${issue?.message || "invalid operation"}` };
  }
  const operations: NativeEditOperation[] = [];
  for (const [index, operation] of parsed.data.entries()) {
    if (operation.op === "set_style") {
      operations.push(operation);
    } else if (operation.op === "move") {
      if (operation.dx === 0 && operation.dy === 0) return { ok: false, error: `Operation ${index + 1}: move requires a non-zero dx or dy` };
      operations.push(operation);
    } else if (operation.op === "auto_layout") {
      if (operation.engine === "dagre" && operation.algorithm !== "layered") {
        return { ok: false, error: `Operation ${index + 1}: Dagre does not support the requested “${operation.algorithm}” algorithm. Select “layered” or use ELK for other algorithms.` };
      }
      if (!nativeLayoutSupportsAlgorithm(operation.engine, operation.algorithm)) {
        return { ok: false, error: `Operation ${index + 1}: algorithm “${operation.algorithm}” is not supported by “${operation.engine}".` };
      }
      if (operation.preserveRelativeAnchors && operation.anchorCellIds.length < 2) {
        return { ok: false, error: `Operation ${index + 1}: preserveRelativeAnchors requires at least two exact anchorCellIds.` };
      }
      if (!operation.preserveRelativeAnchors && operation.anchorCellIds.length > 0) {
        return { ok: false, error: `Operation ${index + 1}: anchorCellIds require preserveRelativeAnchors=true.` };
      }
      operations.push(operation);
    } else {
      operations.push(operation);
    }
  }
  return { ok: true, operations };
}

/** One-line, user-facing description of a planned operation. */
export function describeNativeEditOperation(operation: NativeEditOperation & { targetLabel?: string; cellId?: string }): string {
  const target = typeof operation.targetLabel === "string" && operation.targetLabel.trim()
    ? operation.targetLabel.trim()
    : operation.cellId && operation.target === operation.cellId
      ? "unnamed element"
      : operation.target;
  switch (operation.op) {
    case "select": return `Select “${target}”`;
    case "set_label": return `Rename “${target}” to “${operation.label}”`;
    case "set_style": return `Set ${operation.key} of “${target}” to ${operation.color}`;
    case "auto_layout": {
      const engineLabels: Record<NativeAutoLayoutEngine, string> = {
        elk: "ELK", dagre: "Dagre", graphviz: "Graphviz", msagl: "MSAGL.js", cytoscape: "Cytoscape.js", d3: "D3"
      };
      return "Auto-layout the active page using " + engineLabels[operation.engine] + " " + operation.algorithm +
        " (" + operation.direction + ", node spacing " + operation.nodeSpacing + ", layer spacing " + operation.layerSpacing +
        ", preserve local grouping " + (operation.preserveLocalGrouping ? "on" : "off") +
        ", preserve canvas origin " + (operation.preserveCanvasOrigin ? "on" : "off") +
        ", preserve relative anchors " + (operation.preserveRelativeAnchors ? "on for " + operation.anchorCellIds.length + " cell(s)" : "off") + ").";
    }
    case "move": return `Move “${target}” by ${operation.dx}, ${operation.dy}`;
    case "resize": return `Resize “${target}” to ${operation.width} × ${operation.height}`;
    case "delete": return `Delete “${target}”`;
    case "add_node_after": return `Add “${operation.newLabel}” to the right of “${target}” and connect it`;
    case "add_node_below": return `Add “${operation.newLabel}” below “${target}” and connect it`;
  }
}

export type NativeCellEditPlan =
  | { ok: true; edits: NativeCellEdit[] }
  | { ok: false; error: string };

/**
 * Converts resolved operations into the bridge's `cell:batch` steps.
 *
 * The source XML is used only to reject a target that is not present on the expected page; move
 * remains a delta so the native editor applies it to live geometry rather than stale coordinates.
 */
export function toNativeCellEdits(operations: ResolvedNativeEditOperation[], xml: string, pageId?: string | null, layoutPlan?: NativeLayoutPlan): NativeCellEditPlan {
  if (operations.length === 0) return { ok: false, error: "No native edit operations were supplied" };
  if (operations.length > MAX_NATIVE_EDIT_OPERATIONS) return { ok: false, error: `At most ${MAX_NATIVE_EDIT_OPERATIONS} operations can be executed at once` };
  let activeTargetIds: Set<string>;
  try {
    activeTargetIds = new Set(extractNativeEditTargets(xml, pageId).map((target) => target.id));
  } catch (error) {
    return { ok: false, error: "The Draw.io XML could not be indexed: " + (error instanceof Error ? error.message : String(error)) };
  }
  for (const operation of operations) {
    const activePageOperation = operation.op === "auto_layout" &&
      operation.target === "active_page" && operation.cellId === "__active_page__";
    if (activePageOperation) continue;
    if (typeof operation.cellId !== "string" || !activeTargetIds.has(operation.cellId)) {
      return { ok: false, error: `Cell “${operation.targetLabel || operation.target}” is not present on the expected Draw.io page` };
    }
  }
  const edits: NativeCellEdit[] = [];
  for (const operation of operations) {
    const cellId = operation.cellId;
    if (typeof cellId !== "string" || !cellId.trim()) return { ok: false, error: "An operation is missing its resolved cell id" };
    switch (operation.op) {
      case "select":
        edits.push({ cellId, path: "cell:select", value: "true" });
        break;
      case "delete":
        edits.push({ cellId, path: "cell:delete", value: "true" });
        break;
      case "add_node_after":
        edits.push({ cellId, path: "cell:add-node-after", value: JSON.stringify({ label: operation.newLabel }) });
        break;
      case "add_node_below":
        edits.push({ cellId, path: "cell:add-node-below", value: JSON.stringify({ label: operation.newLabel }) });
        break;
      case "set_label":
        edits.push({ cellId, path: "label", value: operation.label });
        break;
      case "set_style":
        edits.push({ cellId, path: "style:" + operation.key, value: operation.color });
        break;
      case "auto_layout": {
        if (!layoutPlan) return { ok: false, error: "The layout plan was not calculated from the current native XML revision." };
        // The plan carries the runtime identity: a bare model's editor-generated page ID, or the
        // declared page ID for an mxfile.
        const expectedPage = resolveNativePageIdentity(xml, pageId).runtimePageId;
        const revisionMatches = /^[a-f0-9]{64}$/i.test(layoutPlan.documentRevision);
        const optionsMatch = layoutPlan.engine === operation.engine &&
          layoutPlan.algorithm === operation.algorithm &&
          layoutPlan.direction === operation.direction &&
          layoutPlan.preserveLocalGrouping === operation.preserveLocalGrouping &&
          layoutPlan.preserveCanvasOrigin === operation.preserveCanvasOrigin &&
          layoutPlan.preserveRelativeAnchors === operation.preserveRelativeAnchors &&
          layoutPlan.anchorCellIds.length === operation.anchorCellIds.length &&
          layoutPlan.anchorCellIds.every((id, index) => id === operation.anchorCellIds[index]) &&
          layoutPlan.nodeSpacing === operation.nodeSpacing &&
          layoutPlan.layerSpacing === operation.layerSpacing &&
          layoutPlan.edgeRouting === operation.edgeRouting &&
          layoutPlan.iterations === operation.iterations &&
          layoutPlan.randomSeed === operation.randomSeed &&
          layoutPlan.margin === operation.margin;
        if (!revisionMatches || layoutPlan.pageId !== expectedPage || !optionsMatch) {
          return { ok: false, error: "The calculated layout plan does not match the current revision, active page or selected layout options." };
        }
        edits.push({ cellId, path: "cell:auto-layout", value: JSON.stringify(layoutPlan) });
        break;
      }
      case "resize":
        edits.push({ cellId, path: "geometry:size", value: operation.width + "," + operation.height });
        break;
      case "move":
        // Apply deltas to the live mxCell geometry in the native editor. Computing absolute
        // coordinates from this request's XML would overwrite any movement made while the
        // model call was in flight.
        edits.push({ cellId, path: "geometry:translate", value: operation.dx + "," + operation.dy });
        break;
    }
  }
  return { ok: true, edits };
}
