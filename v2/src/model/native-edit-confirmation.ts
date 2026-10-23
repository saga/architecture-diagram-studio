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

function scriptModelEnvelopeSignature(xml: string, pageId?: string | null): string | null {
  const models = modelRoots(xml);
  const matching = models.find((entry) => entry.pageId === pageId) ??
    (models.length === 1 && models[0]?.pageId === null ? models[0] : undefined);
  if (!matching) return null;
  const model = matching.model;
  const root = directChild(model, "root");
  if (!root) return null;
  const attributes = (element: Element) => Array.from(element.attributes)
    .map((attribute) => [attribute.name, attribute.value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    modelAttributes: attributes(model),
    rootAttributes: attributes(root),
    nonRootChildren: elementChildren(model).filter((child) => child !== root).map(elementSignature)
  });
}

function scriptModelEnvelopeIsUnchanged(beforeXml: string, afterXml: string, pageId?: string | null): boolean {
  const before = scriptModelEnvelopeSignature(beforeXml, pageId);
  const after = scriptModelEnvelopeSignature(afterXml, pageId);
  return before !== null && before === after;
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

function pointsFor(record: CellRecord): Element[] {
  if (!record.geometry) return [];
  return elementChildren(record.geometry)
    .filter((child) => child.nodeName === "Array" && child.getAttribute("as") === "points")
    .flatMap((array) => elementChildren(array).filter((child) => child.nodeName === "mxPoint"));
}

function pointFor(record: CellRecord, index: number): Element | null {
  return pointsFor(record)[index] ?? null;
}

function styleAssertionMatches(style: string, key: string, expected: string): boolean {
  const entries = style.split(";").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? { key: entry, value: null as string | null } : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
  const matching = entries.filter((entry) => entry.key === key);
  if (expected === "") return matching.length === 0;
  return matching.some((entry) => entry.value === expected);
}

function scriptPostconditionMatches(
  records: ModelRecords[],
  condition: NativeScriptPostcondition,
  pageId?: string | null
): boolean {
  const record = findCell(records, condition.cellId, pageId);
  if (!condition.exists) return !record;
  if (!record) return false;
  if (condition.kind === "vertex" && record.cell.getAttribute("vertex") !== "1") return false;
  if (condition.kind === "edge" && record.cell.getAttribute("edge") !== "1") return false;
  if (condition.label !== undefined && !labelMatches(record, condition.label)) return false;
  if (condition.parentId !== undefined && (record.cell.getAttribute("parent") || "") !== condition.parentId) return false;
  if (condition.sourceId !== undefined && (record.cell.getAttribute("source") || "") !== condition.sourceId) return false;
  if (condition.targetId !== undefined && (record.cell.getAttribute("target") || "") !== condition.targetId) return false;
  const style = record.cell.getAttribute("style") || "";
  if (condition.style && Object.entries(condition.style).some(([key, expected]) =>
    !styleAssertionMatches(style, key, expected)
  )) return false;
  if (condition.geometry) {
    const geometry = condition.geometry;
    if (!record.geometry) return false;
    for (const key of ["x", "y", "width", "height"] as const) {
      if (geometry[key] !== undefined) {
        const actual = numericAttribute(record.geometry, key);
        if (actual === null || Math.abs(actual - geometry[key]!) > 0.02) return false;
      }
    }
    if (geometry.relative !== undefined && boolAttribute(record.geometry, "relative", false) !== geometry.relative) return false;
    if (geometry.points !== undefined) {
      const actualPoints = pointsFor(record);
      if (actualPoints.length !== geometry.points.length) return false;
      for (let index = 0; index < geometry.points.length; index += 1) {
        const actual = actualPoints[index]!;
        const expected = geometry.points[index]!;
        const x = numericAttribute(actual, "x");
        const y = numericAttribute(actual, "y");
        if (x === null || y === null || Math.abs(x - expected.x) > 0.02 || Math.abs(y - expected.y) > 0.02) return false;
      }
    }
  }
  return true;
}

function scriptCellKind(record: CellRecord): string {
  if (record.cell.getAttribute("vertex") === "1") return "vertex";
  if (record.cell.getAttribute("edge") === "1") return "edge";
  return "cell";
}

function scriptCellLabel(record: CellRecord): string {
  if (record.wrapper !== record.cell) {
    const wrapperLabel = record.wrapper.getAttribute("label");
    if (wrapperLabel !== null) return wrapperLabel;
    const wrapperValue = record.wrapper.getAttribute("value");
    if (wrapperValue !== null) return wrapperValue;
  }
  return record.cell.getAttribute("value") || "";
}

function scriptStyleMap(style: string): Record<string, string | null> {
  const entries: Record<string, string | null> = Object.create(null);
  for (const part of style.split(";").filter(Boolean)) {
    const separator = part.indexOf("=");
    entries[separator < 0 ? part : part.slice(0, separator)] =
      separator < 0 ? null : part.slice(separator + 1);
  }
  return entries;
}

function scriptGeometryState(record: CellRecord): {
  x: number | null; y: number | null; width: number | null; height: number | null;
  relative: boolean; points: Array<{ x: number | null; y: number | null }>;
} | null {
  if (!record.geometry) return null;
  return {
    x: numericAttribute(record.geometry, "x"),
    y: numericAttribute(record.geometry, "y"),
    width: numericAttribute(record.geometry, "width"),
    height: numericAttribute(record.geometry, "height"),
    relative: boolAttribute(record.geometry, "relative", false),
    points: pointsFor(record).map((point) => ({
      x: numericAttribute(point, "x"),
      y: numericAttribute(point, "y")
    }))
  };
}

/** Properties not covered by the postcondition contract must not change implicitly. */
function unmodeledCellSignature(record: CellRecord): string {
  const attributeSignature = (element: Element, excluded: ReadonlySet<string>) =>
    Array.from(element.attributes)
      .filter((attribute) => !excluded.has(attribute.name))
      .map((attribute) => [attribute.name, attribute.value] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  const standardCellAttributes = new Set([
    "id", "value", "style", "vertex", "edge", "parent", "source", "target"
  ]);
  const wrapperAttributes = record.wrapper === record.cell
    ? attributeSignature(record.wrapper, standardCellAttributes)
    : attributeSignature(record.wrapper, new Set(["id", "label", "value"]));
  const wrapperChildren = record.wrapper === record.cell
    ? []
    : elementChildren(record.wrapper).filter((child) => child !== record.cell).map(elementSignature);
  const cellChildren = elementChildren(record.cell)
    .filter((child) => child !== record.geometry)
    .map(elementSignature);
  const geometryUnknown = record.geometry ? {
    attributes: attributeSignature(record.geometry, new Set(["x", "y", "width", "height", "relative"])),
    children: elementChildren(record.geometry)
      .filter((child) => !(child.nodeName === "Array" && child.getAttribute("as") === "points"))
      .map(elementSignature)
  } : null;
  return JSON.stringify({ wrapperAttributes, wrapperChildren, cellChildren, geometryUnknown });
}

function scriptChangesAreDeclared(
  before: ModelRecords[],
  after: ModelRecords[],
  conditions: NativeScriptPostcondition[],
  pageId?: string | null
): boolean {
  const pageModel = (models: ModelRecords[]) =>
    models.find((model) => model.pageId === pageId) ??
    (models.length === 1 && models[0]?.pageId === null ? models[0] : undefined);
  const beforeModel = pageModel(before);
  const afterModel = pageModel(after);
  if (!beforeModel || !afterModel) return false;
  const beforeById = new Map(beforeModel.cells.map((record) => [record.id, record]));
  const afterById = new Map(afterModel.cells.map((record) => [record.id, record]));
  const conditionById = new Map(conditions.map((condition) => [condition.cellId, condition]));
  const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
  let changedCount = 0;

  for (const id of ids) {
    const oldRecord = beforeById.get(id);
    const nextRecord = afterById.get(id);
    if (JSON.stringify(oldRecord ? elementSignature(oldRecord.wrapper) : null) ===
        JSON.stringify(nextRecord ? elementSignature(nextRecord.wrapper) : null)) continue;
    changedCount += 1;
    if (id === "0" || id === "1") return false;
    const condition = conditionById.get(id);
    if (!condition ||
        scriptPostconditionMatches(before, condition, pageId) ||
        !scriptPostconditionMatches(after, condition, pageId)) return false;
    if (!oldRecord || !nextRecord) continue;

    if (scriptCellKind(oldRecord) !== scriptCellKind(nextRecord) &&
        condition.kind !== scriptCellKind(nextRecord)) return false;
    if (scriptCellLabel(oldRecord) !== scriptCellLabel(nextRecord) &&
        (condition.label === undefined || !labelMatches(nextRecord, condition.label))) return false;
    for (const key of ["parent", "source", "target"] as const) {
      const beforeValue = oldRecord.cell.getAttribute(key) || "";
      const afterValue = nextRecord.cell.getAttribute(key) || "";
      const conditionKey = key === "parent" ? "parentId" : key === "source" ? "sourceId" : "targetId";
      if (beforeValue !== afterValue && condition[conditionKey] !== afterValue) return false;
    }

    const oldStyle = scriptStyleMap(oldRecord.cell.getAttribute("style") || "");
    const nextStyle = scriptStyleMap(nextRecord.cell.getAttribute("style") || "");
    const allStyleKeys = new Set([...Object.keys(oldStyle), ...Object.keys(nextStyle)]);
    for (const key of allStyleKeys) {
      if (oldStyle[key] === nextStyle[key] &&
          Object.prototype.hasOwnProperty.call(oldStyle, key) === Object.prototype.hasOwnProperty.call(nextStyle, key)) continue;
      const expected = condition.style?.[key];
      const asserted = condition.style !== undefined && Object.prototype.hasOwnProperty.call(condition.style, key);
      if (!asserted || (expected === "" ? Object.prototype.hasOwnProperty.call(nextStyle, key) : nextStyle[key] !== expected)) return false;
    }

    const oldGeometry = scriptGeometryState(oldRecord);
    const nextGeometry = scriptGeometryState(nextRecord);
    if (Boolean(oldGeometry) !== Boolean(nextGeometry) && !condition.geometry) return false;
    if (oldGeometry && nextGeometry) {
      for (const key of ["x", "y", "width", "height"] as const) {
        const oldValue = oldGeometry[key];
        const nextValue = nextGeometry[key];
        if (oldValue === nextValue) continue;
        const expected = condition.geometry?.[key];
        if (expected === undefined || nextValue === null || Math.abs(expected - nextValue) > 0.02) return false;
      }
      if (oldGeometry.relative !== nextGeometry.relative &&
          condition.geometry?.relative !== nextGeometry.relative) return false;
      const samePoints = JSON.stringify(oldGeometry.points) === JSON.stringify(nextGeometry.points);
      if (!samePoints) {
        const expectedPoints = condition.geometry?.points;
        if (!expectedPoints || expectedPoints.length !== nextGeometry.points.length ||
            expectedPoints.some((point, index) => {
              const actual = nextGeometry.points[index];
              return !actual || actual.x === null || actual.y === null ||
                Math.abs(point.x - actual.x) > 0.02 || Math.abs(point.y - actual.y) > 0.02;
            })) return false;
      }
    }
    if (unmodeledCellSignature(oldRecord) !== unmodeledCellSignature(nextRecord)) return false;
  }
  return changedCount > 0;
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
 * An XML snapshot only confirms a native edit when that exact requested outcome is
 * visible in the snapshot. Generic autosaves and unrelated edits are not sufficient.
 * Unknown operations fail closed so callers can report a timeout instead of false success.
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
      let payload: { script?: unknown; postconditions?: unknown };
      try { payload = JSON.parse(scriptOperation.value) as { script?: unknown; postconditions?: unknown }; }
      catch { return false; }
      if (typeof payload.script !== "string" || !payload.script.trim() ||
          !Array.isArray(payload.postconditions) || payload.postconditions.length < 1 ||
          payload.postconditions.length > 100) return false;
      const conditions = payload.postconditions as NativeScriptPostcondition[];
      const seen = new Set<string>();
      if (!conditions.every((condition) => {
        if (!condition || typeof condition.cellId !== "string" || !condition.cellId.trim() ||
            typeof condition.exists !== "boolean" || seen.has(condition.cellId)) return false;
        seen.add(condition.cellId);
        return true;
      })) return false;
      if (!scriptSnapshotHasScopedChange(input.beforeXml, input.xml, input.pageId) ||
          !scriptModelEnvelopeIsUnchanged(input.beforeXml, input.xml, input.pageId)) return false;
      if (!conditions.every((condition) => scriptPostconditionMatches(after, condition, input.pageId))) return false;
      return scriptChangesAreDeclared(before, after, conditions, input.pageId);
    }
    return documentOperations.every((operation) =>
      operationIsReflected(before, after, operation, input.pageId)
    );
  } catch {
    return false;
  }
}
