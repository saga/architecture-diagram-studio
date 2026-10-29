import { useEffect, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import { Bubble, Sender } from "@ant-design/x";
import { Button, Select } from "antd";
import { recordDiagnostic } from "../diagnostics";
import type { DiagnosticEntry } from "../diagnostics";


export type WorkspacePage = "diagram" | "copilot" | "traces" | "settings";
type TraceFilter = "all" | "copilot" | "drawio" | "error";

const LOW_LEVEL_EVENT_PREFIXES = ["drawio.message.", "drawio.bundle.check.", "drawio.handshake.", "ui.theme."];
const LOW_LEVEL_EVENTS = new Set([
  "app.started",
  "workspace.hydrated",
  "navigation.opened",
  "models.empty",
  "trace.refreshed",
  "drawio.iframe.loaded",
  "drawio.bridge.ready",
  "drawio.plugin.bridge.ready",
  "drawio.document.load.sent"
]);

function isLowLevelTrace(entry: DiagnosticEntry): boolean {
  if (entry.level === "error" || entry.level === "warn") return false;
  if (entry.message === entry.event) return true;
  if (LOW_LEVEL_EVENTS.has(entry.event)) return true;
  return LOW_LEVEL_EVENT_PREFIXES.some((prefix) => entry.event.startsWith(prefix));
}

function traceTitle(entry: DiagnosticEntry): string {
  if (entry.message && entry.message !== entry.event) return entry.message;
  for (const key of ["errorMessage", "error", "note", "reason", "message"]) {
    const value = entry.details[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
  }
  return entry.event;
}

type TraceTokenUsage = {
  input: number | null;
  output: number | null;
  total: number | null;
  calls: number | null;
  cachedInput: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  premiumRequestCost: number | null;
  totalNanoAiu: number | null;
};

type TraceContextUsage = {
  currentTokens: number | null;
  tokenLimit: number | null;
  messagesLength: number | null;
  percent: number | null;
};

function traceTokenUsage(entry: DiagnosticEntry): TraceTokenUsage | null {
  const raw = entry.details.usage;
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const modelCalls = Array.isArray(entry.details.modelCallUsages) ? entry.details.modelCallUsages : [];
  const read = (source: Record<string, unknown>, key: string): number | null =>
    typeof source[key] === "number" && Number.isFinite(source[key]) && (source[key] as number) >= 0
      ? source[key] as number : null;
  const sumModelField = (key: string): number | null => {
    const byModel = value.byModel;
    if (!byModel || typeof byModel !== "object") return null;
    let total = 0, found = false;
    for (const item of Object.values(byModel as Record<string, unknown>)) {
      if (item && typeof item === "object") {
        const amount = read(item as Record<string, unknown>, key);
        if (amount !== null) { total += amount; found = true; }
      }
    }
    return found ? total : null;
  };
  const input = read(value, "inputTokens") ?? sumModelField("inputTokens");
  const output = read(value, "outputTokens") ?? sumModelField("outputTokens");
  const total = read(value, "totalTokens") ?? (input !== null && output !== null ? input + output : null);
  const calls = read(value, "modelCalls") ?? read(value, "calls") ?? (modelCalls.length ? modelCalls.length : null);
  const result: TraceTokenUsage = {
    input, output, total, calls,
    cachedInput: read(value, "cachedInputTokens"),
    cacheWrite: read(value, "cacheWriteTokens"),
    reasoning: read(value, "reasoningTokens"),
    premiumRequestCost: read(value, "premiumRequestCost"),
    totalNanoAiu: read(value, "totalNanoAiu")
  };
  const hasUsage = [result.input, result.output, result.total, result.calls, result.cachedInput, result.cacheWrite,
    result.reasoning, result.premiumRequestCost, result.totalNanoAiu].some((item) => item !== null);
  return hasUsage ? result : null;
}

function traceContextUsage(entry: DiagnosticEntry): TraceContextUsage | null {
  const raw = entry.details.contextUsage;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const read = (key: string): number | null =>
    typeof value[key] === "number" && Number.isFinite(value[key]) && (value[key] as number) >= 0
      ? value[key] as number : null;
  const result: TraceContextUsage = {
    currentTokens: read("currentTokens"),
    tokenLimit: read("tokenLimit"),
    messagesLength: read("messagesLength"),
    percent: read("percent")
  };
  return Object.values(result).some((item) => item !== null) ? result : null;
}

function formatTokenCount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "0";
}

function formatUsageAmount(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 6 }) : "—";
}

