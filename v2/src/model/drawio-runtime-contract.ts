export const PINNED_DRAWIO_VERSION = "v32.0.2";
export const DRAWIO_RUNTIME_BRIDGE_VERSION = "studio-native-runtime/5";

export const RUNTIME_INSPECTION_LIMITS = {
  /** Transport cap for the live mxCellRenderer.defaultShapes registry. */
  liveShapeClasses: 2000,
  liveShapeClassNameLength: 160
} as const;

/**
 * Identity plus the live shape registry. Native cells, geometry and rendered edge points are not
 * carried: the XML document is the source of truth for every one of them, so shipping a second
 * projection per request only bought staleness and transport cost.
 */
export interface DrawioRuntimeInspection {
  schemaVersion: 1;
  bridgeVersion: string;
  drawioVersion: string;
  documentRevision: string;
  pageId: string | null;
  /** Bounded live mxCellRenderer.defaultShapes registry from the current iframe. */
  liveShapeClasses: string[];
  /** True when the registry itself exceeded the transport cap; search counts are then incomplete. */
  liveShapeClassesTruncated: boolean;
}

export interface RuntimeInspectionExpectation {
  documentRevision?: string;
  pageId?: string | null;
  drawioVersion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shapeClassName(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= RUNTIME_INSPECTION_LIMITS.liveShapeClassNameLength &&
    /^[A-Za-z0-9_$:.-]{1,160}$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value);
}

/**
 * Validate and bound iframe-provided inspection data before it enters a request. This is a
 * context-quality check, not a security boundary or authorization decision.
 */
export function normalizeDrawioRuntimeInspection(
  value: unknown,
  expected: RuntimeInspectionExpectation = {}
): DrawioRuntimeInspection | null {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      value.bridgeVersion !== DRAWIO_RUNTIME_BRIDGE_VERSION ||
      value.drawioVersion !== PINNED_DRAWIO_VERSION) return null;

  const documentRevision = typeof value.documentRevision === "string" ? value.documentRevision : "";
  if (!/^[a-f0-9]{64}$/i.test(documentRevision)) return null;
  if (expected.documentRevision && documentRevision !== expected.documentRevision) return null;

  const pageId = typeof value.pageId === "string" ? value.pageId.slice(0, 200) : null;
  // null means the caller has not resolved the active page yet. Accept the live page ID
  // as discovery data, while still enforcing exact matches whenever a page ID was supplied.
  if (expected.pageId !== undefined && expected.pageId !== null && pageId !== expected.pageId) return null;

  const shapeClasses = Array.isArray(value.liveShapeClasses)
    ? [...new Set(value.liveShapeClasses.filter(shapeClassName))]
    : [];
  return {
    schemaVersion: 1,
    bridgeVersion: DRAWIO_RUNTIME_BRIDGE_VERSION,
    drawioVersion: PINNED_DRAWIO_VERSION,
    documentRevision,
    pageId,
    liveShapeClasses: shapeClasses.slice(0, RUNTIME_INSPECTION_LIMITS.liveShapeClasses),
    liveShapeClassesTruncated: value.liveShapeClassesTruncated === true ||
      shapeClasses.length > RUNTIME_INSPECTION_LIMITS.liveShapeClasses
  };
}
