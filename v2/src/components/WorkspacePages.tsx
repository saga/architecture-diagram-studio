import { useEffect, useMemo, useRef, useState } from "react";
import type { ButtonHTMLAttributes } from "react";
import { Bubble, Sender } from "@ant-design/x";
import { Button, Select, Tag } from "antd";
import type { DiagramDocument } from "../model/types";
import { LAYOUT_PROFILES } from "../layout/profiles";
import type { DiagnosticEntry } from "../diagnostics";


type PromptKey = "system" | "task" | "planTool" | "behavior" | "workspace" | "supportedCommands" | "toolDescription" | "toolResult";
type StudioConfig = { layoutProfiles: string[]; prompts: Record<PromptKey, string>; updatedAt: string; updatedBy?: string };
const PROMPT_OPTIONS: Array<{ key: PromptKey; label: string; description: string }> = [
  { key: "system", label: "System Prompt", description: "定义 Copilot 的总体角色和任务范围。" },
  { key: "task", label: "任务规划 Prompt", description: "定义每次请求的规划目标、详细程度和输出要求。" },
  { key: "planTool", label: "计划工具 Prompt", description: "说明何时以及如何调用结构化计划工具。" },
  { key: "behavior", label: "行为约束与安全规则", description: "控制允许执行的行为、预览确认和不可信上下文处理。" },
  { key: "workspace", label: "工作区上下文 Prompt", description: "支持 {{workspaceName}}、{{rootPath}}、{{primaryDiagram}} 三个运行时占位符。" },
  { key: "supportedCommands", label: "支持的命令 Prompt", description: "支持 {{commands}} 占位符，运行时会填入服务端允许的命令列表。" },
  { key: "toolDescription", label: "结构化工具描述", description: "发送给模型的 propose_layout_plan 工具说明。" },
  { key: "toolResult", label: "工具执行结果 Prompt", description: "结构化计划工具返回给模型的说明。" }
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
    if (!response.ok || !payload.config) throw new Error(payload.error || "读取配置失败");
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
      if (!response.ok || !payload.config) throw new Error(payload.error || "保存失败");
      setConfig(payload.config); onLayoutProfilesChanged(payload.config.layoutProfiles); setMessage("配置已保存并追加到服务端 JSONL 版本历史"); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  if (!config) return <section className="settings-card"><h2>布局算法与 Copilot Prompt</h2><p>{message || "正在读取服务端配置…"}</p></section>;
  return <section className="settings-card settings-logs-card">
    <div className="settings-card-heading"><div className="settings-card-icon">⚙</div><div><h2>布局算法与 Copilot Prompt</h2><p>服务端统一配置；每次保存都会追加不可覆盖的 JSONL 版本记录。</p></div></div>
    <strong>自动布局算法白名单</strong>
    <div className="settings-field">
      {PROFILE_OPTIONS.map((option) => <label key={option.value} style={{display:"flex",gap:8,alignItems:"center",padding:"5px 0"}}><input type="checkbox" checked={config.layoutProfiles.includes(option.value)} onChange={(event) => setConfig({...config,layoutProfiles:event.target.checked?[...config.layoutProfiles,option.value]:config.layoutProfiles.filter((p)=>p!==option.value)})}/>{option.label}</label>)}
    </div>
    <p className="settings-description">此列表控制服务端允许执行的布局算法；文档原有布局配置不会被静默改写。</p>
    <div className="settings-prompt-list">
      {PROMPT_OPTIONS.map(({ key, label, description }) => <label className="settings-field" key={key}>
        <strong>{label}</strong>
        <span className="settings-description">{description}</span>
        <textarea rows={5} value={config.prompts[key]} onChange={(event)=>setConfig({...config,prompts:{...config.prompts,[key]:event.target.value}})} />
      </label>)}
    </div>
    <div className="settings-card-actions"><span className="settings-trace-count">{revisions} 个历史版本</span><UiButton type="button" className="button button-primary" disabled={busy || !config.layoutProfiles.length} onClick={()=>void save()}>{busy?"保存中…":"保存并创建版本"}</UiButton></div>
    {message && <p className="settings-description">{message}</p>}
    {history.length > 0 && <div className="settings-terminal-note"><strong>最近配置版本</strong>{history.map((item)=><span key={item.revisionId}>{new Date(item.updatedAt).toLocaleString()} · {item.changeSummary || item.revisionId}</span>)}</div>}
  </section>;
}


export type WorkspacePage = "studio" | "copilot" | "traces" | "settings";
type TraceFilter = "all" | "copilot" | "layout" | "drawio" | "error";
type ChatMessage = { role: "assistant" | "user"; text: string; id: number };
type DrawioStatus = "unknown" | "checking" | "ready" | "missing" | "error";

