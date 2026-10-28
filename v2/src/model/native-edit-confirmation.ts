import { decodeDrawioPageXml } from "./drawio-xml-schema";
import { parseDrawioXml } from "./drawio-xml-dom";

export interface NativeEditOperation {
  cellId: string;
  path: string;
  value: string;
}

export interface NativeEditConfirmationInput extends NativeEditOperation {
  beforeXml: string;
  xml: string;
  pageId?: string | null;
}

interface CellRecord {
  id: string;
  pageId: string | null;
  wrapper: Element;
  cell: Element;
  geometry: Element | null;
}

interface ModelRecords {
  pageId: string | null;
  cells: CellRecord[];
  /** True only for a bare mxGraphModel without an mxfile page envelope. */
  standalone: boolean;
}

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

function modelRoots(xml: string): Array<{ pageId: string | null; model: Element; standalone: boolean }> {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  if (root.nodeName === "mxGraphModel") return [{ pageId: null, model: root, standalone: true }];
  if (root.nodeName !== "mxfile") return [];

  const result: Array<{ pageId: string | null; model: Element; standalone: boolean }> = [];
  for (const page of elementChildren(root).filter((child) => child.nodeName === "diagram")) {
    const pageId = page.getAttribute("id") || null;
    const inlineModel = directChild(page, "mxGraphModel");
    if (inlineModel) {
      result.push({ pageId, model: inlineModel, standalone: false });
      continue;
    }
    const payload = (page.textContent || "").trim();
    if (!payload) continue;
    const decoded = parseDrawioXml(decodeDrawioPageXml(payload));
    if (decoded.documentElement.nodeName === "mxGraphModel") result.push({ pageId, model: decoded.documentElement, standalone: false });
  }
  return result;
}

