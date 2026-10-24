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

function modelRoots(xml: string): Array<{ pageId: string | null; model: Element }> {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  if (root.nodeName === "mxGraphModel") return [{ pageId: null, model: root }];
  if (root.nodeName !== "mxfile") return [];

  const result: Array<{ pageId: string | null; model: Element }> = [];
  for (const page of elementChildren(root).filter((child) => child.nodeName === "diagram")) {
    const pageId = page.getAttribute("id") || null;
    const inlineModel = directChild(page, "mxGraphModel");
    if (inlineModel) {
      result.push({ pageId, model: inlineModel });
      continue;
    }
    const payload = (page.textContent || "").trim();
    if (!payload) continue;
    const decoded = parseDrawioXml(decodeDrawioPageXml(payload));
    if (decoded.documentElement.nodeName === "mxGraphModel") result.push({ pageId, model: decoded.documentElement });
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

function semanticDiagramSignature(xml: string, pageId?: string | null): string {
  const document = parseDrawioXml(xml);
  const root = document.documentElement;
  if (root.nodeName !== "mxfile") return JSON.stringify(elementSignature(root));
  const pages = elementChildren(root).filter((child) => child.nodeName === "diagram");
  const page = pageId ? pages.find((candidate) => candidate.getAttribute("id") === pageId) : null;
  if (pageId) {
    if (!page) return "missing-page:" + pageId;
    const models = modelRoots(xml);
    const matchingModel = models.find((entry) => entry.pageId === pageId);
    return JSON.stringify({
      pageId,
      pageName: page.getAttribute("name") || null,
      model: matchingModel ? elementSignature(matchingModel.model) : null
    });
  }
  const models = modelRoots(xml);
  return JSON.stringify(pages.map((candidate) => {
    const candidateId = candidate.getAttribute("id") || null;
    const matchingModel = models.find((entry) => entry.pageId === candidateId);
    return { pageId: candidateId, pageName: candidate.getAttribute("name") || null, model: matchingModel ? elementSignature(matchingModel.model) : null };
  }));
}

function cellsForXml(xml: string): ModelRecords[] {
  return modelRoots(xml).map(({ pageId, model }) => {
    const root = directChild(model, "root");
    if (!root) return { pageId, cells: [] };
    const cells: CellRecord[] = [];
    for (const item of elementChildren(root)) {
      const cell = item.nodeName === "mxCell" ? item : directChild(item, "mxCell");
      if (!cell) continue;
      const id = item === cell ? cell.getAttribute("id") : item.getAttribute("id") || cell.getAttribute("id");
      if (!id) continue;
      cells.push({ id, pageId, wrapper: item, cell, geometry: directChild(cell, "mxGeometry") });
    }
    return { pageId, cells };
  });
}

function findCell(models: ModelRecords[], cellId: string, pageId?: string | null): CellRecord | null {
  for (const model of models) {
    if (pageId && model.pageId !== null && model.pageId !== pageId) continue;
    const cell = model.cells.find((item) => item.id === cellId);
    if (cell) return cell;
  }
  return null;
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
  for (const model of after) {
    if (pageId && model.pageId !== null && model.pageId !== pageId) continue;
    for (const candidate of model.cells) {
      if (candidate.id === operation.cellId || candidate.cell.getAttribute("vertex") !== "1" || !labelMatches(candidate, payload.label.trim())) continue;
      const existedBefore = before.some((oldModel) => oldModel.cells.some((oldCell) =>
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
  for (const model of after) {
    if (pageId && model.pageId !== null && model.pageId !== pageId) continue;
    for (const candidate of model.cells) {
      if (candidate.id === operation.cellId || candidate.cell.getAttribute("vertex") !== "1" ||
          !labelMatches(candidate, expectedLabel) || !candidate.geometry) continue;
      const candidateX = numericAttribute(candidate.geometry, "x");
      const candidateY = numericAttribute(candidate.geometry, "y");
      const candidateWidth = numericAttribute(candidate.geometry, "width");
      if (candidateX === null || candidateY === null || candidateWidth === null ||
          candidateY < targetY + targetHeight + 1 ||
          Math.abs((candidateX + candidateWidth / 2) - (targetX + targetWidth / 2)) > 1) continue;
      const existedBefore = before.some((oldModel) => oldModel.cells.some((oldCell) =>
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
  if (path === "cell:set-c4-type") {
    let payload: { kind?: unknown };
    try { payload = JSON.parse(value) as { kind?: unknown }; } catch { return false; }
    const presets = {
      person: { type: "Person", fill: "#083F75", stroke: "#06315C", width: 200, height: 180, shape: "mxgraph.c4.person2" },
      system: { type: "Software System", fill: "#1061B0", stroke: "#0D5091", width: 240, height: 120, shape: null },
      external: { type: "Software System", fill: "#8C8496", stroke: "#736782", width: 240, height: 120, shape: null }
    } as const;
    if (payload.kind !== "person" && payload.kind !== "system" && payload.kind !== "external") return false;
    const preset = presets[payload.kind];
    const style = nextCell.cell.getAttribute("style") || "";
    const labelTemplate = nextCell.wrapper.getAttribute("label") || "";
    return nextCell.cell.getAttribute("vertex") === "1" &&
      nextCell.wrapper.getAttribute("placeholders") === "1" &&
      Boolean(nextCell.wrapper.getAttribute("c4Name")?.trim()) &&
      nextCell.wrapper.getAttribute("c4Type") === preset.type &&
      nextCell.wrapper.hasAttribute("c4Description") &&
      labelTemplate.includes("%c4Name%") && labelTemplate.includes("%c4Type%") &&
      styleKeyMatches(style, "fillColor", preset.fill) &&
      styleKeyMatches(style, "strokeColor", preset.stroke) &&
      styleKeyMatches(style, "fontColor", "#ffffff") &&
      (preset.shape ? styleKeyMatches(style, "shape", preset.shape) : style.split(";").some((entry) => entry === "rounded=1") && styleKeyMatches(style, "shape", "")) &&
      numericAttribute(nextCell.geometry, "width") === preset.width &&
      numericAttribute(nextCell.geometry, "height") === preset.height;
  }
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

/**
 * Typed operations are confirmed against their requested native XML postconditions.
 * Direct scripts have an intentionally broader contract: a non-throwing script may mutate any
 * native editor structure, so its acknowledgement requires a valid serialized Draw.io document
 * rather than a predeclared cell-level postcondition allowlist.
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
      // The bridge has already confirmed that the script returned without throwing. At this point
      // the host has serialized and validated native Draw.io XML. Do not constrain what the script
      // may change to a predeclared cell-level postcondition: scripts may edit routing, groups,
      // custom attributes, layers, page metadata, or other native structures.
      return after.length > 0 && after.every((page) =>
        page.cells.some((cell) => cell.id === "0") && page.cells.some((cell) => cell.id === "1")
      );
    }
    return documentOperations.every((operation) =>
      operationIsReflected(before, after, operation, input.pageId)
    );
  } catch {
    return false;
  }
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
    const pageOrderChanged = beforePages.map((page) => page.id ?? "__single__").join("\\u0000") !==
      afterPages.map((page) => page.id ?? "__single__").join("\\u0000");
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