interface Props {
  page: Exclude<WorkspacePage, "studio">;
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
  openStudio: () => void;
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
    page, document, previewDocument, previewSummary, messages, chatInput, setChatInput, chatBusy,
    sendIntent, acceptPreview, discardPreview, openStudio, aiModel, setAiModel, reasoningEffort, setReasoningEffort,
    saveAISettings, clearAISettings, traceEntries, refreshTraces,
    drawioStatus, drawioStatusMessage, checkDrawioStatus
  } = props;
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<Array<{ value: string; label: string }>>([
    { value: "claude-sonnet-5.5", label: "Claude Sonnet 5.5 (默认)" },
    { value: "gpt-5", label: "GPT-5" }
  ]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("");
  const filteredTraces = useMemo(() => traceEntries.filter((entry) => {
    if (traceFilter === "all") return true;
    if (traceFilter === "error") return entry.level === "error" || entry.level === "warn";
    return entry.event.toLowerCase().includes(traceFilter);
  }), [traceEntries, traceFilter]);
  const errorCount = traceEntries.filter((entry) => entry.level === "error").length;
  const copilotCount = traceEntries.filter((entry) => entry.event.toLowerCase().includes("copilot")).length;
  const layoutCount = traceEntries.filter((entry) => entry.event.toLowerCase().includes("layout")).length;

  useEffect(() => {
    if (page === "copilot") chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, page]);

  useEffect(() => {
    if (page !== "settings") return;
    let cancelled = false;
    setModelsLoading(true);
    fetch("/api/copilot/models")
      .then(async (response) => {
        const payload = await response.json() as { models?: Array<{ id?: string; name?: string; label?: string }>; error?: string };
        if (!response.ok) throw new Error(payload.error || "模型列表请求失败");
        const options = (payload.models || [])
          .filter((model) => typeof model.id === "string" && model.id.length > 0)
          .map((model) => ({ value: model.id!, label: model.label || model.name || model.id! }));
        if (!cancelled && options.length) {
          const merged = [...options];
          if (!merged.some((item) => item.value === "claude-sonnet-5.5")) merged.unshift({ value: "claude-sonnet-5.5", label: "Claude Sonnet 5.5（默认）" });
          if (aiModel && !merged.some((item) => item.value === aiModel)) merged.unshift({ value: aiModel, label: aiModel + "（当前选择）" });
          setModelOptions(merged);
          setModelsMessage("已从本机 Copilot SDK 获取可用模型。");
        } else if (!cancelled) {
          setModelOptions((current) => aiModel && !current.some((item) => item.value === aiModel)
            ? [{ value: aiModel, label: aiModel + "（当前选择）" }, ...current]
            : current);
          setModelsMessage("SDK 暂未返回模型列表，可使用内置候选项。");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setModelsMessage("无法读取 SDK 模型列表，显示内置候选项：" + (error instanceof Error ? error.message : String(error)));
      })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [page, aiModel]);

  if (page === "copilot") {
    return (
      <main className="workspace-page copilot-workspace">
        <div className="page-content copilot-page-content">
          <div className="page-hero copilot-page-hero">
            <div>
              <div className="page-eyebrow">LAYOUT COPILOT / SEMANTIC WORKFLOW</div>
              <h1>问问 Layout Copilot</h1>
              <p>当前文档：{document.title}。用自然语言说明希望如何组织图形。Copilot 将请求转换为受限布局指令；修改先以预览呈现，确认后才写入正式文档。</p>
            </div>
            <div className="page-hero-status"><i /><Tag color={aiModel.trim() ? "processing" : "default"}>{aiModel.trim() ? "GitHub Copilot SDK Agent" : "本地规则模式"}</Tag></div>
          </div>

          <section className="gemini-chat">
            <div className="gemini-chat-scroll">
              <div className="gemini-welcome">
                <div className="gemini-spark">✳</div>
                <h2>这张图，想怎么调整？</h2>
                <p>例如：把所有 external 移到右侧；数据库放到底部；所有连线改成直角折线。</p>
                <div className="prompt-suggestions">
                  {["把所有 external 放到右侧", "把数据库和存储放到底部", "所有关系线改成虚线", "把曲线改成折线"].map((prompt) =>
                    <UiButton type="button" key={prompt} onClick={() => setChatInput(prompt)}>{prompt}<span>↗</span></UiButton>
                  )}
                </div>
              </div>
              <div className="gemini-messages" aria-live="polite">
                {messages.map((message) => <article key={message.id} className={"gemini-message " + message.role}>
                  {message.role === "assistant" && <div className="gemini-avatar">✳</div>}
                  <div className="gemini-message-body"><div className="gemini-message-role">{message.role === "assistant" ? "Layout Copilot" : "你"}</div><Bubble content={message.text} placement={message.role === "user" ? "end" : "start"} className="copilot-bubble" /></div>
                </article>)}
                <div ref={chatEndRef} />
              </div>
            </div>

            {previewDocument && <div className="preview-actions copilot-preview-actions">
              <div className="preview-pill">布局预览 · 未应用</div>
              <div className="preview-summary">{previewSummary || "布局预览已生成"}</div>
              <div className="preview-buttons">
                <Button onClick={discardPreview}>丢弃预览</Button>
                <Button onClick={openStudio}>到 Studio 画布检查</Button>
                <Button type="primary" onClick={acceptPreview}>应用到正式图</Button>
              </div>
            </div>}

            <div className="gemini-composer antd-composer">
              <Sender value={chatInput} onChange={setChatInput} onSubmit={() => sendIntent()} loading={chatBusy}
                disabled={Boolean(previewDocument)} placeholder="描述希望的布局变化…" autoSize={{ minRows: 2, maxRows: 5 }} submitType="enter" />
              <div className="gemini-composer-footer">
                <span>{chatBusy ? <><i className="spinner" /> 正在分析布局意图…</> : "Enter 发送 · Shift + Enter 换行"}</span>
              </div>
            </div>
            <div className="gemini-privacy-note">通过本地 Copilot SDK Agent 生成受限布局计划；Agent 不能直接修改图形。坐标由本地布局器计算，所有变更都先预览，再由你确认应用。</div>
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
            <div><div className="page-eyebrow">OBSERVABILITY / LOCAL SESSION</div><h1>Agent 轨迹</h1>
              <p>记录布局意图请求、模型返回、预览/应用、布局器、Draw.io 初始化、导入导出和运行时异常。事件保存在当前浏览器中，并在开发模式下同步输出到终端。</p>
            </div>
            <div className="page-hero-actions"><UiButton type="button" className="button button-secondary" onClick={() => window.location.reload()}>刷新页面</UiButton><UiButton type="button" className="button button-quiet" onClick={refreshTraces}>刷新轨迹</UiButton></div>
          </div>

          <div className="trace-metrics">
            <div><span>全部事件</span><strong>{traceEntries.length}</strong><small>服务端与浏览器事件</small></div>
            <div><span>Copilot 阶段</span><strong>{copilotCount}</strong><small>请求、解析与执行结果</small></div>
            <div><span>布局阶段</span><strong>{layoutCount}</strong><small>布局开始、结束和失败</small></div>
            <div className={errorCount ? "has-errors" : ""}><span>错误事件</span><strong>{errorCount}</strong><small>异常与初始化失败</small></div>
          </div>

          <div className="trace-toolbar">
            <div className="trace-filters">
              {([["all", "全部"], ["copilot", "Copilot"], ["layout", "布局"], ["drawio", "Draw.io"], ["error", "警告 / 错误"]] as Array<[TraceFilter, string]>).map(([value, label]) =>
                <UiButton type="button" key={value} className={traceFilter === value ? "active" : ""} onClick={() => setTraceFilter(value)}>{label}</UiButton>
              )}
            </div>
            <span>按时间倒序 · 浏览器诊断事件不保存完整提示词或原始 XML；服务端 Copilot 审计日志单独保留请求与上下文信息</span>
          </div>

          <div className="trace-list">
            {filteredTraces.length ? [...filteredTraces].reverse().map((entry) => (
              <article className={"trace-entry trace-" + entry.level} key={entry.id}>
                <div className="trace-entry-rail"><span /></div>
                <div className="trace-entry-content">
                  <div className="trace-entry-head">
                    <span className={"trace-level level-" + entry.level}>{entry.level.toUpperCase()}</span>
                    <code>{entry.event}</code><time>{formattedTime(entry.timestamp)}</time>
                    <UiButton type="button" onClick={() => setDetailsOpen((current) => current === entry.id ? null : entry.id)}>{detailsOpen === entry.id ? "收起详情" : "查看详情"}</UiButton>
                  </div>
                  <div className="trace-entry-message">{entry.message}</div>
                  {detailsOpen === entry.id && <pre className="trace-entry-details">{JSON.stringify(entry.details, null, 2)}</pre>}
                </div>
              </article>
            )) : <div className="trace-empty"><div className="trace-empty-icon">◎</div><h2>没有匹配的轨迹</h2><p>切换到 Studio 或 Layout Copilot 执行操作后，事件会自动出现在这里。Draw.io 初始化和错误信息也会记录。</p><UiButton type="button" className="button button-secondary" onClick={() => setTraceFilter("all")}>显示全部事件</UiButton></div>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="workspace-page settings-workspace">
      <div className="page-content">
        <div className="page-hero">
          <div><div className="page-eyebrow">WORKSPACE / RUNTIME CONFIGURATION</div><h1>配置</h1>
            <p>集中管理模型选择、本地 Draw.io 资源检查和开发诊断。默认模型为 Claude Sonnet 5.5；敏感凭据不会写入浏览器持久存储。</p>
          </div>
        </div>

        <div className="settings-grid">
          <ConfigurationEditor onLayoutProfilesChanged={props.onLayoutProfilesChanged} />

          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon">✳</div><div><h2>GitHub Copilot SDK / Agent Runtime</h2><p>服务端 Copilot CLI runtime；使用已登录的 GitHub Copilot 身份</p></div></div>
            <div className="settings-status-line"><span className={"settings-status-dot " + (aiModel.trim() ? "status-ready" : "status-unknown")} /><strong>{aiModel.trim() ? "Agent 模式已配置" : "当前使用本地规则"}</strong></div>
            <label className="settings-field">默认模型
              <Select
                showSearch
                optionFilterProp="label"
                value={aiModel || undefined}
                options={modelOptions}
                loading={modelsLoading}
                onChange={(value) => setAiModel(value)}
                placeholder="选择模型（留空使用本地规则）"
                style={{ width: "100%" }}
              />
            </label>
            <p className="settings-description">{modelsMessage || "默认使用 Claude Sonnet 5.5；模型选项优先来自本机 Copilot SDK。"}</p>
            <label className="settings-field">Thinking effort
              <Select value={reasoningEffort} onChange={(value: "high" | "max") => setReasoningEffort(value)} options={[{ value: "max", label: "Max — 最高推理强度（默认）" }, { value: "high", label: "High — 高推理强度" }]} style={{ width: "100%" }} />
            </label>
            <p className="settings-description">通过 Copilot SDK 的 reasoningEffort 传递。仅当所选模型支持该档位时生效；服务端会依据 SDK 模型能力选择兼容档位。</p>
            <div className="settings-security-note"><strong>Agent 能力与安全边界</strong><span>服务端通过 @github/copilot-sdk 创建会话，并要求 Agent 调用 propose_layout_plan 工具提交结构化布局计划。模型凭据不经过浏览器；服务使用本机已登录的 Copilot CLI。Agent 只能提出白名单中的布局命令，不能执行任意代码或直接写入图形。计划通过校验后仍需在 Studio 中预览并由你确认。</span></div>
            <div className="settings-card-actions"><UiButton type="button" className="button button-quiet" onClick={clearAISettings}>清除模型配置</UiButton><UiButton type="button" className="button button-primary" onClick={saveAISettings}>保存配置</UiButton></div>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon drawio-icon">D</div><div><h2>原生 Draw.io</h2><p>固定版本、本地静态资源、同源 embed 协议</p></div></div>
            <div className="settings-status-line"><span className={"settings-status-dot status-" + drawioStatus} /><strong>{drawioStatus === "ready" ? "本地资源可用" : drawioStatus === "checking" ? "正在检查…" : drawioStatus === "missing" ? "资源缺失或校验不匹配" : drawioStatus === "error" ? "检查失败" : "尚未检查"}</strong></div>
            <p className="settings-description">{drawioStatusMessage || "检查 /drawio/studio-bundle.json 与 /drawio/index.html 的响应状态、版本清单和 SHA-256 校验信息。"}</p>
            <UiButton type="button" className="button button-secondary" onClick={checkDrawioStatus} disabled={drawioStatus === "checking"}>{drawioStatus === "checking" ? "检查中…" : "检查本地 Draw.io"}</UiButton>
            <div className="settings-terminal-note"><strong>卡在 Loading… 时</strong><span>先查看 Agent 轨迹里的 drawio.handshake.* 和 drawio.init.timeout，再查看启动终端的 [studio:v2] JSON 日志。初始化成功前不会发送文档 XML。</span></div>
          </section>

          <section className="settings-card settings-logs-card">
            <div className="settings-card-heading"><div className="settings-card-icon">⌘</div><div><h2>终端日志与诊断轨迹</h2><p>浏览器事件 → Vite 开发终端 → 本地轨迹页面</p></div></div>
            <p className="settings-description">运行 <code>npm run dev</code> 会同时启动 Vite 与 Copilot SDK Agent 服务。浏览器诊断事件不保存完整提示词、凭据或原始 XML；服务端 Copilot 会话审计日志会保存用户请求、图形上下文摘要及工具事件。请将本地审计日志视为可能包含项目敏感信息的数据。</p>
            <div className="terminal-example"><span>TERMINAL</span><code>[studio:v2] receivedAt=… level=info event=layout.run.completed durationMs=…</code></div>
            <div className="settings-card-actions"><span className="settings-trace-count">{traceEntries.length} 条本地轨迹 · {errorCount} 条错误</span></div>
          </section>
        </div>
      </div>
    </main>
  );
}
