import { readFile } from "node:fs/promises";
import { expect, test } from "./support/test";
import { createWorkspace, nativeFrame, openStudio, readWorkspaceXml, waitForNativeEditor, type WorkspaceFixture } from "./support/fixtures";

let workspace: WorkspaceFixture;

function multiPageStyleFixture(): string {
  const page = (id: string, name: string, cell: string, shape: string, label: string, fill: string) =>
    '<diagram id="' + id + '" name="' + name + '"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="4" guides="1" page="1" pageScale="1" pageWidth="1200" pageHeight="800" background="#FFFF66"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    '<mxCell id="' + cell + '" value="' + label + '" style="shape=' + shape + ';whiteSpace=wrap;html=1;fillColor=' + fill +
    ';strokeColor=#990000;fontColor=#111111;strokeWidth=7;rounded=0;vendorFlag=preserve;" vertex="1" parent="1"><mxGeometry x="80" y="90" width="170" height="65" as="geometry"/></mxCell>' +
    '<mxCell id="note-' + id + '" value="Keep non-cell metadata" style="text;html=1;" vertex="1" parent="1"><mxGeometry x="330" y="200" width="140" height="30" as="geometry"/></mxCell>' +
    '<mxCell id="edge-' + id + '" value="uses" style="edgeStyle=orthogonalEdgeStyle;html=1;strokeColor=#AA0000;endArrow=block;strokeWidth=4;dashed=1;vendorEdgeFlag=preserve;" edge="1" parent="1" source="' + cell + '" target="note-' + id + '"><mxGeometry relative="1" as="geometry"/></mxCell>' +
    '</root></mxGraphModel></diagram>';
  return '<mxfile host="app.diagrams.net" agent="Draw.io style regression fixture">' +
    page("page-one", "Service page", "service-cell", "mxgraph.c4.application", "API Service", "#FF0000") +
    page("page-two", "Database page", "database-cell", "cylinder", "Data Store", "#00FF00") +
    '</mxfile>';
}

async function setUpMultiPageWorkspace(request: Parameters<typeof createWorkspace>[0]): Promise<WorkspaceFixture> {
  const fixture = await createWorkspace(request);
  const stateResponse = await request.get("/api/workspace/state");
  expect(stateResponse.ok()).toBe(true);
  const state = await stateResponse.json() as { workspaceRevision: string };
  const xml = multiPageStyleFixture();
  const save = await request.put("/api/workspace/document", {
    data: { drawioXml: xml, label: "Style transformation fixture", baseRevision: state.workspaceRevision }
  });
  expect(save.status(), await save.text()).toBe(200);
  return fixture;
}

async function captureNativeExports(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as Window & { __drawioStyleExports?: string[] };
    state.__drawioStyleExports = [];
    window.addEventListener("message", (event) => {
      let payload: { event?: string; format?: string; xml?: string } | null = null;
      try {
        payload = typeof event.data === "string"
          ? JSON.parse(event.data) as { event?: string; format?: string; xml?: string }
          : event.data as { event?: string; format?: string; xml?: string };
      } catch { return; }
      if (payload?.event === "export" && payload.format === "xml" && typeof payload.xml === "string") {
        state.__drawioStyleExports?.push(payload.xml);
      }
    });
  });
}

async function latestNativeExport(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const state = window as Window & { __drawioStyleExports?: string[] };
    return state.__drawioStyleExports?.at(-1) ?? "";
  });
}

async function chooseDiagramStyle(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.getByLabel("Draw.io document style").click();
  await page.getByRole("option", { name, exact: true }).click();
}

test.beforeEach(async ({ page, request }) => {
  workspace = await setUpMultiPageWorkspace(request);
  await openStudio(page);
  await waitForNativeEditor(page);
  await captureNativeExports(page);
});

