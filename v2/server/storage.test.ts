import { describe, expect, it } from "vitest";
import { createSerializedWriteQueue, isWorkspaceSaveContextCompatible, matchesWorkspaceRevision, retainRecentVersions, workspaceRevision } from "./storage";
describe("server persistence primitives", () => {
  it("retains the most recent bounded number of versions per workspace", () => {
    const versions = Array.from({ length: 8 }, (_, index) => ({ id: "v" + index, workspaceId: "a" }));
    versions.push({ id: "b0", workspaceId: "b" }, { id: "b1", workspaceId: "b" });
    expect(retainRecentVersions(versions, 3).map((version) => version.id)).toEqual(["v5", "v6", "v7", "b0", "b1"]);
  });
  it("enforces a global version cap even when snapshots span many workspaces", () => {
    const versions = Array.from({ length: 24 }, (_, index) => ({ id: "v" + index, workspaceId: "workspace-" + (index % 6) }));
    const retained = retainRecentVersions(versions, 10, 7);
    expect(retained).toHaveLength(7);
    expect(retained.map((version) => version.id)).toEqual(["v17", "v18", "v19", "v20", "v21", "v22", "v23"]);
  });
  it("retains version history independently for each diagram in the same workspace", () => {
    const versions = [
      { id: "a0", workspaceId: "w", diagramPath: "a.drawio" },
      { id: "a1", workspaceId: "w", diagramPath: "a.drawio" },
      { id: "b0", workspaceId: "w", diagramPath: "b.drawio" },
      { id: "b1", workspaceId: "w", diagramPath: "b.drawio" },
      { id: "a2", workspaceId: "w", diagramPath: "a.drawio" },
      { id: "b2", workspaceId: "w", diagramPath: "b.drawio" }
    ];
    expect(retainRecentVersions(versions, 2, 10).map((version) => version.id)).toEqual(["a1", "b1", "a2", "b2"]);
  });
  it("accepts only a supplied revision equal to the current server revision", () => {
    expect(matchesWorkspaceRevision(undefined, null)).toBe(false);
    expect(matchesWorkspaceRevision("stale", "current")).toBe(false);
    expect(matchesWorkspaceRevision(null, null)).toBe(true);
    expect(matchesWorkspaceRevision("current", "current")).toBe(true);
  });
  it("rejects stale document saves after a workspace switch", () => {
    expect(isWorkspaceSaveContextCompatible(true, true, true, "current")).toBe(true);
    expect(isWorkspaceSaveContextCompatible(false, true, true, null)).toBe(false);
    expect(isWorkspaceSaveContextCompatible(false, false, true, null)).toBe(false);
    expect(isWorkspaceSaveContextCompatible(false, false, false, "stale")).toBe(false);
    expect(isWorkspaceSaveContextCompatible(false, false, false, undefined)).toBe(false);
    expect(isWorkspaceSaveContextCompatible(false, false, false, null)).toBe(true);
  });
  it("tracks workspace revisions from the authoritative XML only", () => {
    expect(workspaceRevision("<xml/>")).not.toBe(workspaceRevision("<changed/>"));
    expect(workspaceRevision("<xml/>")).toBe(workspaceRevision("<xml/>"));
  });
  it("keeps the write queue usable after a failed write", async () => {
    const write = createSerializedWriteQueue(), order: number[] = [];
    await Promise.all([
      write(async () => { order.push(1); throw new Error("expected"); }).catch(() => undefined),
      write(async () => { order.push(2); })
    ]);
    expect(order).toEqual([1, 2]);
  });
});
