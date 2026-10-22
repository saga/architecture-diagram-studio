import { DOMParser } from "@xmldom/xmldom";
import { inflateSync, unzlibSync } from "fflate";
import { z } from "zod";

/**
 * Lossless-enough validation view of XML. It is never serialized back over the user's
 * source: unknown element names, attributes and children deliberately remain representable.
 * The exact original XML string remains the source of truth.
 */
export interface DrawioXmlElement {
  name: string;
  attributes: Record<string, string>;
  children: DrawioXmlElement[];
  text: string;
}

const XmlAttributesSchema = z.record(z.string(), z.string());
const NumericXmlStringSchema = z.string().refine((value) => value.trim() !== "" && Number.isFinite(Number(value)), "Expected a finite numeric XML attribute");

function openAttributes<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).passthrough();
}

/** Known fields are typed; passthrough keeps version-specific Draw.io metadata. */
export const MxfileAttributesSchema = openAttributes({
  host: z.string().optional(), modified: z.string().optional(), agent: z.string().optional(),
  version: z.string().optional(), etag: z.string().optional(), type: z.string().optional(),
  userAgent: z.string().optional(), editor: z.string().optional(), compressed: z.string().optional(),
  pages: NumericXmlStringSchema.optional(), vars: z.string().optional()
});
export const DiagramPageAttributesSchema = openAttributes({
  id: z.string().optional(), name: z.string().optional(), viewBox: z.string().optional()
});
export const MxGraphModelAttributesSchema = openAttributes({
  dx: NumericXmlStringSchema.optional(), dy: NumericXmlStringSchema.optional(),
  grid: z.string().optional(), gridSize: NumericXmlStringSchema.optional(),
  guides: z.string().optional(), tooltips: z.string().optional(), connect: z.string().optional(),
  arrows: z.string().optional(), fold: z.string().optional(), page: z.string().optional(),
  pageScale: NumericXmlStringSchema.optional(), pageWidth: NumericXmlStringSchema.optional(),
  pageHeight: NumericXmlStringSchema.optional(), background: z.string().optional(),
  backgroundImage: z.string().optional(), math: z.string().optional(), shadow: z.string().optional(),
  adaptiveColors: z.string().optional(), extFonts: z.string().optional(), style: z.string().optional()
});
export const MxCellAttributesSchema = openAttributes({
  id: z.string().optional(), value: z.string().optional(), style: z.string().optional(),
  vertex: z.string().optional(), edge: z.string().optional(), parent: z.string().optional(),
  source: z.string().optional(), target: z.string().optional(), connectable: z.string().optional(),
  visible: z.string().optional(), collapsed: z.string().optional()
});
export const MxGeometryAttributesSchema = openAttributes({
  x: NumericXmlStringSchema.optional(), y: NumericXmlStringSchema.optional(),
  width: NumericXmlStringSchema.optional(), height: NumericXmlStringSchema.optional(),
  relative: z.string().optional(), as: z.string().optional()
});
export const MxPointAttributesSchema = openAttributes({
  x: NumericXmlStringSchema.optional(), y: NumericXmlStringSchema.optional(), as: z.string().optional()
});
export const MxRectangleAttributesSchema = openAttributes({
  x: NumericXmlStringSchema.optional(), y: NumericXmlStringSchema.optional(),
  width: NumericXmlStringSchema.optional(), height: NumericXmlStringSchema.optional(),
  as: z.string().optional()
});
export const MxArrayAttributesSchema = openAttributes({ as: z.string().optional() });
export const MxDefAttributesSchema = openAttributes({ data: z.string().optional() });
export const MxLibraryAttributesSchema = openAttributes({ title: z.string().optional(), tags: z.string().optional() });

function appendIssues(ctx: z.RefinementCtx, issues: z.ZodIssue[], path: PropertyKey[] = []): void {
  for (const item of issues) ctx.addIssue({ ...item, path: path.concat(item.path) });
}
function validateAttributes<T>(schema: z.ZodType<T>, element: DrawioXmlElement, ctx: z.RefinementCtx, path: PropertyKey[] = []): void {
  const result = schema.safeParse(element.attributes);
  if (!result.success) appendIssues(ctx, result.error.issues, path.concat("attributes"));
}

export const DrawioXmlElementSchema: z.ZodType<DrawioXmlElement> = z.lazy(() =>
  z.object({
    name: z.string().min(1),
    attributes: XmlAttributesSchema,
    children: z.array(DrawioXmlElementSchema),
    text: z.string()
  }).strict()
);

