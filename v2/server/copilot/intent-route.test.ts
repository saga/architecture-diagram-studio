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
  "if (!source) { throw new Error('source cell not found'); }",
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

function reportingCopilot(
  outcome: "answered" | "needs_clarification" | "unsupported",
  reply: string
): Record<string, unknown> & { getPreparedSystemMessage: () => string } {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; systemMessage: string; tools: unknown[] } = { configRevisionId: "test-config", systemMessage: "", tools: [] };
  const prompts: string[] = [];
  const copilot = {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    getPreparedSystemMessage: () => prepared.systemMessage,
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
      send: async (input: { prompt: string }) => {
        prompts.push(input.prompt);
        const tool = prepared.tools.map((candidate) => candidate as { name?: string; handler?: (args: unknown) => Promise<unknown> })
          .find((candidate) => candidate.name === "report_intent_outcome");
        if (!tool?.handler) throw new Error("report_intent_outcome tool was not registered");
        await tool.handler({ outcome, reply, ...(outcome === "needs_clarification" ? { question: reply } : {}), ...(outcome === "unsupported" ? { reason: "not in allowlist" } : {}) });
        return { message: { data: { content: reply } }, modelCallUsages: [] };
      }
    })
  };
  Object.defineProperty(copilot, "prompts", { get: () => prompts });
  return copilot;
}

function elementSearchingCopilot(
  query = "Payment Orchestrator",
  toolName = "search_drawio_elements",
  toolArgs?: unknown
) {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; systemMessage: string; tools: unknown[] } = { configRevisionId: "test-config", systemMessage: "", tools: [] };
  let searchResult: unknown = null;
  const copilot: Record<string, unknown> = {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    getPreparedSystemMessage: () => prepared.systemMessage,
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
        const search = tools.find((candidate) => candidate.name === toolName);
        if (!search?.handler) throw new Error(toolName + " tool was not registered");
        searchResult = await search.handler(toolArgs !== undefined ? toolArgs : { query, limit: 5 });
        const report = tools.find((candidate) => candidate.name === "report_intent_outcome");
        if (!report?.handler) throw new Error("report_intent_outcome tool was not registered");
        await report.handler({ outcome: "answered", reply: "Element search completed." });
        return { message: { data: { content: "Element search completed." } }, modelCallUsages: [] };
      }
    })
  };
  Object.defineProperty(copilot, "searchResult", { get: () => searchResult });
  return copilot;
}

function shapeSearchingCopilot(query: string) {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; systemMessage: string; tools: unknown[] } = { configRevisionId: "test-config", systemMessage: "", tools: [] };
  let searchResponse: Record<string, unknown> = {};
  const copilot: Record<string, unknown> = {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    getPreparedSystemMessage: () => prepared.systemMessage,
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
        const search = tools.find((candidate) => candidate.name === "search_drawio_shapes");
        if (!search?.handler) throw new Error("search_drawio_shapes tool was not registered");
        searchResponse = (await search.handler({ query })) as Record<string, unknown>;
        const report = tools.find((candidate) => candidate.name === "report_intent_outcome");
        if (!report?.handler) throw new Error("report_intent_outcome tool was not registered");
        await report.handler({ outcome: "answered", reply: "Shape search completed." });
        return { message: { data: { content: "Shape search completed." } }, modelCallUsages: [] };
      }
    })
  };
  Object.defineProperty(copilot, "searchResponse", { get: () => searchResponse });
  return copilot;
}

function renamingCopilot() {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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

function ambiguousTargetCopilot() {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    getPreparedSystemMessage: () => "",
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
        const edit = tools.find((candidate) => candidate.name === "propose_native_edits");
        const report = tools.find((candidate) => candidate.name === "report_intent_outcome");
        if (!edit?.handler || !report?.handler) throw new Error("Required tools were not registered");
        const rejected = await edit.handler({ operations: [{ op: "delete", target: "Database" }] }) as { accepted?: boolean; reason?: string; error?: string };
        if (rejected.accepted !== false || rejected.reason !== "unresolved_targets") {
          throw new Error("Expected a structured ambiguous-target rejection, received " + JSON.stringify(rejected));
        }
        const reply = "The label Database is ambiguous; choose the exact element ID.";
        await report.handler({ outcome: "needs_clarification", reply, question: reply });
        return { message: { data: { content: reply } }, modelCallUsages: [] };
      }
    })
  };
}

