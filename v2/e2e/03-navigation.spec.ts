import { expect, test } from "./support/test";
import {
  createWorkspace,
  nativeFrameHandle,
  openStudio,
  waitForNativeEditor
} from "./support/fixtures";

test.beforeEach(async ({ page, request }) => {
  await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
});

test.describe("工作区导航与外观", () => {
  test("顶栏在 Diagram / Agent traces / Settings 之间切换，Copilot 由右侧面板进入", async ({ page }) => {
    const nav = page.locator('nav[aria-label="Workspace pages"]');
    await expect(nav.getByRole("button", { name: "Diagram" })).toHaveAttribute("aria-current", "page");

    // The top bar no longer duplicates the Copilot entry; it is the right-panel tab.
    await expect(nav.getByRole("button", { name: "Layout Copilot" })).toHaveCount(0);
    await page.locator(".right-tabs").getByRole("tab", { name: "Copilot" }).click();
    await expect(page.locator(".right-copilot-panel")).toBeVisible();
    await expect(page.locator(".right-tabs").getByRole("tab", { name: "Copilot" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "Properties" }).click();
    await expect(page.locator(".inspector-section")).toBeVisible();

    await nav.getByRole("button", { name: "Agent traces" }).click();
    await expect(page.locator(".traces-workspace")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agent trace" })).toBeVisible();
    await expect(page.locator(".trace-filters")).toContainText("Copilot");
    await expect(page.locator(".trace-noise-toggle")).toContainText("low-level events");

    await nav.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator(".settings-workspace")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to diagram" })).toHaveCount(0);

    await nav.getByRole("button", { name: "Diagram" }).click();
    await expect(page.locator(".canvas-stage")).toBeVisible();
    await expect(nav.getByRole("button", { name: "Diagram" })).toHaveAttribute("aria-current", "page");
  });

  test("切换主题会同步到原生画布背景，并在刷新后保留", async ({ page }) => {
    const frame = nativeFrameHandle(page);
    const canvasBackground = () => frame.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // The default theme is warm (#fffcf6); the iframe must mirror it exactly.
    await expect.poll(canvasBackground, { timeout: 20_000 }).toBe("rgb(255, 252, 246)");

    await page.locator(".theme-selector .ant-select").click();
    await page.getByText("Vivid", { exact: true }).click();

    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "youth");
    await expect.poll(canvasBackground, { timeout: 20_000 }).toBe("rgb(255, 250, 255)");

    await page.reload();
    await waitForNativeEditor(page);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "youth");
    await expect.poll(() => nativeFrameHandle(page).evaluate(() => getComputedStyle(document.body).backgroundColor), { timeout: 20_000 })
      .toBe("rgb(255, 250, 255)");
  });

  test("设置页保存配置会追加一条服务端 revision", async ({ page, request }) => {
    await page.locator('nav[aria-label="Workspace pages"]').getByRole("button", { name: "Settings" }).click();
    const configCard = page.locator(".settings-card").filter({ hasText: "Layout engines and Copilot prompts" });
    const counter = configCard.locator(".settings-trace-count");
    await expect(counter).toHaveText(/\d+ revisions/);
    const before = Number((await counter.textContent())!.match(/\d+/)![0]);

    await configCard.getByRole("button", { name: "Save and create revision" }).click();
    await expect(page.getByText("Configuration saved and appended to the server-side JSONL history")).toBeVisible();
    await expect(counter).toHaveText(`${before + 1} revisions`);

    const response = await request.get("/api/workspace/configuration");
    const payload = (await response.json()) as { revisions: number; config: { layoutProfiles: string[] } };
    expect(payload.revisions).toBe(before + 1);
    expect(payload.config.layoutProfiles.length).toBeGreaterThan(0);
  });
});
