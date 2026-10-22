import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotRuntime } from "./runtime";
import { NativeExecutionAcknowledgements, registerCopilotIntentRoute } from "./intent-route";
import { workspaceRevision } from "../storage";

const XML = '<mxfile><diagram id="p1" name="Page 1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

type ServerHarness = {
  baseUrl: string;
  server: Server;
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  acknowledgements: NativeExecutionAcknowledgements;
  snapshot: ReturnType<typeof vi.fn>;
  copilot: Record<string, unknown>;
};

const servers: Server[] = [];

async function createServer(options: {
  snapshot?: () => Promise<{ drawioXml: string; revision: string } | null>;
  copilot?: Record<string, unknown>;
  acknowledgements?: NativeExecutionAcknowledgements;
} = {}): Promise<ServerHarness> {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const acknowledgements = options.acknowledgements ?? new NativeExecutionAcknowledgements();
  const snapshot = vi.fn(options.snapshot ?? (async () => ({ drawioXml: XML, revision: workspaceRevision(XML) })));
  const copilot = options.copilot ?? {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model")
  };
  registerCopilotIntentRoute(app, {
    copilot: copilot as unknown as CopilotRuntime,
    defaultModel: "test-model",
    writeLog: async (event, fields) => { logs.push({ event, fields }); },
    getStudioConfig: async () => ({ revisionId: "test-config", model: "test-model", reasoningEffort: "max" }),
    getProjectWorkspace: async () => ({ id: "ws-1", name: "Test", rootPath: "/tmp", primaryDiagram: "test.drawio" }),
    getWorkspaceDiagramSnapshot: snapshot,
    collectAgentWorkspaceContext: async () => ({}),
    persistSessionId: vi.fn(async () => undefined),
    acknowledgements
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, logs, acknowledgements, snapshot, copilot };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  )));
});

async function post(baseUrl: string, path: string, body: unknown) {
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

function intentRequest(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "Rename Database",
    context: { kind: "drawio", activePageId: "p1", selectedCell: null, cells: [] },
    diagramXml: XML,
    documentRevision: workspaceRevision(XML),
    sessionId: "route-test-session",
    standalone: false,
    ...overrides
  };
}

function seedAck(store: NativeExecutionAcknowledgements, overrides: Record<string, unknown> = {}) {
  const entry = {
    requestId: "11111111-1111-4111-8111-111111111111",
    sessionId: "route-test-session",
    standalone: false,
    documentRevision: "source-revision",
    operationCount: 2,
    summary: "Rename Database; move API",
    createdAt: Date.now(),
    ...overrides
  };
  store.register(entry as {
    requestId: string; sessionId: string; standalone: boolean; documentRevision: string;
    operationCount: number; summary: string; createdAt: number;
  });
  return entry;
}

function appliedAck(entry: ReturnType<typeof seedAck>, overrides: Record<string, unknown> = {}) {
  return {
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    standalone: entry.standalone,
    documentRevision: entry.documentRevision,
    outcome: "applied",
    editorAcknowledged: true,
    serializedXmlRevision: "saved-revision",
    persistenceStatus: "saved",
    persistedRevision: "saved-revision",
    failureStage: null,
    error: null,
    ...overrides
  };
}

