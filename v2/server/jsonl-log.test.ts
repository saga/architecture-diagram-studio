import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRotatingJsonl, readRecentJsonl } from "./jsonl-log";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryLog() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "studio-jsonl-log-"));
  directories.push(directory);
  return path.join(directory, "events.jsonl");
}

describe("bounded JSONL logs", () => {
  it("rotates complete records and reads current plus recent archives in order", async () => {
    const file = await temporaryLog();
    const rows = Array.from({ length: 8 }, (_, index) => JSON.stringify({ index, text: "x".repeat(12) }) + "\n");
    for (const row of rows) await appendRotatingJsonl(file, row, 55, 3);

    const combined = await readRecentJsonl(file, 4096, 3);
    const parsed = combined.trim().split("\n").map((line) => JSON.parse(line) as { index: number });
    expect(parsed.map((row) => row.index)).toEqual([4, 5, 6, 7]);
    expect((await readdir(path.dirname(file))).sort()).toEqual(["events.jsonl", "events.jsonl.1", "events.jsonl.2", "events.jsonl.3"]);
  });

  it("keeps an individual oversized Prompt/Response record intact", async () => {
    const file = await temporaryLog();
    const longRecord = JSON.stringify({ event: "turn.model-call.completed", responseText: "response-" + "x".repeat(20_000) }) + "\n";
    await appendRotatingJsonl(file, longRecord, 100, 2);
    const contents = await readRecentJsonl(file, 50, 2);
    expect(contents).toBe(longRecord);
    expect(JSON.parse(contents).responseText.length).toBeGreaterThan(20_000);
    expect((await stat(file)).size).toBe(Buffer.byteLength(longRecord, "utf8"));
    expect(await readFile(file, "utf8")).toBe(longRecord);
  });

  it("serializes concurrent writes before rotating the same file", async () => {
    const file = await temporaryLog();
    await Promise.all(Array.from({ length: 30 }, (_, index) =>
      appendRotatingJsonl(file, JSON.stringify({ index }) + "\n", 90, 5)));
    const combined = await readRecentJsonl(file, 4096, 5);
    const rows = combined.trim().split("\n").map((line) => JSON.parse(line) as { index: number });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.at(-1)?.index).toBe(29);
    expect(rows.every((row) => Number.isInteger(row.index))).toBe(true);
  });
});
