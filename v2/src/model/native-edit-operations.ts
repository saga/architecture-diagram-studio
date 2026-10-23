import { inflateSync, unzlibSync } from "fflate";
import { findDrawioElements, parseDrawioXml } from "./drawio-xml-dom";
import { DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, type NativeAutoLayoutOptions, type NativeLayoutPlan } from "../layout/native-layout";

/**
 * Shared contract for native Draw.io cell edits.
 *
 * The same operation list is produced by the Copilot agent, validated by the server and
 * executed by the browser through the native bridge. Keeping one schema here prevents the
 * model, the server and the client from drifting into separate vocabularies.
 */
export const NATIVE_EDIT_STYLE_KEYS = ["fillColor", "strokeColor", "fontColor"] as const;
export type NativeEditStyleKey = (typeof NATIVE_EDIT_STYLE_KEYS)[number];

/** Maximum length of a model-generated program executed by the local Draw.io editor. */
export const MAX_NATIVE_DRAWIO_SCRIPT_LENGTH = 50_000;

/** The bridge batch caps at 50 steps; typed moves are a single live-geometry delta. */
export const MAX_NATIVE_EDIT_OPERATIONS = 20;

export type NativeEditOperation =
  | { op: "select"; target: string }
  | { op: "set_label"; target: string; label: string }
  | { op: "set_style"; target: string; key: NativeEditStyleKey; color: string }
  | { op: "set_c4_type"; target: string; kind: "person" | "system" | "external" }
  | { op: "run_drawio_script"; target: "active_page"; summary: string; script: string }
  | ({ op: "auto_layout"; target: "active_page" } & NativeAutoLayoutOptions)
  | { op: "move"; target: string; dx: number; dy: number }
  | { op: "resize"; target: string; width: number; height: number }
  | { op: "delete"; target: string }
  | { op: "add_node_after"; target: string; newLabel: string }
  | { op: "add_node_below"; target: string; newLabel: string };

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
}

/** Outcome of one atomic bridge batch, as reported by the native editor. */
export interface NativeEditExecution {
  ok: boolean;
  error?: string;
  /** Distinguishes a native editor rejection from a successful edit whose required save failed. */
  failureStage?: "editor" | "persistence";
  /** The local edit may be saved even if its final audit receipt could not be accepted by the server. */
  auditWarning?: string;
  /** Bounded return value from a native Draw.io script, when one was supplied. */
  scriptResult?: unknown;
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
}

export interface NativeDiagramPageInfo {
  id: string | null;
  title: string | null;
}

/** Read the current page metadata from the native mxfile envelope without semantic inference. */
export function getNativeDiagramPageInfo(xml: string, pageId?: string | null): NativeDiagramPageInfo {
  const parsed = parseDrawioXml(xml);
  if (parsed.documentElement.nodeName !== "mxfile") return { id: null, title: null };
  const diagrams = Array.from(parsed.getElementsByTagName("diagram"));
  const page = (pageId ? diagrams.find((item) => item.getAttribute("id") === pageId) : undefined) || diagrams[0];
  if (!page) return { id: null, title: null };
  return {
    id: page.getAttribute("id") || null,
    title: page.getAttribute("name") || null
  };
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
  const diagram = (pageId ? diagrams.find((page) => page.getAttribute("id") === pageId) : undefined) || diagrams[0];
  if (!diagram) return parsed;
  const model = diagram.getElementsByTagName("mxGraphModel").item(0);
  if (model) return model as unknown as Document;
  const payload = (diagram.textContent || "").trim();
  if (!payload) return parsed;
  if (payload.startsWith("<")) {
    const nested = parseDrawioXml(payload);
    if (nested.documentElement.nodeName === "mxGraphModel") return nested;
  }
  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let inflated: Uint8Array | null = null;
    try { inflated = inflateSync(bytes); } catch { /* Try a zlib-wrapped legacy payload. */ }
    if (!inflated) {
      try { inflated = unzlibSync(bytes); } catch { /* The page is not a supported compressed payload. */ }
    }
    if (inflated) {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
      const candidates = [decoded];
      try {
        const uriDecoded = decodeURIComponent(decoded);
        if (uriDecoded !== decoded) candidates.push(uriDecoded);
      } catch { /* A plain XML payload does not need URI decoding. */ }
      for (const candidate of candidates) {
        try {
          const nested = parseDrawioXml(candidate);
          if (nested.documentElement.nodeName === "mxGraphModel") return nested;
        } catch { /* Try the next representation. */ }
      }
    }
  } catch { /* Non-compressed or malformed pages yield no targets. */ }
  return parsed;
}

