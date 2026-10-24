import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.STUDIO_DRAWIO_PORT || 4176);
const HOST = "127.0.0.1";
const DRAWIO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/drawio");

// Keep arbitrary agent-authored JavaScript inside a separate local origin with no network
// connection capability. The parent UI talks to it only through the exact-origin embed protocol.
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
  "navigate-to 'self'",
  "frame-ancestors http://localhost:* http://127.0.0.1:*"
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
    response.setHeader("Referrer-Policy", "no-referrer");
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
