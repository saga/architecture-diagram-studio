// Throwaway visual check for the Agent trace row typography.
import { chromium } from "@playwright/test";

const URL = process.env.SHOT_URL || "http://127.0.0.1:5280/";
const OUT = process.env.SHOT_OUT || "/tmp/trace-row.png";

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, deviceScaleFactor: 2 });

await page.addInitScript(() => {
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const entries = [
    { id: "a1", timestamp: at(1), level: "error", event: "copilot.agent.response.error", message: "The Copilot SDK agent request failed", details: { errorMessage: "GitHub Copilot quota is exhausted or rate limited for gpt-6-luna" } },
    { id: "a2", timestamp: at(1), level: "error", event: "copilot.request.failed", message: "Layout intent failed; nothing was committed", details: {} },
    { id: "a3", timestamp: at(2), level: "info", event: "copilot.request.finished", message: "Layout intent finished", details: {} },
    { id: "a4", timestamp: at(3), level: "info", event: "workspace.diagram.created", message: "Created a new Draw.io file and opened it", details: { path: "test.drawio" } },
    { id: "a5", timestamp: at(4), level: "info", event: "drawio.handshake.ready", message: "", details: { note: "no human sentence for this one" } }
  ];
  window.localStorage.setItem("architecture-diagram-studio:v2:diagnostic-traces", JSON.stringify(entries));
});

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
// A fresh data directory opens the workspace setup modal on first load; it is irrelevant here.
await page.addStyleTag({ content: ".ant-modal-root, .ant-modal-mask, .ant-modal-wrap { display: none !important; }" });
console.log("nav buttons:", await page.locator(".workspace-nav button").allInnerTexts());
await page.locator(".workspace-nav button", { hasText: "Agent traces" }).click({ force: true });
await page.waitForSelector(".trace-entry", { timeout: 20_000 });
await page.waitForTimeout(600);
await page.locator(".trace-list").screenshot({ path: OUT });
await page.locator(".trace-entry").first().locator(".trace-entry-toggle").click();
await page.waitForTimeout(300);
await page.locator(".trace-list").screenshot({ path: OUT.replace(".png", "-expanded.png") });
console.log("saved", OUT);
await browser.close();
process.exit(0);
