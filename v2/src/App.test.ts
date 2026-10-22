import { describe, expect, it } from "vitest";
import { parseAIIntentResponse } from "./intent/aiProvider";
import { parseNativeEditOperations } from "./model/native-edit-operations";

describe("native Draw.io Copilot contract", () => {
  it("accepts typed native editor operations with server-resolved cell IDs", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      reply: "Add an audit service",
      nativeEdits: {
        operations: [{ op: "add_node_after", target: "Database", cellId: "db", targetLabel: "Database", newLabel: "Audit Service" }],
        summary: "Add an audit service after Database",
        requiresClientExecution: true
      },
      model: "stub-model"
    }));
    expect(response.nativeEdits?.operations[0]).toMatchObject({
      op: "add_node_after", cellId: "db", newLabel: "Audit Service"
    });
    expect(response.reply).toBe("Add an audit service");
  });

  it("rejects native edit batches without resolved cell IDs", () => {
    expect(() => parseAIIntentResponse(JSON.stringify({
      nativeEdits: {
        operations: [{ op: "set_label", target: "Database", label: "Store" }],
        summary: "Rename",
        requiresClientExecution: true
      }
    }))).toThrow("resolved cell id");
  });

  it("preserves the requested new label separately from the resolved target label", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      reply: "Renamed Database to Data Store",
      nativeEdits: {
        operations: [{
          op: "set_label", target: "Database", cellId: "db",
          targetLabel: "Database", label: "Data Store"
        }],
        summary: "Rename Database to Data Store",
        requiresClientExecution: true
      }
    }));
    expect(response.nativeEdits?.operations[0]).toMatchObject({
      op: "set_label", cellId: "db", targetLabel: "Database", label: "Data Store"
    });
  });


  it("rejects invalid JSON and unsupported operations instead of guessing an intent", () => {
    expect(() => parseAIIntentResponse("move database to the right")).toThrow("valid native-edit response");
    expect(parseNativeEditOperations([{ op: "rewrite_whole_diagram", target: "all" }])).toMatchObject({ ok: false });
  });
});
