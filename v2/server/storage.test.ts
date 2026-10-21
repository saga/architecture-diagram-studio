import { describe, expect, it } from "vitest";
import { createSerializedWriteQueue, retainRecentVersions, workspaceRevision } from "./storage";
describe("server persistence primitives", () => {
  it("retains the most recent bounded number of versions per workspace", () => {
    const versions = Array.from({ length: 8 }, (_, index) => ({ id: "v" + index, workspaceId: "a" }));
    versions.push({ id: "b0", workspaceId: "b" }, { id: "b1", workspaceId: "b" });
    expect(retainRecentVersions(versions, 3).map((version) => version.id)).toEqual(["v5", "v6", "v7", "b0", "b1"]);
  });
  it("changes the revision when the document or native XML changes", () => {
    expect(workspaceRevision({ id: "a" }, "<xml/>")).not.toBe(workspaceRevision({ id: "a" }, "<changed/>"));
    expect(workspaceRevision({ id: "a" }, "<xml/>")).not.toBe(workspaceRevision({ id: "b" }, "<xml/>"));
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
