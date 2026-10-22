import { inflateSync, unzlibSync } from "fflate";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { validateDrawioXmlDocument } from "../model/drawio-xml-schema";
import type { DiagramDocument, DiagramNode, DiagramRelation, NodeRole, NodeVisualStyle, RelationVisualStyle, Point, SequenceFragment } from "../model/types";
import { diagramPalette, nodeVisualDefaults, relationVisualDefaults } from "../design/render-spec";

// xmldom ships its own module-local DOM types, which do not unify with lib.dom. This module reads the
// parsed tree as a lib.dom document, so the two crossings below are explicit casts rather than a
// re-typed walker.
type XmldomSerializerNode = Parameters<InstanceType<typeof XMLSerializer>["serializeToString"]>[0];

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key === "amp") return "&";
    if (key === "lt") return "<";
    if (key === "gt") return ">";
    if (key === "quot") return '"';
    if (key === "apos") return "'";
    if (key === "nbsp") return "\u00a0";
    try {
      const codePoint = key.startsWith("#x") ? Number.parseInt(key.slice(2), 16) : Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    } catch { return match; }
  });
}
function plainLabel(value: string): string {
  // Do not depend on document.createElement: the same importer also derives the server's
  // transient semantic view from XML. Draw.io cell values may contain HTML fragments.
  const block = /<div\b[^>]*>\s*<div\b[^>]*>([\s\S]*?)<\/div>/i.exec(value)
    || /<div\b[^>]*>([\s\S]*?)<\/div>/i.exec(value);
  const html = block?.[1] || value;
  return decodeHtmlEntities(html.replace(/<br\s*\/?\s*>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
}
function directChild(element: Element, name: string): Element | null {
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child?.nodeType === 1 && (child as Element).nodeName === name) return child as Element;
  }
  return null;
}
function directChildren(element: Element, name: string): Element[] {
  const values: Element[] = [];
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child = element.childNodes.item(index);
    if (child?.nodeType === 1 && (child as Element).nodeName === name) values.push(child as Element);
  }
  return values;
}
export function roleFromStyle(style: string): NodeRole {
  const explicit = style.match(/(?:^|;)studioRole=([^;]+)/)?.[1];
  const allowed: NodeRole[] = ["actor", "source", "entry", "ui", "domain", "business", "api", "worker", "data", "storage", "external", "vendor", "infra", "decision", "start", "end", "service"];
  if (explicit && allowed.includes(explicit as NodeRole)) return explicit as NodeRole;

  const normalized = style.toLowerCase();
  const shape = style.match(/(?:^|;)shape=([^;]+)/i)?.[1]?.toLowerCase() || "";
  if (shape.includes("lifeline") || shape.includes("actor") || shape === "actor") return "actor";
  if (shape.includes("cloud")) return "external";
  if (shape.includes("swimlane")) return "business";
  if (shape.includes("flowchart.start") || /(?:^|;)shape=start(?:;|$)/i.test(style)) return "start";
  if (shape.includes("flowchart.end") || /(?:^|;)shape=end(?:;|$)/i.test(style)) return "end";
  if (shape.includes("rhombus") || shape.includes("decision") || normalized.includes("rhombus")) return "decision";
  if (shape.includes("database") || shape.includes("cylinder") || shape.includes("datastore") ||
      normalized.includes("database") || normalized.includes("cylinder")) return "storage";
  if (shape === "table" || shape.includes("entityrelation") || shape.includes("umlclass") ||
      shape.includes("document") || shape.includes("parallelogram") || shape.includes("note") || shape.includes("data")) return "data";
  if (shape.includes("process") || shape.includes("hexagon") || normalized.includes("ellipse") || normalized.includes("arcsize=50")) return "service";
  return "domain";
}
function visualRoleFromStyle(style: string): DiagramNode["visualRole"] {
  const explicit = style.match(/(?:^|;)studioVisualRole=([^;]+)/)?.[1];
  const allowed: DiagramNode["visualRole"][] = ["primary", "secondary", "muted", "external", "highlight"];
  return explicit && allowed.includes(explicit as DiagramNode["visualRole"]) ? explicit as DiagramNode["visualRole"] : "secondary";
}
function styleValues(style: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const token of style.split(";")) {
    const equals = token.indexOf("=");
    if (equals <= 0) continue;
    values.set(token.slice(0, equals).trim(), token.slice(equals + 1).trim());
  }
  return values;
}
function colorsEqual(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
/** Retain explicit Draw.io styles, but don't freeze values generated by the active render theme. */
export function nodeVisualStyleFromDrawio(style: string, role: DiagramNode["role"], visualRole: DiagramNode["visualRole"], fallbackTheme: string): NodeVisualStyle | undefined {
  const values = styleValues(style);
  const theme = values.get("studioTheme");
  const palette = diagramPalette(theme || fallbackTheme);
  const defaults = nodeVisualDefaults({ role, visualRole } as DiagramNode, palette);
  const result: NodeVisualStyle = {};
  const setString = (key: string, property: "fillColor" | "strokeColor" | "fontColor" | "fontFamily" | "accentColor", defaultValue: string | undefined) => {
    const value = values.get(key);
    if (value !== undefined && (!theme || defaultValue === undefined || !colorsEqual(value, defaultValue))) result[property] = value;
  };
  const setNumber = (key: string, property: "fontSize" | "fontStyle" | "strokeWidth" | "arcSize", defaultValue: number | undefined) => {
    const raw = values.get(key);
    if (raw === undefined) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    if (!theme || defaultValue === undefined || Math.abs(value - defaultValue) > 0.001) result[property] = value;
  };
  setString("fillColor", "fillColor", defaults.fill);
  setString("strokeColor", "strokeColor", defaults.stroke);
  setString("fontColor", "fontColor", defaults.text);
  setString("fontFamily", "fontFamily", defaults.fontFamily);
  setString("studioAccentColor", "accentColor", defaults.accent);
  setNumber("fontSize", "fontSize", defaults.fontSize);
  setNumber("fontStyle", "fontStyle", defaults.fontWeight >= 600 ? 1 : 0);
  setNumber("strokeWidth", "strokeWidth", defaults.strokeWidth);
  const rounded = values.get("rounded");
  const arcSize = values.get("arcSize");
  let shape: NodeVisualStyle["shape"] | undefined;
  if (style.includes("rhombus")) shape = "diamond";
  else if (rounded === "1" && arcSize !== undefined && Number(arcSize) >= 35) shape = "pill";
  else if (rounded === "0" || values.has("ellipse")) shape = "rect";
  if (shape && (!theme || shape !== defaults.shape)) result.shape = shape;
  if (arcSize !== undefined) setNumber("arcSize", "arcSize", defaults.radius);
  else if (rounded === "0" && (!theme || defaults.radius !== 0)) result.arcSize = 0;
  return Object.keys(result).length ? result : undefined;
}
export function relationVisualStyleFromDrawio(style: string, kind: DiagramRelation["kind"], fallbackTheme: string): RelationVisualStyle | undefined {
  const values = styleValues(style);
  const theme = values.get("studioTheme");
  const palette = diagramPalette(theme || fallbackTheme);
  const dashed = values.get("dashed") === "1" || values.has("dashPattern");
  const defaults = relationVisualDefaults({ kind, dashed } as DiagramRelation, palette);
  const result: RelationVisualStyle = {};
  const setString = (key: string, property: keyof RelationVisualStyle, defaultValue: string | undefined) => {
    const value = values.get(key);
    if (value !== undefined && (!theme || defaultValue === undefined || !colorsEqual(value, defaultValue))) (result as unknown as Record<string, unknown>)[property] = value;
  };
  const setNumber = (key: string, property: keyof RelationVisualStyle, defaultValue: number | undefined) => {
    const raw = values.get(key);
    if (raw === undefined) return;
    const value = Number(raw);
    if (Number.isFinite(value) && (!theme || defaultValue === undefined || Math.abs(value - defaultValue) > 0.001)) (result as unknown as Record<string, unknown>)[property] = value;
  };
  setString("strokeColor", "strokeColor", defaults.stroke);
  setString("fontColor", "fontColor", defaults.fontColor);
  setString("fontFamily", "fontFamily", defaults.fontFamily);
  setString("labelBackgroundColor", "labelBackgroundColor", defaults.labelBackground);
  setNumber("strokeWidth", "strokeWidth", defaults.width);
  setNumber("fontSize", "fontSize", defaults.fontSize);
  const rawDash = values.get("dashPattern");
  if (rawDash !== undefined && (!theme || !colorsEqual(rawDash, defaults.dash))) result.dashPattern = rawDash;
  if (values.has("dashed")) {
    const styledDash = values.get("dashed") === "1";
    const defaultDash = Boolean(defaults.dash);
    if (!theme || styledDash !== defaultDash) result.dashed = styledDash;
  }
  setString("startArrow", "startArrow", defaults.startArrow);
  setString("endArrow", "endArrow", defaults.endArrow);
  const endFill = values.get("endFill");
  if (endFill !== undefined && (!theme || (endFill === "1") !== defaults.endFill)) result.endFill = endFill === "1";
  return Object.keys(result).length ? result : undefined;
}
function parseDrawioXml(xml: string): Document | null {
  if (!validateDrawioXmlDocument(xml).success) return null;
  const parse = (source: string): Document | null => {
    const errors: string[] = [];
    try {
      const parser = new DOMParser({ locator: false, onError: (level, message) => { if (level !== "warning") errors.push(message); } });
      const result = parser.parseFromString(source, "application/xml");
      // @xmldom/xmldom 0.9.x exposes module-local DOM types, not lib.dom's Document.
      // Cast only at this parser boundary; downstream traversal treats it as read-only.
      return errors.length || !result.documentElement ? null : result as unknown as Document;
    } catch { return null; }
  };

  const parsed = parse(xml);
  if (!parsed) return null;
  if (parsed.documentElement.nodeName === "mxGraphModel") return parsed;

  // Project only the first page, but never merge cell IDs from different pages. The
  // untouched complete mxfile remains the only document source and stays in persistence.
  const diagram = directChildren(parsed.documentElement, "diagram")[0];
  if (!diagram) return null;
  const embeddedModel = directChild(diagram, "mxGraphModel");
  // XMLSerializer has the same module-local DOM type mismatch in xmldom 0.9.x.
  // The explicit cast stays at the boundary; the original mxfile XML remains authoritative.
  if (embeddedModel) return parse(new XMLSerializer().serializeToString(embeddedModel as unknown as XmldomSerializerNode));

  const payload = diagram.textContent?.trim();
  if (!payload) return null;
  if (payload.startsWith("<")) {
    const nested = parse(payload);
    if (nested?.documentElement.nodeName === "mxGraphModel") return nested;
  }

  try {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let inflated: Uint8Array | null = null;
    try { inflated = inflateSync(bytes); } catch { /* Try a zlib-wrapped payload for legacy files. */ }
    if (!inflated) {
      try { inflated = unzlibSync(bytes); } catch { /* Invalid or unsupported compressed payload. */ }
    }
    if (!inflated) return null;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
    const candidates = [decoded];
    try {
      const uriDecoded = decodeURIComponent(decoded);
      if (uriDecoded !== decoded) candidates.push(uriDecoded);
    } catch { /* A few older files contain direct XML text. */ }
    for (const candidate of candidates) {
      const nested = parse(candidate);
      if (nested?.documentElement.nodeName === "mxGraphModel") return nested;
    }
  } catch { return null; }
  return null;
}

export function fromDrawioXml(xml: string, previous: DiagramDocument): DiagramDocument {
  const parsed = parseDrawioXml(xml);
  if (!parsed) return previous;
  const root = directChild(parsed.documentElement, "root");
  const cellEntries: Array<{ cell: Element; wrapper: Element; id: string }> = [];
  if (root) {
    for (let index = 0; index < root.childNodes.length; index += 1) {
      const child = root.childNodes.item(index);
      if (!child || child.nodeType !== 1) continue;
      const wrapper = child as Element;
      if (wrapper.nodeName === "mxCell") {
        cellEntries.push({ cell: wrapper, wrapper, id: wrapper.getAttribute("id") || "" });
      } else {
        const wrappedCell = directChild(wrapper, "mxCell");
        if (wrappedCell) cellEntries.push({ cell: wrappedCell, wrapper, id: wrapper.getAttribute("id") || wrappedCell.getAttribute("id") || "" });
      }
    }
  }
  const cells = cellEntries.map((entry) => entry.cell);
  const idByCell = new Map(cellEntries.map((entry) => [entry.cell, entry.id]));
  const wrapperByCell = new Map(cellEntries.map((entry) => [entry.cell, entry.wrapper]));
  const cellId = (cell: Element) => idByCell.get(cell) || cell.getAttribute("id") || "";
  const currentCellIds = new Set(cells.map(cellId));
  const cellById = new Map(cellEntries.map((entry) => [entry.id, entry.cell]));
  const layerCell = cellById.get("1");
  const storedLayout = styleValues(layerCell?.getAttribute("style") || "");
  const storedNumber = (key: string, fallback: number, minimum: number) => {
    const raw = storedLayout.get(key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) && value >= minimum ? value : fallback;
  };
  const storedEnum = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = storedLayout.get(key);
    return value && (allowed as readonly string[]).includes(value) ? value as T : fallback;
  };
  let storedProfile = previous.layout.profile;
  const encodedProfile = storedLayout.get("studioLayoutProfile");
  if (encodedProfile) {
    try {
      const decoded = decodeURIComponent(encodedProfile);
      if (/^[a-zA-Z0-9._-]{1,100}$/.test(decoded)) storedProfile = decoded;
    } catch { /* Ignore malformed non-Studio metadata and retain the supplied fallback. */ }
  }
  const projectedLayout: DiagramDocument["layout"] = {
    ...previous.layout,
    profile: storedProfile,
    direction: storedEnum("studioLayoutDirection", ["RIGHT", "DOWN"] as const, previous.layout.direction),
    routing: storedEnum("studioLayoutRouting", ["orthogonal", "polyline", "curved"] as const, previous.layout.routing),
    nodeSpacing: storedNumber("studioNodeSpacing", previous.layout.nodeSpacing, 1),
    layerSpacing: storedNumber("studioLayerSpacing", previous.layout.layerSpacing, 1),
    boundaryPadding: storedNumber("studioBoundaryPadding", previous.layout.boundaryPadding, 0),
    externalSide: storedEnum("studioExternalSide", ["LEFT", "RIGHT"] as const, previous.layout.externalSide),
    storageSide: storedEnum("studioStorageSide", ["BOTTOM", "RIGHT"] as const, previous.layout.storageSide)
  };
  const absolutePosition = (cell: Element): Point => {
    const geometry = directChild(cell, "mxGeometry");
    let x = Number(geometry?.getAttribute("x") || 0);
    let y = Number(geometry?.getAttribute("y") || 0);
    let parentId = cell.getAttribute("parent") || "";
    const visited = new Set<string>([cellId(cell)]);
    while (parentId && parentId !== "0" && parentId !== "1" && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = cellById.get(parentId);
      if (!parent) break;
      const parentGeometry = directChild(parent, "mxGeometry");
      if (parentGeometry) {
        x += Number(parentGeometry.getAttribute("x") || 0);
        y += Number(parentGeometry.getAttribute("y") || 0);
      }
      parentId = parent.getAttribute("parent") || "";
    }
    return { x, y };
  };
  const previousNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  const previousRelations = new Map(previous.relations.map((relation) => [relation.id, relation]));
  const nodes: DiagramNode[] = [];
  const relations: DiagramRelation[] = [];
  const importedBoundaries = new Map(previous.boundaries
    .filter((boundary) => currentCellIds.has(boundary.id))
    .map((boundary) => [boundary.id, { ...boundary, members: [...boundary.members] }]));
  const importedFragments = new Map<string, SequenceFragment>((previous.sequence?.fragments || [])
    .filter((fragment) => currentCellIds.has(fragment.id + "__sequenceFragment"))
    .map((fragment) => [fragment.id, { ...fragment }]));
  for (const cell of cells) {
    const id = cellId(cell);
    if (!id || id === "0" || id === "1" || id.endsWith("__lifelineEnd") ||
        id.endsWith("__messageSourceAnchor") || id.endsWith("__messageTargetAnchor") ||
        id.endsWith("__lifeline") || id.endsWith("__sequenceActivation") || id.endsWith("__studioAccent")) continue;
    const wrapper = wrapperByCell.get(cell) || cell;
    const value = plainLabel(cell.getAttribute("value") || wrapper.getAttribute("label") || "");
    const style = cell.getAttribute("style") || "";
    if (cell.getAttribute("vertex") === "1") {
      if (style.includes("studioBoundary=1")) {
        const members = style.match(/(?:^|;)studioMembers=([^;]+)/)?.[1]?.split(",").filter(Boolean) || [];
        importedBoundaries.set(id, { id, name: value || "SYSTEM BOUNDARY", members });
        continue;
      }
      if (id.endsWith("__sequenceFragment")) {
        const fragmentId = id.slice(0, -"__sequenceFragment".length);
        if (style.includes("studioSequenceFragment=1")) {
          const fragmentKind = style.match(/(?:^|;)studioFragmentKind=(alt|opt|loop)(?:;|$)/)?.[1];
          const startOrder = Number(style.match(/(?:^|;)studioStartOrder=(\d+)(?:;|$)/)?.[1]);
          const endOrder = Number(style.match(/(?:^|;)studioEndOrder=(\d+)(?:;|$)/)?.[1]);
          if (fragmentKind && Number.isFinite(startOrder) && Number.isFinite(endOrder) && endOrder >= startOrder) {
            const label = value.replace(/^(ALT|OPT|LOOP)\s*[·:-]?\s*/i, "").trim();
            const participants = style.match(/(?:^|;)studioFragmentParticipants=([^;]*)(?:;|$)/)?.[1]
              ?.split(",").filter(Boolean);
            importedFragments.set(fragmentId, {
              id: fragmentId, kind: fragmentKind as SequenceFragment["kind"], label, startOrder, endOrder,
              ...(participants?.length ? { participants } : {})
            });
          }
        }
        continue;
      }
      const old = previousNodes.get(id);
      // Empty structural/decoration cells stay in the authoritative XML but are not
      // projected into visible Studio nodes as misleading "New node" placeholders.
      if (!value && !old) continue;
      const geometry = directChild(cell, "mxGeometry");
      if (!geometry) continue;
      const position = absolutePosition(cell);
      const x = position.x;
      const y = position.y;
      const width = Number(geometry.getAttribute("width") || 180);
      const height = Number(geometry.getAttribute("height") || 78);
      const nativeParentId = cell.getAttribute("parent") || "";
      const positionChanged = Boolean(old && (Math.abs(old.x - x) > 1 || Math.abs(old.y - y) > 1));
      // Semantic roles are a projection of the current XML style. Studio-generated cells
      // persist explicit markers; native cells are mapped from their current shape instead
      // of inheriting potentially stale role values from a previous document.
      const role = roleFromStyle(style);
      const visualRole = visualRoleFromStyle(style);
      const importedStyle = nodeVisualStyleFromDrawio(style, role, visualRole, previous.renderTheme || "editorial");
      nodes.push({
        ...(old || { id, name: value || "New node", role, visualRole, width: 180, height: 78, x: 0, y: 0, layoutHints: {} }),
        name: value || old!.name,
        parentId: nativeParentId && nativeParentId !== "0" && nativeParentId !== "1" ? nativeParentId : undefined,
        x, y, width, height,
        layoutHints: {
          ...((old && old.layoutHints) || {}),
          locked: old ? Boolean(old.layoutHints?.locked) || positionChanged : false
        },
        visualStyle: importedStyle
      });
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const importedNodeIds = new Set(nodeById.keys());
  // Resolve edges only after all vertices (including later-in-XML endpoints) are indexed.
  for (const cell of cells) {
    if (cell.getAttribute("edge") !== "1") continue;
    const id = cellId(cell);
    if (!id) continue;
    const wrapper = wrapperByCell.get(cell) || cell;
    const value = plainLabel(cell.getAttribute("value") || wrapper.getAttribute("label") || "");
    const style = cell.getAttribute("style") || "";
    if (id.endsWith("__lifeline")) continue;

    const rawSource = cell.getAttribute("source") || "";
    const rawTarget = cell.getAttribute("target") || "";
    const styleSource = style.match(/(?:^|;)studioSource=([^;]+)/)?.[1];
    const styleTarget = style.match(/(?:^|;)studioTarget=([^;]+)/)?.[1];
    const old = previousRelations.get(id);
    const source = styleSource || (rawSource.includes("__messageSourceAnchor") ? old?.source || rawSource : rawSource);
    const target = styleTarget || (rawTarget.includes("__messageTargetAnchor") ? old?.target || rawTarget : rawTarget);
    // XML is the source of truth: an edge is valid only when both endpoints are
    // vertices projected from this page. Previous semantic state must not resurrect
    // nodes that are absent from the imported XML.
    if (!importedNodeIds.has(source) || !importedNodeIds.has(target)) continue;

    const geometry = directChild(cell, "mxGeometry");
    const pointElements = geometry ? directChildren(geometry, "Array")
      .filter((array) => array.getAttribute("as") === "points")
      .flatMap((array) => directChildren(array, "mxPoint")) : [];
    const points: Point[] = pointElements.map((point) => ({
      x: Number(point.getAttribute("x") || 0),
      y: Number(point.getAttribute("y") || 0)
    }));
    const explicitKind = style.match(/(?:^|;)studioKind=(flow|call|return|async|event|dependency)(?:;|$)/)?.[1] as DiagramRelation["kind"] | undefined;
    const explicitSequenceOrder = style.match(/(?:^|;)studioSequenceOrder=(\d+)(?:;|$)/)?.[1];
    const relationKind = explicitKind || old?.kind || "flow";
    const importedRelationStyle = relationVisualStyleFromDrawio(style, relationKind, previous.renderTheme || "editorial");
    const sourceGeometryNode = nodeById.get(source) || previousNodes.get(source);
    const targetGeometryNode = nodeById.get(target) || previousNodes.get(target);
    const readPort = (
      xKey: "exitX" | "entryX",
      yKey: "exitY" | "entryY",
      node: DiagramNode | undefined
    ): Point | undefined => {
      if (!node) return undefined;
      const xValue = style.match(new RegExp("(?:^|;)" + xKey + "=([-+0-9.eE]+)(?:;|$)"))?.[1];
      const yValue = style.match(new RegExp("(?:^|;)" + yKey + "=([-+0-9.eE]+)(?:;|$)"))?.[1];
      if (xValue === undefined || yValue === undefined) return undefined;
      const x = Number(xValue), y = Number(yValue);
      return Number.isFinite(x) && Number.isFinite(y)
        ? { x: node.x + x * node.width, y: node.y + y * node.height }
        : undefined;
    };
    const sourcePort = readPort("exitX", "exitY", sourceGeometryNode);
    const targetPort = readPort("entryX", "entryY", targetGeometryNode);
    relations.push({
      ...(old || { id, source, target, label: value, kind: explicitKind || "flow" }),
      source, target, label: value,
      kind: relationKind,
      sequenceOrder: explicitSequenceOrder === undefined ? old?.sequenceOrder : Number(explicitSequenceOrder),
      dashed: style.includes("dashed=1"),
      routing: style.includes("curved=1") ? "curved" : style.includes("edgeStyle=orthogonalEdgeStyle") ? "orthogonal" : "polyline",
      sourcePort, targetPort,
      points,
      visualStyle: importedRelationStyle
    });
  }
  // A valid Draw.io page may intentionally contain no vertices or no edges.
  // Do not reuse semantic relations from the previous document: that can leak stale
  // edges into a newly imported diagram whose XML contains no edge cells.
  const relationList = relations;
  const boundaries = [...importedBoundaries.values()].map((boundary) => ({
    ...boundary,
    members: boundary.members.filter((id) => importedNodeIds.has(id))
  }));
  const embeddedTheme = cells.map((cell) => styleValues(cell.getAttribute("style") || "").get("studioTheme")).find(Boolean);
  const importedTheme = embeddedTheme || previous.renderTheme || "editorial";
  const hasNativeSequenceStructure = cells.some((cell) => {
    const style = (cell.getAttribute("style") || "").toLowerCase();
    const shape = style.match(/(?:^|;)shape=([^;]+)/)?.[1] || "";
    return shape.includes("lifeline") || shape.includes("umlactor");
  });
  const isSequenceDiagram = previous.kind === "sequence" || hasNativeSequenceStructure || cells.some((cell) => {
    const cellId = idByCell.get(cell) || cell.getAttribute("id") || "";
    return cellId.endsWith("__lifelineEnd") || cellId.endsWith("__messageSourceAnchor");
  }) || importedFragments.size > 0;
  const declaredParticipants = previous.sequence?.participants || [];
  const sequence = isSequenceDiagram ? {
    participants: [
      ...declaredParticipants.filter((id) => importedNodeIds.has(id)),
      ...nodes.map((node) => node.id).filter((id) => !declaredParticipants.includes(id))
    ],
    fragments: [...importedFragments.values()]
  } : previous.sequence;
  const imported: DiagramDocument = {
    ...previous,
    renderTheme: importedTheme as DiagramDocument["renderTheme"],
    // A previous sequence projection must not classify a newly imported non-sequence
    // page. Native sequence markers above are derived from the current XML page.
    kind: isSequenceDiagram ? "sequence" : previous.kind === "sequence" ? "c4" : previous.kind,
    layout: isSequenceDiagram ? { ...projectedLayout, direction: "RIGHT", routing: "polyline" } : projectedLayout,
    nodes, relations: relationList, boundaries, sequence: isSequenceDiagram ? sequence : undefined
  };
  return imported;
}