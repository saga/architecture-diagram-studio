import express from "express";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";
import { createEmptyDrawioXml, normalizeNewDrawioFileName } from "./diagram-file";
import { readCopilotProvider, describeModelRouting, isModelConfiguredWithoutProvider } from "./copilot/model-routing";
import { randomUUID } from "node:crypto";
import { CopilotRuntime } from "./copilot/runtime";
import { createWorkspaceFileService, type ProjectWorkspace } from "./workspace-files";
import { registerCopilotIntentRoute } from "./copilot/intent-route";
import { createSerializedWriteQueue, writeTextAtomic, writeJsonAtomic, matchesWorkspaceRevision, isWorkspaceSaveContextCompatible, workspaceRevision, retainRecentVersions as retainVersionsWithinLimit } from "./storage";

/**
 * The Copilot runtime reads its model provider configuration from the environment
 * (`COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_MODEL`, …). Loading a project
 * `.env` keeps that configuration with the project instead of with whichever shell started the
 * server, which is the usual reason a custom model silently falls back to the GitHub catalog.
 * An already-exported variable always wins over the file.
 */
function loadLocalEnv(): void {
  if (typeof parseEnv !== "function") return;
  const merged: Record<string, string> = {};
  for (const dir of [process.cwd(), path.join(process.cwd(), "v2")]) {
    for (const file of [".env", ".env.local"]) {
      try { Object.assign(merged, parseEnv(readFileSync(path.join(dir, file), "utf8"))); }
      catch { /* absent or unreadable; keep looking */ }
    }
  }
  for (const [key, value] of Object.entries(merged)) if (process.env[key] === undefined) process.env[key] = value;
}
loadLocalEnv();

const PORT = Number(process.env.COPILOT_PORT || 4175);
const DEFAULT_MODEL = process.env.COPILOT_MODEL || "claude-sonnet-5.5";
/** The retired built-in default; a stored value equal to it was never a deliberate choice. */
const LEGACY_DEFAULT_MODEL = "claude-sonnet-5.5";
const LOG_DIR = process.env.COPILOT_LOG_DIR || path.join(os.homedir(), ".architecture-diagram-studio", "logs");
const LOG_FILE = path.join(LOG_DIR, "copilot-sessions.jsonl");
const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(os.homedir(), ".architecture-diagram-studio", "data");
const WORKSPACE_FILE = path.join(DATA_DIR, "workspace.json");
const VERSIONS_FILE = path.join(DATA_DIR, "diagram-versions.json");
const APP_LOG_FILE = path.join(DATA_DIR, "application-events.jsonl");
const PROJECT_WORKSPACE_FILE = path.join(DATA_DIR, "project-workspace.json");
const CONFIG_HISTORY_FILE = path.join(DATA_DIR, "studio-config-history.jsonl");
type StudioConfig = {
  schemaVersion: 1;
  revisionId: string;
  model: string;
  reasoningEffort: "high" | "max";
  updatedAt: string;
  updatedBy: string;
};
const DEFAULT_STUDIO_CONFIG: StudioConfig = {
  schemaVersion: 1, revisionId: "default", model: DEFAULT_MODEL, reasoningEffort: "max",
  updatedAt: new Date(0).toISOString(), updatedBy: "default"
};
let studioConfig: StudioConfig | null = null;

function parseConfigHistory(contents: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  let start = -1, depth = 0, inString = false, escaped = false;
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i];
    if (start < 0) {
      if (ch === "{") { start = i; depth = 1; inString = false; escaped = false; }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        const parsed: unknown = JSON.parse(contents.slice(start, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>);
      } catch { /* Ignore malformed historical records and keep any earlier valid snapshots. */ }
      start = -1;
    }
  }
  return records;
}

function isValidConfigHistoryRecord(record: Record<string, unknown>): boolean {
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) return false;
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length > 100)) return false;
  if (record.reasoningEffort !== undefined && record.reasoningEffort !== "high" && record.reasoningEffort !== "max") return false;
  return true;
}

async function getStudioConfig(): Promise<StudioConfig> {
  if (studioConfig) return studioConfig;
  const contents = await readFile(CONFIG_HISTORY_FILE, "utf8").catch((error) =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : Promise.reject(error));
  const records = parseConfigHistory(contents);
  for (let i = records.length - 1; i >= 0; i--) {
    const parsed = records[i];
    if (!isValidConfigHistoryRecord(parsed)) continue;
    studioConfig = {
      ...DEFAULT_STUDIO_CONFIG,
      revisionId: typeof parsed.revisionId === "string" ? parsed.revisionId :
        "legacy-" + (typeof parsed.updatedAt === "string" ? parsed.updatedAt.replace(/\D/g, "") : String(i)),
      model: typeof parsed.model === "string" ? parsed.model : DEFAULT_STUDIO_CONFIG.model,
      reasoningEffort: parsed.reasoningEffort === "high" ? "high" : "max",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : DEFAULT_STUDIO_CONFIG.updatedAt,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "legacy"
    };
    return adoptConfiguredModel(studioConfig);
  }
  studioConfig = { ...DEFAULT_STUDIO_CONFIG };
  return adoptConfiguredModel(studioConfig);
}

/** Replace the retired default only when a configured custom provider supplies a different model. */
async function adoptConfiguredModel(config: StudioConfig): Promise<StudioConfig> {
  const provider = readCopilotProvider();
  if (config.model !== LEGACY_DEFAULT_MODEL || provider.mode !== "byok" || !provider.model) return config;
  const migrated: StudioConfig = {
    ...config, revisionId: randomUUID(), model: provider.model,
    updatedAt: new Date().toISOString(), updatedBy: "migration"
  };
  await appendStudioConfig(migrated, "Adopt the model served by the configured custom provider");
  return migrated;
}

async function appendStudioConfig(config: StudioConfig, changeSummary: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(CONFIG_HISTORY_FILE, JSON.stringify({ ...config, changeSummary }) + "\n", "utf8");
  studioConfig = config;
}
let projectWorkspace: ProjectWorkspace | null | undefined;

