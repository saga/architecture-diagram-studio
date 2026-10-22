import { expect, test } from "./support/test";
import type { WorkspaceFixture } from "./support/fixtures";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

let workspace: WorkspaceFixture;

test.beforeEach(async ({ page, request }) => {
  workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  await expect(nativeFrame(page).getByText("API Service", { exact: true })).toBeVisible();
});

/** Reads the x coordinate of the first cell whose id contains the given fragment. */
function cellX(xml: string, fragment: string): number | null {
  const cell = new RegExp('id="([^"]*' + fragment + '[^"]*)"').exec(xml);
  if (!cell) return null;
  const geometry = new RegExp('id="' + cell[1] + '"[^>]*>\\s*<mxGeometry x="([-\\d.]+)"').exec(xml);
  return geometry ? Number(geometry[1]) : null;
}

test.describe("原生画布", () => {
  test("加载工作区的 Draw.io 文件并渲染全部节点", async ({ page }) => {
    const frame = nativeFrame(page);
    for (const label of ["Client", "API Service", "Background Worker", "Message Queue", "Database"]) {
      await expect(frame.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.locator(".status-right")).toContainText("5 nodes");
    await expect(page.locator(".status-right")).toContainText("4 relations");
    await expect(page.locator(".drawio-error-banner")).toHaveCount(0);
    await expect(page.locator(".drawio-inline-hint")).toContainText("edits autosave back into Studio");
  });

  test("拖动节点会把新的几何信息写回工作区文件", async ({ page }) => {
    const before = await readWorkspaceXml(workspace);
    const beforeX = cellX(before, "client");
    expect(beforeX).not.toBeNull();

    const label = nativeFrame(page).getByText("Client", { exact: true });
    const box = await label.boundingBox();
    expect(box, "the Client node must be rendered before it can be dragged").not.toBeNull();

    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 40, startY + 16, { steps: 8 });
    await page.mouse.move(startX + 140, startY + 56, { steps: 12 });
    await page.mouse.up();

    await expect
      .poll(async () => cellX(await readWorkspaceXml(workspace), "client"), { timeout: 30_000, intervals: [500] })
      .not.toBe(beforeX);
    await expect(page.locator(".status-left")).toContainText("Synced changes from native Draw.io");
  });

  test("刷新页面后画布恢复到拖动后的版本", async ({ page }) => {
    const label = nativeFrame(page).getByText("Client", { exact: true });
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 120, box!.y + box!.height / 2 + 40, { steps: 14 });
    await page.mouse.up();

    const beforeReload = await readWorkspaceXml(workspace);
    await expect
      .poll(async () => (await readWorkspaceXml(workspace)) !== beforeReload, { timeout: 30_000, intervals: [500] })
      .toBe(true);
    const draggedX = cellX(await readWorkspaceXml(workspace), "client");

    await page.reload();
    await waitForNativeEditor(page);
    await expect(nativeFrame(page).getByText("Client", { exact: true })).toBeVisible();
    // The reload must not roll the file back to the pre-drag geometry.
    expect(cellX(await readWorkspaceXml(workspace), "client")).toBe(draggedX);
  });

  test.fixme("选中画布元素后右侧切换到原生 Draw.io 属性面板", async ({ page }) => {
    // The bundled Draw.io v32 exposes neither `window.editorUi` nor a
    // selectionChanged embed event, so DrawioFrame never receives a cell id and the
    // panel keeps showing semantic properties. Tracked as a product gap, not a test defect.
    await nativeFrame(page).getByText("Database", { exact: true }).click();
    const inspector = page.locator(".native-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector).toContainText("Element properties");
  });
});
