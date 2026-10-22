import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { CopilotClient, ToolSet } from "@github/copilot-sdk";
import type {
  CopilotSession,
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent
} from "@github/copilot-sdk";
import { chooseRuntimeModel, readCopilotProvider, toProviderConfig, type CopilotProvider, type ModelChoice } from "./model-routing";

export type Logger = (event: string, fields?: Record<string, unknown>) => Promise<void> | void;

/** Everything a session needs from the studio document side: prompt text, the tool, and the config revision it came from. */
export interface SessionPreparation {
  configRevisionId: string;
  systemMessage: string;
  tools: NonNullable<SessionConfig["tools"]>;
  workspaceId?: string;
}

export interface RuntimeSession {
  session: CopilotSession;
  /** SDK-side session id; stable for a conversation + configuration revision. */
  sdkSessionId: string;
  conversationId: string;
  model: string;
  /** Model the runtime actually used for the last turn; differs from `model` when it auto-routed. */
  observedModel?: string;
  configRevisionId: string;
  /** Effort the caller asked for; part of the cache key. */
  requestedEffort: "high" | "max";
  /** Effort the runtime actually accepted for this model. */
  reasoningEffort?: string;
  workspaceId?: string;
  lastUsedAt: number;
  /** Reusable when the runtime has to rebuild the session after a crash. */
  prepared: SessionPreparation;
  /** Detaches the session event listener. */
  disposeEvents?: () => void;
}

export interface SessionRequest {
  conversationId: string;
  model: string;
  requestedEffort: "high" | "max";
  prepare: () => Promise<SessionPreparation>;
}

/** Usage reported by one Copilot SDK assistant.usage event. Missing fields stay absent. */
export interface ModelCallUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  premiumRequestCost?: number;
  totalNanoAiu?: number;
  durationMs?: number;
  finishReason?: string;
  reasoningEffort?: string;
  timeToFirstTokenMs?: number;
  interTokenLatencyMs?: number;
}

/** Current prompt/context occupancy; this is not the same as tokens consumed by the turn. */
export interface ContextUsage {
  currentTokens?: number;
  tokenLimit?: number;
  messagesLength?: number;
  percent?: number;
}

export interface TurnUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  premiumRequestCost?: number;
  totalNanoAiu?: number;
  modelCalls?: number;
  source: "provider-event" | "session-metrics" | "unknown";
  byModel?: Record<string, Omit<ModelCallUsage, "model" | "finishReason" | "reasoningEffort" | "timeToFirstTokenMs" | "interTokenLatencyMs">>;
}

export interface SessionSendResult {
  message?: SessionEvent;
  usage?: TurnUsageMetrics;
  modelCallUsages: ModelCallUsage[];
  contextUsage?: ContextUsage;
}

/** Handed to one conversation turn; `session` follows the live session if the runtime is rebuilt mid-turn. */
export interface SessionTurn {
  readonly session: RuntimeSession;
  send(body: unknown, timeoutMs: number): Promise<SessionSendResult>;
}

export interface CopilotRuntimeOptions {
  log: Logger;
  defaultModel: string;
  /** Sessions idle for longer than this are disconnected and dropped from the cache. */
  idleTtlMs: number;
  baseDirectory?: string;
  modelsCacheTtlMs?: number;
  /** Custom-provider configuration; read from the environment when omitted. */
  provider?: CopilotProvider;
}

const EFFORT_ORDER = ["max", "xhigh", "high", "medium", "low"] as const;
type Effort = (typeof EFFORT_ORDER)[number];
type SendBody = Parameters<CopilotSession["sendAndWait"]>[0];

/**
 * Failures the CLI process itself produces. Everything else (quota, auth, model selection) is an answer from
 * the service and rebuilding the client would only hide it, so only these trigger a reconnect.
 */
function isRecoverable(message: string): boolean {
  return /ECONNREFUSED|ECONNRESET|EPIPE|not running|has stopped|process exited|connection (closed|refused|reset)|client not connected|session is disconnected|session (is )?(closed|disconnected)|runtime (stopped|closed)/i.test(message);
}

/** Session-level events are logged compactly: the full payload of a turn is megabytes of deltas. */
function compactEvent(event: SessionEvent): Record<string, unknown> {
  const payload = event as SessionEvent & { ephemeral?: boolean };
  let detail = "";
  try {
    detail = JSON.stringify(event.data ?? {});
  } catch {
    detail = "[unserializable]";
  }
  return { type: event.type, ephemeral: payload.ephemeral === true, detail: detail.length > 300 ? detail.slice(0, 300) + "…" : detail };
}

