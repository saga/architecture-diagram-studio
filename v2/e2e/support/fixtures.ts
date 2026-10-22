import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { tempDir } from "./temp-dirs";

export interface WorkspaceFixture {
  rootPath: string;
  fileName: string;
  filePath: string;
  workspaceId: string;
}

/** Static native Draw.io XML fixture. Tests exercise the same mxGraph document format as production. */
function nativeFixtureXml(): string {
  const cell = (id: string, label: string, x: number, y: number, fill: string) =>
    '<mxCell id="' + id + '" value="' + label + '" style="rounded=1;whiteSpace=wrap;html=1;fillColor=' + fill +
    ';strokeColor=#52627a;fontColor=#1f2937;" vertex="1" parent="1"><mxGeometry x="' + x + '" y="' + y +
    '" width="150" height="60" as="geometry"/></mxCell>';
  const edge = (id: string, source: string, target: string, label = "") =>
    '<mxCell id="' + id + '" value="' + label +
    '" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#52627a;" edge="1" parent="1" source="' +
    source + '" target="' + target + '"><mxGeometry relative="1" as="geometry"/></mxCell>';
  return '<mxfile host="app.diagrams.net" agent="Architecture Diagram Studio E2E">' +
    '<diagram id="page-1" name="E2E diagram"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="800" math="0" shadow="0"><root>' +
    '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
    cell("client", "Client", 60, 110, "#e5efff") +
    cell("api", "API Service", 280, 110, "#e4f4eb") +
    cell("worker", "Background Worker", 740, 270, "#fff0d8") +
    cell("queue", "Message Queue", 500, 270, "#f0e8ff") +
    cell("database", "Database", 520, 110, "#e8edf3") +
    edge("client-api", "client", "api") +
    edge("api-database", "api", "database", "query") +
    edge("api-queue", "api", "queue", "publish") +
    edge("queue-worker", "queue", "worker", "deliver") +
    '</root></mxGraphModel></diagram></mxfile>';
}

/**
 * Creates a throwaway project and seeds it with a native Draw.io XML file.
 * No semantic model, generated template, or conversion route participates in test setup.
 */
export async function createWorkspace(
  request: APIRequestContext,
  options: { name?: string } = {}
): Promise<WorkspaceFixture> {
  const rootPath = await tempDir("studio-e2e-ws-");
  const fileName = "architecture.drawio";
  const created = await request.post("/api/workspace/diagram/create", {
    data: { rootPath, name: options.name ?? "E2E Workspace", fileName }
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { workspace: { id: string }; workspaceRevision: string };

  const xml = nativeFixtureXml();
  const saved = await request.put("/api/workspace/document", {
    data: { drawioXml: xml, label: "E2E native Draw.io fixture", baseRevision: body.workspaceRevision }
  });
  expect(saved.status(), await saved.text()).toBe(200);
  return { rootPath, fileName, filePath: path.join(rootPath, fileName), workspaceId: body.workspace.id };
}

/** Loads the app shell; Draw.io readiness is a separate wait because the setup modal can block it. */
export async function openStudio(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator('[role="dialog"], .workspace-card').first()).toBeVisible({ timeout: 20_000 });
}

export async function waitForNativeEditor(page: Page): Promise<void> {
  await expect(page.locator(".status-native")).toContainText("Native editor ready", { timeout: 60_000 });
}

export function nativeFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Native Draw.io editor"]');
}

export function nativeFrameHandle(page: Page) {
  const frame = page.frames().find((candidate) => candidate.url().includes("/drawio/index.html"));
  expect(frame, "the Draw.io iframe should be present in the page").toBeTruthy();
  return frame!;
}

export async function readWorkspaceXml(fixture: WorkspaceFixture): Promise<string> {
  return readFile(fixture.filePath, "utf8");
}

/** Open the same workspace modal used by both first-run setup and workspace switching. */
export async function openWorkspaceModal(page: Page) {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Switch workspace" }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}
