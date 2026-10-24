import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEmptyDrawioXml } from "./diagram-file";
import { createLocalDiagramFileService } from "./local-diagram-files";

describe("server-managed local Draw.io files", () => {
  let root: string;
  let outside: string;
  let service: ReturnType<typeof createLocalDiagramFileService>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "studio-local-files-"));
    outside = await mkdtemp(path.join(os.tmpdir(), "studio-local-files-outside-"));
    service = createLocalDiagramFileService({ allowedRoots: async () => [root], historyDirectory: path.join(root, ".studio-history") });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("browses directories and only lists supported diagram files", async () => {
    await mkdir(path.join(root, "diagrams"));
    await writeFile(path.join(root, "diagrams", "architecture.drawio"), createEmptyDrawioXml("architecture.drawio"));
    await writeFile(path.join(root, "ignore.txt"), "not a diagram");
    const result = await service.listDirectory(root);
    expect(result.entries.map((item) => item.name)).toContain("diagrams");
    expect(result.entries.map((item) => item.name)).not.toContain("ignore.txt");
    const nested = await service.listDirectory(path.join(root, "diagrams"));
    expect(nested.entries.map((item) => item.name)).toContain("architecture.drawio");
  });

  it("opens and saves through Node fs without changing the file's destination", async () => {
    const file = path.join(root, "main.drawio");
    const original = createEmptyDrawioXml("main.drawio");
    await writeFile(file, original, "utf8");
    const opened = await service.openDiagram(file);
    const changed = original.replace('name="main"', 'name="Updated Page"');
    const saved = await service.saveDiagram(opened.fileToken, opened.revision, changed);
    expect(saved.path).toBe(file);
    expect(saved.revision).not.toBe(opened.revision);
    expect(await readFile(file, "utf8")).toBe(changed);
  });

  it("rejects a stale save when an external process changed the file", async () => {
    const file = path.join(root, "main.drawio");
    const original = createEmptyDrawioXml("main.drawio");
    await writeFile(file, original, "utf8");
    const opened = await service.openDiagram(file);
    const outsideEdit = original.replace('name="main"', 'name="Edited outside Studio"');
    await writeFile(file, outsideEdit, "utf8");
    await expect(service.saveDiagram(opened.fileToken, opened.revision, original.replace('name="main"', 'name="Studio edit"')))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(file, "utf8")).toBe(outsideEdit);
  });

  it("stores standalone history under the Studio data directory and restores safely", async () => {
    const file = path.join(root, "main.drawio");
    const original = createEmptyDrawioXml("main.drawio");
    await writeFile(file, original, "utf8");
    const opened = await service.openDiagram(file);
    const changed = original.replace('name="main"', 'name="Changed Page"');
    const saved = await service.saveDiagram(opened.fileToken, opened.revision, changed);
    const history = await service.listHistory(opened.fileToken);
    expect(history.length).toBeGreaterThan(0);
    const restored = await service.restoreHistory(opened.fileToken, saved.revision, history[0]!.id);
    expect(restored.drawioXml).toBe(original);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("exports without overwriting an existing file", async () => {
    const xml = createEmptyDrawioXml("export.drawio");
    const first = await service.exportDiagram(root, "export.drawio", xml);
    expect(await readFile(first.path, "utf8")).toBe(xml);
    await expect(service.exportDiagram(root, "export.drawio", xml)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects traversal, symlinks, non-absolute paths and invalid XML", async () => {
    const file = path.join(outside, "outside.drawio");
    await writeFile(file, createEmptyDrawioXml("outside.drawio"), "utf8");
    await expect(service.openDiagram(file)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.openDiagram("relative.drawio")).rejects.toThrow(/absolute/);
    const linked = path.join(root, "linked.drawio");
    await symlink(file, linked);
    await expect(service.openDiagram(linked)).rejects.toThrow(/Symbolic links/);
    await expect(service.exportDiagram(root, "../escape.drawio", createEmptyDrawioXml("x.drawio"))).rejects.toThrow(/file name/);
    await expect(service.exportDiagram(root, "invalid.drawio", "<mxfile><broken")).rejects.toThrow();
  });
});
