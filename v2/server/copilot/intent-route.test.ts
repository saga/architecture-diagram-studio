import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotRuntime } from "./runtime";
import { registerCopilotIntentRoute } from "./intent-route";
import { workspaceRevision } from "../storage";
import {
  DRAWIO_RUNTIME_BRIDGE_VERSION, PINNED_DRAWIO_VERSION, PINNED_RUNTIME_CAPABILITY_REQUIREMENTS
} from "../../src/model/drawio-runtime-contract";

const XML = '<mxfile><diagram id="p1" name="Page 1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '<mxCell id="api" value="API Service" vertex="1" parent="1"><mxGeometry x="200" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

function runtimeInspectionWithShapes(liveShapeClasses: string[], liveShapeClassesTruncated: boolean) {
  const requirements = {
    graph: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.graph],
    model: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.model],
    view: [...PINNED_RUNTIME_CAPABILITY_REQUIREMENTS.view]
  };
  return {
    schemaVersion: 1,
    bridgeVersion: DRAWIO_RUNTIME_BRIDGE_VERSION,
    drawioVersion: PINNED_DRAWIO_VERSION,
    documentRevision: workspaceRevision(XML),
    pageId: "p1",
    capabilities: requirements,
    capabilityManifest: {
      required: requirements,
      missing: { graph: [], model: [], view: [] },
      jsShapeClasses: { requested: [], registered: {} }
    },
    counts: { cells: 4, vertices: 2, edges: 0 },
    cells: [],
    liveShapeClasses,
    liveShapeClassesTruncated,
    renderedEdges: [],
    truncated: liveShapeClassesTruncated
  };
}

type ServerHarness = {
  baseUrl: string;
  server: Server;
  logs: Array<{ event: string; fields?: Record<string, unknown> }>;
  snapshot: ReturnType<typeof vi.fn>;
  copilot: Record<string, unknown>;
  persistSessionId: ReturnType<typeof vi.fn>;
};

const servers: Server[] = [];

async function createServer(options: {
  snapshot?: () => Promise<{ drawioXml: string; revision: string } | null>;
  copilot?: Record<string, unknown>;
  commitWorkspaceXmlPatch?: (input: { patch: Array<Record<string, unknown>>; baseRevision: string; pageId: string | null; label: string }) => Promise<{ ok: boolean; status: number; body: unknown }>;
} = {}): Promise<ServerHarness> {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
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
    ...(options.commitWorkspaceXmlPatch ? { commitWorkspaceXmlPatch: options.commitWorkspaceXmlPatch } : {}),
    collectAgentWorkspaceContext: async () => ({}),
    persistSessionId,
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server, logs, snapshot, copilot, persistSessionId };
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

function xmlEditingCopilot() {
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
          .find((candidate) => candidate.name === "edit_drawio_xml");
        if (!tool?.handler) throw new Error("edit_drawio_xml tool was not registered");
        await tool.handler({
          summary: "Rename Database",
          patch: [{ op: "set-cell-attributes", cellId: "db", attributes: { value: "Data Store" } }]
        });
        return { message: { data: { content: "Rename Database to Data Store." } }, model: "test-model" };
      }
    })
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

function shapeSearchingCopilot(query: string, limit?: number) {
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
        searchResponse = (await search.handler({ query, ...(limit !== undefined ? { limit } : {}) })) as Record<string, unknown>;
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

function terminalConflictCopilot(
  scenario: "select-only" | "invalid-select"
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
        if (scenario === "select-only") {
          await invoke("select_diagram_element", { target: "Database" });
        } else {
          await invoke("select_diagram_element", { target: "" });
          await invoke("report_intent_outcome", {
            outcome: "needs_clarification", reply: "Select a specific element from the current diagram.", question: "Which element should be selected?"
          });
        }
        return { message: { data: { content: "The native edit request was processed." } }, modelCallUsages: [] };
      }
    })
  };
  Object.defineProperty(copilot, "toolResults", { get: () => toolResults });
  return copilot;
}

