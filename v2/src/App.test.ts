import { describe, expect, it } from "vitest";
import { parseAIIntentResponse } from "./intent/aiProvider";

describe("native Draw.io Copilot XML contract", () => {
  it("accepts a validated workspace XML commit receipt", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      outcome: "xml_committed",
      reply: "Renamed Database.",
      requestId: "11111111-1111-4111-8111-111111111111",
      persistence: { workspaceRevision: "revision-2", saved: true }
    }));
    expect(response).toMatchObject({
      outcome: "xml_committed",
      requestId: "11111111-1111-4111-8111-111111111111",
      persistence: { workspaceRevision: "revision-2" }
    });
  });

  it("accepts a standalone XML patch with source and patched revisions", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      outcome: "xml_patch_ready",
      reply: "Updated the diagram.",
      requestId: "22222222-2222-4222-8222-222222222222",
      drawioXml: "<mxfile/>",
      documentRevision: "source-revision",
      patchedRevision: "patched-revision",
      changedCellIds: ["db", "api"]
    }));
    expect(response).toMatchObject({
      outcome: "xml_patch_ready",
      documentRevision: "source-revision",
      patchedRevision: "patched-revision",
      changedCellIds: ["db", "api"]
    });
  });

  it("rejects XML commit receipts without a committed workspace revision", () => {
    expect(() => parseAIIntentResponse(JSON.stringify({
      outcome: "xml_committed",
      reply: "Updated the diagram.",
      requestId: "33333333-3333-4333-8333-333333333333",
      persistence: { saved: true }
    }))).toThrow("workspace revision");
  });

  it("validates selection and explicit no-mutation outcomes", () => {
    expect(parseAIIntentResponse(JSON.stringify({
      outcome: "selected", reply: "Selected Database.",
      selection: { cellId: "db", pageId: "p1", label: "Database" }
    })).outcome).toBe("selected");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "answered", reply: "The diagram has three services." })).outcome).toBe("answered");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "needs_clarification", reply: "Which database?", question: "Which database?" })).outcome).toBe("needs_clarification");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "unsupported", reply: "Page reordering is not supported.", reason: "no page operation" })).outcome).toBe("unsupported");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "stale_context", reply: "Reload the diagram.", error: "revision mismatch", documentRevision: "new-revision" })).outcome).toBe("stale_context");
    expect(parseAIIntentResponse(JSON.stringify({ outcome: "failed", reply: "No edit was applied.", error: "tool call failed" })).outcome).toBe("failed");
  });

  it("rejects invalid JSON and retired typed-edit outcomes", () => {
    expect(() => parseAIIntentResponse("move database to the right")).toThrow("valid Copilot intent response");
    expect(() => parseAIIntentResponse(JSON.stringify({
      outcome: "command_ready", reply: "Rename Database", nativeEdits: {}
    }))).toThrow("supported discriminated outcome");
    expect(() => parseAIIntentResponse(JSON.stringify({
      outcome: "proposal_required", reply: "Confirm this change", proposal: {}
    }))).toThrow("supported discriminated outcome");
  });
});
