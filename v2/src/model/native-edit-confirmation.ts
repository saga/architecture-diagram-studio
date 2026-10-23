import { decodeDrawioPageXml } from "./drawio-xml-schema";
import { parseDrawioXml } from "./drawio-xml-dom";
import type { NativeScriptPostcondition } from "./native-edit-operations";

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

function scriptSnapshotHasScopedChange(beforeXml: string, afterXml: string, pageId?: string | null): boolean {
  const beforeDocument = parseDrawioXml(beforeXml);
  const afterDocument = parseDrawioXml(afterXml);
  const beforeRoot = beforeDocument.documentElement;
  const afterRoot = afterDocument.documentElement;
  if (beforeRoot.nodeName !== afterRoot.nodeName) return false;

  // A standalone mxGraphModel represents one page. For mxfile, require the same ordered
  // page set and verify every non-target page is semantically unchanged.
  if (beforeRoot.nodeName === "mxGraphModel") {
    const beforeCells = cellsForXml(beforeXml);
    const afterCells = cellsForXml(afterXml);
    if (!findCell(beforeCells, "0", pageId) || !findCell(beforeCells, "1", pageId) ||
        !findCell(afterCells, "0", pageId) || !findCell(afterCells, "1", pageId)) return false;
    return JSON.stringify(elementSignature(beforeRoot)) !== JSON.stringify(elementSignature(afterRoot));
  }
  if (beforeRoot.nodeName !== "mxfile" || afterRoot.nodeName !== "mxfile" || !pageId) return false;

  const beforePages = elementChildren(beforeRoot).filter((child) => child.nodeName === "diagram");
  const afterPages = elementChildren(afterRoot).filter((child) => child.nodeName === "diagram");
  const getPageIds = (pages: Element[]) => pages.map((page) => page.getAttribute("id") || null);
  const beforeIds = getPageIds(beforePages);
  const afterIds = getPageIds(afterPages);
  if (beforeIds.some((id) => !id) || JSON.stringify(beforeIds) !== JSON.stringify(afterIds) || !beforeIds.includes(pageId)) {
    return false;
  }

  const pageMetadataSignature = (page: Element): string => JSON.stringify({
    attributes: Array.from(page.attributes)
      .map((attribute) => [attribute.name, attribute.value] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
    nonModelChildren: elementChildren(page)
      .filter((child) => child.nodeName !== "mxGraphModel")
      .map(elementSignature)
  });
  // The envelope/attributes of every page must remain unchanged, not only its ID/name.
  // This prevents a script from changing page-level flags while a cell mutation masks it.
  for (const candidateId of beforeIds) {
    const beforePage = beforePages.find((page) => page.getAttribute("id") === candidateId);
    const afterPage = afterPages.find((page) => page.getAttribute("id") === candidateId);
    if (!beforePage || !afterPage ||
        pageMetadataSignature(beforePage) !== pageMetadataSignature(afterPage)) return false;
  }

  const beforeCells = cellsForXml(beforeXml);
  const afterCells = cellsForXml(afterXml);
  // The active page must still exist with its root and default layer; otherwise a page/layer
  // deletion or graph replacement must not masquerade as a successful cell edit.
  for (const requiredId of ["0", "1"]) {
    if (!findCell(beforeCells, requiredId, pageId) || !findCell(afterCells, requiredId, pageId)) return false;
  }

  for (const otherPageId of beforeIds) {
    if (!otherPageId || otherPageId === pageId) continue;
    if (semanticDiagramSignature(beforeXml, otherPageId) !== semanticDiagramSignature(afterXml, otherPageId)) {
      return false;
    }
  }

  // This signature includes the page name plus the full native mxGraphModel, including
  // geometry, styles, page dimensions and grid settings. A style string alone is not enough.
  const beforeTarget = semanticDiagramSignature(beforeXml, pageId);
  const afterTarget = semanticDiagramSignature(afterXml, pageId);
  return beforeTarget !== afterTarget;
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
  if (expected === "") return matching.length === 0;
  if (normalized === "0" || normalized === "false") {
    return matching.length === 0 || matching.some((entry) => {
      const value = (entry.value || "").toLowerCase();
      return value === "0" || value === "false";
    });
  }
  if (normalized === "1" || normalized === "true") {
    return matching.some((entry) => {
      const value = (entry.value || "").toLowerCase();
      return entry.value === null || value === "1" || value === "true";
    });
  }
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

function recordsForPage(records: ModelRecords[], pageId?: string | null): CellRecord[] {
  return records
    .filter((model) => pageId ? model.pageId === pageId : model.pageId === null)
    .flatMap((model) => model.cells);
}

function resolveUniqueRecord(records: ModelRecords[], reference: string, pageId?: string | null): CellRecord | null {
  const scoped = recordsForPage(records, pageId);
  const byId = scoped.filter((record) => record.id === reference);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return null;
  const normalized = normalizeLabel(reference);
  const byLabel = scoped.filter((record) => normalizeLabel(findText(record)) === normalized);
  return byLabel.length === 1 ? byLabel[0] : null;
}

function recordHasType(record: CellRecord, cellType?: "vertex" | "edge"): boolean {
  if (!cellType) return true;
  return record.cell.getAttribute(cellType) === "1";
}

function resolveAfterTransition(
  before: ModelRecords[],
  after: ModelRecords[],
  reference: string,
  pageId?: string | null
): CellRecord | null {
  const previous = resolveUniqueRecord(before, reference, pageId);
  if (previous) {
    return recordsForPage(after, pageId).find((record) => record.id === previous.id) ?? null;
  }
  const candidate = resolveUniqueRecord(after, reference, pageId);
  if (!candidate) return null;
  return recordsForPage(before, pageId).some((record) => record.id === candidate.id) ? null : candidate;
}

function postconditionIsReflected(
  before: ModelRecords[],
  after: ModelRecords[],
  condition: NativeScriptPostcondition,
  pageId?: string | null
): boolean {
  switch (condition.kind) {
    case "cell_added": {
      const expected = normalizeLabel(condition.label);
      const oldIds = new Set(recordsForPage(before, pageId).map((record) => record.id));
      const added = recordsForPage(after, pageId).filter((record) =>
        !oldIds.has(record.id) &&
        normalizeLabel(findText(record)) === expected &&
        recordHasType(record, condition.cellType)
      );
      return added.length === 1;
    }
    case "cell_absent": {
      const oldTarget = resolveUniqueRecord(before, condition.target, pageId);
      return Boolean(oldTarget && !recordsForPage(after, pageId).some((record) => record.id === oldTarget.id));
    }
    case "label_equals": {
      const previous = resolveUniqueRecord(before, condition.target, pageId);
      const target = resolveAfterTransition(before, after, condition.target, pageId);
      return Boolean(target && (!previous || normalizeLabel(findText(previous)) !== normalizeLabel(condition.value)) &&
        labelMatches(target, condition.value));
    }
    case "style_equals": {
      const previous = resolveUniqueRecord(before, condition.target, pageId);
      const target = resolveAfterTransition(before, after, condition.target, pageId);
      if (!target) return false;
      const oldStyle = previous?.cell.getAttribute("style") || "";
      const nextStyle = target.cell.getAttribute("style") || "";
      return (!previous || !styleKeyMatches(oldStyle, condition.key, condition.value)) &&
        styleKeyMatches(nextStyle, condition.key, condition.value);
    }
    case "geometry_matches": {
      const previous = resolveUniqueRecord(before, condition.target, pageId);
      const target = resolveAfterTransition(before, after, condition.target, pageId);
      if (!target?.geometry || (previous && !previous.geometry)) return false;
      let changed = !previous;
      for (const key of ["x", "y", "width", "height"] as const) {
        const expected = condition[key];
        if (expected !== undefined) {
          const oldValue = previous ? numericAttribute(previous.geometry, key) : null;
          const nextValue = numericAttribute(target.geometry, key);
          if (nextValue === null || Math.abs(nextValue - expected) >= 0.01) return false;
          if (previous && (oldValue === null || Math.abs(oldValue - expected) >= 0.01)) changed = true;
        }
      }
      return changed && (condition.x !== undefined || condition.y !== undefined ||
        condition.width !== undefined || condition.height !== undefined);
    }
    case "edge_connects": {
      const previousSource = resolveUniqueRecord(before, condition.source, pageId);
      const previousTarget = resolveUniqueRecord(before, condition.target, pageId);
      const source = previousSource
        ? recordsForPage(after, pageId).find((record) => record.id === previousSource.id) ?? null
        : resolveUniqueRecord(after, condition.source, pageId);
      const target = previousTarget
        ? recordsForPage(after, pageId).find((record) => record.id === previousTarget.id) ?? null
        : resolveUniqueRecord(after, condition.target, pageId);
      if (!source || !target) return false;
      const previousById = new Map(recordsForPage(before, pageId).map((record) => [record.id, record]));
      return recordsForPage(after, pageId).some((record) => {
        if (record.cell.getAttribute("edge") !== "1" ||
            record.cell.getAttribute("source") !== source.id ||
            record.cell.getAttribute("target") !== target.id) return false;
        const previous = previousById.get(record.id);
        return !previous || previous.cell.getAttribute("edge") !== "1" ||
          previous.cell.getAttribute("source") !== source.id ||
          previous.cell.getAttribute("target") !== target.id;
      });
    }
    case "parent_is": {
      const previous = resolveUniqueRecord(before, condition.target, pageId);
      const target = resolveAfterTransition(before, after, condition.target, pageId);
      const previousParent = resolveUniqueRecord(before, condition.parent, pageId);
      const parent = previousParent
        ? recordsForPage(after, pageId).find((record) => record.id === previousParent.id) ?? null
        : resolveUniqueRecord(after, condition.parent, pageId);
      return Boolean(target && parent &&
        (!previous || (previous.cell.getAttribute("parent") || "") !== parent.id) &&
        target.cell.getAttribute("parent") === parent.id);
    }
    default:
      return false;
  }
}

interface NativeScriptPayload {
  script: string;
  postconditions: NativeScriptPostcondition[];
}

function parseNativeScriptPayload(value: string): NativeScriptPayload | null {
  try {
    const payload = JSON.parse(value) as { script?: unknown; postconditions?: unknown };
    if (typeof payload.script !== "string" || !payload.script.trim() ||
        !Array.isArray(payload.postconditions) || payload.postconditions.length < 1 ||
        payload.postconditions.length > 12) return null;
    const allowedKinds = new Set(["cell_added", "cell_absent", "label_equals", "style_equals", "geometry_matches", "edge_connects", "parent_is"]);
    if (!payload.postconditions.every((condition) =>
      Boolean(condition) && typeof condition === "object" && !Array.isArray(condition) &&
      typeof (condition as { kind?: unknown }).kind === "string" &&
      allowedKinds.has((condition as { kind: string }).kind)
    )) return null;
    return { script: payload.script, postconditions: payload.postconditions as NativeScriptPostcondition[] };
  } catch {
    return null;
  }
}

/**
 * An XML snapshot only confirms a native edit when that exact requested outcome is
 * visible in the snapshot. Generic autosaves and unrelated edits are not sufficient.
 * Fallback scripts require declarative postconditions; page changes alone never prove success.
 * Unknown operations fail closed so callers cannot report false success.
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
      const scriptOperation = documentOperations[0];
      if (operations.length !== 1 || scriptOperation.cellId !== "__active_page__") return false;
      const payload = parseNativeScriptPayload(scriptOperation.value);
      if (!payload || !scriptSnapshotHasScopedChange(input.beforeXml, input.xml, input.pageId)) return false;
      return payload.postconditions.every((condition) =>
        postconditionIsReflected(before, after, condition, input.pageId)
      );
    }
    return documentOperations.every((operation) =>
      operationIsReflected(before, after, operation, input.pageId)
    );
  } catch {
    return false;
  }
}
