import { expect, test } from "./support/test";
import { decodeDrawioPageXml } from "../src/model/drawio-xml-schema";
import { parseDrawioXml } from "../src/model/drawio-xml-dom";
import type { WorkspaceFixture } from "./support/fixtures";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

let workspace: WorkspaceFixture;

test.beforeEach(async ({ page, request }) => {
  workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  const editorFrame = page.locator('iframe[title="Native Draw.io editor"]');
  // noSaveBtn=1 alone replaces Save with Save and Exit; keep saveAndExit=0 explicit.
  await expect(editorFrame).toHaveAttribute("src", /saveAndExit=0&noSaveBtn=1&noExitBtn=1/);
  await expect(nativeFrame(page).getByText("API Service", { exact: true })).toBeVisible();
});

/** Reads geometry from native mxCells, handling both compressed and uncompressed Draw.io pages. */
function cellPosition(xml: string, fragment: string): { x: number; y: number } | null {
  try {
    const source = parseDrawioXml(xml);
    const documentRoot = source.documentElement;
    const models: Element[] = [];
    if (documentRoot.nodeName === "mxGraphModel") {
      models.push(documentRoot as unknown as Element);
    } else if (documentRoot.nodeName === "mxfile") {
      for (const page of Array.from(documentRoot.getElementsByTagName("diagram"))) {
        const inlineModel = page.getElementsByTagName("mxGraphModel").item(0);
        if (inlineModel) {
          models.push(inlineModel);
          continue;
        }
        const payload = (page.textContent || "").trim();
        if (!payload) continue;
        try {
          const decoded = parseDrawioXml(decodeDrawioPageXml(payload));
          if (decoded.documentElement.nodeName === "mxGraphModel") {
            models.push(decoded.documentElement as unknown as Element);
          }
        } catch { /* Ignore unsupported pages and keep checking other pages. */ }
      }
    }
    const needle = fragment.toLocaleLowerCase();
    for (const model of models) {
      for (const cell of Array.from(model.getElementsByTagName("mxCell"))) {
        const id = cell.getAttribute("id") || "";
        const label = cell.getAttribute("value") || "";
        if (!id.toLocaleLowerCase().includes(needle) && !label.toLocaleLowerCase().includes(needle)) continue;
        const geometry = cell.getElementsByTagName("mxGeometry").item(0);
        if (!geometry) continue;
        const x = Number(geometry.getAttribute("x"));
        const y = Number(geometry.getAttribute("y"));
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cellX(xml: string, fragment: string): number | null {
  return cellPosition(xml, fragment)?.x ?? null;
}

/** Returns all native edge styles from inline or compressed Draw.io pages. */
function edgeStyles(xml: string): string[] {
  try {
    const source = parseDrawioXml(xml);
    const documentRoot = source.documentElement;
    const models: Element[] = [];
    if (documentRoot.nodeName === "mxGraphModel") {
      models.push(documentRoot as unknown as Element);
    } else if (documentRoot.nodeName === "mxfile") {
      for (const page of Array.from(documentRoot.getElementsByTagName("diagram"))) {
        const inlineModel = page.getElementsByTagName("mxGraphModel").item(0);
        if (inlineModel) {
          models.push(inlineModel);
          continue;
        }
        const payload = (page.textContent || "").trim();
        if (!payload) continue;
        try {
          const decoded = parseDrawioXml(decodeDrawioPageXml(payload));
          if (decoded.documentElement.nodeName === "mxGraphModel") {
            models.push(decoded.documentElement as unknown as Element);
          }
        } catch { /* Continue with the other pages. */ }
      }
    }
    return models.flatMap((model) =>
      Array.from(model.getElementsByTagName("mxCell"))
        .filter((cell) => cell.getAttribute("edge") === "1")
        .map((cell) => cell.getAttribute("style") || "")
    );
  } catch {
    return [];
  }
}

test.describe("原生画布", () => {
  test("加载工作区的 Draw.io 文件并渲染全部节点", async ({ page }) => {
    const frame = nativeFrame(page);
    for (const label of ["Client", "API Service", "Background Worker", "Message Queue", "Database"]) {
      await expect(frame.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.locator(".drawio-error-banner")).toHaveCount(0);
    // The autosave contract lives in the status tooltip so the bar stays one short line.
    await expect(page.locator(".status-native")).toHaveAttribute("title", /AI scripts use the live editor API and save through Studio/);
  });

  test("图形主题直接重着色 Draw.io XML，保持应用主题、页面背景和网格", async ({ page, request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml?: string | null; workspaceRevision?: string | null };
    const initialXml = typeof state.drawioXml === "string" ? state.drawioXml : await readWorkspaceXml(workspace);
    const documentXml = initialXml.replace(/<mxGraphModel\\b/, '<mxGraphModel background="#FFFF66"');
    expect(documentXml).not.toBe(initialXml);
    const savedFixture = await request.put("/api/workspace/document", {
      data: { drawioXml: documentXml, label: "E2E native background fixture", baseRevision: state.workspaceRevision }
    });
    expect(savedFixture.status(), await savedFixture.text()).toBe(200);

    await page.reload();
    await waitForNativeEditor(page);
    const inspectCanvas = async () => {
      const frame = page.frames().find((candidate) => candidate.url().includes("/drawio/index.html"));
      if (!frame) return null;
      return frame.evaluate(() => {
        const page = document.querySelector<HTMLElement>(".geBackgroundPage");
        return {
          color: page ? getComputedStyle(page).backgroundColor : null,
          image: page ? getComputedStyle(page).backgroundImage : null,
          themeOverlay: Boolean(document.querySelector("#studio-native-theme"))
        };
      });
    };
    await expect.poll(inspectCanvas, { timeout: 20_000 }).toMatchObject({
      color: "rgb(255, 255, 102)",
      themeOverlay: false
    });
    expect((await inspectCanvas())?.image).not.toBe("none");

    await page.locator(".theme-selector .ant-select").click();
    await page.getByText("Vivid", { exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "warm");
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 20_000 })
      .toContain("fillColor=#FCE7F3");
    await expect.poll(inspectCanvas, { timeout: 20_000 }).toMatchObject({
      color: "rgb(255, 255, 102)",
      themeOverlay: false
    });
    expect((await inspectCanvas())?.image).not.toBe("none");

    await page.reload();
    await waitForNativeEditor(page);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "warm");
    const reloadedCanvas = await inspectCanvas();
    expect(reloadedCanvas).toMatchObject({ color: "rgb(255, 255, 102)", themeOverlay: false });
    expect(reloadedCanvas?.image).not.toBe("none");
    const savedXml = await readWorkspaceXml(workspace);
    expect(savedXml).toContain('background="#FFFF66"');
    expect(savedXml).toContain('grid="1"');
    expect(savedXml).toContain("fillColor=#FCE7F3");
  });

  test("自动布局按钮调用原生 Draw.io 布局并保存重排结果", async ({ page }) => {
    const ids = ["client", "api", "worker", "queue", "database"];
    const beforeXml = await readWorkspaceXml(workspace);
    const beforePositions = ids.map((id) => cellPosition(beforeXml, id));
    expect(beforePositions.every((position) => position !== null)).toBe(true);

    const autoLayoutButton = page.getByRole("button", { name: "Auto layout", exact: true });
    await expect(autoLayoutButton).toBeEnabled();
    await autoLayoutButton.click();

    // The click is only successful when Draw.io returns the post-layout XML and workspace
    // persistence writes geometry changes; a present-but-inert toolbar button must fail here.
    await expect.poll(async () => {
      const afterXml = await readWorkspaceXml(workspace);
      const afterPositions = ids.map((id) => cellPosition(afterXml, id));
      return afterPositions.every((position) => position !== null) &&
        afterPositions.some((position, index) =>
          position !== null && beforePositions[index] !== null &&
          (position.x !== beforePositions[index]!.x || position.y !== beforePositions[index]!.y));
    }, { timeout: 30_000, intervals: [500] }).toBe(true);

    const frame = nativeFrame(page);
    for (const label of ["Client", "API Service", "Background Worker", "Message Queue", "Database"]) {
      await expect(frame.getByText(label, { exact: true })).toBeVisible();
    }
  });

  test("布局工具栏恢复引擎和方向下拉设置，以及横向纵向快捷布局", async ({ page }) => {
    await expect(page.getByRole("combobox", { name: "Layout engine" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Layout direction" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Horizontal layout" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Vertical layout" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Advanced layout settings" })).toBeEnabled();

    const ids = ["client", "api", "worker", "queue", "database"];
    const beforeXml = await readWorkspaceXml(workspace);
    const beforePositions = ids.map((id) => cellPosition(beforeXml, id));
    expect(beforePositions.every((position) => position !== null)).toBe(true);

    await page.getByRole("button", { name: "Vertical layout" }).click();
    await expect.poll(async () => {
      const afterXml = await readWorkspaceXml(workspace);
      const afterPositions = ids.map((id) => cellPosition(afterXml, id));
      return afterPositions.every((position) => position !== null) &&
        afterPositions.some((position, index) =>
          position !== null && beforePositions[index] !== null && position.y !== beforePositions[index]!.y);
    }, { timeout: 30_000, intervals: [500] }).toBe(true);

    await page.getByRole("button", { name: "Advanced layout settings" }).click();
    await expect(page.getByRole("dialog", { name: "Layout settings" })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Node spacing" })).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Layer spacing" })).toBeVisible();
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
    await expect(page.locator(".status-left")).toContainText("Synced native Draw.io changes");
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
    // The inspector reads and writes the native XML directly.
    // The native XML value may contain HTML label markup; the inspector deliberately
    // preserves it rather than silently flattening or rewriting user content.
    await expect(inspector.locator(".native-property-field textarea").first()).toHaveValue(/Database/);

    // Editing through the inspector has to reach the same file the canvas autosaves into.
    const before = cellX(await readWorkspaceXml(workspace), "database");
    expect(before).not.toBeNull();
    await page.evaluate(() => {
      const target = window as Window & { __studioPropertyResults?: Array<Record<string, unknown>> };
      target.__studioPropertyResults = [];
      window.addEventListener("message", (event) => {
        try {
          const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
          if (data?.event === "studioPropertyEditResult") target.__studioPropertyResults?.push(data);
        } catch { /* Ignore unrelated Draw.io protocol messages. */ }
      });
    });
    const xField = inspector.locator('.native-inspector-group').filter({ hasText: "Geometry" }).locator('label.native-property-field:has(span:text-is("x")) input');
    await xField.fill(String(before! + 40));
    await xField.press("Tab");
    const propertyResult = await page.waitForFunction(() => {
      const target = window as Window & { __studioPropertyResults?: Array<Record<string, unknown>> };
      return target.__studioPropertyResults?.at(-1) ?? false;
    }, { timeout: 5_000 }).then((handle) => handle.jsonValue()) as { success?: boolean; error?: string } | false;
    expect(propertyResult && propertyResult.success, propertyResult && propertyResult.error ? propertyResult.error : "No native property edit result was received").toBe(true);
    try {
      await expect
        .poll(async () => cellX(await readWorkspaceXml(workspace), "database"), { timeout: 30_000, intervals: [500] })
        .toBe(before! + 40);
    } catch (error) {
      const diagnostics = await page.evaluate(() => {
        try {
          const entries = JSON.parse(localStorage.getItem("architecture-diagram-studio:v2:diagnostic-traces") || "[]");
          return Array.isArray(entries) ? entries.filter((entry) =>
            typeof entry?.event === "string" && (entry.event.includes("bridge") || entry.event.includes("property") || entry.event.includes("xml"))
          ).slice(-20) : [];
        } catch { return []; }
      });
      throw new Error(String(error) + "\\nNative property diagnostics: " + JSON.stringify(diagnostics));
    }
  });
  test("Copilot 可以通过通用原生脚本修改 Draw.io 连线样式", async ({ page }) => {
    const before = await readWorkspaceXml(workspace);
    expect(edgeStyles(before).length, "fixture should contain native connector cells").toBeGreaterThan(0);

    const result = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.drawio-iframe");
      if (!frame?.contentWindow) throw new Error("Native Draw.io iframe is unavailable");
      const requestId = 938272;
      const script = `
        const edges = [];
        function collect(parent) {
          const count = model.getChildCount(parent);
          for (let i = 0; i < count; i += 1) {
            const cell = model.getChildAt(parent, i);
            if (cell && cell.edge) edges.push(cell);
            collect(cell);
          }
        }
        collect(model.getRoot());
        if (!edges.length) throw new Error("No connector cells found on the active page");
        graph.setCellStyles("edgeStyle", "orthogonalEdgeStyle", edges);
        graph.setCellStyles("curved", "1", edges);
        graph.refresh();
        if (graph.view && typeof graph.view.validate === "function") graph.view.validate();
        const stylesVerified = edges.every((edge) => {
          const style = model.getStyle(edge) || "";
          return /(?:^|;)edgeStyle=orthogonalEdgeStyle(?:;|$)/.test(style) && /(?:^|;)curved=1(?:;|$)/.test(style);
        });
        const renderedEdges = edges.slice(0, 20).map((edge) => {
          const state = graph.view && typeof graph.view.getState === "function" ? graph.view.getState(edge) : null;
          return { id: edge.id, stateAvailable: Boolean(state), pointCount: state && state.absolutePoints ? state.absolutePoints.length : 0 };
        });
        return { affectedEdges: edges.length, stylesVerified, renderedEdges };
      `;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", receive);
          reject(new Error("Timed out waiting for native script acknowledgement"));
        }, 8000);
        const receive = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow) return;
          let data: Record<string, unknown>;
          try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
          catch { return; }
          if (data?.event !== "studioPropertyEditResult" || data.requestId !== requestId) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", receive);
          resolve(data);
        };
        window.addEventListener("message", receive);
      });
      frame.contentWindow.postMessage(JSON.stringify({
        event: "studioPropertyEditRequest",
        requestId,
        cellId: "__batch__",
        path: "cell:batch",
        value: JSON.stringify([{ cellId: "__active_page__", path: "cell:execute-script", value: script }])
      }), new URL(frame.src).origin);
      return response;
    });

    expect(result.success, String(result.error || "The native Draw.io script was not executed")).toBe(true);
    expect(result.scriptResult).toMatchObject({
      available: true,
      value: { affectedEdges: expect.any(Number), stylesVerified: true, renderedEdges: expect.any(Array) }
    });
    await expect.poll(async () => {
      const styles = edgeStyles(await readWorkspaceXml(workspace));
      return styles.length > 0 && styles.every((style) => /(?:^|;)curved=1(?:;|$)/.test(style));
    }, { timeout: 30_000, intervals: [500] }).toBe(true);
  });

  test("通用原生脚本抛错时会回滚新建的节点", async ({ page }) => {
    const before = await readWorkspaceXml(workspace);
    const result = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.drawio-iframe");
      if (!frame?.contentWindow) throw new Error("Native Draw.io iframe is unavailable");
      const requestId = 938273;
      const script = 'graph.insertVertex(graph.getDefaultParent(), null, "Temporary script node", 100, 100, 120, 60); throw new Error("intentional rollback");';
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", receive);
          reject(new Error("Timed out waiting for native script rollback acknowledgement"));
        }, 8000);
        const receive = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow) return;
          let data: Record<string, unknown>;
          try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
          catch { return; }
          if (data?.event !== "studioPropertyEditResult" || data.requestId !== requestId) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", receive);
          resolve(data);
        };
        window.addEventListener("message", receive);
      });
      frame.contentWindow.postMessage(JSON.stringify({
        event: "studioPropertyEditRequest",
        requestId,
        cellId: "__batch__",
        path: "cell:batch",
        value: JSON.stringify([{ cellId: "__active_page__", path: "cell:execute-script", value: script }])
      }), new URL(frame.src).origin);
      return response;
    });

    expect(result.success).toBe(false);
    expect(result.batchRolledBack).toBe(true);
    expect(result.rollbackErrors).toEqual([]);
    await expect.poll(async () => {
      const xml = await readWorkspaceXml(workspace);
      return cellX(xml, "Temporary script node") !== null;
    }, { timeout: 10_000, intervals: [250] }).toBe(false);
    expect(await readWorkspaceXml(workspace)).toBe(before);
  });

  test("原生批量编辑逐步执行，失败时回滚并报告失败步骤", async ({ page }) => {
    const before = await readWorkspaceXml(workspace);
    const databaseCell = Array.from(before.matchAll(/<mxCell\b([^>]*)>/g))
      .find((match) => /\bvalue="Database"/.test(match[1]));
    expect(databaseCell, "fixture must contain the Database cell").toBeTruthy();
    const databaseId = /\bid="([^"]+)"/.exec(databaseCell![1])?.[1];
    expect(databaseId).toBeTruthy();

    const result = await page.evaluate(async (cellId) => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.drawio-iframe");
      if (!frame?.contentWindow) throw new Error("Native Draw.io iframe is unavailable");
      const requestId = 938271;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", receive);
          reject(new Error("Timed out waiting for native batch acknowledgement"));
        }, 8000);
        const receive = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow) return;
          let data: Record<string, unknown>;
          try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; }
          catch { return; }
          if (data?.event !== "studioPropertyEditResult" || data.requestId !== requestId) return;
          window.clearTimeout(timeout);
          window.removeEventListener("message", receive);
          resolve(data);
        };
        window.addEventListener("message", receive);
      });
      frame.contentWindow.postMessage(JSON.stringify({
        event: "studioPropertyEditRequest", requestId, cellId: "__batch__", path: "cell:batch",
        value: JSON.stringify([
          { cellId, path: "label", value: "Database changed temporarily" },
          { cellId, path: "geometry:size", value: "240,100" },
          { cellId: "missing-cell-for-rollback-test", path: "label", value: "Must fail" }
        ])
      }), new URL(frame.src).origin);
      return response;
    }, databaseId!);

    expect(result.success).toBe(false);
    expect(result.batchRolledBack, "Native batch rollback details: " + JSON.stringify(result, null, 2)).toBe(true);
    expect(result.failedIndex).toBe(2);
    expect(Array.isArray(result.batchResults)).toBe(true);
    expect((result.batchResults as Array<{ success: boolean }>).map((step) => step.success)).toEqual([true, true, false]);
    expect(result.rollbackErrors).toEqual([]);
    expect(await readWorkspaceXml(workspace)).toBe(before);
    await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();
    await expect(nativeFrame(page).getByText("Database changed temporarily", { exact: true })).toHaveCount(0);
  });

});
