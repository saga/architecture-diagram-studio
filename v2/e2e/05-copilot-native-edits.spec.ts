import { expect, test } from "./support/test";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

test("Copilot edits the authoritative Draw.io XML and refreshes the editor", async ({ page, request }) => {
  await createWorkspace(request);
  const initial = await (await request.get("/api/workspace/state")).json() as { drawioXml: string; workspaceRevision: string };
  const secondPage = '<diagram id="copied-page" name="Duplicated page"><mxGraphModel><root>' +
    '<mxCell id="copy-prefix-0"/><mxCell id="copy-prefix-1" parent="copy-prefix-0"/>' +
    '<mxCell id="copy-marker" value="Copied page marker" vertex="1" parent="copy-prefix-1"><mxGeometry x="80" y="80" width="120" height="50" as="geometry"/></mxCell>' +
    '</root></mxGraphModel></diagram>';
  const fixtureXml = initial.drawioXml.replace("</mxfile>", secondPage + "</mxfile>");
  const fixtureSave = await request.put("/api/workspace/document", {
    data: { drawioXml: fixtureXml, label: "XML-first multi-page fixture", baseRevision: initial.workspaceRevision }
  });
  expect(fixtureSave.status(), await fixtureSave.text()).toBe(200);

  await openStudio(page);
  await waitForNativeEditor(page);
  let ackCalls = 0;
  await page.route("**/api/copilot/intent/ack", async (route) => {
    ackCalls++;
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Retired endpoint" }) });
  });
  await page.route("**/api/copilot/intent", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}") as {
      diagramXml?: string; documentRevision?: string; sessionId?: string;
    };
    const sourceXml = String(body.diagramXml ?? "");
    expect(sourceXml).toContain('id="copied-page"');
    const updatedXml = sourceXml.replace('value="Database"', 'value="Primary Database"');
    expect(updatedXml).not.toBe(sourceXml);
    const save = await request.put("/api/workspace/document", {
      data: { drawioXml: updatedXml, label: "Copilot XML-first patch", baseRevision: String(body.documentRevision ?? "") }
    });
    expect(save.status(), await save.text()).toBe(200);
    const saved = await (await request.get("/api/workspace/state")).json() as { drawioXml: string; workspaceRevision: string };
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        outcome: "xml_committed",
        reply: "Applied the server-side XML patch and refreshed the current document.",
        requestId: "55555555-5555-4555-8555-555555555555",
        persistence: { workspaceRevision: saved.workspaceRevision },
        sessionId: body.sessionId || "e2e-xml-first-commit",
        model: "stub-model", provider: "github-copilot-sdk", durationMs: 1,
        toolsUsed: ["edit_drawio_xml"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Rename Database to Primary Database");
  await input.press("Enter");
  await expect(page.locator(".gemini-message.assistant").last()).toContainText("Applied the server-side XML patch");
  await expect(nativeFrame(page).getByText("Primary Database", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const saved = await (await request.get("/api/workspace/state")).json() as { drawioXml: string };
    return saved.drawioXml.includes('id="copied-page"') &&
      saved.drawioXml.includes('id="copy-prefix-0"') &&
      saved.drawioXml.includes('id="copy-prefix-1"') &&
      saved.drawioXml.includes('value="Copied page marker"') &&
      saved.drawioXml.includes('value="Primary Database"');
  }).toBe(true);
  expect(ackCalls).toBe(0);
});

test("Copilot reports a rejected XML patch without claiming that a change was applied", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const xmlBefore = await readWorkspaceXml(workspace);
  let ackCalls = 0;
  await page.route("**/api/copilot/intent/ack", async (route) => {
    ackCalls++;
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Retired endpoint" }) });
  });
  await page.route("**/api/copilot/intent", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        outcome: "failed",
        reply: "Nothing was applied because the XML patch failed validation.",
        error: "The requested cell could not be resolved in the current document revision.",
        sessionId: "e2e-rejected-xml-patch", model: "stub-model", provider: "github-copilot-sdk",
        durationMs: 1, toolsUsed: ["edit_drawio_xml"]
      })
    });
  });
  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Apply an XML patch against a missing cell");
  await input.press("Enter");
  const resultMessage = page.locator(".gemini-message.assistant").last();
  await expect(resultMessage).toContainText("Nothing was applied");
  await expect(resultMessage).not.toContainText("diagram has changed");
  await expect.poll(async () => readWorkspaceXml(workspace)).toBe(xmlBefore);
  expect(ackCalls).toBe(0);
});

test("Read-only Copilot inspection does not change XML or workspace history", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const xmlBefore = await readWorkspaceXml(workspace);
  const versionsBefore = await (await request.get("/api/workspace/versions")).json() as { versions: unknown[] };
  await page.route("**/api/copilot/intent", async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        outcome: "answered",
        reply: "Read-only inspection completed: { cellCount: 4, pageId: \"page-1\" }",
        sessionId: "e2e-read-only-inspection", model: "stub-model", provider: "github-copilot-sdk",
        durationMs: 1, toolsUsed: ["inspect_drawio_graph"]
      })
    });
  });
  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Inspect the native cell count without changing the diagram");
  await input.press("Enter");
  const resultMessage = page.locator(".gemini-message.assistant").last();
  await expect(resultMessage).toContainText("Read-only inspection completed");
  await expect(resultMessage).toContainText("cellCount");
  await expect.poll(async () => readWorkspaceXml(workspace)).toBe(xmlBefore);
  const versionsAfter = await (await request.get("/api/workspace/versions")).json() as { versions: unknown[] };
  expect(versionsAfter.versions).toHaveLength(versionsBefore.versions.length);
});