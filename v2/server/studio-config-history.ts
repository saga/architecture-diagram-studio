import { appendFile, mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
export type StudioConfig = {
  schemaVersion: 1;
  revisionId: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "max";
  updatedAt: string;
  updatedBy: string;
};

export function parseConfigHistory(contents: string): Array<Record<string, unknown>> {
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

export function isValidConfigHistoryRecord(record: Record<string, unknown>): boolean {
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) return false;
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length > 100)) return false;
  if (record.reasoningEffort !== undefined && !["low", "medium", "high", "max"].includes(String(record.reasoningEffort))) return false;
  return true;
}

export interface StudioConfigServiceOptions {
  globalDataDir: string;
  historyFile: string;
  defaultModel: string;
  legacyDefaultModel: string;
  readProvider: () => { mode: string; model?: string };
}

export function createStudioConfigService(options: StudioConfigServiceOptions) {
  const defaultConfig: StudioConfig = {
    schemaVersion: 1,
    revisionId: "default",
    model: options.defaultModel,
    reasoningEffort: "medium",
    updatedAt: new Date(0).toISOString(),
    updatedBy: "default"
  };
  let current: StudioConfig | null = null;

  async function appendStudioConfig(config: StudioConfig, changeSummary: string): Promise<void> {
    await mkdir(options.globalDataDir, { recursive: true, mode: 0o700 });
    await appendFile(options.historyFile, JSON.stringify({ ...config, changeSummary }) + "\\n", { encoding: "utf8", mode: 0o600 });
    current = config;
  }

  async function adoptConfiguredModel(config: StudioConfig): Promise<StudioConfig> {
    const provider = options.readProvider();
    if (config.model !== options.legacyDefaultModel || provider.mode !== "byok" || !provider.model) return config;
    const migrated: StudioConfig = {
      ...config,
      revisionId: randomUUID(),
      model: provider.model,
      updatedAt: new Date().toISOString(),
      updatedBy: "migration"
    };
    await appendStudioConfig(migrated, "Adopt the model served by the configured custom provider");
    return migrated;
  }

  async function getStudioConfig(): Promise<StudioConfig> {
    if (current) return current;
    const contents = await readFile(options.historyFile, "utf8").catch((error) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? "" : Promise.reject(error));
    const records = parseConfigHistory(contents);
    for (let i = records.length - 1; i >= 0; i--) {
      const parsed = records[i];
      if (!isValidConfigHistoryRecord(parsed)) continue;
      current = {
        ...defaultConfig,
        revisionId: typeof parsed.revisionId === "string" ? parsed.revisionId :
          "legacy-" + (typeof parsed.updatedAt === "string" ? parsed.updatedAt.replace(/\\D/g, "") : String(i)),
        model: typeof parsed.model === "string" ? parsed.model : defaultConfig.model,
        reasoningEffort: ["low", "medium", "high", "max"].includes(String(parsed.reasoningEffort)) ? parsed.reasoningEffort as StudioConfig["reasoningEffort"] : "medium",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaultConfig.updatedAt,
        updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : "legacy"
      };
      return adoptConfiguredModel(current);
    }
    current = { ...defaultConfig };
    return adoptConfiguredModel(current);
  }

  return { getStudioConfig, appendStudioConfig };
}
