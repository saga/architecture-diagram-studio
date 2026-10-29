import { expect, test } from "./support/test";
import { decodeDrawioPageXml } from "../src/model/drawio-xml-schema";
import { parseDrawioXml, serializeDrawioXml } from "../src/model/drawio-xml-dom";
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

/** Put role-based fills on a sentinel so these tests verify palette application, not fixture/palette coincidence. */
function setCategoryFillsForThemeTest(document: Document): void {
  for (const cell of Array.from(document.getElementsByTagName("mxCell"))) {
    const style = cell.getAttribute("style") || "";
    if (!/studioColorRole=category-\d+(?:;|$)/.test(style)) continue;
    const entries = style.split(";").filter(Boolean);
    let hasFill = false;
    const normalized = entries.map((entry) => {
      if (!entry.startsWith("fillColor=")) return entry;
      hasFill = true;
      return "fillColor=#123456";
    });
    if (!hasFill) normalized.push("fillColor=#123456");
    cell.setAttribute("style", normalized.join(";") + ";");
  }
}

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

function nativeCellSnapshot(xml: string, cellId: string) {
  const source = parseDrawioXml(xml);
  const documentRoot = source.documentElement;
  const models: Element[] = [];
  if (documentRoot.nodeName === "mxGraphModel") {
    models.push(documentRoot as unknown as Element);
  } else if (documentRoot.nodeName === "mxfile") {
    for (const page of Array.from(documentRoot.getElementsByTagName("diagram"))) {
      const inline = page.getElementsByTagName("mxGraphModel").item(0);
      if (inline) {
        models.push(inline);
        continue;
      }
      const payload = (page.textContent || "").trim();
      if (!payload) continue;
      try {
        const decoded = parseDrawioXml(decodeDrawioPageXml(payload));
        if (decoded.documentElement.nodeName === "mxGraphModel") models.push(decoded.documentElement as unknown as Element);
      } catch { /* Keep searching other pages. */ }
    }
  }
  for (const model of models) {
    const cell = Array.from(model.getElementsByTagName("mxCell")).find((candidate) => candidate.getAttribute("id") === cellId);
    if (!cell) continue;
    const geometry = Array.from(cell.children).find((child) => child.tagName === "mxGeometry") as Element | undefined;
    return {
      parent: cell.getAttribute("parent"),
      source: cell.getAttribute("source"),
      target: cell.getAttribute("target"),
      x: geometry?.getAttribute("x") ?? null,
      y: geometry?.getAttribute("y") ?? null,
      width: geometry?.getAttribute("width") ?? null,
      height: geometry?.getAttribute("height") ?? null,
      relative: geometry?.getAttribute("relative") ?? null,
      points: geometry
        ? Array.from(geometry.children)
          .filter((child) => child.tagName === "Array" && child.getAttribute("as") === "points")
          .flatMap((array) => Array.from(array.children))
          .filter((child) => child.tagName === "mxPoint")
          .map((point) => ({ x: point.getAttribute("x"), y: point.getAttribute("y") }))
        : []
    };
  }
  return null;
}