function issue(ctx: z.RefinementCtx, message: string, path: PropertyKey[] = []): void {
  ctx.addIssue({ code: "custom", message, path });
}

function childNodesNamed(element: DrawioXmlElement, name: string): DrawioXmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function effectiveCellId(wrapper: DrawioXmlElement): string | undefined {
  const innerCell = wrapper.name === "mxCell"
    ? wrapper
    : wrapper.children.find((child) => child.name === "mxCell");
  return wrapper.attributes.id || innerCell?.attributes.id || undefined;
}

function cellsFromRoot(root: DrawioXmlElement): Array<{ wrapper: DrawioXmlElement; cell: DrawioXmlElement; index: number }> {
  const result: Array<{ wrapper: DrawioXmlElement; cell: DrawioXmlElement; index: number }> = [];
  root.children.forEach((wrapper, index) => {
    const cell = wrapper.name === "mxCell"
      ? wrapper
      : wrapper.children.find((child) => child.name === "mxCell");
    if (cell) result.push({ wrapper, cell, index });
  });
  return result;
}

function validateCell(element: DrawioXmlElement, ctx: z.RefinementCtx, path: PropertyKey[] = []): void {
  if (element.name !== "mxCell") {
    issue(ctx, "Expected an mxCell element", path);
    return;
  }
  validateAttributes(MxCellAttributesSchema, element, ctx, path);
  if (element.attributes.vertex === "1" && element.attributes.edge === "1") {
    issue(ctx, "An mxCell cannot be both a vertex and an edge", path.concat("attributes"));
  }
  const geometries = childNodesNamed(element, "mxGeometry");
  if (geometries.length > 1) issue(ctx, "An mxCell can have at most one direct mxGeometry child", path.concat("children"));
  for (const [index, geometry] of geometries.entries()) {
    if (geometry.attributes.as !== undefined && geometry.attributes.as !== "geometry") {
      issue(ctx, "A cell's geometry must use as=\"geometry\"", path.concat("children", index, "attributes", "as"));
    }
    validateGeometry(geometry, ctx, path.concat("children", index));
  }
}

/** Standard geometry children. Their attribute maps stay open to forward-compatible extensions. */
export const MxPointSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "mxPoint") issue(ctx, "Expected mxPoint");
  validateAttributes(MxPointAttributesSchema, element, ctx);
});
export const MxRectangleSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "mxRectangle") issue(ctx, "Expected mxRectangle");
  validateAttributes(MxRectangleAttributesSchema, element, ctx);
});
export const MxArraySchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "Array") issue(ctx, "Expected Array");
  validateAttributes(MxArrayAttributesSchema, element, ctx);
  element.children.forEach((child, index) => {
    if (child.name === "mxPoint") {
      const result = MxPointSchema.safeParse(child);
      if (!result.success) appendIssues(ctx, result.error.issues, ["children", index]);
    }
  });
});
export const MxDefSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "def") issue(ctx, "Expected def");
  validateAttributes(MxDefAttributesSchema, element, ctx);
});
export const MxDefsSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "defs") issue(ctx, "Expected defs");
  element.children.forEach((child, index) => {
    if (child.name === "def") {
      const result = MxDefSchema.safeParse(child);
      if (!result.success) appendIssues(ctx, result.error.issues, ["children", index]);
    }
  });
});

/** Extensible geometry schema: known mxPoint/Array/alternateBounds nodes are checked, unknown extensions are retained. */
export const MxGeometrySchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "mxGeometry") issue(ctx, "Expected mxGeometry");
  validateAttributes(MxGeometryAttributesSchema, element, ctx);
  element.children.forEach((child, index) => {
    const childSchema = child.name === "mxPoint" ? MxPointSchema
      : child.name === "mxRectangle" ? MxRectangleSchema
      : child.name === "Array" ? MxArraySchema : null;
    if (childSchema) {
      const result = childSchema.safeParse(child);
      if (!result.success) appendIssues(ctx, result.error.issues, ["children", index]);
    }
  });
});

function validateGeometry(element: DrawioXmlElement, ctx: z.RefinementCtx, path: PropertyKey[] = []): void {
  const checked = MxGeometrySchema.safeParse(element);
  if (!checked.success) {
    for (const item of checked.error.issues) ctx.addIssue({ ...item, path: path.concat(item.path) });
  }
}

