import { validateDrawioXmlDocument } from "../../src/model/drawio-xml-schema";
import {
  extractNativeEditTargets,
  getNativeDiagramPageInfo,
  type NativeDiagramPageInfo,
  type NativeEditTarget
} from "../../src/model/native-edit-operations";

export interface ParsedNativeDiagramSnapshot {
  revision: string;
  requestedPageId: string | null;
  pageInfo: NativeDiagramPageInfo;
  targets: NativeEditTarget[];
}

interface RevisionEntry {
  pages: Map<string, ParsedNativeDiagramSnapshot>;
}

export type CachedSnapshotResult =
  | { ok: true; cacheHit: boolean; snapshot: ParsedNativeDiagramSnapshot }
  | { ok: false; cacheHit: false };

const MAX_REVISIONS = 4;
const MAX_PAGES_PER_REVISION = 4;
const cache = new Map<string, RevisionEntry>();

function touch(revision: string, entry: RevisionEntry): void {
  cache.delete(revision);
  cache.set(revision, entry);
  while (cache.size > MAX_REVISIONS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Parses a verified content revision once per active page. The revision hash is computed and
 * checked by the caller on every request; only successful validation and derived immutable data
 * are memoized. No stale workspace state or failed validation is cached.
 */
export function getCachedNativeDiagramSnapshot(
  xml: string,
  revision: string,
  requestedPageId: string | null
): CachedSnapshotResult {
  let entry = cache.get(revision);
  if (entry) {
    const existing = entry.pages.get(requestedPageId ?? "");
    if (existing) {
      touch(revision, entry);
      return { ok: true, cacheHit: true, snapshot: existing };
    }
  } else {
    if (!validateDrawioXmlDocument(xml).success) return { ok: false, cacheHit: false };
    entry = { pages: new Map() };
    touch(revision, entry);
  }

  try {
    const pageInfo = getNativeDiagramPageInfo(xml, requestedPageId);
    const snapshot: ParsedNativeDiagramSnapshot = {
      revision,
      requestedPageId,
      pageInfo,
      targets: extractNativeEditTargets(xml, pageInfo.id, { includeGeometry: true })
    };
    entry.pages.set(requestedPageId ?? "", snapshot);
    while (entry.pages.size > MAX_PAGES_PER_REVISION) {
      const oldest = entry.pages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      entry.pages.delete(oldest);
    }
    touch(revision, entry);
    return { ok: true, cacheHit: false, snapshot };
  } catch {
    // Parser errors must fail closed and must not be memoized as success.
    if (entry.pages.size === 0) cache.delete(revision);
    return { ok: false, cacheHit: false };
  }
}

/** Allows deterministic tests to isolate cache lifecycle assertions. */
export function clearDiagramSnapshotCacheForTests(): void {
  cache.clear();
}
