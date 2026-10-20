#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const VERSION = "v32.0.2";
const SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
const URL = "https://github.com/jgraph/drawio/releases/download/v32.0.2/draw.war";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "public", "drawio");
const STAMP = path.join(DEST, ".version");
function log(message) { console.log("[drawio-bundle] " + message); }

function readEntries(buffer) {
  const signature = 0x06054b50;
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === signature) { end = i; break; }
  }
  if (end < 0) throw new Error("The supplied draw.war is not a valid ZIP archive.");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(start, start + compressedSize);
    if (name.endsWith("/")) continue;
    if (method !== 0 && method !== 8) throw new Error("Unsupported ZIP compression " + method + " in " + name);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(payload) : payload });
  }
  return entries;
}

async function loadWar() {
  if (process.env.DRAWIO_WAR) {
    const file = path.resolve(process.env.DRAWIO_WAR);
    if (!fs.existsSync(file)) throw new Error("DRAWIO_WAR does not exist: " + file);
    log("Using offline archive " + file);
    return fs.readFileSync(file);
  }
  log("Downloading Draw.io " + VERSION + " for build-time bundling (not runtime use)...");
  const response = await fetch(URL);
  if (!response.ok) throw new Error("Download failed with HTTP " + response.status + ". Set DRAWIO_WAR to a local archive in offline environments.");
  return Buffer.from(await response.arrayBuffer());
}
function hasValidBundle() {
  try {
    if (fs.readFileSync(STAMP, "utf8").trim() !== VERSION) return false;
    if (!fs.existsSync(path.join(DEST, "index.html"))) return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(DEST, "studio-bundle.json"), "utf8"));
    return manifest.version === VERSION && manifest.sha256 === SHA256;
  } catch {
    return false;
  }
}

async function main() {
  if (hasValidBundle()) {
    log("Pinned assets and checksum manifest verified; no download needed.");
    return;
  }
  const archive = await loadWar();
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  if (digest !== SHA256) throw new Error("Checksum mismatch for draw.war. Expected " + SHA256 + ", got " + digest + ". The archive was not installed.");
  const temp = DEST + ".tmp-" + process.pid;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  let written = 0;
  for (const entry of readEntries(archive)) {
    if (entry.name.startsWith("WEB-INF/") || entry.name.startsWith("META-INF/")) continue;
    const target = path.resolve(temp, entry.name);
    if (!target.startsWith(temp + path.sep)) throw new Error("Unsafe archive path: " + entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    written++;
  }
  fs.writeFileSync(path.join(temp, ".version"), VERSION + "\n");
  fs.writeFileSync(path.join(temp, "studio-bundle.json"), JSON.stringify({ version: VERSION, sha256: SHA256 }, null, 2) + "\n");
  if (!fs.existsSync(path.join(temp, "index.html"))) throw new Error("The archive did not contain the Draw.io web entry point.");
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.renameSync(temp, DEST);
  log("Installed " + written + " web assets into public/drawio. Runtime now serves them locally.");
}
main().catch((error) => {
  console.error("[drawio-bundle] " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});