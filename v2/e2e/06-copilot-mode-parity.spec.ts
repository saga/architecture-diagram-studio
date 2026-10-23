import { expect, test } from "./support/test";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

test("Copilot uses the same server intent contract while standalone edits stay out of workspace persistence", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const originalWorkspaceXml = await readWorkspaceXml(workspace);

  let intentCalls = 0;
  const seenPrompts: string[] = [];
  const acknowledgementCalls: Array<Record<string, unknown>> = [];
  await page.route("**/api/copilot/intent/ack", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
    acknowledgementCalls.push(body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: body.outcome,
        requestId: body.requestId,
        documentRevision: body.serializedXmlRevision ?? null,
        persistedRevision: body.persistedRevision ?? null,
        versionId: body.versionId ?? null
      })
    });
  });
  await page.route("**/api/copilot/intent", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as {
      standalone?: boolean;
      prompt?: string;
      sessionId?: string;
      documentRevision?: string;
      context?: { activePageId?: string | null };
    };
    intentCalls++;
    seenPrompts.push(String(body.prompt ?? ""));
    const standalone = body.standalone === true;
    const newLabel = standalone ? "Local Data Store" : "Workspace Data Store";
    const requestId = standalone
      ? "22222222-2222-4222-8222-222222222222"
      : "11111111-1111-4111-8111-111111111111";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        reply: "Rename Database to " + newLabel,
        sessionId: body.sessionId || "mode-parity-session",
        nativeEdits: {
          operations: [{
            op: "set_label",
            target: "Database",
            cellId: "database",
            targetLabel: "Database",
            label: newLabel
          }],
          summary: "Rename Database to " + newLabel,
          pageId: body.context?.activePageId ?? null,
          documentRevision: body.documentRevision,
          requestId
        },
        model: "e2e-stub-model",
        provider: "github-copilot-sdk",
        durationMs: 1,
        toolsUsed: ["propose_native_edits"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Rename Database to Workspace Data Store");
  await input.press("Enter");
  await expect(page.locator(".gemini-message.assistant").last()).toContainText("Applied 1 native change");
  await expect(nativeFrame(page).getByText("Workspace Data Store", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readWorkspaceXml(workspace)).includes('value="Workspace Data Store"')).toBe(true);
  const savedWorkspaceXml = await readWorkspaceXml(workspace);
  expect(savedWorkspaceXml).not.toBe(originalWorkspaceXml);

  // Provide a deterministic File System Access handle so the test exercises the standalone-file adapter.
  await page.evaluate((xml) => {
    const file = new File([xml], "standalone.drawio", { type: "application/xml" });
    Object.defineProperty(window, "__mockStandaloneFileSavedXml", { configurable: true, writable: true, value: xml });
    const handle = {
      name: file.name,
      getFile: async () => file,
      createWritable: async () => ({
        write: async (value: string) => {
          (window as Window & { __mockStandaloneFileSavedXml?: string }).__mockStandaloneFileSavedXml = value;
        },
        close: async () => undefined
      })
    };
    Object.defineProperty(window, "showOpenFilePicker", {
      configurable: true, writable: true,
      value: async () => [handle]
    });
  }, originalWorkspaceXml);
  await page.getByRole("button", { name: "Open Draw.io" }).click();
  await expect.poll(async () => {
    const name = (await page.locator(".document-breadcrumb strong").textContent())?.trim() || "";
    if (name === "standalone.drawio") return name;
    const status = (await page.locator(".status-left").textContent())?.trim() || "";
    const diagnostics = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("architecture-diagram-studio:v2:diagnostic-traces") || "[]";
        const entries = JSON.parse(raw) as Array<{ event?: string; message?: string; details?: unknown }>;
        return entries.filter((entry) => typeof entry.event === "string" && entry.event.startsWith("drawio.open.standalone"))
          .slice(-4).map((entry) => ({ event: entry.event, message: entry.message, details: entry.details }));
      } catch { return []; }
    });
    return name + " | lastAction=" + status + " | openDiagnostics=" + JSON.stringify(diagnostics);
  }, { timeout: 15_000 }).toBe("standalone.drawio");
  await waitForNativeEditor(page);
  await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();
  await expect(nativeFrame(page).getByText("Workspace Data Store", { exact: true })).toHaveCount(0);

  let workspaceDocumentWrites = 0;
  await page.route("**/api/workspace/document", async (route) => {
    workspaceDocumentWrites++;
    await route.continue();
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  await input.fill("把 Database 改名为 Local Data Store");
  await input.press("Enter");
  await expect(page.locator(".gemini-message.assistant").last()).toContainText("Applied 1 native change");
  await expect(nativeFrame(page).getByText("Local Data Store", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readWorkspaceXml(workspace)).includes('value="Workspace Data Store"')).toBe(true);
  await expect.poll(async () => page.evaluate(() =>
    (window as Window & { __mockStandaloneFileSavedXml?: string }).__mockStandaloneFileSavedXml || ""
  )).toContain('value="Local Data Store"');

  expect(intentCalls).toBe(2);
  expect(seenPrompts).toEqual([
    "Rename Database to Workspace Data Store",
    "把 Database 改名为 Local Data Store"
  ]);
  expect(acknowledgementCalls).toHaveLength(2);
  expect(acknowledgementCalls[0]?.standalone).toBe(false);
  expect(acknowledgementCalls[1]?.standalone).toBe(true);
  expect(acknowledgementCalls[0]?.versionId).toEqual(expect.any(String));
  expect(acknowledgementCalls[1]?.persistenceStatus).toBe("not_managed_by_server");
  expect(acknowledgementCalls[1]?.versionId).toBeNull();
  expect(workspaceDocumentWrites).toBe(0);
  expect(await readWorkspaceXml(workspace)).toBe(savedWorkspaceXml);
});