type ChatMessage = { role: "assistant" | "user"; text: string; id: number; proposal?: { id: string; summary: string } };
type DrawioStatus = "unknown" | "checking" | "ready" | "missing" | "error";
type ModelRouting = {
  mode?: "byok" | "github";
  host?: string | null;
  configuredModel?: string | null;
  summary?: string;
  modelConfiguredWithoutProvider?: boolean;
};

interface Props {
  page: Exclude<WorkspacePage, "diagram">;
  messages: ChatMessage[];
  chatInput: string;
  setChatInput: (value: string) => void;
  chatBusy: boolean;
  sendIntent: () => void;
  confirmProposal: (proposalId: string) => void;
  aiModel: string;
  setAiModel: (value: string) => void;
  reasoningEffort: "low" | "medium" | "high" | "max";
  setReasoningEffort: (value: "low" | "medium" | "high" | "max") => void;
  saveAISettings: () => void;
  clearAISettings: () => void;
  traceEntries: DiagnosticEntry[];
  refreshTraces: () => void;
  drawioStatus: DrawioStatus;
  drawioStatusMessage: string;
  checkDrawioStatus: () => void;
}

function UiButton({ type, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...(props as any)} htmlType={type === "submit" ? "submit" : "button"} />;
}

function formattedTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const pad = (value: number) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
    + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

