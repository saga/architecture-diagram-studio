import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import { CopilotRuntime, describeCopilotFailure } from "./runtime";
import type { ContextUsage, ModelCallUsage, TurnUsageMetrics } from "./runtime";
import type { AgentAppliedEditView, AgentProposalView } from "./diagram-tools";
import {
  describeNativeEditOperation, MAX_NATIVE_EDIT_OPERATIONS, NATIVE_EDIT_STYLE_KEYS, parseNativeEditOperations,
  type ResolvedNativeEditOperation
} from "../../src/model/native-edit-operations";
import { resolveNativeEditTargets } from "./native-edit-tool";

interface AgentPromptConfig {
  revisionId: string;
  model: string;
  reasoningEffort: "high" | "max";
  prompts: {
    system: string; task: string; planTool: string; behavior: string; workspace: string;
    supportedCommands: string; toolDescription: string; toolResult: string;
  };
}
interface ProjectWorkspace { id: string; name: string; rootPath: string; primaryDiagram: string | null; }
interface IntentDependencies {
  copilot: CopilotRuntime;
  defaultModel: string;
  allowedCommands: Set<string>;
  writeLog(event: string, fields?: Record<string, unknown>): Promise<void>;
  getStudioConfig(): Promise<AgentPromptConfig>;
  getProjectWorkspace(): Promise<ProjectWorkspace | null>;
  collectAgentWorkspaceContext(): Promise<unknown>;
  persistSessionId(sessionId: string): Promise<void>;
}

interface PendingPlan { commands: string[]; reply: string; }
const pendingPlans = new Map<string, PendingPlan>();
const pendingAgentProposals = new Map<string, AgentProposalView>();
const pendingAgentApplications = new Map<string, AgentAppliedEditView>();
const pendingAgentSelections = new Map<string, { cellId: string; pageId: string | null; label: string }>();
const pendingNativeEdits = new Map<string, { operations: ResolvedNativeEditOperation[]; summary: string }>();
const usedToolsBySession = new Map<string, Set<string>>();

/**
 * The select and native-edit tools must see the elements of the *current* request.
 * The SDK session survives across turns and its tool closures are created once, so the
 * per-request context is read from here instead of being captured at session build time.
 */
const contextBySession = new Map<string, unknown>();