test.describe("原生 Draw.io 文档风格", () => {
  test("风格切换修改所有页面的原生 XML，并由 Draw.io Undo/Redo 恢复风格和下拉框", async ({ page }) => {
    const originalXml = await readWorkspaceXml(workspace);
    expect(originalXml).toContain('background="#FFFF66"');
    expect(originalXml).toContain("fillColor=#FF0000");
    expect(originalXml).toContain("fillColor=#00FF00");
    await expect(page.locator(".diagram-style-controls .ant-select-selection-item")).toHaveText("Original");

    await chooseDiagramStyle(page, "Editorial");
    await expect(page.locator(".status-left")).toContainText("Applied Draw.io document style: Editorial");
    await expect(page.locator(".diagram-style-controls .ant-select-selection-item")).toHaveText("Editorial");

    await expect.poll(async () => latestNativeExport(page), { timeout: 20_000, intervals: [250] }).toContain("fillColor=#E6F0FF");
    const styledExport = await latestNativeExport(page);
    expect(styledExport).toContain("fillColor=#E3F2E8");
    expect(styledExport).toContain("fillColor=#F8FAFD");
    expect(styledExport).toContain("strokeColor=#7487A0");
    expect(styledExport).toContain("vendorEdgeFlag=preserve");
    expect(styledExport).toContain('background="#FFFF66"');
    expect(styledExport).toContain("vendorFlag=preserve");
    expect(styledExport).toContain("shape=mxgraph.c4.application");
    expect(styledExport).toContain("shape=cylinder");
    expect(styledExport).toContain("Keep non-cell metadata");
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 30_000, intervals: [500] }).toContain("fillColor=#E6F0FF");

    await nativeFrame(page).locator("body").press("Control+z");
    await expect(page.locator(".diagram-style-controls .ant-select-selection-item")).toHaveText("Original", { timeout: 20_000 });
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 30_000, intervals: [500] }).toContain("fillColor=#FF0000");
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 30_000, intervals: [500] }).toContain("fillColor=#00FF00");

    await nativeFrame(page).locator("body").press("Control+Shift+z");
    await expect(page.locator(".diagram-style-controls .ant-select-selection-item")).toHaveText("Editorial", { timeout: 20_000 });
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 30_000, intervals: [500] }).toContain("fillColor=#E3F2E8");
    expect(await readWorkspaceXml(workspace)).toContain('background="#FFFF66"');
  });

  test("风格 JSON 可单独导入、导出和删除，删除配置不会改写现有文档", async ({ page }) => {
    const importedStyle = {
      schemaVersion: 1,
      style: {
        id: "e2e-custom",
        name: "E2E Custom",
        version: 1,
        description: "A style used by Playwright to validate library operations.",
        categories: {
          node: { fillColor: "#123456", strokeColor: "#234567", fontColor: "#FFFFFF", strokeWidth: "2" },
          service: { fillColor: "#123456", strokeColor: "#234567", fontColor: "#FFFFFF", strokeWidth: "2" },
          database: { fillColor: "#345678", strokeColor: "#456789", fontColor: "#FFFFFF", strokeWidth: "2" },
          edge: { strokeColor: "#123456", fontColor: "#234567", strokeWidth: "2", endArrow: "block" },
          edgeDashed: { strokeColor: "#456789", fontColor: "#234567", strokeWidth: "2", dashed: "1", dashPattern: "8 4" }
        }
      }
    };
    await page.locator('input[aria-label="Import Draw.io style JSON"]').setInputFiles({
      name: "e2e-custom.drawio-style.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(importedStyle, null, 2))
    });
    await expect(page.getByRole("option", { name: "E2E Custom", exact: true })).toHaveCount(0);
    await expect(page.locator(".status-left")).toContainText("Imported diagram style: E2E Custom");
    await chooseDiagramStyle(page, "E2E Custom");
    await expect(page.locator(".status-left")).toContainText("Applied Draw.io document style: E2E Custom");
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 30_000, intervals: [500] }).toContain("fillColor=#123456");

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export style", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("e2e-custom.drawio-style.json");
    const exported = JSON.parse(await readFile((await download.path())!, "utf8")) as typeof importedStyle;
    expect(exported.schemaVersion).toBe(1);
    expect(exported.style.id).toBe("e2e-custom");
    expect(exported.style.categories.node.fillColor).toBe("#123456");

    page.once("dialog", async (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Delete style", exact: true }).click();
    await expect(page.locator(".diagram-style-controls .ant-select-selection-item")).toHaveText("Original");
    await expect(page.getByRole("option", { name: "E2E Custom", exact: true })).toHaveCount(0);
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 30_000, intervals: [500] }).toContain("fillColor=#123456");
    expect(await readWorkspaceXml(workspace)).toContain('background="#FFFF66"');
  });
});