/** Read editable targets directly from native mxCells. */
export function extractNativeEditTargets(xml: string, pageId?: string | null): NativeEditTarget[] {
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
    if (!id || seen.has(id) || (!vertex && !edge) || id === "0" || id === "1") continue;
    seen.add(id);
    const rawLabel = wrapper?.getAttribute("label") || wrapper?.getAttribute("value") ||
      cell.getAttribute("value") || cell.getAttribute("label") || "";
    result.push({ id, name: plainNativeLabel(rawLabel) || id, cellType: vertex ? "vertex" : "edge" });
  }
  return result;
}

const OPERATION_NAMES = ["select", "set_label", "set_style", "set_c4_type", "run_drawio_script", "auto_layout", "move", "resize", "delete", "add_node_after", "add_node_below"] as const;

/**
 * Colors the agent may name. Longest keys are matched first so “红色” wins over “红”
 * inside a value such as “红色背景色”.
 */
const NAMED_COLORS: Record<string, string> = {
  red: "#ff0000", blue: "#0000ff", green: "#008000", black: "#000000", white: "#ffffff",
  orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080", yellow: "#ffff00",
  pink: "#ffc0cb", brown: "#a52a2a", cyan: "#00ffff", teal: "#008080", navy: "#000080",
  红色: "#ff0000", 红: "#ff0000", 蓝色: "#0000ff", 蓝: "#0000ff", 绿色: "#008000", 绿: "#008000",
  黑色: "#000000", 黑: "#000000", 白色: "#ffffff", 白: "#ffffff", 橙色: "#ffa500", 橙: "#ffa500",
  紫色: "#800080", 紫: "#800080", 灰色: "#808080", 灰: "#808080", 黄色: "#ffff00", 黄: "#ffff00",
  粉色: "#ffc0cb", 粉: "#ffc0cb", 棕色: "#a52a2a", 棕: "#a52a2a", 青色: "#00ffff", 青: "#00ffff"
};
const NAMED_COLOR_KEYS = Object.keys(NAMED_COLORS).sort((left, right) => right.length - left.length);

/** Normalizes `#f00`, `#FF0000`, `red` and `红色背景色` to a lowercase six-digit hex color. */
export function normalizeNativeColor(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw || raw.length > 40) return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(raw);
  if (hex) {
    const digits = hex[1];
    return "#" + (digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits);
  }
  if (NAMED_COLORS[raw]) return NAMED_COLORS[raw];
  // Accept a named color embedded in a phrase such as “红色背景色” or “字色改成蓝色”.
  const embedded = NAMED_COLOR_KEYS.find((key) => raw.includes(key));
  return embedded ? NAMED_COLORS[embedded] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textField(source: Record<string, unknown>, field: string, maxLength: number): string {
  const value = source[field];
  if (typeof value !== "string") throw new Error(`Operation field “${field}” must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Operation field “${field}” must not be empty`);
  if (trimmed.length > maxLength) throw new Error(`Operation field “${field}” exceeds ${maxLength} characters`);
  return trimmed;
}

