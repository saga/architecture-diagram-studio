import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DiagramDocument } from "../model/types";
import { fromDrawioXml } from "../import/drawio";
import { recordDiagnostic } from "../diagnostics";

const DRAWIO_VERSION = "v32.0.2";
const DRAWIO_SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
const EMBED_URL = "/drawio/index.html?embed=1&proto=json&configure=1&ui=min&libraries=1&noSaveBtn=1";

interface Props {
  document: DiagramDocument;
  xml: string;
  onDocumentChange: (document: DiagramDocument, nativeXml: string) => void;
}

export default function DrawioFrame({ document, xml, onDocumentChange }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const documentRef = useRef(document);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const iframeLoadedRef = useRef(false);
  documentRef.current = document;
  onDocumentChangeRef.current = onDocumentChange;
  const lastSent = useRef("");
  const seenEvents = useRef(new Set<string>());
  const [available, setAvailable] = useState<boolean | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    recordDiagnostic("drawio.bundle.check.started", "检查本地 Draw.io 包", { url: "/drawio/studio-bundle.json", expectedVersion: DRAWIO_VERSION });
    fetch("/drawio/studio-bundle.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          recordDiagnostic("drawio.bundle.check.failed", "本地 Draw.io 清单请求失败", { httpStatus: response.status }, "error");
          return false;
        }
        const manifest = await response.json() as { version?: string; sha256?: string };
        const installed = manifest.version === DRAWIO_VERSION && manifest.sha256 === DRAWIO_SHA256;
        recordDiagnostic(installed ? "drawio.bundle.check.ready" : "drawio.bundle.check.mismatch",
          installed ? "本地 Draw.io 包与校验清单匹配" : "本地 Draw.io 包版本或校验值不匹配",
          { installedVersion: manifest.version ?? null, checksumMatches: manifest.sha256 === DRAWIO_SHA256, durationMs: Date.now() - startedAt },
          installed ? "info" : "error");
        return installed;
      })
      .then((installed) => { if (active) setAvailable(installed); })
      .catch((error: unknown) => {
        recordDiagnostic("drawio.bundle.check.error", "读取本地 Draw.io 清单时发生异常",
          { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
        if (active) setAvailable(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (available !== true || editorReady) return;
    const timeout = window.setTimeout(() => {
      setStartupError("Draw.io 未在 20 秒内完成 embed 初始化。请检查终端中的 [studio:v2] drawio 日志，或重新初始化编辑器。");
      recordDiagnostic("drawio.init.timeout", "等待 Draw.io embed 初始化超时", {
        iframeLoaded, ready: editorReady, url: EMBED_URL, timeoutMs: 20000
      }, "error");
    }, 20_000);
    return () => window.clearTimeout(timeout);
  }, [available, editorReady, iframeLoaded]);

  // The iframe's DOM load event is not the Draw.io embed API's ready event.
  // Sending "load" before the editor emits "init" can leave its canvas on an endless spinner.
  useEffect(() => {
    if (!editorReady || !iframeRef.current?.contentWindow || xml === lastSent.current) return;
    try {
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ action: "load", xml, autosave: 1 }),
        window.location.origin
      );
      lastSent.current = xml;
      setStartupError(null);
      recordDiagnostic("drawio.document.load.sent", "向原生 Draw.io 发送文档", {
        xmlLength: xml.length, nodeCount: document.nodes.length, relationCount: document.relations.length
      });
    } catch (error) {
      setStartupError("无法把文档发送到 Draw.io：" + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("drawio.document.load.failed", "发送文档到 Draw.io 失败",
        { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
    }
  }, [editorReady, xml, document.nodes.length, document.relations.length]);

  useLayoutEffect(() => {
    // Install the message listener in the commit phase before the iframe can finish loading
    // and send its configure/init handshake. Keep it stable across document and callback changes.
    function receive(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin && event.origin !== "null") {
        recordDiagnostic("drawio.message.origin_rejected", "忽略来自非预期 origin 的 Draw.io 消息", { origin: event.origin }, "warn");
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) as Record<string, unknown> : event.data as Record<string, unknown>;
      } catch {
        recordDiagnostic("drawio.message.invalid_json", "忽略无法解析的 Draw.io 消息", { dataType: typeof event.data }, "warn");
        return;
      }
      if (!data || typeof data !== "object") return;
      if (typeof data.event === "string" && !seenEvents.current.has(data.event)) {
        seenEvents.current.add(data.event);
        recordDiagnostic("drawio.message.first_seen", "首次收到 Draw.io embed 协议事件", {
          event: data.event, fields: Object.keys(data).slice(0, 20), origin: event.origin
        });
      }

      if (data.event === "configure") {
        recordDiagnostic("drawio.handshake.configure", "Draw.io 请求配置");
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({
          action: "configure",
          config: { defaultFonts: ["Inter", "Arial"], defaultPageFormat: "A4", autosave: 1 }
        }), window.location.origin);
      }
      if (data.event === "init") {
        recordDiagnostic("drawio.handshake.ready", "Draw.io embed API 已初始化；现在可以安全加载文档", {
          iframeLoaded: iframeLoadedRef.current, origin: event.origin
        });
        setStartupError(null);
        setEditorReady(true);
      }
      if (data.event === "error") {
        const message = typeof data.message === "string" ? data.message.slice(0, 300) : "Draw.io 返回了未说明的错误。";
        setStartupError("Draw.io 错误：" + message);
        recordDiagnostic("drawio.editor.error", "Draw.io 编辑器返回错误", { message }, "error");
      }
      if ((data.event === "save" || data.event === "autosave") && typeof data.xml === "string") {
        if (data.xml === lastSent.current) return;
        lastSent.current = data.xml;
        try {
          const currentDocument = documentRef.current;
          const next = fromDrawioXml(data.xml, currentDocument);
          recordDiagnostic("drawio.document.saved", "接收到 Draw.io 保存结果并同步语义模型", {
            event: data.event, xmlLength: data.xml.length, nodeCount: next.nodes.length, relationCount: next.relations.length
          });
          onDocumentChangeRef.current(next, data.xml);
        } catch (error) {
          recordDiagnostic("drawio.document.parse.failed", "解析 Draw.io 保存结果失败",
            { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
          setStartupError("Draw.io 保存内容解析失败，Studio 模型尚未同步。请查看 Agent 轨迹中的错误详情。");
        }
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  function retryEditor() {
    recordDiagnostic("drawio.retry", "用户请求重新初始化 Draw.io 编辑器", { previousFrameKey: frameKey }, "warn");
    lastSent.current = "";
    setEditorReady(false);
    setIframeLoaded(false);
    iframeLoadedRef.current = false;
    setStartupError(null);
    setFrameKey((value) => value + 1);
  }

  if (available === null) return <div className="drawio-status"><span className="spinner" />正在检查本地 Draw.io 资源…</div>;
  if (!available) return (
    <div className="drawio-missing">
      <div className="drawio-missing-icon">D</div>
      <h3>本地 Draw.io 尚未打包或校验失败</h3>
      <p>V2 不使用在线 embed。请在 v2 目录中运行打包脚本，检查终端是否有下载、SHA-256 校验或解包错误。</p>
      <code>npm run drawio:fetch</code>
      <p className="muted">离线环境：DRAWIO_WAR=/path/to/draw.war npm run drawio:fetch</p>
    </div>
  );

  return (
    <div className="drawio-frame-wrap">
      <div className="drawio-inline-bar">
        <span className="local-indicator" />
        <span>本地 Draw.io · {DRAWIO_VERSION} · 同源编辑</span>
        <span className="drawio-inline-hint">{editorReady ? "原生编辑器已就绪 · 保存后同步回 Studio 模型" : "等待 embed 初始化事件…"}</span>
      </div>
      {startupError && <div className="drawio-error-banner" role="alert">
        <span>{startupError}</span><button type="button" onClick={retryEditor}>重新初始化</button>
      </div>}
      <iframe key={frameKey} ref={iframeRef} className="drawio-iframe" title="Native Draw.io editor"
        src={EMBED_URL}
        onLoad={() => {
          setIframeLoaded(true);
          iframeLoadedRef.current = true;
          recordDiagnostic("drawio.iframe.loaded", "Draw.io iframe 的浏览器 load 事件已触发；继续等待 embed init", { url: EMBED_URL, frameKey });
        }}
        onError={() => {
          setStartupError("浏览器无法加载本地 Draw.io 页面，请检查 /drawio/index.html 是否存在。");
          recordDiagnostic("drawio.iframe.load.failed", "浏览器无法加载本地 Draw.io iframe", { url: EMBED_URL }, "error");
        }}
        allow="clipboard-read; clipboard-write" />
    </div>
  );
}
