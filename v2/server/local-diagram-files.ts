import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";

const MAX_DIAGRAM_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 100;
const OPEN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const DIAGRAM_EXTENSIONS = new Set([".drawio", ".dio", ".xml"]);

export class LocalDiagramFileError extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = "LocalDiagramFileError";
  }
}

export interface LocalDiagramEntry {
  name: string;
  path: string;
  kind: "directory" | "diagram";
  size: number;
  modifiedAt: string;
}

export interface LocalDiagramOpenResult {
  fileToken: string;
  path: string;
  name: string;
  drawioXml: string;
  revision: string;
  size: number;
}

interface OpenFileBinding {
  path: string;
  name: string;
  revision: string;
  lastUsedAt: number;
}

interface LocalHistoryEntry {
  id: string;
  createdAt: string;
  label: string;
  xml: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function isDiagramPath(filePath: string): boolean {
  return DIAGRAM_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function validateXml(xml: string): void {
  if (Buffer.byteLength(xml, "utf8") > MAX_DIAGRAM_BYTES) {
    throw new LocalDiagramFileError("Draw.io XML exceeds the 20 MiB limit", 413);
  }
  const validation = validateDrawioXmlDocument(xml);
  if (!validation.success) throw new LocalDiagramFileError(validation.issues[0] || "The selected file is not valid Draw.io XML");
}

export function createLocalDiagramFileService(options: {
  allowedRoots: () => Promise<string[]>;
  historyDirectory?: string;
}) {
  const openFiles = new Map<string, OpenFileBinding>();
  const historyDirectory = path.resolve(options.historyDirectory || path.join(homedir(), ".architecture-diagram-studio", "data", "standalone-history"));

  function pruneExpiredTokens(): void {
    const cutoff = Date.now() - OPEN_TOKEN_TTL_MS;
    for (const [token, binding] of openFiles) if (binding.lastUsedAt < cutoff) openFiles.delete(token);
    while (openFiles.size > 200) {
      const oldest = [...openFiles.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!oldest) break;
      openFiles.delete(oldest[0]);
    }
  }

  async function canonicalRoots(): Promise<string[]> {
    const roots = await options.allowedRoots();
    const result: string[] = [];
    for (const root of roots) {
      if (!root || !path.isAbsolute(root)) continue;
      try {
        const canonical = await realpath(path.resolve(root));
        if ((await stat(canonical)).isDirectory() && !result.includes(canonical)) result.push(canonical);
      } catch { /* A missing workspace root is not an available browse root. */ }
    }
    if (!result.length) throw new LocalDiagramFileError("No local filesystem browse root is available", 500);
    return result;
  }

  async function resolveAllowedPath(requestedPath: string, kind: "file" | "directory"): Promise<{ path: string; root: string }> {
    if (!requestedPath || !path.isAbsolute(requestedPath)) throw new LocalDiagramFileError("Use an absolute local path");
    const absolute = path.resolve(requestedPath);
    const roots = await canonicalRoots();
    const root = roots.filter((candidate) => isWithin(candidate, absolute)).sort((a, b) => b.length - a.length)[0];
    if (!root) throw new LocalDiagramFileError("The path must be inside your home directory or the configured workspace", 403);
    let info;
    try { info = await lstat(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalDiagramFileError("The selected path does not exist", 404);
      throw error;
    }
    if (info.isSymbolicLink()) throw new LocalDiagramFileError("Symbolic links are not opened or written by the local file service", 403);
    const canonical = await realpath(absolute);
    if (!isWithin(root, canonical)) throw new LocalDiagramFileError("The resolved path escapes the permitted browse root", 403);
    if (kind === "file" && !info.isFile()) throw new LocalDiagramFileError("The selected path is not a regular file");
    if (kind === "directory" && !info.isDirectory()) throw new LocalDiagramFileError("The selected path is not a directory");
    return { path: canonical, root };
  }

  async function readDiagramFile(requestedPath: string) {
    const resolved = await resolveAllowedPath(requestedPath, "file");
    if (!isDiagramPath(resolved.path)) throw new LocalDiagramFileError("Choose a .drawio, .dio, or .xml file");
    const info = await stat(resolved.path);
    if (info.size > MAX_DIAGRAM_BYTES) throw new LocalDiagramFileError("Draw.io XML exceeds the 20 MiB limit", 413);
    const xml = await readFile(resolved.path, "utf8");
    validateXml(xml);
    return { path: resolved.path, name: path.basename(resolved.path), xml, revision: digest(xml), size: info.size };
  }

  async function readHistory(binding: OpenFileBinding): Promise<LocalHistoryEntry[]> {
    const filePath = path.join(historyDirectory, digest(binding.path) + ".json");
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is LocalHistoryEntry =>
        !!entry && typeof entry === "object" &&
        typeof (entry as LocalHistoryEntry).id === "string" &&
        typeof (entry as LocalHistoryEntry).createdAt === "string" &&
        typeof (entry as LocalHistoryEntry).label === "string" &&
        typeof (entry as LocalHistoryEntry).xml === "string" &&
        Buffer.byteLength((entry as LocalHistoryEntry).xml, "utf8") <= MAX_DIAGRAM_BYTES
      ).slice(-MAX_HISTORY_ENTRIES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function atomicReplace(filePath: string, content: string, mode: number): Promise<void> {
    const temporaryPath = filePath + "." + randomUUID() + ".tmp";
    const handle = await open(temporaryPath, "wx", mode);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await handle.close();
    try { await rename(temporaryPath, filePath); }
    catch (error) { await unlink(temporaryPath).catch(() => undefined); throw error; }
  }

  async function writeHistory(binding: OpenFileBinding, entries: LocalHistoryEntry[]): Promise<void> {
    await mkdir(historyDirectory, { recursive: true, mode: 0o700 });
    await atomicReplace(path.join(historyDirectory, digest(binding.path) + ".json"), JSON.stringify(entries.slice(-MAX_HISTORY_ENTRIES)), 0o600);
  }

  async function snapshot(binding: OpenFileBinding, xml: string, label: string): Promise<void> {
    if (!xml || !validateDrawioXmlDocument(xml).success) return;
    const entries = await readHistory(binding);
    if (entries.at(-1)?.xml !== xml) {
      entries.push({ id: randomUUID(), createdAt: new Date().toISOString(), label: label.slice(0, 200), xml });
      await writeHistory(binding, entries);
    }
  }

  function getBinding(token: string): OpenFileBinding {
    pruneExpiredTokens();
    const binding = openFiles.get(token);
    if (!binding) throw new LocalDiagramFileError("This open-file session expired. Reopen the diagram before saving.", 410);
    binding.lastUsedAt = Date.now();
    return binding;
  }

  async function verifyUnchangedOnDisk(binding: OpenFileBinding, baseRevision: string): Promise<{ xml: string; mode: number }> {
    if (baseRevision !== binding.revision) throw new LocalDiagramFileError("The save is based on an older editor revision. Reload the file before retrying.", 409);
    const info = await lstat(binding.path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalDiagramFileError("The original file was moved or deleted", 409);
      throw error;
    });
    if (info.isSymbolicLink() || !info.isFile()) throw new LocalDiagramFileError("The original file is no longer a regular file", 409);
    const xml = await readFile(binding.path, "utf8");
    if (digest(xml) !== binding.revision) throw new LocalDiagramFileError("The file changed outside Draw.io Studio. Reopen it before overwriting those changes.", 409);
    return { xml, mode: info.mode & 0o777 };
  }

  async function writeNewFile(filePath: string, xml: string): Promise<void> {
    const handle = await open(filePath, "wx", 0o644).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LocalDiagramFileError("That file already exists. Choose another name to avoid overwriting it.", 409);
      throw error;
    });
    try { await handle.writeFile(xml, "utf8"); await handle.sync(); }
    catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(filePath).catch(() => undefined);
      throw error;
    }
    await handle.close();
  }

