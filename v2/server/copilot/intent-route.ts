import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { defineTool } from "@github/copilot-sdk";
import { CopilotRuntime, describeCopilotFailure } from "./runtime";
import type { AgentAppliedEditView, AgentProposalView } from "./diagram-tools";

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
  createDiagramTools(sessionId: string, onProposal: (proposal: AgentProposalView) => void, onApplied: (applied: AgentAppliedEditView) => void, onToolUse: (toolName: string) => void): any[];
}

interface PendingPlan { commands: string[]; reply: string; }
const pendingPlans = new Map<string, PendingPlan>();
const pendingAgentProposals = new Map<string, AgentProposalView>();
const pendingAgentApplications = new Map<string, AgentAppliedEditView>();
const usedToolsBySession = new Map<string, Set<string>>();

export function registerCopilotIntentRoute(app: Express, deps: IntentDependencies): void {
  async function buildSystemMessage(config: AgentPromptConfig, standalone = false): Promise<string> {
    const workspace = standalone ? null : await deps.getProjectWorkspace();
    const workspaceContext = standalone
      ? "Standalone Draw.io file mode: the supplied diagram context is the only target. No project workspace is active. Do not inspect, modify, or make claims about project files. Only return an allowlisted layout plan or answer about the supplied diagram."
      : config.prompts.workspace
      .replaceAll("{{workspaceName}}", workspace?.name || "not configured")
      .replaceAll("{{rootPath}}", workspace?.rootPath || "not configured")
      .replaceAll("{{primaryDiagram}}", workspace?.primaryDiagram || "not selected");
    const supportedCommands = config.prompts.supportedCommands.replaceAll("{{commands}}", [...deps.allowedCommands].join("; "));
    const internalToolGuidance = standalone
      ? "Standalone mode exposes only propose_layout_plan. Use it only for exact allowlisted global layout commands; otherwise answer based solely on the supplied diagram context. Do not invoke workspace tools, propose semantic edits, or claim to have changed the diagram. The user can review and apply supported layout previews in the local UI. Never write raw Draw.io XML or workspace files."
      : "IMPORTANT: This tool guidance supersedes any conflicting legacy prompt above, including instructions to use only propose_layout_plan or to avoid semantic operations. Use the registered internal diagram tools for inspection, quality evaluation, workspace-example search, semantic edits, templates and version history. For one focused node, relation, layout, boundary or sequence-fragment change explicitly requested by the user, inspect_active_diagram first and use apply_diagram_operation with its exact revision and stable IDs; this tool directly applies the change after server-side revision, semantic and quality validation and creates an immutable version. Do not use direct apply for analysis, hypothetical edits, broad redesigns, ambiguous or bulk destructive changes, template replacement or restore; use a proposal tool and require explicit confirmation. Use propose_diagram_operation when the change needs preview/review and propose_layout_plan only for exact allowlisted global layout commands. Never write raw Draw.io XML or workspace files. Mermaid import/conversion is not implemented.";
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

  app.post("/api/copilot/intent", async (req, res) => {
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
    const context = req.body?.context;
    const sessionId = typeof req.body?.sessionId === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(req.body.sessionId)
      ? req.body.sessionId
      : randomUUID();
    const config = await deps.getStudioConfig();
    const model = typeof req.body?.model === "string" && req.body.model.trim()
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

    const startedAt = Date.now();
    await deps.writeLog("request.received", { sessionId, model, reasoningEffort: requestedEffort, prompt, context });
    if (!standalone) await deps.persistSessionId(sessionId);
    try {
      const runtime = await deps.copilot.acquireSession({
        conversationId: sessionId,
        model,
        requestedEffort,
        prepare: async () => {
          const latestConfig = await deps.getStudioConfig();
          return {
            configRevisionId: latestConfig.revisionId,
            systemMessage: await buildSystemMessage(latestConfig),
            tools: [
              createProposeLayoutPlanTool(sessionId, latestConfig),
              ...deps.createDiagramTools(
                sessionId,
                (proposal) => pendingAgentProposals.set(sessionId, proposal),
                (application) => pendingAgentApplications.set(sessionId, application),
                (toolName) => {
                  let used = usedToolsBySession.get(sessionId);
                  if (!used) { used = new Set<string>(); usedToolsBySession.set(sessionId, used); }
                  used.add(toolName);
                }
              )
            ],
            workspaceId: (await deps.getProjectWorkspace())?.id
          };
        }
      });
      const plan = await deps.copilot.withTurn(sessionId, async (turn) => {
        pendingPlans.delete(sessionId);
        pendingAgentProposals.delete(sessionId);
        pendingAgentApplications.delete(sessionId);
        usedToolsBySession.set(sessionId, new Set<string>());
        await deps.writeLog("turn.started", { sessionId, model: runtime.model, reasoningEffort: runtime.reasoningEffort || "model-default", prompt });
        const projectContext = standalone ? { mode: "standalone", workspace: null, snippets: [], diagram: context } : await deps.collectAgentWorkspaceContext();
        await deps.writeLog("turn.workspace-context.loaded", {
          sessionId,
          workspaceId: (projectContext as { workspace?: { id?: string } }).workspace?.id || null,
          snippetCount: (projectContext as { snippets?: unknown[] }).snippets?.length || 0
        });
        const firstTurn = await turn.send({ prompt: JSON.stringify({ request: prompt, diagram: context, projectWorkspace: projectContext }) }, 50000);
        let captured = pendingPlans.get(sessionId) || null;
        pendingPlans.delete(sessionId);
        let capturedProposal = pendingAgentProposals.get(sessionId) || null;
        pendingAgentProposals.delete(sessionId);
        let capturedApplication = pendingAgentApplications.get(sessionId) || null;
        pendingAgentApplications.delete(sessionId);
        let modelText = assistantText(firstTurn);
        let usedToolNames = usedToolsBySession.get(sessionId) || new Set<string>();
        if (!captured && !capturedProposal && !capturedApplication && usedToolNames.size === 0) {
          await deps.writeLog("turn.tool-not-called", { sessionId, attempt: 1, modelText: modelText.slice(0, 2000) });
          const nudged = await turn.send({
            prompt: JSON.stringify({ request: standalone ? "Use propose_layout_plan only if the request exactly matches an allowlisted global layout command. Otherwise answer about the supplied standalone diagram without changing any project workspace." : "Use the most appropriate internal diagram tool for the previous request. For analysis, inspect the active diagram and evaluate quality. For one focused change explicitly requested by the user, inspect the diagram and use apply_diagram_operation with the exact active revision; for broad or ambiguous changes, create a reviewable proposal. Use propose_layout_plan only for its exact allowlisted global layout commands.", diagram: context })
          }, 25000);
          captured = pendingPlans.get(sessionId) || null;
          pendingPlans.delete(sessionId);
          capturedProposal = pendingAgentProposals.get(sessionId) || null;
          pendingAgentProposals.delete(sessionId);
          capturedApplication = pendingAgentApplications.get(sessionId) || null;
          pendingAgentApplications.delete(sessionId);
          usedToolNames = usedToolsBySession.get(sessionId) || new Set<string>();
          modelText = assistantText(nudged) || modelText;
        }
        return { captured, capturedProposal, capturedApplication, modelText, usedToolNames: [...usedToolNames], session: turn.session };
      });

      if (plan.capturedApplication) {
        const application = plan.capturedApplication;
        const response = {
          commands: [], reply: application.summary,
          application: { applied: true, versionId: application.versionId, baseRevision: application.baseRevision,
            workspaceRevision: application.workspaceRevision, document: application.document,
            summary: application.summary, quality: application.quality },
          sessionId, model: plan.session.model, reasoningEffort: plan.session.reasoningEffort || "model-default",
          provider: "github-copilot-sdk", durationMs: Date.now() - startedAt, toolsUsed: plan.usedToolNames
        };
        await deps.writeLog("turn.completed.with-applied-edit", {
          sessionId, versionId: application.versionId, baseRevision: application.baseRevision,
          workspaceRevision: application.workspaceRevision, summary: application.summary, qualityScore: application.quality.score
        });
        res.json(response);
        return;
      }
      if (plan.capturedProposal) {
        const proposal = plan.capturedProposal;
        const response = {
          commands: [], reply: proposal.summary,
          proposal: {
            proposalId: proposal.proposalId, baseRevision: proposal.baseRevision, document: proposal.document,
            summary: proposal.summary, baseQuality: proposal.baseQuality, quality: proposal.quality
          },
          sessionId, model: plan.session.model, reasoningEffort: plan.session.reasoningEffort || "model-default",
          provider: "github-copilot-sdk", durationMs: Date.now() - startedAt
        };
        await deps.writeLog("turn.completed.with-proposal", { sessionId, proposalId: proposal.proposalId, summary: proposal.summary, qualityScore: proposal.quality.score });
        res.json(response);
        return;
      }
      let resolved = plan.captured;
      let modelText = plan.modelText;
      if (!resolved) {
        resolved = planFromText(modelText, deps.allowedCommands);
        if (resolved) await deps.writeLog("turn.plan.parsed-from-text", { sessionId, commandCount: resolved.commands.length });
      }
      if (!resolved) {
        if (plan.usedToolNames.length) {
          await deps.writeLog("turn.completed.after-analysis-tools", { sessionId, model: plan.session.model, tools: plan.usedToolNames, modelText: modelText.slice(0, 2000) });
          res.json({
            commands: [], reply: modelText.slice(0, 500) || "The requested analysis completed; the diagram is unchanged.",
            sessionId, model: plan.session.model, reasoningEffort: plan.session.reasoningEffort || "model-default",
            provider: "github-copilot-sdk", durationMs: Date.now() - startedAt, toolsUsed: plan.usedToolNames
          });
          return;
        }
        await deps.writeLog("turn.completed.without-plan", { sessionId, model: plan.session.model, modelText: modelText.slice(0, 2000) });
        res.json({
          commands: [], reply: modelText.slice(0, 500) || "No actionable plan was produced and the diagram is unchanged. Try specifying a supported layout or semantic edit.",
          sessionId, model: plan.session.model, reasoningEffort: plan.session.reasoningEffort || "model-default",
          provider: "github-copilot-sdk", durationMs: Date.now() - startedAt
        });
        return;
      }
      const response = {
        ...resolved, sessionId, model: plan.session.model, reasoningEffort: plan.session.reasoningEffort || "model-default",
        provider: "github-copilot-sdk", durationMs: Date.now() - startedAt
      };
      await deps.writeLog("turn.completed", { sessionId, model: plan.session.model, durationMs: response.durationMs, response });
      res.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await deps.writeLog("turn.failed", {
        sessionId, model, durationMs: Date.now() - startedAt,
        errorName: error instanceof Error ? error.name : typeof error, errorMessage: message
      });
      res.status(502).json({ error: describeCopilotFailure(message), sessionId });
    }
  });
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
