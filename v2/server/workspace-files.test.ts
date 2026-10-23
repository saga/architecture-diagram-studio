import { mkdtemp, symlink, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyWorkspaceFile, createWorkspaceFileService, matchesWorkspacePattern, resolveWorkspaceRoot, type ProjectWorkspace } from "./workspace-files";

describe("workspace file service", () => {
  it("classifies diagram, source and documentation files", () => {
    expect(classifyWorkspaceFile("architecture/main.drawio")).toBe("diagram");
    expect(classifyWorkspaceFile("src/App.tsx")).toBe("code");
    expect(classifyWorkspaceFile("docs/adr.md")).toBe("document");
    expect(classifyWorkspaceFile("assets/logo.png")).toBe("other");
  });
  it("matches workspace glob patterns", () => {
    expect(matchesWorkspacePattern("src/App.tsx", "src/**/*.tsx")).toBe(true);
    expect(matchesWorkspacePattern("packages/node_modules/pkg/index.js", "**/node_modules/**")).toBe(true);
    expect(matchesWorkspacePattern("src/App.tsx", "docs/**/*.md")).toBe(false);
  });
  it("rejects traversal paths and symlink reads", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-workspace-"));
    const workspace: ProjectWorkspace = { schemaVersion: 1, id: "w", name: "test", rootPath: root, primaryDiagram: null, includePatterns: [], excludePatterns: [], createdAt: "", updatedAt: "" };
    const filePath = path.join(root, "diagram.drawio");
    const linkPath = path.join(root, "escape.txt");
    await writeFile(filePath, "<mxfile/>", "utf8");
    await symlink(filePath, linkPath);
    const service = createWorkspaceFileService(async () => workspace);
    try {
      await expect(service.resolveWorkspaceFile("../outside.txt")).rejects.toThrow(/Invalid file path|escapes the workspace/);
      expect((await service.resolveWorkspaceFile("diagram.drawio")).absolutePath).toBe(await realpath(filePath));
      await expect(service.resolveWorkspaceFile("escape.txt")).rejects.toThrow(/symlinks/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("reuses task-relevant excerpts and invalidates them when file metadata changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-context-cache-"));
    const workspace: ProjectWorkspace = { schemaVersion: 1, id: "context-cache", name: "test", rootPath: root, primaryDiagram: null, includePatterns: [], excludePatterns: [], createdAt: "", updatedAt: "" };
    try {
      await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "src"), { recursive: true }));
      await writeFile(path.join(root, "README.md"), "Workspace instructions and architecture context.", "utf8");
      await writeFile(path.join(root, "src", "account-mapping.ts"), "export const accountMapping = 'before';", "utf8");
      await writeFile(path.join(root, "src", "billing.ts"), "export const billing = true;", "utf8");
      const service = createWorkspaceFileService(async () => workspace);
      const first = await service.collectAgentWorkspaceContext("update account mapping") as { cacheHits?: number; cacheMisses?: number; snippets?: Array<{ path: string; content: string }> };
      const second = await service.collectAgentWorkspaceContext("update account mapping") as { cacheHits?: number; cacheMisses?: number; snippets?: Array<{ path: string; content: string }> };
      expect(first.cacheMisses).toBeGreaterThan(0);
      expect(second.cacheHits).toBeGreaterThan(0);

      await writeFile(path.join(root, "src", "account-mapping.ts"), "export const accountMapping = 'updated-content';", "utf8");
      const third = await service.collectAgentWorkspaceContext("update account mapping") as { cacheHits?: number; cacheMisses?: number; snippets?: Array<{ path: string; content: string }> };
      expect(third.cacheMisses).toBeGreaterThan(0);
      expect(third.snippets?.find((item) => item.path === "src/account-mapping.ts")?.content).toContain("updated-content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the supplied directory when no Git root exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-root-"));
    try {
      const resolved = await resolveWorkspaceRoot(root);
      // The service canonicalises the path, and on macOS the temp directory is reached
      // through a symlink (/var → /private/var), so compare against the real path.
      expect(resolved.rootPath).toBe(await realpath(root));
      expect(resolved.repositoryRoot).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