describe("Copilot intent route result and revision contract", () => {
  it("returns stale_context when the source hash does not match the XML", async () => {
    const harness = await createServer();
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ documentRevision: "forged-revision" }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(typeof body.reply).toBe("string");
    expect(harness.snapshot).not.toHaveBeenCalled();
  });

  it("returns stale_context when the active page is not in the current XML", async () => {
    const harness = await createServer();
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      context: { kind: "drawio", activePageId: "missing-page", selectedCell: null, cells: [] }
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(body.documentRevision).toBe(workspaceRevision(XML));
    expect(harness.snapshot).not.toHaveBeenCalled();
  });

  it("returns stale_context when the selected native cell no longer exists", async () => {
    const harness = await createServer();
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      context: { kind: "drawio", activePageId: "p1", selectedCell: { cellId: "deleted", pageId: "p1", label: "Database" }, cells: [] }
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(String(body.error)).toContain("not present");
  });

  it("returns stale_context when workspace revision changed before model processing", async () => {
    const harness = await createServer({
      snapshot: async () => ({ drawioXml: XML + " ", revision: "newer-workspace-revision" })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(body.documentRevision).toBe("newer-workspace-revision");
  });

  it("does not consult or persist workspace state for standalone requests", async () => {
    const copilot = {
      providerInfo: { mode: "byok", host: null },
      resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
      lastObservedModel: vi.fn(() => "test-model")
    };
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ standalone: true }));
    // The deliberately minimal runtime fails after request validation; the isolation check is the contract under test.
    expect(response.status).toBe(502);
    expect(body.outcome).toBe("failed");
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.logs.some((entry) => entry.event === "request.received" && entry.fields?.standalone === true)).toBe(true);
    expect(harness.logs.some((entry) => entry.event === "session.persisted")).toBe(false);
  });
});

describe("Copilot native-edit acknowledgement route", () => {
  it("accepts an applied workspace result only when the saved revision matches", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: "saved-revision" })
    });
    const payload = appliedAck(pending);
    const first = await post(harness.baseUrl, "/api/copilot/intent/ack", payload);
    expect(first.response.status).toBe(200);
    expect(first.body.outcome).toBe("applied");
    expect(harness.logs.filter((entry) => entry.event === "turn.native-edit.final-outcome")).toHaveLength(1);
  });

  it("makes an exact acknowledgement replay idempotent but rejects a conflicting replay", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: "saved-revision" })
    });
    const payload = appliedAck(pending);
    const first = await post(harness.baseUrl, "/api/copilot/intent/ack", payload);
    const replay = await post(harness.baseUrl, "/api/copilot/intent/ack", payload);
    expect(first.response.status).toBe(200);
    expect(replay.response.status).toBe(200);
    expect(replay.body.outcome).toBe("applied");
    const conflict = await post(harness.baseUrl, "/api/copilot/intent/ack", { ...payload, persistedRevision: "different-revision" });
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.outcome).toBe("stale_context");
    expect(harness.logs.filter((entry) => entry.event === "turn.native-edit.final-outcome")).toHaveLength(1);
  });

  it("rejects an applied acknowledgement when persistence revision differs from serialized XML", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: "saved-revision" })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", appliedAck(pending, {
      serializedXmlRevision: "serialized-revision",
      persistedRevision: "saved-revision"
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(harness.logs.some((entry) => entry.event === "turn.native-edit.ack-rejected")).toBe(true);
  });

  it("records editor failures without misreporting them as applied", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store, { standalone: true });
    const harness = await createServer({ acknowledgements: store });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", {
      requestId: pending.requestId, sessionId: pending.sessionId, standalone: true,
      documentRevision: pending.documentRevision, outcome: "failed", editorAcknowledged: false,
      serializedXmlRevision: null, persistenceStatus: "not_attempted", persistedRevision: null,
      failureStage: "editor", error: "Draw.io rejected step 2"
    });
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("failed");
    expect(harness.logs.some((entry) => entry.event === "turn.native-edit.final-outcome" && entry.fields?.failureStage === "editor")).toBe(true);
  });

  it("returns a stale_context outcome for expired acknowledgements", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store, { createdAt: Date.now() - 60 * 60_000 });
    const harness = await createServer({ acknowledgements: store });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", appliedAck(pending));
    expect(response.status).toBe(404);
    expect(body.outcome).toBe("stale_context");
    expect(harness.logs.some((entry) => entry.event === "turn.native-edit.ack-expired")).toBe(true);
  });

  it("rejects a standalone acknowledgement that falsely claims workspace persistence", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store, { standalone: true });
    const harness = await createServer({ acknowledgements: store });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", appliedAck(pending, {
      standalone: true, persistenceStatus: "saved", persistedRevision: "saved-revision"
    }));
    expect(response.status).toBe(400);
    expect(body.outcome).toBe("failed");
  });
});