/**
 * Owns the Copilot SDK client and the conversation-level session cache.
 *
 * The client is created lazily and rebuilt once if the underlying runtime dies, so a crashed CLI does not
 * poison every later request. Sessions are keyed by conversation, reuse their SDK identity across server
 * restarts (resume → create), and are dropped when the studio configuration revision changes.
 */
export class CopilotRuntime {
  private client: CopilotClient | null = null;
  private clientStart: Promise<CopilotClient> | null = null;
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;
  private modelsInFlight: Promise<ModelInfo[]> | null = null;
  private readonly sessions = new Map<string, RuntimeSession>();
  private readonly sessionLocks = new Map<string, Promise<void>>();
  private readonly turnLocks = new Map<string, Promise<void>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private readonly provider: CopilotProvider;

  constructor(private readonly options: CopilotRuntimeOptions) {
    this.provider = options.provider || readCopilotProvider();
    if (options.idleTtlMs > 0) {
      const interval = Math.min(Math.max(options.idleTtlMs, 60_000), 5 * 60_000);
      this.sweepTimer = setInterval(() => { void this.sweepIdleSessions(); }, interval);
      this.sweepTimer.unref();
    }
  }

  /** Custom-provider state of this process, for health output and failure messages. */
  get providerInfo(): CopilotProvider {
    return this.provider;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Cheap status probe: reports the runtime state without starting it, and reads the Copilot identity only
   * when a runtime is already up (the auth RPC is an IPC round-trip, not a network call).
   */
  async health(): Promise<{ runtime: "stopped" | "starting" | "running"; sessions: number; auth: { authenticated: boolean; login?: string; authType?: string } | null }> {
    const state = this.client ? "running" : this.clientStart ? "starting" : "stopped";
    let auth: { authenticated: boolean; login?: string; authType?: string } | null = null;
    if (this.client) {
      try {
        const status = await this.client.getAuthStatus();
        auth = { authenticated: status.isAuthenticated, login: status.login, authType: status.authType };
      } catch (error) {
        await this.options.log("client.auth-status.failed", { error: messageOf(error) });
      }
    }
    return { runtime: state, sessions: this.sessions.size, auth };
  }

  listSessions(workspaceId?: string): Array<{ sessionId: string; model: string; reasoningEffort: string; lastUsedAt: string }> {
    return [...this.sessions.entries()]
      .filter(([, item]) => !workspaceId || item.workspaceId === workspaceId)
      .map(([conversationId, item]) => ({
        sessionId: conversationId,
        model: item.model,
        reasoningEffort: item.reasoningEffort || "model-default",
        lastUsedAt: new Date(item.lastUsedAt).toISOString()
      }));
  }

  /** Starts the runtime once; concurrent callers share the same start attempt. */
  async getClient(): Promise<CopilotClient> {
    if (this.stopping) throw new Error("Copilot runtime is shutting down");
    if (this.client) return this.client;
    if (this.clientStart) return this.clientStart;
    this.clientStart = (async () => {
      // "empty" keeps the runtime free of host capabilities: no built-in shell or file tools.
      const client = new CopilotClient({
        mode: "empty",
        useLoggedInUser: true,
        baseDirectory: this.options.baseDirectory || process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot")
      });
      try {
        await client.start();
      } catch (error) {
        this.clientStart = null;
        await this.options.log("client.start.failed", { error: messageOf(error) });
        throw error;
      }
      this.client = client;
      this.clientStart = null;
      this.watchLifecycle(client);
      await this.options.log("client.started", {
        defaultModel: this.options.defaultModel,
        provider: this.provider.mode,
        providerHost: this.provider.host ?? null,
        providerModel: this.provider.model ?? null
      });
      return client;
    })();
    return this.clientStart;
  }

  /**
   * Drops the current client so the next call spawns a fresh runtime. Cached sessions belong to the old
   * process and are unusable, so they are released here instead of failing on the next turn.
   */
  private async resetClient(reason: string): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientStart = null;
    this.modelsCache = null;
    for (const [conversationId, session] of [...this.sessions.entries()]) {
      this.sessions.delete(conversationId);
      session.disposeEvents?.();
      await this.options.log("session.invalidated", { conversationId, sdkSessionId: session.sdkSessionId, reason });
    }
    if (!client) return;
    await this.options.log("client.reset", { reason });
    try { await client.forceStop(); } catch { /* the runtime is already gone */ }
  }

  /**
   * Schedules diagnostics without allowing either asynchronous or synchronous logger failures to
   * escape into SDK callbacks. Permission and MCP-auth callbacks must settle independently of I/O.
   */
  private logDetached(event: string, fields?: Record<string, unknown>): void {
    void Promise.resolve()
      .then(() => this.options.log(event, fields))
      .catch(() => undefined);
  }

