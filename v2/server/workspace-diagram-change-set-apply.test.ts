import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { applyWorkspaceDiagramChangeSet } from "./workspace-diagram-change-set-apply";

const xml = (pageId: string, label: string) =>
  `<mxfile><diagram id="${pageId}" name="Overview"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="${label}" vertex="1" parent="1"><mxGeometry x="10" y="10" width="100" height="40" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`;
const revision = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let temporaryDirectory = "";
async function setup(files: Record<string, string>) {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "diagram-change-set-"));
  const absolute = new Map<string, string>();
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(temporaryDirectory, relative);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(target), { recursive: true }));
    await writeFile(target, content, "utf8");
    absolute.set(relative, target);
  }
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  return {
    logs,
    resolver: {
      workspaceId: "workspace-1",
      resolveWorkspaceFile: async (relativePath: string) => {
        const absolutePath = absolute.get(relativePath);
        if (!absolutePath) throw new Error("File not found in workspace");
        return { workspace: { id: "workspace-1" }, absolutePath };
      },
      writeLog: async (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); }
    },
    absolute
  };
}

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("applyWorkspaceDiagramChangeSet", () => {
  it("applies multiple files after validating all targets and revisions", async () => {
    const beforeA = xml("page-a", "Before A");
    const beforeB = xml("page-b", "Before B");
    const env = await setup({ "a.drawio": beforeA, "nested/b.drawio": beforeB });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-1", workspaceId: "workspace-1",
      targets: [
        { filePath: "a.drawio", expectedRevision: revision(beforeA), resultXml: xml("page-a", "After A"), changedPageIds: ["page-a"] },
        { filePath: "nested/b.drawio", expectedRevision: revision(beforeB), resultXml: xml("page-b", "After B"), changedPageIds: ["page-b"] }
      ]
    }, env.resolver);
    expect(result.ok).toBe(true);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toContain("After A");
    expect(await readFile(env.absolute.get("nested/b.drawio")!, "utf8")).toContain("After B");
    expect(env.logs.map((entry) => entry.event)).toContain("workspace.diagram-change-set.applied");
  });

  it("rejects a stale target before writing any file", async () => {
    const beforeA = xml("page-a", "Before A");
    const beforeB = xml("page-b", "Before B");
    const env = await setup({ "a.drawio": beforeA, "b.drawio": beforeB });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-2", workspaceId: "workspace-1",
      targets: [
        { filePath: "a.drawio", expectedRevision: revision(beforeA), resultXml: xml("page-a", "After A"), changedPageIds: ["page-a"] },
        { filePath: "b.drawio", expectedRevision: "0".repeat(64), resultXml: xml("page-b", "After B"), changedPageIds: ["page-b"] }
      ]
    }, env.resolver);
    expect(result.ok).toBe(false);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(beforeA);
    expect(await readFile(env.absolute.get("b.drawio")!, "utf8")).toBe(beforeB);
  });

  it("rejects missing page IDs and invalid proposed XML without writes", async () => {
    const before = xml("page-a", "Before");
    const env = await setup({ "a.drawio": before });
    const missingPage = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-3", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(before), resultXml: xml("page-a", "After"), changedPageIds: ["missing"] }]
    }, env.resolver);
    expect(missingPage.ok).toBe(false);
    const invalidXml = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-4", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(before), resultXml: "<not-drawio/>", changedPageIds: ["page-a"] }]
    }, env.resolver);
    expect(invalidXml.ok).toBe(false);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(before);
  });

  it("preserves untouched pages when one page is targeted", async () => {
    const before = xml("page-a", "Before A").replace("</mxfile>", xml("page-b", "Before B").replace(/^<mxfile>|<\/mxfile>$/g, "") + "</mxfile>");
    const after = xml("page-a", "After A").replace("</mxfile>", xml("page-b", "Before B").replace(/^<mxfile>|<\/mxfile>$/g, "") + "</mxfile>");
    const env = await setup({ "a.drawio": before });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-6", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(before), resultXml: after, changedPageIds: ["page-a"] }]
    }, env.resolver);
    expect(result.ok).toBe(true);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toContain("Before B");
  });

  it("rejects a combined XML payload above the change-set limit before resolving files", async () => {
    const oversized = "x".repeat(18 * 1024 * 1024);
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-oversized", workspaceId: "workspace-1",
      targets: [
        { filePath: "a.drawio", expectedRevision: "a".repeat(64), resultXml: oversized, changedPageIds: ["page-a"] },
        { filePath: "b.drawio", expectedRevision: "b".repeat(64), resultXml: oversized, changedPageIds: ["page-b"] },
        { filePath: "c.drawio", expectedRevision: "c".repeat(64), resultXml: oversized, changedPageIds: ["page-c"] }
      ]
    }, {
      workspaceId: "workspace-1",
      resolveWorkspaceFile: async () => { throw new Error("Must reject before resolving files"); }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("50 MiB");
  });

  it("rejects duplicate stable page IDs before writing", async () => {
    const before = xml("page-a", "Before");
    const duplicatePage = xml("page-a", "Duplicate").replace("<mxfile>", "").replace("</mxfile>", "");
    const duplicatePages = before.replace("</mxfile>", duplicatePage + "</mxfile>");
    const env = await setup({ "a.drawio": before });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-duplicate-page", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(before), resultXml: duplicatePages, changedPageIds: ["page-a"] }]
    }, env.resolver);
    expect(result.ok).toBe(false);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(before);
  });

  it("ignores XML attribute order and indentation changes on untouched pages", async () => {
    const before = xml("page-a", "Before A").replace("</mxfile>",
      xml("page-b", "Before B").replace(/^<mxfile>|<\/mxfile>$/g, "") + "</mxfile>");
    const reorderedUntouchedPage = xml("page-b", "Before B")
      .replace('<diagram id="page-b" name="Overview">', '<diagram name="Overview" id="page-b">')
      .replace('id="node" value="Before B" vertex="1" parent="1"', 'parent="1" vertex="1" value="Before B" id="node"');
    const after = xml("page-a", "After A").replace("</mxfile>",
      reorderedUntouchedPage.replace(/^<mxfile>|<\/mxfile>$/g, "") + "</mxfile>");
    const env = await setup({ "a.drawio": before });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-formatting", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(before), resultXml: after, changedPageIds: ["page-a"] }]
    }, env.resolver);
    expect(result.ok).toBe(true);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(after);
  });

  it("rejects two path aliases that resolve to the same physical file", async () => {
    const before = xml("page-a", "Before");
    const env = await setup({ "a.drawio": before });
    const resolver = {
      ...env.resolver,
      resolveWorkspaceFile: async (_relativePath: string) => ({
        workspace: { id: "workspace-1" },
        absolutePath: env.absolute.get("a.drawio")!
      })
    };
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-alias", workspaceId: "workspace-1",
      targets: [
        { filePath: "a.drawio", expectedRevision: revision(before), resultXml: xml("page-a", "After A"), changedPageIds: ["page-a"] },
        { filePath: "A.DRAWIO", expectedRevision: revision(before), resultXml: xml("page-a", "After B"), changedPageIds: ["page-a"] }
      ]
    }, resolver);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("same workspace file");
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(before);
  });

  it("rejects an invalid existing target before preparing a replacement", async () => {
    const original = '<mxfile><diagram id="page-a"><broken/></diagram></mxfile>';
    const env = await setup({ "a.drawio": original });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-invalid-before", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(original), resultXml: xml("page-a", "After"), changedPageIds: ["page-a"] }]
    }, env.resolver);
    expect(result.ok).toBe(false);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(original);
  });

  it("rejects changing the set of page IDs in a proposed file", async () => {
    const before = xml("page-a", "Before");
    const env = await setup({ "a.drawio": before });
    const result = await applyWorkspaceDiagramChangeSet({
      changeSetId: "cs-5", workspaceId: "workspace-1",
      targets: [{ filePath: "a.drawio", expectedRevision: revision(before), resultXml: xml("new-page", "After"), changedPageIds: ["page-a"] }]
    }, env.resolver);
    expect(result.ok).toBe(false);
    expect(await readFile(env.absolute.get("a.drawio")!, "utf8")).toBe(before);
  });
});
