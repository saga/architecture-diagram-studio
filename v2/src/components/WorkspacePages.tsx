import { useEffect, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import { Bubble, Sender } from "@ant-design/x";
import { Button, Checkbox, Input, Select } from "antd";
import type { DiagramDocument } from "../model/types";
import { LAYOUT_PROFILES } from "../layout/profiles";
import type { DiagnosticEntry } from "../diagnostics";


type PromptKey = "system" | "task" | "planTool" | "behavior" | "workspace" | "supportedCommands" | "toolDescription" | "toolResult";
type StudioConfig = { layoutProfiles: string[]; prompts: Record<PromptKey, string>; updatedAt: string; updatedBy?: string };
const PROMPT_OPTIONS: Array<{ key: PromptKey; label: string; description: string }> = [
  { key: "system", label: "System Prompt", description: "Defines the overall role and scope of the Copilot." },
  { key: "task", label: "Task Prompt", description: "Defines the planning goal, level of detail, and output expectations for every request." },
  { key: "planTool", label: "Plan Tool Prompt", description: "Explains when and how to call the structured plan tool." },
  { key: "behavior", label: "Behaviour and Safety Rules", description: "Controls allowed actions, preview confirmation, and handling of untrusted context." },
  { key: "workspace", label: "Workspace Context Prompt", description: "Supports the {{workspaceName}}, {{rootPath}}, and {{primaryDiagram}} runtime placeholders." },
  { key: "supportedCommands", label: "Supported Commands Prompt", description: "Supports the {{commands}} placeholder, filled with the command list the server allows." },
  { key: "toolDescription", label: "Tool Description", description: "The propose_layout_plan tool description sent to the model." },
  { key: "toolResult", label: "Tool Result Prompt", description: "The acknowledgement the plan tool returns to the model." }
];
const PROFILE_OPTIONS = LAYOUT_PROFILES.map(({ value, label }) => ({ value, label }));
function ConfigurationEditor({ onLayoutProfilesChanged }: { onLayoutProfilesChanged: (profiles: string[]) => void }) {
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [revisions, setRevisions] = useState(0);
  const [history, setHistory] = useState<Array<{revisionId:string;updatedAt:string;changeSummary:string}>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = async () => {
    const response = await fetch("/api/workspace/configuration");
    const payload = await response.json() as {config?:StudioConfig;revisions?:number;error?:string};
    if (!response.ok || !payload.config) throw new Error(payload.error || "Could not load the configuration");
    setConfig(payload.config); setRevisions(payload.revisions || 0);
    const h = await fetch("/api/workspace/configuration/history");
    if (h.ok) { const hp = await h.json() as {revisions?:Array<{revisionId:string;updatedAt:string;changeSummary:string}>}; setHistory((hp.revisions || []).slice(-8).reverse()); }
  };
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : String(error))); }, []);
  const save = async () => {
    if (!config) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/workspace/configuration", {method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({config:{layoutProfiles:config.layoutProfiles,prompts:config.prompts}})});
      const payload = await response.json() as {config?:StudioConfig;error?:string};
      if (!response.ok || !payload.config) throw new Error(payload.error || "Saving failed");
      setConfig(payload.config); onLayoutProfilesChanged(payload.config.layoutProfiles); setMessage("Configuration saved and appended to the server-side JSONL history"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!config) return <section className="settings-card"><h2>Layout engines and Copilot prompts</h2><p>{message || "Loading the server configuration…"}</p></section>;
  return <section className="settings-card settings-logs-card">
    <div className="settings-card-heading"><div className="settings-card-icon">⚙</div><div><h2>Layout engines and Copilot prompts</h2><p>Served from one server-side configuration; every save appends an immutable JSONL revision.</p></div></div>
    <strong>Allowed layout engines</strong>
    <div className="settings-field">
      {PROFILE_OPTIONS.map((option) => <Checkbox key={option.value} className="settings-checkbox" checked={config.layoutProfiles.includes(option.value)} onChange={(event) => setConfig({...config,layoutProfiles:event.target.checked?[...config.layoutProfiles,option.value]:config.layoutProfiles.filter((p)=>p!==option.value)})}>{option.label}</Checkbox>)}
    </div>
    <p className="settings-description">This list controls which layout engines the server may run. Layout settings already stored in a document are never rewritten silently.</p>
    <div className="settings-prompt-list">
      {PROMPT_OPTIONS.map(({ key, label, description }) => <label className="settings-field" key={key}>
        <strong>{label}</strong>
        <span className="settings-description">{description}</span>
        <Input.TextArea className="text-field" rows={5} value={config.prompts[key]} onChange={(event)=>setConfig({...config,prompts:{...config.prompts,[key]:event.target.value}})} />
      </label>)}
    </div>
    <div className="settings-card-actions"><span className="settings-trace-count">{revisions} revisions</span><UiButton type="button" className="button button-primary" disabled={busy || !config.layoutProfiles.length} onClick={()=>void save()}>{busy ? "Saving…" : "Save and create revision"}</UiButton></div>
    {message && <p className="settings-description">{message}</p>}
    {history.length > 0 && <div className="settings-terminal-note"><strong>Recent revisions</strong>{history.map((item)=><span key={item.revisionId}>{new Date(item.updatedAt).toLocaleString()} · {item.changeSummary || item.revisionId}</span>)}</div>}
  </section>;
}


