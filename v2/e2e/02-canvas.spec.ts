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
  const escaped = fragment.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const cells = Array.from(xml.matchAll(/<mxCell\b([^>]*)>([\s\S]*?)<\/mxCell>/g));
  const cell = cells.find((match) => new RegExp('\\bid="[^"]*' + escaped + '[^"]*"').test(match[1]));
  if (!cell) return null;
  const geometry = /<mxGeometry\b([^>]*)\/?\s*>/.exec(cell[2]);
  const x = geometry && /\bx="([-.\d]+)"/.exec(geometry[1]);
  return x ? Number(x[1]) : null;
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

  test("选中画布元素后可以查看并编辑原生 Draw.io 属性", async ({ page }) => {
    // Selection is bridged from Draw.io's supported plugin entry point; no private
    // editorUi global or non-standard embed event is assumed.
    await nativeFrame(page).getByText("Database", { exact: true }).click();

    const inspector = page.locator(".native-inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.locator(".native-inspector-heading")).toContainText("Element properties");
    // The inspector reads the native XML, not the semantic projection.
    // The native XML value may contain HTML label markup; the inspector deliberately
    // preserves it rather than silently flattening or rewriting user content.
    await expect(inspector.locator(".native-property-field textarea").first()).toHaveValue(/Database/);

    // Editing through the inspector has to reach the same file the canvas autosaves into.
    const before = cellX(await readWorkspaceXml(workspace), "database");
    expect(before).not.toBeNull();
    const xField = inspector.locator('.native-inspector-group').filter({ hasText: "Geometry" }).locator('label.native-property-field:has(span:text-is("x")) input');
    await xField.fill(String(before! + 40));
    await xField.press("Tab");
    await expect
      .poll(async () => cellX(await readWorkspaceXml(workspace), "database"), { timeout: 30_000, intervals: [500] })
      .toBe(before! + 40);
  });
});
