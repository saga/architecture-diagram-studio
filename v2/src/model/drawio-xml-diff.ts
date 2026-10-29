import { parseDrawioXml, serializeDrawioXml } from "./drawio-xml-dom";
import { decodeDrawioPageXml } from "./drawio-xml-schema";

export interface NativeXmlCellSnapshot {
  id: string;
  pageId: string;
  label: string;
  parentId: string | null;
  cellType: "vertex" | "edge" | "other";
  attributes: Record<string, string>;
  style: Record<string, string>;
  geometry: Record<string, string>;
  sourceId: string | null;
  targetId: string | null;
  wrapperAttributes: Record<string, string>;
}

export interface NativeXmlChange {
  pageId: string;
  cellId: string;
  label: string;
  kind: "added" | "removed" | "changed";
  fields: string[];
  before?: NativeXmlCellSnapshot;
  after?: NativeXmlCellSnapshot;
}

export interface NativeXmlImpactReport {
  schemaVersion: 1;
  beforeHash: string;
  afterHash: string;
  changed: boolean;
  pageIdsBefore: string[];
  pageIdsAfter: string[];
  changes: NativeXmlChange[];
  summary: { added: number; removed: number; changed: number; changedFields: number };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function attributesOf(element: Element | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!element?.attributes) return result;
  for (let i = 0; i < element.attributes.length; i++) {
    const attr = element.attributes.item(i);
    if (attr) result[attr.name] = attr.value;
  }
  return result;
}

function parseStyle(style: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of style.split(";")) {
    if (!item) continue;
    const separator = item.indexOf("=");
    if (separator < 0) result[item] = "";
    else result[item.slice(0, separator)] = item.slice(separator + 1);
  }
  return result;
}

function pageModels(xml: string): Array<{ id: string; document: Document }> {
  const root = parseDrawioXml(xml).documentElement;
  if (root.tagName === "mxGraphModel") return [{ id: "0", document: parseDrawioXml(xml) }];
  if (root.tagName !== "mxfile") throw new Error("Expected an mxfile or mxGraphModel root for XML impact analysis.");
  const pages = Array.from(root.getElementsByTagName("diagram"));
  return pages.map((page, index) => {
    const id = page.getAttribute("id") || String(index);
    const payload = Array.from(page.childNodes).find((node) => node.nodeType === 1);
    let modelDocument: Document;
    if (payload && (payload as Element).tagName === "mxGraphModel") {
      modelDocument = parseDrawioXml(serializeDrawioXml(payload));
    } else {
      const text = page.textContent || "";
      modelDocument = parseDrawioXml(decodeDrawioPageXml(text));
    }
    return { id, document: modelDocument };
  });
}

function snapshotPage(pageId: string, document: Document): Map<string, NativeXmlCellSnapshot> {
  const result = new Map<string, NativeXmlCellSnapshot>();
  const cells = Array.from(document.getElementsByTagName("mxCell"));
  for (const cell of cells) {
    const id = cell.getAttribute("id");
    if (!id) continue;
    const parent = cell.parentElement;
    const wrapper = parent && parent.tagName !== "root" ? parent : null;
    const geometryElement = Array.from(cell.childNodes).find((node) =>
      node.nodeType === 1 && (node as Element).tagName === "mxGeometry"
    ) as Element | undefined;
    const attributes = attributesOf(cell);
    const wrapperAttributes = attributesOf(wrapper);
    const label = attributes.value || wrapperAttributes.label || wrapperAttributes.value || "";
    const cellType = attributes.edge === "1" ? "edge" : attributes.vertex === "1" ? "vertex" : "other";
    result.set(id, {
      id,
      pageId,
      label,
      parentId: attributes.parent || null,
      cellType,
      attributes,
      style: parseStyle(attributes.style || ""),
      geometry: attributesOf(geometryElement ?? null),
      sourceId: attributes.source || null,
      targetId: attributes.target || null,
      wrapperAttributes
    });
  }
  return result;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ":" + stable(item)).join(",") + "}";
  }
  return JSON.stringify(value) ?? String(value);
}

function changedFields(before: NativeXmlCellSnapshot, after: NativeXmlCellSnapshot): string[] {
  const fields: string[] = [];
  for (const field of ["label", "parentId", "cellType", "attributes", "style", "geometry", "sourceId", "targetId", "wrapperAttributes"] as const) {
    if (stable(before[field]) !== stable(after[field])) fields.push(field);
  }
  return fields;
}

/**
 * Compare native XML directly. This is a diagnostic projection only: it never serializes
 * back into the user's document and deliberately leaves unknown XML as the authoritative source.
 */
export async function interpretNativeXmlChange(beforeXml: string, afterXml: string): Promise<NativeXmlImpactReport> {
  const beforePages = pageModels(beforeXml);
  const afterPages = pageModels(afterXml);
  const before = new Map<string, NativeXmlCellSnapshot>();
  const after = new Map<string, NativeXmlCellSnapshot>();
  for (const page of beforePages) for (const [id, cell] of snapshotPage(page.id, page.document)) before.set(page.id + "\0" + id, cell);
  for (const page of afterPages) for (const [id, cell] of snapshotPage(page.id, page.document)) after.set(page.id + "\0" + id, cell);
  const changes: NativeXmlChange[] = [];
  for (const [key, current] of after) {
    const previous = before.get(key);
    if (!previous) changes.push({ pageId: current.pageId, cellId: current.id, label: current.label, kind: "added", fields: ["cell"], after: current });
    else {
      const fields = changedFields(previous, current);
      if (fields.length) changes.push({ pageId: current.pageId, cellId: current.id, label: current.label || previous.label, kind: "changed", fields, before: previous, after: current });
    }
  }
  for (const [key, previous] of before) {
    if (!after.has(key)) changes.push({ pageId: previous.pageId, cellId: previous.id, label: previous.label, kind: "removed", fields: ["cell"], before: previous });
  }
  changes.sort((a, b) => a.pageId.localeCompare(b.pageId) || a.cellId.localeCompare(b.cellId));
  const added = changes.filter((item) => item.kind === "added").length;
  const removed = changes.filter((item) => item.kind === "removed").length;
  const changed = changes.filter((item) => item.kind === "changed").length;
  return {
    schemaVersion: 1,
    beforeHash: await sha256(beforeXml),
    afterHash: await sha256(afterXml),
    changed: beforeXml !== afterXml,
    pageIdsBefore: beforePages.map((page) => page.id),
    pageIdsAfter: afterPages.map((page) => page.id),
    changes,
    summary: { added, removed, changed, changedFields: changes.reduce((count, item) => count + item.fields.length, 0) }
  };
}
