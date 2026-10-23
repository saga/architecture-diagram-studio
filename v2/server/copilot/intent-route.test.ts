import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotRuntime } from "./runtime";
import { NativeExecutionAcknowledgements, registerCopilotIntentRoute } from "./intent-route";
import { workspaceRevision } from "../storage";
import type { ResolvedNativeEditOperation } from "../../src/model/native-edit-operations";
import {
  DRAWIO_RUNTIME_BRIDGE_VERSION, PINNED_DRAWIO_VERSION, PINNED_RUNTIME_CAPABILITY_REQUIREMENTS
} from "../../src/model/drawio-runtime-contract";

const XML = '<mxfile><diagram id="p1" name="Page 1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="api" value="API Service" vertex="1" parent="1"><mxGeometry x="200" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

const SAFE_CREATION_SCRIPT = [
  "var parent = graph.getDefaultParent();",
  "var source = model.getCell('db');",
  "var target = null;",
  "var edge = null;",
  "model.beginUpdate();",
  "try {",
  "  target = graph.insertVertex(parent, null, 'ddd', 100, 160, 120, 60, 'rounded=0;whiteSpace=wrap;html=1;');",
  "  edge = graph.insertEdge(parent, null, '', source, target, 'endArrow=block;endFill=1;curved=1;');",
  "} finally { model.endUpdate(); }",
  "graph.refresh();",
  "return { nodeId: target.id, edgeId: edge.id, sourceId: model.getTerminal(edge, true).id, targetId: model.getTerminal(edge, false).id };"
].join("\n");

type ServerHarness = {
  baseUrl: string;
  server: Server;
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  acknowledgements: NativeExecutionAcknowledgements;
  snapshot: ReturnType<typeof vi.fn>;
  copilot: Record<string, unknown>;
  persistSessionId: ReturnType<typeof vi.fn>;
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
  const persistSessionId = vi.fn(async () => undefined);
  registerCopilotIntentRoute(app, {
    copilot: copilot as unknown as CopilotRuntime,
    defaultModel: "test-model",
    writeLog: async (event, fields) => { logs.push({ event, fields }); },
    getStudioConfig: async () => ({ revisionId: "test-config", model: "test-model", reasoningEffort: "max" }),
    getProjectWorkspace: async () => ({ id: "ws-1", name: "Test", rootPath: "/tmp", primaryDiagram: "test.drawio" }),
    getWorkspaceDiagramSnapshot: snapshot,
    getWorkspaceVersionSnapshot: async (versionId) => versionId === "version-1"
      ? { drawioXml: XML, revision: workspaceRevision(XML), versionId }
      : null,
    collectAgentWorkspaceContext: async () => ({}),
    persistSessionId,
    acknowledgements
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, logs, acknowledgements, snapshot, copilot, persistSessionId };
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

function reportingCopilot(outcome: "answered" | "needs_clarification" | "unsupported", reply: string) {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; systemMessage: string; tools: unknown[] } = { configRevisionId: "test-config", systemMessage: "", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    getPreparedSystemMessage: () => prepared.systemMessage,
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
      prepared = await request.prepare();
      activeSession = {
        sdkSessionId: "sdk-test-session", conversationId: request.conversationId, model: request.model,
        observedModel: request.model, configRevisionId: prepared.configRevisionId, requestedEffort: request.requestedEffort,
        reasoningEffort: request.requestedEffort, lastUsedAt: Date.now(), prepared
      };
      return activeSession;
    },
    withTurn: async (_conversationId: string, run: (turn: unknown) => Promise<unknown>) => run({
      get session() { return activeSession; },
      send: async () => {
        const tool = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> })
          .find((candidate) => candidate.name === "report_intent_outcome");
        if (!tool?.handler) throw new Error("report_intent_outcome tool was not registered");
        await tool.handler({ outcome, reply, ...(outcome === "needs_clarification" ? { question: reply } : {}), ...(outcome === "unsupported" ? { reason: "not in allowlist" } : {}) });
        return { message: { data: { content: reply } }, modelCallUsages: [] };
      }
    })
  };
}