export type WorkspacePage = "diagram" | "copilot" | "traces" | "settings";
type TraceFilter = "all" | "copilot" | "layout" | "drawio" | "error";

/**
 * Bookkeeping events that fire constantly and never explain what the agent did.
 * They stay one click away behind "Show low-level events"; warnings and errors are
 * never treated as low-level, so a broken handshake is still visible by default.
 */
const LOW_LEVEL_EVENT_PREFIXES = ["drawio.message.", "drawio.bundle.check.", "drawio.handshake.", "ui.theme."];
const LOW_LEVEL_EVENTS = new Set([
  "app.started",
  "workspace.hydrated",
  "navigation.opened",
  "models.empty",
  "trace.refreshed",
  "diagram.relation.selected",
  "drawio.iframe.loaded",
  "drawio.bridge.ready",
  "drawio.plugin.bridge.ready",
  "drawio.document.load.sent"
]);

function isLowLevelTrace(entry: DiagnosticEntry): boolean {
  if (entry.level === "error" || entry.level === "warn") return false;
  // Server-side runtime logs carry no human message; the endpoint copies the event id into
  // `message`, which is exactly the row that used to read the same thing twice.
  if (entry.message === entry.event) return true;
  if (LOW_LEVEL_EVENTS.has(entry.event)) return true;
  return LOW_LEVEL_EVENT_PREFIXES.some((prefix) => entry.event.startsWith(prefix));
}

/** Server logs have no prose, so fall back to the first meaningful detail instead of repeating the event id. */
function traceTitle(entry: DiagnosticEntry): string {
  if (entry.message && entry.message !== entry.event) return entry.message;
  for (const key of ["errorMessage", "error", "note", "reason", "message"]) {
    const value = entry.details[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 240);
  }
  return entry.event;
}

type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type DrawioStatus = "unknown" | "checking" | "ready" | "missing" | "error";

interface Props {
  page: Exclude<WorkspacePage, "diagram">;
  document: DiagramDocument;
  previewDocument: DiagramDocument | null;
  previewSummary: string;
  messages: ChatMessage[];
  chatInput: string;
  setChatInput: (value: string) => void;
  chatBusy: boolean;
  sendIntent: () => void;
  acceptPreview: () => void;
  discardPreview: () => void;
  openDiagram: () => void;
  aiBaseUrl: string;
  setAiBaseUrl: (value: string) => void;
  aiModel: string;
  setAiModel: (value: string) => void;
  reasoningEffort: "high" | "max";
  setReasoningEffort: (value: "high" | "max") => void;
  aiApiKey: string;
  setAiApiKey: (value: string) => void;
  saveAISettings: () => void;
  clearAISettings: () => void;
  traceEntries: DiagnosticEntry[];
  refreshTraces: () => void;
  drawioStatus: DrawioStatus;
  drawioStatusMessage: string;
  checkDrawioStatus: () => void;
  onLayoutProfilesChanged: (profiles: string[]) => void;
}

/** Ant Design Button adapter retaining existing semantic HTML button attributes. */
function UiButton({ type, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...(props as any)} htmlType={type === "submit" ? "submit" : "button"} />;
}

function formattedTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export default function WorkspacePages(props: Props) {
  const {
    page, previewDocument, previewSummary, messages, chatInput, setChatInput, chatBusy,
    sendIntent, acceptPreview, discardPreview, openDiagram, aiModel, setAiModel, reasoningEffort, setReasoningEffort,
    saveAISettings, clearAISettings, traceEntries, refreshTraces,
    drawioStatus, drawioStatusMessage, checkDrawioStatus
  } = props;
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [showLowLevel, setShowLowLevel] = useState(false);
  const [expandedTraceId, setExpandedTraceId] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([
    { value: "claude-sonnet-5.5", label: "Claude Sonnet 5.5 (default)" },
    { value: "gpt-5", label: "GPT-5" }
  ]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const significantTraces = useMemo(() => traceEntries.filter((entry) => !isLowLevelTrace(entry)), [traceEntries]);
  const lowLevelCount = traceEntries.length - significantTraces.length;
  const filteredTraces = useMemo(() => (showLowLevel ? traceEntries : significantTraces).filter((entry) => {
    if (traceFilter === "all") return true;
    if (traceFilter === "error") return entry.level === "error" || entry.level === "warn";
    return entry.event.toLowerCase().includes(traceFilter);
  }), [traceEntries, significantTraces, showLowLevel, traceFilter]);
  const errorCount = traceEntries.filter((entry) => entry.level === "error").length;

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
        const payload = await response.json() as { models?: Array<{ id?: string; name?: string; label?: string }>; error?: string };
        if (!response.ok) throw new Error(payload.error || "The model list request failed");
        const options = (payload.models || [])
          .filter((model) => typeof model.id === "string" && model.id.length > 0)
          .map((model) => ({ value: model.id!, label: model.label || model.name || model.id! }));
        if (!cancelled && options.length) {
          const merged = [...options];
          if (!merged.some((item) => item.value === "claude-sonnet-5.5")) merged.unshift({ value: "claude-sonnet-5.5", label: "Claude Sonnet 5.5 (default)" });
          if (aiModel && !merged.some((item) => item.value === aiModel)) merged.unshift({ value: aiModel, label: aiModel + " (current)" });
          setModelOptions(merged);
          setModelsMessage("Available models loaded from the local Copilot SDK.");
        } else if (!cancelled) {
          setModelOptions((current) => aiModel && !current.some((item) => item.value === aiModel)
            ? [{ value: aiModel, label: aiModel + " (current)" }, ...current]
            : current);
          setModelsMessage("The SDK returned no model list yet; built-in candidates are shown.");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setModelsMessage("Could not read the SDK model list, showing built-in candidates: " + (error instanceof Error ? error.message : String(error)));
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
                  {["Put all external systems on the right", "Move databases and storage to the bottom", "Make all relations dashed", "Change curves to polylines"].map((prompt) =>
                    <UiButton type="button" key={prompt} onClick={() => setChatInput(prompt)}>{prompt}<span>↗</span></UiButton>
                  )}
                </div>
              </div>}
              {messages.length > 0 && <div className="gemini-messages" aria-live="polite">
                {messages.map((message) => <article key={message.id} className={"gemini-message " + message.role}>
                  {message.role === "assistant" && <div className="gemini-avatar">✳</div>}
                  <div className="gemini-message-body"><div className="gemini-message-role">{message.role === "assistant" ? "Layout Copilot" : "You"}</div><Bubble content={message.text} placement={message.role === "user" ? "end" : "start"} className="copilot-bubble" /></div>
                </article>)}
                <div ref={chatEndRef} />
              </div>}
            </div>

            {previewDocument && <div className="preview-actions copilot-preview-actions">
              <div className="preview-pill">Layout preview · not applied</div>
              <div className="preview-summary">{previewSummary || "Layout preview generated"}</div>
              <div className="preview-buttons">
                <Button onClick={discardPreview}>Discard preview</Button>
                <Button onClick={openDiagram}>Inspect on the diagram canvas</Button>
                <Button type="primary" onClick={acceptPreview}>Apply to the document</Button>
              </div>
            </div>}

            <div className="gemini-composer antd-composer">
              <Sender value={chatInput} onChange={setChatInput} onSubmit={() => sendIntent()} loading={chatBusy}
                disabled={Boolean(previewDocument)} placeholder="Describe the layout change you want…" autoSize={{ minRows: 2, maxRows: 5 }} submitType="enter" />
              {chatBusy && <div className="gemini-composer-footer"><span><i className="spinner" /> Analysing the layout request…</span></div>}
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
              {([["all", "All"], ["copilot", "Copilot"], ["layout", "Layout"], ["drawio", "Draw.io"], ["error", "Warnings / errors"]] as Array<[TraceFilter, string]>).map(([value, label]) =>
                <UiButton type="button" key={value} className={traceFilter === value ? "active" : ""} onClick={() => setTraceFilter(value)}>{label}</UiButton>
              )}
            </div>
            <button type="button" className={"trace-noise-toggle" + (showLowLevel ? " active" : "")} aria-pressed={showLowLevel} onClick={() => setShowLowLevel(!showLowLevel)}>
              {showLowLevel ? "Hide" : "Show"} low-level events · {lowLevelCount}
            </button>
          </div>

          <div className="trace-list">
            {filteredTraces.length ? [...filteredTraces].reverse().map((entry) => {
              const title = traceTitle(entry);
              return (
              <article className={"trace-entry trace-" + entry.level} key={entry.id}>
                <div className="trace-entry-rail"><span /></div>
                <div className="trace-entry-content">
                  <div className="trace-entry-row">
                    <span className={"trace-level level-" + entry.level}>{entry.level.toUpperCase()}</span>
                    <span className={"trace-entry-message" + (title === entry.event ? " is-event" : "")} title={title}>{title}</span>
                    {title !== entry.event && <code>{entry.event}</code>}
                    <time>{formattedTime(entry.timestamp)}</time>
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
            }) : <div className="trace-empty"><div className="trace-empty-icon">◎</div><h2>No matching events</h2><p>Copilot turns, layout runs, saves and errors appear here automatically. Low-level Draw.io handshake noise stays hidden until you ask for it.</p>{traceFilter !== "all" && <UiButton type="button" className="button button-secondary" onClick={() => setTraceFilter("all")}>Show all events</UiButton>}</div>}
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
          <ConfigurationEditor onLayoutProfilesChanged={props.onLayoutProfilesChanged} />

          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon">✳</div><div><h2>GitHub Copilot SDK / Agent Runtime</h2><p>Server-side Copilot CLI runtime using the signed-in GitHub Copilot identity</p></div></div>
            <div className="settings-status-line"><span className={"settings-status-dot " + (aiModel.trim() ? "status-ready" : "status-unknown")} /><strong>{aiModel.trim() ? "Agent mode configured" : "Using local rules"}</strong></div>
            <label className="settings-field">Default model
              <Select
                showSearch
                optionFilterProp="label"
                value={aiModel || undefined}
                options={modelOptions}
                loading={modelsLoading}
                onChange={(value) => setAiModel(value)}
                placeholder="Select a model (leave empty for local rules)"
                style={{ width: "100%" }}
              />
            </label>
            <p className="settings-description">{modelsMessage || "Defaults to Claude Sonnet 5.5; options come from the local Copilot SDK when available."}</p>
            <label className="settings-field">Thinking effort
              <Select value={reasoningEffort} onChange={(value: "high" | "max") => setReasoningEffort(value)} options={[{ value: "max", label: "Max — highest reasoning effort (default)" }, { value: "high", label: "High — high reasoning effort" }]} style={{ width: "100%" }} />
            </label>
            <p className="settings-description">Passed to the Copilot SDK as reasoningEffort. It only applies when the selected model supports that level; the server falls back to a compatible level based on the SDK model capabilities.</p>
            <div className="settings-security-note"><strong>Agent capabilities and boundaries</strong><span>The server creates sessions through @github/copilot-sdk and requires the agent to submit a structured plan via the propose_layout_plan tool. Model credentials never pass through the browser; the service uses the local, signed-in Copilot CLI. The agent may only propose whitelisted layout commands — it cannot execute arbitrary code or write to the diagram. A plan that passes validation is still previewed in Studio and applied only after you confirm.</span></div>
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
            <div className="settings-card-heading"><div className="settings-card-icon">⌘</div><div><h2>Terminal output and diagnostics</h2><p>Browser events → Vite dev terminal → local trace page</p></div></div>
            <p className="settings-description"><code>npm run dev</code> starts Vite and the Copilot SDK agent service together. Browser diagnostics never store full prompts, credentials, or raw XML; the server-side Copilot audit log keeps user requests, diagram context summaries, and tool events. Treat the local audit log as data that may contain sensitive project details.</p>
            <div className="terminal-example"><span>TERMINAL</span><code>[studio:v2] receivedAt=… level=info event=layout.run.completed durationMs=…</code></div>
            <div className="settings-card-actions"><span className="settings-trace-count">{traceEntries.length} local events · {errorCount} errors</span></div>
          </section>
        </div>
      </div>
    </main>
  );
}