  /** Drops a session the runtime itself reported as deleted, so the next turn resumes from disk. */
  private watchLifecycle(client: CopilotClient): void {
    try {
      client.onLifecycle("session.deleted", (event) => {
        const sessionId = (event as { sessionId?: string }).sessionId;
        if (!sessionId) return;
        for (const [conversationId, item] of [...this.sessions.entries()]) {
          if (item.sdkSessionId !== sessionId) continue;
          this.sessions.delete(conversationId);
          item.disposeEvents?.();
          this.logDetached("session.deleted.externally", { conversationId, sdkSessionId: sessionId });
        }
      });
    } catch (error) {
      this.logDetached("client.lifecycle.unavailable", { error: messageOf(error) });
    }
  }

  /** Runs a client call, rebuilding the runtime once when the failure looks like a dead CLI process. */
  private async withClient<T>(label: string, run: (client: CopilotClient) => Promise<T>): Promise<T> {
    const client = await this.getClient();
    try {
      return await run(client);
    } catch (error) {
      const message = messageOf(error);
      if (!isRecoverable(message)) throw error;
      await this.options.log("client.recovering", { label, error: message });
      await this.resetClient(label);
      return run(await this.getClient());
    }
  }

  /**
   * Models the account may use. An empty answer is not cached: it usually means the runtime has not resolved
   * entitlements yet (or the account is out of quota), and it would otherwise stick for the whole process.
   * The SDK keeps its own copy of that empty answer, so `refresh: true` rebuilds the client to bypass it.
   */
  async listModels(options: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    if (options.refresh) await this.resetClient("models.refresh");
    const ttl = this.options.modelsCacheTtlMs ?? 5 * 60_000;
    if (this.modelsCache && Date.now() - this.modelsCache.at < ttl) return this.modelsCache.models;
    if (this.modelsInFlight) return this.modelsInFlight;
    this.modelsInFlight = this.withClient("listModels", (client) => client.listModels())
      .then(async (models) => {
        if (models.length) this.modelsCache = { at: Date.now(), models };
        else await this.options.log("models.empty", { note: "the account or runtime has not returned a model list yet" });
        return models;
      })
      .finally(() => { this.modelsInFlight = null; });
    return this.modelsInFlight;
  }

  /** Maps the requested effort onto what the chosen model actually supports. */
  async resolveEffort(model: string, requested: "high" | "max"): Promise<Effort | undefined> {
    // A custom provider publishes no catalog, so there is nothing to map the effort onto; the
    // runtime applies the provider's own default instead of guessing a level it cannot support.
    if (this.provider.mode === "byok") return undefined;
    const supported = (await this.listModels().catch(() => []))
      .find((item) => item.id === model)?.supportedReasoningEfforts || [];
    for (const effort of [requested, ...EFFORT_ORDER]) {
      if (supported.includes(effort)) return effort;
    }
    await this.options.log("models.effort.unresolved", { model, requested, supported: supported.length });
    return undefined;
  }

  /**
   * Resolves the model id a turn will actually run on.
   *
   * A model the runtime does not know is not rejected: it silently falls back to automatic routing
   * and bills whichever catalog model it picks. Choosing the id here keeps the turn and the bill on
   * the same model, and records every substitution so a mismatch is diagnosable after the fact.
   */
  async resolveModel(requested: string): Promise<ModelChoice> {
    const available = this.provider.mode === "byok"
      ? []
      : await this.listModels().then((models) => models.map((model) => model.id)).catch(() => []);
    const choice = chooseRuntimeModel({ requested, provider: this.provider, available });
    if (choice.substituted) {
      await this.options.log("model.substituted", {
        requested, model: choice.model, reason: choice.reason, available: choice.available.slice(0, 12)
      });
    }
    return choice;
  }

  /** Last model the runtime reported for a conversation, which is not always the requested one. */
  lastObservedModel(conversationId: string): string | undefined {
    return this.sessions.get(conversationId)?.observedModel;
  }

  /** Returns a session matching the requested conversation, model, and configuration revision. */
  async acquireSession(request: SessionRequest): Promise<RuntimeSession> {
    const prepared = await request.prepare();
    const reused = this.sessions.get(request.conversationId);
    if (reused && this.matches(reused, request, prepared.configRevisionId)) {
      reused.lastUsedAt = Date.now();
      return reused;
    }
    return this.withSessionLock(request.conversationId, async () => {
      const current = this.sessions.get(request.conversationId);
      if (current && this.matches(current, request, prepared.configRevisionId)) {
        current.lastUsedAt = Date.now();
        return current;
      }
      if (current) await this.retireSession(current, "configuration.changed");
      return this.openSession(request, prepared);
    });
  }