/** Core cell schema; arbitrary attributes/style keys and wrapper metadata are intentionally open. */
export const MxCellSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  validateCell(element, ctx);
});

/** mxGraph root is a flat cell list; custom object names may wrap a single mxCell. */
export const MxRootSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "root") issue(ctx, "Expected root under mxGraphModel");
  const inventory = cellsFromRoot(element);
  const seenIds = new Map<string, number>();
  const rootlessCells = inventory.filter((entry) => entry.cell.attributes.parent === undefined);
  if (rootlessCells.length !== 1) issue(ctx, "A well-formed Draw.io page has exactly one cell without a parent", ["children"]);
  for (const entry of inventory) {
    if (entry.wrapper.name !== "mxCell" && childNodesNamed(entry.wrapper, "mxCell").length !== 1) {
      issue(ctx, "A cell wrapper must contain exactly one direct mxCell", ["children", entry.index]);
    }
    const wrapperId = entry.wrapper === entry.cell ? undefined : entry.wrapper.attributes.id;
    const innerId = entry.cell.attributes.id;
    if (wrapperId && innerId && wrapperId !== innerId) {
      issue(ctx, "A user-object wrapper ID and its inner mxCell ID must match when both are present", ["children", entry.index]);
    }
    const id = effectiveCellId(entry.wrapper);
    if (id) {
      const previous = seenIds.get(id);
      if (previous !== undefined) issue(ctx, "Duplicate cell id \"" + id + "\" within this page", ["children", entry.index]);
      else seenIds.set(id, entry.index);
    }
    validateCell(entry.cell, ctx, ["children", entry.index, ...(entry.wrapper === entry.cell ? [] : ["children", entry.wrapper.children.indexOf(entry.cell)])]);
  }
  // No fixed whitelist for root children: UserObject, object, vendor wrappers and future
  // mxCodec elements are valid so long as an actual mxCell inside them can be preserved.
});

/** Every mxGraphModel attribute is optional in Draw.io; defs is valid before root when styles are compressed. */
export const MxGraphModelSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((element, ctx) => {
  if (element.name !== "mxGraphModel") issue(ctx, "Expected mxGraphModel");
  validateAttributes(MxGraphModelAttributesSchema, element, ctx);
  const roots = childNodesNamed(element, "root");
  if (roots.length !== 1) {
    issue(ctx, "mxGraphModel must contain exactly one direct root element", ["children"]);
  } else {
    const result = MxRootSchema.safeParse(roots[0]);
    if (!result.success) for (const item of result.error.issues) {
      ctx.addIssue({ ...item, path: ["children", element.children.indexOf(roots[0]), ...item.path] });
    }
  }
  if (childNodesNamed(element, "defs").length > 1) issue(ctx, "mxGraphModel may contain at most one defs element", ["children"]);
  element.children.forEach((child, index) => {
    if (child.name === "defs") {
      const result = MxDefsSchema.safeParse(child);
      if (!result.success) appendIssues(ctx, result.error.issues, ["children", index]);
    }
  });
  // All unknown model-level extension elements and attributes remain legal and opaque.
});

/** A page can be represented by an inline model or by a compressed raw-DEFLATE/Base64 payload. */
export const DrawioDiagramPageSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((page, ctx) => {
  if (page.name !== "diagram") issue(ctx, "Expected diagram page");
  validateAttributes(DiagramPageAttributesSchema, page, ctx);
  const models = childNodesNamed(page, "mxGraphModel");
  const payload = page.text.trim();
  if (models.length > 1) issue(ctx, "A diagram page may contain at most one inline mxGraphModel", ["children"]);
  if (models.length === 0 && !payload) issue(ctx, "A diagram page must contain an mxGraphModel or a non-empty compressed payload", ["text"]);
  if (models.length > 0 && payload) issue(ctx, "A diagram page cannot mix an inline mxGraphModel with a compressed payload", ["text"]);
  for (const [index, model] of models.entries()) {
    const result = MxGraphModelSchema.safeParse(model);
    if (!result.success) for (const item of result.error.issues) {
      ctx.addIssue({ ...item, path: ["children", page.children.indexOf(model), ...item.path] });
    }
    void index;
  }
});

