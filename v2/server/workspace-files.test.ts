import { mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
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
    expect(matchesWorkspacePattern("node_modules/pkg/index.js", "**/node_modules/**")).toBe(true);
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
      expect((await service.resolveWorkspaceFile("diagram.drawio")).absolutePath).toBe(filePath);
      await expect(service.resolveWorkspaceFile("escape.txt")).rejects.toThrow(/symlinks/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("resolves the supplied directory when no Git root exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-root-"));
    try {
      const resolved = await resolveWorkspaceRoot(root);
      expect(resolved.rootPath).toBe(root);
      expect(resolved.repositoryRoot).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
