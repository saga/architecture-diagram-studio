import { describe, expect, it } from "vitest";
import { createNativeExecutionReceipt, transitionNativeExecution } from "./native-execution-protocol";

describe("native execution protocol", () => {
  it("keeps one request identity through execution and persistence", () => {
    const requested = createNativeExecutionReceipt({
      requestId: "request-1", documentRevision: "rev-before", pageId: "page-1",
      beforeXmlHash: "rev-before", now: "2026-10-29T00:00:00.000Z"
    });
    const executing = transitionNativeExecution(requested, "executing", {}, "2026-10-29T00:00:01.000Z");
    const exported = transitionNativeExecution(executing, "exported", { afterXmlHash: "rev-after" }, "2026-10-29T00:00:02.000Z");
    const pending = transitionNativeExecution(exported, "persistence-pending", {}, "2026-10-29T00:00:03.000Z");
    const committed = transitionNativeExecution(pending, "committed", { persistenceRevision: "rev-after", versionId: "version-1" }, "2026-10-29T00:00:04.000Z");
    expect(committed.requestId).toBe("request-1");
    expect(committed.documentRevision).toBe("rev-before");
    expect(committed.afterXmlHash).toBe("rev-after");
    expect(committed.versionId).toBe("version-1");
  });

  it("does not mistake timeout for terminal failure", () => {
    const requested = createNativeExecutionReceipt({ requestId: "r", documentRevision: "rev", pageId: null, beforeXmlHash: "rev" });
    const executing = transitionNativeExecution(requested, "executing");
    const timedOut = transitionNativeExecution(executing, "timed-out-pending-reconciliation", { reconciliationRequired: true });
    const committed = transitionNativeExecution(timedOut, "committed", { afterXmlHash: "next", persistenceRevision: "next" });
    expect(committed.status).toBe("committed");
  });

  it("rejects contradictory terminal transitions", () => {
    const requested = createNativeExecutionReceipt({ requestId: "r", documentRevision: "rev", pageId: null, beforeXmlHash: "rev" });
    const failed = transitionNativeExecution(requested, "failed");
    expect(() => transitionNativeExecution(failed, "committed")).toThrow(/terminal/);
  });
});
