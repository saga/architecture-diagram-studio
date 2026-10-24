import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export interface StorageWorkspaceBinding {
  id: string;
  rootPath: string;
}

export interface StudioStorageLayoutInput {
  appHome?: string;
  workspace?: StorageWorkspaceBinding | null;
  dataDirOverride?: string;
  logDirOverride?: string;
  copilotHomeOverride?: string;
}

export interface StudioStorageLayout {
  scopeKey: string;
  scope: "workspace" | "single-file";
  rootDir: string;
  dataDir: string;
  logDir: string;
  copilotDir: string;
  workspaceStateFile: string;
  diagramVersionsFile: string;
  applicationLogFile: string;
  copilotLogFile: string;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function defaultStudioHome(): string {
  return path.resolve(process.env.STUDIO_HOME?.trim() || path.join(os.homedir(), ".architecture-diagram-studio"));
}

/** The only source of default paths for V2 runtime persistence. */
export function resolveStudioStorageLayout(input: StudioStorageLayoutInput = {}): StudioStorageLayout {
  const appHome = path.resolve(input.appHome || defaultStudioHome());
  const workspace = input.workspace ?? null;
  const scope: StudioStorageLayout["scope"] = workspace ? "workspace" : "single-file";
  const workspaceIdentity = workspace
    ? workspace.id + "\0" + path.resolve(workspace.rootPath)
    : "single-file";
  const scopeKey = (workspace ? "workspace:" : "single-file:") + fingerprint(workspaceIdentity);
  const scopedRoot = workspace
    ? path.join(appHome, "workspaces", fingerprint(workspaceIdentity))
    : appHome;

  // Legacy explicit directories are retained for test isolation and operator-managed deployments.
  // They may intentionally disable physical per-workspace separation for the overridden category,
  // but they do not change the logical scope key/cache invalidation behavior.
  const rootDir = input.dataDirOverride ? path.dirname(path.resolve(input.dataDirOverride)) : scopedRoot;
  const dataDir = input.dataDirOverride ? path.resolve(input.dataDirOverride) : path.join(rootDir, "data");
  const logDir = path.resolve(input.logDirOverride || path.join(rootDir, "logs"));
  const copilotDir = path.resolve(input.copilotHomeOverride || path.join(rootDir, "copilot"));

  return {
    scopeKey,
    scope,
    rootDir,
    dataDir,
    logDir,
    copilotDir,
    workspaceStateFile: path.join(dataDir, "workspace.json"),
    diagramVersionsFile: path.join(dataDir, "diagram-versions.json"),
    applicationLogFile: path.join(logDir, "application-events.jsonl"),
    copilotLogFile: path.join(logDir, "copilot-sessions.jsonl")
  };
}
