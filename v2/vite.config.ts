import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function terminalDiagnostics(): Plugin {
  return {
    name: "studio-terminal-diagnostics",
    configureServer(server) {
      server.middlewares.use("/__studio/log", (request, response, next) => {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.setHeader("Allow", "POST");
          response.end();
          return;
        }

        const origin = request.headers.origin;
        const host = request.headers.host;
        if (origin && host) {
          try {
            if (new URL(origin).host !== host) {
              response.statusCode = 403;
              response.end();
              return;
            }
          } catch {
            response.statusCode = 403;
            response.end();
            return;
          }
        }

        request.setEncoding("utf8");
        let raw = "";
        let tooLarge = false;
        request.on("data", (chunk: string) => {
          if (raw.length + chunk.length > 16_384) {
            tooLarge = true;
            return;
          }
          raw += chunk;
        });
        request.on("end", () => {
          if (tooLarge) {
            response.statusCode = 413;
            response.end();
            return;
          }
          try {
            const input: unknown = JSON.parse(raw);
            if (!input || typeof input !== "object") throw new Error("Expected a JSON object.");
            const item = input as Record<string, unknown>;
            const safeText = (value: unknown, max = 300) => typeof value === "string" ? value.slice(0, max) : "";
            const level = ["debug", "info", "warn", "error"].includes(String(item.level)) ? String(item.level) : "info";
            const event = safeText(item.event, 100) || "unknown";
            const details = redactTerminalData(item.details);
            const logRecord = {
              receivedAt: new Date().toISOString(),
              clientTimestamp: safeText(item.timestamp, 40),
              id: safeText(item.id, 80),
              level,
              event,
              message: safeText(item.message),
              details
            };
            const line = "[studio:v2] " + JSON.stringify(logRecord);
            if (level === "error") server.config.logger.error(line);
            else if (level === "warn") server.config.logger.warn(line);
            else if (level === "debug") server.config.logger.info("[debug] " + line);
            else server.config.logger.info(line);
            response.statusCode = 204;
            response.end();
          } catch (error) {
            server.config.logger.warn("[studio:v2] rejected malformed diagnostic event: " +
              (error instanceof Error ? error.message : String(error)));
            response.statusCode = 400;
            response.end();
          }
        });
      });
    }
  };
}

function redactTerminalData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 500 ? value.slice(0, 500) + "…[truncated]" : value;
  if (depth >= 3) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactTerminalData(item, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key] = /^(api.?key|token|secret|password|authorization|prompt|raw.?xml|xml|request.?body|access.?key)$/i.test(key)
        ? "[redacted]"
        : redactTerminalData(nested, depth + 1);
    }
    return output;
  }
  return String(value);
}

export default defineConfig({
  plugins: [react(), terminalDiagnostics()],
  server: { host: "0.0.0.0", port: 5174 },
  preview: { host: "0.0.0.0", port: 4174 },
  build: { target: "es2022", sourcemap: true }
});
