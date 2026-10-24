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

  test("导出通过 Node.js fs 写入所选目录中的原生 Draw.io XML", async ({ page }) => {
    await page.getByRole("button", { name: /Export/ }).click();
    const dialog = page.getByRole("dialog", { name: "Export Draw.io copy" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Export file name" }).fill("architecture-export.drawio");
    await dialog.getByRole("button", { name: "Export file" }).click();

    const exported = await readFile(path.join(workspace.rootPath, "architecture-export.drawio"), "utf8");
    expect(exported).toContain("<mxfile");
    expect(exported).toContain("Database");
    await expect(page.locator(".status-left")).toContainText("Exported native Draw.io XML to");
  });

  test("导入本地 .drawio 文件后画布与工作区文件都更新", async ({ page }) => {
    const source = await readWorkspaceXml(workspace);
    const renamed = source.replace("Database", "Edge Gateway");
    expect(renamed).not.toBe(source);
    const importPath = path.join(workspace.rootPath, "incoming.drawio");
    await writeFile(importPath, renamed, "utf8");

    await page.getByRole("button", { name: /Import/ }).click();
    const dialog = page.getByRole("dialog", { name: "Import Draw.io file" });
    await expect(dialog).toBeVisible();
    await dialog.locator("button").filter({ hasText: "incoming.drawio" }).click();

    await expect(nativeFrame(page).getByText("Edge Gateway", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await readWorkspaceXml(workspace)).includes("Edge Gateway"), { timeout: 30_000, intervals: [500] })
      .toBe(true);
  });

  test("打开本地 Draw.io 后通过 Node.js 自动保存，不再依赖浏览器文件写入权限", async ({ page }) => {
    const source = await readWorkspaceXml(workspace);
    const changed = source.replace('value="Database"', 'value="NodeFS Save"');
    expect(changed).not.toBe(source);
    const importedPath = path.join(workspace.rootPath, "standalone-update.drawio");
    await writeFile(importedPath, changed, "utf8");

    await page.getByRole("button", { name: "Open Draw.io", exact: true }).click();
    const openDialog = page.getByRole("dialog", { name: "Open Draw.io file" });
    await expect(openDialog).toBeVisible();
    await openDialog.locator("button").filter({ hasText: "architecture.drawio" }).click();
    await expect(page.locator(".status-left")).toContainText("direct Node.js autosave enabled");

    await page.getByRole("button", { name: /Import/ }).click();
    const importDialog = page.getByRole("dialog", { name: "Import Draw.io file" });
    await expect(importDialog).toBeVisible();
    await importDialog.locator("button").filter({ hasText: "standalone-update.drawio" }).click();

    await expect(nativeFrame(page).getByText("NodeFS Save", { exact: true })).toBeVisible();
    await expect.poll(async () => (await readWorkspaceXml(workspace)).includes("NodeFS Save"), { timeout: 30_000, intervals: [500] }).toBe(true);
  });

  test("服务端拒绝格式错误的原生 XML，且不改动文件和 revision", async ({ request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml: string; workspaceRevision: string };
    const before = await readWorkspaceXml(workspace);

    const invalid = await request.put("/api/workspace/document", {
      data: {
        drawioXml: '<mxfile><diagram id="broken">',
        label: "Invalid XML must not persist",
        baseRevision: state.workspaceRevision
      }
    });
    expect(invalid.status()).toBe(400);
    expect(await readWorkspaceXml(workspace)).toBe(before);

    const afterResponse = await request.get("/api/workspace/state");
    expect(afterResponse.ok()).toBe(true);
    const after = await afterResponse.json() as { drawioXml: string; workspaceRevision: string };
    expect(after.drawioXml).toBe(state.drawioXml);
    expect(after.workspaceRevision).toBe(state.workspaceRevision);
  });

  test("服务端拒绝过期 revision，且不覆盖更新后的 XML", async ({ request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml: string; workspaceRevision: string };

    const latestXml = state.drawioXml.replace('value="Database"', 'value="Primary Database"');
    expect(latestXml).not.toBe(state.drawioXml);
    const latestSave = await request.put("/api/workspace/document", {
      data: { drawioXml: latestXml, label: "Current revision", baseRevision: state.workspaceRevision }
    });
    expect(latestSave.status(), await latestSave.text()).toBe(200);
    const savedRevision = (await latestSave.json() as { workspaceRevision: string }).workspaceRevision;

    const staleXml = state.drawioXml.replace('value="Database"', 'value="Stale overwrite"');
    const staleSave = await request.put("/api/workspace/document", {
      data: { drawioXml: staleXml, label: "Stale revision must not persist", baseRevision: state.workspaceRevision }
    });
    expect(staleSave.status()).toBe(409);

    expect(await readWorkspaceXml(workspace)).toBe(latestXml);
    const afterResponse = await request.get("/api/workspace/state");
    expect(afterResponse.ok()).toBe(true);
    const after = await afterResponse.json() as { drawioXml: string; workspaceRevision: string };
    expect(after.drawioXml).toBe(latestXml);
    expect(after.workspaceRevision).toBe(savedRevision);
  });

});
