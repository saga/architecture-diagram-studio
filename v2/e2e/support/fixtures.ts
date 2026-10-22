import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";
import { tempDir } from "./temp-dirs";

export type TemplateKey = "service-queue-database" | "c4-context" | "sequence-request";

export interface WorkspaceFixture {
  rootPath: string;
  fileName: string;
  filePath: string;
  workspaceId: string;
}

/**
 * Creates a throwaway project directory with one Draw.io file and makes it the
 * active server workspace. The UI is unaware of the shortcut, so a page load
 * exercises the same hydration path a user gets after picking a folder.
 */
export async function createWorkspace(
  request: APIRequestContext,
  options: { template?: TemplateKey | null; name?: string } = {}
): Promise<WorkspaceFixture> {
  const rootPath = await tempDir("studio-e2e-ws-");
  const fileName = "architecture.drawio";
  const created = await request.post("/api/workspace/diagram/create", {
    data: { rootPath, name: options.name ?? "E2E Workspace", fileName }
  });
  expect(created.status(), await created.text()).toBe(201);
  const body = (await created.json()) as { workspace: { id: string }; workspaceRevision: string };

  const template = options.template === undefined ? "service-queue-database" : options.template;
  if (template) {
    const applied = await request.post("/api/workspace/diagram/apply-template", {
      data: { templateKey: template, confirmed: true, baseRevision: body.workspaceRevision }
    });
    expect(applied.status(), await applied.text()).toBe(200);
  }
  return { rootPath, fileName, filePath: path.join(rootPath, fileName), workspaceId: body.workspace.id };
}

/** Loads the app shell. Draw.io readiness is a separate wait because the setup modal can block it. */
export async function openStudio(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".app-shell")).toBeVisible();
  // Bootstrap either restores the workspace card or opens the setup wizard.
  await expect(page.locator('[role="dialog"], .workspace-card').first()).toBeVisible({ timeout: 20_000 });
}

/** Waits for the Draw.io embed handshake, which is what makes the canvas interactive. */
export async function waitForNativeEditor(page: Page): Promise<void> {
  await expect(page.locator(".drawio-inline-hint")).toContainText("Native editor ready", { timeout: 60_000 });
}

export function nativeFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Native Draw.io editor"]');
}

export function nativeFrameHandle(page: Page) {
  const frame = page.frames().find((candidate) => candidate.url().includes("/drawio/index.html"));
  expect(frame, "the Draw.io iframe should be present in the page").toBeTruthy();
  return frame!;
}

/** Reads the authoritative file the server keeps in the workspace directory. */
export async function readWorkspaceXml(fixture: WorkspaceFixture): Promise<string> {
  return readFile(fixture.filePath, "utf8");
}

/**
 * The setup wizard opens by itself on a fresh data directory and stays reachable
 * through the sidebar on later runs. Both entry points land on the same modal.
 */
export async function openWorkspaceModal(page: Page) {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Switch workspace" }).click();
  }
  await expect(dialog).toBeVisible();
  return dialog;
}
