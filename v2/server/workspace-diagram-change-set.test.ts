import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspaceDiagramChangeSet } from "./workspace-diagram-change-set";

const workspaceId = "workspace-test";
let root = "";

async function setup(files: Record<string, string>) {
  root = await mkdtemp(path.join(os.tmpdir(), "studio-change-set-"));
  for (const [relative, xml] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, xml, "utf8");
  }
  return {
    workspaceId,
    async resolveWorkspaceFile(relativePath: string) {
      if (relativePath.startsWith("/") || relativePath.split(/[\\/]/).includes("..")) throw new Error("Invalid file path");
      const absolutePath = path.resolve(root, relativePath);
      if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) throw new Error("Path escapes workspace");
      return { workspace: { id: workspaceId }, absolutePath };
    }
  };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("prepareWorkspaceDiagramChangeSet", () => {
  it("prepares multiple files and pages using exact XML revisions", async () => {
    const first = '<mxfile><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram><diagram id="p2" name="Details"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    const second = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
    const resolver = await setup({ "diagrams/a.drawio": first, "diagrams/b.drawio": second });
    const makeTarget = (filePath: string, pageId: string | null, xml: string) => ({
      workspaceId, filePath, pageId,
      expectedRevision: createHash("sha256").update(xml).digest("hex")
    });
    const result = await prepareWorkspaceDiagramChangeSet({
      id: "change-1", workspaceId, summary: "Update diagrams",
      targets: [
        makeTarget("diagrams/a.drawio", "p1", first),
        makeTarget("diagrams/a.drawio", "p2", first),
        makeTarget("diagrams/b.drawio", null, second)
      ]
    }, resolver);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.targets).toHaveLength(3);
      expect(result.targets[0].title).toBe("Overview");
      expect(result.targets[1].title).toBe("Details");
      expect(result.targets[2].pageId).toBeNull();
    }
  });

  it("rejects a stale target before returning any prepared target", async () => {
    const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
    const resolver = await setup({ "diagrams/a.drawio": xml });
    const result = await prepareWorkspaceDiagramChangeSet({
      id: "change-2", workspaceId, summary: "Update diagram",
      targets: [{ workspaceId, filePath: "diagrams/a.drawio", pageId: null, expectedRevision: "a".repeat(64) }]
    }, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("revision changed");
  });

  it("rejects missing page IDs in multi-page files", async () => {
    const xml = '<mxfile><diagram id="p1" name="Overview"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    const resolver = await setup({ "diagrams/a.drawio": xml });
    const result = await prepareWorkspaceDiagramChangeSet({
      id: "change-3", workspaceId, summary: "Update diagram",
      targets: [{ workspaceId, filePath: "diagrams/a.drawio", pageId: null, expectedRevision: createHash("sha256").update(xml).digest("hex") }]
    }, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("explicit pageId");
  });
});