/** Drag the native SVG shape instead of the foreignObject label. */
async function dragNativeNode(page: import("@playwright/test").Page, labelText: string, deltaX: number, deltaY: number) {
  // Scope to the rendered canvas label; the sidebar can contain duplicate palette labels.
  const label = nativeFrame(page).locator(".geDiagramContainer").getByText(labelText, { exact: true });
  await expect(label, `the ${labelText} canvas node must be rendered before it can be dragged`).toBeVisible();
  const frameBox = await page.locator('iframe[title="Native Draw.io editor"]').boundingBox();
  const bounds = await label.boundingBox();
  expect(frameBox, "the native Draw.io iframe must be visible").not.toBeNull();
  expect(bounds, `the ${labelText} canvas label must have visible bounds`).not.toBeNull();

  // Find the mxGraph SVG shape that actually contains the HTML label. This avoids both the
  // palette duplicate and label-only hit targets that do not initiate the native vertex drag.
  const shapePoint = await label.evaluate((element) => {
    const labelBounds = element.getBoundingClientRect();
    const center = {
      x: labelBounds.left + labelBounds.width / 2,
      y: labelBounds.top + labelBounds.height / 2
    };
    const candidates = Array.from(document.querySelectorAll(".geDiagramContainer rect[pointer-events='all']"))
      .map((rect) => {
        const r = rect.getBoundingClientRect();
        return { rect, bounds: r, area: r.width * r.height };
      })
      .filter(({ bounds: r }) =>
        r.width > 0 && r.height > 0 &&
        center.x >= r.left && center.x <= r.right &&
        center.y >= r.top && center.y <= r.bottom
      )
      .sort((a, b) => a.area - b.area);
    const shape = candidates[0];
    if (!shape) {
      return {
        error: "No native SVG vertex rect contains the rendered label",
        labelBounds: { x: labelBounds.x, y: labelBounds.y, width: labelBounds.width, height: labelBounds.height },
        visibleRects: Array.from(document.querySelectorAll(".geDiagramContainer rect[pointer-events='all']"))
          .slice(0, 20).map((rect) => {
            const r = rect.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          })
      };
    }
    const r = shape.bounds;
    const x = r.left + r.width * 0.8;
    const y = r.top + r.height * 0.78;
    const hit = document.elementFromPoint(x, y);
    if (hit && hit.closest(".geItem")) {
      return {
        error: "The native canvas node is occluded by the Draw.io shape palette",
        labelText: element.textContent,
        x, y,
        hit: { tag: hit.tagName, className: typeof hit.className === "string" ? hit.className : "" }
      };
    }
    return {
      x, y,
      shapeBounds: { x: r.x, y: r.y, width: r.width, height: r.height },
      hit: hit ? { tag: hit.tagName, className: typeof hit.className === "string" ? hit.className : "" } : null
    };
  });
  if ("error" in shapePoint) throw new Error(JSON.stringify(shapePoint));

  // Frame-local DOM coordinates become host-page coordinates after adding the iframe offset.
  const startX = frameBox!.x + shapePoint.x;
  const startY = frameBox!.y + shapePoint.y;
  const before = await label.boundingBox();
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 14 });
  await page.mouse.up();

  await expect.poll(() => label.boundingBox(), { timeout: 5_000, intervals: [100] })
    .not.toEqual(before);
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

  test("图形主题清除主题底色、突出节点，并保留原生网格和应用主题", async ({ page, request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml?: string | null; workspaceRevision?: string | null };
    const initialXml = typeof state.drawioXml === "string" ? state.drawioXml : await readWorkspaceXml(workspace);
    const sourceDocument = parseDrawioXml(initialXml);
    const models = sourceDocument.getElementsByTagName("mxGraphModel");
    expect(models.length).toBeGreaterThan(0);
    models.item(0)?.setAttribute("background", "#FFFF66");
    setCategoryFillsForThemeTest(sourceDocument);
    const documentXml = serializeDrawioXml(sourceDocument);
    const savedFixture = await request.put("/api/workspace/document", {
      data: { drawioXml: documentXml, label: "E2E unset canvas fixture", baseRevision: state.workspaceRevision }
    });
    expect(savedFixture.status(), await savedFixture.text()).toBe(200);

    await page.reload();
    await waitForNativeEditor(page);
    const inspectCanvas = async () => nativeFrame(page).locator("body").evaluate(() => {
      const page = document.querySelector<HTMLElement>(".geBackgroundPage");
      return {
        color: page ? getComputedStyle(page).backgroundColor : null,
        image: page ? getComputedStyle(page).backgroundImage : null,
        themeOverlay: Boolean(document.querySelector("#studio-native-theme"))
      };
    });
    const firstPageBackground = async () => {
      const xml = await readWorkspaceXml(workspace);
      return parseDrawioXml(xml).getElementsByTagName("mxGraphModel").item(0)?.getAttribute("background") ?? null;
    };
    await expect.poll(inspectCanvas, { timeout: 20_000 }).toMatchObject({
      color: "rgb(255, 255, 102)",
      themeOverlay: false
    });
    expect((await inspectCanvas())?.image).not.toBe("none");

    await page.locator(".theme-selector .ant-select").click();
    await page.getByText("Ocean Depths", { exact: true }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "warm");
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 20_000 })
      .toContain("fillColor=#8EC6D8");
    await expect.poll(firstPageBackground, { timeout: 20_000 }).toBeNull();
    await expect.poll(async () => (await inspectCanvas())?.color, { timeout: 20_000 })
      .not.toBe("rgb(197, 221, 231)");
    await expect.poll(async () => (await inspectCanvas())?.themeOverlay, { timeout: 20_000 }).toBe(false);
    expect((await inspectCanvas())?.image).not.toBe("none");

    await page.locator(".theme-selector .ant-select").click();
    await page.getByText("Midnight Galaxy", { exact: true }).click();
    await expect.poll(async () => readWorkspaceXml(workspace), { timeout: 20_000 })
      .toContain("fillColor=#A1B4E4");
    await expect.poll(firstPageBackground, { timeout: 20_000 }).toBeNull();
    expect((await inspectCanvas())?.image).not.toBe("none");

    await page.reload();
    await waitForNativeEditor(page);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-theme", "warm");
    await expect.poll(firstPageBackground, { timeout: 20_000 }).toBeNull();
    expect((await inspectCanvas())?.themeOverlay).toBe(false);
    expect((await inspectCanvas())?.image).not.toBe("none");
    const savedXml = await readWorkspaceXml(workspace);
    expect(savedXml).toContain('grid="1"');
    expect(savedXml).toContain("fillColor=#");
  });

  test("原生 Undo/Redo 将节点颜色与清除画布底色作为一次操作恢复", async ({ page, request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml?: string | null; workspaceRevision?: string | null };
    const initialXml = typeof state.drawioXml === "string" ? state.drawioXml : await readWorkspaceXml(workspace);
    const sourceDocument = parseDrawioXml(initialXml);
    const models = sourceDocument.getElementsByTagName("mxGraphModel");
    expect(models.length).toBeGreaterThan(0);
    models.item(0)?.setAttribute("background", "#FFFF66");
    setCategoryFillsForThemeTest(sourceDocument);
    const savedFixture = await request.put("/api/workspace/document", {
      data: { drawioXml: serializeDrawioXml(sourceDocument), label: "E2E undo canvas fixture", baseRevision: state.workspaceRevision }
    });
    expect(savedFixture.status(), await savedFixture.text()).toBe(200);
    await page.reload();
    await waitForNativeEditor(page);

    const pageBackground = async () => {
      const xml = await readWorkspaceXml(workspace);
      return parseDrawioXml(xml).getElementsByTagName("mxGraphModel").item(0)?.getAttribute("background") ?? null;
    };
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    const redo = page.getByRole("button", { name: "Redo", exact: true });
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();

    await page.locator(".theme-selector .ant-select").click();
    await page.getByText("Ocean Depths", { exact: true }).click();
    await expect.poll(async () => {
      const xml = await readWorkspaceXml(workspace);
      return xml.includes("fillColor=#8EC6D8") && (await pageBackground()) === null;
    }, { timeout: 20_000 }).toBe(true);
    await expect(undo).toBeEnabled();

    // One native Undo restores the source styles and original explicit background.
    await undo.click();
    await expect.poll(async () => {
      const xml = await readWorkspaceXml(workspace);
      return !xml.includes("fillColor=#8EC6D8") && (await pageBackground()) === "#FFFF66";
    }, { timeout: 20_000 }).toBe(true);
    await expect(redo).toBeEnabled();

    await page.keyboard.press("Control+Shift+Z");
    await expect.poll(async () => {
      const xml = await readWorkspaceXml(workspace);
      return xml.includes("fillColor=#8EC6D8") && (await pageBackground()) === null;
    }, { timeout: 20_000 }).toBe(true);
    await expect(page.locator(".theme-selector")).toContainText("Ocean Depths");
    await expect(undo).toBeEnabled();

    await page.keyboard.press("Control+Z");
    await expect.poll(async () => {
      const xml = await readWorkspaceXml(workspace);
      return !xml.includes("fillColor=#8EC6D8") && (await pageBackground()) === "#FFFF66";
    }, { timeout: 20_000 }).toBe(true);
    await expect(redo).toBeEnabled();
    await expect(page.locator(".theme-selector")).toContainText("Diagram colors (this page)");
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
    const layoutSummary = page.locator(".bottom-status .status-left");
    await expect(layoutSummary).toContainText("Auto layout");
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => {
      const xmlAfterUndo = await readWorkspaceXml(workspace);
      const afterUndo = ids.map((id) => cellPosition(xmlAfterUndo, id));
      return afterUndo.every((position, index) => {
        const before = beforePositions[index];
        return position !== null && before !== null && position.x === before.x && position.y === before.y;
      });
    }, { timeout: 20_000, intervals: [500] }).toBe(true);
    await expect(page.getByRole("button", { name: "Redo", exact: true })).toBeEnabled();
  });

  test("Group 作为原子节点参与布局，内部节点与内部连线的相对几何保持不变", async ({ page, request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml?: string | null; workspaceRevision?: string | null };
    const sourceXml = typeof state.drawioXml === "string" ? state.drawioXml : await readWorkspaceXml(workspace);
    const groupCells = `
      <mxCell id="group-container" value="Grouped Block" style="rounded=1;container=1;collapsible=0;fillColor=#f8fafc;strokeColor=#64748b;" vertex="1" parent="1"><mxGeometry x="930" y="430" width="230" height="120" as="geometry"/></mxCell>
      <mxCell id="group-step-a" value="Step A" vertex="1" parent="group-container"><mxGeometry x="18" y="30" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="group-step-b" value="Step B" vertex="1" parent="group-container"><mxGeometry x="128" y="30" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="group-internal-edge" edge="1" parent="group-container" source="group-step-a" target="group-step-b" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;"><mxGeometry relative="1" as="geometry"/></mxCell>
      <mxCell id="edge-database-to-group-child" edge="1" parent="1" source="database" target="group-step-a" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    expect(sourceXml.split("</root>").length).toBe(2);
    const withGroupXml = sourceXml.replace("</root>", groupCells + "</root>");
    const saved = await request.put("/api/workspace/document", {
      data: {
        drawioXml: withGroupXml,
        label: "E2E atomic group layout fixture",
        baseRevision: state.workspaceRevision
      }
    });
    expect(saved.status(), await saved.text()).toBe(200);

    await page.reload();
    await waitForNativeEditor(page);
    const beforeXml = await readWorkspaceXml(workspace);
    const groupBefore = nativeCellSnapshot(beforeXml, "group-container");
    const childABefore = nativeCellSnapshot(beforeXml, "group-step-a");
    const childBBefore = nativeCellSnapshot(beforeXml, "group-step-b");
    const internalEdgeBefore = nativeCellSnapshot(beforeXml, "group-internal-edge");
    expect(groupBefore).not.toBeNull();
    expect(childABefore).not.toBeNull();
    expect(childBBefore).not.toBeNull();
    expect(internalEdgeBefore).not.toBeNull();

    await page.getByRole("button", { name: "Auto layout", exact: true }).click();
    await expect.poll(async () => nativeCellSnapshot(await readWorkspaceXml(workspace), "group-container")?.x, {
      timeout: 30_000, intervals: [500]
    }).not.toBe(groupBefore!.x);

    const afterXml = await readWorkspaceXml(workspace);
    expect(nativeCellSnapshot(afterXml, "group-step-a")).toEqual(childABefore);
    expect(nativeCellSnapshot(afterXml, "group-step-b")).toEqual(childBBefore);
    expect(nativeCellSnapshot(afterXml, "group-internal-edge")).toEqual(internalEdgeBefore);
    expect(nativeCellSnapshot(afterXml, "edge-database-to-group-child")).toMatchObject({
      parent: "1", source: "database", target: "group-step-a"
    });
    expect(nativeCellSnapshot(afterXml, "edge-database-to-group-child")?.points.length).toBeGreaterThan(0);
    await expect(page.locator(".bottom-status .status-left")).toContainText("routed 1 grouped connector(s)");
  });

  test("geometry-only spatial regions move atomically and preserve internal connector waypoints", async ({ page, request }) => {
    const stateResponse = await request.get("/api/workspace/state");
    expect(stateResponse.ok()).toBe(true);
    const state = await stateResponse.json() as { drawioXml?: string | null; workspaceRevision?: string | null };
    const sourceXml = typeof state.drawioXml === "string" ? state.drawioXml : await readWorkspaceXml(workspace);
    const regionCells = `
      <mxCell id="spatial-it-region" value="" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#6c8ebf;">
        <mxGeometry x="900" y="400" width="350" height="260" as="geometry"/>
      </mxCell>
      <mxCell id="spatial-it-title" value="IT Network" vertex="1" parent="1" style="shape=text;html=1;align=left;strokeColor=none;fillColor=none;">
        <mxGeometry x="920" y="405" width="130" height="24" as="geometry"/>
      </mxCell>
      <mxCell id="spatial-switch-a" value="Switch A" vertex="1" parent="1"><mxGeometry x="950" y="480" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="spatial-server-b" value="Server B" vertex="1" parent="1"><mxGeometry x="1080" y="480" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="spatial-plc-c" value="PLC C" vertex="1" parent="1"><mxGeometry x="1090" y="570" width="80" height="40" as="geometry"/></mxCell>
      <mxCell id="spatial-internal-edge" edge="1" parent="1" source="spatial-switch-a" target="spatial-server-b" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;">
        <mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="1050" y="500"/><mxPoint x="1050" y="520"/></Array></mxGeometry>
      </mxCell>
      <mxCell id="spatial-cross-boundary-edge" edge="1" parent="1" source="spatial-plc-c" target="database" style="edgeStyle=orthogonalEdgeStyle;endArrow=block;">
        <mxGeometry relative="1" as="geometry"/>
      </mxCell>`;
    expect(sourceXml.split("</root>").length).toBe(2);
    const withRegionXml = sourceXml.replace("</root>", regionCells + "</root>");
    const saved = await request.put("/api/workspace/document", {
      data: {
        drawioXml: withRegionXml,
        label: "E2E geometry-only atomic spatial region fixture",
        baseRevision: state.workspaceRevision
      }
    });
    expect(saved.status(), await saved.text()).toBe(200);

    await page.reload();
    await waitForNativeEditor(page);
    const beforeXml = await readWorkspaceXml(workspace);
    const beforeRegion = nativeCellSnapshot(beforeXml, "spatial-it-region");
    const memberIds = ["spatial-it-title", "spatial-switch-a", "spatial-server-b", "spatial-plc-c"];
    const beforeMembers = new Map(memberIds.map((id) => [id, nativeCellSnapshot(beforeXml, id)]));
    const beforeInternalEdge = nativeCellSnapshot(beforeXml, "spatial-internal-edge");
    expect(beforeRegion).not.toBeNull();
    expect([...beforeMembers.values()].every((item) => item !== null)).toBe(true);
    expect(beforeInternalEdge?.points.length).toBe(2);

    await page.getByRole("button", { name: "Auto layout", exact: true }).click();
    await expect.poll(async () => {
      const after = nativeCellSnapshot(await readWorkspaceXml(workspace), "spatial-it-region");
      return after?.x !== beforeRegion!.x || after?.y !== beforeRegion!.y;
    }, { timeout: 30_000, intervals: [500] }).toBe(true);

    const afterXml = await readWorkspaceXml(workspace);
    const afterRegion = nativeCellSnapshot(afterXml, "spatial-it-region");
    const afterInternalEdge = nativeCellSnapshot(afterXml, "spatial-internal-edge");
    expect(afterRegion).not.toBeNull();
    const dx = Number(afterRegion!.x) - Number(beforeRegion!.x);
    const dy = Number(afterRegion!.y) - Number(beforeRegion!.y);
    for (const id of memberIds) {
      const before = beforeMembers.get(id)!;
      const after = nativeCellSnapshot(afterXml, id);
      expect(after).not.toBeNull();
      expect(Number(after!.x) - Number(before!.x)).toBeCloseTo(dx, 3);
      expect(Number(after!.y) - Number(before!.y)).toBeCloseTo(dy, 3);
      expect(after!.parent).toBe(before!.parent);
      expect(after!.width).toBe(before!.width);
      expect(after!.height).toBe(before!.height);
    }
    expect(afterInternalEdge?.points).toHaveLength(2);
    for (let index = 0; index < 2; index += 1) {
      expect(Number(afterInternalEdge!.points[index].x)).toBeCloseTo(Number(beforeInternalEdge!.points[index].x) + dx, 3);
      expect(Number(afterInternalEdge!.points[index].y)).toBeCloseTo(Number(beforeInternalEdge!.points[index].y) + dy, 3);
    }
    expect(nativeCellSnapshot(afterXml, "spatial-cross-boundary-edge")).toMatchObject({
      parent: "1", source: "spatial-plc-c", target: "database"
    });
    expect(nativeCellSnapshot(afterXml, "spatial-cross-boundary-edge")?.points.length).toBeGreaterThan(0);
    await expect(page.locator(".bottom-status .status-left")).toContainText(/kept \d+ spatial region\(s\) atomic with \d+ member node\(s\)/);
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
    const beforeX = cellX(before, "database");
    expect(beforeX).not.toBeNull();

    // The Client fixture starts under Draw.io's left palette; use an unobscured canvas node.
    await dragNativeNode(page, "Database", 120, 40);

    await expect
      .poll(async () => cellX(await readWorkspaceXml(workspace), "database"), { timeout: 30_000, intervals: [500] })
      .not.toBe(beforeX);
    await expect(page.locator(".status-left")).toContainText("Synced native Draw.io changes");
  });

  test("刷新页面后画布恢复到拖动后的版本", async ({ page }) => {
    const beforeDragXml = await readWorkspaceXml(workspace);
    const beforeDragX = cellX(beforeDragXml, "database");
    expect(beforeDragX).not.toBeNull();
    await dragNativeNode(page, "Database", 120, 40);

    await expect
      .poll(async () => cellX(await readWorkspaceXml(workspace), "database"), { timeout: 30_000, intervals: [500] })
      .not.toBe(beforeDragX);
    const draggedX = cellX(await readWorkspaceXml(workspace), "database");

    await page.reload();
    await waitForNativeEditor(page);
    await expect(nativeFrame(page).getByText("Database", { exact: true })).toBeVisible();
    // The reload must not roll the file back to the pre-drag geometry.
    expect(cellX(await readWorkspaceXml(workspace), "database")).toBe(draggedX);
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
  test("legacy native script requests are rejected without changing the diagram", async ({ page }) => {
    const before = await readWorkspaceXml(workspace);
    const result = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.drawio-iframe");
      if (!frame?.contentWindow) throw new Error("Native Draw.io iframe is unavailable");
      const requestId = 938274;
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          window.removeEventListener("message", receive);
          reject(new Error("Timed out waiting for removed-script rejection"));
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
        value: JSON.stringify([{
          cellId: "__active_page__", path: "cell:execute-script",
          value: 'graph.insertVertex(graph.getDefaultParent(), null, "SHOULD NOT RUN", 1, 1, 10, 10);'
        }])
      }), new URL(frame.src).origin);
      return response;
    });
    expect(result.success).toBe(false);
    expect(String(result.error).toLowerCase()).toContain("script execution has been removed");
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
