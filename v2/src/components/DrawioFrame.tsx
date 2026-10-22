import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isDrawioXmlDocument } from "../model/drawio-xml-source";
import { recordDiagnostic } from "../diagnostics";
import { drawioFrameThemeCss, readDrawioModelBackground, type DrawioThemePalette } from "../model/drawio-theme";

export const DRAWIO_VERSION = "v32.0.2";
const DRAWIO_SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
const EMBED_URL = "/drawio/index.html?embed=1&proto=json&configure=1&ui=min&lang=zh&format=0&sidebar=0&noSaveBtn=1&noExitBtn=1";

interface CellPropertyEdit { cellId: string; pageId: string | null; path: string; value: string; requestId: number; }
type NativeEditResult = {
  requestId: number | null;
  success: boolean;
  cellId: string | null;
  path: string | null;
  error?: string;
  batchResults?: Array<{ index: number; cellId: string; path: string; value: string; success: boolean; error?: string }> | null;
  failedIndex?: number | null;
  rollbackErrors?: Array<{ cellId: string; error: string }>;
  batchRolledBack?: boolean | null;
  /** XML returned by the native Draw.io save protocol after a Copilot batch. */
  serializedXml?: string;
  /** Set by the host when the editor accepted the edit but required persistence failed. */
  failureStage?: "editor" | "persistence";
  auditWarning?: string;
};
type PendingNativeEdit = { cellId: string; path: string; value: string; startedAt: number; beforeXml: string };
type PendingSaveConfirmation = PendingNativeEdit & { deferredBatchAck?: NativeEditResult };
interface Props {
  onNativeEditResult?: (result: NativeEditResult) => void;
  xml: string;
  onDocumentChange: (nativeXml: string) => void;
  onSelectionChange: (cellId: string | null, pageId: string | null) => void;
  cellEdit: CellPropertyEdit | null;
  theme: string;
  /** Reports the embed handshake state so the app's single status bar can show it. */
  onEditorStatusChange?: (ready: boolean) => void;
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

export default function DrawioFrame({ xml, onDocumentChange, onSelectionChange, onNativeEditResult, cellEdit, theme, onEditorStatusChange }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onNativeEditResultRef = useRef(onNativeEditResult);
  const lastHandledCellEditRequestRef = useRef<number | null>(null);
  const pendingNativeEditsRef = useRef(new Map<number, PendingNativeEdit>());
  const pendingSaveConfirmationsRef = useRef(new Map<number, PendingSaveConfirmation>());
  const iframeLoadedRef = useRef(false);
  const nativeDocumentLoadedRef = useRef(false);
  const themeRef = useRef(theme);
  const themeBackgroundRef = useRef<{ restore: boolean; background: string; restoreBackground: string | null }>({
    restore: true, background: "#ffffff", restoreBackground: null
  });
  themeRef.current = theme;
  onDocumentChangeRef.current = onDocumentChange;
  onSelectionChangeRef.current = onSelectionChange;
  onNativeEditResultRef.current = onNativeEditResult;
  const lastSent = useRef("");
  const seenEvents = useRef(new Set<string>());
  const [available, setAvailable] = useState<boolean | null>(null);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const embedUiObserverRef = useRef<MutationObserver | null>(null);

  // The editor's readiness is surfaced in the app's bottom status bar, so the canvas stays flush
  // against the stage instead of carrying its own header strip.
  useEffect(() => {
    onEditorStatusChange?.(editorReady);
  }, [editorReady, onEditorStatusChange]);

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
    const frameDocument = iframeRef.current?.contentDocument;
    const appShell = window.parent.document.querySelector<HTMLElement>(".app-shell");
    if (!frameDocument || !appShell) return;
    const computed = window.parent.getComputedStyle(appShell);
    const token = (name: string, fallback: string) => computed.getPropertyValue(name).trim() || fallback;
    const palette: DrawioThemePalette = {
      canvas: token("--theme-canvas", "#ffffff"),
      panel: token("--theme-panel", "#ffffff"),
      text: token("--theme-text", "#172033"),
      secondary: token("--theme-secondary", "#334155"),
      muted: token("--theme-muted", "#64748b"),
      border: token("--theme-border", "#d0d7e2"),
      accent: token("--theme-accent", "#425bc7"),
      soft: token("--theme-soft", "#e8edff")
    };
    let style = frameDocument.getElementById("studio-native-theme") as HTMLStyleElement | null;
    if (!style && frameDocument.head) {
      style = frameDocument.createElement("style");
      style.id = "studio-native-theme";
      frameDocument.head.appendChild(style);
    }
    if (style) style.textContent = drawioFrameThemeCss(palette);

    // UI themes affect iframe presentation only. Never rewrite the authoritative
    // Draw.io XML on theme changes; that creates a save/reload feedback loop.
    const explicitBackground = readDrawioModelBackground(xml);
    themeBackgroundRef.current = {
      restore: theme === "editorial",
      background: palette.canvas,
      restoreBackground: explicitBackground
    };
    // Do not mutate Draw.io's graph model for a Studio UI theme. CSS above controls
    // presentation without triggering native autosave or dirty-document prompts.

    // Deliberately do not call onDocumentChange here: UI theme changes are not document edits.
  }, [theme, editorReady, iframeLoaded, xml, bridgeReady]);

  useEffect(() => {
    if (!editorReady || !iframeRef.current?.contentWindow || xml === lastSent.current) return;
    try {
      // Never feed a malformed/stale XML snapshot into Draw.io: its import dialog can
      // repeatedly ask to save the broken new-file document. Keep the source untouched
      // and show an actionable Studio error instead.
      if (!isDrawioXmlDocument(xml)) {
        setStartupError("The current Draw.io XML is malformed and was not loaded. Restore a valid revision from Agent traces → History, then reopen the diagram.");
        recordDiagnostic("drawio.document.load.rejected", "Refused to load malformed authoritative Draw.io XML", {
          xmlLength: xml.length
        }, "error");
        return;
      }
      nativeDocumentLoadedRef.current = false;
      iframeRef.current.contentWindow.postMessage(
        JSON.stringify({ action: "load", xml, autosave: 1 }),
        window.location.origin
      );
      lastSent.current = xml;
      setStartupError(null);
      recordDiagnostic("drawio.document.load.sent", "Sent the document to native Draw.io", {
        xmlLength: xml.length
      });
    } catch (error) {
      setStartupError("Could not send the document to Draw.io: " + (error instanceof Error ? error.message : String(error)));
      recordDiagnostic("drawio.document.load.failed", "Sending the document to Draw.io failed",
        { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
    }
  }, [editorReady, xml]);


  useEffect(() => {
    if (!cellEdit || !editorReady || !bridgeReady || lastHandledCellEditRequestRef.current === cellEdit.requestId) return;
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    lastHandledCellEditRequestRef.current = cellEdit.requestId;
    target.postMessage(JSON.stringify({
      event: "studioPropertyEditRequest",
      requestId: cellEdit.requestId,
      cellId: cellEdit.cellId,
      pageId: cellEdit.pageId,
      path: cellEdit.path,
      value: cellEdit.value
    }), window.location.origin);
    recordDiagnostic("drawio.selection.property.requested", "Sent a native property edit through the Draw.io plugin bridge", {
      cellId: cellEdit.cellId, property: cellEdit.path, value: cellEdit.value, requestId: cellEdit.requestId,
      pageId: cellEdit.pageId, xmlLengthBefore: xml.length
    });
    pendingNativeEditsRef.current.set(cellEdit.requestId, { cellId: cellEdit.cellId, path: cellEdit.path, value: cellEdit.value, startedAt: Date.now(), beforeXml: xml });
  }, [cellEdit, editorReady, bridgeReady]);

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

      if (data.event === "studioBridgeReady") {
        setBridgeReady(true);
        recordDiagnostic("drawio.bridge.ready", "Native Draw.io selection and property bridge is ready", { frameKey });
        recordDiagnostic("drawio.plugin.bridge.ready", "The native Draw.io selection and property-edit plugin is ready", { frameKey });
      }
      if (data.event === "studioSelectionChanged") {
        const cellId = typeof data.cellId === "string" && data.cellId ? data.cellId : null;
        const pageId = typeof data.pageId === "string" && data.pageId ? data.pageId : null;
        onSelectionChangeRef.current(cellId, pageId);
      }
      if (data.event === "studioPropertyEditResult") {
        const requestId = typeof data.requestId === "number" ? data.requestId : null;
        if (data.success === true) {
          const nativeResult: NativeEditResult = {
            requestId, success: true,
            cellId: typeof data.cellId === "string" ? data.cellId : null,
            path: typeof data.path === "string" ? data.path : null,
            batchResults: Array.isArray(data.batchResults) ? data.batchResults as NativeEditResult["batchResults"] : null
          };
          const pending = requestId === null ? undefined : pendingNativeEditsRef.current.get(requestId);
          if (requestId !== null) pendingNativeEditsRef.current.delete(requestId);
          if (requestId !== null && pending) {
            pendingSaveConfirmationsRef.current.set(requestId, {
              ...pending,
              ...(data.path === "cell:batch" ? { deferredBatchAck: nativeResult } : {})
            });
          }
          // Copilot batch success is deferred until the native editor has serialized XML. A graph-model
          // mutation acknowledgement alone is not proof that the resulting document was captured.
          if (data.path !== "cell:batch" || !pending) onNativeEditResultRef.current?.(nativeResult);
          recordDiagnostic("drawio.selection.property.updated", "Draw.io acknowledged a native cell property mutation", {
            cellId: data.cellId, property: data.path, value: pending?.value ?? null, requestId,
            durationMs: pending ? Date.now() - pending.startedAt : null, xmlLengthBefore: pending?.beforeXml.length ?? null
          });
          // "save" is an editor-to-host event, not a supported host action. Request native XML
          // serialization through the documented export action so programmatic mutations can be
          // acknowledged even when they do not trigger autosave.
          iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "xml" }), window.location.origin);
          recordDiagnostic("drawio.selection.property.save_requested", "Requested native Draw.io XML serialization after a property edit", {
            requestId, cellId: data.cellId, property: data.path, protocolAction: "export", format: "xml"
          });
        } else {
          const errorMessage = typeof data.error === "string" ? data.error : "Unknown property edit error";
          onNativeEditResultRef.current?.({ requestId, success: false, cellId: typeof data.cellId === "string" ? data.cellId : null, path: typeof data.path === "string" ? data.path : null, error: errorMessage,
            batchResults: Array.isArray(data.batchResults) ? data.batchResults as Array<{ index: number; cellId: string; path: string; value: string; success: boolean; error?: string }> : null,
            failedIndex: typeof data.failedIndex === "number" ? data.failedIndex : null,
            rollbackErrors: Array.isArray(data.rollbackErrors) ? data.rollbackErrors as Array<{ cellId: string; error: string }> : [] });
          const pending = requestId === null ? undefined : pendingNativeEditsRef.current.get(requestId);
          if (requestId !== null) pendingNativeEditsRef.current.delete(requestId);
          recordDiagnostic("drawio.selection.property.update.failed", "Draw.io rejected a native cell property mutation", {
            cellId: data.cellId, property: data.path, value: pending?.value ?? null, requestId,
            durationMs: pending ? Date.now() - pending.startedAt : null,
            errorMessage, failedIndex: data.failedIndex ?? null, batchResults: data.batchResults ?? null, rollbackErrors: data.rollbackErrors ?? [], batchRolledBack: data.batchRolledBack ?? null
          }, "error");
        }
      }
      if (data.event === "configure") {
        recordDiagnostic("drawio.handshake.configure", "Draw.io requested configuration");
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({
          action: "configure",
          config: { defaultFonts: ["Inter", "Arial"], defaultPageFormat: "A4", autosave: 1, noSaveBtn: true, noExitBtn: true }
        }), window.location.origin);
      }
      if (data.event === "load") {
        nativeDocumentLoadedRef.current = true;
        // Theme is presentation-only; do not modify Draw.io graph background on init.
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
      const pendingSerialization = pendingSaveConfirmationsRef.current.size > 0;
      const exportSerialization = data.event === "export" && data.format === "xml" && pendingSerialization;
      if ((data.event === "save" || data.event === "autosave" || exportSerialization) && typeof data.xml === "string") {
        const duplicateXml = data.xml === lastSent.current;
        try {
          if (!isDrawioXmlDocument(data.xml)) {
            setStartupError("Draw.io returned an invalid XML document. The previous saved source was preserved.");
            recordDiagnostic("drawio.document.xml.invalid", "Rejected a malformed native Draw.io XML payload", { event: data.event, xmlLength: data.xml.length }, "error");
            return;
          }
          const pendingSaves = Array.from(pendingSaveConfirmationsRef.current.entries());
          const deferredBatchAcks: NativeEditResult[] = [];
          for (const [requestId, pending] of pendingSaves) {
            const changed = data.xml !== pending.beforeXml;
            recordDiagnostic(changed ? "drawio.selection.property.save_confirmed" : "drawio.selection.property.save_unchanged",
              changed ? "Native Draw.io serialization confirmed XML changed after the acknowledged edit" : "Native Draw.io serialized XML but no XML difference from the edit baseline was observed",
              { requestId, cellId: pending.cellId, property: pending.path, value: pending.value,
                durationMs: Date.now() - pending.startedAt, xmlLengthBefore: pending.beforeXml.length, xmlLengthAfter: data.xml.length,
                xmlChanged: changed, saveEvent: data.event, serializedByExport: exportSerialization });
            if (pending.deferredBatchAck) deferredBatchAcks.push({ ...pending.deferredBatchAck, serializedXml: data.xml });
            pendingSaveConfirmationsRef.current.delete(requestId);
          }
          if (duplicateXml) {
            for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
            return;
          }
          lastSent.current = data.xml;
          recordDiagnostic("drawio.document.saved", "Native Draw.io XML autosave captured as the authoritative source", {
            event: data.event, xmlLength: data.xml.length
          });
          onDocumentChangeRef.current(data.xml);
          for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
        } catch (error) {
          recordDiagnostic("drawio.document.parse.failed", "Parsing the Draw.io autosave payload failed",
            { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
          setStartupError("Could not accept the Draw.io autosave payload. See Agent traces for details.");
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
    nativeDocumentLoadedRef.current = false;
    setBridgeReady(false);
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