export function registerCopilotIntentRoute(app: Express, deps: IntentDependencies): void {
  async function buildSystemMessage(config: AgentPromptConfig, standalone = false): Promise<string> {
    const workspace = standalone ? null : await deps.getProjectWorkspace();
    const workspaceContext = standalone
      ? "Standalone Draw.io file mode: the supplied diagram context is the only target. No project workspace is active. Do not inspect, modify, or make claims about project files. You may select a uniquely identified diagram element, submit typed native edits, or return an allowlisted layout plan. Selection changes UI state and does not modify document content."
      : config.prompts.workspace
      .replaceAll("{{workspaceName}}", workspace?.name || "not configured")
      .replaceAll("{{rootPath}}", workspace?.rootPath || "not configured")
      .replaceAll("{{primaryDiagram}}", workspace?.primaryDiagram || "not selected");
    const supportedCommands = config.prompts.supportedCommands.replaceAll("{{commands}}", [...deps.allowedCommands].join("; "));
    const internalToolGuidance = standalone
      ? "The context includes selectedCell with the exact native cellId and pageId. When the user says the current or selected element, use that cellId directly rather than guessing by label. Standalone mode exposes only propose_native_edits and select_diagram_element. Use propose_native_edits for supported native operations such as rename, colors, move, resize, delete and add_node_after. add_node_after creates a new vertex to the right of the target and connects it. The operation executes in the native Draw.io model; no semantic projection or server-authored XML is involved. Use select_diagram_element only for pure focus requests. If an operation is not supported, explain that it was not applied. Never write raw Draw.io XML or workspace files."
      : "The context includes selectedCell with the exact native cellId and pageId. When the user says the current or selected element, use that cellId directly rather than guessing by label. V2 diagram editing is native Draw.io only. Use propose_native_edits for supported focused changes including select, rename, color, move, resize, delete and add_node_after. These native edits work when projectionComplete is false; that flag is not an edit gate and no DiagramDocument tool should be used. Every mutation must use exact ids or unique labels, supported typed operations, and editor acknowledgement. Never write raw XML or claim success before acknowledgement. Explain unsupported operations without changing the diagram.";
    return [config.prompts.system, config.prompts.task, config.prompts.planTool, config.prompts.behavior, workspaceContext, supportedCommands, internalToolGuidance].filter(Boolean).join("\n\n");
  }

  function createProposeLayoutPlanTool(sessionId: string, config: AgentPromptConfig) {
    return defineTool("propose_layout_plan", {
      description: config.prompts.toolDescription,
      parameters: {
        type: "object",
        properties: {
          commands: { type: "array", items: { type: "string", enum: [...deps.allowedCommands] }, maxItems: 6 },
          reply: { type: "string" }
        },
        required: ["commands", "reply"]
      },
      handler: async (args: { commands: string[]; reply: string }) => {
        const commands = Array.isArray(args.commands) ? args.commands : [];
        if (commands.length > 6 || commands.some((command) => !deps.allowedCommands.has(command))) {
          await deps.writeLog("tool.propose_layout_plan.rejected", { sessionId, commands });
          throw new Error("The plan contains an unsupported layout command");
        }
        pendingPlans.set(sessionId, { commands, reply: String(args.reply || "").slice(0, 500) });
        await deps.writeLog("tool.propose_layout_plan.accepted", { sessionId, commands, reply: String(args.reply || "").slice(0, 500) });
        const latestConfig = await deps.getStudioConfig();
        return { accepted: true, commandCount: commands.length, note: latestConfig.prompts.toolResult };
      }
    });
  }

  function createProposeNativeEditsTool(sessionId: string) {
    return defineTool("propose_native_edits", {
      description: "Submit typed native Draw.io edits. Supports select, set_label, set_style (fillColor, strokeColor, fontColor), move, resize, delete, and add_node_after (create a new shape to the right of a target and connect it with an edge). These operations execute in the native Draw.io model and do not depend on DiagramDocument completeness. The server validates targets and style keys; the browser applies the operations as one atomic batch and rolls back on failure. Use exact cell IDs or unique exact labels from the diagram context; do not guess.",
      parameters: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            maxItems: MAX_NATIVE_EDIT_OPERATIONS,
            items: {
              type: "object",
              properties: {
                op: { type: "string", enum: ["select", "set_label", "set_style", "move", "resize", "delete", "add_node_after"] },
                target: { type: "string", minLength: 1, maxLength: 200 },
                label: { type: "string", minLength: 1, maxLength: 500 },
                newLabel: { type: "string", minLength: 1, maxLength: 500 },
                key: { type: "string", enum: [...NATIVE_EDIT_STYLE_KEYS] },
                color: { type: "string", minLength: 1, maxLength: 40 },
                dx: { type: "number", minimum: -10000, maximum: 10000 },
                dy: { type: "number", minimum: -10000, maximum: 10000 },
                width: { type: "number", minimum: 1, maximum: 10000 },
                height: { type: "number", minimum: 1, maximum: 10000 }
              },
              required: ["op", "target"],
              additionalProperties: false
            }
          }
        },
        required: ["operations"],
        additionalProperties: false
      },
      handler: async (args: { operations?: unknown }) => {
        const parsed = parseNativeEditOperations(args?.operations);
        if (!parsed.ok) {
          await deps.writeLog("tool.propose_native_edits.rejected", { sessionId, error: parsed.error });
          throw new Error(parsed.error);
        }
        const resolved = resolveNativeEditTargets(contextBySession.get(sessionId) ?? null, parsed.operations);
        if (!resolved.ok) {
          await deps.writeLog("tool.propose_native_edits.unresolved", { sessionId, operations: parsed.operations, error: resolved.error });
          throw new Error(resolved.error);
        }
        const summary = resolved.operations.map(describeNativeEditOperation).join("; ");
        pendingNativeEdits.set(sessionId, { operations: resolved.operations, summary });
        await deps.writeLog("tool.propose_native_edits.accepted", {
          sessionId, operationCount: resolved.operations.length,
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, label: operation.label }))
        });
        return {
          accepted: true, operationCount: resolved.operations.length, requiresClientExecution: true,
          operations: resolved.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, label: operation.label })),
          summary
        };
      }
    });
  }

  app.post("/api/copilot/intent", async (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const context = req.body?.context;
    const sessionId = typeof req.body?.sessionId === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(req.body.sessionId)
      ? req.body.sessionId
      : randomUUID();
    const config = await deps.getStudioConfig();
    const requestedModel = typeof req.body?.model === "string" && req.body.model.trim()
      ? req.body.model.trim().slice(0, 100)
      : (config.model || deps.defaultModel);
    const requestedEffort = req.body?.reasoningEffort === "high" || req.body?.reasoningEffort === "max"
      ? req.body.reasoningEffort
      : config.reasoningEffort;
    const standalone = req.body?.standalone === true;
    if (!prompt || prompt.length > 4000) {
      await deps.writeLog("request.validation.failed", { sessionId, reason: "invalid_prompt", promptLength: prompt.length });
      res.status(400).json({ error: "prompt must be 1–4000 characters", sessionId });
      return;
    }
    if (!context || typeof context !== "object" || !Array.isArray(context.nodes) || context.nodes.length > 200) {
      await deps.writeLog("request.validation.failed", { sessionId, reason: "invalid_context" });
      res.status(400).json({ error: "Invalid diagram context or more than 200 nodes", sessionId });
      return;
    }
    const modelChoice = await deps.copilot.resolveModel(requestedModel);
    const model = modelChoice.model || requestedModel;

    const startedAt = Date.now();
    const requestId = randomUUID();
    contextBySession.set(sessionId, context);
    const nodeNames = (context.nodes as Array<{ id?: unknown; name?: unknown }>).slice(0, 80).map((node) => ({ id: typeof node.id === "string" ? node.id : null, name: typeof node.name === "string" ? node.name.slice(0, 120) : null }));
    await deps.writeLog("request.received", { requestId, sessionId, model, requestedModel: requestedModel === model ? undefined : requestedModel, modelSource: modelChoice.reason, reasoningEffort: requestedEffort, standalone, prompt, promptLength: prompt.length, contextKind: (context as { kind?: unknown }).kind ?? null, contextTitle: typeof (context as { title?: unknown }).title === "string" ? (context as { title: string }).title : null, nodeCount: (context.nodes as unknown[]).length, nodeNames });
    if (!standalone) await deps.persistSessionId(sessionId);
    try {
      await deps.writeLog("request.session.acquire.started", { requestId, sessionId, model, standalone });
      const acquireStartedAt = Date.now();
      const runtime = await deps.copilot.acquireSession({
        conversationId: sessionId,
        model,
        requestedEffort,
        prepare: async () => {
          const latestConfig = await deps.getStudioConfig();
          return {
            configRevisionId: latestConfig.revisionId,
            systemMessage: await buildSystemMessage(latestConfig, standalone),
            tools: [
              createSelectDiagramElementTool(sessionId),
              createProposeNativeEditsTool(sessionId)
            ],
            workspaceId: (await deps.getProjectWorkspace())?.id
          };
        }
      });
      await deps.writeLog("request.session.acquire.completed", { requestId, sessionId, sdkSessionId: runtime.sdkSessionId, model: runtime.model, reasoningEffort: runtime.reasoningEffort || "model-default", durationMs: Date.now() - acquireStartedAt });
      const plan = await deps.copilot.withTurn(sessionId, async (turn) => {
        pendingPlans.delete(sessionId);
        pendingAgentProposals.delete(sessionId);
        pendingAgentApplications.delete(sessionId);
        pendingAgentSelections.delete(sessionId);
        pendingNativeEdits.delete(sessionId);
        usedToolsBySession.set(sessionId, new Set<string>());
        const usageSamples: TurnUsageMetrics[] = [];
        const modelCallUsages: ModelCallUsage[] = [];
        let contextUsage: ContextUsage | undefined;
        await deps.writeLog("turn.started", { sessionId, model: runtime.model, reasoningEffort: runtime.reasoningEffort || "model-default", prompt });
        const projectContext = standalone ? { mode: "standalone", workspace: null, snippets: [], diagram: context } : await deps.collectAgentWorkspaceContext();
        await deps.writeLog("turn.workspace-context.loaded", {
          sessionId,
          workspaceId: (projectContext as { workspace?: { id?: string } }).workspace?.id || null,
          snippetCount: (projectContext as { snippets?: unknown[] }).snippets?.length || 0
        });
        const firstTurnStartedAt = Date.now();
        const firstRequestPrompt = JSON.stringify({ request: prompt, diagram: context, projectWorkspace: projectContext });
        await deps.writeLog("turn.model-call.started", { requestId, sessionId, attempt: 1, timeoutMs: 50000, model: turn.session.model, promptLength: prompt.length, requestPrompt: firstRequestPrompt, standalone, toolCount: turn.session.prepared.tools.length });
        const firstTurnResult = await turn.send({ prompt: firstRequestPrompt }, 50000);
        const firstTurn = firstTurnResult.message;
        if (firstTurnResult.usage) usageSamples.push(firstTurnResult.usage);
        modelCallUsages.push(...firstTurnResult.modelCallUsages);
        contextUsage = firstTurnResult.contextUsage ?? contextUsage;
        await deps.writeLog("turn.model-call.completed", {
          requestId, sessionId, attempt: 1, durationMs: Date.now() - firstTurnStartedAt,
          responseType: firstTurn?.type ?? null, responseAvailable: Boolean(firstTurn), responseText: assistantText(firstTurn),
          usage: firstTurnResult.usage ?? null, modelCallUsages: firstTurnResult.modelCallUsages,
          contextUsage: firstTurnResult.contextUsage ?? null
        });
        let captured = pendingPlans.get(sessionId) || null;
        pendingPlans.delete(sessionId);
        let capturedProposal = pendingAgentProposals.get(sessionId) || null;
        pendingAgentProposals.delete(sessionId);
        let capturedApplication = pendingAgentApplications.get(sessionId) || null;
        pendingAgentApplications.delete(sessionId);
        let capturedSelection = pendingAgentSelections.get(sessionId) || null;
        pendingAgentSelections.delete(sessionId);
        let capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
        pendingNativeEdits.delete(sessionId);
        let modelText = assistantText(firstTurn);
        let usedToolNames = usedToolsBySession.get(sessionId) || new Set<string>();
        if (!captured && !capturedProposal && !capturedApplication && !capturedSelection && !capturedNativeEdits && usedToolNames.size === 0) {
          await deps.writeLog("turn.tool-not-called", { sessionId, attempt: 1, modelText: modelText.slice(0, 2000) });
          const retryStartedAt = Date.now();
          const retryPrompt = JSON.stringify({ request: "Use propose_native_edits for supported native Draw.io mutations, including add_node_after when the user asks to add a node after a target and connect it. Use select_diagram_element only for pure focus requests. Do not call semantic DiagramDocument operations or return free-form layout commands. If the target is ambiguous or the operation is unsupported, make no changes and explain why.", diagram: context });
          await deps.writeLog("turn.model-call.started", { requestId, sessionId, attempt: 2, timeoutMs: 25000, reason: "first response did not invoke a tool", standalone, requestPrompt: retryPrompt });
          const nudgedResult = await turn.send({ prompt: retryPrompt }, 25000);
          const nudged = nudgedResult.message;
          if (nudgedResult.usage) usageSamples.push(nudgedResult.usage);
          modelCallUsages.push(...nudgedResult.modelCallUsages);
          contextUsage = nudgedResult.contextUsage ?? contextUsage;
          await deps.writeLog("turn.model-call.completed", {
            requestId, sessionId, attempt: 2, durationMs: Date.now() - retryStartedAt,
            responseType: nudged?.type ?? null, responseAvailable: Boolean(nudged), responseText: assistantText(nudged),
            usage: nudgedResult.usage ?? null, modelCallUsages: nudgedResult.modelCallUsages,
            contextUsage: nudgedResult.contextUsage ?? null
          });
          captured = pendingPlans.get(sessionId) || null;
          pendingPlans.delete(sessionId);
          capturedProposal = pendingAgentProposals.get(sessionId) || null;
          pendingAgentProposals.delete(sessionId);
          capturedApplication = pendingAgentApplications.get(sessionId) || null;
          pendingAgentApplications.delete(sessionId);
          capturedSelection = pendingAgentSelections.get(sessionId) || null;
          pendingAgentSelections.delete(sessionId);
          capturedNativeEdits = pendingNativeEdits.get(sessionId) || null;
          pendingNativeEdits.delete(sessionId);
          usedToolNames = usedToolsBySession.get(sessionId) || new Set<string>();
          modelText = assistantText(nudged) || modelText;
        }
        return {
          captured, capturedProposal, capturedApplication, capturedSelection, capturedNativeEdits, modelText,
          usedToolNames: [...usedToolNames], session: turn.session,
          usage: mergeTurnUsage(usageSamples), modelCallUsages, contextUsage
        };
      });

      const modelReply = plan.modelText.trim().slice(0, 500);
      const selection = plan.capturedSelection || undefined;
      const shared = {
        sessionId, model: plan.session.observedModel || plan.session.model, reasoningEffort: plan.session.reasoningEffort || "model-default",
        provider: "github-copilot-sdk", durationMs: Date.now() - startedAt, toolsUsed: plan.usedToolNames,
        ...(plan.usage ? { usage: plan.usage } : {}),
        ...(plan.modelCallUsages.length ? { modelCallUsages: plan.modelCallUsages } : {}),
        ...(plan.contextUsage ? { contextUsage: plan.contextUsage } : {})
      };
      if (plan.capturedApplication) {
        const application = plan.capturedApplication;
        const response = {
          commands: [], reply: application.summary, selection,
          application: { applied: true, versionId: application.versionId, baseRevision: application.baseRevision,
            workspaceRevision: application.workspaceRevision, document: application.document,
            summary: application.summary, quality: application.quality },
          ...shared
        };
        await deps.writeLog("turn.completed.with-applied-edit", {
          sessionId, versionId: application.versionId, baseRevision: application.baseRevision,
          workspaceRevision: application.workspaceRevision, summary: application.summary, qualityScore: application.quality.score,
          selection: selection ?? null, discardedNativeEdits: Boolean(plan.capturedNativeEdits),
          response: { applied: true, summary: application.summary, versionId: application.versionId, workspaceRevision: application.workspaceRevision }, toolsUsed: plan.usedToolNames, usage: plan.usage
        });
        res.json(response);
        return;
      }
      if (plan.capturedNativeEdits) {
        const nativeEdits = plan.capturedNativeEdits;
        const response = {
          commands: [], reply: modelReply || nativeEdits.summary, selection,
          nativeEdits: { operations: nativeEdits.operations, summary: nativeEdits.summary, requiresClientExecution: true },
          ...shared
        };
        await deps.writeLog("turn.completed.with-native-edits", {
          sessionId, operationCount: nativeEdits.operations.length, summary: nativeEdits.summary,
          selection: selection ?? null, operations: nativeEdits.operations.map((operation) => ({ op: operation.op, cellId: operation.cellId, label: operation.label })), usage: plan.usage
        });
        res.json(response);
        return;
      }
      if (plan.capturedProposal) {
        const proposal = plan.capturedProposal;
        const response = {
          commands: [], reply: proposal.summary, selection,
          proposal: {
            proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, document: proposal.document,
            summary: proposal.summary, baseQuality: proposal.baseQuality, quality: proposal.quality
          },
          ...shared
        };
        await deps.writeLog("turn.completed.with-proposal", { sessionId, proposalId: proposal.proposalId, summary: proposal.summary, qualityScore: proposal.quality.score, selection: selection ?? null, usage: plan.usage });
        res.json(response);
        return;
      }
      const resolved = plan.captured;
      const modelText = plan.modelText;
      if (resolved) {
        const response = { ...resolved, ...(selection ? { selection } : {}), ...shared };
        await deps.writeLog("turn.completed", { sessionId, model: plan.session.model, durationMs: response.durationMs, response, usage: plan.usage });
        res.json(response);
        return;
      }
      if (selection) {
        const response = { commands: [], reply: modelReply || "Selected diagram element: " + selection.label, selection, ...shared };
        await deps.writeLog("turn.completed.with-selection", { sessionId, selection, response, usage: plan.usage });
        res.json(response);
        return;
      }
      if (plan.usedToolNames.length) {
        await deps.writeLog("turn.completed.after-analysis-tools", { sessionId, model: plan.session.model, tools: plan.usedToolNames, modelText: modelText.slice(0, 2000), usage: plan.usage });
        res.json({
          commands: [], reply: modelText.slice(0, 500) || "The requested analysis completed; the diagram is unchanged.",
          ...shared
        });
        return;
      }
      await deps.writeLog("turn.completed.without-plan", { sessionId, model: plan.session.model, modelText: modelText.slice(0, 2000), usage: plan.usage });
      res.json({
        commands: [], reply: modelText.slice(0, 500) || "No actionable plan was produced and the diagram is unchanged. Try specifying a supported layout or semantic edit.",
        ...shared
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const actualModel = deps.copilot.lastObservedModel(sessionId);
      await deps.writeLog("turn.failed", {
        requestId, sessionId, model, requestedModel: requestedModel === model ? undefined : requestedModel, actualModel: actualModel ?? null,
        provider: deps.copilot.providerInfo.mode, providerHost: deps.copilot.providerInfo.host ?? null,
        standalone, durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: message, errorStack: error instanceof Error ? error.stack : null
      });
      res.status(502).json({ error: describeCopilotFailure(message, { requestedModel: model, actualModel }), sessionId });
    }
  });
}

function createSelectDiagramElementTool(sessionId: string) {
  return defineTool("select_diagram_element", {
    description: "Select and focus one existing element in the native Draw.io canvas. This is a UI selection action, not a diagram edit, so it does not create a version or require a commit. Use exact IDs or a unique exact label from the supplied diagram context; do not guess.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["target"],
      additionalProperties: false
    },
    handler: async (args: { target: string }) => {
      const current = contextBySession.get(sessionId);
      const source = current && typeof current === "object" ? current as { nodes?: unknown; selectedNode?: unknown; pageId?: unknown } : {};
      const nodes = Array.isArray(source.nodes) ? source.nodes as Array<{ id?: unknown; name?: unknown }> : [];
      const target = args.target.trim();
      const matches = nodes.filter((node) =>
        (typeof node.id === "string" && node.id === target) ||
        (typeof node.name === "string" && node.name.trim().toLocaleLowerCase() === target.toLocaleLowerCase())
      );
      if (matches.length !== 1 || typeof matches[0]?.id !== "string") {
        throw new Error(matches.length > 1 ? "The element label is ambiguous; provide its exact cell ID." : "The element was not found in the supplied diagram context. No selection changed.");
      }
      const selected = { cellId: matches[0].id, pageId: typeof source.pageId === "string" ? source.pageId : null, label: typeof matches[0].name === "string" ? matches[0].name : matches[0].id };
      pendingAgentSelections.set(sessionId, selected);
      return { selected: true, ...selected, documentChanged: false };
    }
  });
}

