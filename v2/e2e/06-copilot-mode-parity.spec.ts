import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./support/test";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";
import { installFileSystemAccessMock } from "./support/file-system-access";

test("Copilot uses the XML-first contract in workspace and standalone modes", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const originalWorkspaceXml = await readWorkspaceXml(workspace);
  let intentCalls = 0;
  let ackCalls = 0;
  await page.route("**/api/copilot/intent/ack", async (route) => {
    ackCalls++;
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Retired endpoint" }) });
  });
  await page.route("**/api/copilot/intent", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as {
      standalone?: boolean; diagramXml?: string; sessionId?: string; documentRevision?: string;
    };
    intentCalls++;
    const standalone = body.standalone === true;
    const sourceXml = standalone ? String(body.diagramXml ?? "") : await readWorkspaceXml(workspace);
    const newLabel = standalone ? "Local Data Store" : "Workspace Data Store";
    const updatedXml = sourceXml.replace('value="Database"', 'value="' + newLabel + '"');
    expect(updatedXml).not.toBe(sourceXml);
    if (!standalone) {
      const save = await request.put("/api/workspace/document", {
        data: { drawioXml: updatedXml, label: "Workspace XML-first patch", baseRevision: String(body.documentRevision ?? "") }
      });
      expect(save.status(), await save.text()).toBe(200);
      const saved = await (await request.get("/api/workspace/state")).json() as { workspaceRevision: string };
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          outcome: "xml_committed", reply: "Renamed Database to Workspace Data Store.",
          requestId: "11111111-1111-4111-8111-111111111111",
          persistence: { workspaceRevision: saved.workspaceRevision },
          sessionId: body.sessionId || "mode-parity-session", model: "e2e-stub-model",
          provider: "github-copilot-sdk", durationMs: 1, toolsUsed: ["edit_drawio_xml"]
        })
      });
      return;
    }
    const patchedRevision = createHash("sha256").update(updatedXml, "utf8").digest("hex");
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        outcome: "xml_patch_ready", reply: "Renamed Database to Local Data Store.",
        requestId: "22222222-2222-4222-8222-222222222222",
        drawioXml: updatedXml, documentRevision: body.documentRevision,
        patchedRevision, changedCellIds: ["database"],
        sessionId: body.sessionId || "mode-parity-session", model: "e2e-stub-model",
        provider: "github-copilot-sdk", durationMs: 1, toolsUsed: ["edit_drawio_xml"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Rename Database to Workspace Data Store");
  await input.press("Enter");
  await expect(page.locator(".gemini-message.assistant").last()).toContainText("Renamed Database to Workspace Data Store");
  await expect(nativeFrame(page).getByText("Workspace Data Store", { exact: true })).toBeVisible();
  const savedWorkspaceXml = await readWorkspaceXml(workspace);
  expect(savedWorkspaceXml).not.toBe(originalWorkspaceXml);

  const standalonePath = path.join(workspace.rootPath, "standalone.drawio");
  await writeFile(standalonePath, originalWorkspaceXml, "utf8");
  await installFileSystemAccessMock(page, workspace.rootPath, [
    { name: "standalone.drawio", path: standalonePath, content: originalWorkspaceXml }
  ]);
  await page.getByRole("button", { name: "Open Draw.io" }).click();
  await expect.poll(async () => (await page.locator(".document-breadcrumb strong").textContent())?.trim() || "")
    .toBe("standalone.drawio");
  await waitForNativeEditor(page);
  await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();
  await expect(nativeFrame(page).getByText("Workspace Data Store", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: "Copilot" }).click();
  await input.fill("把 Database 改名为 Local Data Store");
  await input.press("Enter");
  await expect(page.locator(".gemini-message.assistant").last()).toContainText("Renamed Database to Local Data Store");
  await expect(nativeFrame(page).getByText("Local Data Store", { exact: true })).toBeVisible();
  await expect.poll(async () => readFile(standalonePath, "utf8")).toContain('value="Local Data Store"');
  expect(await readWorkspaceXml(workspace)).toBe(savedWorkspaceXml);
  expect(intentCalls).toBe(2);
  expect(ackCalls).toBe(0);
});

test("Standalone read-only inspection leaves the browser-owned file and local history unchanged", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const sourceXml = await readWorkspaceXml(workspace);
  const standalonePath = path.join(workspace.rootPath, "standalone-read-only.drawio");
  await writeFile(standalonePath, sourceXml, "utf8");
  await installFileSystemAccessMock(page, workspace.rootPath, [
    { name: "standalone-read-only.drawio", path: standalonePath, content: sourceXml }
  ]);
  await page.getByRole("button", { name: "Open Draw.io", exact: true }).click();
  await expect(page.locator(".document-breadcrumb strong")).toHaveText("standalone-read-only.drawio");
  await waitForNativeEditor(page);
  await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();

  const historyDialog = page.getByRole("dialog", { name: /Local Draw.io history/ });
  await page.getByRole("button", { name: "Local history", exact: true }).click();
  await expect(historyDialog).toBeVisible();
  const historyRows = historyDialog.locator('div[style*="overflow-y: auto"]').first().getByRole("button");
  const historyCountBefore = await historyRows.count();
  await page.keyboard.press("Escape");
  await expect(historyDialog).toBeHidden();

  const fileBefore = await readFile(standalonePath, "utf8");
  await page.route("**/api/copilot/intent", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        outcome: "answered",
        reply: "Read-only inspection completed: { cellCount: 4, pageId: \"page-1\" }",
        sessionId: "e2e-standalone-read-only", model: "stub-model", provider: "github-copilot-sdk",
        durationMs: 1, toolsUsed: ["inspect_drawio_graph"]
      })
    });
  });
  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Inspect the standalone native diagram without editing it");
  await input.press("Enter");
  await expect(page.locator(".gemini-message.assistant").last()).toContainText("Read-only inspection completed");
  await expect.poll(async () => readFile(standalonePath, "utf8")).toBe(fileBefore);

  await page.getByRole("button", { name: "Local history", exact: true }).click();
  await expect(historyDialog).toBeVisible();
  const historyCountAfter = await historyDialog.locator('div[style*="overflow-y: auto"]').first().getByRole("button").count();
  expect(historyCountAfter).toBe(historyCountBefore);
  await expect.poll(async () => readFile(standalonePath, "utf8")).toBe(fileBefore);
});