function scriptProposingCopilot(
  script = "return { checked: true };",
  summary = "Read-only runtime script for confirmation-gate test",
  mode: "read" | "mutate" = "mutate"
) {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  return {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
          .find((candidate) => candidate.name === "run_drawio_script");
        if (!tool?.handler) throw new Error("run_drawio_script tool was not registered");
        await tool.handler({ summary, script, mode });
        return { message: { data: { content: "Inspect and modify the diagram." } }, modelCallUsages: [] };
      }
    })
  };
}

function terminalConflictCopilot(
  scenario: "read-edit-report" | "report-edit" | "duplicate-edit" | "throw-after-edit" | "select-only" | "invalid-select"
) {
  let activeSession: Record<string, unknown> = {};
  let prepared: { configRevisionId: string; tools: unknown[] } = { configRevisionId: "test-config", tools: [] };
  const toolResults: Record<string, Record<string, unknown>> = {};
  const copilot: Record<string, unknown> = {
    providerInfo: { mode: "byok", host: null },
    resolveModel: vi.fn(async (requested: string) => ({ model: requested, reason: "test", substituted: false, available: [] })),
    lastObservedModel: vi.fn(() => "test-model"),
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
        const tools = prepared.tools.map((candidate) => candidate as {
          name?: string; handler?: (args: unknown) => Promise<unknown>
        });
        const invoke = async (name: string, args: unknown) => {
          const tool = tools.find((candidate) => candidate.name === name);
          if (!tool?.handler) throw new Error(name + " tool was not registered");
          const suffix = Object.keys(toolResults).filter((key) => key === name || key.startsWith(name + "#")).length;
          toolResults[suffix === 0 ? name : name + "#" + suffix] =
            await tool.handler(args) as Record<string, unknown>;
        };
        const propose = async (label: string) => invoke("propose_native_edits", {
          operations: [{ op: "set_label", target: "Database", label }]
        });
        const report = async () => invoke("report_intent_outcome", {
          outcome: "answered", reply: "No diagram changes are needed."
        });
        if (scenario === "read-edit-report") {
          await invoke("run_drawio_script", {
            summary: "Inspect existing labels before translation",
            script: "return { labels: ['Database'] };",
            mode: "read"
          });
          await propose("数据库");
          await report();
        } else if (scenario === "report-edit") {
          await report();
          await propose("数据库");
        } else if (scenario === "throw-after-edit") {
          await propose("数据库");
          throw new Error("Synthetic SDK stream failure after native edit was accepted");
        } else if (scenario === "select-only") {
          await invoke("select_diagram_element", { target: "Database" });
        } else if (scenario === "invalid-select") {
          await invoke("select_diagram_element", { target: "" });
          await invoke("report_intent_outcome", {
            outcome: "needs_clarification", reply: "Select a specific element from the current diagram.", question: "Which element should be selected?"
          });
        } else {
          await propose("第一版");
          await propose("第二版");
        }
        return { message: { data: { content: "The native edit request was processed." } }, modelCallUsages: [] };
      }
    })
  };
  Object.defineProperty(copilot, "toolResults", { get: () => toolResults });
  return copilot;
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
    acquireSession: async (request: { conversationId: string; model: string; requestedEffort: "low" | "medium" | "high" | "max"; prepare: () => Promise<{ configRevisionId: string; systemMessage: string; tools: unknown[]; workspaceId?: string }> }) => {
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
    applicationState: "applied-and-verified",
    failureStage: null,
    error: null,
    ...overrides
  };
}