describe("Copilot intent route result and revision contract", () => {
  it("returns a revision-checked XML patch for standalone browser-owned persistence", async () => {
    const harness = await createServer({ copilot: xmlEditingCopilot() });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({ standalone: true }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("xml_patch_ready");
    expect(body.documentRevision).toBe(workspaceRevision(XML));
    expect(body.drawioXml).toContain('value="Data Store"');
    expect(body.patchedRevision).toBe(workspaceRevision(String(body.drawioXml)));
    expect(body.changedCellIds).toEqual(["db"]);
  });

  it("commits the XML-first tool through the versioned server persistence callback", async () => {
    const commitWorkspaceXmlPatch = vi.fn(async (input: { patch: Array<Record<string, unknown>>; baseRevision: string; pageId: string | null; label: string }) => ({
      ok: true, status: 200, body: { ok: true, workspaceRevision: "new-revision", version: { id: "v-2" }, accepted: input.patch.length === 1 }
    }));
    const harness = await createServer({ copilot: xmlEditingCopilot(), commitWorkspaceXmlPatch });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest());
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("xml_committed");
    expect(commitWorkspaceXmlPatch).toHaveBeenCalledWith(expect.objectContaining({
      baseRevision: workspaceRevision(XML), pageId: "p1", label: "Copilot: Rename Database",
      patch: [{ op: "set-cell-attributes", cellId: "db", attributes: { value: "Data Store" } }]
    }));
    expect(harness.logs.some((entry) => entry.event === "turn.completed.xml-patch-committed")).toBe(true);
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
    expect(prompt).toContain("geometry");
    expect(prompt).toContain("exact native cell IDs");
    expect(prompt).toContain("Catalogue misses do not prove a shape is absent");
    expect(prompt).toContain("edit_drawio_xml");
    expect(prompt).not.toContain("run_drawio_script");
    expect(prompt).toContain("report_intent_outcome for information");
    expect(prompt.length).toBeLessThan(2800);
    const firstRequest = JSON.parse((copilot as unknown as { prompts: string[] }).prompts[0]!) as { editingGuidance: string };
    expect(firstRequest.editingGuidance).toContain("search/inspection results bound to this exact documentRevision");
    expect(firstRequest.editingGuidance).toContain("plain-text replacements that would flatten markup");
    expect(firstRequest.editingGuidance).toContain("labelContains is Studio-only, not Draw.io XML");
    expect(firstRequest.editingGuidance).not.toContain("expectedTitle");
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

  it("accepts a bare mxGraphModel even when the editor still reports its own page ID", async () => {
    const bare = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>' +
      '</root></mxGraphModel>';
    const copilot = reportingCopilot("answered", "No diagram changes are needed.");
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: bare, revision: workspaceRevision(bare) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      standalone: true,
      diagramXml: bare,
      documentRevision: workspaceRevision(bare),
      context: { kind: "drawio", activePageId: "editor-page-1", selectedCell: null, cells: [] }
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
  });

  it("does not classify model and SDK errors by English message wording", async () => {    const failures = [
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

  });

  it("rejects a workspace XML snapshot that is stale against the authoritative revision", async () => {
    const harness = await createServer({ copilot: reportingCopilot("answered", "The request was not executed because its XML snapshot was stale.") });
    const editedXml = XML.replace('value="Database"', 'value="Warehouse"');
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      diagramXml: editedXml, documentRevision: workspaceRevision(editedXml)
    }));
    expect(response.status).toBe(409);
    expect(body.outcome).toBe("stale_context");

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

  });

  it("returns the native style from element search so a key-only edit needs no full style guess", async () => {
    const styledXml = XML.replace(
      '<mxCell id="db" value="Database" vertex="1" parent="1">',
      '<mxCell id="db" value="Database" style="rounded=1;fillColor=#ffffff;strokeColor=#000000;" vertex="1" parent="1">'
    );
    const copilot = elementSearchingCopilot("db", "search_drawio_elements", { query: "db", limit: 5 });
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: styledXml, revision: workspaceRevision(styledXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "Find the database block",
      diagramXml: styledXml,
      documentRevision: workspaceRevision(styledXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const searchResult = (copilot as { searchResult?: { results: Array<{ id: string; style?: string }> } }).searchResult;
    expect(searchResult?.results[0]).toMatchObject({
      id: "db", style: "rounded=1;fillColor=#ffffff;strokeColor=#000000;"
    });
  });

  it("filters graph inspection by a native style substring", async () => {
    const styledXml = XML.replace(
      '<mxCell id="db" value="Database" vertex="1" parent="1">',
      '<mxCell id="db" value="Database" style="rounded=1;fillColor=#ffffff;strokeColor=#000000;" vertex="1" parent="1">'
    );
    const copilot = elementSearchingCopilot("", "inspect_drawio_graph", { styleContains: "fillColor=#ffffff", limit: 10 });
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: styledXml, revision: workspaceRevision(styledXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "List white cells",
      diagramXml: styledXml,
      documentRevision: workspaceRevision(styledXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const inspection = (copilot as { searchResult?: { totalCount: number; results: Array<{ id: string; style?: string }> } }).searchResult;
    expect(inspection?.totalCount).toBe(1);
    expect(inspection?.results[0]).toMatchObject({
      id: "db", style: "rounded=1;fillColor=#ffffff;strokeColor=#000000;"
    });
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

  it("does not let an exact cell ID suppress other substring search hits", async () => {
    const relatedCells = ["task-1", "task-10", "task-11"].map((id, index) =>
      '<mxCell id="' + id + '" value="Component ' + index +
      '" vertex="1" parent="1"><mxGeometry x="' + (index * 30) +
      '" y="1" width="20" height="20" as="geometry"/></mxCell>'
    ).join("");
    const relatedXml = XML.replace("</root>", relatedCells + "</root>");
    const revision = workspaceRevision(relatedXml);
    const copilot = elementSearchingCopilot("task-1", "search_drawio_elements", { query: "task-1" });
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: relatedXml, revision })
    });
    const { response } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: 'Search for "task-1"',
      diagramXml: relatedXml,
      documentRevision: revision
    }));
    expect(response.status).toBe(200);
    const result = (copilot as { searchResult?: {
      matchCount: number; returnedCount: number; truncated: boolean; results: Array<{ id: string }>
    } }).searchResult;
    expect(result).toMatchObject({ matchCount: 3, returnedCount: 3, truncated: false });
    expect(result?.results.map((cell) => cell.id)).toEqual(["task-1", "task-10", "task-11"]);
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

  it("does not treat a truncated live shape registry as exhaustive", async () => {
    const copilot = elementSearchingCopilot("", "search_drawio_runtime_shapes", {
      query: "mxgraph.missing.shape", limit: 15
    });
    const harness = await createServer({ copilot });
    const runtimeInspection = runtimeInspectionWithShapes([
      "mxgraph.c4.person2", "mxgraph.test.cloud"
    ], true);
    const { response } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      context: {
        kind: "drawio", activePageId: "p1", selectedCell: null, cells: [], runtimeInspection
      }
    }));
    expect(response.status).toBe(200);
    const result = (copilot as { searchResult?: Record<string, unknown> }).searchResult ?? {};
    expect(result).toMatchObject({
      source: "live-mxCellRenderer.defaultShapes",
      liveSnapshotAvailable: true,
      registrySnapshotTruncated: true,
      matchCountComplete: false,
      matchCount: 0,
      returnedCount: 0,
      resultSetTruncated: false,
      truncated: true
    });
    expect(String(result.guidance)).toContain("do not conclude a class is unavailable");
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

  it("reports curated shape catalogue truncation and requires a narrower query", async () => {
    const copilot = shapeSearchingCopilot("a", 3);
    const harness = await createServer({ copilot });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "Search the shape catalogue for a"
    }));
    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const result = (copilot as { searchResponse?: Record<string, unknown> }).searchResponse ?? {};
    expect(result).toMatchObject({
      returnedCount: 3,
      truncated: true
    });
    expect(result.matchCount).toBeGreaterThan(3);
    expect(String(result.guidance)).toContain("Do not treat this subset as the complete candidate set");
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

  });

  it("never reports box geometry for an inspected edge", async () => {
    const edgeCell = '<mxCell id="e1" value="" edge="1" parent="1" source="db" target="api" style="edgeStyle=none;">' +
      '<mxGeometry relative="1" as="geometry"/></mxCell>';
    const edgeXml = XML.replace("</root>", edgeCell + "</root>");
    const copilot = elementSearchingCopilot("", "inspect_drawio_graph", { cellType: "edge", limit: 20 });
    const harness = await createServer({
      copilot,
      snapshot: async () => ({ drawioXml: edgeXml, revision: workspaceRevision(edgeXml) })
    });
    const { response, body } = await post(harness.baseUrl, "/api/copilot/intent", intentRequest({
      prompt: "Inspect every connector",
      diagramXml: edgeXml,
      documentRevision: workspaceRevision(edgeXml)
    }));

    expect(response.status).toBe(200);
    expect(body.outcome).toBe("answered");
    const result = (copilot as { searchResult?: { results?: Array<Record<string, unknown>> } }).searchResult;
    expect(result?.results?.[0]).toMatchObject({ id: "e1", cellType: "edge" });
    // The live model reports zeros for an edge's box, but Draw.io omits those attributes from the
    // saved XML, so reporting them invites assertions that can never pass.
    expect(result?.results?.[0]).not.toHaveProperty("geometry");
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
    expect(result).toMatchObject({ matchCount: 4, returnedCount: 4, truncated: false });
    expect(result.scriptTemplate).toBeUndefined();
    expect(String(result.guidance)).toContain("edit_drawio_xml");
    expect(String(result.guidance)).toContain("mxCell XML fragments");
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
