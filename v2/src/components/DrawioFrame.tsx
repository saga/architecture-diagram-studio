import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DiagramDocument } from "../model/types";
import { fromDrawioXml } from "../import/drawio";
import { recordDiagnostic } from "../diagnostics";

const DRAWIO_VERSION = "v32.0.2";
const DRAWIO_SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
const EMBED_URL = "/drawio/index.html?embed=1&proto=json&configure=1&ui=min&lang=zh&format=0&sidebar=0&windows=0&noSaveBtn=1&noExitBtn=1";

interface Props {
  document: DiagramDocument;
  xml: string;
  onDocumentChange: (document: DiagramDocument, nativeXml: string) => void;
}

/**
 * Draw.io ships its own save/exit buttons; Studio owns persistence, so they are hidden.
 * Matched by id, data-id, and label, in the languages the bundled editor can render.
 */
const SAVE_AND_EXIT_SELECTOR = [
  "#save", "#exit", "#saveBtn", "#exitBtn",
  "[data-id='save']", "[data-id='exit']",
  "[title*='Save and Exit']", "[title*='Save & Exit']",
  "[aria-label*='Save and Exit']", "[aria-label*='Save & Exit']",
  "[title*='保存并退出']", "[aria-label*='保存并退出']"
].join(", ");

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
  const embedUiObserverRef = useRef<MutationObserver | null>(null);

  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    recordDiagnostic("drawio.bundle.check.started", "Checking the local Draw.io bundle", { url: "/drawio/studio-bundle.json", expectedVersion: DRAWIO_VERSION });
    fetch("/drawio/studio-bundle.json", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          recordDiagnostic("drawio.bundle.check.failed", "The local Draw.io manifest request failed", { httpStatus: response.status }, "error");
          return false;
        }
        const manifest = await response.json() as { version?: string; sha256?: string };
        const installed = manifest.version === DRAWIO_VERSION && manifest.sha256 === DRAWIO_SHA256;
        recordDiagnostic(installed ? "drawio.bundle.check.ready" : "drawio.bundle.check.mismatch",
          installed ? "The local Draw.io bundle matches the manifest" : "The local Draw.io bundle version or checksum does not match",
          { installedVersion: manifest.version ?? null, checksumMatches: manifest.sha256 === DRAWIO_SHA256, durationMs: Date.now() - startedAt },
          installed ? "info" : "error");
        return installed;
      })
      .then((installed) => { if (active) setAvailable(installed); })
      .catch((error: unknown) => {
        recordDiagnostic("drawio.bundle.check.error", "Reading the local Draw.io manifest failed",
          { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
        if (active) setAvailable(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (available !== true || editorReady) return;
    const timeout = window.setTimeout(() => {
      setStartupError("Draw.io did not finish the embed handshake within 20 seconds. Check the [studio:v2] drawio output in the terminal, or re-initialise the editor.");
      recordDiagnostic("drawio.init.timeout", "Timed out waiting for the Draw.io embed to initialise", {
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
      recordDiagnostic("drawio.document.load.sent", "Sent the document to native Draw.io", {
        xmlLength: xml.length, nodeCount: document.nodes.length, relationCount: document.relations.length
      });
    } catch (error) {
      setStartupError("Could not send the document to Draw.io: " + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("drawio.document.load.failed", "Sending the document to Draw.io failed",
        { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
    }
  }, [editorReady, xml, document.nodes.length, document.relations.length]);

  useLayoutEffect(() => {
    // Install the message listener in the commit phase before the iframe can finish loading
    // and send its configure/init handshake. Keep it stable across document and callback changes.
    function receive(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== window.location.origin && event.origin !== "null") {
        recordDiagnostic("drawio.message.origin_rejected", "Ignored a Draw.io message from an unexpected origin", { origin: event.origin }, "warn");
        return;
      }
      let data: Record<string, unknown>;
      try {
        data = typeof event.data === "string" ? JSON.parse(event.data) as Record<string, unknown> : event.data as Record<string, unknown>;
      } catch {
        recordDiagnostic("drawio.message.invalid_json", "Ignored an unparseable Draw.io message", { dataType: typeof event.data }, "warn");
        return;
      }
      if (!data || typeof data !== "object") return;
      if (typeof data.event === "string" && !seenEvents.current.has(data.event)) {
        seenEvents.current.add(data.event);
        recordDiagnostic("drawio.message.first_seen", "First Draw.io embed protocol event received", {
          event: data.event, fields: Object.keys(data).slice(0, 20), origin: event.origin
        });
      }

      if (data.event === "configure") {
        recordDiagnostic("drawio.handshake.configure", "Draw.io requested configuration");
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({
          action: "configure",
          config: { defaultFonts: ["Inter", "Arial"], defaultPageFormat: "A4", autosave: 1, noSaveBtn: true, noExitBtn: true }
        }), window.location.origin);
      }
      if (data.event === "init") {
        recordDiagnostic("drawio.handshake.ready", "Draw.io embed API initialised; documents can be loaded safely", {
          iframeLoaded: iframeLoadedRef.current, origin: event.origin
        });
        setStartupError(null);
        setEditorReady(true);
      }
      if (data.event === "error") {
        const message = typeof data.message === "string" ? data.message.slice(0, 300) : "Draw.io returned an unspecified error.";
        setStartupError("Draw.io error: " + message);
        recordDiagnostic("drawio.editor.error", "The Draw.io editor reported an error", { message }, "error");
      }
      if ((data.event === "save" || data.event === "autosave") && typeof data.xml === "string") {
        if (data.xml === lastSent.current) return;
        lastSent.current = data.xml;
        try {
          const currentDocument = documentRef.current;
          const next = fromDrawioXml(data.xml, currentDocument);
          recordDiagnostic("drawio.document.saved", "Draw.io autosave result synced into the Studio model", {
            event: data.event, xmlLength: data.xml.length, nodeCount: next.nodes.length, relationCount: next.relations.length
          });
          onDocumentChangeRef.current(next, data.xml);
        } catch (error) {
          recordDiagnostic("drawio.document.parse.failed", "Parsing the Draw.io autosave payload failed",
            { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
          setStartupError("Could not parse the Draw.io autosave payload; the Studio model is not synced yet. See the agent trace for details.");
        }
      }
    }
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  function hideSaveAndExitControls() {
    const frameDocument = iframeRef.current?.contentDocument;
    if (!frameDocument) return;
    const hideControls = () => {
      const controls = frameDocument.querySelectorAll<HTMLElement>(
        SAVE_AND_EXIT_SELECTOR
      );
      controls.forEach((element) => {
        element.style.setProperty("display", "none", "important");
        element.setAttribute("aria-hidden", "true");
      });
    };
    hideControls();
    if (frameDocument.head && !frameDocument.getElementById("studio-hide-save-exit")) {
      const style = frameDocument.createElement("style");
      style.id = "studio-hide-save-exit";
      style.textContent = SAVE_AND_EXIT_SELECTOR + " { display: none !important; }";
      frameDocument.head.appendChild(style);
    }
    embedUiObserverRef.current?.disconnect();
    embedUiObserverRef.current = new MutationObserver(hideControls);
    embedUiObserverRef.current.observe(frameDocument.documentElement, { childList: true, subtree: true });
  }

  function retryEditor() {
    recordDiagnostic("drawio.retry", "The user asked to re-initialise the Draw.io editor", { previousFrameKey: frameKey }, "warn");
    lastSent.current = "";
    setEditorReady(false);
    setIframeLoaded(false);
    iframeLoadedRef.current = false;
    setStartupError(null);
    setFrameKey((value) => value + 1);
  }

  if (available === null) return <div className="drawio-status"><span className="spinner" />Checking the local Draw.io bundle…</div>;
  if (!available) return (
    <div className="drawio-missing">
      <div className="drawio-missing-icon">D</div>
      <h3>The local Draw.io bundle is missing or failed its checksum</h3>
      <p>V2 never uses the hosted embed. Run the bundling script inside the v2 directory and check the terminal for download, SHA-256, or unpacking errors.</p>
      <code>npm run drawio:fetch</code>
      <p className="muted">Offline: DRAWIO_WAR=/path/to/draw.war npm run drawio:fetch</p>
    </div>
  );

  return (
    <div className="drawio-frame-wrap">
      <div className="drawio-inline-bar">
        <span className="local-indicator" />
        <span>Local Draw.io · {DRAWIO_VERSION} · same-origin editing</span>
        <span className="drawio-inline-hint">{editorReady ? "Native editor ready · edits autosave back into Studio" : "Waiting for the embed handshake…"}</span>
      </div>
      {startupError && <div className="drawio-error-banner" role="alert">
        <span>{startupError}</span><button type="button" onClick={retryEditor}>Re-initialise</button>
      </div>}
      <iframe key={frameKey} ref={iframeRef} className="drawio-iframe" title="Native Draw.io editor"
        src={EMBED_URL}
        onLoad={() => {
          setIframeLoaded(true);
          iframeLoadedRef.current = true;
          hideSaveAndExitControls();
          recordDiagnostic("drawio.iframe.loaded", "The Draw.io iframe fired its browser load event; still waiting for embed init", { url: EMBED_URL, frameKey });
        }}
        onError={() => {
          embedUiObserverRef.current?.disconnect();
          embedUiObserverRef.current = null;
          setStartupError("The browser could not load the local Draw.io page. Check that /drawio/index.html exists.");
          recordDiagnostic("drawio.iframe.load.failed", "The browser could not load the local Draw.io iframe", { url: EMBED_URL }, "error");
        }}
        allow="clipboard-read; clipboard-write" />
    </div>
  );
}
