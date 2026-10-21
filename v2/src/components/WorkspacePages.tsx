import { useEffect, useMemo, useRef, useState } from "react";
import type { DiagramDocument } from "../model/types";
import type { DiagnosticEntry } from "../diagnostics";

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
  aiApiKey: string;
  setAiApiKey: (value: string) => void;
  saveAISettings: () => void;
  clearAISettings: () => void;
  traceEntries: DiagnosticEntry[];
  clearTraces: () => void;
  drawioStatus: DrawioStatus;
  drawioStatusMessage: string;
  checkDrawioStatus: () => void;
}

function formattedTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export default function WorkspacePages(props: Props) {
  const {
    page, document, previewDocument, previewSummary, messages, chatInput, setChatInput, chatBusy,
    sendIntent, acceptPreview, discardPreview, openStudio, aiBaseUrl, setAiBaseUrl, aiModel, setAiModel,
    aiApiKey, setAiApiKey, saveAISettings, clearAISettings, traceEntries, clearTraces,
    drawioStatus, drawioStatusMessage, checkDrawioStatus
  } = props;
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [traceFilter, setTraceFilter] = useState<TraceFilter>("all");
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null);
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
            <div className="page-hero-status"><i />{aiBaseUrl.trim() && aiModel.trim() ? "兼容模型 + 本地规则" : "本地规则模式"}</div>
          </div>

          <section className="gemini-chat">
            <div className="gemini-chat-scroll">
              <div className="gemini-welcome">
                <div className="gemini-spark">✳</div>
                <h2>这张图，想怎么调整？</h2>
                <p>例如：把所有 external 移到右侧；数据库放到底部；所有连线改成直角折线。</p>
                <div className="prompt-suggestions">
                  {["把所有 external 放到右侧", "把数据库和存储放到底部", "所有关系线改成虚线", "把曲线改成折线"].map((prompt) =>
                    <button type="button" key={prompt} onClick={() => setChatInput(prompt)}>{prompt}<span>↗</span></button>
                  )}
                </div>
              </div>
              <div className="gemini-messages" aria-live="polite">
                {messages.map((message) => <article key={message.id} className={"gemini-message " + message.role}>
                  {message.role === "assistant" && <div className="gemini-avatar">✳</div>}
                  <div className="gemini-message-body"><div className="gemini-message-role">{message.role === "assistant" ? "Layout Copilot" : "你"}</div><div className="gemini-message-text">{message.text}</div></div>
                </article>)}
                <div ref={chatEndRef} />
              </div>
            </div>

            {previewDocument && <div className="preview-actions copilot-preview-actions">
              <div className="preview-pill">布局预览 · 未应用</div>
              <div className="preview-summary">{previewSummary || "布局预览已生成"}</div>
              <div className="preview-buttons">
                <button type="button" className="preview-discard" onClick={discardPreview}>丢弃预览</button>
                <button type="button" className="preview-discard" onClick={openStudio}>到 Studio 画布检查</button>
                <button type="button" className="preview-accept" onClick={acceptPreview}>应用到正式图</button>
              </div>
            </div>}

            <form className="gemini-composer" onSubmit={(event) => { event.preventDefault(); sendIntent(); }}>
              <textarea disabled={Boolean(previewDocument)} value={chatInput} onChange={(event) => setChatInput(event.target.value)}
                placeholder="描述希望的布局变化…" rows={3}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendIntent(); } }} />
              <div className="gemini-composer-footer">
                <span>{chatBusy ? <><i className="spinner" /> 正在分析布局意图…</> : "Enter 发送 · Shift + Enter 换行"}</span>
                <button type="submit" disabled={chatBusy || Boolean(previewDocument) || !chatInput.trim()} aria-label="发送布局意图">↑</button>
              </div>
            </form>
            <div className="gemini-privacy-note">本地布局规则负责坐标与质量检查；配置外部模型时，只会发送布局请求和有限的图形元数据。API Key 不写入浏览器持久存储。</div>
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
            <div className="page-hero-actions"><button type="button" className="button button-secondary" onClick={() => window.location.reload()}>刷新页面</button><button type="button" className="button button-quiet" onClick={clearTraces}>清空轨迹</button></div>
          </div>

          <div className="trace-metrics">
            <div><span>全部事件</span><strong>{traceEntries.length}</strong><small>当前浏览器会话历史</small></div>
            <div><span>Copilot 阶段</span><strong>{copilotCount}</strong><small>请求、解析与执行结果</small></div>
            <div><span>布局阶段</span><strong>{layoutCount}</strong><small>布局开始、结束和失败</small></div>
            <div className={errorCount ? "has-errors" : ""}><span>错误事件</span><strong>{errorCount}</strong><small>异常与初始化失败</small></div>
          </div>

          <div className="trace-toolbar">
            <div className="trace-filters">
              {([["all", "全部"], ["copilot", "Copilot"], ["layout", "布局"], ["drawio", "Draw.io"], ["error", "警告 / 错误"]] as Array<[TraceFilter, string]>).map(([value, label]) =>
                <button type="button" key={value} className={traceFilter === value ? "active" : ""} onClick={() => setTraceFilter(value)}>{label}</button>
              )}
            </div>
            <span>按时间倒序 · 不记录 API Key、提示词正文或原始 XML</span>
          </div>

          <div className="trace-list">
            {filteredTraces.length ? [...filteredTraces].reverse().map((entry) => (
              <article className={"trace-entry trace-" + entry.level} key={entry.id}>
                <div className="trace-entry-rail"><span /></div>
                <div className="trace-entry-content">
                  <div className="trace-entry-head">
                    <span className={"trace-level level-" + entry.level}>{entry.level.toUpperCase()}</span>
                    <code>{entry.event}</code><time>{formattedTime(entry.timestamp)}</time>
                    <button type="button" onClick={() => setDetailsOpen((current) => current === entry.id ? null : entry.id)}>{detailsOpen === entry.id ? "收起详情" : "查看详情"}</button>
                  </div>
                  <div className="trace-entry-message">{entry.message}</div>
                  {detailsOpen === entry.id && <pre className="trace-entry-details">{JSON.stringify(entry.details, null, 2)}</pre>}
                </div>
              </article>
            )) : <div className="trace-empty"><div className="trace-empty-icon">◎</div><h2>没有匹配的轨迹</h2><p>切换到 Studio 或 Layout Copilot 执行操作后，事件会自动出现在这里。Draw.io 初始化和错误信息也会记录。</p><button type="button" className="button button-secondary" onClick={() => setTraceFilter("all")}>显示全部事件</button></div>}
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
            <p>集中管理模型接口、本地 Draw.io 资源检查和开发诊断。敏感凭据不会写入浏览器持久存储。</p>
          </div>
        </div>

        <div className="settings-grid">
          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon">✳</div><div><h2>Layout Copilot 模型接口</h2><p>OpenAI-compatible Chat Completions 接口</p></div></div>
            <label className="settings-field">Base URL<input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="例如：http://localhost:1234/v1" autoComplete="url" /></label>
            <label className="settings-field">Model<input value={aiModel} onChange={(event) => setAiModel(event.target.value)} placeholder="例如：gpt-4.1-mini" autoComplete="off" /></label>
            <label className="settings-field">API Key（可选）<input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="只保留在当前页面内存" autoComplete="new-password" /></label>
            <div className="settings-security-note"><strong>数据说明</strong><span>模型只把自然语言转换为受限的布局指令；坐标仍由本地布局器计算。外部请求会包含当前图标题及有限的节点名称/角色。请勿向未经批准的服务发送敏感架构信息。API Key 仅保存在当前页面内存，刷新后需要重新输入。</span></div>
            <div className="settings-card-actions"><button type="button" className="button button-quiet" onClick={clearAISettings}>清除模型配置</button><button type="button" className="button button-primary" onClick={saveAISettings}>保存配置</button></div>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><div className="settings-card-icon drawio-icon">D</div><div><h2>原生 Draw.io</h2><p>固定版本、本地静态资源、同源 embed 协议</p></div></div>
            <div className="settings-status-line"><span className={"settings-status-dot status-" + drawioStatus} /><strong>{drawioStatus === "ready" ? "本地资源可用" : drawioStatus === "checking" ? "正在检查…" : drawioStatus === "missing" ? "资源缺失或校验不匹配" : drawioStatus === "error" ? "检查失败" : "尚未检查"}</strong></div>
            <p className="settings-description">{drawioStatusMessage || "检查 /drawio/studio-bundle.json 与 /drawio/index.html 的响应状态、版本清单和 SHA-256 校验信息。"}</p>
            <button type="button" className="button button-secondary" onClick={checkDrawioStatus} disabled={drawioStatus === "checking"}>{drawioStatus === "checking" ? "检查中…" : "检查本地 Draw.io"}</button>
            <div className="settings-terminal-note"><strong>卡在 Loading… 时</strong><span>先查看 Agent 轨迹里的 drawio.handshake.* 和 drawio.init.timeout，再查看启动终端的 [studio:v2] JSON 日志。初始化成功前不会发送文档 XML。</span></div>
          </section>

          <section className="settings-card settings-logs-card">
            <div className="settings-card-heading"><div className="settings-card-icon">⌘</div><div><h2>终端日志与诊断轨迹</h2><p>浏览器事件 → Vite 开发终端 → 本地轨迹页面</p></div></div>
            <p className="settings-description">运行 <code>npm run dev</code> 后，应用会将带有时间戳、事件名、持续时间和状态的结构化 JSON 日志发到开发服务器，终端会显示为 <code>[studio:v2]</code>。提示词正文、API Key 和原始 XML 会脱敏或省略。</p>
            <div className="terminal-example"><span>TERMINAL</span><code>[studio:v2] receivedAt=… level=info event=layout.run.completed durationMs=…</code></div>
            <div className="settings-card-actions"><span className="settings-trace-count">{traceEntries.length} 条本地轨迹 · {errorCount} 条错误</span></div>
          </section>
        </div>
      </div>
    </main>
  );
}