describe("Copilot intent route result and revision contract", () => {
  it("dispatches the first valid edit when a later terminal report conflicts", async () => {
    const harness = await createServer({ copilot: conflictingCopilot() });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "set_label", cellId: "db", targetLabel: "Database", label: "Data Store" }]);
    expect(harness.acknowledgements.pending.size).toBe(1);
    expect(harness.logs.some((entry) => entry.event === "turn.failed" &&
      entry.fields?.reason === "conflicting_terminal_tools")).toBe(false);
    expect(harness.logs.some((entry) => entry.event === "tool.terminal-intent.rejected" &&
      entry.fields?.requestedKind === "no_mutation" && entry.fields?.registeredKind === "native_edit")).toBe(true);
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
    expect(String(copilot.getPreparedSystemMessage())).toContain("typed operations are shortcuts, not limits");
  });

  it("uses one canonical prompt for localized rename, selected-cell movement and unsupported operations", async () => {
    const copilot = reportingCopilot("answered", "No document change is needed.");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "把当前选中的 Database 向上移动 10px"
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const prompt = String(copilot.getPreparedSystemMessage());
    expect(prompt).toContain("Preserve rename text verbatim");
    expect(prompt).toContain("up/left negative, down/right positive");
    expect(prompt).toContain("selectedCell.cellId");
    expect(prompt).toContain("catalogue misses do not prove absence");
    expect(prompt).toContain("run_drawio_script");
    expect(prompt).toContain("Scripts receive live ui/editor/graph/model/inspectRuntime bindings");
    expect(prompt).toContain("exactly one terminal action per turn");
    expect(prompt.length).toBeLessThan(2800);
    const firstRequest = JSON.parse((copilot as unknown as { prompts: string[] }).prompts[0]!) as { editingGuidance: string };
    expect(firstRequest.editingGuidance).toContain("search/inspection results bound to this exact documentRevision");
  });

  it("dispatches insertion-only native scripts without a confirmation step", async () => {
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
    expect(harness.logs.some((entry) =>
      entry.event === "tool.run_drawio_script.accepted" && entry.fields?.script === SAFE_CREATION_SCRIPT
    )).toBe(true);
  });
  it("reports a queued selection without claiming the canvas has selected it", async () => {
    const copilot = terminalConflictCopilot("select-only");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ prompt: "Select Database" }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("selected");
    expect(body.selection).toMatchObject({ cellId: "db", label: "Database", pageId: "p1" });
    const results = (copilot as { toolResults: Record<string, Record<string, unknown>> }).toolResults;
    expect(results.select_diagram_element).toMatchObject({
      accepted: true, queued: true, execution: "after_model_turn",
      terminal: true, result_available: false, action: "select_diagram_element"
    });
    expect(results.select_diagram_element).not.toHaveProperty("selected", true);
  });

  it("returns actionable tool feedback for an invalid selection target", async () => {
    const copilot = terminalConflictCopilot("invalid-select");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ prompt: "Select this" }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("needs_clarification");
    const results = (copilot as { toolResults: Record<string, Record<string, unknown>> }).toolResults;
    expect(results.select_diagram_element).toMatchObject({
      selected: false, accepted: false, reason: "invalid_target"
    });
    expect(String(results.select_diagram_element.error)).toContain("non-empty target");
    expect(results.report_intent_outcome).toMatchObject({ accepted: true, terminal: true, outcome: "needs_clarification" });
  });

  it("does not let a deferred read script consume the terminal slot before a Chinese label edit", async () => {
    const copilot = terminalConflictCopilot("read-edit-report");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "set_label", cellId: "db", label: "数据库", targetLabel: "Database" }]);
    const results = (copilot as { toolResults: Record<string, Record<string, unknown>> }).toolResults;
    expect(results.run_drawio_script).toMatchObject({
      accepted: false, mode: "read", result_available: false, terminal: false,
      reason: "deferred_script_has_no_current_turn_result"
    });
    expect(results.propose_native_edits).toMatchObject({ accepted: true, operationCount: 1 });
    expect(results.report_intent_outcome).toMatchObject({
      recorded: false, accepted: false, reason: "terminal_action_already_registered", registeredKind: "native_edit"
    });
    expect(harness.acknowledgements.pending.size).toBe(1);
    expect(harness.logs.some((entry) => entry.event === "tool.run_drawio_script.read.rejected")).toBe(true);
    expect(harness.logs.some((entry) => entry.event === "tool.terminal-intent.rejected" &&
      entry.fields?.requestedKind === "no_mutation" && entry.fields?.registeredKind === "native_edit")).toBe(true);
    expect(harness.logs.some((entry) => entry.event === "turn.failed" &&
      entry.fields?.reason === "conflicting_terminal_tools")).toBe(false);
  });

  it("preserves an accepted native edit when the SDK stream fails afterward", async () => {
    const copilot = terminalConflictCopilot("throw-after-edit");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect(String(body.reply)).toContain("model stream failed after a terminal action was accepted");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "set_label", cellId: "db", targetLabel: "Database", label: "数据库" }]);
    expect(harness.acknowledgements.pending.size).toBe(1);
    expect(harness.logs.some((entry) => entry.event === "turn.model-call.failed-after-terminal-intent.failed" &&
      entry.fields?.terminalKind === "native_edit" && entry.fields?.acceptedNativeEdit === true &&
      String(entry.fields?.errorMessage).includes("Synthetic SDK stream failure"))).toBe(true);
    expect(harness.logs.some((entry) => entry.event === "turn.failed")).toBe(false);
  });

  it("promotes a concrete native edit over a premature no-mutation report", async () => {
    const copilot = terminalConflictCopilot("report-edit");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "set_label", cellId: "db", label: "数据库" }]);
    const results = (copilot as { toolResults: Record<string, Record<string, unknown>> }).toolResults;
    expect(results.report_intent_outcome).toMatchObject({ recorded: true, accepted: true });
    expect(results.propose_native_edits).toMatchObject({ accepted: true, operationCount: 1 });
    expect(harness.logs.some((entry) => entry.event === "tool.terminal-intent.promoted-to-edit" &&
      entry.fields?.replacedKind === "no_mutation")).toBe(true);
    expect(harness.acknowledgements.pending.size).toBe(1);
  });

  it("keeps the first valid edit when a second terminal edit is attempted", async () => {
    const copilot = terminalConflictCopilot("duplicate-edit");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "set_label", cellId: "db", label: "第一版" }]);
    const results = (copilot as { toolResults: Record<string, Record<string, unknown>> }).toolResults;
    expect(results.propose_native_edits).toMatchObject({ accepted: true, operationCount: 1 });
    expect(results["propose_native_edits#1"]).toMatchObject({
      accepted: false, reason: "terminal_action_already_registered", registeredKind: "native_edit"
    });
    expect(harness.acknowledgements.pending.size).toBe(1);
    expect(harness.logs.some((entry) => entry.event === "turn.failed" &&
      entry.fields?.reason === "conflicting_terminal_tools")).toBe(false);
  });

  it("dispatches no-op scripts without requiring manifest approval or confirmation", async () => {
    const harness = await createServer({ copilot: scriptProposingCopilot() });
    const requestContext = {
      kind: "drawio", activePageId: "p1", selectedCell: null, cells: [],
      runtimeInspection: compatibleRuntimeInspection()
    };
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ context: requestContext }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "run_drawio_script", script: "return { checked: true };" }]);
    expect(harness.acknowledgements.pending.size).toBe(1);
  });
  it("dispatches a single typed deletion without a second confirmation", async () => {
    const harness = await createServer({ copilot: proposingCopilot([{ op: "delete", target: "Database" }]) });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "delete", cellId: "db", targetLabel: "Database" }]);
    expect(harness.acknowledgements.pending.size).toBe(1);
  });
  it("allows direct script execution when the runtime capability manifest is absent", async () => {
    const harness = await createServer({ copilot: scriptProposingCopilot("graph.refresh();") });
    const requestContext = { kind: "drawio", activePageId: "p1", selectedCell: null, cells: [] };
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ context: requestContext }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: Array<Record<string, unknown>> }).operations)
      .toMatchObject([{ op: "run_drawio_script", script: "graph.refresh();" }]);
    expect(harness.acknowledgements.pending.size).toBe(1);
    expect(harness.logs.some((entry) =>
      entry.event === "tool.run_drawio_script.accepted" && entry.fields?.script === "graph.refresh();"
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

  it("does not classify model and SDK errors by English message wording", async () => {
    const failures = [
      "The requested model was not found among configured providers.",
      "The provider is not supported by this SDK version."
    ];
    for (const failureMessage of failures) {
      const copilot = reportingCopilot("answered", "This response should not be reached.");
      copilot.withTurn = async () => { throw new Error(failureMessage); };
      const harness = await createServer({ copilot });
      const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
      expect(response.status).toBe(502);
      expect(body.outcome).toBe("failed");
      expect(harness.logs.some((entry) => entry.event === "turn.failed" &&
        String(entry.fields?.errorMessage).includes(failureMessage))).toBe(true);
    }
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

  it("dispatches broad destructive batches without a confirmation gate", async () => {
    const harness = await createServer({ copilot: proposingCopilot() });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("command_ready");
    expect((body.nativeEdits as { operations: unknown[] }).operations).toHaveLength(2);
    expect(harness.acknowledgements.pending.size).toBe(1);
  });
  it("rejects a workspace XML snapshot that is stale against the authoritative revision", async () => {
    const harness = await createServer({ copilot: proposingCopilot() });
    const editedXml = XML.replace('value="Database"', 'value="Warehouse"');
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      diagramXml: editedXml, documentRevision: workspaceRevision(editedXml)
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");
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

  it("searches native cells omitted from the compact 200-cell prompt context", async () => {
    const filler = Array.from({ length: 230 }, (_, index) =>
      '<mxCell id="search-extra-' + index + '" value="Unrelated Component ' + index + '" vertex="1" parent="1"><mxGeometry x="1" y="1" width="20" height="20" as="geometry"/></mxCell>'
    ).join("");
    const target = '<mxCell id="payment-orchestrator" value="Payment Orchestrator" vertex="1" parent="1"><mxGeometry x="1" y="1" width="20" height="20" as="geometry"/></mxCell>';
    const crowdedXml = XML.replace("</root>", filler + target + "</root>");
    const copilot = elementSearchingCopilot();
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: crowdedXml, revision: workspaceRevision(crowdedXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "Find Payment Orchestrator",
      diagramXml: crowdedXml,
      documentRevision: workspaceRevision(crowdedXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const searchResult = (copilot as { searchResult?: {
      found: boolean; matchCount: number; pageId: string | null; documentRevision: string | null;
      results: Array<{ id: string; label: string }>
    } }).searchResult;
    expect(searchResult?.found).toBe(true);
    expect(searchResult?.matchCount).toBe(1);
    expect(searchResult?.pageId).toBe("p1");
    expect(searchResult?.documentRevision).toBe(workspaceRevision(crowdedXml));
    expect(searchResult?.results).toMatchObject([{
      id: "payment-orchestrator", label: "Payment Orchestrator", cellType: expect.any(String),
      geometry: { x: 1, y: 1, width: 20, height: 20 }, parentId: "1"
    }]);
    expect(harness.logs.some((entry) => entry.event === "tool.search_drawio_elements.completed")).toBe(true);
    expect(harness.acknowledgements.pending.size).toBe(0);
  });

  it("returns exact-label and rich-label substring matches together, ranking exact labels first", async () => {
    const exactTargets = ["11", "36", "50"].map((id) =>
      '<mxCell id="task-' + id + '" value="Task 7" vertex="1" parent="1"><mxGeometry x="1" y="1" width="20" height="20" as="geometry"/></mxCell>'
    ).join("");
    const wrappedTargets = ["63", "66"].map((id) =>
      '<object label="Task 7&lt;br&gt;%status%" placeholders="1"><mxCell id="task-' + id +
      '" vertex="1" parent="1"><mxGeometry x="1" y="1" width="20" height="20" as="geometry"/></mxCell></object>'
    ).join("");
    const taskXml = XML.replace("</root>", exactTargets + wrappedTargets + "</root>");
    const copilot = elementSearchingCopilot("Task 7", "search_drawio_elements", { query: "Task 7", limit: 10 });
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: taskXml, revision: workspaceRevision(taskXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: 'Find every cell containing "Task 7"',
      diagramXml: taskXml,
      documentRevision: workspaceRevision(taskXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const result = (copilot as { searchResult?: {
      found: boolean; matchCount: number; truncated: boolean;
      results: Array<{ id: string; label: string }>
    } }).searchResult;
    expect(result?.found).toBe(true);
    expect(result?.matchCount).toBe(5);
    expect(result?.truncated).toBe(false);
    expect(result?.results.map((item) => item.id)).toEqual([
      "task-11", "task-36", "task-50", "task-63", "task-66"
    ]);
  });

  it("does not let a truncated element search masquerade as a complete bulk-edit target set", async () => {
    const targets = Array.from({ length: 12 }, (_, index) =>
      '<mxCell id="task-' + index + '" value="Task 7" vertex="1" parent="1"><mxGeometry x="' +
      (index * 30) + '" y="1" width="20" height="20" as="geometry"/></mxCell>'
    ).join("");
    const taskXml = XML.replace("</root>", targets + "</root>");
    const revision = workspaceRevision(taskXml);
    const searchCopilot = elementSearchingCopilot("Task 7", "search_drawio_elements", { query: "Task 7" });
    const searchHarness = await createServer({
      copilot: searchCopilot,
      snapshot: async () => ({ drawioXml: taskXml, revision })
    });
    const searched = await post(searchHarness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: 'Find all "Task 7" cells',
      diagramXml: taskXml,
      documentRevision: revision
    }));
    expect(searched.response.status).toBe(200);
    const searchResult = (searchCopilot as { searchResult?: {
      matchCount: number; returnedCount: number; truncated: boolean; guidance?: string
    } }).searchResult;
    expect(searchResult).toMatchObject({
      matchCount: 12, returnedCount: 10, truncated: true
    });
    expect(searchResult?.guidance).toContain("do not perform an 'all' edit from this subset");
    expect(searchResult?.guidance).toContain("inspect_drawio_graph");

    const inspectCopilot = elementSearchingCopilot("", "inspect_drawio_graph", {
      query: "Task 7", offset: 0, limit: 100
    });
    const inspectHarness = await createServer({
      copilot: inspectCopilot,
      snapshot: async () => ({ drawioXml: taskXml, revision })
    });
    const inspected = await post(inspectHarness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: 'Inspect all "Task 7" cells',
      diagramXml: taskXml,
      documentRevision: revision
    }));
    expect(inspected.response.status).toBe(200);
    const inspection = (inspectCopilot as { searchResult?: {
      totalCount: number; returnedCount: number; truncated: boolean;
      pageId: string | null; documentRevision: string | null; results: Array<{ id: string }>
    } }).searchResult;
    expect(inspection).toMatchObject({
      totalCount: 12, returnedCount: 12, truncated: false, pageId: "p1", documentRevision: revision
    });
    expect(inspection?.results.map((cell) => cell.id)).toEqual(
      Array.from({ length: 12 }, (_, index) => "task-" + index)
    );
  });

  it("returns a structured rejection when the reference tool receives null arguments", async () => {
    const copilot = elementSearchingCopilot("", "get_drawio_reference", null);
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "Read the Draw.io API reference"
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    expect((copilot as { searchResult?: Record<string, unknown> }).searchResult).toMatchObject({
      accepted: false, reason: "invalid_reference_topic"
    });
    expect(harness.logs.some((entry) => entry.event === "turn.failed")).toBe(false);
  });

  it("accepts a single Chinese character in curated shape search", async () => {
    const copilot = shapeSearchingCopilot("桌");
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "查找桌子形状"
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    expect((copilot as { searchResponse?: Record<string, unknown> }).searchResponse).toBeTruthy();
    expect(harness.logs.some((entry) => entry.event === "tool.search_drawio_shapes.rejected")).toBe(false);
  });

  it("searches unlabeled floor-plan furniture using a single Chinese character", async () => {
    const furniture = '<mxCell id="table-north" value="桌子" style="shape=mxgraph.floorplan.table;" vertex="1" parent="1">' +
      '<mxGeometry x="300" y="210" width="82" height="42" as="geometry"/></mxCell>';
    const floorplanXml = XML.replace("</root>", furniture + "</root>");
    const copilot = elementSearchingCopilot("桌");
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: floorplanXml, revision: workspaceRevision(floorplanXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "搜索桌",
      diagramXml: floorplanXml,
      documentRevision: workspaceRevision(floorplanXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const result = (copilot as { searchResult?: {
      matchCount: number; pageId: string | null; documentRevision: string | null;
      results: Array<Record<string, unknown>>
    } }).searchResult;
    expect(result?.matchCount).toBe(1);
    expect(result?.pageId).toBe("p1");
    expect(result?.documentRevision).toBe(workspaceRevision(floorplanXml));
    expect(result?.results[0]).toMatchObject({
      id: "table-north", label: "桌子", shape: "mxgraph.floorplan.table",
      geometry: { x: 300, y: 210, width: 82, height: 42 }
    });
  });

  it("inspects unnamed furniture by native shape and paginates without ending the turn", async () => {
    const tableA = '<mxCell id="table-a" value="" style="shape=mxgraph.floorplan.table;" vertex="1" parent="1">' +
      '<mxGeometry x="300" y="210" width="82" height="42" as="geometry"/></mxCell>';
    const tableB = '<mxCell id="table-b" value="" style="shape=mxgraph.floorplan.table;" vertex="1" parent="1">' +
      '<mxGeometry x="430" y="210" width="82" height="42" as="geometry"/></mxCell>';
    const floorplanXml = XML.replace("</root>", tableA + tableB + "</root>");
    const copilot = elementSearchingCopilot("", "inspect_drawio_graph", {
      shape: "mxgraph.floorplan.table", unlabeled: true, offset: 0, limit: 1
    });
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: floorplanXml, revision: workspaceRevision(floorplanXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "Inspect unnamed table shapes",
      diagramXml: floorplanXml,
      documentRevision: workspaceRevision(floorplanXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const result = (copilot as { searchResult?: Record<string, unknown> }).searchResult;
    expect(result).toMatchObject({
      source: "native-drawio-xml", pageId: "p1", totalCount: 2,
      offset: 0, limit: 1, returnedCount: 1, nextOffset: 1, truncated: true,
      results: [{
        id: "table-a", label: "", cellType: "vertex", shape: "mxgraph.floorplan.table",
        geometry: { x: 300, y: 210, width: 82, height: 42 }, parentId: "1"
      }]
    });
    expect(harness.logs.some((entry) => entry.event === "tool.inspect_drawio_graph.completed")).toBe(true);
    expect(harness.acknowledgements.pending.size).toBe(0);
  });

  it("resolves duplicate labels beyond the prompt's first 200 cells as ambiguous", async () => {
    const filler = Array.from({ length: 200 }, (_, index) =>
      '<mxCell id="extra-' + index + '" value="' + (index === 199 ? "Database" : "Extra " + index) + '" vertex="1" parent="1"><mxGeometry x="1" y="1" width="20" height="20" as="geometry"/></mxCell>'
    ).join("");
    const crowdedXml = XML.replace("</root>", filler + "</root>");
    const harness = await createServer({
      copilot: ambiguousTargetCopilot(),
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

  it("answers the whole C4 discovery turn from one C4 directory query", async () => {
    const copilot = shapeSearchingCopilot("C4 directory");
    const harness = await createServer({ copilot });
    const { response } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ prompt: "Create a C4 diagram" }));
    expect(response.status).toBe(200);
    const result = (copilot as { searchResponse?: Record<string, unknown> }).searchResponse ?? {};
    const ids = (result.results as Array<{ id: string }>).map((entry) => entry.id);
    expect(ids).toContain("c4.person");
    expect(ids).toContain("c4.relationship");
    expect(String(result.scriptTemplate)).toContain("xmlAssertions");
    expect(String(result.guidance)).toContain("Do not call get_drawio_reference");
  });

  it("keeps the C4 bundle off single-shape queries", async () => {
    const copilot = shapeSearchingCopilot("database");
    const harness = await createServer({ copilot });
    await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ prompt: "Add a database" }));
    const result = (copilot as { searchResponse?: Record<string, unknown> }).searchResponse ?? {};
    expect(result.scriptTemplate).toBeUndefined();
    expect(result.guidance).toBeUndefined();
  });

  it("hands the model native shape and geometry metadata instead of raw snapshot names", async () => {
    const copilot = reportingCopilot("answered", "No diagram changes are needed.");
    const harness = await createServer({ copilot });
    await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    const prompts = (copilot as unknown as { prompts: string[] }).prompts;
    const first = JSON.parse(prompts[0]) as { diagram: { cells: Array<Record<string, unknown>> } };
    const database = first.diagram.cells.find((cell) => cell.id === "db");
    expect(database).toMatchObject({
      id: "db", label: "Database", cellType: "vertex",
      geometry: { x: 10, y: 20, width: 120, height: 60 }, parentId: "1"
    });
    expect(database).not.toHaveProperty("name");
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

  it("closes a pending receipt when Studio rejects a command before editor dispatch", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({ acknowledgements: store });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      standalone: pending.standalone,
      documentRevision: pending.documentRevision,
      outcome: "failed",
      editorAcknowledged: false,
      applicationState: "unknown",
      persistenceStatus: "not_attempted",
      persistedRevision: null,
      versionId: null,
      failureStage: null,
      error: "A previous native edit is still awaiting reconciliation; this command was not dispatched."
    });
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("failed");
    expect(store.pending.has(pending.requestId)).toBe(false);
    expect(store.getReceipt(pending.requestId)?.body.outcome).toBe("failed");
    expect(harness.logs.some((entry) => entry.event === "turn.native-edit.final-outcome" &&
      entry.fields?.outcome === "failed")).toBe(true);
  });

  it("acknowledges a read-only inspection without requiring a persisted XML version", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store, {
      operationCount: 1,
      summary: "Inspect floor-plan furniture",
      operations: [{
        op: "run_drawio_script", target: "active_page", summary: "Inspect floor-plan furniture",
        script: "return { tableCount: 3 };", mode: "read",
        cellId: "__active_page__", targetLabel: "active Draw.io page"
      } as ResolvedNativeEditOperation]
    });
    const harness = await createServer({
      acknowledgements: store,
      snapshot: async () => ({ drawioXml: XML, revision: workspaceRevision(XML), versionId: "unexpected-version" })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack", {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      standalone: false,
      documentRevision: pending.documentRevision,
      outcome: "applied",
      editorAcknowledged: true,
      serializedXmlRevision: null,
      persistenceStatus: "read_only_no_change",
      persistedRevision: null,
      versionId: null,
      applicationState: "not-applied",
      failureStage: null,
      error: null
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      outcome: "applied", applicationState: "not-applied",
      persistenceStatus: "read_only_no_change", documentRevision: null, versionId: null
    });
    expect(harness.snapshot).not.toHaveBeenCalled();
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

  it("rejects an applied acknowledgement when editor verification is incomplete", async () => {
    const store = new NativeExecutionAcknowledgements();
    const pending = seedAck(store);
    const harness = await createServer({ acknowledgements: store });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent/ack",
      appliedAck(pending, { applicationState: "changed-unverified" }));
    expect(response.status).toBe(400);
    expect(body.outcome).toBe("failed");
    expect(body.reason).toBe("editor_state_not_verified");
    expect(String(body.error)).toContain("applied-and-verified");
    expect(store.pending.size).toBe(1);
    expect(store.getReceipt(pending.requestId)).toBeNull();
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
