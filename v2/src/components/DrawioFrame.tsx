import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DiagramDocument } from "../model/types";
import { fromDrawioXml } from "../import/drawio";
import { isDrawioXmlDocument } from "../model/drawio-xml-source";
import { recordDiagnostic } from "../diagnostics";
import { applyDrawioThemeBackgroundReversible, drawioFrameThemeCss, type DrawioThemePalette } from "../model/drawio-theme";

const DRAWIO_VERSION = "v32.0.2";
const DRAWIO_SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
const EMBED_URL = "/drawio/index.html?embed=1&proto=json&configure=1&ui=min&lang=zh&format=0&sidebar=0&windows=0&noSaveBtn=1&noExitBtn=1";

interface CellPropertyEdit { cellId: string; pageId: string | null; path: string; value: string; requestId: number; }
interface Props {
  document: DiagramDocument;
  xml: string;
  onDocumentChange: (document: DiagramDocument, nativeXml: string) => void;
  onSelectionChange: (cellId: string | null, pageId: string | null) => void;
  cellEdit: CellPropertyEdit | null;
  theme: string;
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

export default function DrawioFrame({ document, xml, onDocumentChange, onSelectionChange, cellEdit, theme }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const documentRef = useRef(document);
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const lastHandledCellEditRequestRef = useRef<number | null>(null);
  const iframeLoadedRef = useRef(false);
  documentRef.current = document;
  onDocumentChangeRef.current = onDocumentChange;
  onSelectionChangeRef.current = onSelectionChange;
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

    const themedXml = applyDrawioThemeBackgroundReversible(xml, palette.canvas, theme as "editorial" | "youth" | "warm" | "midnight");

    // Use Draw.io's own graph view API as the visual adapter. This also covers
    // compressed <diagram> payloads where no mxGraphModel tag is visible in XML.
    const editorWindow = iframeRef.current?.contentWindow as (Window & {
      editorUi?: { editor?: { graph?: {
        background?: string;
        refresh?: () => void;
        view?: { validateBackground?: () => void };
      } } };
    }) | null;
    const graph = editorWindow?.editorUi?.editor?.graph;
    if (graph) {
      const storedBackground = /\bstudioThemeOriginalBackground=(["'])(.*?)\1/.exec(themedXml)?.[2];
      const explicitBackground = /\bbackground=(["'])(.*?)\1/.exec(themedXml)?.[2];
      graph.background = theme === "editorial" ? (storedBackground && storedBackground !== "__none__" ? storedBackground : explicitBackground || palette.canvas) : palette.canvas;
      graph.view?.validateBackground?.();
      graph.refresh?.();
    }

    // For uncompressed XML pages, persist the corresponding mxGraphModel background
    // attribute without touching cell styles. Compressed pages use the graph API above.
    if (editorReady && themedXml !== xml) {
      recordDiagnostic("drawio.theme.background.applied", "Applied the selected Studio theme to the native Draw.io model background", {
        theme, background: palette.canvas, xmlChanged: true
      });
      onDocumentChangeRef.current(documentRef.current, themedXml);
    }
  }, [theme, editorReady, iframeLoaded, xml]);

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


  useEffect(() => {
    if (!cellEdit || !editorReady || lastHandledCellEditRequestRef.current === cellEdit.requestId) return;
    const editorWindow = iframeRef.current?.contentWindow as (Window & { editorUi?: { editor?: { graph?: any }; currentPage?: { id?: string; getId?: () => string } } }) | null;
    const graph = editorWindow?.editorUi?.editor?.graph;
    const model = graph?.getModel?.();
    if (!graph || !model) return;
    const currentPage = editorWindow?.editorUi?.currentPage;
    const currentPageId = currentPage?.getId?.() ?? currentPage?.id ?? null;
    if (cellEdit.pageId && currentPageId && cellEdit.pageId !== currentPageId) {
      lastHandledCellEditRequestRef.current = cellEdit.requestId;
      recordDiagnostic("drawio.selection.property.stale-page", "Ignored a property edit after the active Draw.io page changed", {
        cellId: cellEdit.cellId, requestedPageId: cellEdit.pageId, currentPageId
      }, "warn");
      return;
    }
    const cell = model.getCell?.(cellEdit.cellId);
    if (!cell) {
      lastHandledCellEditRequestRef.current = cellEdit.requestId;
      recordDiagnostic("drawio.selection.property.cell-missing", "Ignored a property edit because the selected cell no longer exists", { cellId: cellEdit.cellId }, "warn");
      return;
    }
    lastHandledCellEditRequestRef.current = cellEdit.requestId;
    const { path, value } = cellEdit;
    try {
      model.beginUpdate();
      try {
        if (path === "label") {
          const current = cell.value;
          if (current && typeof current === "object" && current.nodeType === 1) {
            const next = current.cloneNode(true) as Element;
            next.setAttribute(next.hasAttribute("label") ? "label" : "value", value);
            model.setValue(cell, next);
          } else model.setValue(cell, value);
        } else if (path === "style") {
          model.setStyle(cell, value);
        } else if (path.startsWith("style:")) {
          const key = path.slice("style:".length);
          const styles = String(model.getStyle(cell) || "").split(";").filter(Boolean);
          let found = false;
          const normalized = value.toLowerCase();
          const remove = value === "" || normalized === "0" || normalized === "false";
          const flag = normalized === "1" || normalized === "true";
          const next = styles.map((part: string) => {
            const index = part.indexOf("=");
            const partKey = index > 0 ? part.slice(0, index) : part;
            if (partKey === key) {
              found = true;
              return remove ? "" : flag ? key : key + "=" + value;
            }
            return part;
          }).filter(Boolean);
          if (!found && !remove) next.push(flag ? key : key + "=" + value);
          model.setStyle(cell, next.join(";") + (next.length ? ";" : ""));
        } else if (path.startsWith("point:") && cell.geometry) {
          const [, indexText, axis] = path.split(":");
          const index = Number(indexText);
          const numeric = Number(value);
          const geometry = cell.geometry.clone();
          if (!Number.isInteger(index) || index < 0 || !Number.isFinite(numeric) || (axis !== "x" && axis !== "y")) {
            throw new Error("Connector control point coordinates must be numeric");
          }
          const points = (geometry.points || []).map((point: { clone?: () => unknown }) =>
            typeof point.clone === "function" ? point.clone() : { ...point }
          ) as Array<Record<string, unknown>>;
          if (!points[index]) throw new Error("Connector control point no longer exists");
          points[index][axis] = numeric;
          geometry.points = points as never;
          model.setGeometry(cell, geometry);
        } else if (path.startsWith("geometry:") && cell.geometry) {
          const key = path.slice("geometry:".length);
          const geometry = cell.geometry.clone();
          if (key === "relative") {
            const normalized = value.toLowerCase();
            if (!["1", "0", "true", "false"].includes(normalized)) throw new Error("relative must be 1/0 or true/false");
            geometry.relative = normalized === "1" || normalized === "true";
          } else if (["x", "y", "width", "height"].includes(key)) {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) throw new Error("Geometry must be numeric");
            (geometry as unknown as Record<string, unknown>)[key] = numeric;
          }
          model.setGeometry(cell, geometry);
        } else if (path.startsWith("cell:")) {
          const key = path.slice("cell:".length);
          if (["visible", "collapsed", "connectable"].includes(key)) {
            const normalized = value.toLowerCase();
            if (!["1", "0", "true", "false"].includes(normalized)) throw new Error(key + " must be 1/0 or true/false");
            const enabled = normalized === "1" || normalized === "true";
            if (key === "visible") model.setVisible(cell, enabled);
            else if (key === "collapsed") model.setCollapsed(cell, enabled);
            else model.setConnectable(cell, enabled);
          } else if (key === "source" || key === "target") {
            const terminal = value ? model.getCell(value) : null;
            if (value && !terminal) throw new Error("No cell exists with id " + value);
            model.setTerminal(cell, terminal, key === "source");
          } else if (key === "parent") {
            if (cell.id === "0" || cell.id === "1") throw new Error("The Draw.io root and default layer cannot be reparented");
            const parent = model.getCell(value);
            if (!parent) throw new Error("No parent cell exists with id " + value);
            let ancestor = parent;
            while (ancestor) {
              if (ancestor === cell) throw new Error("A cell cannot be moved into itself or one of its descendants");
              ancestor = ancestor.parent;
            }
            model.add(parent, cell, model.getChildCount(parent));
          }
        } else if (path.startsWith("valueAttr:")) {
          const key = path.slice("valueAttr:".length);
          const current = cell.value;
          if (current && typeof current === "object" && current.nodeType === 1) {
            const next = current.cloneNode(true) as Element;
            if (value === "") next.removeAttribute(key); else next.setAttribute(key, value);
            model.setValue(cell, next);
          }
        }
      } finally { model.endUpdate(); }
      graph.refresh?.();
      recordDiagnostic("drawio.selection.property.updated", "Updated a selected native Draw.io cell property", { cellId: cellEdit.cellId, property: path });
    } catch (error) {
      recordDiagnostic("drawio.selection.property.update.failed", "Could not update the selected native Draw.io cell property", {
        cellId: cellEdit.cellId, property: path, errorMessage: error instanceof Error ? error.message : String(error)
      }, "error");
    }
  }, [cellEdit, editorReady]);


  useEffect(() => {
    if (!editorReady) return;
    const editorWindow = iframeRef.current?.contentWindow as (Window & {
      editorUi?: {
        editor?: { graph?: {
          getSelectionModel?: () => { addListener?: (name: string, listener: () => void) => void; removeListener?: (listener: () => void) => void };
          getSelectionCells?: () => Array<{ id?: string; getId?: () => string }>;
        } };
        currentPage?: { id?: string; getId?: () => string };
      };
    }) | null;
    const graph = editorWindow?.editorUi?.editor?.graph;
    const selectionModel = graph?.getSelectionModel?.();
    if (!graph || !selectionModel?.addListener) {
      recordDiagnostic("drawio.selection.listener.unavailable", "The native Draw.io selection model was not available after initialization", { frameKey }, "warn");
      return;
    }
    const onSelectionChanged = () => {
      const selected = graph.getSelectionCells?.() ?? [];
      const id = selected[0]?.getId?.() ?? selected[0]?.id ?? null;
      const page = editorWindow?.editorUi?.currentPage;
      const pageId = page?.getId?.() ?? page?.id ?? null;
      onSelectionChangeRef.current(typeof id === "string" && id ? id : null, typeof pageId === "string" && pageId ? pageId : null);
    };
    selectionModel.addListener("change", onSelectionChanged);
    onSelectionChanged();
    recordDiagnostic("drawio.selection.listener.ready", "Attached to the native Draw.io selection model", { frameKey });
    return () => selectionModel.removeListener?.(onSelectionChanged);
  }, [editorReady, frameKey]);

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
          if (!isDrawioXmlDocument(data.xml)) {
            setStartupError("Draw.io returned an invalid XML document. The previous saved source was preserved.");
            recordDiagnostic("drawio.document.xml.invalid", "Rejected a malformed native Draw.io XML payload", { event: data.event, xmlLength: data.xml.length }, "error");
            return;
          }
          // The XML is authoritative even when its cells cannot be mapped into the partial
          // Studio projection. In that case keep the old projection and persist the complete XML.
          const next = fromDrawioXml(data.xml, currentDocument);
          const projection = next === currentDocument ? currentDocument : next;
          recordDiagnostic("drawio.document.saved", "Native Draw.io XML autosave captured as the authoritative source", {
            event: data.event, xmlLength: data.xml.length, projectionMapped: next !== currentDocument,
            nodeCount: projection.nodes.length, relationCount: projection.relations.length
          });
          onDocumentChangeRef.current(projection, data.xml);
        } catch (error) {
          recordDiagnostic("drawio.document.parse.failed", "Parsing the Draw.io autosave payload failed",
            { errorName: error instanceof Error ? error.name : typeof error, errorMessage: error instanceof Error ? error.message : String(error) }, "error");
          setStartupError("Could not parse the Draw.io autosave payload; the semantic projection is not synced yet. See the agent trace for details.");
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