function renamingCopilot() {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
      prepared = await request.prepare();
      activeSession = {
        sdkSessionId: "sdk-test-session", conversationId: request.conversationId, model: request.model,
        observedModel: request.model, configRevisionId: prepared.configRevisionId, requestedEffort: request.requestedEffort,
        reasoningEffort: request.requestedEffort, lastUsedAt: Date.now(), prepared
      };
      return activeSession;
    },
    withTurn: async (_conversationId: string, run: (turn: unknown) => Promise<unknown>) => run({
      get session() { return activeSession; },
      send: async () => {
        const tool = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> })
          .find((candidate) => candidate.name === "propose_native_edits");
        if (!tool?.handler) throw new Error("propose_native_edits tool was not registered");
        await tool.handler({ operations: [{ op: "set_label", target: "Database", label: "Data Store" }] });
        return { message: { data: { content: "Rename Database to Data Store." } }, modelCallUsages: [] };
      }
    })
  };
}

function belowNodesCopilot() {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; systemMessage: string; tools: unknown[] } = { configRevisionId: "test-config", systemMessage: "", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    getPreparedSystemMessage: () => prepared.systemMessage,
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
      prepared = await request.prepare();
      activeSession = {
        sdkSessionId: "sdk-test-session", conversationId: request.conversationId, model: request.model,
        observedModel: request.model, configRevisionId: prepared.configRevisionId, requestedEffort: request.requestedEffort,
        reasoningEffort: request.requestedEffort, lastUsedAt: Date.now(), prepared
      };
      return activeSession;
    },
    withTurn: async (_conversationId: string, run: (turn: unknown) => Promise<unknown>) => run({
      get session() { return activeSession; },
      send: async () => {
        const tool = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> })
          .find((candidate) => candidate.name === "propose_native_edits");
        if (!tool?.handler) throw new Error("propose_native_edits tool was not registered");
        await tool.handler({ operations: [
          { op: "add_node_below", target: "Database", newLabel: "ddd" },
          { op: "add_node_below", target: "API Service", newLabel: "eee" }
        ] });
        return { message: { data: { content: "Added ddd below Database and eee below API Service." } }, modelCallUsages: [] };
      }
    })
  };
}

function proposingCopilot(operations: Array<Record<string, unknown>> = [{ op: "delete", target: "Database" }, { op: "delete", target: "API Service" }]) {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
      prepared = await request.prepare();
      activeSession = {
        sdkSessionId: "sdk-test-session", conversationId: request.conversationId, model: request.model,
        observedModel: request.model, configRevisionId: prepared.configRevisionId, requestedEffort: request.requestedEffort,
        reasoningEffort: request.requestedEffort, lastUsedAt: Date.now(), prepared
      };
      return activeSession;
    },
    withTurn: async (_conversationId: string, run: (turn: unknown) => Promise<unknown>) => run({
      get session() { return activeSession; },
      send: async () => {
        const tool = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> })
          .find((candidate) => candidate.name === "propose_native_edits");
        if (!tool?.handler) throw new Error("propose_native_edits tool was not registered");
        await tool.handler({ operations });
        return { message: { data: { content: "Delete both nodes." } }, modelCallUsages: [] };
      }
    })
  };
}

function scriptProposingCopilot(script = "return { checked: true };", summary = "Read-only runtime script for confirmation-gate test") {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
      prepared = await request.prepare();
      activeSession = {
        sdkSessionId: "sdk-test-session", conversationId: request.conversationId, model: request.model,
        observedModel: request.model, configRevisionId: prepared.configRevisionId, requestedEffort: request.requestedEffort,
        reasoningEffort: request.requestedEffort, lastUsedAt: Date.now(), prepared
      };
      return activeSession;
    },
    withTurn: async (_conversationId: string, run: (turn: unknown) => Promise<unknown>) => run({
      get session() { return activeSession; },
      send: async () => {
        const tool = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> })
          .find((candidate) => candidate.name === "propose_native_edits");
        if (!tool?.handler) throw new Error("propose_native_edits tool was not registered");
        await tool.handler({ operations: [{
          op: "run_drawio_script", target: "active_page",
          summary,
          script
        }] });
        return { message: { data: { content: "Inspect and modify the diagram." } }, modelCallUsages: [] };
      }
    })
  };
}

