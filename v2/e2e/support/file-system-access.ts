import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

export interface E2EBrowserFile {
  name: string;
  path: string;
  content: string;
}

type BrowserPickerTestWindow = Window & {
  __studioSelectFile?: (name: string) => void;
};

/**
 * Installs a deterministic stand-in for the browser File System Access API.
 * The app still uses its production picker/handle logic; only the OS picker and final
 * browser write are simulated so Playwright can assert the real fixture file contents.
 */
export async function installFileSystemAccessMock(
  page: Page,
  rootDirectory: string,
  files: E2EBrowserFile[]
): Promise<void> {
  const entries = new Map(files.map((item) => [item.name, { ...item }]));
  await page.unroute("**/__studio-file-write").catch(() => undefined);
  await page.route("**/__studio-file-write", async (route) => {
    try {
      const payload = JSON.parse(route.request().postData() || "{}") as { name?: string; content?: string };
      if (typeof payload.name !== "string" || typeof payload.content !== "string") {
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Invalid mock file write" }) });
        return;
      }
      const entry = entries.get(payload.name) ?? {
        name: payload.name,
        path: path.join(rootDirectory, payload.name),
        content: ""
      };
      await writeFile(entry.path, payload.content, "utf8");
      entry.content = payload.content;
      entries.set(entry.name, entry);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    } catch (error) {
      await route.fulfill({
        status: 500, contentType: "application/json",
        body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      });
    }
  });

  await page.evaluate(({ sourceFiles }) => {
    type FileState = { name: string; content: string; lastModified: number };
    const state = new Map<string, FileState>(
      sourceFiles.map((item) => [item.name, { ...item, lastModified: Date.now() }])
    );
    let selectedName: string | null = sourceFiles[0]?.name ?? null;

    const makeHandle = (name: string) => ({
      kind: "file" as const,
      name,
      async getFile() {
        const item = state.get(name);
        if (!item) throw new DOMException("The mock file no longer exists", "NotFoundError");
        return new File([item.content], item.name, {
          type: "application/xml",
          lastModified: item.lastModified
        });
      },
      async createWritable() {
        let pending = "";
        return {
          async write(data: string | Blob) {
            pending = typeof data === "string" ? data : await data.text();
          },
          async close() {
            const response = await fetch("/__studio-file-write", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, content: pending })
            });
            if (!response.ok) throw new Error("Mock file write failed: HTTP " + response.status);
            const previous = state.get(name);
            state.set(name, { name, content: pending, lastModified: Date.now() + 1, ...(previous ? {} : {}) });
          },
          async abort() { pending = ""; }
        };
      },
      async isSameEntry(other: { name?: string }) { return other?.name === name; },
      async queryPermission() { return "granted"; },
      async requestPermission() { return "granted"; }
    });

    const target = window as BrowserPickerTestWindow;
    Object.defineProperty(target, "showOpenFilePicker", {
      configurable: true,
      value: async () => {
        const name = selectedName;
        selectedName = null;
        if (!name) throw new DOMException("The user cancelled the picker", "AbortError");
        if (!state.has(name)) throw new DOMException("The mock file was not found", "NotFoundError");
        return [makeHandle(name)];
      }
    });
    Object.defineProperty(target, "showSaveFilePicker", {
      configurable: true,
      value: async (options?: { suggestedName?: string }) => {
        const name = options?.suggestedName || "diagram-export.drawio";
        if (!state.has(name)) state.set(name, { name, content: "", lastModified: Date.now() });
        return makeHandle(name);
      }
    });
    target.__studioSelectFile = (name: string) => { selectedName = name; };
  }, {
    sourceFiles: files.map(({ name, content }) => ({ name, content }))
  });
}

export async function setNextBrowserFile(page: Page, name: string): Promise<void> {
  await page.evaluate((nextName) => {
    const target = window as BrowserPickerTestWindow;
    target.__studioSelectFile?.(nextName);
  }, name);
}
