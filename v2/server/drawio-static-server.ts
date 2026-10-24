import express from "express";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

function loadLocalEnv(): void {
  if (typeof parseEnv !== "function") return;
  const merged: Record<string, string> = {};
  for (const dir of [process.cwd(), path.join(process.cwd(), "v2")]) {
    for (const file of [".env", ".env.local"]) {
      try { Object.assign(merged, parseEnv(readFileSync(path.join(dir, file), "utf8"))); }
      catch { /* absent or unreadable; keep looking */ }
    }
  }
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadLocalEnv();

const configuredPort = Number(process.env.STUDIO_DRAWIO_PORT || 4176);
const PORT = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535
  ? configuredPort : 4176;
const HOST = "127.0.0.1";
const DRAWIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/drawio");
const configuredStudioPorts = [
  process.env.STUDIO_WEB_PORT || 5174,
  process.env.STUDIO_PREVIEW_PORT || 4174
].map(Number).filter((port, index, ports) =>
  Number.isInteger(port) && port >= 1024 && port <= 65535 && ports.indexOf(port) === index
);
const allowedStudioAncestors = configuredStudioPorts.flatMap((port) => [
  "http://localhost:" + port,
  "http://127.0.0.1:" + port
]).join(" ");
if (!allowedStudioAncestors) throw new Error("No valid Studio parent ports are configured for the isolated Draw.io origin.");

if (!existsSync(path.join(DRAWIO_ROOT, "index.html")) ||
    !existsSync(path.join(DRAWIO_ROOT, "studio-selection-plugin.js"))) {
  console.error("[studio:drawio-static] The local Draw.io bundle is missing. Run npm run drawio:fetch first.");
  process.exit(1);
}

// Keep arbitrary agent-authored JavaScript on a separate local origin. CSP blocks common
// request channels (connect-src) and remote images; it is not a process-level network sandbox.
// The parent UI communicates only through the exact-origin embed protocol.
export const DRAWIO_CONTENT_SECURITY_POLICY = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'self'",
  "frame-ancestors " + allowedStudioAncestors
].join("; ");

const app = express();
app.disable("x-powered-by");
app.get("/__health", (_request, response) => {
  response.json({ ok: true, service: "studio-drawio-static", port: PORT });
});
app.use(express.static(DRAWIO_ROOT, {
  dotfiles: "deny",
  index: "index.html",
  fallthrough: true,
  setHeaders(response, filePath) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin");
    response.setHeader("Cache-Control", "no-store");
    if (path.basename(filePath).toLowerCase() === "index.html") {
      response.setHeader("Content-Security-Policy", DRAWIO_CONTENT_SECURITY_POLICY);
    }
  }
}));
app.use((_request, response) => {
  response.status(404).type("text/plain").send("Draw.io asset not found.");
});

const server = app.listen(PORT, HOST, () => {
  console.log("[studio:drawio-static] Listening on http://" + HOST + ":" + PORT +
    " with CSP connect-src 'none'; bundle=" + DRAWIO_ROOT);
});
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error("[studio:drawio-static] Failed to start:", error.message);
  process.exitCode = 1;
});
