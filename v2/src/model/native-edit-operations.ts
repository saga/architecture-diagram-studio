import { findDrawioElements, parseDrawioXml, type DrawioDomDocument } from "./drawio-xml-dom";
import { decodeDrawioPageXml } from "./drawio-xml-schema";

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

/**
 * Page identity of the document a caller is addressing.
 *
 * Studio and Draw.io disagree about bare `<mxGraphModel>` documents: the XML holds exactly one
 * page and declares no page ID, while the live editor reports a UUID it generated. Comparing one
 * layer's ID against the other rejects valid work, so callers read the identity for their own
 * layer instead of re-deriving the bare-model exception at each comparison:
 *
 * - `documentPageId` — what the XML declares. Use it for revision-bound XML patches and any
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

function readPageInfo(parsed: DrawioDomDocument, pageId: string | null): { id: string | null; title: string | null } {
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
