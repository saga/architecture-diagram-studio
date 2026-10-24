import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createEmptyDrawioXml } from "./diagram-file";
import { createLocalDiagramFileService } from "./local-diagram-files";

describe("standalone Draw.io history for browser-owned files", () => {
  let dataRoot: string;
  let service: ReturnType<typeof createLocalDiagramFileService>;

  beforeEach(async () => {
    dataRoot = await mkdtemp(path.join(os.tmpdir(), "studio-browser-history-"));
    service = createLocalDiagramFileService({ historyDirectory: path.join(dataRoot, "history") });
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  it("registers the browser document and stores the initial XML snapshot", async () => {
    const xml = createEmptyDrawioXml("main.drawio");
    const session = await service.openBrowserDocument("document-1", "main.drawio", xml);

    expect(session.documentId).toBe("document-1");
    expect(session.name).toBe("main.drawio");
    expect(session.revision).toHaveLength(64);
    expect(session.snapshotCount).toBe(1);
    const history = await service.listHistory(session.fileToken);
    expect(history).toHaveLength(1);
    expect(history[0]?.label).toBe("Opened file");
    expect((await service.readHistoryEntry(session.fileToken, history[0]!.id)).xml).toBe(xml);
  });

  it("stores changed XML snapshots without receiving or writing the source file path", async () => {
    const original = createEmptyDrawioXml("main.drawio");
    const session = await service.openBrowserDocument("document-2", "main.drawio", original);
    const changed = original.replace('name="main"', 'name="Updated Page"');

    const saved = await service.saveSnapshot(session.fileToken, session.revision, changed, "Autosave");
    expect(saved.revision).not.toBe(session.revision);
    expect(saved.snapshotCount).toBe(2);
    const history = await service.listHistory(session.fileToken);
    expect(history.map((item) => item.label)).toEqual(["Opened file", "Autosave"]);

    // Only the snapshot store exists here. There is deliberately no source path for this service to write.
    const historyXml = await service.readHistoryEntry(session.fileToken, history[1]!.id);
    expect(historyXml.xml).toBe(changed);
    expect(await readFile(path.join(dataRoot, "main.drawio")).catch(() => null)).toBeNull();
  });

  it("rejects stale snapshot revisions and does not append the stale XML", async () => {
    const original = createEmptyDrawioXml("main.drawio");
    const session = await service.openBrowserDocument("document-3", "main.drawio", original);
    const changed = original.replace('name="main"', 'name="Updated Page"');
    await service.saveSnapshot(session.fileToken, session.revision, changed, "Current");

    await expect(service.saveSnapshot(session.fileToken, session.revision, original, "Stale"))
      .rejects.toMatchObject({ statusCode: 409 });
    const history = await service.listHistory(session.fileToken);
    expect(history).toHaveLength(2);
    expect((await service.readHistoryEntry(session.fileToken, history.at(-1)!.id)).xml).toBe(changed);
  });

  it("prepares a history restore and snapshots the current XML without writing the selected file", async () => {
    const original = createEmptyDrawioXml("main.drawio");
    const session = await service.openBrowserDocument("document-4", "main.drawio", original);
    const initialHistory = await service.listHistory(session.fileToken);
    const changed = original.replace('name="main"', 'name="Changed Page"');
    const saved = await service.saveSnapshot(session.fileToken, session.revision, changed, "Changed");

    const prepared = await service.prepareHistoryRestore(
      session.fileToken, saved.revision, changed, initialHistory[0]!.id
    );
    expect(prepared.drawioXml).toBe(original);
    expect(prepared.revision).toBe(session.revision);
    expect((await service.listHistory(session.fileToken)).map((item) => item.label))
      .toEqual(["Opened file", "Changed"]);
    expect((await service.readHistoryEntry(session.fileToken, initialHistory[0]!.id)).xml).toBe(original);
  });

  it("rejects invalid document IDs, invalid XML and expired session tokens", async () => {
    const valid = createEmptyDrawioXml("main.drawio");
    await expect(service.openBrowserDocument("/tmp/main.drawio", "main.drawio", valid)).rejects.toThrow(/document ID/);
    await expect(service.openBrowserDocument("document-5", "main.drawio", "<mxfile><broken"))
      .rejects.toThrow();
    await service.openBrowserDocument("document-6", "main.drawio", valid);
    await expect(service.listHistory("not-a-session-token")).rejects.toMatchObject({ statusCode: 410 });
  });
});