export default function WorkspacePages(props: Props) {
  const {
    page, messages, chatInput, setChatInput, chatBusy,
    sendIntent, confirmProposal, aiModel, setAiModel, reasoningEffort, setReasoningEffort,
    saveAISettings, clearAISettings, traceEntries, refreshTraces,
    drawioStatus, drawioStatusMessage, checkDrawioStatus
  } = props;
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [showLowLevel, setShowLowLevel] = useState(false);
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");
  const [modelRouting, setModelRouting] = useState<ModelRouting | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const significantTraces = useMemo(() => traceEntries.filter((entry) => !isLowLevelTrace(entry)), [traceEntries]);
  const lowLevelCount = traceEntries.length - significantTraces.length;
  const filteredTraces = useMemo(() => (showLowLevel ? traceEntries : significantTraces).filter((entry) => {
    if (traceFilter === "all") return true;
    if (traceFilter === "error") return entry.level === "error" || entry.level === "warn";
    return entry.event.toLowerCase().includes(traceFilter);
  }), [traceEntries, significantTraces, showLowLevel, traceFilter]);
  const errorCount = traceEntries.filter((entry) => entry.level === "error").length;
  const traceUsageSummary = useMemo(() => {
    const modelCallEntries = traceEntries.filter((entry) => entry.event === "turn.model-call.completed");
    let input = 0, output = 0, total = 0, cachedInput = 0, reasoning = 0, premiumRequestCost = 0, totalNanoAiu = 0;
    let hasInput = false, hasOutput = false, hasTotal = false, hasCachedInput = false, hasReasoning = false, hasPremiumCost = false, hasAiu = false;
    let calls = 0, hasCalls = false, measuredEntries = 0;
    for (const entry of modelCallEntries) {
      const usage = traceTokenUsage(entry);
      if (!usage) continue;
      measuredEntries++;
      if (usage.input !== null) { input += usage.input; hasInput = true; }
      if (usage.output !== null) { output += usage.output; hasOutput = true; }
      if (usage.total !== null) { total += usage.total; hasTotal = true; }
      if (usage.cachedInput !== null) { cachedInput += usage.cachedInput; hasCachedInput = true; }
      if (usage.reasoning !== null) { reasoning += usage.reasoning; hasReasoning = true; }
      if (usage.premiumRequestCost !== null) { premiumRequestCost += usage.premiumRequestCost; hasPremiumCost = true; }
      if (usage.totalNanoAiu !== null) { totalNanoAiu += usage.totalNanoAiu; hasAiu = true; }
      if (usage.calls !== null) { calls += usage.calls; hasCalls = true; }
    }
    if (!measuredEntries) return null;
    return {
      input: hasInput ? input : null, output: hasOutput ? output : null, total: hasTotal ? total : null,
      cachedInput: hasCachedInput ? cachedInput : null, reasoning: hasReasoning ? reasoning : null,
      premiumRequestCost: hasPremiumCost ? premiumRequestCost : null, totalNanoAiu: hasAiu ? totalNanoAiu : null,
      calls: hasCalls ? calls : null, entries: measuredEntries, totalEntries: modelCallEntries.length
    };
  }, [traceEntries]);

  useEffect(() => {
    if (page === "copilot") chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, page]);

  useEffect(() => {
    if (page !== "settings") return;
    let cancelled = false;
    setModelsLoading(true);
    if (modelsRefreshKey > 0) setModelsMessage("Re-reading the SDK model list…");
    fetch("/api/copilot/models" + (modelsRefreshKey > 0 ? "?refresh=1" : ""))
      .then(async (response) => {
        const payload = await response.json() as { models?: Array<{ id?: string; name?: string; label?: string }>; defaultModel?: string; modelRouting?: ModelRouting; error?: string };
        if (!response.ok) throw new Error(payload.error || "The model list request failed");
        if (!cancelled && payload.modelRouting) setModelRouting(payload.modelRouting);
        const options = (payload.models || [])
          .filter((model) => typeof model.id === "string" && model.id.length > 0)
          .map((model) => ({ value: model.id!, label: model.label || model.name || model.id! }));
        if (!cancelled && options.length) {
          const merged = [...options];
          const runtimeDefault = payload.defaultModel?.trim();
          if (runtimeDefault && !merged.some((item) => item.value === runtimeDefault)) {
            merged.unshift({ value: runtimeDefault, label: runtimeDefault + " (runtime default)" });
          }
          if (aiModel && !merged.some((item) => item.value === aiModel)) merged.unshift({ value: aiModel, label: aiModel + " (current)" });
          setModelOptions(merged);
          setModelsMessage("Available models loaded from the local Copilot SDK.");
        } else if (!cancelled) {
          setModelOptions((current) => aiModel && !current.some((item) => item.value === aiModel)
            ? [{ value: aiModel, label: aiModel + " (current)" }, ...current]
            : current);
          setModelsMessage(payload.modelRouting?.mode === "byok"
            ? "The custom provider publishes no model list; the configured model is used for every turn."
            : "The SDK returned no model list yet; the server still uses its configured default model.");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setModelsMessage("Could not read the SDK model list, showing built-in candidates: " + message);
          recordDiagnostic("copilot.models.load.failed", "Could not load the Copilot SDK model list", {
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: message
          }, "warn");
        }
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [page, aiModel, modelsRefreshKey]);

  if (page === "copilot") {
    return (
      <main className="workspace-page copilot-workspace">
        <div className="page-content copilot-page-content">
          <section className="gemini-chat">
            <div className="gemini-chat-scroll">
              {messages.length === 0 && <div className="gemini-welcome">
                <div className="prompt-suggestions">
                  {["Add Audit Service after Database and connect it", "Rename Database to Data Store", "Make Database background red", "Move API Service right by 60"].map((prompt) =>
                    <UiButton type="button" key={prompt} onClick={() => setChatInput(prompt)}>{prompt}<span>↗</span></UiButton>
                  )}
                </div>
              </div>}
              {messages.length > 0 && <div className="gemini-messages" aria-live="polite">
                {messages.map((message) => <article key={message.id} className={"gemini-message " + message.role}>
                  {message.role === "assistant" && <div className="gemini-avatar">✳</div>}
                  <div className="gemini-message-body"><div className="gemini-message-role">{message.role === "assistant" ? "Copilot" : "You"}</div><Bubble content={message.role === "assistant" ? (message.text || (message.proposal ? "A diagram change is ready for review." : " ")) : message.text} placement={message.role === "user" ? "end" : "start"} className="copilot-bubble" />
                    {message.proposal && <div className="proposal-actions"><UiButton type="button" className="button button-primary" disabled={chatBusy} onClick={() => confirmProposal(message.proposal!.id)}>Confirm changes</UiButton><span>Nothing is applied until you confirm. This proposal expires after 10 minutes.</span></div>}
                  </div>
                </article>)}
                <div ref={chatEndRef} />
              </div>}
            </div>

            <div className="gemini-composer antd-composer">
              <Sender value={chatInput} onChange={setChatInput} onSubmit={() => sendIntent()} loading={chatBusy}
                placeholder="Describe the change you want…" autoSize={{ minRows: 2, maxRows: 5 }} submitType="enter" />
              {chatBusy && <div className="gemini-composer-footer"><span><i className="spinner" /> Thinking…</span></div>}
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (page === "traces") {
    return (
      <main className="workspace-page traces-workspace">
        <div className="page-content">
          <div className="page-hero">
            <div><h1>Agent trace</h1></div>
            <div className="page-hero-actions"><UiButton type="button" className="button button-secondary" onClick={() => window.location.reload()}>Reload page</UiButton><UiButton type="button" className="button button-quiet" onClick={refreshTraces}>Refresh trace</UiButton></div>
          </div>

          <div className="trace-toolbar">
            <div className="trace-filters">
              {([["all", "All"], ["copilot", "Copilot"], ["drawio", "Draw.io"], ["error", "Warnings / errors"]] as Array<[TraceFilter, string]>).map(([value, label]) =>
                <UiButton type="button" key={value} className={traceFilter === value ? "active" : ""} onClick={() => setTraceFilter(value)}>{label}</UiButton>
              )}
            </div>
            <button type="button" className={"trace-noise-toggle" + (showLowLevel ? " active" : "")} aria-pressed={showLowLevel} onClick={() => setShowLowLevel(!showLowLevel)}>
              {showLowLevel ? "Hide" : "Show"} low-level events · {lowLevelCount}
            </button>
          </div>

          {traceUsageSummary && <div className="trace-usage-summary">
            <strong>Usage in loaded model-call records</strong>
            {traceUsageSummary.input !== null && <span>Input {formatTokenCount(traceUsageSummary.input)}</span>}
            {traceUsageSummary.output !== null && <span>Output {formatTokenCount(traceUsageSummary.output)}</span>}
            {traceUsageSummary.total !== null && <span>Total {formatTokenCount(traceUsageSummary.total)}</span>}
            {traceUsageSummary.cachedInput !== null && <span>Cached input {formatTokenCount(traceUsageSummary.cachedInput)}</span>}
            {traceUsageSummary.reasoning !== null && <span>Reasoning {formatTokenCount(traceUsageSummary.reasoning)}</span>}
            {traceUsageSummary.premiumRequestCost !== null && <span>Premium request cost {formatUsageAmount(traceUsageSummary.premiumRequestCost)}</span>}
            {traceUsageSummary.totalNanoAiu !== null && <span>nano-AIU {formatUsageAmount(traceUsageSummary.totalNanoAiu)}</span>}
            {traceUsageSummary.calls !== null && <span>{formatTokenCount(traceUsageSummary.calls)} model calls</span>}
            <span>{traceUsageSummary.entries} usage records / {traceUsageSummary.totalEntries} model-call records</span>
          </div>}

          <div className="trace-list">
            {filteredTraces.length ? [...filteredTraces].reverse().map((entry) => {
              const title = traceTitle(entry);
              const usage = traceTokenUsage(entry);
              return (
              <article className={"trace-entry trace-" + entry.level} key={entry.id}>
                <div className="trace-entry-rail"><span /></div>
                <div className="trace-entry-content">
                  <div className="trace-entry-row">
                    <span className={"trace-level level-" + entry.level}>{entry.level.toUpperCase()}</span>
                    <span
                      className={"trace-entry-message" + (title === entry.event ? " is-event" : "")}
                      title={title === entry.event ? title : title + " · " + entry.event}
                    >{title}</span>
                    {usage && <code title="Reported by the model provider; absent metrics are not estimated">{usage.input !== null || usage.output !== null ? `tokens ${usage.input === null ? "—" : formatTokenCount(usage.input)} in / ${usage.output === null ? "—" : formatTokenCount(usage.output)} out` : "usage recorded"}</code>}
                    <time dateTime={entry.timestamp}>{formattedTime(entry.timestamp)}</time>
                    <button
                      type="button"
                      className={"trace-entry-toggle" + (expandedTraceId === entry.id ? " open" : "")}
                      aria-expanded={expandedTraceId === entry.id}
                      aria-label={expandedTraceId === entry.id ? "Hide event details" : "Show event details"}
                      title={expandedTraceId === entry.id ? "Hide event details" : "Show event details"}
                      onClick={() => setExpandedTraceId(expandedTraceId === entry.id ? null : entry.id)}
                    >›</button>
                  </div>
                  {expandedTraceId === entry.id && <div className="trace-entry-details-content">
                        <div className="trace-entry-meta"><span>Event</span><code>{entry.event}</code><span>Level</span><code>{entry.level}</code></div>
                        {usage && <div className="trace-entry-meta trace-usage-details">
                          {usage.input !== null && <><span>Input tokens</span><code>{formatTokenCount(usage.input)}</code></>}
                          {usage.output !== null && <><span>Output tokens</span><code>{formatTokenCount(usage.output)}</code></>}
                          {usage.total !== null && <><span>Total tokens</span><code>{formatTokenCount(usage.total)}</code></>}
                          {usage.calls !== null && <><span>Model calls</span><code>{usage.calls}</code></>}
                          {usage.cachedInput !== null && <><span>Cached input</span><code>{formatTokenCount(usage.cachedInput)}</code></>}
                          {usage.cacheWrite !== null && <><span>Cache write</span><code>{formatTokenCount(usage.cacheWrite)}</code></>}
                          {usage.reasoning !== null && <><span>Reasoning tokens</span><code>{formatTokenCount(usage.reasoning)}</code></>}
                          {usage.premiumRequestCost !== null && <><span>Premium request cost</span><code>{formatUsageAmount(usage.premiumRequestCost)}</code></>}
                          {usage.totalNanoAiu !== null && <><span>Total nano-AIU</span><code>{formatUsageAmount(usage.totalNanoAiu)}</code></>}
                        </div>}
                        {traceContextUsage(entry) && <div className="trace-entry-meta trace-context-usage">
                          <strong>Context window</strong>
                          {traceContextUsage(entry)!.currentTokens !== null && <><span>Current tokens</span><code>{formatTokenCount(traceContextUsage(entry)!.currentTokens!)}</code></>}
                          {traceContextUsage(entry)!.tokenLimit !== null && <><span>Limit</span><code>{formatTokenCount(traceContextUsage(entry)!.tokenLimit!)}</code></>}
                          {traceContextUsage(entry)!.percent !== null && <><span>Occupied</span><code>{traceContextUsage(entry)!.percent}%</code></>}
                          {traceContextUsage(entry)!.messagesLength !== null && <><span>Messages</span><code>{formatTokenCount(traceContextUsage(entry)!.messagesLength!)}</code></>}
                        </div>}
                        {typeof entry.details.requestPrompt === "string" && <>
                          <strong>Request prompt</strong>
                          <pre className="trace-entry-details">{entry.details.requestPrompt}</pre>
                        </>}
                        {typeof entry.details.responseText === "string" && <>
                          <strong>Model response</strong>
                          <pre className="trace-entry-details">{entry.details.responseText || "(empty response text)"}</pre>
                        </>}
                        {entry.details.response !== undefined && <>
                          <strong>Raw response</strong>
                          <pre className="trace-entry-details">{JSON.stringify(entry.details.response, null, 2)}</pre>
                        </>}
                        <strong>All event details</strong>
                        <pre className="trace-entry-details">{JSON.stringify(entry.details, null, 2)}</pre>
                      </div>}
                </div>
              </article>
              );
            }) : <div className="trace-empty"><div className="trace-empty-icon">◎</div><h2>No matching events</h2><p>Copilot turns, native cell edits, saves and errors appear here automatically. Low-level Draw.io handshake noise stays hidden until you ask for it.</p>{traceFilter !== "all" && <UiButton type="button" className="button button-secondary" onClick={() => setTraceFilter("all")}>Show all events</UiButton>}</div>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="workspace-page settings-workspace">
      <div className="page-content">
        <div className="page-hero">
          <div><h1>Settings</h1></div>
        </div>

        <div className="settings-grid">

          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon">✳</div><div><h2>GitHub Copilot SDK / Agent Runtime</h2><p>Server-side Copilot CLI runtime using the signed-in GitHub Copilot identity</p></div></div>
            <div className="settings-status-line"><span className={"settings-status-dot " + (aiModel.trim() ? "status-ready" : "status-unknown")} /><strong>{aiModel.trim() ? "Agent mode configured" : "Using server default model"}</strong></div>
            <label className="settings-field">Default model
              <Select showSearch optionFilterProp="label" value={aiModel || undefined} options={modelOptions} loading={modelsLoading} onChange={(value) => setAiModel(value)} placeholder="Select a model (leave empty to use server default)" style={{ width: "100%" }} />
            </label>
            <p className="settings-description">{modelsMessage || "Options come from the local Copilot SDK; the server's configured model is used when nothing is selected."}</p>
            {modelRouting && (
              <p className={"settings-description settings-routing" + (modelRouting.modelConfiguredWithoutProvider ? " settings-routing-warning" : "")}>
                {modelRouting.modelConfiguredWithoutProvider
                  ? "Custom model " + (modelRouting.configuredModel || "") + " is configured, but no provider serves it: COPILOT_PROVIDER_BASE_URL is not set, so every turn runs on a GitHub-hosted model instead."
                  : modelRouting.summary || ""}
              </p>
            )}
            <label className="settings-field">Thinking effort
              <Select value={reasoningEffort} onChange={(value: "low" | "medium" | "high" | "max") => setReasoningEffort(value)} options={[{ value: "medium", label: "Medium — balanced speed and reasoning (default)" }, { value: "low", label: "Low — faster for simple edits" }, { value: "high", label: "High — complex edits" }, { value: "max", label: "Max — highest reasoning effort" }]} style={{ width: "100%" }} />
            </label>
            <p className="settings-description">Passed to the Copilot SDK as reasoningEffort. Medium is the default for routine diagram edits; use High/Max for complex transformations. The server maps the requested level to capabilities advertised by the selected model.</p>
            <div className="settings-security-note"><strong>Agent capabilities and boundaries</strong><span>The agent uses typed operations for common edits and run_drawio_script for full native Draw.io API access. Scripts run in a separate-origin sandboxed iframe, not in Node.js; this is browser-origin isolation, not an OS-level sandbox. Use trusted local model providers for sensitive diagrams. The browser accepts changes only after native XML serialization and save/version acknowledgement. Model credentials never pass through the browser.</span></div>
            <div className="settings-card-actions"><UiButton type="button" className="button button-quiet" onClick={() => setModelsRefreshKey((key) => key + 1)}>Reload models</UiButton><UiButton type="button" className="button button-quiet" onClick={clearAISettings}>Clear model settings</UiButton><UiButton type="button" className="button button-primary" onClick={saveAISettings}>Save settings</UiButton></div>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon drawio-icon">D</div><div><h2>Native Draw.io</h2><p>Pinned version, local static assets, same-origin embed protocol</p></div></div>
            <div className="settings-status-line"><span className={"settings-status-dot status-" + drawioStatus} /><strong>{drawioStatus === "ready" ? "Local assets available" : drawioStatus === "checking" ? "Checking…" : drawioStatus === "missing" ? "Assets missing or checksum mismatch" : drawioStatus === "error" ? "Check failed" : "Not checked yet"}</strong></div>
            <p className="settings-description">{drawioStatusMessage || "Checks the response status, version manifest, and SHA-256 of /drawio/studio-bundle.json and /drawio/index.html."}</p>
            <UiButton type="button" className="button button-secondary" onClick={checkDrawioStatus} disabled={drawioStatus === "checking"}>{drawioStatus === "checking" ? "Checking…" : "Check local Draw.io"}</UiButton>
            <div className="settings-terminal-note"><strong>Stuck on Loading…</strong><span>Turn on “Show low-level events” on the Agent trace page and look at drawio.handshake.* and drawio.init.timeout first, then at the [studio:v2] JSON output in the terminal that started the dev server. No document XML is sent before initialisation succeeds.</span></div>
          </section>

          <section className="settings-card settings-logs-card">
            <div className="settings-card-heading"><div className="settings-card-icon">⌘</div><div><h2>Terminal output and diagnostics</h2><p>Browser events → local server terminal → local trace page</p></div></div>
            <p className="settings-description"><code>npm run dev</code> starts Vite and the Copilot SDK agent service together. Browser diagnostics never store full prompts, credentials, or raw XML; the server-side Copilot audit log keeps user requests, diagram context summaries, and tool events. Treat the local audit log as data that may contain sensitive project details.</p>
            <div className="terminal-example"><span>TERMINAL</span><code>[studio:ERROR] [studio:v2] receivedAt=… level=error event=drawio.document.load.failed</code></div>
            <div className="settings-card-actions"><span className="settings-trace-count">{traceEntries.length} local events · {errorCount} errors</span></div>
          </section>
        </div>
      </div>
    </main>
  );
}