/** The outer mxfile contains metadata and one or more named pages; its attributes are open-ended. */
export const MxfileSchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((file, ctx) => {
  if (file.name !== "mxfile") issue(ctx, "Expected mxfile root");
  validateAttributes(MxfileAttributesSchema, file, ctx);
  const pages = childNodesNamed(file, "diagram");
  if (pages.length === 0) issue(ctx, "mxfile must contain at least one diagram page", ["children"]);
  const pageIds = new Map<string, number>();
  for (const [index, page] of pages.entries()) {
    const pageId = page.attributes.id;
    if (pageId) {
      const previous = pageIds.get(pageId);
      if (previous !== undefined) issue(ctx, "Duplicate diagram page id \"" + pageId + "\"", ["children", index, "attributes", "id"]);
      else pageIds.set(pageId, index);
    }
    const result = DrawioDiagramPageSchema.safeParse(page);
    if (!result.success) for (const item of result.error.issues) {
      ctx.addIssue({ ...item, path: ["children", file.children.indexOf(page), ...item.path] });
    }
  }
});

/** Draw.io also uses the distinct <mxlibrary> format for custom shape libraries; it is not an editable diagram file. */
export const MxLibraryEntrySchema = z.object({
  xml: z.string().min(1).optional(),
  data: z.string().min(1).optional(),
  w: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]),
  h: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]),
  title: z.string().optional(),
  aspect: z.string().optional(),
  style: z.string().optional()
}).passthrough().refine((entry) => Boolean(entry.xml || entry.data), {
  message: "Each mxlibrary item must contain either xml or data"
});

export const MxLibrarySchema: z.ZodType<DrawioXmlElement> = DrawioXmlElementSchema.superRefine((library, ctx) => {
  if (library.name !== "mxlibrary") issue(ctx, "Expected mxlibrary root");
  validateAttributes(MxLibraryAttributesSchema, library, ctx);
  let items: unknown;
  try { items = JSON.parse(library.text); }
  catch { issue(ctx, "mxlibrary text must be a JSON array"); return; }
  const result = z.array(MxLibraryEntrySchema).safeParse(items);
  if (!result.success) {
    for (const item of result.error.issues) ctx.addIssue({ ...item, path: ["text", ...item.path] });
    return;
  }
  result.data.forEach((entry, index) => {
    if (!entry.xml) return;
    try {
      // Library XML entries are an mxGraphModel, either plain XML or encoded/compressed
      // in the same way as a page payload. Keep each stencil's internal cells opaque.
      const decoded = decodeCompressedPage(entry.xml);
      const model = parseXmlTree(decoded);
      const modelResult = MxGraphModelSchema.safeParse(model);
      if (!modelResult.success) {
        for (const item of modelResult.error.issues) {
          ctx.addIssue({ ...item, path: ["text", index, "xml", ...item.path] });
        }
      }
    } catch (error) {
      issue(ctx, "Invalid mxlibrary embedded mxGraphModel: " + (error instanceof Error ? error.message : String(error)), ["text", index, "xml"]);
    }
  });
});

/** Covers the documented Draw.io XML root formats while keeping library files distinct from editable diagrams. */
export const DrawioXmlRootSchema = z.union([MxfileSchema, MxGraphModelSchema, MxLibrarySchema]);
export const DrawioDiagramXmlSchema = z.union([MxfileSchema, MxGraphModelSchema]);

export interface DrawioXmlValidationSuccess {
  success: true;
  format: "mxfile" | "mxGraphModel" | "mxlibrary";
  root: DrawioXmlElement;
  warnings: string[];
}
export interface DrawioXmlValidationFailure {
  success: false;
  issues: string[];
}
export type DrawioXmlValidationResult = DrawioXmlValidationSuccess | DrawioXmlValidationFailure;

function toXmlElement(element: Element): DrawioXmlElement {
  const attributes: Record<string, string> = {};
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attr = element.attributes.item(index);
    if (attr) attributes[attr.name] = attr.value;
  }
  const children: DrawioXmlElement[] = [];
  let text = "";
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (!child) continue;
    if (child.nodeType === 1) children.push(toXmlElement(child as Element));
    else if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue || "";
  }
  return { name: element.nodeName, attributes, children, text };
}

function issuesAsStrings(issues: z.ZodIssue[]): string[] {
  return issues.map((item) => {
    const path = item.path.map((part) => String(part)).join(".");
    return (path ? path + ": " : "") + item.message;
  });
}

