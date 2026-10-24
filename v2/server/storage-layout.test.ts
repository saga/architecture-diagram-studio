import { describe, expect, it } from "vitest";
import path from "node:path";
import { resolveStudioStorageLayout } from "./storage-layout";

const HOME = path.join(path.sep, "tmp", "studio-home");
const WORKSPACE_A = { id: "workspace-a", rootPath: path.join(path.sep, "projects", "a") };

describe("unified Studio runtime storage layout", () => {
  it("uses the shared Studio home for single-file mode", () => {
    const layout = resolveStudioStorageLayout({ appHome: HOME });
    expect(layout.scope).toBe("single-file");
    expect(layout.rootDir).toBe(HOME);
    expect(layout.dataDir).toBe(path.join(HOME, "data"));
    expect(layout.logDir).toBe(path.join(HOME, "logs"));
    expect(layout.copilotDir).toBe(path.join(HOME, "copilot"));
    expect(layout.workspaceStateFile).toBe(path.join(HOME, "data", "workspace.json"));
  });

  it("binds all default runtime data to a stable workspace partition", () => {
    const a = resolveStudioStorageLayout({ appHome: HOME, workspace: WORKSPACE_A });
    const same = resolveStudioStorageLayout({ appHome: HOME, workspace: { ...WORKSPACE_A } });
    const moved = resolveStudioStorageLayout({ appHome: HOME, workspace: { ...WORKSPACE_A, rootPath: "/projects/a-moved" } });
    const other = resolveStudioStorageLayout({ appHome: HOME, workspace: { id: "workspace-b", rootPath: WORKSPACE_A.rootPath } });
    expect(a.scope).toBe("workspace");
    expect(a.rootDir).toContain(path.join(HOME, "workspaces"));
    expect(a.scopeKey).toBe(same.scopeKey);
    expect(a.scopeKey).not.toBe(moved.scopeKey);
    expect(a.scopeKey).not.toBe(other.scopeKey);
    expect(a.dataDir).not.toBe(resolveStudioStorageLayout({ appHome: HOME }).dataDir);
    expect(a.applicationLogFile).toContain(a.rootDir);
    expect(a.copilotLogFile).toContain(a.rootDir);
    expect(a.copilotDir).toContain(a.rootDir);
  });

  it("keeps operator/test overrides explicit while still exposing logical scope changes", () => {
    const a = resolveStudioStorageLayout({
      appHome: HOME, workspace: WORKSPACE_A,
      dataDirOverride: "/tmp/studio-test/data",
      logDirOverride: "/tmp/studio-test/logs",
      copilotHomeOverride: "/tmp/studio-test/sdk"
    });
    const b = resolveStudioStorageLayout({
      appHome: HOME, workspace: { id: "workspace-b", rootPath: "/projects/b" },
      dataDirOverride: "/tmp/studio-test/data",
      logDirOverride: "/tmp/studio-test/logs",
      copilotHomeOverride: "/tmp/studio-test/sdk"
    });
    expect(a.rootDir).toBe("/tmp/studio-test");
    expect(a.dataDir).toBe("/tmp/studio-test/data");
    expect(a.logDir).toBe("/tmp/studio-test/logs");
    expect(a.copilotDir).toBe("/tmp/studio-test/sdk");
    expect(a.scopeKey).not.toBe(b.scopeKey);
  });

  it("does not allow workspace metadata to become a path component", () => {
    const layout = resolveStudioStorageLayout({ appHome: HOME, workspace: { id: "../../unsafe", rootPath: "/tmp/../outside" } });
    expect(layout.rootDir).toContain(path.join(HOME, "workspaces"));
    expect(path.relative(path.join(HOME, "workspaces"), layout.rootDir).startsWith("..")).toBe(false);
  });
});