  private matches(session: RuntimeSession, request: SessionRequest, configRevisionId: string): boolean {
    return session.configRevisionId === configRevisionId
      && session.model === request.model
      && session.requestedEffort === request.requestedEffort;
  }

  private async withSessionLock<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
    const pending = this.sessionLocks.get(conversationId);
    if (pending) {
      await pending.catch(() => undefined);
      return this.withSessionLock(conversationId, run);
    }
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.sessionLocks.set(conversationId, lock);
    try {
      return await run();
    } finally {
      if (this.sessionLocks.get(conversationId) === lock) this.sessionLocks.delete(conversationId);
      release();
    }
  }

  /**
   * Runs one conversation turn under a per-conversation lock, so two browser tabs cannot interleave prompts
   * on the same SDK session. The lock covers the whole turn, including the follow-up call made by callers.
   */
  async withTurn<T>(conversationId: string, run: (turn: SessionTurn) => Promise<T>): Promise<T> {
    const queued = this.sessions.get(conversationId);
    if (!queued) throw new Error(`No Copilot session is available for ${conversationId}`);

    const pending = this.turnLocks.get(conversationId);
    let release!: () => void;
    const lock = new Promise<void>((resolve) => { release = resolve; });
    this.turnLocks.set(conversationId, lock);
    let active = queued;
    try {
      if (pending) await pending.catch(() => undefined);
      const turn: SessionTurn = {
        get session() { return active; },
        send: async (body, timeoutMs) => {
          const outcome = await this.sendWithRecovery(active, body, timeoutMs);
          active = outcome.session;
          return {
            message: outcome.message,
            ...(outcome.usage ? { usage: outcome.usage } : {}),
            modelCallUsages: outcome.modelCallUsages,
            ...(outcome.contextUsage ? { contextUsage: outcome.contextUsage } : {})
          };
        }
      };
      return await run(turn);
    } finally {
      active.lastUsedAt = Date.now();
      if (this.turnLocks.get(conversationId) === lock) this.turnLocks.delete(conversationId);
      release();
    }
  }

  /** Sends one prompt; captures real SDK usage events and retries once if the CLI process died. */
  private async sendWithRecovery(session: RuntimeSession, body: unknown, timeoutMs: number, recovered = false): Promise<{ session: RuntimeSession; message: SessionEvent | undefined; usage?: TurnUsageMetrics; modelCallUsages: ModelCallUsage[]; contextUsage?: ContextUsage }> {
    const modelCallUsages: ModelCallUsage[] = [];
    let contextUsage: ContextUsage | undefined;
    const offUsage = session.session.on((event: SessionEvent) => {
      const data = event.data as unknown as Record<string, unknown> | undefined;
      if (!data) return;
      if (event.type === "assistant.usage") {
        const item = normalizeModelCallUsage(data);
        if (item) modelCallUsages.push(item);
      } else if (event.type === "session.usage_info") {
        contextUsage = normalizeContextUsage(data);
      }
    });

    try {
      const usageBefore = await readSessionUsageMetrics(session.session);
      const pending = session.session.sendAndWait(body as SendBody, timeoutMs > 0 ? timeoutMs + 1_000 : timeoutMs);
      let watchdog: NodeJS.Timeout | undefined;
      let message: SessionEvent | undefined;
      try {
        // Keep an application-level watchdog because SDK sendAndWait timeouts are not
        // sufficient protection against a stuck external-tool dispatch / tool loop.
        message = timeoutMs > 0
          ? await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                watchdog = setTimeout(
                  () => reject(new Error(`Copilot turn watchdog timed out after ${timeoutMs}ms`)),
                  timeoutMs
                );
              })
            ])
          : await pending;
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
      const usageAfter = await readSessionUsageMetrics(session.session);
      const eventUsage = aggregateModelCallUsage(modelCallUsages);
      const metricUsage = diffSessionUsageMetrics(usageAfter, usageBefore);
      const usage = mergeTurnUsagePreferProviderEvents(eventUsage, metricUsage);
      return {
        session, message, modelCallUsages,
        ...(usage ? { usage } : {}),
        ...(contextUsage ? { contextUsage } : {})
      };
    } catch (error) {
      const message = messageOf(error);
      if (/Copilot turn watchdog timed out/i.test(message)) {
        // Stop the SDK session explicitly and bound both abort and idle waits; the HTTP
        // request must not hang forever while trying to clean up a stuck background turn.
        await this.abortAfterWatchdog(session.session);
        throw error;
      }
      if (!isRecoverable(message) || recovered) throw error;
      await this.options.log("turn.recovering", { conversationId: session.conversationId, error: message });
      const fresh = await this.reopenSession(session);
      // Reuse the same watchdog/abort path on the single permitted retry. A second
      // transport failure is surfaced rather than recursively recreating sessions.
      return this.sendWithRecovery(fresh, body, timeoutMs, true);
    } finally {
      offUsage();
    }
  }

  private async abortAfterWatchdog(session: CopilotSession): Promise<void> {
    let idleTimer: NodeJS.Timeout | undefined;
    let abortTimer: NodeJS.Timeout | undefined;
    let off = () => {};
    let settled = false;
    const idle = new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        off();
        resolve(value);
      };
      off = session.on("session.idle", () => finish(true));
      idleTimer = setTimeout(() => finish(false), 10_000);
    });
    try {
      await Promise.race([
        session.abort(),
        new Promise<never>((_, reject) => {
          abortTimer = setTimeout(() => reject(new Error("Copilot abort timed out")), 10_000);
        })
      ]);
      const idleObserved = await idle;
      if (!idleObserved) {
        this.logDetached("turn.abort.idle-timeout", {});
      }
    } catch (error) {
      this.logDetached("turn.abort.failed", {
        error: messageOf(error),
        idleObserved: settled
      });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (abortTimer) clearTimeout(abortTimer);
      off();
    }
  }

  /** Rebuilds a session for the same conversation after the runtime process was replaced. */
  private async reopenSession(previous: RuntimeSession): Promise<RuntimeSession> {
    await this.resetClient("turn.recovery");
    return this.openSession(
      {
        conversationId: previous.conversationId,
        model: previous.model,
        requestedEffort: previous.requestedEffort,
        prepare: async () => previous.prepared
      },
      previous.prepared
    );
  }

  private async retireSession(session: RuntimeSession, reason: string): Promise<void> {
    this.sessions.delete(session.conversationId);
    const turn = this.turnLocks.get(session.conversationId);
    if (turn) await turn.catch(() => undefined);
    session.disposeEvents?.();
    try {
      await session.session.disconnect();
      await this.options.log("session.closed", { conversationId: session.conversationId, reason });
    } catch (error) {
      await this.options.log("session.close.failed", { conversationId: session.conversationId, reason, error: messageOf(error) });
    }
  }

  private async openSession(request: SessionRequest, prepared: SessionPreparation): Promise<RuntimeSession> {
    const effort = request.requestedEffort;
    // The runtime only leaves the Copilot API when the session itself declares a custom provider;
    // the CLI environment alone is not enough for sessions the SDK hosts over RPC.
    const providerConfig = toProviderConfig(this.provider);
    const base: ResumeSessionConfig = {
      streaming: true,
      ...(providerConfig ? { provider: providerConfig } : {}),
      availableTools: new ToolSet().addCustom("*"),
      tools: prepared.tools,
      systemMessage: { content: prepared.systemMessage },
      // Without this callback the SDK emits a permission request and leaves it pending,
      // which can make sendAndWait hang forever. This runtime uses mode:"empty" and
      // exposes only Studio-owned custom tools, so approve each tool invocation once;
      // no ambient shell/filesystem tools are enabled by this session configuration.
      onPermissionRequest: async (request, invocation) => {
        // This app has no human approval UI. Never auto-approve a request that carries
        // managed-policy requirements; explicitly fail closed instead of leaving it pending.
        const managedApprovalRequired = request.managedApprovalRequired === true;
        const managedSettingsEnabled = invocation.managedSettingsEnabled === true;
        if (managedApprovalRequired || managedSettingsEnabled) {
          this.logDetached("permission.request", {
            kind: request.kind,
            decision: "user-not-available",
            managedApprovalRequired,
            managedSettingsEnabled
          });
          return { kind: "user-not-available" };
        }

        // Permission callbacks must never depend on log storage completing. A slow disk/log
        // sink here blocks the SDK's permission handshake and can stall sendAndWait.
        this.logDetached("permission.request", {
          kind: request.kind,
          decision: "approve-once"
        });
        return { kind: "approve-once" };
      },
      // This application has no OAuth UI/token broker. Cancel explicitly so an MCP
      // authentication request cannot remain pending indefinitely inside the SDK.
      onMcpAuthRequest: async (request) => {
        this.logDetached("mcp.auth.cancelled", {
          serverName: request.serverName,
          reason: request.reason
        });
        return { kind: "cancelled" };
      }
    };

    // The runtime rejects session ids containing dots, so the studio conversation id is sanitized and the
    // configuration revision is folded into the id to isolate SDK history per revision.
    const revisionKey = createHash("sha256").update([prepared.configRevisionId, request.model, effort].join("\0")).digest("hex").slice(0, 16);
    const sdkSessionId = (request.conversationId.replace(/[^a-zA-Z0-9-]/g, "-") + "-cfg-" + revisionKey).slice(0, 100);

    let resumed: CopilotSession | null = null;
    try {
      resumed = await this.withClient("resumeSession", (client) => client.resumeSession(sdkSessionId, base));
      await this.options.log("session.resumed", { conversationId: request.conversationId, sdkSessionId });
    } catch (error) {
      const message = messageOf(error);
      await this.options.log("session.resume.failed", { conversationId: request.conversationId, sdkSessionId, error: message });
      // Only recreate a missing session. Auth, quota, transport and SDK errors must remain
      // visible; silently creating a new session can discard conversation history.
      if (!/session not found|no such session|unknown session|does not exist|has been deleted/i.test(message)) {
        throw error;
      }
    }

    let session = resumed;
    let actualEffort: Effort | undefined = effort;
    if (!session) {
      actualEffort = await this.resolveEffort(request.model, effort);
      session = await this.withClient("createSession", (client) => client.createSession({
        ...base,
        sessionId: sdkSessionId,
        model: request.model,
        ...(actualEffort ? { reasoningEffort: actualEffort } : {})
      }));
      await this.options.log("session.created", {
        conversationId: request.conversationId, sdkSessionId, model: request.model,
        reasoningEffort: actualEffort || "model-default"
      });
    }

    const runtimeSession: RuntimeSession = {
      session,
      sdkSessionId,
      conversationId: request.conversationId,
      model: request.model,
      configRevisionId: prepared.configRevisionId,
      requestedEffort: effort,
      reasoningEffort: actualEffort,
      workspaceId: prepared.workspaceId,
      lastUsedAt: Date.now(),
      prepared
    };
    this.sessions.set(request.conversationId, runtimeSession);
    runtimeSession.disposeEvents = this.attachEvents(runtimeSession);
    return runtimeSession;
  }

  private attachEvents(runtimeSession: RuntimeSession): () => void {
    try {
      return runtimeSession.session.on((event: SessionEvent) => {
        // The runtime announces the model it settled on before the first token; keeping it lets a
        // quota failure name the model that was actually billed instead of the one that was asked for.
        const observed = observedModelOf(event);
        if (observed) runtimeSession.observedModel = observed;
        this.logDetached("sdk.event", { conversationId: runtimeSession.conversationId, ...compactEvent(event) });
      });
    } catch (error) {
      this.logDetached("session.events.unavailable", { conversationId: runtimeSession.conversationId, error: messageOf(error) });
      return () => undefined;
    }
  }

  private async sweepIdleSessions(): Promise<void> {
    const ttl = this.options.idleTtlMs;
    if (ttl <= 0) return;
    const now = Date.now();
    for (const item of [...this.sessions.values()]) {
      if (now - item.lastUsedAt < ttl) continue;
      await this.retireSession(item, "idle-timeout");
    }
  }

  /** Stops every session and the runtime itself; safe to call twice. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const item of [...this.sessions.values()]) await this.retireSession(item, "shutdown");
    const client = this.client;
    this.client = null;
    this.clientStart = null;
    if (client) {
      const errors = await client.stop().catch((error: unknown) => [error instanceof Error ? error : new Error(String(error))]);
      if (errors.length) await this.options.log("client.stop.failed", { errors: errors.map((error) => error.message) });
    }
  }
}

type UsageRecord = Record<string, unknown>;

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModelCallUsage(data: UsageRecord): ModelCallUsage | undefined {
  const usage: ModelCallUsage = {};
  const fields: Array<[keyof ModelCallUsage, string]> = [
    ["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"],
    ["totalTokens", "totalTokens"], ["cachedInputTokens", "cacheReadTokens"],
    ["cacheWriteTokens", "cacheWriteTokens"], ["reasoningTokens", "reasoningTokens"],
    ["premiumRequestCost", "cost"], ["totalNanoAiu", "totalNanoAiu"],
    ["durationMs", "duration"], ["timeToFirstTokenMs", "timeToFirstTokenMs"],
    ["interTokenLatencyMs", "interTokenLatencyMs"]
  ];
  for (const [target, source] of fields) {
    const value = numberValue(data[source]);
    if (value !== undefined) (usage as Record<string, unknown>)[target] = value;
  }
  const model = stringValue(data.model);
  const finishReason = stringValue(data.finishReason);
  const reasoningEffort = stringValue(data.reasoningEffort);
  if (model) usage.model = model;
  if (finishReason) usage.finishReason = finishReason;
  if (reasoningEffort) usage.reasoningEffort = reasoningEffort;
  if (usage.totalTokens === undefined && usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function normalizeContextUsage(data: UsageRecord): ContextUsage | undefined {
  const result: ContextUsage = {};
  const currentTokens = numberValue(data.currentTokens);
  const tokenLimit = numberValue(data.tokenLimit);
  const messagesLength = numberValue(data.messagesLength);
  if (currentTokens !== undefined) result.currentTokens = currentTokens;
  if (tokenLimit !== undefined) result.tokenLimit = tokenLimit;
  if (messagesLength !== undefined) result.messagesLength = messagesLength;
  if (currentTokens !== undefined && tokenLimit !== undefined && tokenLimit > 0) {
    result.percent = Math.round(currentTokens / tokenLimit * 100);
  }
  return Object.keys(result).length ? result : undefined;
}

function sumNumber(target: Record<string, unknown>, source: ModelCallUsage, key: keyof ModelCallUsage): void {
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = (typeof target[key] === "number" ? target[key] as number : 0) + value;
  }
}

function aggregateModelCallUsage(calls: ModelCallUsage[]): TurnUsageMetrics | undefined {
  if (!calls.length) return undefined;
  const result: TurnUsageMetrics = { source: "provider-event", modelCalls: calls.length };
  const byModel: Record<string, Record<string, unknown>> = {};
  for (const call of calls) {
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "premiumRequestCost", "totalNanoAiu"] as const) {
      sumNumber(result as unknown as Record<string, unknown>, call, key);
    }
    const name = call.model || "unknown";
    const entry = byModel[name] ?? (byModel[name] = {});
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "premiumRequestCost", "totalNanoAiu"] as const) {
      sumNumber(entry, call, key);
    }
  }
  if (Object.keys(byModel).length) result.byModel = byModel as TurnUsageMetrics["byModel"];
  return result;
}

/** Read cumulative SDK metrics as a fallback when per-call assistant.usage events are unavailable. */
async function readSessionUsageMetrics(session: CopilotSession): Promise<UsageRecord | undefined> {
  try {
    const usage = (session as unknown as { usage?: { getMetrics?: () => Promise<unknown> } }).usage;
    if (!usage?.getMetrics) return undefined;
    const metrics = await usage.getMetrics();
    return metrics && typeof metrics === "object" ? metrics as UsageRecord : undefined;
  } catch {
    return undefined;
  }
}