function mergeTurnUsage(samples: TurnUsageMetrics[]): TurnUsageMetrics | undefined {
  if (!samples.length) return undefined;
  const sources = new Set(samples.map((item) => item.source));
  const result: TurnUsageMetrics = {
    source: sources.size === 1 ? samples[0]!.source : "unknown"
  };
  const byModel: NonNullable<TurnUsageMetrics["byModel"]> = {};
  for (const sample of samples) {
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "premiumRequestCost", "totalNanoAiu", "modelCalls"] as const) {
      const value = sample[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        const target = result as unknown as Record<string, unknown>;
        target[key] = ((typeof target[key] === "number" ? target[key] : 0) as number) + value;
      }
    }
    for (const [model, counts] of Object.entries(sample.byModel ?? {})) {
      const aggregate = { ...(byModel[model] ?? {}) } as Record<string, unknown>;
      for (const [key, value] of Object.entries(counts)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          aggregate[key] = ((typeof aggregate[key] === "number" ? aggregate[key] : 0) as number) + value;
        }
      }
      byModel[model] = aggregate as NonNullable<TurnUsageMetrics["byModel"]>[string];
    }
  }
  if (Object.keys(byModel).length) result.byModel = byModel;
  return result;
}

function assistantText(message: unknown): string {
  const content = (message as { data?: { content?: unknown } } | undefined)?.data?.content;
  return typeof content === "string" ? content.trim() : "";
}
function planFromText(text: string, allowedCommands: Set<string>): PendingPlan | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as { commands?: unknown; reply?: unknown };
  if (!Array.isArray(value.commands)) return null;
  const commands = value.commands.filter((item): item is string => typeof item === "string" && allowedCommands.has(item)).slice(0, 6);
  if (commands.length !== value.commands.length) return null;
  return { commands, reply: typeof value.reply === "string" ? value.reply.trim().slice(0, 500) : "" };
}
