#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import tls from "node:tls";
import { ProxyAgent } from "undici";

const VERSION = "v32.0.2";
const SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
const URL = "https://github.com/jgraph/drawio/releases/download/v32.0.2/draw.war";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEST = path.join(ROOT, "public", "drawio");
const STAMP = path.join(DEST, ".version");
function log(message) { console.log("[drawio-bundle] " + new Date().toISOString() + " " + message); }

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
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP central directory at byte " + offset + ".");
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
    const stats = fs.statSync(file);
    log("Offline archive selected: path=" + file + ", bytes=" + stats.size);
    return fs.readFileSync(file);
  }
  const startedAt = Date.now();
  log("Downloading the pinned Draw.io release for build-time bundling. No runtime network access is required.");

  // Support HTTPS proxies that re-sign TLS traffic with an internal CA.
  // TLS_TRUST_SSL_CERT_FILE (or DRAWIO_TRUST_SSL_CERT_FILE) points to a PEM CA certificate/bundle.
  const trustSslCertFile = process.env.TLS_TRUST_SSL_CERT_FILE || process.env.DRAWIO_TRUST_SSL_CERT_FILE;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
  let ca;
  if (trustSslCertFile) {
    const certPath = path.resolve(trustSslCertFile);
    if (!fs.existsSync(certPath)) throw new Error("TLS trustSslCertFile does not exist: " + certPath);
    ca = [...tls.rootCertificates, fs.readFileSync(certPath)];
    log("Custom TLS trust certificate configured: " + certPath);
  }
  const dispatcher = proxyUrl
    ? new ProxyAgent({
        uri: proxyUrl,
        ...(ca ? { proxyTls: { ca }, requestTls: { ca } } : {})
      })
    : undefined;
  if (proxyUrl) log("HTTPS proxy configured: " + new URL(proxyUrl).origin);
  log("GET " + URL);
  const response = await fetch(URL, dispatcher ? { dispatcher } : undefined);
  log("Download response: status=" + response.status + " " + response.statusText +
      ", content-length=" + (response.headers.get("content-length") || "unknown"));
  if (!response.ok) throw new Error("Download failed with HTTP " + response.status + " " + response.statusText +
    ". Set DRAWIO_WAR to a local archive in offline environments.");
  const archive = Buffer.from(await response.arrayBuffer());
  log("Download complete: bytes=" + archive.length + ", durationMs=" + (Date.now() - startedAt));
  return archive;
}

function hasValidBundle() {
  try {
    if (fs.readFileSync(STAMP, "utf8").trim() !== VERSION) return false;
    if (!fs.existsSync(path.join(DEST, "index.html"))) return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(DEST, "studio-bundle.json"), "utf8"));
    const indexHtml = fs.readFileSync(path.join(DEST, "index.html"), "utf8");
    return manifest.version === VERSION && manifest.sha256 === SHA256 &&
      fs.existsSync(path.join(DEST, "studio-selection-plugin.js")) &&
      indexHtml.includes('<script src="studio-selection-plugin.js"></script>');
  } catch {
    return false;
  }
}

async function main() {
  const startedAt = Date.now();
  log("Bundle validation started: version=" + VERSION + ", destination=" + DEST);
  if (hasValidBundle()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(DEST, "studio-bundle.json"), "utf8"));
    const entry = fs.statSync(path.join(DEST, "index.html"));
    log("Bundle cache hit: version=" + manifest.version + ", sha256=" + manifest.sha256 +
      ", indexHtmlBytes=" + entry.size + ". No download or extraction required.");
    return;
  }

  log("Bundle cache miss: version stamp, index.html, or checksum manifest is absent or invalid.");
  const archive = await loadWar();
  log("Archive received: bytes=" + archive.length);
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  log("Archive SHA-256: " + digest);
  if (digest !== SHA256) {
    throw new Error("Checksum mismatch for draw.war. Expected " + SHA256 + ", got " + digest + ". The archive was not installed.");
  }
  log("SHA-256 verified. Parsing ZIP central directory.");
  const entries = readEntries(archive);
  log("ZIP parsed: fileEntries=" + entries.length);

  const temp = DEST + ".tmp-" + process.pid;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  let written = 0;
  let skipped = 0;
  let extractedBytes = 0;
  for (const entry of entries) {
    if (entry.name.startsWith("WEB-INF/") || entry.name.startsWith("META-INF/")) { skipped++; continue; }
    const target = path.resolve(temp, entry.name);
    if (!target.startsWith(temp + path.sep)) throw new Error("Unsafe archive path: " + entry.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    written++;
    extractedBytes += entry.data.length;
  }

  // Add a first-party plugin to bridge native Draw.io selection events to the host.
  // Draw.io intentionally does not expose editorUi on window and its embed protocol has no
  // selection event, so the plugin is loaded from this same-origin, pinned local bundle.
  const pluginSource = path.join(ROOT, "plugins", "studio-selection-plugin.js");
  if (!fs.existsSync(pluginSource)) throw new Error("Missing local Draw.io selection bridge: " + pluginSource);
  fs.copyFileSync(pluginSource, path.join(temp, "studio-selection-plugin.js"));
  const indexHtmlPath = path.join(temp, "index.html");
  let indexHtml = fs.readFileSync(indexHtmlPath, "utf8");
  if (!indexHtml.includes('<script src="studio-selection-plugin.js"></script>')) {
    const mainScript = /(<script\s+src=["']js\/main\.js["'][^>]*>\s*<\/script>)/i;
    if (!mainScript.test(indexHtml)) throw new Error("Could not locate js/main.js in Draw.io index.html to install the selection bridge.");
    indexHtml = indexHtml.replace(mainScript, '$1\n<script src="studio-selection-plugin.js"></script>');
    fs.writeFileSync(indexHtmlPath, indexHtml);
  }

  fs.writeFileSync(path.join(temp, ".version"), VERSION + "\n");
  fs.writeFileSync(path.join(temp, "studio-bundle.json"), JSON.stringify({ version: VERSION, sha256: SHA256 }, null, 2) + "\n");
  const entryPath = path.join(temp, "index.html");
  if (!fs.existsSync(entryPath)) throw new Error("The archive did not contain the Draw.io web entry point.");
  log("Extraction validated: index.html bytes=" + fs.statSync(entryPath).size + ", files=" + written +
      ", skippedMetadata=" + skipped + ", extractedBytes=" + extractedBytes);
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.renameSync(temp, DEST);
  log("Install complete: output=" + DEST + ", version=" + VERSION + ", files=" + written +
      ", elapsedMs=" + (Date.now() - startedAt));
}

main().catch((error) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error("[drawio-bundle] " + new Date().toISOString() + " FAILED\n" + message);
  process.exitCode = 1;
});
