import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
export async function writeTextAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), "utf8");
  await rename(temp, file);
}
export function matchesWorkspaceRevision(baseRevision: string | null | undefined, currentRevision: string | null): boolean {
  return baseRevision !== undefined && baseRevision === currentRevision;
}
/** Prevent a null revision from authorizing a stale save across workspace switches. */
export function isWorkspaceSaveContextCompatible(
  activeStateMatches: boolean,
  workspaceHasPrimaryDiagram: boolean,
  storedXmlExists: boolean,
  baseRevision: string | null | undefined
): boolean {
  if (activeStateMatches) return true;
  return !workspaceHasPrimaryDiagram && !storedXmlExists && baseRevision === null;
}

export function workspaceRevision(drawioXml: string | null): string {
  return createHash("sha256").update(drawioXml ?? "").digest("hex");
}
export function retainRecentVersions<T extends { id: string; workspaceId?: string; diagramPath?: string | null; drawioXml?: string }>(
  versions: T[], maxPerWorkspace: number, maxTotalVersions = 500,
  maxBytesPerWorkspace = Number.MAX_SAFE_INTEGER, maxTotalBytes = Number.MAX_SAFE_INTEGER
): T[] {
  const counts = new Map<string, number>();
  const bytesByScope = new Map<string, number>();
  const retained = new Set<string>();
  const totalLimit = Math.max(1, Math.floor(maxTotalVersions));
  const workspaceLimit = Math.max(1, Math.floor(maxPerWorkspace));
  const workspaceByteLimit = Math.max(1, Math.floor(maxBytesPerWorkspace));
  const totalByteLimit = Math.max(1, Math.floor(maxTotalBytes));
  let totalBytes = 0;
  // Prefer newest history first, but enforce storage budgets as well as count limits.
  for (let i = versions.length - 1; i >= 0 && retained.size < totalLimit; i--) {
    const version = versions[i];
    const workspaceId = version.workspaceId ?? "__legacy__";
    const diagramPath = version.diagramPath ?? "__legacy_diagram__";
    const scopeKey = workspaceId + "\0" + diagramPath;
    const count = counts.get(scopeKey) ?? 0;
    if (count >= workspaceLimit) continue;
    const size = typeof version.drawioXml === "string" ? Buffer.byteLength(version.drawioXml, "utf8") : 0;
    const scopeBytes = bytesByScope.get(scopeKey) ?? 0;
    if (size > workspaceByteLimit || scopeBytes + size > workspaceByteLimit || totalBytes + size > totalByteLimit) continue;
    counts.set(scopeKey, count + 1);
    bytesByScope.set(scopeKey, scopeBytes + size);
    totalBytes += size;
    retained.add(version.id);
  }
  return versions.filter((version) => retained.has(version.id));
}
export interface CompensatingWriteStep {
  name: string;
  apply: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Run ordered file writes with reverse-order compensation if a later write fails.
 * This is not a filesystem-wide atomic transaction; rollback failures are surfaced
 * explicitly so the caller can report that recovery was incomplete.
 */
export async function runCompensatingTransaction(steps: CompensatingWriteStep[]): Promise<void> {
  const completed: CompensatingWriteStep[] = [];
  try {
    for (const step of steps) {
      await step.apply();
      completed.push(step);
    }
  } catch (cause) {
    const rollbackErrors: string[] = [];
    for (const step of completed.reverse()) {
      try {
        await step.rollback();
      } catch (error) {
        rollbackErrors.push(step.name + ": " + (error instanceof Error ? error.message : String(error)));
      }
    }
    if (rollbackErrors.length) {
      const causeMessage = cause instanceof Error ? cause.message : String(cause);
      throw new Error("Write failed: " + causeMessage + "; compensation was incomplete: " + rollbackErrors.join("; "));
    }
    throw cause;
  }
}

export function createSerializedWriteQueue() {
  let queue: Promise<void> = Promise.resolve();
  return async function withSerializedWrite<T>(operation: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    queue = queue.then(async () => {
      try { resolve(await operation()); } catch (error) { reject(error); }
    });
    await queue;
    return result;
  };
}
