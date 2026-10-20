import { useEffect, useRef, useState } from "react";
import type { DiagramDocument } from "../model/types";
import { fromDrawioXml } from "../import/drawio";

interface Props {
  document: DiagramDocument;
  xml: string;
  onDocumentChange: (document: DiagramDocument) => void;
}
export default function DrawioFrame({ document, xml, onDocumentChange }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastSent = useRef("");
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/drawio/studio-bundle.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return false;
        const manifest = await response.json() as { version?: string; sha256?: string };
        return manifest.version === "v32.0.2" && typeof manifest.sha256 === "string";
      })
      .then((installed) => { if (alive) setAvailable(installed); })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!loaded || !iframeRef.current?.contentWindow || xml === lastSent.current) return;
    iframeRef.current.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: 1 }), window.location.origin);
    lastSent.current = xml;
  }, [loaded, xml]);

  useEffect(() => {
    function receive(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin && event.origin !== "null") return;
      let data: Record<string, unknown>;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) as Record<string, unknown> : event.data as Record<string, unknown>;
      } catch { return; }
      if (data.event === "configure") {
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({
          action: "configure", config: { defaultFonts: ["Inter", "Arial"], defaultPageFormat: "A4", autosave: 1 }
        }), window.location.origin);
      }
      if ((data.event === "save" || data.event === "autosave") && typeof data.xml === "string") {
        lastSent.current = data.xml;
        onDocumentChange(fromDrawioXml(data.xml, document));
      }
      if (data.event === "init") setLoaded(true);
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [document, onDocumentChange]);

  if (available === null) return <div className="drawio-status"><span className="spinner" />正在检查本地 Draw.io 资源…</div>;
  if (!available) return (
    <div className="drawio-missing">
      <div className="drawio-missing-icon">D</div>
      <h3>本地 Draw.io 尚未打包</h3>
      <p>V2 不使用在线 embed。首次联网运行一次打包脚本，或把已下载的 draw.war 路径传给脚本。完成后，应用会从同源的 /drawio/ 加载原生编辑器。</p>
      <code>npm run drawio:fetch</code>
      <p className="muted">离线环境：DRAWIO_WAR=/path/to/draw.war npm run drawio:fetch</p>
    </div>
  );
  return (
    <div className="drawio-frame-wrap">
      <div className="drawio-inline-bar"><span className="local-indicator" /><span>本地 Draw.io · v32.0.2 · 同源编辑</span><span className="drawio-inline-hint">按 ⌘S 保存；保存后同步回 Studio 模型</span></div>
      <iframe ref={iframeRef} className="drawio-iframe" title="Native Draw.io editor"
        src="/drawio/index.html?embed=1&proto=json&configure=1&ui=min&spin=1&libraries=1&noSaveBtn=1"
        onLoad={() => {
          setLoaded(true);
          if (iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: 1 }), window.location.origin);
            lastSent.current = xml;
          }
        }}
        allow="clipboard-read; clipboard-write" />
    </div>
  );
}