function elementSignature(element: Element): unknown {
  const attributes = Array.from(element.attributes)
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const text = Array.from(element.childNodes)
    .filter((child) => child.nodeType === 3 || child.nodeType === 4)
    .map((child) => (child.nodeValue || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [element.nodeName, attributes, text, elementChildren(element).map(elementSignature)];
}

/**
 * mxGraphModel.dx/dy describe the current viewport translation, not diagram content.
 * Draw.io may rewrite them during export after the user pans the canvas; ignoring these
 * two root attributes prevents a read-only script from appearing to mutate the document.
 * Keep every nested cell, geometry, style and metadata attribute in the signature.
 */
function modelSemanticSignature(model: Element): unknown {
  const attributes = Array.from(model.attributes)
    .filter((attribute) => attribute.name !== "dx" && attribute.name !== "dy")
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const text = Array.from(model.childNodes)
    .filter((child) => child.nodeType === 3 || child.nodeType === 4)
    .map((child) => (child.nodeValue || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [model.nodeName, attributes, text, elementChildren(model).map(elementSignature)];
}

function semanticDiagramSignature(xml: string, pageId?: string | null): string {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  if (root.nodeName !== "mxfile") return JSON.stringify(root.nodeName === "mxGraphModel" ? modelSemanticSignature(root) : elementSignature(root));
  const pages = elementChildren(root).filter((child) => child.nodeName === "diagram");
  const page = pageId != null ? pages.find((candidate) => candidate.getAttribute("id") === pageId) : null;
  if (pageId != null) {
    if (!page) return "missing-page:" + pageId;
    const models = modelRoots(xml);
    const matchingModel = models.find((entry) => entry.pageId === pageId);
    return JSON.stringify({
      pageId,
      pageName: page.getAttribute("name") || null,
      model: matchingModel ? modelSemanticSignature(matchingModel.model) : null
    });
  }
  const models = modelRoots(xml);
  return JSON.stringify(pages.map((candidate) => {
    const candidateId = candidate.getAttribute("id") || null;
    const matchingModel = models.find((entry) => entry.pageId === candidateId);
    return { pageId: candidateId, pageName: candidate.getAttribute("name") || null, model: matchingModel ? modelSemanticSignature(matchingModel.model) : null };
  }));
}

function cellsForXml(xml: string): ModelRecords[] {
  return modelRoots(xml).map(({ pageId, model, standalone }) => {
    const root = directChild(model, "root");
    if (!root) return { pageId, cells: [], standalone };
    const cells: CellRecord[] = [];
    for (const item of elementChildren(root)) {
      const cell = item.nodeName === "mxCell" ? item : directChild(item, "mxCell");
      if (!cell) continue;
      const id = item === cell ? cell.getAttribute("id") : item.getAttribute("id") || cell.getAttribute("id");
      if (!id) continue;
      cells.push({ id, pageId, wrapper: item, cell, geometry: directChild(cell, "mxGeometry") });
    }
    return { pageId, cells, standalone };
  });
}

function scopedModels(models: ModelRecords[], pageId?: string | null): ModelRecords[] {
  // An explicitly empty ID is invalid, not a request to drop page scope.
  if (pageId === "") return [];
  if (pageId != null) {
    const matchingPages = models.filter((model) => model.pageId === pageId);
    if (matchingPages.length > 0) return matchingPages;
    // A bare mxGraphModel has no page ID to match. It is still one unambiguous native model.
    return models.length === 1 && models[0].standalone ? models : [];
  }
  // With no page ID, a single decoded model is unambiguous; multiple models require explicit scope.
  return models.length === 1 ? models : [];
}

function findCell(models: ModelRecords[], cellId: string, pageId?: string | null): CellRecord | null {
  const candidates = scopedModels(models, pageId)
    .flatMap((model) => model.cells.filter((item) => item.id === cellId));
  return candidates.length === 1 ? candidates[0] : null;
}

function findText(record: CellRecord): string {
  if (record.wrapper !== record.cell && record.wrapper.hasAttribute("label")) return record.wrapper.getAttribute("label") || "";
  if (record.wrapper !== record.cell && record.wrapper.hasAttribute("value")) return record.wrapper.getAttribute("value") || "";
  return record.cell.getAttribute("value") || "";
}

function normalizeLabel(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:div|p|li|tr)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function labelMatches(record: CellRecord, expected: string): boolean {
  const actual = findText(record);
  return actual === expected || normalizeLabel(actual) === normalizeLabel(expected);
}

function numericAttribute(element: Element | null, name: string): number | null {
  if (!element || !element.hasAttribute(name)) return null;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function styleKeyMatches(style: string, key: string, expected: string): boolean {
  const entries = style.split(";").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? { key: entry, value: null } : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
  const matching = entries.filter((entry) => entry.key === key);
  const normalized = expected.toLowerCase();
  if (expected === "" || normalized === "0" || normalized === "false") return matching.length === 0;
  if (normalized === "1" || normalized === "true") return matching.some((entry) => entry.value === null);
  return matching.some((entry) => entry.value === expected);
}

function boolAttribute(element: Element, name: string, defaultValue: boolean): boolean {
  if (!element.hasAttribute(name)) return defaultValue;
  const value = (element.getAttribute(name) || "").toLowerCase();
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return defaultValue;
}

function attributeMatches(element: Element, name: string, expected: string): boolean {
  if (expected === "") return !element.hasAttribute(name) || element.getAttribute(name) === "";
  return element.getAttribute(name) === expected;
}

function pointFor(record: CellRecord, index: number): Element | null {
  if (!record.geometry) return null;
  const points = elementChildren(record.geometry)
    .filter((child) => child.nodeName === "Array" && child.getAttribute("as") === "points")
    .flatMap((array) => elementChildren(array).filter((child) => child.nodeName === "mxPoint"));
  return points[index] ?? null;
}

function hasAddedNodeAfter(before: ModelRecords[], after: ModelRecords[], operation: NativeEditOperation, pageId?: string | null): boolean {
  let payload: { label?: unknown };
  try { payload = JSON.parse(operation.value) as { label?: unknown }; } catch { return false; }
  if (typeof payload.label !== "string" || !payload.label.trim()) return false;
  const expectedLabel = payload.label.trim();
  const targetBefore = findCell(before, operation.cellId, pageId);
  const targetAfter = findCell(after, operation.cellId, pageId);
  if (!targetBefore || !targetAfter) return false;
  for (const model of scopedModels(after, pageId)) {
    for (const candidate of model.cells) {
      if (candidate.id === operation.cellId || candidate.cell.getAttribute("vertex") !== "1" || !labelMatches(candidate, payload.label.trim())) continue;
      const existedBefore = scopedModels(before, pageId).some((oldModel) => oldModel.cells.some((oldCell) =>
        oldCell.id === candidate.id && labelMatches(oldCell, expectedLabel)
      ));
      if (existedBefore) continue;
      const connected = model.cells.some((edge) => edge.cell.getAttribute("edge") === "1" &&
        ((edge.cell.getAttribute("source") === operation.cellId && edge.cell.getAttribute("target") === candidate.id) ||
         (edge.cell.getAttribute("target") === operation.cellId && edge.cell.getAttribute("source") === candidate.id)));
      if (connected) return true;
    }
  }
  return false;
}

function hasAddedNodeBelow(before: ModelRecords[], after: ModelRecords[], operation: NativeEditOperation, pageId?: string | null): boolean {
  let payload: { label?: unknown };
  try { payload = JSON.parse(operation.value) as { label?: unknown }; } catch { return false; }
  if (typeof payload.label !== "string" || !payload.label.trim()) return false;
  const expectedLabel = payload.label.trim();
  const targetBefore = findCell(before, operation.cellId, pageId);
  const targetAfter = findCell(after, operation.cellId, pageId);
  if (!targetBefore?.geometry || !targetAfter?.geometry) return false;
  const targetX = numericAttribute(targetAfter.geometry, "x");
  const targetY = numericAttribute(targetAfter.geometry, "y");
  const targetWidth = numericAttribute(targetAfter.geometry, "width");
  const targetHeight = numericAttribute(targetAfter.geometry, "height");
  if (targetX === null || targetY === null || targetWidth === null || targetHeight === null) return false;
  for (const model of scopedModels(after, pageId)) {
    for (const candidate of model.cells) {
      if (candidate.id === operation.cellId || candidate.cell.getAttribute("vertex") !== "1" ||
          !labelMatches(candidate, expectedLabel) || !candidate.geometry) continue;
      const candidateX = numericAttribute(candidate.geometry, "x");
      const candidateY = numericAttribute(candidate.geometry, "y");
      const candidateWidth = numericAttribute(candidate.geometry, "width");
      if (candidateX === null || candidateY === null || candidateWidth === null ||
          candidateY < targetY + targetHeight + 1 ||
          Math.abs((candidateX + candidateWidth / 2) - (targetX + targetWidth / 2)) > 1) continue;
      const existedBefore = scopedModels(before, pageId).some((oldModel) => oldModel.cells.some((oldCell) =>
        oldCell.id === candidate.id && labelMatches(oldCell, expectedLabel)
      ));
      if (existedBefore) continue;
      const connected = model.cells.some((edge) => edge.cell.getAttribute("edge") === "1" &&
        edge.cell.getAttribute("source") === operation.cellId &&
        edge.cell.getAttribute("target") === candidate.id);
      if (connected) return true;
    }
  }
  return false;
}

function operationIsReflected(
  before: ModelRecords[],
  after: ModelRecords[],
  operation: NativeEditOperation,
  pageId?: string | null
): boolean {
  const oldCell = findCell(before, operation.cellId, pageId);
  const nextCell = findCell(after, operation.cellId, pageId);
  if (operation.path === "cell:delete") return Boolean(oldCell && !nextCell);
  if (operation.path === "cell:add-node-after") return hasAddedNodeAfter(before, after, operation, pageId);
  if (operation.path === "cell:add-node-below") return hasAddedNodeBelow(before, after, operation, pageId);
  if (!nextCell) return false;

  const value = operation.value;
  const path = operation.path;
  if (path === "label") return labelMatches(nextCell, value);
  if (path === "style") return (nextCell.cell.getAttribute("style") || "") === value;
  if (path.startsWith("style:")) return styleKeyMatches(nextCell.cell.getAttribute("style") || "", path.slice(6), value);
  if (path.startsWith("valueAttr:")) {
    const key = path.slice(10);
    return attributeMatches(nextCell.wrapper, key, value);
  }
  if (path.startsWith("geometry:")) {
    if (!nextCell.geometry) return false;
    const key = path.slice(9);
    if (key === "size") {
      const [width, height, ...rest] = value.split(",").map(Number);
      return rest.length === 0 && Number.isFinite(width) && Number.isFinite(height) &&
        numericAttribute(nextCell.geometry, "width") === width && numericAttribute(nextCell.geometry, "height") === height;
    }
    if (key === "translate") {
      if (!oldCell?.geometry) return false;
      const [dx, dy, ...rest] = value.split(",").map(Number);
      const oldX = numericAttribute(oldCell.geometry, "x") ?? 0;
      const oldY = numericAttribute(oldCell.geometry, "y") ?? 0;
      const nextX = numericAttribute(nextCell.geometry, "x");
      const nextY = numericAttribute(nextCell.geometry, "y");
      return rest.length === 0 && Number.isFinite(dx) && Number.isFinite(dy) &&
        nextX !== null && nextY !== null && Math.abs(nextX - (oldX + dx)) < 0.000001 &&
        Math.abs(nextY - (oldY + dy)) < 0.000001;
    }
    if (key === "relative") {
      const expected = ["1", "true"].includes(value.toLowerCase()) ? "1" : "0";
      return boolAttribute(nextCell.geometry, "relative", false) === (expected === "1");
    }
    if (["x", "y", "width", "height"].includes(key)) {
      const expected = Number(value);
      return Number.isFinite(expected) && numericAttribute(nextCell.geometry, key) === expected;
    }
    return false;
  }
  if (path.startsWith("point:")) {
    const [, indexText, axis] = path.split(":");
    const index = Number(indexText);
    const expected = Number(value);
    const point = Number.isInteger(index) && index >= 0 ? pointFor(nextCell, index) : null;
    return Boolean(point && (axis === "x" || axis === "y") && Number.isFinite(expected) && numericAttribute(point, axis) === expected);
  }
  if (path.startsWith("cell:")) {
    const key = path.slice(5);
    if (["visible", "collapsed", "connectable"].includes(key)) {
      const requested = ["1", "true"].includes(value.toLowerCase());
      const defaultValue = key !== "collapsed";
      return boolAttribute(nextCell.cell, key, defaultValue) === requested;
    }
    if (key === "source" || key === "target" || key === "parent") {
      return (nextCell.cell.getAttribute(key) || "") === value;
    }
  }
  return false;
}

function isNativeRootOrLayerCell(record: CellRecord): boolean {
  return record.cell.getAttribute("vertex") !== "1" &&
    record.cell.getAttribute("edge") !== "1" &&
    record.geometry === null;
}

/**
 * Draw.io cell IDs are not semantic roles: duplicated/imported pages may prefix both the root
 * and layer IDs. Validate the relationship graph instead of assuming literal IDs "0" and "1".
 */
function hasValidNativeModelStructure(model: ModelRecords): boolean {
  const roots = model.cells.filter((record) =>
    !record.cell.hasAttribute("parent") && isNativeRootOrLayerCell(record)
  );
  if (roots.length !== 1) return false;
  const rootId = roots[0].id;
  return model.cells.some((record) =>
    record.cell.getAttribute("parent") === rootId && isNativeRootOrLayerCell(record)
  );
}

/**
 * A script addressed to __active_page__ is scoped to that page, not every page in the file.
 * A missing target page is a hard failure; never fall back to checking unrelated pages.
 * Bare mxGraphModel XML has no page envelope, so its single model is the active model.
 */
function hasValidScriptScope(xml: string, models: ModelRecords[], pageId?: string | null): boolean {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  if (root.nodeName === "mxGraphModel") {
    return models.length === 1 && hasValidNativeModelStructure(models[0]);
  }
  if (root.nodeName !== "mxfile") return false;
  const pages = elementChildren(root).filter((child) => child.nodeName === "diagram");
  if (pages.length === 0) return false;

  if (pageId === "") return false;
  if (pageId != null) {
    const targetPage = pages.find((page) => page.getAttribute("id") === pageId);
    if (!targetPage) return false;
    const targetModel = models.find((model) => model.pageId === pageId);
    return Boolean(targetModel && hasValidNativeModelStructure(targetModel));
  }

  // Without an explicit page ID, preserve whole-document validation semantics.
  return models.length === pages.length && models.every(hasValidNativeModelStructure);
}

/**
 * Typed operations are confirmed against their requested native XML postconditions.
 * Direct scripts use relationship-based native structure validation, scoped to the requested
 * active page. Script-specific business postconditions are handled by the caller using the
 * bounded JSON result and the serialized XML; structural validity alone is not proof of intent.
 */
export function nativeEditIsReflectedInXml(input: NativeEditConfirmationInput): boolean {
  try {
    const before = cellsForXml(input.beforeXml);
    const after = cellsForXml(input.xml);
    const operations: NativeEditOperation[] = input.path === "cell:batch"
      ? JSON.parse(input.value) as NativeEditOperation[]
      : [{ cellId: input.cellId, path: input.path, value: input.value }];
    if (!Array.isArray(operations) || operations.length === 0 ||
        !operations.every((operation) => Boolean(operation && typeof operation.cellId === "string" &&
          typeof operation.path === "string" && typeof operation.value === "string"))) return false;

    // Selection is native UI state, not a serialized document mutation. Confirm that the
    // target still exists, but never require a <mxCell> change for cell:select itself.
    const selectionOperations = operations.filter((operation) => operation.path === "cell:select");
    if (selectionOperations.some((operation) =>
      !findCell(before, operation.cellId, input.pageId) || !findCell(after, operation.cellId, input.pageId)
    )) return false;

    const documentOperations = operations.filter((operation) => operation.path !== "cell:select");
    if (documentOperations.length === 0) {
      return semanticDiagramSignature(input.beforeXml, input.pageId) === semanticDiagramSignature(input.xml, input.pageId);
    }
    if (documentOperations.length === 1 && documentOperations[0].path === "cell:execute-script") {
      return hasValidScriptScope(input.xml, after, input.pageId);
    }
    return documentOperations.every((operation) =>
      operationIsReflected(before, after, operation, input.pageId)
    );
  } catch {
    return false;
  }
}


export interface NativeScriptXmlPointAssertion {
  x: number | null;
  y: number | null;
}

export interface NativeScriptXmlGeometryAssertion {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  relative?: boolean | null;
  points?: NativeScriptXmlPointAssertion[] | null;
  offset?: NativeScriptXmlPointAssertion | null;
  sourcePoint?: NativeScriptXmlPointAssertion | null;
  targetPoint?: NativeScriptXmlPointAssertion | null;
}

export interface NativeScriptXmlCellAssertion {
  cellId: string;
  exists?: boolean;
  kind?: "vertex" | "edge";
  label?: string;
  /** Expected substring of the serialized native label, including rich labels/user objects. */
  labelContains?: string;
  parentId?: string | null;
  sourceId?: string | null;
  targetId?: string | null;
  style?: Record<string, string | null>;
  geometry?: NativeScriptXmlGeometryAssertion;
}

/** A bounded field-level diagnostic explaining why a script assertion was rejected. */
export type NativeScriptXmlAssertionFailureKind = "invalid-result" | "invalid-assertion" | "invalid-document" | "mismatch";

export interface NativeScriptXmlAssertionFailure {
  kind: NativeScriptXmlAssertionFailureKind;
  index: number | null;
  cellId?: string;
  field: string;
  reason: string;
  expected?: unknown;
  actual?: unknown;
}

export interface NativeScriptXmlValidationResult {
  ok: boolean;
  failures: NativeScriptXmlAssertionFailure[];
  /** Unknown metadata fields are reported here without masking verifiable, supported evidence. */
  warnings?: NativeScriptXmlAssertionFailure[];
}

function nativeAssertionStyleValue(style: string, key: string): Array<string | null> | null {
  const matches = style.split(";").map((part) => {
    const index = part.indexOf("=");
    return index < 0
      ? { key: part.trim(), value: null as string | null }
      : { key: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
  }).filter((entry) => entry.key === key);
  return matches.length ? matches.map((entry) => entry.value) : null;
}

function nativeEffectiveStyleMap(style: string | null): Map<string, string | null> {
  const effective = new Map<string, string | null>();
  for (const part of (style || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    const key = (separator < 0 ? trimmed : trimmed.slice(0, separator)).trim();
    if (!key) continue;
    effective.set(key, separator < 0 ? null : trimmed.slice(separator + 1).trim());
  }
  return effective;
}

function numericOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function numericXmlAttribute(element: Element | null, name: string): number | null {
  if (!element || !element.hasAttribute(name)) return null;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : null;
}

function nativeGeometryPoint(point: Element): { x: number | null; y: number | null } {
  return { x: numericXmlAttribute(point, "x"), y: numericXmlAttribute(point, "y") };
}

/** Structured geometry evidence uses native XML coordinates, not a reconstructed graph model. */
function nativeGeometryAssertionValue(geometry: Element | null, key: string): unknown {
  if (["x", "y", "width", "height"].includes(key)) return numericXmlAttribute(geometry, key);
  if (key === "relative") {
    if (!geometry || !geometry.hasAttribute("relative")) return null;
    const value = (geometry.getAttribute("relative") || "").toLowerCase();
    return value === "1" || value === "true";
  }
  if (!geometry) return null;
  if (key === "points") {
    const array = elementChildren(geometry).find((child) => child.nodeName === "Array" && child.getAttribute("as") === "points");
    return array ? elementChildren(array).filter((child) => child.nodeName === "mxPoint").map(nativeGeometryPoint) : null;
  }
  if (key === "offset" || key === "sourcePoint" || key === "targetPoint") {
    const point = elementChildren(geometry).find((child) => child.nodeName === "mxPoint" && child.getAttribute("as") === key);
    return point ? nativeGeometryPoint(point) : null;
  }
  return undefined;
}

function numericEvidenceMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null;
  return typeof expected === "number" && typeof actual === "number" &&
    Number.isFinite(expected) && Number.isFinite(actual) && Math.abs(expected - actual) <= 0.01;
}

function pointEvidenceMatches(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null;
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      !actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const requested = expected as Record<string, unknown>;
  const observed = actual as Record<string, unknown>;
  return ["x", "y"].every((axis) => axis in requested && numericEvidenceMatches(requested[axis], observed[axis]));
}

function geometryEvidenceMatches(key: string, expected: unknown, actual: unknown): boolean {
  if (key === "relative") return expected === actual;
  if (key === "points") {
    if (expected === null) return actual === null;
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    return expected.every((point, index) => pointEvidenceMatches(point, actual[index]));
  }
  if (key === "offset" || key === "sourcePoint" || key === "targetPoint") return pointEvidenceMatches(expected, actual);
  return numericEvidenceMatches(expected, actual);
}

function nativeGeometryChangedFields(before: Element | null, after: Element | null): string[] {
  if (!before || !after) return ["geometry"];
  const changed: string[] = [];
  for (const key of ["x", "y", "width", "height", "relative", "points", "offset", "sourcePoint", "targetPoint"]) {
    const left = nativeGeometryAssertionValue(before, key);
    const right = nativeGeometryAssertionValue(after, key);
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(key === "relative" ? "geometry.relative" : "geometry." + key);
  }
  const recognizedChildren = (geometry: Element) => elementChildren(geometry).filter((child) =>
    !(child.nodeName === "Array" && child.getAttribute("as") === "points") &&
    !(child.nodeName === "mxPoint" && ["offset", "sourcePoint", "targetPoint"].includes(child.getAttribute("as") || ""))
  );
  if (JSON.stringify(recognizedChildren(before).map(elementSignature)) !==
      JSON.stringify(recognizedChildren(after).map(elementSignature))) changed.push("geometry.other-children");
  return changed;
}

/**
 * Independently verifies script-declared native-cell evidence against serialized XML.
 * Boolean postconditions express what the script checked in the live editor; xmlAssertions
 * carry the concrete cell facts the host verifies after serialization.
 * Diagnostics distinguish invalid assertion structure from actual document mismatches.
 */
export function validateNativeScriptResultAgainstXml(
  scriptResult: unknown,
  xml: string,
  pageId: string | null
): NativeScriptXmlValidationResult {
  const failures: NativeScriptXmlAssertionFailure[] = [];
  const warnings: NativeScriptXmlAssertionFailure[] = [];
  const maxFailures = 100;
  const fail = (failure: NativeScriptXmlAssertionFailure) => {
    if (failures.length < maxFailures) failures.push(failure);
  };
  const warn = (warning: NativeScriptXmlAssertionFailure) => {
    if (warnings.length < maxFailures) warnings.push(warning);
  };
  const finish = (): NativeScriptXmlValidationResult => ({
    ok: failures.length === 0,
    failures,
    ...(warnings.length ? { warnings } : {})
  });

  try {
    if (!scriptResult || typeof scriptResult !== "object" || Array.isArray(scriptResult)) {
      fail({ kind: "invalid-result", index: null, field: "scriptResult", reason: "Script result must be a JSON object.", actual: scriptResult });
      return finish();
    }
    const outer = scriptResult as Record<string, unknown>;
    if (outer.available !== true || !outer.value || typeof outer.value !== "object" || Array.isArray(outer.value)) {
      fail({ kind: "invalid-result", index: null, field: "scriptResult.value", reason: "Script result does not contain an available JSON value.", actual: outer.available });
      return finish();
    }
    const value = outer.value as Record<string, unknown>;
    if (value.ok !== true) {
      fail({ kind: "invalid-result", index: null, field: "ok", reason: "Script result must declare ok: true.", expected: true, actual: value.ok });
    }
    if (!Array.isArray(value.xmlAssertions) || value.xmlAssertions.length === 0) {
      fail({ kind: "invalid-result", index: null, field: "xmlAssertions", reason: "At least one native-cell assertion is required.", expected: "non-empty array", actual: value.xmlAssertions });
      return finish();
    }

    const models = cellsForXml(xml);
    if (!hasValidScriptScope(xml, models, pageId)) {
      fail({ kind: "invalid-document", index: null, field: "document", reason: "The serialized XML does not contain a structurally valid native model for the requested page.", expected: pageId });
      return finish();
    }
    const scoped = scopedModels(models, pageId);
    if (scoped.length !== 1) {
      fail({ kind: "invalid-document", index: null, field: "pageId", reason: "The requested page or native model was not found uniquely in the serialized XML.", expected: pageId, actual: scoped.length });
      return finish();
    }
    // These are Studio-side assertion keys, not Draw.io cell attributes. labelContains is
    // the sole substring predicate; use it for titles embedded in rich labels as well.
    const allowedFields = new Set([
      "cellId", "exists", "kind", "label", "labelContains",
      "parentId", "sourceId", "targetId", "style", "geometry"
    ]);
    const evidenceFieldsAllowed = new Set([
      "kind", "label", "labelContains", "parentId", "sourceId", "targetId", "style", "geometry"
    ]);
    const geometryFields = new Set(["x", "y", "width", "height", "relative", "points", "offset", "sourcePoint", "targetPoint"]);

    const attributeMatches = (cell: Element, key: "parent" | "source" | "target", expected: unknown): boolean => {
      if (expected !== null && typeof expected !== "string") return false;
      return expected === null
        ? !cell.hasAttribute(key) || cell.getAttribute(key) === ""
        : cell.getAttribute(key) === expected;
    };
    const styleMatches = (style: string, key: string, expected: unknown): boolean => {
      if (expected !== null && typeof expected !== "string") return false;
      const occurrences = nativeAssertionStyleValue(style, key);
      // mxGraph style parsing applies the last occurrence of a duplicated key.
      // Match that effective value instead of accepting any stale earlier occurrence.
      const effectiveValue = occurrences && occurrences.length > 0 ? occurrences[occurrences.length - 1] : undefined;
      return expected === null ? effectiveValue === undefined : effectiveValue === expected;
    };

    value.xmlAssertions.forEach((raw, assertionIndex) => {
      let cellId = "";
      const invalid = (field: string, reason: string, expected?: unknown, actual?: unknown,
        kind: NativeScriptXmlAssertionFailureKind = "invalid-assertion") => {
        fail({ kind, index: assertionIndex, ...(cellId ? { cellId } : {}), field, reason,
          ...(expected !== undefined ? { expected } : {}), ...(actual !== undefined ? { actual } : {}) });
      };
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        invalid("assertion", "Each assertion must be a JSON object.", "object", raw);
        return;
      }

      const assertion = raw as Record<string, unknown>;
      cellId = typeof assertion.cellId === "string" ? assertion.cellId.trim() : "";
      let shapeInvalid = false;
      for (const key of Object.keys(assertion)) {
        if (!allowedFields.has(key)) {
          warn({
            kind: "invalid-assertion",
            index: assertionIndex,
            ...(cellId ? { cellId } : {}),
            field: key,
            reason: "Unknown assertion field '" + key + "' was ignored. Supported evidence fields: " +
              [...allowedFields].join(", ") + ".",
            expected: [...allowedFields],
            actual: key
          });
        }
      }
      if (!cellId) {
        invalid("cellId", "A non-empty cellId is required.", "non-empty string", assertion.cellId);
        shapeInvalid = true;
      }
      if (assertion.exists !== undefined && typeof assertion.exists !== "boolean") {
        invalid("exists", "exists must be a boolean.", "boolean", assertion.exists);
        shapeInvalid = true;
      }
      if (assertion.kind !== undefined && assertion.kind !== "vertex" && assertion.kind !== "edge") {
        invalid("kind", "kind must be vertex or edge.", ["vertex", "edge"], assertion.kind);
        shapeInvalid = true;
      }
      if (assertion.label !== undefined && typeof assertion.label !== "string") {
        invalid("label", "label must be a string; an empty string is valid.", "string", assertion.label);
        shapeInvalid = true;
      }
      for (const key of ["labelContains"] as const) {
        if (assertion[key] !== undefined &&
            (typeof assertion[key] !== "string" || !assertion[key].trim())) {
          invalid(key, key + " must be a non-empty string that the serialized label is expected to contain.",
            "non-empty string", assertion[key]);
          shapeInvalid = true;
        }
      }
      for (const key of ["parentId", "sourceId", "targetId"] as const) {
        if (assertion[key] !== undefined && assertion[key] !== null && typeof assertion[key] !== "string") {
          invalid(key, key + " must be a string or null.", ["string", "null"], assertion[key]);
          shapeInvalid = true;
        }
      }
      if (assertion.style !== undefined) {
        if (!assertion.style || typeof assertion.style !== "object" || Array.isArray(assertion.style)) {
          invalid("style", "style must be a non-empty object mapping style keys to expected values, not a full style string.", "Record<string, string | null>", typeof assertion.style);
          shapeInvalid = true;
        } else {
          const entries = Object.entries(assertion.style as Record<string, unknown>);
          if (entries.length === 0) {
            invalid("style", "An empty style object verifies no style keys; omit style or provide explicit key/value expectations.", "non-empty object", {});
            shapeInvalid = true;
          }
          for (const [key, expected] of entries) {
            if (!key.trim() || (expected !== null && typeof expected !== "string")) {
              invalid("style." + key, "Each style entry needs a non-empty key and a string or null expected value.", "string or null", expected);
              shapeInvalid = true;
            }
          }
        }
      }
      if (assertion.geometry !== undefined) {
        if (!assertion.geometry || typeof assertion.geometry !== "object" || Array.isArray(assertion.geometry)) {
          invalid("geometry", "geometry must be a non-empty object containing explicit geometry fields.", "object", assertion.geometry);
          shapeInvalid = true;
        } else {
          const entries = Object.entries(assertion.geometry as Record<string, unknown>);
          if (entries.length === 0) {
            invalid("geometry", "An empty geometry object verifies no properties; omit geometry or provide explicit expectations.", "non-empty object", {});
            shapeInvalid = true;
          }
          for (const [key, expected] of entries) {
            if (!geometryFields.has(key)) {
              invalid("geometry." + key, "Unknown geometry assertion field.", [...geometryFields], key);
              shapeInvalid = true;
            } else if (key === "relative") {
              if (expected !== null && typeof expected !== "boolean") {
                invalid("geometry.relative", "relative must be a boolean or null.", ["boolean", "null"], expected);
                shapeInvalid = true;
              }
            } else if (key === "points") {
              if (expected !== null && (!Array.isArray(expected) || expected.some((point) =>
                !point || typeof point !== "object" || Array.isArray(point) ||
                !("x" in (point as Record<string, unknown>)) || !("y" in (point as Record<string, unknown>)) ||
                !numericOrNull((point as Record<string, unknown>).x) || !numericOrNull((point as Record<string, unknown>).y)
              ))) {
                invalid("geometry.points", "points must be null or an array of {x, y} finite-number/null coordinates.", "Array<{x:number|null,y:number|null}> | null", expected);
                shapeInvalid = true;
              }
            } else if (key === "offset" || key === "sourcePoint" || key === "targetPoint") {
              if (expected !== null && (!expected || typeof expected !== "object" || Array.isArray(expected) ||
                !("x" in (expected as Record<string, unknown>)) || !("y" in (expected as Record<string, unknown>)) ||
                !numericOrNull((expected as Record<string, unknown>).x) || !numericOrNull((expected as Record<string, unknown>).y)
              )) {
                invalid("geometry." + key, key + " must be null or an {x, y} object with finite-number/null coordinates.", "{x:number|null,y:number|null} | null", expected);
                shapeInvalid = true;
              }
            } else if (!numericOrNull(expected)) {
              invalid("geometry." + key, "Coordinate and size expectations must be finite numbers or null.", "finite number or null", expected);
              shapeInvalid = true;
            }
          }
        }
      }

      const expectedExists = assertion.exists === undefined ? true : assertion.exists;
      // Unknown advisory fields (for example bodyTailPreserved) never count as evidence.
      const evidenceFields = Object.keys(assertion).filter((key) =>
        key !== "cellId" && key !== "exists" && evidenceFieldsAllowed.has(key)
      );
      if (expectedExists !== false && evidenceFields.length === 0) {
        invalid("assertion", "An assertion for an existing cell must include concrete property evidence; exists: true alone is too weak to verify the requested edit.", "kind, label, relationship, style or geometry expectation", assertion);
        shapeInvalid = true;
      }
      if (expectedExists === false && evidenceFields.length > 0) {
        invalid("assertion", "An assertion for a missing cell may contain only cellId and exists: false.", "{ cellId, exists: false }", Object.keys(assertion));
        shapeInvalid = true;
      }
      if (shapeInvalid) return;

      const candidates = scoped.flatMap((model) => model.cells.filter((item) => item.id === cellId));
      if (expectedExists === false) {
        if (candidates.length > 0) invalid("exists", "The cell exists in the serialized XML but was declared absent.", false, true, "mismatch");
        return;
      }
      if (candidates.length !== 1) {
        invalid("cellId", candidates.length === 0
          ? "The cell was not found on the requested page."
          : "The cell ID is ambiguous on the requested page.", cellId, candidates.length, "mismatch");
        return;
      }
      const record = candidates[0];

      const assertionKind = typeof assertion.kind === "string" ? assertion.kind : undefined;
      if (assertionKind !== undefined && record.cell.getAttribute(assertionKind) !== "1") {
        invalid("kind", "Serialized cell kind did not match.", assertionKind, record.cell.getAttribute("vertex") === "1" ? "vertex" : record.cell.getAttribute("edge") === "1" ? "edge" : "cell", "mismatch");
      }
      const actualLabel = findText(record);
      const normalizedActualLabel = normalizeLabel(actualLabel);
      const assertionLabel = typeof assertion.label === "string" ? assertion.label : undefined;
      if (assertionLabel !== undefined &&
          !(actualLabel === assertionLabel || normalizedActualLabel === normalizeLabel(assertionLabel))) {
        invalid("label", "Serialized label did not match.", assertionLabel, actualLabel, "mismatch");
      }
      if (typeof assertion.labelContains === "string" &&
          !normalizedActualLabel.includes(normalizeLabel(assertion.labelContains))) {
        invalid("labelContains", "Serialized label did not contain the expected substring.", assertion.labelContains, actualLabel, "mismatch");
      }
      for (const key of ["parentId", "sourceId", "targetId"] as const) {
        if (assertion[key] === undefined) continue;
        const attribute = key === "parentId" ? "parent" : key === "sourceId" ? "source" : "target";
        if (!attributeMatches(record.cell, attribute, assertion[key])) {
          invalid(key, "Serialized cell relationship did not match.", assertion[key], record.cell.hasAttribute(attribute) ? record.cell.getAttribute(attribute) : null, "mismatch");
        }
      }
      if (assertion.style !== undefined) {
        const style = record.cell.getAttribute("style") || "";
        for (const [key, expected] of Object.entries(assertion.style as Record<string, string | null>)) {
          if (!styleMatches(style, key, expected)) {
            invalid("style." + key, "Serialized style key did not match.", expected, nativeAssertionStyleValue(style, key), "mismatch");
          }
        }
      }
      if (assertion.geometry !== undefined) {
        if (!record.geometry) {
          invalid("geometry", "The serialized cell has no geometry element.", assertion.geometry, null, "mismatch");
        } else {
          const geometry = assertion.geometry as Record<string, unknown>;
          for (const [key, expected] of Object.entries(geometry)) {
            const actual = nativeGeometryAssertionValue(record.geometry, key);
            if (!geometryEvidenceMatches(key, expected, actual)) {
              invalid("geometry." + key, "Serialized geometry value did not match.", expected, actual, "mismatch");
            }
          }
        }
      }
    });

    if (value.ok !== true && failures.length === 0) {
      fail({ kind: "invalid-result", index: null, field: "ok", reason: "Script result must declare ok: true.", expected: true, actual: value.ok });
    }
    return finish();
  } catch (error) {
    fail({
      kind: "invalid-document",
      index: null,
      field: "xml",
      reason: "Unable to validate assertions against serialized Draw.io XML.",
      actual: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
    });
    return finish();
  }
}

/** Backward-compatible boolean API for callers that only need the verification result. */
export function nativeScriptResultMatchesXml(
  scriptResult: unknown,
  xml: string,
  pageId: string | null
): boolean {
  return validateNativeScriptResultAgainstXml(scriptResult, xml, pageId).ok;
}


export interface NativeScriptScopeViolation {
  kind: "added" | "changed" | "removed" | "unproven-change";
  cellId: string;
  pageId: string | null;
  label: string;
  changedFields?: string[];
}

export interface NativeScriptScopeResult {
  ok: boolean;
  available: boolean;
  /** Whether the serialized before/after XML contains semantic changes when comparison is available. */
  changed?: boolean;
  declaredCellIds: string[];
  violations: NativeScriptScopeViolation[];
  error?: string;
}

/** Cell IDs the script itself declared in `xmlAssertions`; `exists: false` declares a removal. */
export function declaredNativeScriptCellIds(scriptResult: unknown): string[] {
  if (!scriptResult || typeof scriptResult !== "object" || Array.isArray(scriptResult)) return [];
  const value = (scriptResult as Record<string, unknown>).value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const assertions = (value as Record<string, unknown>).xmlAssertions;
  if (!Array.isArray(assertions)) return [];
  const ids = assertions.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const cellId = (raw as { cellId?: unknown }).cellId;
    return typeof cellId === "string" && cellId.trim() ? [cellId.trim()] : [];
  });
  return [...new Set(ids)];
}

/**
 * A passing assertion proves the declared cells changed; it does not prove that nothing else did.
 * Compare the before/after XML and require every newly created, changed or removed cell to be
 * declared by the script. Declarations are scoped to the request's active page, so duplicate IDs
 * on other pages cannot authorize an undeclared cross-page change.
 */
export function findUndeclaredNativeScriptChanges(
  beforeXml: string,
  afterXml: string,
  scriptResult: unknown,
  maxViolations = 20,
  expectedPageId?: string | null
): NativeScriptScopeResult {
  const declaredCellIds = declaredNativeScriptCellIds(scriptResult);
  const diff = summarizeNativeDiagramXmlDiff(beforeXml, afterXml, 500);
  if (!diff.available || typeof diff.changed !== "boolean") {
    return {
      ok: false, available: false, declaredCellIds, violations: [],
      error: diff.error || "The before/after native XML could not be compared."
    };
  }
  if (diff.truncated) {
    return {
      ok: false, available: false, changed: diff.changed, declaredCellIds, violations: [],
      error: "The before/after native XML change set is too large to verify every untouched cell."
    };
  }
  const declared = new Set(declaredCellIds);
  // A bare mxGraphModel has no page envelope, although the editor still has an active page ID.
  // The validator deliberately treats a single bare model as unambiguous for that page.
  const beforeModels = modelRoots(beforeXml);
  const afterModels = modelRoots(afterXml);
  const isStandaloneModelPair = beforeModels.length === 1 && beforeModels[0].standalone &&
    afterModels.length === 1 && afterModels[0].standalone;
  const scopedExpectedPageId = isStandaloneModelPair ? null : expectedPageId;
  const isDeclaredOnExpectedPage = (cell: { id: string; pageId: string | null }) =>
    declared.has(cell.id) && (expectedPageId === undefined || cell.pageId === scopedExpectedPageId);
  const envelope = scriptResult && typeof scriptResult === "object" && !Array.isArray(scriptResult)
    ? (scriptResult as Record<string, unknown>).value
    : null;
  const assertionRows = envelope && typeof envelope === "object" && !Array.isArray(envelope) &&
    Array.isArray((envelope as Record<string, unknown>).xmlAssertions)
    ? ((envelope as Record<string, unknown>).xmlAssertions as unknown[]).filter((raw): raw is Record<string, unknown> =>
        Boolean(raw) && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as Record<string, unknown>).cellId === "string")
    : [];
  const assertionForCell = (cellId: string): Record<string, unknown> | null => {
    const matches = assertionRows.filter((assertion) => String(assertion.cellId).trim() === cellId);
    if (!matches.length) return null;
    return Object.assign({}, ...matches);
  };
  const matchesField = (record: Record<string, unknown> | null, field: string): boolean =>
    Boolean(record && Object.prototype.hasOwnProperty.call(record, field));
  const findRecord = (models: ModelRecords[], pageId: string | null, cellId: string): CellRecord | null => {
    const matches = models.flatMap((model) => model.cells.filter((cell) => cell.pageId === pageId && cell.id === cellId));
    return matches.length === 1 ? matches[0] : null;
  };
  const beforeCells = cellsForXml(beforeXml);
  const afterCells = cellsForXml(afterXml);
  const missingEvidenceForChange = (
    oldRecord: CellRecord | null, nextRecord: CellRecord | null, changedFields: string[], assertion: Record<string, unknown> | null
  ): string[] => {
    if (!oldRecord || !nextRecord || !assertion) return ["cell assertion"];
    const missing: string[] = [];
    const hasLabelEvidence = matchesField(assertion, "label") ||
      (typeof assertion.labelContains === "string" && Boolean(assertion.labelContains.trim()));
    if (changedFields.includes("label") && !hasLabelEvidence) missing.push("label");
    if (changedFields.includes("parent") && !matchesField(assertion, "parentId")) missing.push("parentId");
    if (changedFields.includes("source") && !matchesField(assertion, "sourceId")) missing.push("sourceId");
    if (changedFields.includes("target") && !matchesField(assertion, "targetId")) missing.push("targetId");
    if ((changedFields.includes("vertex") || changedFields.includes("edge")) && !matchesField(assertion, "kind")) missing.push("kind");
    if (changedFields.includes("style")) {
      const beforeStyle = nativeEffectiveStyleMap(oldRecord.cell.getAttribute("style"));
      const afterStyle = nativeEffectiveStyleMap(nextRecord.cell.getAttribute("style"));
      const changedKeys = new Set([...beforeStyle.keys(), ...afterStyle.keys()]);
      const assertionStyle = assertion.style && typeof assertion.style === "object" && !Array.isArray(assertion.style)
        ? assertion.style as Record<string, unknown> : {};
      for (const key of changedKeys) {
        if (beforeStyle.has(key) === afterStyle.has(key) && beforeStyle.get(key) === afterStyle.get(key)) continue;
        if (!Object.prototype.hasOwnProperty.call(assertionStyle, key)) missing.push("style." + key);
      }
    }
    if (changedFields.includes("geometry")) {
      const changedGeometry = nativeGeometryChangedFields(oldRecord.geometry, nextRecord.geometry);
      for (const field of changedGeometry) {
        if (field === "geometry") {
          if (!matchesField(assertion, "geometry")) missing.push("geometry");
          continue;
        }
        const key = field.startsWith("geometry.") ? field.slice("geometry.".length) : field;
        const assertionGeometry = assertion.geometry && typeof assertion.geometry === "object" && !Array.isArray(assertion.geometry)
          ? assertion.geometry as Record<string, unknown> : {};
        if (!Object.prototype.hasOwnProperty.call(assertionGeometry, key)) missing.push(field);
      }
    }
    if (changedFields.includes("attributes-or-children")) missing.push("custom attributes/children (no assertion field exists)");
    return [...new Set(missing)];
  };
  // A removed page takes its cells with it; page-level operations are not cell edits.
  const removedPages = new Set((diff.pagesRemoved ?? []).map((pageId) => String(pageId)));
  const violations: NativeScriptScopeViolation[] = [];
  // Cell assertions cannot prove page-level changes. Until a dedicated page assertion contract
  // exists, fail closed on page creation/removal/rename/reorder instead of claiming an edit passed.
  const pageChanges = [
    ...(diff.pagesAdded ?? []).map((pageId) => "page-added:" + pageId),
    ...(diff.pagesRemoved ?? []).map((pageId) => "page-removed:" + pageId),
    ...(diff.pagesRenamed ?? []).map((page) => "page-renamed:" + page.id + ":" + page.before + "->" + page.after),
    ...(diff.pageOrderChanged ? ["page-order-changed"] : [])
  ];
  if (pageChanges.length) {
    violations.push({
      kind: "unproven-change", cellId: "__pages__", pageId: null, label: "Draw.io pages",
      changedFields: pageChanges.slice(0, 20)
    });
  }
  for (const cell of diff.cellsAdded ?? []) {
    if (!isDeclaredOnExpectedPage(cell)) {
      violations.push({ kind: "added", cellId: cell.id, pageId: cell.pageId, label: cell.label, changedFields: ["created"] });
      continue;
    }
    const assertion = assertionForCell(cell.id);
    const hasLabelEvidence = matchesField(assertion, "label") ||
      (assertion !== null && typeof assertion.labelContains === "string" && Boolean(assertion.labelContains.trim()));
    const missing = cell.kind === "vertex"
      ? ["kind"].filter((field) => !matchesField(assertion, field)).concat(hasLabelEvidence ? [] : ["label"])
      : cell.kind === "edge"
        ? ["kind", "sourceId", "targetId"].filter((field) => !matchesField(assertion, field))
        : ["kind (unsupported cell type)"];
    if (missing.length) violations.push({
      kind: "unproven-change", cellId: cell.id, pageId: cell.pageId, label: cell.label,
      changedFields: ["created", ...missing.map((field) => "assertion." + field)]
    });
  }
  for (const cell of diff.cellsRemoved ?? []) {
    if (cell.pageId !== null && removedPages.has(String(cell.pageId))) continue;
    if (!isDeclaredOnExpectedPage(cell)) {
      violations.push({ kind: "removed", cellId: cell.id, pageId: cell.pageId, label: cell.label });
      continue;
    }
    const assertion = assertionForCell(cell.id);
    if (assertion?.exists !== false) violations.push({
      kind: "unproven-change", cellId: cell.id, pageId: cell.pageId, label: cell.label,
      changedFields: ["assertion.exists=false"]
    });
  }
  for (const cell of diff.cellsChanged ?? []) {
    if (!isDeclaredOnExpectedPage(cell)) {
      violations.push({
        kind: "changed", cellId: cell.id, pageId: cell.pageId,
        label: cell.labelAfter || cell.labelBefore, changedFields: cell.changedFields
      });
      continue;
    }
    const assertion = assertionForCell(cell.id);
    const oldRecord = findRecord(beforeCells, cell.pageId, cell.id);
    const nextRecord = findRecord(afterCells, cell.pageId, cell.id);
    const missing = missingEvidenceForChange(oldRecord, nextRecord, cell.changedFields, assertion);
    if (missing.length) violations.push({
      kind: "unproven-change", cellId: cell.id, pageId: cell.pageId,
      label: cell.labelAfter || cell.labelBefore, changedFields: missing
    });
  }
  const limit = Math.max(1, Math.floor(maxViolations) || 20);
  return {
    ok: violations.length === 0, available: true, changed: diff.changed, declaredCellIds,
    violations: violations.slice(0, limit),
    ...(violations.length > limit ? { error: violations.length + " undeclared native cells were added, changed or removed; only the first " + limit + " are listed." } : {})
  };
}

export interface NativeDiagramXmlDiffSummary {
  available: boolean;
  changed?: boolean;
  pagesBefore?: number;
  pagesAfter?: number;
  pageOrderChanged?: boolean;
  pagesChanged?: string[];
  pagesAdded?: string[];
  pagesRemoved?: string[];
  pagesRenamed?: Array<{ id: string; before: string; after: string }>;
  cellsAdded?: Array<{ pageId: string | null; id: string; label: string; kind: string; sourceId?: string; targetId?: string }>;
  cellsRemoved?: Array<{ pageId: string | null; id: string; label: string; kind: string; sourceId?: string; targetId?: string }>;
  cellsChanged?: Array<{ pageId: string | null; id: string; labelBefore: string; labelAfter: string; kind: string; changedFields: string[] }>;
  truncated?: boolean;
  error?: string;
}

/**
 * Summarizes a native XML before/after pair for local execution traces. It intentionally keeps
 * the saved XML as the sole model and emits only a bounded summary, not another persisted graph.
 */
export function summarizeNativeDiagramXmlDiff(
  beforeXml: string,
  afterXml: string,
  maxItems = 100
): NativeDiagramXmlDiffSummary {
  const limit = Math.max(1, Math.min(500, Math.floor(maxItems) || 100));
  try {
    const pageInfo = (xml: string): Array<{ id: string | null; title: string }> => {
      const root = parseDrawioXml(xml).documentElement;
      if (root.nodeName === "mxGraphModel") return [{ id: null, title: "Diagram" }];
      if (root.nodeName !== "mxfile") return [];
      return elementChildren(root).filter((child) => child.nodeName === "diagram").map((page, index) => ({
        id: page.getAttribute("id") || null,
        title: page.getAttribute("name") || "Page " + (index + 1)
      }));
    };
    const beforePages = pageInfo(beforeXml);
    const afterPages = pageInfo(afterXml);
    const beforePageMap = new Map(beforePages.map((page, index) => [page.id ?? "__single__", { ...page, index }]));
    const afterPageMap = new Map(afterPages.map((page, index) => [page.id ?? "__single__", { ...page, index }]));
    const pagesAddedAll = afterPages.filter((page) => !beforePageMap.has(page.id ?? "__single__")).map((page) => page.id ?? page.title);
    const pagesRemovedAll = beforePages.filter((page) => !afterPageMap.has(page.id ?? "__single__")).map((page) => page.id ?? page.title);
    const pagesRenamedAll: Array<{ id: string; before: string; after: string }> = [];
    for (const page of afterPages) {
      const key = page.id ?? "__single__";
      const old = beforePageMap.get(key);
      if (old && old.title !== page.title) pagesRenamedAll.push({ id: page.id ?? "__single__", before: old.title, after: page.title });
    }

    const records = (xml: string) => cellsForXml(xml);
    const beforeRecords = records(beforeXml);
    const afterRecords = records(afterXml);
    const mapCells = (models: ModelRecords[]) => {
      const map = new Map<string, CellRecord>();
      for (const model of models) {
        for (const cell of model.cells) map.set((model.pageId ?? "__single__") + "::" + cell.id, cell);
      }
      return map;
    };
    const beforeCells = mapCells(beforeRecords);
    const afterCells = mapCells(afterRecords);
    const summarize = (cell: CellRecord) => ({
      pageId: cell.pageId,
      id: cell.id,
      label: findText(cell).replace(/\s+/g, " ").trim().slice(0, 240),
      kind: cell.cell.getAttribute("edge") === "1" ? "edge" : cell.cell.getAttribute("vertex") === "1" ? "vertex" : "cell",
      ...(cell.cell.getAttribute("source") ? { sourceId: cell.cell.getAttribute("source")! } : {}),
      ...(cell.cell.getAttribute("target") ? { targetId: cell.cell.getAttribute("target")! } : {})
    });
    const addedAll = [...afterCells.entries()].filter(([key]) => !beforeCells.has(key)).map(([, cell]) => summarize(cell));
    const removedAll = [...beforeCells.entries()].filter(([key]) => !afterCells.has(key)).map(([, cell]) => summarize(cell));
    const changedPageIdsAll: string[] = [];
    for (const page of afterPages) {
      const key = page.id ?? "__single__";
      if (!beforePageMap.has(key)) continue;
      const beforeSignature = semanticDiagramSignature(beforeXml, page.id);
      const afterSignature = semanticDiagramSignature(afterXml, page.id);
      if (beforeSignature !== afterSignature) changedPageIdsAll.push(key);
    }
    const changedAll: Array<{ pageId: string | null; id: string; labelBefore: string; labelAfter: string; kind: string; changedFields: string[] }> = [];
    for (const [key, next] of afterCells) {
      const old = beforeCells.get(key);
      if (!old || JSON.stringify(elementSignature(old.wrapper)) === JSON.stringify(elementSignature(next.wrapper))) continue;
      const changedFields: string[] = [];
      if (findText(old) !== findText(next)) changedFields.push("label");
      if ((old.cell.getAttribute("style") || "") !== (next.cell.getAttribute("style") || "")) changedFields.push("style");
      if (JSON.stringify(old.geometry ? elementSignature(old.geometry) : null) !==
          JSON.stringify(next.geometry ? elementSignature(next.geometry) : null)) changedFields.push("geometry");
      for (const attr of ["parent", "source", "target", "vertex", "edge"]) {
        if ((old.cell.getAttribute(attr) || "") !== (next.cell.getAttribute(attr) || "")) changedFields.push(attr);
      }
      if (!changedFields.length) changedFields.push("attributes-or-children");
      changedAll.push({
        pageId: next.pageId,
        id: next.id,
        labelBefore: findText(old).replace(/\s+/g, " ").trim().slice(0, 240),
        labelAfter: findText(next).replace(/\s+/g, " ").trim().slice(0, 240),
        kind: next.cell.getAttribute("edge") === "1" ? "edge" : next.cell.getAttribute("vertex") === "1" ? "vertex" : "cell",
        changedFields
      });
    }
    const sortCell = (left: { pageId: string | null; id: string }, right: { pageId: string | null; id: string }) =>
      String(left.pageId ?? "").localeCompare(String(right.pageId ?? "")) || left.id.localeCompare(right.id);
    addedAll.sort(sortCell);
    removedAll.sort(sortCell);
    changedAll.sort(sortCell);
    const pageOrderChanged = beforePages.map((page) => page.id ?? "__single__").join("\u0000") !==
      afterPages.map((page) => page.id ?? "__single__").join("\u0000");
    const changed = pageOrderChanged || pagesAddedAll.length > 0 || pagesRemovedAll.length > 0 ||
      pagesRenamedAll.length > 0 || changedPageIdsAll.length > 0 || addedAll.length > 0 || removedAll.length > 0 || changedAll.length > 0;
    return {
      available: true,
      changed,
      pagesBefore: beforePages.length,
      pagesAfter: afterPages.length,
      pageOrderChanged,
      pagesChanged: changedPageIdsAll.slice(0, limit),
      pagesAdded: pagesAddedAll.slice(0, limit),
      pagesRemoved: pagesRemovedAll.slice(0, limit),
      pagesRenamed: pagesRenamedAll.slice(0, limit),
      cellsAdded: addedAll.slice(0, limit),
      cellsRemoved: removedAll.slice(0, limit),
      cellsChanged: changedAll.slice(0, limit),
      truncated: changedPageIdsAll.length > limit || pagesAddedAll.length > limit || pagesRemovedAll.length > limit ||
        pagesRenamedAll.length > limit || addedAll.length > limit || removedAll.length > limit || changedAll.length > limit
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000) };
  }
}
