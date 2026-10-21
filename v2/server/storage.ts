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
export function workspaceRevision(document: unknown, drawioXml: string | null): string {
  return createHash("sha256").update(JSON.stringify(document)).update("\0").update(drawioXml ?? "").digest("hex");
}
export function retainRecentVersions<T extends { id: string; workspaceId?: string }>(versions: T[], maxPerWorkspace: number): T[] {
  const counts = new Map<string, number>();
  const retained = new Set<string>();
  for (let i = versions.length - 1; i >= 0; i--) {
    const version = versions[i], workspaceId = version.workspaceId ?? "__legacy__";
    const count = counts.get(workspaceId) ?? 0;
    if (count >= maxPerWorkspace) continue;
    counts.set(workspaceId, count + 1);
    retained.add(version.id);
  }
  return versions.filter((version) => retained.has(version.id));
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