function compatibleRuntimeInspection() {
  const revision = workspaceRevision(XML);
  return {
    schemaVersion: 1,
    bridgeVersion: DRAWIO_RUNTIME_BRIDGE_VERSION,
    drawioVersion: PINNED_DRAWIO_VERSION,
    documentRevision: revision,
    pageId: "p1",
    capabilities: {
      ui: [], editor: [],
      graph: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.graph],
      model: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.model],
      view: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.view],
      vertexCell: [], edgeCell: []
    },
    capabilityManifest: {
      scriptSupported: true,
      required: {
        graph: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.graph],
        model: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.model],
        view: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.view]
      },
      missing: { graph: [], model: [], view: [] }
    },
    counts: { cells: 2, vertices: 2, edges: 0 },
    cells: [],
    renderedEdges: [],
    truncated: false
  };
}

function conflictingCopilot() {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
      prepared = await request.prepare();
      activeSession = {
        sdkSessionId: "sdk-test-session", conversationId: request.conversationId, model: request.model,
        observedModel: request.model, configRevisionId: prepared.configRevisionId, requestedEffort: request.requestedEffort,
        reasoningEffort: request.requestedEffort, lastUsedAt: Date.now(), prepared
      };
      return activeSession;
    },
    withTurn: async (_conversationId: string, run: (turn: unknown) => Promise<unknown>) => run({
      get session() { return activeSession; },
      send: async () => {
        const tools = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> });
        const editTool = tools.find((candidate) => candidate.name === "propose_native_edits");
        const outcomeTool = tools.find((candidate) => candidate.name === "report_intent_outcome");
        if (!editTool?.handler || !outcomeTool?.handler) throw new Error("Required terminal tools were not registered");
        await editTool.handler({ operations: [{ op: "set_label", target: "Database", label: "Data Store" }] });
        await outcomeTool.handler({ outcome: "answered", reply: "No edit is required." });
        return { message: { data: { content: "Conflicting terminal actions." } }, modelCallUsages: [] };
      }
    })
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
    operations: [
      { op: "set_label", target: "Database", label: "Data Store", cellId: "db", targetLabel: "Database" },
      { op: "move", target: "API Service", dx: 10, dy: 0, cellId: "api", targetLabel: "API Service" }
    ] as ResolvedNativeEditOperation[],
    createdAt: Date.now(),
    ...overrides
  };
  store.register(entry as {
    requestId: string; sessionId: string; standalone: boolean; documentRevision: string;
    operationCount: number; summary: string; operations: ResolvedNativeEditOperation[]; createdAt: number;
  });
  return entry;
}

function appliedAck(entry: ReturnType<typeof seedAck>, overrides: Record<string, unknown> = {}) {
  const savedRevision = workspaceRevision(XML);
  return {
    requestId: entry.requestId,
    sessionId: entry.sessionId,
    standalone: entry.standalone,
    documentRevision: entry.documentRevision,
    outcome: "applied",
    editorAcknowledged: true,
    serializedXmlRevision: savedRevision,
    persistenceStatus: "saved",
    persistedRevision: savedRevision,
    versionId: "version-1",
    failureStage: null,
    error: null,
    ...overrides
  };
}