  return {
    async listDirectory(directory?: string) {
      const roots = await canonicalRoots();
      const target = directory || roots[0]!;
      const resolved = await resolveAllowedPath(target, "directory");
      const items = await readdir(resolved.path, { withFileTypes: true });
      const entries: LocalDiagramEntry[] = [];
      for (const item of items) {
        if (item.isSymbolicLink() || item.name === "." || item.name === "..") continue;
        const fullPath = path.join(resolved.path, item.name);
        if (item.isDirectory()) {
          if (item.name.startsWith(".")) continue;
          let info;
          try { info = await stat(fullPath); } catch { continue; }
          entries.push({ name: item.name, path: fullPath, kind: "directory", size: 0, modifiedAt: info.mtime.toISOString() });
        } else if (item.isFile() && isDiagramPath(item.name)) {
          let info;
          try { info = await stat(fullPath); } catch { continue; }
          entries.push({ name: item.name, path: fullPath, kind: "diagram", size: info.size, modifiedAt: info.mtime.toISOString() });
        }
        if (entries.length >= 500) break;
      }
      entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
      const activeRoot = roots.filter((item) => isWithin(item, resolved.path)).sort((a, b) => b.length - a.length)[0]!;
      const parent = resolved.path === activeRoot ? null : path.dirname(resolved.path);
      return {
        directory: resolved.path,
        parentDirectory: parent && isWithin(activeRoot, parent) ? parent : null,
        roots: roots.map((root) => ({ path: root, name: path.basename(root) || root })),
        entries
      };
    },

    async openDiagram(filePath: string): Promise<LocalDiagramOpenResult> {
      const file = await readDiagramFile(filePath);
      const fileToken = randomUUID();
      openFiles.set(fileToken, { path: file.path, name: file.name, revision: file.revision, lastUsedAt: Date.now() });
      pruneExpiredTokens();
      return { fileToken, path: file.path, name: file.name, drawioXml: file.xml, revision: file.revision, size: file.size };
    },

    async importDiagram(filePath: string) {
      const file = await readDiagramFile(filePath);
      return { path: file.path, name: file.name, drawioXml: file.xml, revision: file.revision, size: file.size };
    },

    async saveDiagram(token: string, baseRevision: string, drawioXml: string) {
      const binding = getBinding(token);
      validateXml(drawioXml);
      const current = await verifyUnchangedOnDisk(binding, baseRevision);
      if (current.xml !== drawioXml) await snapshot(binding, current.xml, "Before save");
      await atomicReplace(binding.path, drawioXml, current.mode || 0o600);
      binding.revision = digest(drawioXml);
      binding.lastUsedAt = Date.now();
      return { path: binding.path, name: binding.name, revision: binding.revision, size: Buffer.byteLength(drawioXml, "utf8") };
    },

    async exportDiagram(directory: string, fileName: string, drawioXml: string) {
      const resolved = await resolveAllowedPath(directory, "directory");
      const requestedName = fileName.trim();
      const safeName = path.basename(requestedName);
      if (!safeName || safeName !== requestedName || safeName.startsWith(".") || safeName.includes("\0")) {
        throw new LocalDiagramFileError("Enter a file name, not a path");
      }
      const normalizedName = path.extname(safeName) ? safeName : safeName + ".drawio";
      if (!isDiagramPath(normalizedName)) throw new LocalDiagramFileError("Export as .drawio, .dio, or .xml");
      validateXml(drawioXml);
      const outputPath = path.join(resolved.path, normalizedName);
      await writeNewFile(outputPath, drawioXml);
      return { path: outputPath, name: normalizedName, size: Buffer.byteLength(drawioXml, "utf8") };
    },

    async snapshotCurrent(token: string, baseRevision: string, label: string) {
      const binding = getBinding(token);
      const current = await verifyUnchangedOnDisk(binding, baseRevision);
      await snapshot(binding, current.xml, label);
      return { snapshotCount: (await readHistory(binding)).length };
    },

    async listHistory(token: string) {
      const binding = getBinding(token);
      return (await readHistory(binding)).map(({ xml, ...summary }) => ({ ...summary, xmlLength: xml.length }));
    },

    async readHistoryEntry(token: string, versionId: string) {
      const binding = getBinding(token);
      const entry = (await readHistory(binding)).find((item) => item.id === versionId);
      if (!entry) throw new LocalDiagramFileError("The requested local history snapshot was not found", 404);
      return entry;
    },

    async restoreHistory(token: string, baseRevision: string, versionId: string) {
      const binding = getBinding(token);
      const current = await verifyUnchangedOnDisk(binding, baseRevision);
      const target = (await readHistory(binding)).find((entry) => entry.id === versionId);
      if (!target) throw new LocalDiagramFileError("The requested local history snapshot was not found", 404);
      validateXml(target.xml);
      if (current.xml !== target.xml) {
        await snapshot(binding, current.xml, "Before restore: " + target.label);
        await atomicReplace(binding.path, target.xml, current.mode || 0o600);
      }
      binding.revision = digest(target.xml);
      return { path: binding.path, name: binding.name, revision: binding.revision, drawioXml: target.xml };
    }
  };
}
