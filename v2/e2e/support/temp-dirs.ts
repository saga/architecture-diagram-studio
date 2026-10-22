import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const created: string[] = [];

/**
 * Creates a scratch directory outside the repository and remembers it so the run can
 * remove it afterwards. Workspaces and fixture projects both go through here.
 */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  const dirs = created.splice(0, created.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}
