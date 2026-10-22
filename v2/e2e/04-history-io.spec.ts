import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./support/test";
import type { WorkspaceFixture } from "./support/fixtures";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

let workspace: WorkspaceFixture;

test.beforeEach(async ({ page, request }) => {
  workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
});

test.describe("版本历史与文件交换", () => {
  test("版本历史列出服务端快照并可以恢复到创建时的空文档", async ({ page }) => {
    await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "History" }).click();
    const dialog = page.getByRole("dialog", { name: "Server version history" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/E2E native Draw.io fixture/)).toBeVisible();

    // Each version row is a flex container; match the row by its label, not by index.
    const createdRow = dialog.locator('div[style*="display: flex"]').filter({ hasText: "Created diagram: architecture.drawio" });
    await expect(createdRow).toHaveCount(1);
    await createdRow.getByRole("button", { name: "Restore" }).click();

    await expect(dialog).toBeHidden();

    // The restore status line is transient: the native autosave that follows the reload
    // replaces it with its own sync message. Assert the durable outcome instead.
    await expect(nativeFrame(page).getByText("Database", { exact: true })).toHaveCount(0);
    await expect
      .poll(async () => (await readWorkspaceXml(workspace)).includes("Database"), { timeout: 30_000, intervals: [500] })
      .toBe(false);

    // Restoring appends a new server snapshot that points back at the source version.
    await page.getByRole("button", { name: "History" }).click();
    await expect(dialog.getByText(/Restored version: Created diagram: architecture\.drawio/)).toBeVisible();
  });

  test("导出会下载当前原生 Draw.io XML", async ({ page }) => {
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    const download = await downloadPromise;

    // The exported file name follows the active native Draw.io file.
    expect(download.suggestedFilename()).toMatch(/\.drawio$/);
    const exported = await readFile((await download.path())!, "utf8");
    expect(exported).toContain("<mxfile");
    expect(exported).toContain("Database");
    await expect(page.locator(".status-left")).toContainText("Exported the native .drawio file");
  });

  test("导入本地 .drawio 文件后画布与工作区文件都更新", async ({ page }) => {
    const source = await readWorkspaceXml(workspace);
    const renamed = source.replace("Database", "Edge Gateway");
    expect(renamed).not.toBe(source);
    const importPath = path.join(workspace.rootPath, "incoming.drawio");
    await writeFile(importPath, renamed, "utf8");

    await page.locator('input[type="file"][accept=".drawio,.xml,application/xml,text/xml"]').setInputFiles(importPath);

    await expect(nativeFrame(page).getByText("Edge Gateway", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await readWorkspaceXml(workspace)).includes("Edge Gateway"), { timeout: 30_000, intervals: [500] })
      .toBe(true);
  });
});