function parseXmlTree(xml: string): DrawioXmlElement {
  // DTD/entity declarations are unnecessary for Draw.io files and create avoidable parser risk.
  // Ignore comments, CDATA and processing instructions when detecting declarations.
  const withoutSafeRegions = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(withoutSafeRegions)) throw new Error("DTD and custom entity declarations are not supported.");
  const errors: string[] = [];
  const parser = new DOMParser({
    locator: false,
    onError: (level, message) => {
      if (level !== "warning") errors.push(message);
    }
  });
  const document = parser.parseFromString(xml, "application/xml");
  if (errors.length) throw new Error(errors.slice(0, 5).join("; "));
  if (!document.documentElement) throw new Error("The XML document has no root element.");
  // xmldom implements the DOM, but its types are module-local rather than the lib.dom ones this
  // walker reads, so the parsed root needs an explicit cast at the boundary.
  return toXmlElement(document.documentElement as unknown as Element);
}

const MAX_INFLATED_PAGE_BYTES = 20_000_000;

/**
 * Draw.io compressed pages are raw-DEFLATE + Base64. A fixed output buffer caps
 * decompression at the same byte limit as the submitted XML and prevents a small
 * compressed payload from expanding without bound in browser or server memory.
 */
function inflatePageBytes(bytes: Uint8Array): Uint8Array {
  const outputSize = MAX_INFLATED_PAGE_BYTES + 1;
  let inflated: Uint8Array | null = null;
  try { inflated = inflateSync(bytes, { out: new Uint8Array(outputSize) }); } catch { /* Try a legacy zlib-wrapped payload. */ }
  if (!inflated) {
    try { inflated = unzlibSync(bytes, { out: new Uint8Array(outputSize) }); } catch { /* Invalid or unsupported compressed payload. */ }
  }
  if (!inflated) throw new Error("The compressed diagram page could not be inflated.");
  if (inflated.length > MAX_INFLATED_PAGE_BYTES) {
    throw new Error("The decompressed diagram page exceeds the 20 MB application limit.");
  }
  return inflated;
}

