/**
 * Which model the Copilot runtime will actually run.
 *
 * The runtime works in one of two modes. With `COPILOT_PROVIDER_BASE_URL` set it talks to a custom
 * (BYOK) provider and exposes exactly one model: the one named by `COPILOT_MODEL` /
 * `COPILOT_PROVIDER_MODEL_ID`. Without it, it talks to GitHub and exposes that account's catalog.
 *
 * The failure this module prevents: a model id the runtime does not know is not rejected. The runtime
 * silently falls back to automatic model routing and picks something from the GitHub catalog, so a
 * custom model ends up billed against the GitHub quota and the user sees a quota error that has
 * nothing to do with the model they configured. Choosing the model explicitly, here, keeps the
 * request and the bill on the same model.
 */

import type { ProviderConfig } from "@github/copilot-sdk";

export type CopilotProviderMode = "byok" | "github";
export type CopilotProviderType = "openai" | "azure" | "anthropic";

export interface CopilotProvider {
  mode: CopilotProviderMode;
  /** Custom provider endpoint; only present in BYOK mode. */
  baseUrl?: string;
  /** Host of the custom endpoint, safe to log and show in health output. */
  host?: string;
  /** Wire protocol the custom endpoint speaks. */
  type: CopilotProviderType;
  /** Model the runtime uses when a session does not name one (`COPILOT_MODEL` / `COPILOT_PROVIDER_MODEL_ID`). */
  model?: string;
  /** Model name sent to the provider API; defaults to `model`. */
  wireModel?: string;
  apiKey?: string;
  apiKeyCommand?: string;
  bearerToken?: string;
  wireApi?: "completions" | "responses";
  maxPromptTokens?: number;
  maxOutputTokens?: number;
  /** Extra headers sent only to the provider. */
  headers?: Record<string, string>;
}

/** Reads the provider configuration the Copilot runtime itself reads from its environment. */
export function readCopilotProvider(env: NodeJS.ProcessEnv = process.env): CopilotProvider {
  const baseUrl = text(env.COPILOT_PROVIDER_BASE_URL);
  const model = text(env.COPILOT_MODEL) || text(env.COPILOT_PROVIDER_MODEL_ID);
  const type = text(env.COPILOT_PROVIDER_TYPE);
  return {
    mode: baseUrl ? "byok" : "github",
    baseUrl,
    host: hostOf(baseUrl),
    type: type === "azure" || type === "anthropic" ? type : "openai",
    model,
    wireModel: text(env.COPILOT_PROVIDER_WIRE_MODEL),
    apiKey: text(env.COPILOT_PROVIDER_API_KEY),
    apiKeyCommand: text(env.COPILOT_PROVIDER_API_KEY_COMMAND),
    bearerToken: text(env.COPILOT_PROVIDER_BEARER_TOKEN),
    wireApi: text(env.COPILOT_PROVIDER_WIRE_API) === "responses" ? "responses" : undefined,
    maxPromptTokens: count(env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS),
    maxOutputTokens: count(env.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS),
    headers: headersOf(env.COPILOT_PROVIDER_HEADERS)
  };
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function count(value: string | undefined): number | undefined {
  const parsed = Number(text(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

/** `COPILOT_PROVIDER_HEADERS` is newline-separated "Name: Value" pairs. */
function headersOf(value: string | undefined): Record<string, string> | undefined {
  if (!value) return undefined;
  const headers: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const headerValue = line.slice(separator + 1).trim();
    if (name && headerValue) headers[name] = headerValue;
  }
  return Object.keys(headers).length ? headers : undefined;
}

/**
 * The session-level BYOK configuration.
 *
 * This is the part that actually routes traffic: the SDK runtime hosts sessions over RPC and only
 * switches away from the Copilot API when the session declares a provider. Setting the CLI
 * environment alone makes the runtime *log* that a custom model is configured, but every session it
 * serves still goes to the Copilot API — which is why a working `copilot` CLI and a failing Studio
 * request can coexist.
 */
export function toProviderConfig(provider: CopilotProvider): ProviderConfig | undefined {
  if (provider.mode !== "byok" || !provider.baseUrl) return undefined;
  const wireModel = provider.wireModel || provider.model;
  return {
    type: provider.type,
    baseUrl: provider.baseUrl,
    ...(provider.wireApi ? { wireApi: provider.wireApi } : {}),
    ...(provider.bearerToken ? { bearerToken: provider.bearerToken } : {}),
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    ...(provider.apiKeyCommand ? { apiKeyCommand: provider.apiKeyCommand } : {}),
    ...(provider.model ? { modelId: provider.model } : {}),
    ...(wireModel ? { wireModel } : {}),
    ...(provider.maxPromptTokens ? { maxPromptTokens: provider.maxPromptTokens } : {}),
    ...(provider.maxOutputTokens ? { maxOutputTokens: provider.maxOutputTokens } : {}),
    ...(provider.headers ? { headers: provider.headers } : {})
  };
}

function hostOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try { return new URL(baseUrl).host; } catch { return undefined; }
}

export type ModelChoiceReason = "requested" | "byok" | "catalog-default" | "catalog-first" | "unresolved";

export interface ModelChoice {
  model: string;
  /** True when the runtime cannot honour the requested id and another one was chosen instead. */
  substituted: boolean;
  reason: ModelChoiceReason;
  /** Model ids the runtime reported; empty when the catalog could not be read. */
  available: string[];
}

/**
 * Picks the model id to hand to `createSession`.
 *
 * A custom provider only serves its configured model, so that model always wins there. On GitHub's
 * side the reported catalog is authoritative: an id outside it would be auto-routed, so the
 * configured default (or the first available model) is used instead.
 */
export function chooseRuntimeModel(input: { requested: string; provider: CopilotProvider; available: string[] }): ModelChoice {
  const requested = input.requested.trim();
  const available = [...new Set(input.available.map((id) => id.trim()).filter(Boolean))];
  const configured = input.provider.model;

  if (input.provider.mode === "byok") {
    const model = configured || requested;
    return { model, substituted: Boolean(model && model !== requested), reason: "byok", available };
  }
  if (requested && available.includes(requested)) return { model: requested, substituted: false, reason: "requested", available };
  if (configured && available.includes(configured)) return { model: configured, substituted: true, reason: "catalog-default", available };
  if (available.length) return { model: available[0], substituted: true, reason: "catalog-first", available };
  // The catalog could not be read (no entitlements yet, or the account is over quota). There is
  // nothing to validate against, so keep the request as-is and let the runtime answer.
  const model = requested || configured || "";
  return { model, substituted: false, reason: model ? "requested" : "unresolved", available };
}

/** One line for health output and the startup log: which side of the routing the runtime is on. */
export function describeModelRouting(provider: CopilotProvider): string {
  if (provider.mode === "byok") {
    // Host only: a full URL can carry credentials or query parameters into a log line.
    return "custom provider " + (provider.host || "unset host") + " · model " + (provider.model || "unset");
  }
  return provider.model
    ? "GitHub Copilot catalog · configured model " + provider.model
    : "GitHub Copilot catalog · runtime default model";
}

/**
 * True when a model was configured but no custom provider can serve it — the configuration that
 * looks complete from the outside and silently routes to GitHub instead.
 */
export function isModelConfiguredWithoutProvider(provider: CopilotProvider): boolean {
  return provider.mode === "github" && Boolean(provider.model);
}