function numericDelta(after: unknown, before: unknown): number | undefined {
  const a = numberValue(after);
  const b = numberValue(before);
  if (a === undefined || b === undefined) return undefined;
  return Math.max(0, a - b);
}

function diffSessionUsageMetrics(after: UsageRecord | undefined, before: UsageRecord | undefined): TurnUsageMetrics | undefined {
  if (!after) return undefined;
  const result: TurnUsageMetrics = { source: "session-metrics" };
  const totalFields: Array<[string, string]> = [
    ["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"], ["totalTokens", "totalTokens"],
    ["totalNanoAiu", "totalNanoAiu"], ["totalPremiumRequestCost", "premiumRequestCost"],
    ["cacheReadTokens", "cachedInputTokens"], ["cacheWriteTokens", "cacheWriteTokens"],
    ["reasoningTokens", "reasoningTokens"],
  ];
  for (const [source, target] of totalFields) {
    const value = numericDelta(after[source], before?.[source]);
    if (value !== undefined) (result as unknown as Record<string, unknown>)[target] = value;
  }
  const afterModels = after.modelMetrics;
  const beforeModels = before?.modelMetrics;
  if (afterModels && typeof afterModels === "object") {
    const byModel: Record<string, Record<string, unknown>> = {};
    for (const [model, raw] of Object.entries(afterModels as Record<string, unknown>)) {
      const afterModel = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const beforeRaw = beforeModels && typeof beforeModels === "object" ? (beforeModels as Record<string, unknown>)[model] : undefined;
      const beforeModel = beforeRaw && typeof beforeRaw === "object" ? beforeRaw as Record<string, unknown> : {};
      const afterUsage = afterModel.usage && typeof afterModel.usage === "object" ? afterModel.usage as Record<string, unknown> : {};
      const beforeUsage = beforeModel.usage && typeof beforeModel.usage === "object" ? beforeModel.usage as Record<string, unknown> : {};
      const item: Record<string, unknown> = {};
      const modelFields: Array<[string, string]> = [
        ["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"],
        ["cacheReadTokens", "cachedInputTokens"], ["cacheWriteTokens", "cacheWriteTokens"],
        ["reasoningTokens", "reasoningTokens"], ["totalPremiumRequestCost", "premiumRequestCost"],
      ];
      for (const [source, target] of modelFields) {
        const value = numericDelta(afterUsage[source], beforeUsage[source]);
        if (value !== undefined) item[target] = value;
      }
      const inputs = typeof item.inputTokens === "number" ? item.inputTokens : undefined;
      const outputs = typeof item.outputTokens === "number" ? item.outputTokens : undefined;
      if (inputs !== undefined && outputs !== undefined) item.totalTokens = inputs + outputs;
      const aiu = numericDelta(afterModel.totalNanoAiu, beforeModel.totalNanoAiu);
      if (aiu !== undefined) item.totalNanoAiu = aiu;
      if (Object.keys(item).length) byModel[model] = item;
    }
    if (Object.keys(byModel).length) result.byModel = byModel as TurnUsageMetrics["byModel"];
  }
  return Object.keys(result).some((key) => key !== "source") ? result : undefined;
}

