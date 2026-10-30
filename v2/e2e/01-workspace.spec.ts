import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./support/test";
import { tempDir } from "./support/temp-dirs";
import {
  createWorkspace,
  nativeFrame,
  openStudio,
  openWorkspaceModal,
  readWorkspaceXml,
  waitForNativeEditor
} from "./support/fixtures";

test.describe("工作区引导", () => {
  test("首次启动通过弹窗创建 Draw.io，并把文件真实写入项目目录", async ({ page }) => {
    const rootPath = await tempDir("studio-e2e-bootstrap-");
    await openStudio(page);

    const dialog = await openWorkspaceModal(page);
    await dialog.getByRole("button", { name: "Create new Draw.io" }).click();
    await dialog.getByLabel("Workspace name").fill("E2E Payments");
    await dialog.getByLabel("Absolute path of the project directory").fill(rootPath);
    await dialog.getByLabel("New file name").fill("payments.drawio");
    await dialog.getByRole("button", { name: "Create diagram" }).click();

    await expect(dialog).toBeHidden();
    // The workspace identity lives in the topbar switch button now that the left panel is gone.
    await expect(page.locator(".workspace-switch")).toHaveAttribute("title", /E2E Payments/);
    await expect(page.locator(".document-breadcrumb")).toContainText("payments.drawio");
    await waitForNativeEditor(page);

    const written = await readFile(path.join(rootPath, "payments.drawio"), "utf8");
    expect(written).toContain("<mxfile");
    expect(written).toContain("<mxGraphModel");
    await expect(page.locator(".save-state")).toHaveText(/Saved · r\d+/);
  });

  test("扫描目录后打开已有的 Draw.io 文件并载入画布", async ({ page, request }) => {
    const workspace = await createWorkspace(request);
    const source = await readWorkspaceXml(workspace);
    const target = await tempDir("studio-e2e-open-");
    await writeFile(path.join(target, "orders.drawio"), source, "utf8");

    await openStudio(page);
    const dialog = await openWorkspaceModal(page);
    await dialog.getByLabel("Workspace name").fill("Orders Workspace");
    await dialog.getByLabel("Absolute path of the project directory").fill(target);
    await dialog.getByRole("button", { name: "Verify directory and scan" }).click();

    // The scan has to report the discovered diagram before the file picker fills.
    await expect(page.getByText(/1 files · 1 Draw\.io\/XML files/)).toBeVisible();
    const picker = page.getByRole("combobox", { name: "Draw.io file to open" });
    await picker.click();
    await picker.pressSequentially("orders");
    await page.locator(".ant-select-dropdown:visible .ant-select-item-option").filter({ hasText: "orders.drawio" }).click();
    await expect(picker).toHaveAccessibleName(/orders\.drawio/);
    await dialog.getByRole("button", { name: "Open diagram" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.locator(".document-breadcrumb")).toContainText("orders.drawio");
    await waitForNativeEditor(page);
    await expect(nativeFrame(page).getByText("API Service", { exact: true })).toBeVisible();
  });
});
