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

/** Handed to one conversation turn; `session` follows the live session if the runtime is rebuilt mid-turn. */
export interface SessionTurn {
  readonly session: RuntimeSession;
  send(body: unknown, timeoutMs: number): Promise<SessionEvent | undefined>;
}

export interface CopilotRuntimeOptions {
  log: Logger;
  defaultModel: string;
  /** Sessions idle for longer than this are disconnected and dropped from the cache. */
  idleTtlMs: number;
  baseDirectory?: string;
  modelsCacheTtlMs?: number;
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

  constructor(private readonly options: CopilotRuntimeOptions) {
    if (options.idleTtlMs > 0) {
      const interval = Math.min(Math.max(options.idleTtlMs, 60_000), 5 * 60_000);
      this.sweepTimer = setInterval(() => { void this.sweepIdleSessions(); }, interval);
      this.sweepTimer.unref();
    }
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
      await this.options.log("client.started", { defaultModel: this.options.defaultModel });
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
          void this.options.log("session.deleted.externally", { conversationId, sdkSessionId: sessionId });
        }
      });
    } catch (error) {
      void this.options.log("client.lifecycle.unavailable", { error: messageOf(error) });
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
    const supported = (await this.listModels().catch(() => []))
      .find((item) => item.id === model)?.supportedReasoningEfforts || [];
    for (const effort of [requested, ...EFFORT_ORDER]) {
      if (supported.includes(effort)) return effort;
    }
    await this.options.log("models.effort.unresolved", { model, requested, supported: supported.length });
    return undefined;
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
          return outcome.message;
        }
      };
      return await run(turn);
    } finally {
      active.lastUsedAt = Date.now();
      if (this.turnLocks.get(conversationId) === lock) this.turnLocks.delete(conversationId);
      release();
    }
  }

  /** Sends one prompt; if the CLI died under it, rebuilds the session once and replays the same prompt. */
  private async sendWithRecovery(session: RuntimeSession, body: unknown, timeoutMs: number): Promise<{ session: RuntimeSession; message: SessionEvent | undefined }> {
    try {
      const message = await session.session.sendAndWait(body as SendBody, timeoutMs);
      return { session, message };
    } catch (error) {
      const message = messageOf(error);
      if (!isRecoverable(message)) throw error;
      await this.options.log("turn.recovering", { conversationId: session.conversationId, error: message });
      const fresh = await this.reopenSession(session);
      const retried = await fresh.session.sendAndWait(body as SendBody, timeoutMs);
      return { session: fresh, message: retried };
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
    const base: ResumeSessionConfig = {
      streaming: true,
      availableTools: new ToolSet().addCustom("*"),
      tools: prepared.tools,
      systemMessage: { content: prepared.systemMessage },
      // Without this callback the SDK emits a permission request and leaves it pending,
      // which can make sendAndWait hang forever. This runtime uses mode:"empty" and
      // exposes only Studio-owned custom tools, so approve each tool invocation once;
      // no ambient shell/filesystem tools are enabled by this session configuration.
      onPermissionRequest: async (request) => {
        // Permission callbacks must never depend on log storage completing. A slow disk/log
        // sink here blocks the SDK's permission handshake and can stall sendAndWait.
        void Promise.resolve(this.options.log("permission.request", {
          kind: request.kind,
          decision: "approve-once"
        })).catch(() => undefined);
        return { kind: "approve-once" };
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
        void this.options.log("sdk.event", { conversationId: runtimeSession.conversationId, ...compactEvent(event) });
      });
    } catch (error) {
      void this.options.log("session.events.unavailable", { conversationId: runtimeSession.conversationId, error: messageOf(error) });
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One user-facing sentence per failure class; the raw SDK message stays in the JSONL log. */
export function describeCopilotFailure(message: string): string {
  if (/availableTools/i.test(message)) return "The Copilot session is missing its tool configuration, so this request was not executed. Restart the copilot service and try again.";
  if (/quota|rate limit|402/i.test(message)) return "GitHub Copilot quota is exhausted or rate limited, so this request was not executed. Switch accounts or try again later.";
  if (/not logged in|authentication|401|unauthorized/i.test(message)) return "The local Copilot identity is signed out or expired, so this request was not executed. Run copilot login in a terminal first.";
  if (/model/i.test(message) && /not (found|supported|available)/i.test(message)) return "The selected model is unavailable, so this request was not executed. Pick another model under Settings.";
  if (/timeout|timed out/i.test(message)) return "Copilot did not answer in time, so this request was not executed. Shorten the instruction and try again.";
  return "The Copilot runtime failed, so this request was not executed: " + (message.length > 300 ? message.slice(0, 300) + "…" : message);
}
