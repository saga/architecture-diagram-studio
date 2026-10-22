import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 5218;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: process.cwd(), detached: true, stdio: "ignore" });
async function waitReady(ms = 90_000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(BASE, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {} await new Promise((r) => setTimeout(r, 400)); }
  return false;
}
let browser;
try {
  if (!(await waitReady())) throw new Error("vite not ready");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("iframe", { timeout: 40_000 });
  await page.waitForTimeout(3500);
  const out = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { h: +r.height.toFixed(1), y: +r.y.toFixed(1), bottom: +r.bottom.toFixed(1) }; };
    const cs = (sel) => { const el = document.querySelector(sel); const s = getComputedStyle(el); return { padding: s.padding, margin: s.margin, minHeight: s.minHeight }; };
    return {
      topbar: box(".topbar"), toolbar: box(".canvas-toolbar"), toolbarStyle: cs(".canvas-toolbar"),
      title: box(".canvas-title"), titleStyle: cs(".canvas-title"),
      tools: box(".canvas-tools"), select: box(".canvas-tools .text-field"),
      iframe: box(".drawio-iframe")
    };
  });
  console.log(JSON.stringify(out, null, 1));
  await page.screenshot({ path: ".probe6/top.png", clip: { x: 240, y: 60, width: 830, height: 200 } });
} catch (e) { console.error("FAILED", e.message); }
finally { if (browser) await browser.close().catch(() => {}); try { process.kill(-server.pid, "SIGKILL"); } catch {} process.exit(0); }
