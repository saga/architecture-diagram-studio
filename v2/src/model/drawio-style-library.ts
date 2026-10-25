export const DRAWIO_STYLE_LIBRARY_SCHEMA_VERSION = 1 as const;
export const ORIGINAL_DRAWIO_STYLE_ID = "original" as const;

export const DRAWIO_STYLE_CATEGORIES = [
  "node", "service", "database", "user", "external", "container",
  "edge", "edgeDashed", "edgeDotted"
] as const;
export type DrawioStyleCategory = typeof DRAWIO_STYLE_CATEGORIES[number];

export const DRAWIO_COLOR_PROPERTIES = [
  "fillColor", "strokeColor", "fontColor", "gradientColor", "swimlaneFillColor",
  "separatorColor", "indicatorColor", "labelBackgroundColor", "labelBorderColor"
] as const;

export const DRAWIO_MANAGED_STYLE_PROPERTIES = [
  ...DRAWIO_COLOR_PROPERTIES, "strokeWidth", "dashed", "dashPattern", "startArrow",
  "endArrow", "rounded", "shadow", "opacity", "fontFamily", "fontSize", "fontStyle",
  "align", "verticalAlign", "spacing", "glass", "comic"
] as const;

export type DrawioStyleProperties = Partial<Record<typeof DRAWIO_MANAGED_STYLE_PROPERTIES[number], string>>;
export type DrawioSemanticCategory = "service" | "database" | "user" | "external" | "container";
export type DrawioStyleMatchRules = Partial<Record<DrawioSemanticCategory, string[]>>;

export const DEFAULT_DRAWIO_STYLE_MATCH_RULES: DrawioStyleMatchRules = {
  database: ["database", "cylinder", "datastore", "data-store", "rds", "dynamodb", "sql"],
  user: ["actor", "person", "user", "human"],
  external: ["external", "cloud", "internet", "outside"],
  container: ["swimlane", "partialrectangle", "boundary", "group", "c4.container"],
  service: ["server", "service", "microservice", "compute", "lambda", "ec2", "ecs", "application"]
};

export interface DrawioDiagramStyle {
  id: string;
  name: string;
  description?: string;
  version: 1;
  matchRules?: DrawioStyleMatchRules;
  categories: Partial<Record<DrawioStyleCategory, DrawioStyleProperties>>;
}

export interface DrawioStyleLibrary {
  schemaVersion: typeof DRAWIO_STYLE_LIBRARY_SCHEMA_VERSION;
  styles: DrawioDiagramStyle[];
}

const propertySet = new Set<string>(DRAWIO_MANAGED_STYLE_PROPERTIES);
const categorySet = new Set<string>(DRAWIO_STYLE_CATEGORIES);

export function validateDrawioDiagramStyle(input: unknown): DrawioDiagramStyle {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Style must be a JSON object.");
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(candidate.id) || candidate.id === ORIGINAL_DRAWIO_STYLE_ID) {
    throw new Error("Style id must be a lowercase slug and cannot be 'original'.");
  }
  if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 80) {
    throw new Error("Style name must contain 1–80 characters.");
  }
  if (candidate.version !== 1) throw new Error("Unsupported style version.");
  if (candidate.description !== undefined && (typeof candidate.description !== "string" || candidate.description.length > 500)) {
    throw new Error("Style description must be 500 characters or fewer.");
  }
  if (!candidate.categories || typeof candidate.categories !== "object" || Array.isArray(candidate.categories)) {
    throw new Error("Style categories must be an object.");
  }
  const rawRules = candidate.matchRules;
  const matchRules: DrawioStyleMatchRules = {};
  if (rawRules !== undefined) {
    if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) throw new Error("Style matchRules must be an object.");
    for (const [category, rawTokens] of Object.entries(rawRules as Record<string, unknown>)) {
      if (!["service", "database", "user", "external", "container"].includes(category)) {
        throw new Error("Unsupported style matching category: " + category);
      }
      if (!Array.isArray(rawTokens) || rawTokens.length > 40 ||
          rawTokens.some((token) => typeof token !== "string" || !token.trim() || token.length > 80 ||
            /[;<>\u0000-\u001f]/.test(token))) {
        throw new Error("Match rules for '" + category + "' must be a list of safe shape-name tokens.");
      }
      matchRules[category as DrawioSemanticCategory] = rawTokens.map((token) => String(token).toLowerCase().trim());
    }
  }
  const rawCategories = candidate.categories as Record<string, unknown>;
  const categories: DrawioDiagramStyle["categories"] = {};
  for (const [category, rawProperties] of Object.entries(rawCategories)) {
    if (!categorySet.has(category)) throw new Error("Unsupported style category: " + category);
    if (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties)) {
      throw new Error("Style category '" + category + "' must be an object.");
    }
    const properties: Record<string, string> = {};
    for (const [property, rawValue] of Object.entries(rawProperties as Record<string, unknown>)) {
      if (!propertySet.has(property)) throw new Error("Unsupported managed style property: " + property);
      if (typeof rawValue !== "string" || !rawValue.trim() || rawValue.length > 120 ||
          /[;<>\u0000-\u001f]/.test(rawValue) || /url\s*\(|javascript:/i.test(rawValue)) {
        throw new Error("Invalid value for style property '" + property + "'.");
      }
      properties[property] = rawValue;
    }
    categories[category as DrawioStyleCategory] = properties as DrawioStyleProperties;
  }
  if (!categories.node || !categories.edge) {
    throw new Error("A style must define both 'node' and 'edge' categories.");
  }
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    ...(typeof candidate.description === "string" && candidate.description.trim() ? { description: candidate.description.trim() } : {}),
    version: 1,
    ...(Object.keys(matchRules).length ? { matchRules } : {}),
    categories
  };
}

