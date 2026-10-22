import { expect, test } from "./support/test";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

/**
 * Drives the compound request through the real UI and the real native bridge.
 *
 * Only the model call is stubbed: the response is what the server produces for
 * `propose_native_edits`, so the browser-side batch execution, autosave and selection
 * are exercised end to end. The target cell id is observed from the canvas itself, which
 * is the same id the server would resolve from the request's diagram context.
 */
test("Copilot 原生编辑：一次请求里选中元素并把背景改成红色", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const versionsBefore = await (await request.get("/api/workspace/versions")).json() as { versions: unknown[] };
  const versionCountBefore = versionsBefore.versions.length;

  await page.evaluate(() => {
    const state = window as Window & { __studioSelection?: string[] };
    state.__studioSelection = [];
    window.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) as { event?: string; cellId?: string } : event.data as { event?: string; cellId?: string };
        if (data?.event === "studioSelectionChanged" && data.cellId) state.__studioSelection?.push(data.cellId);
      } catch { /* Ignore unrelated messages. */ }
    });
  });

  // Selecting in the canvas yields the authoritative cell id and clears it of ambiguity.
  await nativeFrame(page).getByText("Database", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const selection = (window as Window & { __studioSelection?: string[] }).__studioSelection ?? [];
    return selection[selection.length - 1] ?? null;
  })).toMatch(/database/i);
  const cellId = await page.evaluate(() => {
    const selection = (window as Window & { __studioSelection?: string[] }).__studioSelection ?? [];
    return selection[selection.length - 1];
  });

  let seenPrompt = "";
  await page.route("**/api/copilot/intent", async (route) => {
    seenPrompt = String((JSON.parse(route.request().postData() || "{}") as { prompt?: unknown }).prompt ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commands: [],
        reply: "Renamed Database to Primary Database and changed its background to red.",
        nativeEdits: {
          operations: [
            { op: "select", target: "Database", cellId, targetLabel: "Database" },
            { op: "set_label", target: "Database", cellId, targetLabel: "Database", label: "Primary Database" },
            { op: "set_style", target: "Database", cellId, targetLabel: "Database", key: "fillColor", color: "#ff0000" }
          ],
          summary: "Select “Database”; Rename “Database” to “Primary Database”; Set fillColor of “Database” to #ff0000",
          requiresClientExecution: true
        },
        sessionId: "e2e-native-edits",
        model: "stub-model",
        provider: "github-copilot-sdk",
        durationMs: 1,
        toolsUsed: ["propose_native_edits"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("选中 Database 并改成红色背景");
  await input.press("Enter");

  const lastMessage = page.locator(".gemini-message.assistant").last();
  await expect(lastMessage).toContainText("Applied 3 native changes");
  await expect(lastMessage).toContainText("#ff0000");
  await expect(nativeFrame(page).getByText("Primary Database", { exact: true })).toBeVisible();
  expect(seenPrompt).toContain("红色背景");

  // The native editor applied the batch, so the authoritative file must carry both the new label and fill.
  await expect.poll(async () => {
    const xml = await readWorkspaceXml(workspace);
    const cell = new RegExp('<mxCell\\b[^>]*id="' + cellId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^>]*>').exec(xml);
    return Boolean(cell && /fillColor=#ff0000/.test(cell[0]) && /value="Primary Database"/.test(cell[0]));
  }, { timeout: 20_000 }).toBe(true);

  // Workspace edits are versioned on the server; local snapshots are only for standalone files.
  await expect.poll(async () => {
    const result = await request.get("/api/workspace/versions");
    const payload = await result.json() as { versions: unknown[] };
    return payload.versions.length;
  }, { timeout: 20_000 }).toBeGreaterThan(versionCountBefore);

  // The selection step reached the canvas as UI state, not as a document mutation.
  await expect.poll(() => page.evaluate((id) => (window as Window & { __studioSelection?: string[] }).__studioSelection?.includes(id) ?? false, cellId), { timeout: 20_000 }).toBe(true);
});


test("Copilot 原生编辑：存在未知 XML 属性时仍可在节点后新增并连接", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  const stateResponse = await request.get("/api/workspace/state");
  expect(stateResponse.ok()).toBe(true);
  const state = await stateResponse.json() as { drawioXml: string; workspaceRevision: string };
  // Add an opaque native-only attribute to verify unrelated XML survives an add-and-connect edit.
  const nativeXml = state.drawioXml.replace('<mxCell id="1"', '<mxCell id="1" nativeCustom="preserve-me"');
  expect(nativeXml).not.toBe(state.drawioXml);
  const savedNativeXml = await request.put("/api/workspace/document", {
    data: { drawioXml: nativeXml, label: "Native-only metadata fixture", baseRevision: state.workspaceRevision }
  });
  expect(savedNativeXml.status(), await savedNativeXml.text()).toBe(200);

  await openStudio(page);
  await waitForNativeEditor(page);
  await page.evaluate(() => {
    const state = window as Window & { __studioSelection?: string[] };
    state.__studioSelection = [];
    window.addEventListener("message", (event) => {
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) as { event?: string; cellId?: string } : event.data as { event?: string; cellId?: string };
        if (data?.event === "studioSelectionChanged" && data.cellId) state.__studioSelection?.push(data.cellId);
      } catch { /* Ignore unrelated messages. */ }
    });
  });
  await nativeFrame(page).getByText("Database", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const selection = (window as Window & { __studioSelection?: string[] }).__studioSelection ?? [];
    return selection[selection.length - 1] ?? null;
  })).toBeTruthy();
  const observedCellId = await page.evaluate(() => {
    const selection = (window as Window & { __studioSelection?: string[] }).__studioSelection ?? [];
    return selection[selection.length - 1] ?? null;
  });
  expect(observedCellId).toBeTruthy();

  let seenPrompt = "";
  await page.route("**/api/copilot/intent", async (route) => {
    seenPrompt = String((JSON.parse(route.request().postData() || "{}") as { prompt?: unknown }).prompt ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commands: [],
        reply: "Added bbb after Database and connected it.",
        nativeEdits: {
          operations: [
            { op: "add_node_after", target: "Database", cellId: observedCellId, targetLabel: "Database", newLabel: "bbb" }
          ],
          summary: "Add “bbb” after “Database” and connect it",
          requiresClientExecution: true
        },
        sessionId: "e2e-native-add-after",
        model: "stub-model",
        provider: "github-copilot-sdk",
        durationMs: 1,
        toolsUsed: ["propose_native_edits"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("把 Database 后面加上一个新元素 bbb，然后连接起来");
  await input.press("Enter");

  const lastMessage = page.locator(".gemini-message.assistant").last();
  await expect(lastMessage).toContainText("Applied 1 native change");
  await expect(lastMessage).toContainText("bbb");
  expect(seenPrompt).toContain("Database");

  await expect.poll(async () => {
    const xml = await readWorkspaceXml(workspace);
    const node = /<mxCell\b(?=[^>]*\bvalue="bbb")(?=[^>]*\bvertex="1")[^>]*>/.exec(xml);
    if (!node) return false;
    const nodeId = /\bid="([^"]+)"/.exec(node[0])?.[1];
    if (!nodeId || !observedCellId) return false;
    const edges = Array.from(xml.matchAll(/<mxCell\b[^>]*\bedge="1"[^>]*>/g), (match) => match[0]);
    const connected = edges.some((edge) => edge.includes('source="' + observedCellId + '"') && edge.includes('target="' + nodeId + '"'));
    return connected && xml.includes('nativeCustom="preserve-me"');
  }, { timeout: 20_000 }).toBe(true);
});