async function getProjectWorkspace(): Promise<ProjectWorkspace | null> {
  if (projectWorkspace !== undefined) return projectWorkspace;
  const stored = await readJsonFile<ProjectWorkspace | null>(PROJECT_WORKSPACE_FILE, null);
  if (!stored || typeof stored.rootPath !== "string" || typeof stored.name !== "string" ||
      typeof stored.id !== "string" || (stored.primaryDiagram !== null && typeof stored.primaryDiagram !== "string")) {
    projectWorkspace = null;
    return projectWorkspace;
  }
  projectWorkspace = {
    schemaVersion: 1,
    id: stored.id,
    name: stored.name,
    rootPath: stored.rootPath,
    primaryDiagram: typeof stored.primaryDiagram === "string" ? stored.primaryDiagram : null,
    includePatterns: Array.isArray(stored.includePatterns) ? stored.includePatterns.filter((value): value is string => typeof value === "string") : [],
    excludePatterns: Array.isArray(stored.excludePatterns) ? stored.excludePatterns.filter((value): value is string => typeof value === "string") : [],
    createdAt: typeof stored.createdAt === "string" ? stored.createdAt : new Date(0).toISOString(),
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : new Date(0).toISOString()
  };
  return projectWorkspace;
}

const workspaceFileService = createWorkspaceFileService(getProjectWorkspace);
const { resolveWorkspaceRoot, scanWorkspaceFiles, resolveWorkspaceFile, collectAgentWorkspaceContext } = workspaceFileService;

/** Draw.io XML is the only persisted model; version entries contain metadata and the complete XML. */
type DiagramVersion = {
  id: string;
  workspaceId?: string;
  diagramPath?: string | null;
  createdAt: string;
  label: string;
  drawioXml: string;
};
type WorkspaceState = {
  workspaceId?: string;
  diagramPath?: string | null;
  drawioXml: string | null;
  copilotSessionId: string | null;
  chatMessages: unknown[];
  updatedAt: string | null;
};
type StoredDiagramVersion = Omit<DiagramVersion, "drawioXml"> & { drawioXml?: unknown; document?: unknown };
type StoredWorkspaceState = Partial<WorkspaceState> & { document?: unknown };

const withDataWrite = createSerializedWriteQueue();
let workspaceState: WorkspaceState | null = null;
let diagramVersions: DiagramVersion[] | null = null;
let diagramVersionsLoad: Promise<DiagramVersion[]> | null = null;

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function persistWorkspaceState(state: WorkspaceState | null = workspaceState): Promise<void> {
  if (state) await writeJsonAtomic(WORKSPACE_FILE, state);
}

async function persistDiagramVersions(versions: DiagramVersion[] = diagramVersions || []): Promise<void> {
  await writeJsonAtomic(VERSIONS_FILE, versions);
}

async function getWorkspaceState(): Promise<WorkspaceState> {
  if (!workspaceState) {
    const stored = await readJsonFile<StoredWorkspaceState>(WORKSPACE_FILE, {
      drawioXml: null, copilotSessionId: null, chatMessages: [], updatedAt: null
    });
    workspaceState = {
      ...(typeof stored.workspaceId === "string" ? { workspaceId: stored.workspaceId } : {}),
      ...(typeof stored.diagramPath === "string" || stored.diagramPath === null ? { diagramPath: stored.diagramPath } : {}),
      drawioXml: typeof stored.drawioXml === "string" ? stored.drawioXml : null,
      copilotSessionId: typeof stored.copilotSessionId === "string" ? stored.copilotSessionId : null,
      chatMessages: Array.isArray(stored.chatMessages) ? stored.chatMessages : [],
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : null
    };
    // Discard the obsolete persisted projection field the first time XML-only state is written.
    if (Object.prototype.hasOwnProperty.call(stored, "document")) await persistWorkspaceState(workspaceState);
  }

  if (typeof workspaceState.drawioXml !== "string") {
    const activeWorkspace = await getProjectWorkspace();
    if (activeWorkspace?.primaryDiagram && /\.(?:drawio|dio|xml)$/i.test(activeWorkspace.primaryDiagram)) {
      try {
        const { absolutePath } = await resolveWorkspaceFile(activeWorkspace.primaryDiagram);
        const sourceXml = await readFile(absolutePath, "utf8");
        if (validateDrawioXmlDocument(sourceXml).success) {
          workspaceState = {
            ...workspaceState,
            workspaceId: activeWorkspace.id,
            diagramPath: activeWorkspace.primaryDiagram,
            drawioXml: sourceXml
          };
          await persistWorkspaceState(workspaceState);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return workspaceState;
}

const MAX_VERSIONS_PER_WORKSPACE = Math.min(500, Math.max(10, Number(process.env.STUDIO_MAX_DIAGRAM_VERSIONS_PER_WORKSPACE) || 100));
const MAX_TOTAL_DIAGRAM_VERSIONS = Math.min(5000, Math.max(100, Number(process.env.STUDIO_MAX_TOTAL_DIAGRAM_VERSIONS) || 500));
function retainRecentVersions(versions: DiagramVersion[]): DiagramVersion[] {
  return retainVersionsWithinLimit(versions, MAX_VERSIONS_PER_WORKSPACE, MAX_TOTAL_DIAGRAM_VERSIONS);
}
function versionMatchesActiveDiagram(version: DiagramVersion, workspace: ProjectWorkspace | null): boolean {
  const activePath = workspace?.primaryDiagram ?? null;
  return (!workspace || version.workspaceId === workspace.id) &&
    (version.diagramPath === undefined || version.diagramPath === activePath);
}
function workspaceStateMatchesActiveDiagram(state: WorkspaceState, workspace: ProjectWorkspace | null): boolean {
  if (state.workspaceId && workspace && state.workspaceId !== workspace.id) return false;
  if (workspace?.primaryDiagram && !state.workspaceId) return false;
  if (state.diagramPath !== undefined && workspace && state.diagramPath !== (workspace.primaryDiagram ?? null)) return false;
  return true;
}

async function getDiagramVersions(): Promise<DiagramVersion[]> {
  if (diagramVersions) return diagramVersions;
  if (!diagramVersionsLoad) {
    diagramVersionsLoad = (async () => {
      const stored = await readJsonFile<StoredDiagramVersion[]>(VERSIONS_FILE, []);
      const hydrated: DiagramVersion[] = [];
      let migrated = false;
      for (const item of stored) {
        const xml = typeof item.drawioXml === "string" ? item.drawioXml : null;
        // Old semantic-only snapshots cannot be restored faithfully; do not regenerate native XML from them.
        if (xml === null || Buffer.byteLength(xml, "utf8") > 20_000_000 || !validateDrawioXmlDocument(xml).success) {
          migrated = true;
          continue;
        }
        hydrated.push({
          id: item.id,
          ...(typeof item.workspaceId === "string" ? { workspaceId: item.workspaceId } : {}),
          ...(typeof item.diagramPath === "string" || item.diagramPath === null ? { diagramPath: item.diagramPath } : {}),
          createdAt: item.createdAt,
          label: item.label,
          drawioXml: xml
        });
        if (Object.prototype.hasOwnProperty.call(item, "document")) migrated = true;
      }
      const retained = retainRecentVersions(hydrated);
      if (retained.length !== stored.length) migrated = true;
      if (migrated) await persistDiagramVersions(retained);
      return retained;
    })().catch((error) => {
      diagramVersionsLoad = null;
      throw error;
    });
  }
  diagramVersions = await diagramVersionsLoad;
  return diagramVersions;
}
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/workspace") && !req.path.startsWith("/api/copilot")) { next(); return; }
  const source = req.get("origin") || req.get("referer");
  if (!source) { next(); return; }
  try {
    const hostname = new URL(source).hostname.toLowerCase();
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) { res.status(403).json({ error: "The Studio API only accepts same-host browser origins" }); return; }
    next();
  } catch {
    res.status(403).json({ error: "Invalid request origin" });
  }
});
let logWriteQueue: Promise<void> = Promise.resolve();

function logPrefixForEvent(event: string): string {
  if (event.startsWith("layout.")) return "[studio:layout]";
  if (event.startsWith("diagram.")) return "[studio:diagram]";
  if (event.startsWith("workspace.") || event.startsWith("settings.") || event.startsWith("project.")) return "[studio:workspace]";
  if (event.startsWith("client.") || event.startsWith("session.") || event.startsWith("sdk.") ||
      event.startsWith("request.") || event.startsWith("turn.") || event.startsWith("tool.")) return "[studio:ai]";
  return "[studio:server]";
}

async function writeLog(event: string, fields: Record<string, unknown> = {}): Promise<void> {
  const record = { timestamp: new Date().toISOString(), workspaceId: projectWorkspace?.id ?? null, event, ...fields };
  const line = JSON.stringify(record) + "\n";
  const persist = logWriteQueue.then(async () => {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, line, "utf8");
  });
  logWriteQueue = persist.catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error("\n\u001b[1;31m[studio:ERROR] failed to persist server log\u001b[0m\n" + message + "\n");
  });
  await logWriteQueue;

  // Keep the JSONL audit trail complete, but reserve the terminal for actionable warnings
  // and errors. Set STUDIO_LOG_LEVEL=info to opt into routine lifecycle events.
  const isError = event.endsWith(".failed") || event.endsWith(".error") || event.endsWith(".fatal");
  const isWarning = event.endsWith(".conflict") || event.endsWith(".rejected") || event.endsWith(".warning");
  if (isError) {
    const detail = typeof fields.stack === "string" ? fields.stack : JSON.stringify(record, null, 2);
    console.error("\n\u001b[1;31m[studio:ERROR] " + event + "\u001b[0m\n" + detail + "\n");
  } else if (isWarning) {
    console.warn("\u001b[1;33m[studio:WARN] " + event + "\u001b[0m " + JSON.stringify(record));
  } else if (process.env.STUDIO_LOG_LEVEL === "info") {
    console.info(logPrefixForEvent(event) + " " + JSON.stringify(record));
  }
}

