import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";

const MAX_DIAGRAM_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_BYTES = 128 * 1024 * 1024;
const OPEN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export class LocalDiagramFileError extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = "LocalDiagramFileError";
  }
}

interface BrowserDocumentBinding {
  documentId: string;
  name: string;
  revision: string;
  lastUsedAt: number;
}

interface LocalHistorySummary {
  id: string;
  createdAt: string;
  label: string;
  xmlLength: number;
  xmlBytes: number;
  revision: string;
}
interface LocalHistoryEntry extends LocalHistorySummary {
  xml: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateXml(xml: string): void {
  if (!xml || Buffer.byteLength(xml, "utf8") > MAX_DIAGRAM_BYTES) {
    throw new LocalDiagramFileError("Draw.io XML must be non-empty and no larger than 20 MiB", 413);
  }
  const validation = validateDrawioXmlDocument(xml);
  if (!validation.success) throw new LocalDiagramFileError(validation.issues[0] || "The selected content is not valid Draw.io XML");
}

function safeDocumentName(name: string): string {
  const normalized = name.trim().split(/[\\/]/).pop()?.slice(0, 255) || "";
  if (!normalized || normalized === "." || normalized === ".." || normalized.includes("\0")) {
    throw new LocalDiagramFileError("A valid Draw.io document name is required");
  }
  return normalized;
}

export function createLocalDiagramFileService(options: { historyDirectory?: string } = {}) {
  const openFiles = new Map<string, BrowserDocumentBinding>();
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

  function getBinding(token: string): BrowserDocumentBinding {
    pruneExpiredTokens();
    const binding = openFiles.get(token);
    if (!binding) throw new LocalDiagramFileError("This browser file session expired. Reopen the diagram before using its history.", 410);
    binding.lastUsedAt = Date.now();
    return binding;
  }

  function documentDirectory(binding: BrowserDocumentBinding): string {
    // Never derive a filesystem path from client-supplied IDs or filenames.
    return path.join(historyDirectory, digest(binding.documentId));
  }

  function indexPath(binding: BrowserDocumentBinding): string {
    return path.join(documentDirectory(binding), "index.json");
  }

  function xmlPath(binding: BrowserDocumentBinding, id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new LocalDiagramFileError("Invalid local history snapshot ID");
    return path.join(documentDirectory(binding), id + ".xml");
  }

  async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
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
    try {
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  function retainWithinBudget(entries: LocalHistorySummary[]): LocalHistorySummary[] {
    const retained: LocalHistorySummary[] = [];
    let bytes = 0;
    for (let index = entries.length - 1; index >= 0 && retained.length < MAX_HISTORY_ENTRIES; index--) {
      const item = entries[index]!;
      if (!Number.isFinite(item.xmlBytes) || item.xmlBytes < 0 || item.xmlBytes > MAX_DIAGRAM_BYTES) continue;
      if (bytes + item.xmlBytes > MAX_HISTORY_BYTES) continue;
      retained.unshift(item);
      bytes += item.xmlBytes;
    }
    return retained;
  }

  async function writeIndex(binding: BrowserDocumentBinding, entries: LocalHistorySummary[]): Promise<void> {
    const directory = documentDirectory(binding);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const retained = retainWithinBudget(entries);
    await atomicWrite(indexPath(binding), JSON.stringify({ schemaVersion: 3, entries: retained }), 0o600);
    const kept = new Set(retained.map((entry) => entry.id));
    for (const entry of entries) {
      if (!kept.has(entry.id)) await unlink(xmlPath(binding, entry.id)).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }

  async function readIndex(binding: BrowserDocumentBinding): Promise<LocalHistorySummary[]> {
    let raw: string;
    try {
      raw = await readFile(indexPath(binding), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return []; }
    const rawEntries = parsed && typeof parsed === "object" &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === 3 &&
      Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries : [];
    const valid: LocalHistorySummary[] = [];
    for (const value of rawEntries) {
      if (!value || typeof value !== "object") continue;
      const item = value as Partial<LocalHistorySummary>;
      if (typeof item.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
          typeof item.createdAt !== "string" || typeof item.label !== "string" ||
          typeof item.xmlLength !== "number" || typeof item.xmlBytes !== "number" ||
          typeof item.revision !== "string") continue;
      const info = await stat(xmlPath(binding, item.id)).catch(() => null);
      if (!info?.isFile() || info.size !== item.xmlBytes) continue;
      valid.push({
        id: item.id, createdAt: item.createdAt, label: item.label,
        xmlLength: item.xmlLength, xmlBytes: item.xmlBytes, revision: item.revision
      });
    }
    const bounded = retainWithinBudget(valid);
    if (bounded.length !== valid.length) await writeIndex(binding, bounded);
    return bounded;
  }

  async function loadHistoryEntry(binding: BrowserDocumentBinding, id: string): Promise<LocalHistoryEntry> {
    const summary = (await readIndex(binding)).find((item) => item.id === id);
    if (!summary) throw new LocalDiagramFileError("The requested local history snapshot was not found", 404);
    const xml = await readFile(xmlPath(binding, id), "utf8").catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalDiagramFileError("The local history snapshot is missing", 410);
      throw error;
    });
    if (xml.length !== summary.xmlLength || Buffer.byteLength(xml, "utf8") !== summary.xmlBytes ||
        digest(xml) !== summary.revision || !validateDrawioXmlDocument(xml).success) {
      throw new LocalDiagramFileError("The local history snapshot failed integrity validation", 409);
    }
    return { ...summary, xml };
  }

  async function writeSnapshot(binding: BrowserDocumentBinding, xml: string, label: string): Promise<void> {
    validateXml(xml);
    const entries = await readIndex(binding);
    const revision = digest(xml);
    if (entries.at(-1)?.revision === revision) return;
    const id = randomUUID();
    const summary: LocalHistorySummary = {
      id, createdAt: new Date().toISOString(), label: label.trim().slice(0, 200) || "Autosave",
      xmlLength: xml.length, xmlBytes: Buffer.byteLength(xml, "utf8"), revision
    };
    await mkdir(documentDirectory(binding), { recursive: true, mode: 0o700 });
    await atomicWrite(xmlPath(binding, id), xml, 0o600);
    await writeIndex(binding, [...entries, summary]);
  }

  return {
    async openBrowserDocument(documentId: string, name: string, drawioXml: string) {
      if (typeof documentId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) {
        throw new LocalDiagramFileError("Invalid browser document ID");
      }
      const safeName = safeDocumentName(name);
      validateXml(drawioXml);
      const binding: BrowserDocumentBinding = {
        documentId, name: safeName, revision: digest(drawioXml), lastUsedAt: Date.now()
      };
      const fileToken = randomUUID();
      openFiles.set(fileToken, binding);
      await writeSnapshot(binding, drawioXml, "Opened file");
      pruneExpiredTokens();
      return { fileToken, documentId, name: safeName, revision: binding.revision, snapshotCount: (await readIndex(binding)).length };
    },

    async saveSnapshot(token: string, baseRevision: string, drawioXml: string, label: string) {
      const binding = getBinding(token);
      if (baseRevision !== binding.revision) {
        throw new LocalDiagramFileError("The history snapshot is based on an older revision. Reload or resynchronize before retrying.", 409);
      }
      validateXml(drawioXml);
      await writeSnapshot(binding, drawioXml, label);
      binding.revision = digest(drawioXml);
      binding.lastUsedAt = Date.now();
      return { revision: binding.revision, snapshotCount: (await readIndex(binding)).length };
    },

    async listHistory(token: string) {
      const binding = getBinding(token);
      return (await readIndex(binding)).map(({ revision, xmlBytes, ...summary }) => summary);
    },

    async readHistoryEntry(token: string, versionId: string) {
      const binding = getBinding(token);
      return loadHistoryEntry(binding, versionId);
    },

    async prepareHistoryRestore(token: string, baseRevision: string, currentXml: string, versionId: string) {
      const binding = getBinding(token);
      if (baseRevision !== binding.revision || digest(currentXml) !== binding.revision) {
        throw new LocalDiagramFileError("The current file or history revision changed. Save or reopen the file before restoring history.", 409);
      }
      validateXml(currentXml);
      await writeSnapshot(binding, currentXml, "Before restore");
      const target = await loadHistoryEntry(binding, versionId);
      return { id: target.id, label: target.label, drawioXml: target.xml, revision: target.revision };
    }
  };
}