/**
 * Per-call SDK events have richer token fields. Use their reported values first, and fill only
 * fields they did not report from the session-metrics delta so the same consumption isn't counted twice.
 */
function mergeTurnUsagePreferProviderEvents(
  eventUsage: TurnUsageMetrics | undefined,
  metricUsage: TurnUsageMetrics | undefined,
): TurnUsageMetrics | undefined {
  if (!eventUsage) return metricUsage;
  if (!metricUsage) return eventUsage;

  const merged = { ...metricUsage, ...eventUsage, source: "provider-event" as const };
  const metricRecord = metricUsage as unknown as Record<string, unknown>;
  const mergedRecord = merged as unknown as Record<string, unknown>;
  for (const key of [
    "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens",
    "reasoningTokens", "modelCalls", "premiumRequestCost", "totalNanoAiu",
  ]) {
    if (mergedRecord[key] === undefined && metricRecord[key] !== undefined) mergedRecord[key] = metricRecord[key];
  }

  const byModel: Record<string, Record<string, unknown>> = {};
  for (const [model, usage] of Object.entries(metricUsage.byModel ?? {})) {
    byModel[model] = { ...(usage as unknown as Record<string, unknown>) };
  }
  for (const [model, usage] of Object.entries(eventUsage.byModel ?? {})) {
    byModel[model] = {
      ...(byModel[model] ?? {}),
      ...(usage as unknown as Record<string, unknown>),
    };
  }
  if (Object.keys(byModel).length) merged.byModel = byModel as TurnUsageMetrics["byModel"];
  return merged;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The model the runtime settled on, from either the auto-routing decision or the first turn event. */
function observedModelOf(event: SessionEvent): string | undefined {
  const type = event.type as string;
  const data = event.data as { chosenModel?: unknown; model?: unknown } | undefined;
  if (type === "session.auto_mode_resolved" && typeof data?.chosenModel === "string") return data.chosenModel;
  if (type === "model.turn_started" && typeof data?.model === "string") return data.model;
  return undefined;
}

export interface FailureContext {
  /** Model the studio asked for. */
  requestedModel?: string;
  /** Model the runtime actually ran, when it announced one. */
  actualModel?: string;
}

/** One user-facing sentence per failure class; the raw SDK message stays in the JSONL log. */
export function describeCopilotFailure(message: string, context: FailureContext = {}): string {
  if (/availableTools/i.test(message)) return "The Copilot session is missing its tool configuration, so this request was not executed. Restart the copilot service and try again.";
  if (/quota|rate limit|402/i.test(message)) {
    const billed = context.actualModel;
    const drifted = Boolean(billed && context.requestedModel && billed !== context.requestedModel);
    return "GitHub Copilot quota is exhausted or rate limited"
      + (billed ? " for " + billed : "")
      + ", so this request was not executed."
      + (drifted
        ? " The runtime routed the turn to " + billed + " instead of " + context.requestedModel + ", which means no custom model provider is active for this server process."
        : " Switch accounts or try again later.");
  }
  if (/not logged in|authentication|401|unauthorized/i.test(message)) return "The local Copilot identity is signed out or expired, so this request was not executed. Run copilot login in a terminal first.";
  if (/model/i.test(message) && /not (found|supported|available)/i.test(message)) return "The selected model is unavailable, so this request was not executed. Pick another model under Settings.";
  if (/timeout|timed out/i.test(message)) return "Copilot did not answer in time, so this request was not executed. Shorten the instruction and try again.";
  return "The Copilot runtime failed, so this request was not executed: " + (message.length > 300 ? message.slice(0, 300) + "…" : message);
}