test("Copilot 原生编辑：完整批次在未知属性存在时保留新增、重命名、移动、删除的结果", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  const stateResponse = await request.get("/api/workspace/state");
  expect(stateResponse.ok()).toBe(true);
  const state = await stateResponse.json() as { drawioXml: string; workspaceRevision: string };
  const nativeXml = state.drawioXml
    .replace('<mxCell id="1"', '<mxCell id="1" nativeCustom="preserve-me"')
    .replace('<mxCell id="client"', '<mxCell id="client" vendorCellFlag="opaque-client"');
  expect(nativeXml).not.toBe(state.drawioXml);
  const saved = await request.put("/api/workspace/document", {
    data: { drawioXml: nativeXml, label: "Native edit regression fixture", baseRevision: state.workspaceRevision }
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await openStudio(page);
  await waitForNativeEditor(page);

  let seenPrompt = "";
  await page.route("**/api/copilot/intent", async (route) => {
    seenPrompt = String((JSON.parse(route.request().postData() || "{}") as { prompt?: unknown }).prompt ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        commands: [],
        reply: "Renamed API Service, moved Background Worker, removed Message Queue, and added bbb after Database.",
        nativeEdits: {
          operations: [
            { op: "set_label", target: "API Service", cellId: "api", targetLabel: "API Service", label: "API Gateway" },
            { op: "move", target: "Background Worker", cellId: "worker", targetLabel: "Background Worker", dx: 45, dy: -10 },
            { op: "delete", target: "Message Queue", cellId: "queue", targetLabel: "Message Queue" },
            { op: "add_node_after", target: "Database", cellId: "database", targetLabel: "Database", newLabel: "bbb" }
          ],
          summary: "Rename API Service; move Background Worker; delete Message Queue; add bbb after Database and connect it",
          requiresClientExecution: true
        },
        sessionId: "e2e-native-mixed-batch",
        model: "stub-model",
        provider: "github-copilot-sdk",
        durationMs: 1,
        toolsUsed: ["propose_native_edits"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("把 API Service 改名为 API Gateway，把 Background Worker 向右移动 45、向上移动 10，删除 Message Queue，并在 Database 后新增 bbb 然后连接起来");
  await input.press("Enter");

  const lastMessage = page.locator(".gemini-message.assistant").last();
  await expect(lastMessage).toContainText("Applied 4 native changes");
  await expect(nativeFrame(page).getByText("API Gateway", { exact: true })).toBeVisible();
  await expect(nativeFrame(page).getByText("bbb", { exact: true })).toBeVisible();
  expect(seenPrompt).toContain("Background Worker");

  await expect.poll(async () => {
    const xml = await readWorkspaceXml(workspace);
    const apiCell = /<mxCell\b(?=[^>]*\bid="api")(?=[^>]*\bvalue="API Gateway")[^>]*>/.exec(xml);
    const workerCell = /<mxCell\b(?=[^>]*\bid="worker")[^>]*>[\s\S]*?<mxGeometry\b([^>]*)/.exec(xml);
    const clientCell = /<mxCell\b(?=[^>]*\bid="client")[^>]*>[\s\S]*?<mxGeometry\b([^>]*)/.exec(xml);
    const node = /<mxCell\b(?=[^>]*\bvalue="bbb")(?=[^>]*\bvertex="1")[^>]*>/.exec(xml);
    if (!apiCell || !workerCell || !clientCell || !node) return false;
    const nodeId = /\bid="([^"]+)"/.exec(node[0])?.[1];
    const geometry = workerCell[1];
    const x = /\bx="([-.\d]+)"/.exec(geometry)?.[1];
    const y = /\by="([-.\d]+)"/.exec(geometry)?.[1];
    const clientGeometry = clientCell[1];
    const clientX = /\bx="([-.\d]+)"/.exec(clientGeometry)?.[1];
    const edges = Array.from(xml.matchAll(/<mxCell\b[^>]*\bedge="1"[^>]*>/g), (match) => match[0]);
    const connected = Boolean(nodeId && edges.some((edge) => edge.includes('source="database"') && edge.includes('target="' + nodeId + '"')));
    return x === "785" && y === "260" && clientX === "60" && connected &&
      !/\bid="queue"\b/.test(xml) && !/\bid="api-queue"\b/.test(xml) && !/\bid="queue-worker"\b/.test(xml) &&
      xml.includes('nativeCustom="preserve-me"') && xml.includes('vendorCellFlag="opaque-client"') &&
      xml.includes('agent="Architecture Diagram Studio E2E"') &&
      xml.includes('<diagram id="page-1" name="E2E diagram"') &&
      /\bvalue="Database"\b/.test(xml);
  }, { timeout: 20_000 }).toBe(true);
});
