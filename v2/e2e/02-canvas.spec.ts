import { expect, test } from "./support/test";
import { decodeDrawioPageXml } from "../src/model/drawio-xml-schema";
import type { WorkspaceFixture } from "./support/fixtures";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor } from "./support/fixtures";

let workspace: WorkspaceFixture;

test.beforeEach(async ({ page, request }) => {
  workspace = await createWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  await expect(nativeFrame(page).getByText("API Service", { exact: true })).toBeVisible();
});

/** Reads the x coordinate of the first cell whose id contains the given fragment. */
function cellX(xml: string, fragment: string): number | null {
  let source = xml;
  if (!source.includes("<mxCell")) {
    const pages = Array.from(source.matchAll(/<diagram\b[^>]*>([\s\S]*?)<\/diagram>/g));
    for (const page of pages) {
      try {
        const decoded = decodeDrawioPageXml(page[1].trim());
        if (decoded.includes("<mxCell")) { source = decoded; break; }
      } catch { /* Ignore malformed pages and continue checking other pages. */ }
    }
  }
  const escaped = fragment.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const cells = Array.from(source.matchAll(/<mxCell\b([^>]*)>([\s\S]*?)<\/mxCell>/g));
  const cell = cells.find((match) => new RegExp('\bid="[^"]*' + escaped + '[^"]*"').test(match[1]));
  if (!cell) return null;
  const geometry = /<mxGeometry\b([^>]*)\/?\s*>/.exec(cell[2]);
  const x = geometry && /\bx="([-.\d]+)"/.exec(geometry[1]);
  return x ? Number(x[1]) : null;
}

test.describe("原生画布", () => {
  test("加载工作区的 Draw.io 文件并渲染全部节点", async ({ page }) => {
    const frame = nativeFrame(page);
    for (const label of ["Client", "API Service", "Background Worker", "Message Queue", "Database"]) {
      await expect(frame.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.locator(".drawio-error-banner")).toHaveCount(0);
    // The autosave contract lives in the status tooltip so the bar stays one short line.
    await expect(page.locator(".status-native")).toHaveAttribute("title", /edits autosave back into Studio/);
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
    await expect(page.locator(".status-left")).toContainText("Synced changes from native Draw.io");
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
    // The inspector reads the native XML, not the semantic projection.
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
      }), window.location.origin);
      return response;
    }, databaseId!);

    expect(result.success).toBe(false);
    expect(result.batchRolledBack).toBe(true);
    expect(result.failedIndex).toBe(2);
    expect(Array.isArray(result.batchResults)).toBe(true);
    expect((result.batchResults as Array<{ success: boolean }>).map((step) => step.success)).toEqual([true, true, false]);
    expect(result.rollbackErrors).toEqual([]);
    expect(await readWorkspaceXml(workspace)).toBe(before);
    await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();
    await expect(nativeFrame(page).getByText("Database changed temporarily", { exact: true })).toHaveCount(0);
  });

});