export function parseDrawioStyleImport(json: string): DrawioDiagramStyle {
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error("The selected file is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The style file must contain a JSON object.");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.schemaVersion !== DRAWIO_STYLE_LIBRARY_SCHEMA_VERSION || !("style" in envelope)) {
    throw new Error("Expected a Studio diagram-style file with schemaVersion 1 and a 'style' object.");
  }
  return validateDrawioDiagramStyle(envelope.style);
}

export function serializeDrawioStyleExport(style: DrawioDiagramStyle): string {
  return JSON.stringify({
    schemaVersion: DRAWIO_STYLE_LIBRARY_SCHEMA_VERSION,
    style: validateDrawioDiagramStyle(style)
  }, null, 2) + "\n";
}

/** Classify only from native cell kind and native style/shape identifiers, never from labels or IDs. */
export function classifyDrawioStyleCell(
  input: { edge: boolean; vertex: boolean; style: string; hasChildren?: boolean },
  style?: DrawioDiagramStyle | null
): DrawioStyleCategory | null {
  if (input.edge) {
    if (/(?:^|;)dashed=1(?:;|$)/.test(input.style) && /(?:^|;)dashPattern=1(?:\s|;)/.test(input.style)) return "edgeDotted";
    if (/(?:^|;)dashed=1(?:;|$)/.test(input.style) || /(?:^|;)dashPattern=/.test(input.style)) return "edgeDashed";
    return "edge";
  }
  if (!input.vertex) return null;
  const shapeMatch = /(?:^|;)shape=([^;]+)/.exec(input.style);
  const shape = (shapeMatch?.[1] || "").toLowerCase();
  const rules = { ...DEFAULT_DRAWIO_STYLE_MATCH_RULES, ...(style?.matchRules || {}) };
  const matches = (category: DrawioSemanticCategory) => (rules[category] || []).some((token) => shape.includes(token.toLowerCase()));
  if (matches("database")) return "database";
  if (matches("user")) return "user";
  if (matches("external")) return "external";
  if (input.hasChildren || matches("container") || /(?:^|;)swimlane=1(?:;|$)/.test(input.style)) return "container";
  if (matches("service")) return "service";
  return "node";
}

/**
 * Original removes only explicit colour overrides. Named styles remove every managed
 * visual property, then apply the target category and its generic node defaults.
 */
export function rewriteDrawioStyleString(
  currentStyle: string,
  category: DrawioStyleCategory,
  target: DrawioDiagramStyle | null
): string {
  const source = currentStyle.split(";").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 0 ? { key: entry, value: "" } : { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
  });
  const removeProperties = new Set<string>(target ? DRAWIO_MANAGED_STYLE_PROPERTIES : DRAWIO_COLOR_PROPERTIES);
  const retained = source.filter((entry) => !removeProperties.has(entry.key));
  if (!target) return retained.map(({ key, value }) => value ? key + "=" + value : key).join(";");

  const categoryProperties = target.categories[category] || {};
  const genericProperties = category === "edge" || category === "edgeDashed" || category === "edgeDotted"
    ? target.categories.edge || {}
    : target.categories.node || {};
  const resolved = { ...genericProperties, ...categoryProperties };
  const next = [...retained];
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value !== "string") continue;
    const existing = next.findIndex((entry) => entry.key === key);
    if (existing >= 0) next.splice(existing, 1);
    next.push({ key, value });
  }
  return next.map(({ key, value }) => value ? key + "=" + value : key).join(";");
}
