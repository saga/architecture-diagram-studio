import { expect, test } from "./support/test";
import {
  createWorkspace,
  nativeFrameHandle,
  openStudio,
  readWorkspaceXml,
  waitForNativeEditor
} from "./support/fixtures";

let activeWorkspace: Awaited<ReturnType<typeof createWorkspace>>;

test.beforeEach(async ({ page, request }) => {
  activeWorkspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
});

test.describe("工作区导航与外观", () => {
  test("在 Diagram / Agent traces / Settings 之间切换，Copilot 保持在右侧面板", async ({ page }) => {
    const nav = page.locator('nav[aria-label="Workspace pages"]');
    await expect(nav.getByRole("button", { name: "Diagram" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "Layout Copilot" })).toHaveCount(0);
    await page.locator(".right-tabs").getByRole("tab", { name: "Copilot" }).click();
    await expect(page.locator(".right-copilot-panel")).toBeVisible();
    await page.getByRole("tab", { name: "Properties" }).click();
    await expect(page.locator(".inspector-section")).toBeVisible();

    await nav.getByRole("button", { name: "Agent traces" }).click();
    await expect(page.locator(".traces-workspace")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Agent trace" })).toBeVisible();
    await expect(page.locator(".trace-filters")).toContainText("Copilot");

    await nav.getByRole("button", { name: "Settings" }).click();
    await expect(page.locator(".settings-workspace")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await nav.getByRole("button", { name: "Diagram" }).click();
    await expect(page.locator(".canvas-stage")).toBeVisible();
  });

  test("切换到 Agent traces 再返回，原生 Draw.io 不重新加载", async ({ page }) => {
    const nav = page.locator('nav[aria-label="Workspace pages"]');
    const frame = nativeFrameHandle(page);
    const marker = "keep-alive-" + Date.now();
    await frame.evaluate((value) => {
      (window as unknown as { __studioKeepAlive?: string }).__studioKeepAlive = value;
    }, marker);
    let drawioDocumentLoads = 0;
    page.on("request", (request) => {
      if (request.url().includes("/drawio/index.html")) drawioDocumentLoads += 1;
    });
    await nav.getByRole("button", { name: "Agent traces" }).click();
    await expect(page.locator(".traces-workspace")).toBeVisible();
    await nav.getByRole("button", { name: "Diagram" }).click();
    const kept = await frame.evaluate(() => (window as unknown as { __studioKeepAlive?: string }).__studioKeepAlive);
    expect(kept).toBe(marker);
    expect(drawioDocumentLoads).toBe(0);
    await expect(page.locator(".status-native")).toContainText("Native editor ready");
  });

  test("选择图形主题只重着色 Draw.io XML，不改变应用主题或覆盖页面背景与网格", async ({ page, request }) => {
    const initialXml = await readWorkspaceXml(activeWorkspace);
    const documentXml = initialXml.replace('<mxGraphModel dx="1200"', '<mxGraphModel background="#FFFF66" dx="1200"');
    expect(documentXml).not.toBe(initialXml);
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { workspaceRevision?: string | null };
    const savedFixture = await request.put("/api/workspace/document", {
      data: { drawioXml: documentXml, label: "E2E native background fixture", baseRevision: state.workspaceRevision }
    });
    expect(savedFixture.status(), await savedFixture.text()).toBe(200);

    await page.reload();
    await waitForNativeEditor(page);
    const frame = nativeFrameHandle(page);
    const nativeBackground = () => frame.evaluate(() => {
      const page = document.querySelector<HTMLElement>(".geBackgroundPage");
      return {
        color: page ? getComputedStyle(page).backgroundColor : null,
        image: page ? getComputedStyle(page).backgroundImage : null,
        themeOverlay: Boolean(document.querySelector("#studio-native-theme"))
      };
    });
    await expect.poll(nativeBackground, { timeout: 20_000 }).toMatchObject({
      color: "rgb(255, 255, 102)",
      themeOverlay: false
    });
    const initialCanvas = await nativeBackground();
    expect(initialCanvas.image).not.toBe("none");

    await page.locator(".theme-selector .ant-select").click();
    await page.getByText("Vivid", { exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "warm");
    await expect.poll(async () => readWorkspaceXml(activeWorkspace), { timeout: 20_000 })
      .toContain("fillColor=#FCE7F3");
    await expect.poll(nativeBackground, { timeout: 20_000 }).toMatchObject({
      color: "rgb(255, 255, 102)",
      themeOverlay: false
    });
    expect((await nativeBackground()).image).not.toBe("none");

    await page.reload();
    await waitForNativeEditor(page);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "warm");
    const reloadedCanvas = await nativeFrameHandle(page).evaluate(() => {
      const page = document.querySelector<HTMLElement>(".geBackgroundPage");
      return {
        color: page ? getComputedStyle(page).backgroundColor : null,
        image: page ? getComputedStyle(page).backgroundImage : null,
        themeOverlay: Boolean(document.querySelector("#studio-native-theme"))
      };
    });
    expect(reloadedCanvas).toMatchObject({ color: "rgb(255, 255, 102)", themeOverlay: false });
    expect(reloadedCanvas.image).not.toBe("none");
    const savedXml = await readWorkspaceXml(activeWorkspace);
    expect(savedXml).toContain('background="#FFFF66"');
    expect(savedXml).toContain('grid="1"');
    expect(savedXml).toContain("fillColor=#FCE7F3");
  });

  test("服务端只保存模型与 reasoning 配置", async ({ page, request }) => {
    await page.locator('nav[aria-label="Workspace pages"]').getByRole("button", { name: "Settings" }).click();
    const configCard = page.locator(".settings-card").filter({ hasText: "GitHub Copilot SDK / Agent Runtime" });
    await expect(configCard).toBeVisible();
    const beforeResponse = await request.get("/api/workspace/configuration");
    expect(beforeResponse.ok()).toBe(true);
    const before = await beforeResponse.json() as { revisions: number; config: { model: string; reasoningEffort: "high" | "max" } };
    const nextEffort = before.config.reasoningEffort === "high" ? "max" : "high";
    const savedResponse = await request.put("/api/workspace/configuration", {
      data: { config: { model: before.config.model, reasoningEffort: nextEffort } }
    });
    expect(savedResponse.status()).toBe(200);
    const saved = await savedResponse.json() as { config: { model: string; reasoningEffort: "high" | "max" } };
    expect(saved.config.model).toBe(before.config.model);
    expect(saved.config.reasoningEffort).toBe(nextEffort);
    const verified = await (await request.get("/api/workspace/configuration")).json() as { revisions: number; config: { reasoningEffort: string } };
    expect(verified.revisions).toBe(before.revisions + 1);
    expect(verified.config.reasoningEffort).toBe(nextEffort);
  });
});
