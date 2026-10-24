import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * These tests drive the real Studio UI against a real Node.js server and the real
 * local Draw.io bundle, so every run needs its own ports and state directory.
 * A developer's `npm run dev` on the default ports is never touched.
 */
const API_PORT = Number(process.env.STUDIO_E2E_API_PORT || 4180);
const WEB_PORT = Number(process.env.STUDIO_E2E_WEB_PORT || 5180);
const DRAWIO_PORT = Number(process.env.STUDIO_E2E_DRAWIO_PORT || 5181);
const RUN_ROOT = mkdtempSync(path.join(tmpdir(), "studio-e2e-"));

export default defineConfig({
  testDir: "./e2e",
  // Traces and failure screenshots live outside the repository so a run never
  // touches build output or the developer's working tree.
  outputDir: path.join(RUN_ROOT, "test-results"),
  // One server instance and one workspace file back the whole run, so tests must
  // not interleave. Every test still creates its own workspace directory.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // Use Playwright's pinned Chromium in CI for reproducible browser coverage; local runs may use installed Chrome.
    channel: process.env.CI ? undefined : "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Draw.io autosaves through the embed protocol; a slower machine only needs
    // more time, never a different code path.
    actionTimeout: 20_000
  },
  webServer: [
    {
      command: "npx --no-install tsx server/copilot-server.ts",
      url: `http://127.0.0.1:${API_PORT}/api/workspace/config`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        COPILOT_PORT: String(API_PORT),
        STUDIO_DATA_DIR: path.join(RUN_ROOT, "data"),
        COPILOT_LOG_DIR: path.join(RUN_ROOT, "logs")
      }
    },
    {
      // The selection bridge is served from the bundled Draw.io copy; refresh it before
      // Vite starts so a test never runs against a stale plugin checked into public/.
      command: `node scripts/bundle-drawio.mjs && npx --no-install concurrently -k -p none "npx --no-install vite --host 127.0.0.1 --port ${WEB_PORT}" "npx --no-install tsx server/drawio-static-server.ts"`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        STUDIO_WEB_PORT: String(WEB_PORT),
        STUDIO_DRAWIO_PORT: String(DRAWIO_PORT),
        VITE_STUDIO_DRAWIO_PORT: String(DRAWIO_PORT),
        STUDIO_API_URL: `http://127.0.0.1:${API_PORT}`,
        STUDIO_VITE_CACHE_DIR: path.join(RUN_ROOT, "vite-cache")
      }
    }
  ]
});