test("Copilot reports native editor success separately when workspace persistence fails", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const sourceXml = await readWorkspaceXml(workspace);
  let acknowledgement: Record<string, unknown> | null = null;

  await page.route("**/api/copilot/intent/ack", async (route) => {
    acknowledgement = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: acknowledgement.outcome,
        requestId: acknowledgement.requestId,
        documentRevision: acknowledgement.serializedXmlRevision ?? null,
        persistedRevision: acknowledgement.persistedRevision ?? null,
        versionId: acknowledgement.versionId ?? null
      })
    });
  });
  await page.route("**/api/copilot/intent", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as {
      documentRevision?: string;
      sessionId?: string;
      context?: { activePageId?: string | null };
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        reply: "Rename Database to Unsaved Data Store",
        sessionId: body.sessionId || "save-failure-session",
        nativeEdits: {
          operations: [{
            op: "set_label",
            target: "Database",
            cellId: "database",
            targetLabel: "Database",
            label: "Unsaved Data Store"
          }],
          summary: "Rename Database to Unsaved Data Store",
          pageId: body.context?.activePageId ?? null,
          documentRevision: body.documentRevision,
          requestId: "33333333-3333-4333-8333-333333333333"
        },
        model: "e2e-stub-model",
        provider: "github-copilot-sdk",
        durationMs: 1,
        toolsUsed: ["propose_native_edits"]
      })
    });
  });
  await page.route("**/api/workspace/document", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected workspace save failure" })
      });
      return;
    }
    await route.continue();
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Rename Database to Unsaved Data Store");
  await input.press("Enter");

  const receipt = page.locator(".gemini-message.assistant").last();
  await expect(receipt).toContainText("workspace save was not confirmed");
  await expect(receipt).not.toContainText("Applied 1 native change");
  await expect(nativeFrame(page).getByText("Unsaved Data Store", { exact: true })).toBeVisible();
  expect(acknowledgement).toMatchObject({
    outcome: "failed",
    failureStage: "persistence",
    persistenceStatus: "failed",
    editorAcknowledged: true
  });
  expect(await readWorkspaceXml(workspace)).toBe(sourceXml);
});