describe("Copilot intent route result and revision contract", () => {
  it("fails closed when the model calls more than one terminal tool in the same turn", async () => {
    const harness = await createServer({ copilot: conflictingCopilot() });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(502);
    expect(body.outcome).toBe("failed");
    expect(harness.acknowledgements.pending.size).toBe(0);
    expect(harness.logs.some((entry) => entry.event === "turn.failed")).toBe(true);
  });

  it("auto-dispatches a small typed below-and-connect batch without a script proposal", async () => {
    const copilot = belowNodesCopilot();
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "在 Database 和 API Service 下方分别添加 ddd 和 eee，并各自连接到来源节点"
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect(body.outcome).not.toBe("proposal_required");
    const nativeEdits = body.nativeEdits as { operations: Array<Record<string, unknown>> };
    expect(nativeEdits.operations).toMatchObject([
      { op: "add_node_below", cellId: "db", targetLabel: "Database", newLabel: "ddd" },
      { op: "add_node_below", cellId: "api", targetLabel: "API Service", newLabel: "eee" }
    ]);
    expect(harness.acknowledgements.pending.size).toBe(1);
    expect(copilot.getPreparedSystemMessage()).toContain("must not be scripted");
  });

  it("uses one canonical prompt for localized rename, selected-cell movement and unsupported operations", async () => {
    const copilot = reportingCopilot("answered", "No document change is needed.");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "把当前选中的 Database 向上移动 10px"
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const prompt = copilot.getPreparedSystemMessage();
    expect(prompt).toContain("把 X 改名为 Y");
    expect(prompt).toContain("negative dy");
    expect(prompt).toContain("selectedCell.cellId");
    expect(prompt).toContain("return needs_clarification");
    expect(prompt).toContain("alignment, distribution, grouping");
    expect(prompt).toContain("run_drawio_script");
    expect(prompt).toContain("actual Draw.io iframe");
  });

  it("auto-dispatches insertion-only native scripts after static validation", async () => {
    const harness = await createServer({
      copilot: scriptProposingCopilot(SAFE_CREATION_SCRIPT, "Create ddd below Database and connect it with a curved edge")
    });
    const requestContext = {
      kind: "drawio", activePageId: "p1", selectedCell: null, cells: [],
      runtimeInspection: compatibleRuntimeInspection()
    };
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ context: requestContext }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    const nativeEdits = body.nativeEdits as { operations: Array<Record<string, unknown>> };
    expect(nativeEdits.operations).toMatchObject([{ op: "run_drawio_script", script: SAFE_CREATION_SCRIPT }]);
    expect(harness.acknowledgements.pending.size).toBe(1);
  });

  it("requires an explicit confirmation proposal for scripts outside the creation-only safe subset", async () => {
    const harness = await createServer({ copilot: scriptProposingCopilot() });
    const requestContext = {
      kind: "drawio", activePageId: "p1", selectedCell: null, cells: [],
      runtimeInspection: compatibleRuntimeInspection()
    };
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ context: requestContext }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("proposal_required");
    expect((body.proposal as { operations: Array<{ op: string }> }).operations).toMatchObject([{ op: "run_drawio_script" }]);
    expect(harness.acknowledgements.pending.size).toBe(0);
  });

  it("requires review before even a single typed deletion", async () => {
    const harness = await createServer({ copilot: proposingCopilot([{ op: "delete", target: "Database" }]) });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("proposal_required");
    expect((body.proposal as { operations: Array<{ op: string }> }).operations).toHaveLength(1);
    expect(harness.acknowledgements.pending.size).toBe(0);
  });

  it("rejects native script operations when the runtime capability manifest is absent", async () => {
    const harness = await createServer({ copilot: scriptProposingCopilot() });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(502);
    expect(body.outcome).toBe("failed");
    expect(harness.acknowledgements.pending.size).toBe(0);
    expect(harness.logs.some((entry) =>
      entry.event === "tool.propose_native_edits.rejected" &&
      entry.fields?.reason === "runtime_capability_manifest_missing_or_mismatched"
    )).toBe(true);
  });

  it("returns stale_context when the source hash does not match the XML", async () => {
    const harness = await createServer();
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ documentRevision: "forged-revision" }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(typeof body.reply).toBe("string");
    expect(harness.snapshot).not.toHaveBeenCalled();
  });

  it("returns a typed failed outcome for malformed native Draw.io XML", async () => {
    const harness = await createServer();
    const malformedXml = '<mxfile><diagram><mxGraphModel><root>';
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      diagramXml: malformedXml,
      documentRevision: workspaceRevision(malformedXml)
    }));
    expect(response.status).toBe(400);
    expect(body.outcome).toBe("failed");
    expect(String(body.reply)).toContain("invalid Draw.io XML");
    expect(harness.acknowledgements.pending.size).toBe(0);
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
    expect(typeof body.requestId).toBe("string");
    expect(harness.logs.some((entry) =>
      entry.event === "request.validation.failed" &&
      entry.fields?.reason === "stale_workspace_revision" &&
      typeof entry.fields?.requestId === "string"
    )).toBe(true);
  });

  it.each([
    ["answered", "The diagram has two nodes."],
    ["needs_clarification", "Which service should be renamed?"],
    ["unsupported", "Page reordering is not supported."]
  ] as const)("returns the model's explicit %s outcome without mutating the diagram", async (outcome, reply) => {
    const harness = await createServer({ copilot: reportingCopilot(outcome, reply) });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe(outcome);
    expect(body.reply).toBe(reply);
    expect(harness.acknowledgements.pending.size).toBe(0);
  });

  it("resolves the same focused rename through the shared pipeline in workspace and standalone modes", async () => {
    const workspaceHarness = await createServer({ copilot: renamingCopilot() });
    const standaloneHarness = await createServer({ copilot: renamingCopilot() });
    const baseRequest = {
      prompt: "Rename Database to Data Store",
      context: { kind: "drawio", activePageId: "p1", selectedCell: null, cells: [] },
      diagramXml: XML,
      documentRevision: workspaceRevision(XML)
    };
    const workspace = await post(workspaceHarness.baseUrl, "/api/copilot/intent", {
      ...baseRequest, sessionId: "workspace-rename", standalone: false
    });
    const standalone = await post(standaloneHarness.baseUrl, "/api/copilot/intent", {
      ...baseRequest, sessionId: "standalone-rename", standalone: true
    });
    expect(workspace.response.status).toBe(200);
    expect(standalone.response.status).toBe(200);
    expect(workspace.body.outcome).toBe("command_ready");
    expect(standalone.body.outcome).toBe("command_ready");
    const workspaceEdit = (workspace.body.nativeEdits as { operations: unknown[] }).operations[0];
    const standaloneEdit = (standalone.body.nativeEdits as { operations: unknown[] }).operations[0];
    expect(workspaceEdit).toMatchObject({ op: "set_label", cellId: "db", targetLabel: "Database", label: "Data Store" });
    expect(standaloneEdit).toEqual(workspaceEdit);
    expect(workspaceHarness.snapshot).toHaveBeenCalledTimes(3);
    expect(standaloneHarness.snapshot).not.toHaveBeenCalled();
    expect(standaloneHarness.persistSessionId).not.toHaveBeenCalled();
  });

  it("turns broad destructive batches into reviewable proposals and requires a fresh explicit confirmation", async () => {
    const harness = await createServer({ copilot: proposingCopilot() });
    const initial = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(initial.response.status).toBe(200);
    expect(initial.body.outcome).toBe("proposal_required");
    const proposal = initial.body.proposal as { id: string; summary: string; operations: unknown[]; pageId: string; documentRevision: string };
    expect(proposal.operations).toHaveLength(2);
    expect(harness.acknowledgements.pending.size).toBe(0);

    const confirmed = await post(harness.baseUrl, "/api/copilot/intent/confirm", {
      proposalId: proposal.id,
      sessionId: "route-test-session",
      standalone: false,
      diagramXml: XML,
      documentRevision: workspaceRevision(XML),
      context: { activePageId: "p1", selectedCell: null }
    });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.outcome).toBe("command_ready");
    expect((confirmed.body.nativeEdits as { operations: unknown[] }).operations).toHaveLength(2);
    expect(harness.acknowledgements.pending.size).toBe(1);

    const replay = await post(harness.baseUrl, "/api/copilot/intent/confirm", {
      proposalId: proposal.id,
      sessionId: "route-test-session",
      standalone: false,
      diagramXml: XML,
      documentRevision: workspaceRevision(XML),
      context: { activePageId: "p1", selectedCell: null }
    });
    expect(replay.response.status).toBe(404);
    expect(replay.body.outcome).toBe("stale_context");
  });

  it("invalidates a proposal when its source revision changes before confirmation", async () => {
    const harness = await createServer({ copilot: proposingCopilot() });
    const initial = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    const proposal = initial.body.proposal as { id: string };
    const changedXml = XML.replace('value="Database"', 'value="Database v2"');
    const response = await post(harness.baseUrl, "/api/copilot/intent/confirm", {
      proposalId: proposal.id, sessionId: "route-test-session", standalone: false,
      diagramXml: changedXml, documentRevision: workspaceRevision(changedXml),
      context: { activePageId: "p1", selectedCell: null }
    });
    expect(response.response.status).toBe(409);
    expect(response.body.outcome).toBe("stale_context");
    expect(harness.acknowledgements.pending.size).toBe(0);
  });

  it("does not consult or persist workspace state for standalone requests", async () => {
    const harness = await createServer({ copilot: reportingCopilot("answered", "This is a standalone diagram.") });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ standalone: true }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    expect(harness.snapshot).not.toHaveBeenCalled();
    expect(harness.persistSessionId).not.toHaveBeenCalled();
    expect(harness.logs.some((entry) => entry.event === "request.received" && entry.fields?.standalone === true)).toBe(true);
  });

  it("returns stale_context when the workspace changes while the model is responding", async () => {
    let snapshots = 0;
    const changedXml = XML.replace('value="Database"', 'value="Database changed externally"');
    const harness = await createServer({
      copilot: reportingCopilot("answered", "The diagram has two nodes."),
      snapshot: async () => {
        snapshots++;
        return snapshots <= 2
          ? { drawioXml: XML, revision: workspaceRevision(XML) }
          : { drawioXml: changedXml, revision: workspaceRevision(changedXml) };
      }
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(snapshots).toBe(3);
  });

  it("loads authoritative workspace XML when the request contains only a revision", async () => {
    const harness = await createServer({ copilot: reportingCopilot("answered", "No diagram changes are needed.") });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ diagramXml: undefined }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    expect(harness.snapshot).toHaveBeenCalled();
  });

  it("resolves duplicate labels beyond the prompt's first 200 cells as ambiguous", async () => {
    const filler = Array.from({ length: 200 }, (_, index) =>
      '<mxCell id="extra-' + index + '" value="' + (index === 199 ? "Database" : "Extra " + index) + '" vertex="1" parent="1"><mxGeometry x="1" y="1" width="20" height="20" as="geometry"/></mxCell>'
    ).join("");
    const crowdedXml = XML.replace("</root>", filler + "</root>");
    const harness = await createServer({
      copilot: proposingCopilot(),
      snapshot: async () => ({ drawioXml: crowdedXml, revision: workspaceRevision(crowdedXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      diagramXml: crowdedXml, documentRevision: workspaceRevision(crowdedXml)
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("needs_clarification");
    expect(String(body.reply)).toContain("ambiguous");
    expect(harness.acknowledgements.pending.size).toBe(0);
  });
});

describe("Copilot native-edit acknowledgement route", () => {
  it("accepts an applied workspace result only when the saved revision matches", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: workspaceRevision(XML), versionId: "version-1" })
    });
    const payload = appliedAck(pending);
    const first = await post(harness.baseUrl, "/api/copilot/intent/ack", payload);
    expect(first.response.status).toBe(200);
    expect(first.body.outcome).toBe("applied");
    expect(first.body.versionId).toBe("version-1");
    expect(first.body.resolvedTargets).toEqual([
      { cellId: "db", label: "Database" },
      { cellId: "api", label: "API Service" }
    ]);
    expect(harness.logs.filter((entry) => entry.event === "turn.native-edit.final-outcome")).toHaveLength(1);
  });

  it("makes an exact acknowledgement replay idempotent but rejects a conflicting replay", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: workspaceRevision(XML), versionId: "version-1" })
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
      snapshot: async () => ({ drawioXml: XML, revision: workspaceRevision(XML), versionId: "version-1" })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", appliedAck(pending, {
      serializedXmlRevision: "serialized-revision",
      persistedRevision: workspaceRevision(XML),
      versionId: "version-1"
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(harness.logs.some((entry) => entry.event === "turn.native-edit.ack-rejected")).toBe(true);
  });

  it("rejects an applied acknowledgement with the wrong immutable workspace version ID", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: workspaceRevision(XML), versionId: "version-1" })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", appliedAck(pending, {
      versionId: "forged-version-id"
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
    expect(body.versionId).toBeNull();
  });

  it("accepts an immutable save acknowledgement if a later edit has advanced the active workspace", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const laterXml = XML.replace('value="Database"', 'value="Database later"');
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: laterXml, revision: workspaceRevision(laterXml), versionId: "version-2" })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", appliedAck(pending));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("applied");
    expect(body.versionId).toBe("version-1");
    expect(harness.snapshot).not.toHaveBeenCalled();
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

  it("records a workspace persistence failure as failed, not applied", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({ acknowledgements: store });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      standalone: false,
      documentRevision: pending.documentRevision,
      outcome: "failed",
      editorAcknowledged: true,
      serializedXmlRevision: workspaceRevision(XML),
      persistenceStatus: "failed",
      persistedRevision: null,
      versionId: null,
      failureStage: "persistence",
      error: "The workspace write was rejected."
    });
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("failed");
    expect(body.reply).toContain("workspace write was rejected");
    expect(harness.logs.some((entry) =>
      entry.event === "turn.native-edit.final-outcome" &&
      entry.fields?.outcome === "failed" &&
      entry.fields?.failureStage === "persistence"
    )).toBe(true);
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