function numericField(source: Record<string, unknown>, field: string, minimum: number, maximum: number): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Operation field “${field}” must be a finite number`);
  if (value < minimum || value > maximum) throw new Error(`Operation field “${field}” must be between ${minimum} and ${maximum}`);
  return value;
}

/**
 * Validates an untrusted operation list from the model.
 *
 * Style keys are restricted here, not in the bridge: the bridge applies any `style:<key>`
 * it receives, so an unvalidated key would let the model rewrite arbitrary Draw.io style.
 */
export function parseNativeEditOperations(input: unknown): NativeEditParseResult {
  if (!Array.isArray(input)) return { ok: false, error: "operations must be an array" };
  if (input.length === 0) return { ok: false, error: "operations must contain at least one operation" };
  if (input.length > MAX_NATIVE_EDIT_OPERATIONS) {
    return { ok: false, error: `operations must contain at most ${MAX_NATIVE_EDIT_OPERATIONS} operations` };
  }
  const containsScript = input.some((raw) => isRecord(raw) && raw.op === "run_drawio_script");
  const containsLayout = input.some((raw) => isRecord(raw) && raw.op === "auto_layout");
  if (containsScript && input.length !== 1) {
    return { ok: false, error: "run_drawio_script must be the only operation in its batch" };
  }
  if (containsLayout && input.length !== 1) {
    return { ok: false, error: "auto_layout must be the only operation in its batch because it recalculates the active page as one transaction" };
  }
  const operations: NativeEditOperation[] = [];
  for (const [index, raw] of input.entries()) {
    const position = index + 1;
    try {
      if (!isRecord(raw)) throw new Error("Operation must be an object");
      const name = raw.op;
      if (typeof name !== "string" || !OPERATION_NAMES.includes(name as (typeof OPERATION_NAMES)[number])) {
        throw new Error(`Unsupported operation “${String(name)}”; expected one of ${OPERATION_NAMES.join(", ")}`);
      }
      const target = textField(raw, "target", 200);
      switch (name) {
        case "select":
        case "delete":
          operations.push({ op: name, target });
          break;
        case "add_node_after":
        case "add_node_below":
          operations.push({ op: name, target, newLabel: textField(raw, "newLabel", 500) });
          break;
        case "set_label":
          operations.push({ op: name, target, label: textField(raw, "label", 500) });
          break;
        case "set_c4_type": {
          const kind = raw.kind;
          if (kind !== "person" && kind !== "system" && kind !== "external") {
            throw new Error('kind must be "person", "system", or "external"');
          }
          operations.push({ op: name, target, kind });
          break;
        }
        case "run_drawio_script": {
          if (target !== "active_page") throw new Error('run_drawio_script target must be "active_page"');
          const script = raw.script;
          if (typeof script !== "string" || !script.trim()) throw new Error("script must be a non-empty JavaScript program");
          if (script.length > MAX_NATIVE_DRAWIO_SCRIPT_LENGTH) {
            throw new Error(`script exceeds ${MAX_NATIVE_DRAWIO_SCRIPT_LENGTH} characters`);
          }
          operations.push({ op: name, target: "active_page", summary: textField(raw, "summary", 1000), script });
          break;
        }
        case "auto_layout": {
          if (target !== "active_page") throw new Error('auto_layout target must be "active_page"');
          const engineValue = raw.engine ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.engine;
          if (engineValue !== "elk" && engineValue !== "dagre") throw new Error('engine must be "elk" or "dagre"');
          const algorithmValue = raw.algorithm ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.algorithm;
          if (!["layered", "mrtree", "radial", "stress", "force"].includes(String(algorithmValue))) {
            throw new Error("algorithm must be layered, mrtree, radial, stress, or force");
          }
          const directionValue = raw.direction ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.direction;
          if (!["RIGHT", "LEFT", "DOWN", "UP"].includes(String(directionValue))) {
            throw new Error("direction must be RIGHT, LEFT, DOWN, or UP");
          }
          const routingValue = raw.edgeRouting ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.edgeRouting;
          if (!["ORTHOGONAL", "POLYLINE", "SPLINES"].includes(String(routingValue))) {
            throw new Error("edgeRouting must be ORTHOGONAL, POLYLINE, or SPLINES");
          }
          operations.push({
            op: "auto_layout", target: "active_page",
            engine: engineValue,
            algorithm: engineValue === "dagre" ? "layered" : algorithmValue as NativeAutoLayoutOptions["algorithm"],
            direction: directionValue as NativeAutoLayoutOptions["direction"],
            nodeSpacing: numericField({ value: raw.nodeSpacing ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.nodeSpacing }, "value", 5, 500),
            layerSpacing: numericField({ value: raw.layerSpacing ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.layerSpacing }, "value", 10, 800),
            edgeRouting: routingValue as NativeAutoLayoutOptions["edgeRouting"],
            iterations: Math.round(numericField({ value: raw.iterations ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.iterations }, "value", 20, 3000)),
            randomSeed: Math.round(numericField({ value: raw.randomSeed ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.randomSeed }, "value", 0, 100000)),
            margin: numericField({ value: raw.margin ?? DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS.margin }, "value", 0, 300)
          });
          break;
        }
        case "set_style": {
          const key = raw.key === undefined || raw.key === null ? "fillColor" : raw.key;
          if (typeof key !== "string" || !NATIVE_EDIT_STYLE_KEYS.includes(key as NativeEditStyleKey)) {
            throw new Error(`Style key must be one of ${NATIVE_EDIT_STYLE_KEYS.join(", ")}`);
          }
          const colorValue = raw.color;
          if (typeof colorValue !== "string") throw new Error("Style color must be a string");
          const color = normalizeNativeColor(colorValue);
          if (!color) throw new Error(`Unsupported color “${colorValue}”`);
          operations.push({ op: name, target, key: key as NativeEditStyleKey, color });
          break;
        }
        case "move": {
          const dx = numericField(raw, "dx", -10000, 10000);
          const dy = numericField(raw, "dy", -10000, 10000);
          if (dx === 0 && dy === 0) throw new Error("move requires a non-zero dx or dy");
          operations.push({ op: name, target, dx, dy });
          break;
        }
        case "resize":
          operations.push({ op: name, target, width: numericField(raw, "width", 1, 10000), height: numericField(raw, "height", 1, 10000) });
          break;
        default:
          throw new Error(`Unsupported operation “${name}”`);
      }
    } catch (error) {
      return { ok: false, error: `Operation ${position}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, operations };
}

