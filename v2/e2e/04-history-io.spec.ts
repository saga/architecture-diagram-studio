import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./support/test";
import type { WorkspaceFixture } from "./support/fixtures";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";
import { installFileSystemAccessMock, setNextBrowserFile } from "./support/file-system-access";

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

  test("导出使用浏览器原生保存选择器写入 Draw.io XML", async ({ page }) => {
    await installFileSystemAccessMock(page, workspace.rootPath, []);
    await page.getByRole("button", { name: /Export/ }).click();

    const exportedPath = path.join(workspace.rootPath, "architecture-export.drawio");
    await expect.poll(async () => readFile(exportedPath, "utf8").catch(() => ""), { timeout: 15_000 }).toContain("<mxfile");
    const exported = await readFile(exportedPath, "utf8");
    expect(exported).toContain("Database");
    await expect(page.locator(".status-left")).toContainText("Exported native Draw.io XML to architecture-export.drawio");
  });

  test("导入使用浏览器原生文件选择器读取 XML，工作区模式仍由 Node.js 持久化", async ({ page }) => {
    const source = await readWorkspaceXml(workspace);
    const renamed = source.replace("Database", "Edge Gateway");
    expect(renamed).not.toBe(source);
    const importPath = path.join(workspace.rootPath, "incoming.drawio");
    await writeFile(importPath, renamed, "utf8");
    await installFileSystemAccessMock(page, workspace.rootPath, [
      { name: "incoming.drawio", path: importPath, content: renamed }
    ]);

    await page.getByRole("button", { name: /Import/ }).click();

    await expect(nativeFrame(page).getByText("Edge Gateway", { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await readWorkspaceXml(workspace)).includes("Edge Gateway"), { timeout: 30_000, intervals: [500] })
      .toBe(true);
  });

  test("standalone 打开使用浏览器句柄读写，Node.js 只保存 XML 历史快照", async ({ page }) => {
    const source = await readWorkspaceXml(workspace);
    const changed = source.replace('value="Database"', 'value="Browser Handle Save"');
    expect(changed).not.toBe(source);
    const importedPath = path.join(workspace.rootPath, "standalone-update.drawio");
    await writeFile(importedPath, changed, "utf8");
    const primaryPath = path.join(workspace.rootPath, "architecture.drawio");
    await installFileSystemAccessMock(page, workspace.rootPath, [
      { name: "architecture.drawio", path: primaryPath, content: source },
      { name: "standalone-update.drawio", path: importedPath, content: changed }
    ]);

    await page.getByRole("button", { name: "Open Draw.io", exact: true }).click();
    await expect(page.locator(".document-breadcrumb strong")).toHaveText("architecture.drawio");
    await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();

    await setNextBrowserFile(page, "standalone-update.drawio");
    await page.getByRole("button", { name: /Import/ }).click();

    await expect(nativeFrame(page).getByText("Browser Handle Save", { exact: true })).toBeVisible();
    await expect.poll(async () => (await readFile(primaryPath, "utf8")).includes("Browser Handle Save"), {
      timeout: 30_000, intervals: [500]
    }).toBe(true);
    await expect(page.locator(".document-breadcrumb .save-state")).toHaveText("Saved to file");
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

  test("服务端检测主图文件的外部修改，不覆盖磁盘上的新内容", async ({ request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml: string; workspaceRevision: string };
    const diskPath = path.join(workspace.rootPath, "architecture.drawio");
    const originalDiskXml = await readFile(diskPath, "utf8");
    const externalXml = originalDiskXml.replace('value="Database"', 'value="External Editor Update"');
    expect(externalXml).not.toBe(originalDiskXml);
    await writeFile(diskPath, externalXml, "utf8");

    const localXml = state.drawioXml.replace('value="Database"', 'value="Local Studio Save"');
    expect(localXml).not.toBe(state.drawioXml);
    const save = await request.put("/api/workspace/document", {
      data: { drawioXml: localXml, label: "Must not overwrite external edit", baseRevision: state.workspaceRevision }
    });
    expect(save.status()).toBe(409);
    expect(await readFile(diskPath, "utf8")).toBe(externalXml);
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