const SESSION_IDLE_TTL_MS = Number(process.env.COPILOT_SESSION_IDLE_TTL_MS || 30 * 60 * 1000);
const copilot = new CopilotRuntime({ log: writeLog, defaultModel: DEFAULT_MODEL, idleTtlMs: SESSION_IDLE_TTL_MS });



app.get("/api/workspace/config", async (_req, res) => {
  try {
    const workspace = await getProjectWorkspace();
    const suggestedRootPath = path.resolve(process.cwd(), path.basename(process.cwd()) === "v2" ? ".." : ".");
    res.json({ configured: Boolean(workspace), workspace, suggestedRootPath });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/workspace/scan", async (req, res) => {
  try {
    const requestedRoot = typeof req.body?.rootPath === "string" ? req.body.rootPath.trim() : "";
    const requestedName = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    if (!requestedRoot || requestedRoot.length > 2048) throw new Error("The local workspace directory path cannot be empty");
    if (!requestedName) throw new Error("Workspace name cannot be empty");
    const resolved = await resolveWorkspaceRoot(requestedRoot);
    const previous = await getProjectWorkspace();
    const sameRoot = previous?.rootPath === resolved.rootPath;
    const now = new Date().toISOString();
    const workspace: ProjectWorkspace = {
      schemaVersion: 1,
      id: sameRoot && previous ? previous.id : randomUUID(),
      name: resolved.repositoryRoot ? path.basename(resolved.rootPath) : requestedName,
      rootPath: resolved.rootPath,
      primaryDiagram: sameRoot && previous ? previous.primaryDiagram : null,
      includePatterns: sameRoot && previous ? previous.includePatterns : [],
      excludePatterns: sameRoot && previous ? previous.excludePatterns : [],
      createdAt: sameRoot && previous ? previous.createdAt : now,
      updatedAt: now
    };
    const files = await scanWorkspaceFiles(workspace);
    res.json({ workspace, files, rootAdjusted: resolved.requestedPath !== resolved.rootPath, repositoryRoot: resolved.repositoryRoot });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/workspace/config", async (req, res) => {
  try {
    const requestedRoot = typeof req.body?.rootPath === "string" ? req.body.rootPath.trim() : "";
    const requestedName = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    const requestedDiagram = typeof req.body?.primaryDiagram === "string" ? req.body.primaryDiagram.trim() : "";
    if (!requestedRoot || requestedRoot.length > 2048) throw new Error("The local workspace directory path cannot be empty");
    if (!requestedName) throw new Error("Workspace name cannot be empty");
    if (!requestedDiagram || path.isAbsolute(requestedDiagram) || requestedDiagram.split(/[\\/]/).some((part: string) => part === "..") ||
        !/\.(?:drawio|dio|xml)$/i.test(requestedDiagram)) {
      throw new Error("Select an existing .drawio, .dio, or XML diagram inside the workspace");
    }
    const resolved = await resolveWorkspaceRoot(requestedRoot);
    const previous = await getProjectWorkspace();
    const sameRoot = previous?.rootPath === resolved.rootPath;
    const now = new Date().toISOString();
    const workspace: ProjectWorkspace = {
      schemaVersion: 1,
      id: sameRoot && previous ? previous.id : randomUUID(),
      name: resolved.repositoryRoot ? path.basename(resolved.rootPath) : requestedName,
      rootPath: resolved.rootPath,
      primaryDiagram: requestedDiagram.replace(/\\/g, "/"),
      includePatterns: sameRoot && previous ? previous.includePatterns : [],
      excludePatterns: sameRoot && previous ? previous.excludePatterns : [],
      createdAt: sameRoot && previous ? previous.createdAt : now,
      updatedAt: now
    };
    const files = await scanWorkspaceFiles(workspace);
    const selected = files.find((file) => file.path === workspace.primaryDiagram);
    if (!selected || selected.kind !== "diagram" || !/\.(?:drawio|dio|xml)$/i.test(selected.path)) {
      throw new Error("The selected diagram was not found inside the scanned workspace");
    }
    const contextChanged = !previous || previous.id !== workspace.id || previous.primaryDiagram !== workspace.primaryDiagram;
    projectWorkspace = workspace;
    await writeJsonAtomic(PROJECT_WORKSPACE_FILE, workspace);
    if (contextChanged) {
      workspaceState = {
        workspaceId: workspace.id, diagramPath: workspace.primaryDiagram, drawioXml: null,
        copilotSessionId: null, chatMessages: [], updatedAt: now
      };
      await persistWorkspaceState(workspaceState);
      // Load the newly selected file into the XML-only state so its optimistic revision matches
      // the on-disk file before the browser's next autosave.
      await getWorkspaceState();
    }
    const activeState = await getWorkspaceState();
    await writeLog("workspace.config.saved", {
      workspaceId: workspace.id, primaryDiagram: workspace.primaryDiagram, contextChanged,
      fileCount: files.length
    });
    res.json({
      configured: true, workspace,
      workspaceRevision: typeof activeState.drawioXml === "string" ? workspaceRevision(activeState.drawioXml) : null,
      files,
      counts: {
        files: files.length, diagrams: files.filter((file) => file.kind === "diagram").length,
        code: files.filter((file) => file.kind === "code").length,
        documents: files.filter((file) => file.kind === "document").length
      },
      rootAdjusted: resolved.requestedPath !== resolved.rootPath, repositoryRoot: resolved.repositoryRoot
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/workspace/configuration", async (_req, res) => {
  const config = await getStudioConfig();
  const contents = await readFile(CONFIG_HISTORY_FILE, "utf8").catch((error) =>
    (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : Promise.reject(error)
  );
  res.json({ config, revisions: parseConfigHistory(contents).length });
});

app.get("/api/workspace/configuration/history", async (_req, res) => {
  try {
    const text = await readFile(CONFIG_HISTORY_FILE, "utf8").catch((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : Promise.reject(error));
    res.json({ revisions: parseConfigHistory(text).filter(isValidConfigHistoryRecord).map((item) => ({
      revisionId: item.revisionId, updatedAt: item.updatedAt, updatedBy: item.updatedBy,
      changeSummary: item.changeSummary, model: item.model, reasoningEffort: item.reasoningEffort
    })) });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.put("/api/workspace/configuration", async (req, res) => {
  try {
    const input = req.body?.config;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      res.status(400).json({ error: "The config must be a JSON object" }); return;
    }
    const previous = await getStudioConfig();
    const model = input.model === undefined ? previous.model : input.model;
    const reasoningEffort = input.reasoningEffort === undefined ? previous.reasoningEffort : input.reasoningEffort;
    if (typeof model !== "string" || model.length > 100 || !["high", "max"].includes(reasoningEffort)) {
      res.status(400).json({ error: "The model id must stay under 100 characters and reasoning effort must be high or max" });
      return;
    }
    const config: StudioConfig = {
      schemaVersion: 1, revisionId: randomUUID(), model: model.trim(), reasoningEffort,
      updatedAt: new Date().toISOString(), updatedBy: "user"
    };
    await withDataWrite(async () => appendStudioConfig(config, "Update runtime model and reasoning effort"));
    await writeLog("settings.configuration.saved", {
      revisionId: config.revisionId, model: config.model || "server-default",
      reasoningEffort: config.reasoningEffort, previousRevisionId: previous.revisionId
    });
    res.json({ config, saved: true });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.post("/api/workspace/diagram/create", async (req, res) => {
  const requestedRoot = typeof req.body?.rootPath === "string" ? req.body.rootPath.trim() : "";
  const requestedName = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
  let fileName: string;
  try { fileName = normalizeNewDrawioFileName(typeof req.body?.fileName === "string" ? req.body.fileName : ""); }
  catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); return; }
  if (!requestedRoot || requestedRoot.length > 2048) { res.status(400).json({ error: "The local workspace directory path cannot be empty" }); return; }
  if (!requestedName) { res.status(400).json({ error: "Workspace name cannot be empty" }); return; }
  let createdPath: string | null = null, createdFileReady = false;
  let activeHandle: Awaited<ReturnType<typeof open>> | null = null;
  // Control-flow analysis narrows the variable to null inside the catch, because the last write in
  // the try block clears it; the closure reads the declared type instead.
  const releaseActiveHandle = async () => {
    const handle = activeHandle;
    activeHandle = null;
    if (handle) await handle.close().catch(() => undefined);
  };
  try {
    const resolved = await resolveWorkspaceRoot(requestedRoot), rootPath = resolved.rootPath;
    const xml = createEmptyDrawioXml(fileName);
    if (!validateDrawioXmlDocument(xml).success) throw new Error("Could not create a valid empty Draw.io file.");
    const result = await withDataWrite(async () => {
      const previous = await getProjectWorkspace(), sameRoot = previous?.rootPath === rootPath;
      const now = new Date().toISOString();
      const workspace: ProjectWorkspace = {
        schemaVersion: 1, id: sameRoot && previous ? previous.id : randomUUID(),
        name: resolved.repositoryRoot ? path.basename(rootPath) : requestedName, rootPath, primaryDiagram: fileName,
        includePatterns: sameRoot && previous ? previous.includePatterns : [],
        excludePatterns: sameRoot && previous ? previous.excludePatterns : [],
        createdAt: sameRoot && previous ? previous.createdAt : now, updatedAt: now
      };
      const targetPath = path.join(rootPath, fileName);
      activeHandle = await open(targetPath, "wx", 0o644);
      createdPath = targetPath;
      await activeHandle.writeFile(xml, "utf8");
      await activeHandle.close(); activeHandle = null;
      createdFileReady = true;
      const files = await scanWorkspaceFiles(workspace);
      let versions = await getDiagramVersions();
      if (sameRoot && previous && previous.primaryDiagram !== workspace.primaryDiagram) {
        let migratedLegacyVersions = false;
        versions = versions.map((version) => {
          if (version.workspaceId === workspace.id && version.diagramPath === undefined) {
            migratedLegacyVersions = true;
            return { ...version, diagramPath: previous.primaryDiagram ?? null };
          }
          return version;
        });
        if (migratedLegacyVersions) await persistDiagramVersions(versions);
      }
      const version: DiagramVersion = {
        id: "v-" + Date.now() + "-" + randomUUID().slice(0, 8),
        workspaceId: workspace.id, diagramPath: workspace.primaryDiagram,
        createdAt: now, label: "Created diagram: " + fileName, drawioXml: xml
      };
      diagramVersions = retainRecentVersions([...versions, version]);
      await persistDiagramVersions(diagramVersions);
      projectWorkspace = workspace;
      await writeJsonAtomic(PROJECT_WORKSPACE_FILE, workspace);
      workspaceState = {
        workspaceId: workspace.id, diagramPath: workspace.primaryDiagram, drawioXml: xml,
        copilotSessionId: null, chatMessages: [], updatedAt: now
      };
      await persistWorkspaceState(workspaceState);
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(APP_LOG_FILE, JSON.stringify({
        timestamp: now, event: "diagram.file.created", workspaceId: workspace.id, diagramPath: fileName,
        versionId: version.id, xmlLength: xml.length
      }) + "\n", "utf8");
      return {
        workspace, files, drawioXml: xml,
        version: { id: version.id, createdAt: version.createdAt, label: version.label },
        workspaceRevision: workspaceRevision(xml),
        counts: { files: files.length, diagrams: files.filter((file) => file.kind === "diagram").length, code: files.filter((file) => file.kind === "code").length, documents: files.filter((file) => file.kind === "document").length }
      };
    });
    await writeLog("diagram.file.created", { workspaceId: result.workspace.id, diagramPath: fileName, versionId: result.version.id });
    res.status(201).json({ ok: true, ...result, rootAdjusted: resolved.requestedPath !== rootPath, repositoryRoot: resolved.repositoryRoot });
  } catch (error) {
    await releaseActiveHandle();
    if (createdPath && !createdFileReady) await unlink(createdPath).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") { res.status(409).json({ error: "That Draw.io file already exists; choose a different file name." }); return; }
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/api/workspace/files", async (_req, res) => { try { const workspace = await getProjectWorkspace(); if (!workspace) { res.status(409).json({ error: "Configure a project workspace first" }); return; } const files = await scanWorkspaceFiles(workspace); res.json({ workspaceId: workspace.id, files, counts: { files: files.length, diagrams: files.filter((f) => f.kind === "diagram").length, code: files.filter((f) => f.kind === "code").length, documents: files.filter((f) => f.kind === "document").length } }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/workspace/files/content", async (req, res) => { try { const relativePath = typeof req.query.path === "string" ? req.query.path : ""; const { workspace, absolutePath } = await resolveWorkspaceFile(relativePath); const info = await stat(absolutePath); const maxBytes = /\.(drawio|dio|xml)$/i.test(relativePath) ? 20 * 1024 * 1024 : 1024 * 1024; if (info.size > maxBytes) { res.status(413).json({ error: "File exceeds the readable limit (" + Math.round(maxBytes / 1024 / 1024) + " MiB)" }); return; } const content = await readFile(absolutePath, "utf8"); await writeLog("workspace.file.read", { workspaceId: workspace.id, path: relativePath, bytes: info.size }); res.json({ workspaceId: workspace.id, path: relativePath, content, size: info.size }); } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); } });
app.get("/api/workspace/agent-context", async (_req, res) => { try { const workspace = await getProjectWorkspace(); if (!workspace) { res.status(409).json({ error: "Configure a project workspace first" }); return; } const files = await scanWorkspaceFiles(workspace); const relevant = [...files.filter((f) => f.kind === "diagram").sort((a, b) => (a.path === workspace.primaryDiagram ? -1 : b.path === workspace.primaryDiagram ? 1 : 0)), ...files.filter((f) => f.kind === "code").slice(0, 100), ...files.filter((f) => f.kind === "document").slice(0, 100)].slice(0, 250); const snippets: Array<{path:string;kind:string;content:string;truncated:boolean}> = []; let budget = 120000; for (const item of relevant) { if (budget <= 0) break; if (item.size > (item.kind === "diagram" ? 20 * 1024 * 1024 : 512 * 1024) || item.kind === "other") continue; if ([".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".lock"].includes(path.extname(item.path).toLowerCase())) continue; const content = await resolveWorkspaceFile(item.path).then(({ absolutePath }) => readFile(absolutePath, "utf8")).catch(() => ""); const excerpt = content.slice(0, Math.min(content.length, budget, item.kind === "diagram" ? 24000 : 6000)); if (excerpt) { snippets.push({ path: item.path, kind: item.kind, content: excerpt, truncated: excerpt.length < content.length }); budget -= excerpt.length; } } res.json({ workspace: { id: workspace.id, name: workspace.name, rootPath: workspace.rootPath, primaryDiagram: workspace.primaryDiagram }, files: relevant.map(({path: filePath, kind, size}) => ({ path: filePath, kind, size })), snippets }); } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); } });

app.get("/api/workspace/state", async (_req, res) => {
  try {
    const state = await getWorkspaceState();
    const workspace = await getProjectWorkspace();
    const belongsToWorkspace = workspaceStateMatchesActiveDiagram(state, workspace);
    const visibleState = belongsToWorkspace ? state : { ...state, drawioXml: null, copilotSessionId: null, chatMessages: [], updatedAt: null };
    const versions = (await getDiagramVersions()).filter((version) => versionMatchesActiveDiagram(version, workspace));
    const latest = versions[versions.length - 1];
    res.json({ ...visibleState, workspaceMismatch: !belongsToWorkspace, workspaceRevision: typeof visibleState.drawioXml === "string" ? workspaceRevision(visibleState.drawioXml) : null, projectWorkspace: workspace, versionCount: versions.length, latestVersion: latest ? { id: latest.id, createdAt: latest.createdAt, label: latest.label } : null });
  } catch (error) {
    await writeLog("workspace.state.read.failed", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Could not read the server workspace data" });
  }
});

app.put("/api/workspace/document", async (req, res) => {
  const drawioXml = req.body?.drawioXml;
  const label = typeof req.body?.label === "string" ? req.body.label.slice(0, 300) : "Document autosave";
  const baseRevision = typeof req.body?.baseRevision === "string" ? req.body.baseRevision : req.body?.baseRevision === null ? null : undefined;
  if (typeof drawioXml !== "string" || Buffer.byteLength(drawioXml, "utf8") > 20_000_000) {
    res.status(400).json({ error: "Invalid Draw.io XML document or the XML exceeds 20 MB" });
    return;
  }
  const validation = validateDrawioXmlDocument(drawioXml);
  if (!validation.success) {
    res.status(400).json({ error: "The Draw.io XML does not match the supported XML document schema." });
    return;
  }
  try {
    const result = await withDataWrite(async () => {
      const state = await getWorkspaceState();
      const workspace = await getProjectWorkspace();
      const allVersions = await getDiagramVersions();
      const activeStateMatches = state.workspaceId === workspace?.id && state.diagramPath === (workspace?.primaryDiagram ?? null);
      const workspaceVersions = allVersions.filter((version) => versionMatchesActiveDiagram(version, workspace));
      // A null revision is valid only for a genuinely empty initial state. If the configured
      // workspace changed while an older XML document is still in memory, null === null must
      // not authorize writing that stale document into the new workspace's primary diagram.
      if (!isWorkspaceSaveContextCompatible(activeStateMatches, Boolean(workspace?.primaryDiagram), typeof state.drawioXml === "string", baseRevision)) {
        return { status: 409 as const, error: "The active workspace or primary diagram changed. Reload the current Draw.io XML before saving.", workspaceRevision: null };
      }
      const currentRevision = activeStateMatches && typeof state.drawioXml === "string" ? workspaceRevision(state.drawioXml) : null;
      if (!matchesWorkspaceRevision(baseRevision, currentRevision)) return { status: 409 as const, error: "The document changed or the save is missing its base revision. Reload the latest version before saving.", workspaceRevision: currentRevision };
      const unchanged = activeStateMatches && state.drawioXml === drawioXml;
      if (!unchanged) {
        const version: DiagramVersion = {
          id: "v-" + Date.now() + "-" + randomUUID().slice(0, 8),
          workspaceId: workspace?.id,
          diagramPath: workspace?.primaryDiagram ?? null,
          createdAt: new Date().toISOString(),
          label,
          drawioXml
        };
        diagramVersions = retainRecentVersions([...allVersions, version]);
        await persistDiagramVersions(diagramVersions);
        if (workspace?.primaryDiagram && /\.(drawio|dio|xml)$/i.test(workspace.primaryDiagram)) {
          const { absolutePath } = await resolveWorkspaceFile(workspace.primaryDiagram, { allowMissingFile: true });
          await writeTextAtomic(absolutePath, drawioXml);
          await writeLog("workspace.primary-diagram.saved", { workspaceId: workspace.id, path: workspace.primaryDiagram, xmlLength: drawioXml.length, versionId: version.id });
        }
        workspaceState = { ...state, workspaceId: workspace?.id, diagramPath: workspace?.primaryDiagram ?? null, drawioXml, updatedAt: version.createdAt };
        await persistWorkspaceState(workspaceState);
        await appendFile(APP_LOG_FILE, JSON.stringify({
          timestamp: version.createdAt, event: "diagram.version.created", workspaceId: workspace?.id,
          versionId: version.id, label, xmlLength: drawioXml.length
        }) + "\n", "utf8");
        return { status: 200 as const, saved: true, version, workspaceRevision: workspaceRevision(drawioXml) };
      }
      return { status: 200 as const, saved: false, version: workspaceVersions[workspaceVersions.length - 1] ?? null, workspaceRevision: currentRevision };
    });
    if (result.status === 409) { res.status(409).json(result); return; }
    res.json({ ok: true, ...result });
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    const errorCode = (error as NodeJS.ErrnoException | undefined)?.code;
    const workspace = await getProjectWorkspace().catch(() => null);
    await writeLog("workspace.document.save.failed", {
      message: cause.message,
      errorName: cause.name,
      errorCode: errorCode ?? null,
      stack: cause.stack ?? null,
      workspaceId: workspace?.id ?? null,
      workspaceRoot: workspace?.rootPath ?? null,
      primaryDiagram: workspace?.primaryDiagram ?? null,
      label,
      xmlLength: drawioXml.length,
      baseRevision: baseRevision ?? null
    });
    // Return the actual failure reason to the caller; a generic 500 hid the actionable cause.
    res.status(500).json({
      error: "Saving the document/Draw.io version on the server failed: " + cause.message,
      code: errorCode ?? null
    });
  }
});
app.put("/api/workspace/chat", async (req, res) => {
  const copilotSessionId = typeof req.body?.copilotSessionId === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(req.body.copilotSessionId)
    ? req.body.copilotSessionId : null;
  const chatMessages = Array.isArray(req.body?.chatMessages) ? req.body.chatMessages.slice(-2000) : [];
  if (chatMessages.some((item: unknown) => !item || typeof item !== "object" ||
    !["assistant", "user"].includes(String((item as { role?: unknown }).role)) ||
    typeof (item as { text?: unknown }).text !== "string" ||
    typeof (item as { id?: unknown }).id !== "number")) {
    res.status(400).json({ error: "Invalid chatMessages format" });
    return;
  }
  try {
    await withDataWrite(async () => {
      const state = await getWorkspaceState();
      workspaceState = { ...state, workspaceId: (await getProjectWorkspace())?.id, copilotSessionId: copilotSessionId ?? state.copilotSessionId, chatMessages, updatedAt: new Date().toISOString() };
      await persistWorkspaceState(workspaceState);
      await appendFile(APP_LOG_FILE, JSON.stringify({
        timestamp: new Date().toISOString(), event: "copilot.chat.persisted",
        sessionId: workspaceState.copilotSessionId, messageCount: chatMessages.length
      }) + "\n", "utf8");
    });
    res.json({ ok: true, copilotSessionId, messageCount: chatMessages.length });
  } catch (error) {
    await writeLog("workspace.chat.save.failed", { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Saving the Copilot conversation on the server failed" });
  }
});

app.post("/api/workspace/logs", async (req, res) => {
  const item = req.body;
  if (!item || typeof item !== "object" || typeof item.event !== "string" || typeof item.message !== "string") {
    res.status(400).json({ error: "Invalid log event format" });
    return;
  }
  try {
    const record = {
      receivedAt: new Date().toISOString(),
      workspaceId: projectWorkspace?.id ?? null,
      id: typeof item.id === "string" ? item.id.slice(0, 100) : randomUUID(),
      clientTimestamp: typeof item.timestamp === "string" ? item.timestamp.slice(0, 50) : null,
      level: ["debug", "info", "warn", "error"].includes(item.level) ? item.level : "info",
      event: item.event.slice(0, 150),
      message: item.message.slice(0, 1000),
      details: item.details && typeof item.details === "object" ? item.details : {}
    };
    await withDataWrite(async () => { await mkdir(DATA_DIR, { recursive: true }); await appendFile(APP_LOG_FILE, JSON.stringify(record) + "\n", "utf8"); });
    res.status(204).end();
  } catch (error) {
    console.error("[studio:server] failed to persist application log", error);
    res.status(500).json({ error: "Could not persist the app log" });
  }
});

app.get("/api/workspace/logs", async (req, res) => {
  try {
    const [appRaw, agentRaw] = await Promise.all([
      readFile(APP_LOG_FILE, "utf8").catch(() => ""),
      readFile(LOG_FILE, "utf8").catch(() => "")
    ]);
    const workspace = await getProjectWorkspace();
    const limit = Math.min(10000, Math.max(1, Number(req.query.limit) || 2000));
    const appLogs = appRaw.split("\n").filter(Boolean).flatMap((line) => {
      try { const entry = JSON.parse(line) as Record<string, unknown>; return !workspace || entry.workspaceId === workspace.id ? [entry] : []; } catch { return []; }
    });
    const agentLogs = agentRaw.split("\n").filter(Boolean).flatMap((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (workspace && entry.workspaceId !== workspace.id) return [];
        const { timestamp, workspaceId, event, ...details } = entry;
        return [{
          id: "agent:" + String(entry.requestId || entry.sessionId || timestamp || "") + ":" + String(event || "event") + ":" + line.length,
          receivedAt: timestamp || new Date(0).toISOString(),
          clientTimestamp: timestamp || null,
          workspaceId: workspaceId ?? null,
          level: String(event || "").endsWith(".failed") || String(event || "").endsWith(".error") ? "error" : "info",
          event: typeof event === "string" ? event : "agent.event",
          message: typeof event === "string" ? event : "Copilot agent event",
          details
        }];
      } catch { return []; }
    });
    const logs = [...appLogs, ...agentLogs].sort((a, b) =>
      new Date(String(a.clientTimestamp || a.receivedAt || 0)).getTime() - new Date(String(b.clientTimestamp || b.receivedAt || 0)).getTime()
    ).slice(-limit);
    res.json({ logs, logFile: APP_LOG_FILE, agentLogFile: LOG_FILE, workspaceId: workspace?.id ?? null });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/workspace/versions", async (_req, res) => {
  try {
    const workspace = await getProjectWorkspace();
    const versions = (await getDiagramVersions()).filter((version) => versionMatchesActiveDiagram(version, workspace));
    res.json({ versions: versions.map(({ id, createdAt, label, diagramPath }) => ({
      id, createdAt, label, documentId: null,
      title: diagramPath?.split(/[\\/]/).pop() || "Draw.io diagram"
    })) });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});
app.get("/api/workspace/versions/:id", async (req, res) => {
  try {
    const workspace = await getProjectWorkspace();
    const version = (await getDiagramVersions()).find((item) => item.id === req.params.id && versionMatchesActiveDiagram(item, workspace));
    if (!version) { res.status(404).json({ error: "Version not found" }); return; }
    res.json({ version: req.query.includeXml === "false" ? { id: version.id, workspaceId: version.workspaceId, diagramPath: version.diagramPath, createdAt: version.createdAt, label: version.label } : version });
  } catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post("/api/workspace/versions/:id/restore", async (req, res) => {
  try {
    const result = await withDataWrite(async () => {
      const versions = await getDiagramVersions();
      const workspace = await getProjectWorkspace();
      const source = versions.find((item) => item.id === req.params.id && versionMatchesActiveDiagram(item, workspace));
      if (!source) return null;
      const state = await getWorkspaceState();
      const version: DiagramVersion = {
        id: "v-" + Date.now() + "-" + randomUUID().slice(0, 8),
        workspaceId: workspace?.id,
        diagramPath: workspace?.primaryDiagram ?? null,
        createdAt: new Date().toISOString(),
        label: "Restored version: " + source.label,
        drawioXml: source.drawioXml
      };
      diagramVersions = retainRecentVersions([...versions, version]);
      await persistDiagramVersions(diagramVersions);
      if (workspace?.primaryDiagram && /\.(drawio|dio|xml)$/i.test(workspace.primaryDiagram)) {
        const { absolutePath } = await resolveWorkspaceFile(workspace.primaryDiagram, { allowMissingFile: true });
        await writeTextAtomic(absolutePath, version.drawioXml);
      }
      workspaceState = { ...state, workspaceId: workspace?.id, diagramPath: workspace?.primaryDiagram ?? null, drawioXml: version.drawioXml, updatedAt: version.createdAt };
      await persistWorkspaceState(workspaceState);
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(APP_LOG_FILE, JSON.stringify({
        timestamp: version.createdAt, event: "diagram.version.restored",
        sourceVersionId: source.id, versionId: version.id, label: version.label,
        xmlLength: version.drawioXml.length
      }) + "\n", "utf8");
      return { version, state: workspaceState };
    });
    if (!result) { res.status(404).json({ error: "The version does not exist or its Draw.io XML is invalid" }); return; }
    if (req.query.includeXml === "false") {
      const version = { ...result.version };
      const state = { ...result.state };
      delete (version as Partial<DiagramVersion>).drawioXml;
      delete (state as Partial<WorkspaceState>).drawioXml;
      res.json({ ok: true, version, state, workspaceRevision: workspaceRevision(result.version.drawioXml) });
    } else res.json({ ok: true, ...result, workspaceRevision: workspaceRevision(result.version.drawioXml) });
  } catch (error) {
    await writeLog("workspace.version.restore.failed", { versionId: req.params.id, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: "Restoring the server version failed" });
  }
});

app.get("/api/copilot/health", async (_req, res) => {
  const health = await copilot.health();
  res.json({ ok: true, provider: "github-copilot-sdk", defaultModel: DEFAULT_MODEL, modelRouting: modelRoutingView(), ...health });
});

/** Routing state the settings UI needs to explain which model a turn will really use. */
function modelRoutingView() {
  const provider = readCopilotProvider();
  return {
    mode: provider.mode,
    host: provider.host ?? null,
    configuredModel: provider.model ?? null,
    summary: describeModelRouting(provider),
    // A model with no provider to serve it is the trap: it looks configured and routes to GitHub.
    modelConfiguredWithoutProvider: isModelConfiguredWithoutProvider(provider)
  };
}

app.get("/api/copilot/models", async (req, res) => {
  try {
    // A custom provider publishes no catalog: the runtime serves exactly the model it was configured
    // with, so that is the whole list. Otherwise the SDK answers with an empty list until entitlements
    // resolve; `refresh` rebuilds the client so the user can retry after fixing an account or quota
    // problem without restarting the studio server.
    const provider = readCopilotProvider();
    const models = provider.mode === "byok"
      ? (provider.model ? [{ id: provider.model, name: provider.model, supportedReasoningEfforts: [], defaultReasoningEffort: undefined }] : [])
      : (await copilot.listModels({ refresh: req.query.refresh === "1" })).map((model) => ({
          id: model.id,
          name: model.name,
          supportedReasoningEfforts: model.supportedReasoningEfforts || [],
          defaultReasoningEffort: model.defaultReasoningEffort
        }));
    res.json({
      defaultModel: provider.mode === "byok" && provider.model ? provider.model : DEFAULT_MODEL,
      modelRouting: modelRoutingView(),
      models: models.map((model) => ({
        ...model,
        label: model.name && model.name !== model.id ? model.name + " (" + model.id + ")" : model.id
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: "Could not list models from the Copilot SDK: " + message.slice(0, 300) });
  }
});

registerCopilotIntentRoute(app, {
  copilot, defaultModel: DEFAULT_MODEL, writeLog,
  getStudioConfig, getProjectWorkspace, collectAgentWorkspaceContext,
  getWorkspaceDiagramSnapshot: async () => {
    const state = await getWorkspaceState();
    const workspace = await getProjectWorkspace();
    if (!workspaceStateMatchesActiveDiagram(state, workspace) || typeof state.drawioXml !== "string") return null;
    const revision = workspaceRevision(state.drawioXml);
    const versions = (await getDiagramVersions()).filter((version) =>
      versionMatchesActiveDiagram(version, workspace) && workspaceRevision(version.drawioXml) === revision
    );
    const currentVersion = versions[versions.length - 1] ?? null;
    return { drawioXml: state.drawioXml, revision, versionId: currentVersion?.id ?? null };
  },
  getWorkspaceVersionSnapshot: async (versionId: string) => {
    const workspace = await getProjectWorkspace();
    const version = (await getDiagramVersions()).find((item) =>
      item.id === versionId && versionMatchesActiveDiagram(item, workspace)
    );
    return version ? { drawioXml: version.drawioXml, revision: workspaceRevision(version.drawioXml), versionId: version.id } : null;
  },
  persistSessionId: async (sessionId) => withDataWrite(async () => {
    const state = await getWorkspaceState();
    workspaceState = { ...state, workspaceId: (await getProjectWorkspace())?.id, copilotSessionId: sessionId, updatedAt: new Date().toISOString() };
    await persistWorkspaceState(workspaceState);
  }),

});

app.get("/api/copilot/sessions", async (_req, res) => {
  const workspace = await getProjectWorkspace();
  res.json({ sessions: copilot.listSessions(workspace?.id) });
});

app.get("/api/copilot/sessions/:id/logs", async (req, res) => {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(LOG_FILE, "utf8").catch(() => "");
    const workspace = await getProjectWorkspace();
    const logs = raw.split("\n").filter(Boolean).flatMap((line) => {
      try { const entry = JSON.parse(line) as Record<string, unknown>; return entry.sessionId === req.params.id && (!workspace || entry.workspaceId === workspace.id) ? [entry] : []; }
      catch { return []; }
    });
    res.json({ sessionId: req.params.id, logFile: LOG_FILE, workspaceId: workspace?.id ?? null, logs });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

const server = app.listen(PORT, "127.0.0.1", () => {
  const provider = readCopilotProvider();
  console.log(`[studio:server] listening on http://127.0.0.1:${PORT}; model=${DEFAULT_MODEL}; routing=${describeModelRouting(provider)}; logs=${LOG_FILE}`);
  if (isModelConfiguredWithoutProvider(provider)) {
    console.warn(
      `[studio:server] ${provider.model} is configured as a model but no custom provider serves it: COPILOT_PROVIDER_BASE_URL is not set, `
      + "so the runtime routes every turn to a GitHub-hosted model. Set COPILOT_PROVIDER_BASE_URL, COPILOT_PROVIDER_API_KEY and "
      + "COPILOT_MODEL in v2/.env (see v2/.env.example) and restart."
    );
  }
});

async function shutdown(): Promise<void> {
  server.close();
  await copilot.stop();
  await writeLog("server.stopped");
}
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