function decodeCompressedPage(payload: string): string {
  const trimmed = payload.trim();
  if (trimmed.startsWith("<")) {
    const root = parseXmlTree(trimmed);
    if (root.name !== "mxGraphModel") throw new Error("The plaintext diagram page must contain mxGraphModel.");
    const validated = MxGraphModelSchema.safeParse(root);
    if (!validated.success) throw new Error(issuesAsStrings(validated.error.issues).slice(0, 5).join("; "));
    return trimmed;
  }
  const compact = payload.replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    const binary = atob(compact);
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("The compressed diagram page is not valid Base64.");
  }
  const inflated = inflatePageBytes(bytes);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
  const candidates = [decoded];
  try {
    const uriDecoded = decodeURIComponent(decoded);
    if (uriDecoded !== decoded) candidates.push(uriDecoded);
  } catch { /* Some older files contain direct XML text. */ }
  const nestedErrors: string[] = [];
  for (const candidate of candidates) {
    try {
      const root = parseXmlTree(candidate);
      if (root.name !== "mxGraphModel") {
        nestedErrors.push("The compressed page did not decode to mxGraphModel.");
        continue;
      }
      const result = MxGraphModelSchema.safeParse(root);
      if (result.success) return candidate;
      nestedErrors.push(...issuesAsStrings(result.error.issues));
    } catch (error) {
      nestedErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(nestedErrors.slice(0, 5).join("; ") || "Invalid compressed Draw.io page.");
}

function addCellInventoryWarnings(root: DrawioXmlElement, warnings: string[], pageLabel: string): void {
  const graphModel = root.name === "mxGraphModel"
    ? root
    : root.children.find((page) => page.name === "diagram")?.children.find((child) => child.name === "mxGraphModel");
  if (!graphModel) return;
  const graphRoot = graphModel.children.find((child) => child.name === "root");
  if (!graphRoot) return;
  const inventory = cellsFromRoot(graphRoot);
  const ids = new Set(inventory.map((entry) => effectiveCellId(entry.wrapper)).filter((id): id is string => Boolean(id)));
  if (!ids.has("0")) warnings.push(pageLabel + ": missing conventional root cell id 0.");
  if (!ids.has("1")) warnings.push(pageLabel + ": missing conventional default-layer cell id 1.");
  for (const [index, entry] of inventory.entries()) {
    const id = effectiveCellId(entry.wrapper);
    if (!id) warnings.push(pageLabel + ": cell " + index + " has no id; Draw.io may assign one on open.");
    if ((entry.cell.attributes.vertex === "1" || entry.cell.attributes.edge === "1") &&
        !entry.cell.children.some((child) => child.name === "mxGeometry")) {
      warnings.push(pageLabel + ": cell " + (id || index) + " has no geometry; source XML is preserved, but Draw.io may not render it as expected.");
    }
    const parent = entry.cell.attributes.parent;
    if (parent && !ids.has(parent)) warnings.push(pageLabel + ": cell " + (id || index) + " references missing parent " + parent + ".");
    if (entry.cell.attributes.edge === "1") {
      const source = entry.cell.attributes.source;
      const target = entry.cell.attributes.target;
      const geometry = entry.cell.children.find((child) => child.name === "mxGeometry");
      const hasPoint = (name: string) => Boolean(geometry?.children.some((child) =>
        child.name === "mxPoint" && child.attributes.as === name
      ));
      if (source && !ids.has(source) && !hasPoint("sourcePoint")) warnings.push(pageLabel + ": edge " + (id || index) + " references missing source " + source + ".");
      if (target && !ids.has(target) && !hasPoint("targetPoint")) warnings.push(pageLabel + ": edge " + (id || index) + " references missing target " + target + ".");
      if (!source && !hasPoint("sourcePoint")) warnings.push(pageLabel + ": edge " + (id || index) + " has neither a source nor a sourcePoint.");
      if (!target && !hasPoint("targetPoint")) warnings.push(pageLabel + ": edge " + (id || index) + " has neither a target nor a targetPoint.");
      if (geometry?.attributes.relative !== "1") warnings.push(pageLabel + ": edge " + (id || index) + " geometry is not marked relative=1.");
    }
  }
}

function parseValidated(xml: string, allowLibrary: boolean): DrawioXmlValidationResult {
  if (!xml.trim()) return { success: false, issues: ["The XML document is empty."] };
  if (xml.length > 20_000_000) return { success: false, issues: ["The Draw.io XML exceeds the 20 MB application limit."] };
  let root: DrawioXmlElement;
  try { root = parseXmlTree(xml); }
  catch (error) {
    return { success: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
  const schema = allowLibrary ? DrawioXmlRootSchema : DrawioDiagramXmlSchema;
  const parsed = schema.safeParse(root);
  if (!parsed.success) return { success: false, issues: issuesAsStrings(parsed.error.issues) };

  if (root.name === "mxfile") {
    const pages = root.children.filter((child) => child.name === "diagram");
    for (const [index, page] of pages.entries()) {
      const inlineModel = page.children.find((child) => child.name === "mxGraphModel");
      if (inlineModel) continue;
      try {
        decodeCompressedPage(page.text);
      } catch (error) {
        return { success: false, issues: ["diagram[" + index + "]: " + (error instanceof Error ? error.message : String(error))] };
      }
    }
  }
  const warnings: string[] = [];
  if (root.name === "mxfile") {
    root.children.filter((child) => child.name === "diagram").forEach((page, index) => {
      const model = page.children.find((child) => child.name === "mxGraphModel");
      if (model) addCellInventoryWarnings(model, warnings, "diagram[" + index + "]");
      else {
        try { addCellInventoryWarnings(parseXmlTree(decodeCompressedPage(page.text)), warnings, "diagram[" + index + "]"); }
        catch { /* Compressed payload errors already return above. */ }
      }
    });
  } else if (root.name === "mxGraphModel") addCellInventoryWarnings(root, warnings, "mxGraphModel");

  return { success: true, format: root.name as DrawioXmlValidationSuccess["format"], root, warnings };
}

/** Decode a Draw.io page payload to its validated mxGraphModel XML for read-only inspection. */
export function decodeDrawioPageXml(payload: string): string {
  return decodeCompressedPage(payload);
}

/** Validate a .drawio/.xml diagram or bare mxGraphModel, including compressed pages. */
export function validateDrawioXmlDocument(xml: string): DrawioXmlValidationResult {
  return parseValidated(xml, false);
}

/** Validate any documented Draw.io XML root, including the separate custom-shape-library format. */
export function validateDrawioXmlFile(xml: string): DrawioXmlValidationResult {
  return parseValidated(xml, true);
}

export function isDrawioXmlDocument(xml: string): boolean {
  return validateDrawioXmlDocument(xml).success;
}
