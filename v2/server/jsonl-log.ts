import { appendFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const appendQueues = new Map<string, Promise<void>>();

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function rotate(filePath: string, backups: number): Promise<void> {
  for (let index = backups; index >= 1; index--) {
    const from = index === 1 ? filePath : filePath + "." + (index - 1);
    const to = filePath + "." + index;
    await removeIfPresent(to);
    try {
      await rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Append one complete JSONL record and rotate before a write would cross the byte limit.
 * A single oversized record is never truncated; it remains intact in its own file.
 * Writes are serialized per path so concurrent diagnostic events cannot race rotation.
 */
export async function appendRotatingJsonl(
  filePath: string,
  line: string,
  maxBytes = 10 * 1024 * 1024,
  backupCount = 3,
): Promise<void> {
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes));
  const safeBackups = Math.max(0, Math.min(10, Math.floor(backupCount)));
  const previous = appendQueues.get(filePath) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    const currentSize = await fileSize(filePath);
    if (currentSize > 0 && currentSize + Buffer.byteLength(line, "utf8") > safeMaxBytes && safeBackups > 0) {
      await rotate(filePath, safeBackups);
    }
    await appendFile(filePath, line, "utf8");
  });
  appendQueues.set(filePath, write);
  try {
    await write;
  } finally {
    if (appendQueues.get(filePath) === write) appendQueues.delete(filePath);
  }
}

async function readCompleteTail(filePath: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  try {
    const { size } = await handle.stat();
    if (!size) return "";
    let start = Math.max(0, size - Math.max(1, maxBytes));
    if (start > 0) {
      // Move to a record boundary by finding the newline before the byte budget. This can
      // include one unusually long record in full, which is preferable to corrupt JSON or
      // silently lose the newest request/response trace.
      const chunkSize = 64 * 1024;
      let cursor = start;
      let boundary = -1;
      while (cursor > 0 && boundary < 0) {
        const chunkStart = Math.max(0, cursor - chunkSize);
        const chunk = Buffer.alloc(cursor - chunkStart);
        await handle.read(chunk, 0, chunk.length, chunkStart);
        const newline = chunk.lastIndexOf(0x0a);
        if (newline >= 0) boundary = chunkStart + newline + 1;
        else cursor = chunkStart;
      }
      start = boundary >= 0 ? boundary : 0;
    }
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Read a bounded tail from the current JSONL file and its recent rotations, preserving
 * complete records. Returned text is ordered oldest-to-newest; callers may sort by timestamp.
 */
export async function readRecentJsonl(
  filePath: string,
  maxBytesPerFile = 1024 * 1024,
  backupCount = 3,
): Promise<string> {
  const safeBackups = Math.max(0, Math.min(10, Math.floor(backupCount)));
  const pieces: string[] = [];
  for (let index = safeBackups; index >= 1; index--) {
    const part = await readCompleteTail(filePath + "." + index, maxBytesPerFile);
    if (part) pieces.push(part);
  }
  const current = await readCompleteTail(filePath, maxBytesPerFile);
  if (current) pieces.push(current);
  return pieces.join("");
}
