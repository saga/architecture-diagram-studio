import { describe, expect, it } from "vitest";
import { parseAIIntentResponse } from "./intent/aiProvider";
import { parseNativeEditOperations } from "./model/native-edit-operations";

describe("native Draw.io Copilot contract", () => {
  it("accepts typed native editor operations with server-resolved cell IDs", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      outcome: "command_ready",
      reply: "Add an audit service",
      nativeEdits: {
        operations: [{ op: "add_node_after", target: "Database", cellId: "db", targetLabel: "Database", newLabel: "Audit Service" }],
        summary: "Add an audit service after Database",
        requestId: "11111111-1111-4111-8111-111111111111",
        pageId: "p1",
        documentRevision: "revision-1"
      },
      model: "stub-model"
    }));
    expect(response.outcome).toBe("command_ready");
    expect(response.nativeEdits?.operations[0]).toMatchObject({
      op: "add_node_after", cellId: "db", newLabel: "Audit Service"
    });
    expect(response.reply).toBe("Add an audit service");
  });

  it("rejects native edit batches without resolved cell IDs", () => {
    expect(() => parseAIIntentResponse(JSON.stringify({
      outcome: "command_ready",
      nativeEdits: {
        operations: [{ op: "set_label", target: "Database", label: "Store" }],
        summary: "Rename",
        requestId: "22222222-2222-4222-8222-222222222222",
        pageId: "p1",
        documentRevision: "revision-1"
      }
    }))).toThrow("resolved cell id");
  });

  it("preserves the requested new label separately from the resolved target label", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      outcome: "command_ready",
      reply: "Renamed Database to Data Store",
      nativeEdits: {
        operations: [{
          op: "set_label", target: "Database", cellId: "db",
          targetLabel: "Database", label: "Data Store"
        }],
        summary: "Rename Database to Data Store",
        requestId: "33333333-3333-4333-8333-333333333333",
        pageId: "p1",
        documentRevision: "revision-1"
      }
    }));
    expect(response.nativeEdits?.operations[0]).toMatchObject({
      op: "set_label", cellId: "db", targetLabel: "Database", label: "Data Store"
    });
  });


  it("validates explicit no-mutation and stale-context outcomes", () => {
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "answered", reply: "The diagram has three services." })).outcome).toBe("answered");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "needs_clarification", reply: "Which database?", question: "Which database?" })).outcome).toBe("needs_clarification");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "unsupported", reply: "Page reordering is not supported.", reason: "no page operation" })).outcome).toBe("unsupported");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "stale_context", reply: "Reload the diagram.", error: "revision mismatch", documentRevision: "new-revision" })).outcome).toBe("stale_context");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "failed", reply: "No edit was applied.", error: "tool call failed" })).outcome).toBe("failed");
    expect(() => parseAIIntentResponse(JSON.stringify({ reply: "The diagram has three services." }))).toThrow("discriminated outcome");
  });

  it("accepts a final applied outcome only when editor, target, revision and version evidence are present", () => {
    const applied = parseAIIntentResponse(JSON.stringify({
      outcome: "applied",
      reply: "Renamed Database.",
      requestId: "11111111-1111-4111-8111-111111111111",
      documentRevision: "revision-2",
      persistedRevision: "revision-2",
      versionId: "v-1700000000-test",
      editorAcknowledged: true,
      persistenceStatus: "saved",
      resolvedTargets: [{ cellId: "db", label: "Database" }]
    }));
    expect(applied.outcome).toBe("applied");
    if (applied.outcome !== "applied") return;
    expect(applied.resolvedTargets).toEqual([{ cellId: "db", label: "Database" }]);
    expect(applied.versionId).toBe("v-1700000000-test");
    expect(() => parseAIIntentResponse(JSON.stringify({
      outcome: "applied", reply: "Done", requestId: "11111111-1111-4111-8111-111111111111",
      documentRevision: "revision-2", versionId: null, editorAcknowledged: true,
      persistenceStatus: "not_managed_by_server", resolvedTargets: []
    }))).not.toThrow();
    expect(() => parseAIIntentResponse(JSON.stringify({
      outcome: "applied", reply: "Done", requestId: "11111111-1111-4111-8111-111111111111",
      documentRevision: "revision-2", versionId: null, editorAcknowledged: true,
      persistenceStatus: "saved"
    }))).toThrow("resolved targets");
  });

  it("rejects invalid JSON and unsupported operations instead of guessing an intent", () => {
    expect(() => parseAIIntentResponse("move database to the right")).toThrow("valid native-edit response");
    expect(parseNativeEditOperations([{ op: "rewrite_whole_diagram", target: "all" }])).toMatchObject({ ok: false });
  });
});
