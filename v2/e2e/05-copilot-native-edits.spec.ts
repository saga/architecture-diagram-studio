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
  await page.route("**/api/copilot/intent/ack", async (route) => {
    const acknowledgement = JSON.parse(route.request().postData() || "{}") as {
      requestId?: string; outcome?: string; serializedXmlRevision?: string | null;
      persistedRevision?: string | null; versionId?: string | null;
    };
    await route.fulfill({
      status: 200, contentType: "application/json",
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
    const requestBody = JSON.parse(route.request().postData() || "{}") as {
      prompt?: unknown; documentRevision?: unknown;
      context?: { activePageId?: string | null };
    };
    seenPrompt = String(requestBody.prompt ?? "");
    const pageId = requestBody.context?.activePageId ?? null;
    const documentRevision = String(requestBody.documentRevision ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        commands: [],
        reply: "Renamed Database to Primary Database and changed its background to red.",
        nativeEdits: {
          operations: [
            { op: "select", target: "Database", cellId, targetLabel: "Database" },
            { op: "set_label", target: "Database", cellId, targetLabel: "Database", label: "Primary Database" },
            { op: "set_style", target: "Database", cellId, targetLabel: "Database", key: "fillColor", color: "#ff0000" }
          ],
          summary: "Select “Database”; Rename “Database” to “Primary Database”; Set fillColor of “Database” to #ff0000",
          requestId: "11111111-1111-4111-8111-111111111111",
          pageId,
          documentRevision
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
  await page.route("**/api/copilot/intent/ack", async (route) => {
    const acknowledgement = JSON.parse(route.request().postData() || "{}") as {
      requestId?: string; outcome?: string; serializedXmlRevision?: string | null;
      persistedRevision?: string | null; versionId?: string | null;
    };
    await route.fulfill({
      status: 200, contentType: "application/json",
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
    const requestBody = JSON.parse(route.request().postData() || "{}") as {
      prompt?: unknown; documentRevision?: unknown;
      context?: { activePageId?: string | null };
    };
    seenPrompt = String(requestBody.prompt ?? "");
    const pageId = requestBody.context?.activePageId ?? null;
    const documentRevision = String(requestBody.documentRevision ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        commands: [],
        reply: "The edit is accepted; please confirm the preview before it is written to the canvas.",
        nativeEdits: {
          operations: [
            { op: "add_node_after", target: observedCellId, cellId: observedCellId, targetLabel: "Database", newLabel: "bbb" }
          ],
          summary: "Add “bbb” after “Database” and connect it",
          requestId: "22222222-2222-4222-8222-222222222222",
          pageId,
          documentRevision
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
  await expect(lastMessage).toContainText("Add “bbb” to the right of “Database” and connect it");
  await expect(lastMessage).not.toContainText(/preview|confirm/i);
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


test("Copilot executes a direct native Draw.io script without a review proposal", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);

  const drawioPort = process.env.STUDIO_E2E_DRAWIO_PORT || "5181";
  const drawioIndex = await request.get("http://127.0.0.1:" + drawioPort + "/index.html");
  expect(drawioIndex.ok()).toBe(true);
  const drawioCsp = drawioIndex.headers()["content-security-policy"];
  const studioOrigin = new URL(page.url()).origin;
  expect(drawioCsp).toContain("connect-src 'self'");
  expect(drawioCsp).toContain("img-src 'self' data: blob:");
  const frameAncestors = /frame-ancestors ([^;]+)/.exec(drawioCsp)?.[1]?.split(/\s+/) ?? [];
  expect(frameAncestors).toContain(studioOrigin);
  expect(drawioCsp).not.toContain("localhost:*");
  expect(drawioCsp).not.toContain("127.0.0.1:*");
  const nativeEditor = page.locator('iframe[title="Native Draw.io editor"]');
  expect(new URL(await nativeEditor.getAttribute("src") || page.url()).origin).not.toBe(new URL(page.url()).origin);
  expect(await nativeEditor.getAttribute("sandbox")).toContain("allow-scripts");
  expect(await nativeEditor.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith("http://127.0.0.1:" + drawioPort + "/"))).toBe(true);
  const isolatedFrame = page.frames().find((frame) => frame.url().startsWith("http://127.0.0.1:" + drawioPort + "/"));
  expect(isolatedFrame).toBeTruthy();
  if (!isolatedFrame) throw new Error("The isolated Draw.io frame did not become available.");
  const studioApiUrl = new URL("/api/workspace/config", page.url()).toString();
  const isolationCheck = await isolatedFrame.evaluate(async (apiUrl) => {
    let parentDomAccessible = true;
    try { void window.parent.document.documentElement; } catch { parentDomAccessible = false; }
    let studioApiReachable = false;
    try {
      const response = await fetch(apiUrl);
      studioApiReachable = response.ok;
    } catch { /* CSP connect-src 'self' should block a cross-origin Studio API request. */ }
    return { parentDomAccessible, studioApiReachable };
  }, studioApiUrl);
  expect(isolationCheck.parentDomAccessible).toBe(false);
  expect(isolationCheck.studioApiReachable).toBe(false);

  const scriptMarker = "AI_SCRIPT_EXECUTED_73491";
  await page.route("**/api/copilot/intent/ack", async (route) => {
    const acknowledgement = JSON.parse(route.request().postData() || "{}") as Record<string, unknown>;
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
    const requestBody = JSON.parse(route.request().postData() || "{}") as {
      sessionId?: string;
      documentRevision?: unknown;
      context?: { activePageId?: string | null };
    };
    const script = [
      "var parent = graph.getDefaultParent();",
      "var created = graph.insertVertex(parent, null, '" + scriptMarker + "', 120, 180, 160, 60, 'rounded=1;whiteSpace=wrap;html=1;');",
      "graph.refresh();",
      "return { cellId: created.id, label: graph.convertValueToString(created) };"
    ].join("\n");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        reply: "Executing a direct native Draw.io script.",
        nativeEdits: {
          operations: [{
            op: "run_drawio_script",
            target: "active_page",
            summary: "Add a native Draw.io vertex",
            script,
            cellId: "__active_page__",
            targetLabel: "active Draw.io page"
          }],
          summary: "Add a native Draw.io vertex",
          requestId: "55555555-5555-4555-8555-555555555555",
          pageId: requestBody.context?.activePageId ?? null,
          documentRevision: String(requestBody.documentRevision ?? "")
        },
        sessionId: requestBody.sessionId || "e2e-native-script",
        model: "stub-model", provider: "github-copilot-sdk", durationMs: 1,
        toolsUsed: ["run_drawio_script"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Add one native vertex");
  await input.press("Enter");

  const resultMessage = page.locator(".gemini-message.assistant").last();
  await expect(resultMessage).toContainText("Applied 1 native change");
  await expect(resultMessage).toContainText("Add a native Draw.io vertex");
  await expect(page.getByRole("button", { name: "Confirm changes" })).toHaveCount(0);
  await expect(nativeFrame(page).getByText(scriptMarker, { exact: true })).toBeVisible();
  await expect.poll(async () => (await readWorkspaceXml(workspace)).includes(scriptMarker)).toBe(true);
});
test("Copilot 原生编辑：两个下置连接节点通过 typed operations 自动执行", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);

  await page.route("**/api/copilot/intent/ack", async (route) => {
    const acknowledgement = JSON.parse(route.request().postData() || "{}") as {
      requestId?: string; outcome?: string; serializedXmlRevision?: string | null;
      persistedRevision?: string | null; versionId?: string | null;
    };
    await route.fulfill({
      status: 200, contentType: "application/json",
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
    const requestBody = JSON.parse(route.request().postData() || "{}") as {
      prompt?: unknown; documentRevision?: unknown; context?: { activePageId?: string | null };
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        reply: "Added ddd below Database and eee below API Service.",
        nativeEdits: {
          operations: [
            { op: "add_node_below", target: "Database", cellId: "database", targetLabel: "Database", newLabel: "ddd" },
            { op: "add_node_below", target: "API Service", cellId: "api", targetLabel: "API Service", newLabel: "eee" }
          ],
          summary: "Add ddd below Database and eee below API Service; connect each new node to its source",
          requestId: "44444444-4444-4444-8444-444444444444",
          pageId: requestBody.context?.activePageId ?? null,
          documentRevision: String(requestBody.documentRevision ?? "")
        },
        sessionId: "e2e-native-add-below",
        model: "stub-model", provider: "github-copilot-sdk", durationMs: 1,
        toolsUsed: ["propose_native_edits"]
      })
    });
  });

  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("在 Database 和 API Service 下方分别新增 ddd 和 eee，并连接各自来源节点");
  await input.press("Enter");

  const lastMessage = page.locator(".gemini-message.assistant").last();
  await expect(lastMessage).toContainText("Applied 2 native changes");
  await expect(lastMessage).toContainText('Add “ddd” below “Database” and connect it');
  await expect(lastMessage).toContainText('Add “eee” below “API Service” and connect it');
  await expect(page.getByRole("button", { name: "Confirm changes" })).toHaveCount(0);

  const frame = nativeFrame(page);
  await expect(frame.getByText("ddd", { exact: true })).toBeVisible();
  await expect(frame.getByText("eee", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const xml = await readWorkspaceXml(workspace);
    const geometry = (matcher: RegExp) => {
      const cell = matcher.exec(xml)?.[0];
      const attributes = cell ? /<mxGeometry\b([^>]*)/.exec(cell)?.[1] : undefined;
      const x = attributes ? Number(/\bx="([- .\d]+)"/.exec(attributes)?.[1]) : NaN;
      const y = attributes ? Number(/\by="([- .\d]+)"/.exec(attributes)?.[1]) : NaN;
      const width = attributes ? Number(/\bwidth="([- .\d]+)"/.exec(attributes)?.[1]) : NaN;
      const height = attributes ? Number(/\bheight="([- .\d]+)"/.exec(attributes)?.[1]) : NaN;
      return { x, y, width, height, id: cell ? /\bid="([^"]+)"/.exec(cell)?.[1] : undefined };
    };
    const database = geometry(/<mxCell\b(?=[^>]*\bid="database")[^>]*>[\s\S]*?<mxGeometry\b[^>]*[\s\S]*?<\/mxCell>/);
    const api = geometry(/<mxCell\b(?=[^>]*\bid="api")[^>]*>[\s\S]*?<mxGeometry\b[^>]*[\s\S]*?<\/mxCell>/);
    const ddd = geometry(/<mxCell\b(?=[^>]*\bvalue="ddd")(?=[^>]*\bvertex="1")[^>]*>[\s\S]*?<mxGeometry\b[^>]*[\s\S]*?<\/mxCell>/);
    const eee = geometry(/<mxCell\b(?=[^>]*\bvalue="eee")(?=[^>]*\bvertex="1")[^>]*>[\s\S]*?<mxGeometry\b[^>]*[\s\S]*?<\/mxCell>/);
    if (![database, api, ddd, eee].every((cell) => Number.isFinite(cell.x) && Number.isFinite(cell.y) && Number.isFinite(cell.height) && Boolean(cell.id))) return false;
    const edges = Array.from(xml.matchAll(/<mxCell\b[^>]*\bedge="1"[^>]*>/g), (match) => match[0]);
    const dddConnected = edges.some((edge) => edge.includes('source="database"') && edge.includes('target="' + ddd.id + '"'));
    const eeeConnected = edges.some((edge) => edge.includes('source="api"') && edge.includes('target="' + eee.id + '"'));
    return dddConnected && eeeConnected &&
      ddd.y >= database.y + database.height && eee.y >= api.y + api.height &&
      Math.abs((ddd.x + ddd.width / 2) - (database.x + database.width / 2)) < 1 &&
      Math.abs((eee.x + eee.width / 2) - (api.x + api.width / 2)) < 1;
  }, { timeout: 20_000, intervals: [250] }).toBe(true);
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
  await page.route("**/api/copilot/intent/ack", async (route) => {
    const acknowledgement = JSON.parse(route.request().postData() || "{}") as {
      requestId?: string; outcome?: string; serializedXmlRevision?: string | null;
      persistedRevision?: string | null; versionId?: string | null;
    };
    await route.fulfill({
      status: 200, contentType: "application/json",
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
    const requestBody = JSON.parse(route.request().postData() || "{}") as {
      prompt?: unknown; documentRevision?: unknown;
      context?: { activePageId?: string | null };
    };
    seenPrompt = String(requestBody.prompt ?? "");
    const pageId = requestBody.context?.activePageId ?? null;
    const documentRevision = String(requestBody.documentRevision ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
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
          requestId: "33333333-3333-4333-8333-333333333333",
          pageId,
          documentRevision
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
      !/\bid="queue"/.test(xml) && !/\bid="api-queue"/.test(xml) && !/\bid="queue-worker"/.test(xml) &&
      xml.includes('nativeCustom="preserve-me"') && xml.includes('vendorCellFlag="opaque-client"') &&
      xml.includes('pageWidth="1200"') && xml.includes('pageScale="1"') &&
      xml.includes('<diagram id="page-1" name="E2E diagram"') &&
      xml.includes('value="Database"');
  }, { timeout: 20_000 }).toBe(true);
});

test("Copilot bulk destructive edits execute without a confirmation proposal", async ({ page, request }) => {
  const workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);

  await page.route("**/api/copilot/intent/ack", async (route) => {
    const acknowledgement = JSON.parse(route.request().postData() || "{}") as {
      requestId?: string; outcome?: string; serializedXmlRevision?: string | null;
      persistedRevision?: string | null; versionId?: string | null;
    };
    await route.fulfill({
      status: 200, contentType: "application/json",
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
      documentRevision?: unknown; context?: { activePageId?: string | null }; sessionId?: string;
    };
    const pageId = body.context?.activePageId ?? null;
    const documentRevision = String(body.documentRevision ?? "");
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        outcome: "command_ready",
        reply: "Delete API Service and Message Queue.",
        sessionId: "e2e-proposal-session",
        nativeEdits: {
          operations: [
            { op: "delete", target: "API Service", cellId: "api", targetLabel: "API Service" },
            { op: "delete", target: "Message Queue", cellId: "queue", targetLabel: "Message Queue" }
          ],
          summary: "Delete “API Service”; Delete “Message Queue”",
          pageId, documentRevision, requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        },
        model: "stub-model", provider: "github-copilot-sdk", durationMs: 1, toolsUsed: ["propose_native_edits"]
      })
    });
  });
  await page.getByRole("tab", { name: "Copilot" }).click();
  const input = page.locator('textarea[placeholder^="Describe the change"]');
  await input.fill("Delete API Service and Message Queue");
  await input.press("Enter");

  const resultMessage = page.locator(".gemini-message.assistant").last();
  await expect(resultMessage).toContainText("Applied 2 native changes");
  await expect(page.getByRole("button", { name: "Confirm changes" })).toHaveCount(0);
  await expect(nativeFrame(page).getByText("API Service", { exact: true })).toHaveCount(0);
  await expect(nativeFrame(page).getByText("Message Queue", { exact: true })).toHaveCount(0);
  await expect.poll(async () => {
    const xml = await readWorkspaceXml(workspace);
    return !/\bid="api"/.test(xml) && !/\bid="queue"/.test(xml);
  }, { timeout: 20_000 }).toBe(true);
});