/** One-line, user-facing description of a planned operation. */
export function describeNativeEditOperation(operation: NativeEditOperation & { targetLabel?: string }): string {
  const target = typeof operation.targetLabel === "string" && operation.targetLabel.trim()
    ? operation.targetLabel.trim()
    : operation.target;
  switch (operation.op) {
    case "select": return `Select “${target}”`;
    case "set_label": return `Rename “${target}” to “${operation.label}”`;
    case "set_style": return `Set ${operation.key} of “${target}” to ${operation.color}`;
    case "set_c4_type": return `Convert “${target}” to the native C4 ${operation.kind === "person" ? "Person" : operation.kind === "system" ? "Software System" : "External Software System"} style`;
    case "run_drawio_script": return operation.summary;
    case "auto_layout": return "Auto-layout the active page using " + (operation.engine === "elk" ? "ELK " + operation.algorithm : "Dagre") +
      " (" + operation.direction + ", node spacing " + operation.nodeSpacing + ", layer spacing " + operation.layerSpacing + ").";
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
    const activePageOperation = (operation.op === "run_drawio_script" || operation.op === "auto_layout") &&
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
      case "set_c4_type":
        edits.push({ cellId, path: "cell:set-c4-type", value: JSON.stringify({ kind: operation.kind }) });
        break;
      case "run_drawio_script":
        edits.push({ cellId, path: "cell:execute-script", value: operation.script });
        break;
      case "auto_layout": {
        if (!layoutPlan) return { ok: false, error: "The Dagre/ELK layout plan was not calculated from the current native XML revision." };
        const expectedPage = getNativeDiagramPageInfo(xml, pageId).id;
        const revisionMatches = /^[a-f0-9]{64}$/i.test(layoutPlan.documentRevision);
        const optionsMatch = layoutPlan.engine === operation.engine &&
          layoutPlan.algorithm === operation.algorithm &&
          layoutPlan.direction === operation.direction &&
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
