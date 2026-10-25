import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { normalizeDrawioRuntimeInspection, PINNED_DRAWIO_VERSION, type DrawioRuntimeInspection } from "../model/drawio-runtime-contract";
import { isDrawioXmlDocument } from "../model/drawio-xml-source";
import { nativeEditIsReflectedInXml, summarizeNativeDiagramXmlDiff } from "../model/native-edit-confirmation";
import { recordDiagnostic } from "../diagnostics";
import { calculateDrawioXmlRevision } from "../intent/aiProvider";
import { drawioFrameThemeCss, type DrawioThemePalette } from "../model/drawio-theme";
import type { DrawioDiagramStyle } from "../model/drawio-style-library";
import { DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS, type NativeAutoLayoutOptions, type NativeLayoutPlan } from "../layout/native-layout";

export const DRAWIO_VERSION = PINNED_DRAWIO_VERSION;
const DRAWIO_SHA256 = "3cb8abec8e9bfc7504760c9cdc9194ecf7e8de178aa2a1d668801c32ecf1a1a7";
/**
 * Keep the native shape panel available in the embedded editor. `libraries=1`
 * enables palettes in embed mode; omitting `sidebar=0` prevents hiding the panel.
 */
export const DRAWIO_PORT = (() => {
  const configured = import.meta.env.VITE_STUDIO_DRAWIO_PORT || "4176";
  const value = Number(configured);
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? String(value) : "4176";
})();
const DRAWIO_ORIGIN = "http://127.0.0.1:" + DRAWIO_PORT;
// Draw.io semantics: noSaveBtn=1 replaces Save with Save & Exit unless saveAndExit=0 is also set.
export const DRAWIO_EMBED_URL = DRAWIO_ORIGIN + "/index.html?embed=1&proto=json&configure=1&ui=min&lang=zh&format=0&libraries=1&saveAndExit=0&noSaveBtn=1&noExitBtn=1";

/**
 * C4 is built into the pinned Draw.io bundle as the `c4` palette. The version bump
 * intentionally refreshes older persisted library preferences so C4 is visible by default.
 */
export const DRAWIO_EDITOR_CONFIG = {
  version: "2026-10-c4-default-library-v2",
  defaultFonts: ["Inter", "Arial"],
  defaultPageFormat: "A4",
  defaultLibraries: "general;uml;er;bpmn;flowchart;basic;arrows2;c4",
  autosave: 1,
  saveAndExit: false,
  noSaveBtn: true,
  noExitBtn: true
} as const;
const NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS = 30_000;
const RUNTIME_INSPECTION_TIMEOUT_MS = 5_000;
const AUTO_LAYOUT_TIMEOUT_MS = 30_000;

export { DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS };
export type { NativeAutoLayoutOptions, NativeLayoutPlan };

export interface DrawioFrameHandle {
  inspectRuntime(input: { documentRevision: string; pageId: string | null; jsShapeClassNames?: string[] }): Promise<DrawioRuntimeInspection>;
  /** Applies a revision/page-bound Dagre or ELK geometry plan to native Draw.io cells. */
  applyAutoLayout(plan: NativeLayoutPlan): Promise<string>;
  /** Reloads the editor from the latest XML retained by Studio after a synchronous script hangs. */
  recoverFromLastSavedXml(): void;
  /** Apply a selected document style through one native Draw.io model transaction and export its XML. */
  applyDiagramStyle(style: DrawioDiagramStyle | null): Promise<string>;
  /** Set the style for newly created/pasted cells without mutating existing XML. */
  setActiveDiagramStyle(style: DrawioDiagramStyle | null): Promise<void>;
  /** Read the exact XML serialized by Draw.io without treating a read as a document edit. */
  exportCurrentXml(): Promise<string>;
}

interface CellPropertyEdit { cellId: string; pageId: string | null; path: string; value: string; requestId: number; }
type NativeEditResult = {
  requestId: number | null;
  success: boolean;
  cellId: string | null;
  path: string | null;
  error?: string;
  errorStack?: string;
  batchResults?: Array<{ index: number; cellId: string; path: string; value: string; success: boolean; error?: string; stack?: string }> | null;
  failedIndex?: number | null;
  rollbackErrors?: Array<{ cellId: string; error: string }>;
  batchRolledBack?: boolean | null;
  /** XML returned by the native Draw.io save protocol after a Copilot batch. */
  serializedXml?: string;
  /** Set by the host when the editor accepted the edit but required persistence failed. */
  failureStage?: "editor" | "persistence";
  auditWarning?: string;
  /** Bounded JSON-safe value returned by a native script after its own postcondition checks. */
  scriptResult?: unknown;
};
type PendingNativeEdit = { cellId: string; pageId: string | null; path: string; value: string; startedAt: number; beforeXml: string };
type PendingSaveConfirmation = PendingNativeEdit & { deferredBatchAck?: NativeEditResult; scriptResult?: unknown; timeoutId?: number; captureOnFailure?: boolean };
type PendingRuntimeInspection = {
  resolve: (inspection: DrawioRuntimeInspection) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  documentRevision: string;
  pageId: string | null;
};
type PendingAutoLayout = {
  resolve: (xml: string) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  startedAt: number;
  awaitingExport: boolean;
  requestId: string;
  plan: NativeLayoutPlan;
};
type PendingDiagramStyle = {
  resolve: (xml: string | null) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  apply: boolean;
  awaitingExport: boolean;
};
type PendingBaselineExport = {
  resolve: (xml: string) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};
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

const DrawioFrame = forwardRef<DrawioFrameHandle, Props>(function DrawioFrame({ xml, onDocumentChange, onSelectionChange, onNativeEditResult, cellEdit, theme, onEditorStatusChange }: Props, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const xmlRef = useRef(xml);
  xmlRef.current = xml;
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onNativeEditResultRef = useRef(onNativeEditResult);
  const lastHandledCellEditRequestRef = useRef<number | null>(null);
  const pendingNativeEditsRef = useRef(new Map<number, PendingNativeEdit>());
  const pendingSaveConfirmationsRef = useRef(new Map<number, PendingSaveConfirmation>());
  const pendingRuntimeInspectionsRef = useRef(new Map<string, PendingRuntimeInspection>());
  const pendingAutoLayoutRef = useRef<PendingAutoLayout | null>(null);
  const pendingDiagramStylesRef = useRef(new Map<string, PendingDiagramStyle>());
  const pendingBaselineExportRef = useRef<PendingBaselineExport | null>(null);
  const diagramStyleSequenceRef = useRef(0);
  const runtimeInspectionSequenceRef = useRef(0);
  const iframeLoadedRef = useRef(false);
  const nativeDocumentLoadedRef = useRef(false);
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

  function finishPendingAutoLayout(xml: string) {
    const pending = pendingAutoLayoutRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingAutoLayoutRef.current = null;
    recordDiagnostic("drawio.layout.completed", "Native Draw.io auto layout was applied and serialized", {
      durationMs: Date.now() - pending.startedAt, xmlLength: xml.length,
      engine: pending.plan.engine, algorithm: pending.plan.algorithm, direction: pending.plan.direction,
      positionCount: pending.plan.positions.length, edgeRouteCount: pending.plan.edgeRoutes.length,
      documentRevision: pending.plan.documentRevision, pageId: pending.plan.pageId
    });
    pending.resolve(xml);
  }

  function rejectPendingAutoLayout(error: Error) {
    const pending = pendingAutoLayoutRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingAutoLayoutRef.current = null;
    recordDiagnostic("drawio.layout.failed", "Native Draw.io auto layout could not be confirmed", {
      durationMs: Date.now() - pending.startedAt, errorMessage: error.message,
      engine: pending.plan.engine, algorithm: pending.plan.algorithm, direction: pending.plan.direction,
      documentRevision: pending.plan.documentRevision, pageId: pending.plan.pageId
    }, "error");
    pending.reject(error);
  }

  function settleDiagramStyle(requestId: string, result: { xml?: string | null; error?: Error }) {
    const pending = pendingDiagramStylesRef.current.get(requestId);
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingDiagramStylesRef.current.delete(requestId);
    if (result.error) pending.reject(result.error);
    else pending.resolve(result.xml ?? null);
  }

  function settleBaselineExport(result: { xml?: string; error?: Error }) {
    const pending = pendingBaselineExportRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingBaselineExportRef.current = null;
    if (result.error) pending.reject(result.error);
    else pending.resolve(result.xml ?? "");
  }

  function exportCurrentXml(): Promise<string> {
    return new Promise((resolve, reject) => {
      const target = iframeRef.current?.contentWindow;
      if (!editorReady || !bridgeReady || !target) {
        reject(new Error("The native Draw.io editor is not ready to export XML."));
        return;
      }
      if (pendingBaselineExportRef.current || pendingDiagramStylesRef.current.size > 0 ||
          pendingSaveConfirmationsRef.current.size > 0 || pendingAutoLayoutRef.current) {
        reject(new Error("Wait for the current native export or edit to finish before reading the current XML."));
        return;
      }
      const timeoutId = window.setTimeout(() => {
        settleBaselineExport({ error: new Error("Draw.io did not return the current XML within 30 seconds.") });
      }, NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS);
      pendingBaselineExportRef.current = { resolve, reject, timeoutId };
      try {
        target.postMessage(JSON.stringify({ action: "export", format: "xml" }), DRAWIO_ORIGIN);
      } catch (error) {
        settleBaselineExport({ error: new Error("Could not request current native XML: " +
          (error instanceof Error ? error.message : String(error))) });
      }
    });
  }

  function requestDiagramStyle(style: DrawioDiagramStyle | null, apply: boolean): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const target = iframeRef.current?.contentWindow;
      if (!editorReady || !bridgeReady || !target) {
        reject(new Error("The native Draw.io editor is not ready for diagram styling."));
        return;
      }
      if (pendingDiagramStylesRef.current.size > 0) {
        reject(new Error("A diagram-style operation is already running."));
        return;
      }
      if (apply && (pendingNativeEditsRef.current.size > 0 || pendingSaveConfirmationsRef.current.size > 0 || pendingAutoLayoutRef.current)) {
        reject(new Error("Wait for the current native edit or layout operation to finish before changing diagram style."));
        return;
      }
      const requestId = "diagram-style-" + (++diagramStyleSequenceRef.current) + "-" + Date.now();
      const timeoutId = window.setTimeout(() => {
        settleDiagramStyle(requestId, { error: new Error("Draw.io did not confirm the diagram-style operation within 30 seconds.") });
      }, NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS);
      pendingDiagramStylesRef.current.set(requestId, { resolve, reject, timeoutId, apply, awaitingExport: false });
      try {
        target.postMessage(JSON.stringify({
          event: "studioDiagramStyleRequest",
          requestId,
          apply,
          style: style ? JSON.parse(JSON.stringify(style)) : null
        }), DRAWIO_ORIGIN);
        recordDiagnostic(apply ? "drawio.style.apply.requested" : "drawio.style.activation.requested",
          apply ? "Requested a native Draw.io document-style transformation" : "Set the current style for future native cells",
          { requestId, styleId: style?.id ?? "original", drawioVersion: DRAWIO_VERSION });
      } catch (error) {
        settleDiagramStyle(requestId, { error: new Error("Could not send the diagram-style request: " +
          (error instanceof Error ? error.message : String(error))) });
      }
    });
  }

  useImperativeHandle(ref, () => ({
    exportCurrentXml,
    applyDiagramStyle: async (style) => {
      const result = await requestDiagramStyle(style, true);
      if (typeof result !== "string") throw new Error("Draw.io did not return the transformed XML.");
      return result;
    },
    setActiveDiagramStyle: async (style) => {
      await requestDiagramStyle(style, false);
    },
    applyAutoLayout: async (plan) => {
      const currentRevision = await calculateDrawioXmlRevision(xmlRef.current);
      if (currentRevision !== plan.documentRevision) {
        throw new Error("The native Draw.io XML changed after layout calculation. No layout was applied; recalculate and retry.");
      }
      return await new Promise<string>((resolve, reject) => {
      const target = iframeRef.current?.contentWindow;
      if (!editorReady || !bridgeReady || !target) {
        reject(new Error("The native Draw.io editor is not ready for auto layout."));
        return;
      }
      if (pendingAutoLayoutRef.current) {
        reject(new Error("An auto layout operation is already running."));
        return;
      }
      if (pendingNativeEditsRef.current.size > 0 || pendingSaveConfirmationsRef.current.size > 0) {
        reject(new Error("Wait for the current native edit to finish saving before applying auto layout."));
        return;
      }
      // The iframe validates the live page ID, full native cell set, geometry and connector terminals
      // against this plan before mutating anything. Do not compare against the first XML page here:
      // Draw.io documents may contain multiple pages, and the selected page need not be the first.
      if (!plan.positions.length || plan.positions.length > 5000 ||
          plan.expectedPageCellIds.length > 20000 || plan.expectedCells.length > 10000) {
        reject(new Error("The layout plan is empty or exceeds the native editor safety limit."));
        return;
      }

      const requestId = "layout-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
      const timeoutId = window.setTimeout(() => {
        rejectPendingAutoLayout(new Error("Draw.io did not confirm Studio auto layout and XML serialization within 30 seconds."));
      }, AUTO_LAYOUT_TIMEOUT_MS);
      pendingAutoLayoutRef.current = { resolve, reject, timeoutId, startedAt: Date.now(), awaitingExport: false, requestId, plan };
      try {
        target.postMessage(JSON.stringify({
          event: "studioNativeLayoutRequest",
          requestId,
          plan
        }), DRAWIO_ORIGIN);
        recordDiagnostic("drawio.layout.requested", "Sent a revision-bound Dagre/ELK plan to the native Draw.io editor", {
          drawioVersion: DRAWIO_VERSION, engine: plan.engine, algorithm: plan.algorithm,
          direction: plan.direction, positionCount: plan.positions.length,
          edgeRouteCount: plan.edgeRoutes.length, expectedCellCount: plan.expectedCells.length,
          documentRevision: plan.documentRevision, pageId: plan.pageId
        });
      } catch (error) {
        rejectPendingAutoLayout(new Error("Could not send the native layout plan to Draw.io: " +
          (error instanceof Error ? error.message : String(error))));
      }
      });
    },
    recoverFromLastSavedXml: () => retryEditor(true),
    inspectRuntime: ({ documentRevision, pageId, jsShapeClassNames }) => new Promise((resolve, reject) => {
      const target = iframeRef.current?.contentWindow;
      if (!editorReady || !bridgeReady || !target) {
        reject(new Error("The native Draw.io runtime is not ready for inspection. Wait for the editor status to become ready, then retry."));
        return;
      }
      const requestId = "runtime-inspect-" + (++runtimeInspectionSequenceRef.current);
      const timeoutId = window.setTimeout(() => {
        const pending = pendingRuntimeInspectionsRef.current.get(requestId);
        if (!pending) return;
        pendingRuntimeInspectionsRef.current.delete(requestId);
        reject(new Error("The native Draw.io runtime did not answer the read-only inspection request within 5 seconds."));
      }, RUNTIME_INSPECTION_TIMEOUT_MS);
      pendingRuntimeInspectionsRef.current.set(requestId, { resolve, reject, timeoutId, documentRevision, pageId });
      try {
        target.postMessage(JSON.stringify({
          event: "studioRuntimeInspectRequest",
          requestId,
          documentRevision,
          drawioVersion: DRAWIO_VERSION,
          expectedPageId: pageId,
          maxCells: 60,
          maxRenderedEdges: 24,
          jsShapeClassNames: Array.isArray(jsShapeClassNames) ? jsShapeClassNames.slice(0, 40) : []
        }), DRAWIO_ORIGIN);
        recordDiagnostic("drawio.runtime-inspection.requested", "Requested a read-only snapshot of the live native Draw.io runtime", {
          requestId, documentRevision, pageId, drawioVersion: DRAWIO_VERSION
        });
      } catch (error) {
        window.clearTimeout(timeoutId);
        pendingRuntimeInspectionsRef.current.delete(requestId);
        reject(new Error("Could not send the Draw.io runtime inspection request: " + (error instanceof Error ? error.message : String(error))));
      }
    })
  }), [editorReady, bridgeReady]);

  useEffect(() => () => {
    for (const pending of pendingSaveConfirmationsRef.current.values()) {
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
    }
    pendingSaveConfirmationsRef.current.clear();
    pendingNativeEditsRef.current.clear();
    rejectPendingAutoLayout(new Error("Draw.io editor closed before auto layout completed."));
    for (const pending of pendingRuntimeInspectionsRef.current.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error("Draw.io editor was closed before runtime inspection completed."));
    }
    pendingRuntimeInspectionsRef.current.clear();
    for (const requestId of Array.from(pendingDiagramStylesRef.current.keys())) {
      settleDiagramStyle(requestId, { error: new Error("Draw.io editor was closed before diagram styling completed.") });
    }
    settleBaselineExport({ error: new Error("Draw.io editor was closed before the native XML export completed.") });
  }, []);

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
        iframeLoaded, ready: editorReady, url: DRAWIO_EMBED_URL, timeoutMs: 20000
      }, "error");
    }, 20_000);
    return () => window.clearTimeout(timeout);
  }, [available, editorReady, iframeLoaded]);

  // The isolated Draw.io frame is styled through the exact-origin bridge.
  useEffect(() => {
    if (!bridgeReady || !iframeRef.current?.contentWindow) return;
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    if (!appShell) return;
    const computed = window.getComputedStyle(appShell);
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
    const css = drawioFrameThemeCss(palette);
    iframeRef.current.contentWindow.postMessage(JSON.stringify({
      event: "studioPresentationThemeRequest",
      css,
      theme
    }), DRAWIO_ORIGIN);
    recordDiagnostic("drawio.presentation-theme.requested", "Sent presentation-only theme CSS over the isolated Draw.io bridge", {
      theme, cssLength: css.length
    });
  }, [theme, editorReady, iframeLoaded, bridgeReady]);


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
        DRAWIO_ORIGIN
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
    }), DRAWIO_ORIGIN);
    recordDiagnostic("drawio.selection.property.requested", "Sent a native property edit through the Draw.io plugin bridge", {
      cellId: cellEdit.cellId, property: cellEdit.path, value: cellEdit.value, requestId: cellEdit.requestId,
      pageId: cellEdit.pageId, xmlLengthBefore: xml.length
    });
    pendingNativeEditsRef.current.set(cellEdit.requestId, { cellId: cellEdit.cellId, pageId: cellEdit.pageId, path: cellEdit.path, value: cellEdit.value, startedAt: Date.now(), beforeXml: xml });
  }, [cellEdit, editorReady, bridgeReady]);

  useLayoutEffect(() => {
    // Install the message listener in the commit phase before the iframe can finish loading
    // and send its configure/init handshake. Keep it stable across document and callback changes.
    function receive(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.origin !== DRAWIO_ORIGIN) {
        recordDiagnostic("drawio.message.origin_rejected", "Ignored a Draw.io message from an unexpected origin", {
          origin: event.origin, expectedOrigin: DRAWIO_ORIGIN
        }, "warn");
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
      if (data.event === "studioDrawioHello") {
        // The child hello contains no sensitive data. Require the exact iframe source/origin
        // above, then reply only to that dedicated Draw.io origin.
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "studioDrawioWelcome" }), DRAWIO_ORIGIN);
        recordDiagnostic("drawio.bridge.handshake.hello", "Accepted a Draw.io bridge hello from the isolated local origin", {
          origin: event.origin, expectedOrigin: DRAWIO_ORIGIN
        });
        return;
      }
      if (typeof data.event === "string" && !seenEvents.current.has(data.event)) {
        seenEvents.current.add(data.event);
        recordDiagnostic("drawio.message.first_seen", "First Draw.io embed protocol event received", {
          event: data.event, fields: Object.keys(data).slice(0, 20), origin: event.origin
        });
      }

      if (data.event === "studioRuntimeInspectResult") {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const pending = requestId ? pendingRuntimeInspectionsRef.current.get(requestId) : undefined;
        if (requestId && pending) {
          window.clearTimeout(pending.timeoutId);
          pendingRuntimeInspectionsRef.current.delete(requestId);
          if (data.success !== true) {
            const message = typeof data.error === "string" ? data.error : "The native Draw.io runtime inspection failed.";
            pending.reject(new Error(message));
          } else {
            const inspection = normalizeDrawioRuntimeInspection(data.inspection, {
              documentRevision: pending.documentRevision,
              pageId: pending.pageId,
              drawioVersion: DRAWIO_VERSION
            });
            if (!inspection) {
              pending.reject(new Error("The runtime inspection did not match the pinned Draw.io version, active page, and source document revision."));
            } else {
              recordDiagnostic("drawio.runtime-inspection.completed", "Received a bounded read-only snapshot of the live native Draw.io runtime", {
                requestId, documentRevision: inspection.documentRevision, pageId: inspection.pageId,
                cellCount: inspection.counts.cells, vertexCount: inspection.counts.vertices, edgeCount: inspection.counts.edges,
                returnedCells: inspection.cells.length, returnedRenderedEdges: inspection.renderedEdges.length,
                truncated: inspection.truncated,
                graphMethodCount: inspection.capabilities.graph.length, modelMethodCount: inspection.capabilities.model.length,
                viewMethodCount: inspection.capabilities.view.length
              });
              pending.resolve(inspection);
            }
          }
        }
      }
      if (data.event === "studioBridgeReady") {
        setBridgeReady(true);
        const advertisedVersion = typeof data.drawioVersion === "string" ? data.drawioVersion : null;
        const manifest = data.capabilityManifest && typeof data.capabilityManifest === "object"
          ? data.capabilityManifest as { scriptSupported?: unknown; missing?: Record<string, unknown> }
          : null;
        const missing = manifest?.missing && typeof manifest.missing === "object" ? manifest.missing : {};
        const hasMissing = ["graph", "model", "view"].some((group) =>
          Array.isArray(missing[group]) && (missing[group] as unknown[]).length > 0
        );
        const compatible = advertisedVersion === DRAWIO_VERSION && manifest?.scriptSupported === true && !hasMissing;
        // In local AI-first mode the manifest is diagnostic evidence, never a permission gate.
        recordDiagnostic(compatible ? "drawio.runtime-manifest.compatible" : "drawio.runtime-manifest.diagnostic-mismatch",
          compatible ? "The observed Draw.io runtime manifest matches the curated contract" : "The observed Draw.io runtime manifest differs from the curated contract; direct script execution remains enabled",
          { frameKey, advertisedVersion, expectedVersion: DRAWIO_VERSION, missing }, compatible ? "info" : "warn");
        recordDiagnostic("drawio.bridge.ready", "Native Draw.io selection and property bridge is ready", { frameKey });
        recordDiagnostic("drawio.plugin.bridge.ready", "The native Draw.io selection and property-edit plugin is ready", { frameKey });
      }
      if (data.event === "studioDiagramStyleResult") {
        const requestId = typeof data.requestId === "string" ? data.requestId : "";
        const pending = pendingDiagramStylesRef.current.get(requestId);
        if (!pending) {
          recordDiagnostic("drawio.style.acknowledgement.unmatched", "Ignored a diagram-style response without a pending request", { requestId }, "warn");
          return;
        }
        if (data.success !== true) {
          settleDiagramStyle(requestId, { error: new Error(typeof data.error === "string" ? data.error.slice(0, 1000) : "Draw.io rejected the diagram style.") });
        } else if (!pending.apply) {
          recordDiagnostic("drawio.style.activation.acknowledged", "Draw.io acknowledged the active style for new cells", { requestId, styleId: data.styleId ?? null });
          settleDiagramStyle(requestId, { xml: null });
        } else {
          pending.awaitingExport = true;
          try {
            iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "xml" }), DRAWIO_ORIGIN);
          } catch (error) {
            settleDiagramStyle(requestId, { error: new Error("Draw.io applied the style but XML export could not be requested: " +
              (error instanceof Error ? error.message : String(error))) });
          }
        }
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
            batchResults: Array.isArray(data.batchResults) ? data.batchResults as NativeEditResult["batchResults"] : null,
            ...(data.scriptResult !== undefined ? { scriptResult: data.scriptResult } : {})
          };
          const pending = requestId === null ? undefined : pendingNativeEditsRef.current.get(requestId);
          if (requestId !== null) pendingNativeEditsRef.current.delete(requestId);
          if (requestId !== null && pending) {
            const previous = pendingSaveConfirmationsRef.current.get(requestId);
            if (previous?.timeoutId !== undefined) window.clearTimeout(previous.timeoutId);
            const confirmation: PendingSaveConfirmation = {
              ...pending,
              ...(data.scriptResult !== undefined ? { scriptResult: data.scriptResult } : {}),
              ...(data.path === "cell:batch" ? { deferredBatchAck: nativeResult } : {})
            };
            confirmation.timeoutId = window.setTimeout(() => {
              if (pendingSaveConfirmationsRef.current.get(requestId) !== confirmation) return;
              pendingSaveConfirmationsRef.current.delete(requestId);
              const originalError = confirmation.deferredBatchAck?.error;
              const errorMessage = confirmation.captureOnFailure
                ? "The failed script's resulting XML could not be serialized within 30 seconds; the last saved XML was preserved." +
                  (originalError ? " Original script error: " + originalError : "")
                : "Draw.io acknowledged the native edit but did not serialize XML within 30 seconds.";
              recordDiagnostic("drawio.selection.property.save-confirmation.timeout",
                confirmation.captureOnFailure
                  ? "Timed out while capturing the native XML state after a failed script"
                  : "Timed out waiting for a serialized XML snapshot after a native property edit",
                { requestId, cellId: confirmation.cellId, property: confirmation.path, captureOnFailure: confirmation.captureOnFailure === true,
                  timeoutMs: NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS,
                  durationMs: Date.now() - confirmation.startedAt }, "warn");
              if (confirmation.deferredBatchAck) {
                onNativeEditResultRef.current?.({
                  ...confirmation.deferredBatchAck,
                  success: false,
                  error: errorMessage,
                  failureStage: "editor",
                  auditWarning: "The edit was not confirmed by a serialized document; verify the canvas before retrying."
                });
              }
            }, NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS);
            pendingSaveConfirmationsRef.current.set(requestId, confirmation);
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
          iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "xml" }), DRAWIO_ORIGIN);
          recordDiagnostic("drawio.selection.property.save_requested", "Requested native Draw.io XML serialization after a property edit", {
            requestId, cellId: data.cellId, property: data.path, protocolAction: "export", format: "xml"
          });
        } else {
          const errorMessage = typeof data.error === "string" ? data.error : "Unknown property edit error";
          const errorStack = typeof data.errorStack === "string" ? data.errorStack.slice(0, 8000) : undefined;
          const failedResult: NativeEditResult = {
            requestId, success: false,
            cellId: typeof data.cellId === "string" ? data.cellId : null,
            path: typeof data.path === "string" ? data.path : null,
            error: errorMessage,
            errorStack,
            batchResults: Array.isArray(data.batchResults) ? data.batchResults as NativeEditResult["batchResults"] : null,
            failedIndex: typeof data.failedIndex === "number" ? data.failedIndex : null,
            rollbackErrors: Array.isArray(data.rollbackErrors) ? data.rollbackErrors as Array<{ cellId: string; error: string }> : [],
            batchRolledBack: typeof data.batchRolledBack === "boolean" ? data.batchRolledBack : null
          };
          const pending = requestId === null ? undefined : pendingNativeEditsRef.current.get(requestId);
          if (requestId !== null) pendingNativeEditsRef.current.delete(requestId);
          let isFailedScriptBatch = false;
          if (pending && pending.path === "cell:batch") {
            try {
              const operations = JSON.parse(pending.value) as Array<{ path?: unknown }>;
              isFailedScriptBatch = Array.isArray(operations) && operations.some((operation) => operation?.path === "cell:execute-script");
            } catch { /* Invalid batch payload is handled by the original editor error path. */ }
          }
          if (requestId !== null && pending && isFailedScriptBatch) {
            // Capture actual XML after a failure because rollback is best-effort. The native result
            // remains failed, but the exact resulting diagram must still flow through persistence.
            const confirmation: PendingSaveConfirmation = { ...pending, deferredBatchAck: failedResult, captureOnFailure: true };
            confirmation.timeoutId = window.setTimeout(() => {
              if (pendingSaveConfirmationsRef.current.get(requestId) !== confirmation) return;
              pendingSaveConfirmationsRef.current.delete(requestId);
              const originalError = confirmation.deferredBatchAck?.error;
              const timeoutError = "The failed script's resulting XML could not be serialized within 30 seconds; the last saved XML was preserved." +
                (originalError ? " Original script error: " + originalError : "");
              onNativeEditResultRef.current?.({
                ...(confirmation.deferredBatchAck || failedResult),
                success: false, error: timeoutError, failureStage: "editor",
                auditWarning: "The partial editor state could not be captured; inspect History and reload the latest saved XML."
              });
              recordDiagnostic("drawio.script-failure-serialization.timeout", "Could not capture native XML after a failed script", {
                requestId, durationMs: Date.now() - confirmation.startedAt, errorMessage: timeoutError
              }, "error");
            }, NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS);
            pendingSaveConfirmationsRef.current.set(requestId, confirmation);
            iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "xml" }), DRAWIO_ORIGIN);
            recordDiagnostic("drawio.script-failure-serialization.requested", "Requested the actual native XML after a failed script so partial edits can be versioned and inspected", {
              requestId, durationMs: Date.now() - pending.startedAt, errorMessage, errorStack: errorStack ?? null,
              rollbackConfirmed: failedResult.batchRolledBack === true,
              diffPendingUntilXmlExport: true
            }, "warn");
          } else {
            onNativeEditResultRef.current?.(failedResult);
          }
          recordDiagnostic("drawio.selection.property.update.failed", "Draw.io rejected a native cell property mutation", {
            cellId: data.cellId, property: data.path, value: pending?.value ?? null, requestId,
            durationMs: pending ? Date.now() - pending.startedAt : null,
            errorMessage, errorStack: errorStack ?? null, failedIndex: data.failedIndex ?? null, batchResults: data.batchResults ?? null,
            rollbackErrors: data.rollbackErrors ?? [], batchRolledBack: data.batchRolledBack ?? null,
            capturedFailedScriptState: isFailedScriptBatch
          }, "error");
        }
      }
      if (data.event === "configure") {
        recordDiagnostic("drawio.handshake.configure", "Draw.io requested configuration");
        iframeRef.current?.contentWindow?.postMessage(JSON.stringify({
          action: "configure",
          config: DRAWIO_EDITOR_CONFIG
        }), DRAWIO_ORIGIN);
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
      if (data.event === "studioNativeLayoutResult") {
        const pending = pendingAutoLayoutRef.current;
        if (!pending) {
          recordDiagnostic("drawio.layout.acknowledgement.unmatched", "Ignored a native layout result without a pending request", {
            requestId: typeof data.requestId === "string" ? data.requestId : null
          }, "warn");
        } else if (data.requestId !== pending.requestId) {
          recordDiagnostic("drawio.layout.acknowledgement.stale", "Ignored a layout response for a different request", {
            receivedRequestId: typeof data.requestId === "string" ? data.requestId : null,
            expectedRequestId: pending.requestId
          }, "warn");
        } else if (data.success !== true) {
          const errorMessage = typeof data.error === "string" ? data.error.slice(0, 500) : "The native editor rejected the layout plan.";
          rejectPendingAutoLayout(new Error(errorMessage + (data.rollbackConfirmed === true ? " Previous geometry was restored." : "")));
        } else if (!pending.awaitingExport) {
          pending.awaitingExport = true;
          recordDiagnostic("drawio.layout.acknowledged", "Native Draw.io applied the geometry plan; requesting the serialized native XML", {
            requestId: typeof data.requestId === "string" ? data.requestId : null,
            engine: pending.plan.engine, algorithm: pending.plan.algorithm,
            changedVertices: typeof data.changedVertices === "number" ? data.changedVertices : null,
            changedEdges: typeof data.changedEdges === "number" ? data.changedEdges : null,
            documentRevision: pending.plan.documentRevision, pageId: pending.plan.pageId
          });
          try {
            iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "xml" }), DRAWIO_ORIGIN);
          } catch (error) {
            rejectPendingAutoLayout(new Error("Draw.io applied the layout but the updated XML could not be requested: " +
              (error instanceof Error ? error.message : String(error))));
          }
        }
      }
      if (data.event === "error") {
        const message = typeof data.message === "string" ? data.message.slice(0, 300) : "Draw.io returned an unspecified error.";
        setStartupError("Draw.io error: " + message);
        recordDiagnostic("drawio.editor.error", "The Draw.io editor reported an error", { message }, "error");
        rejectPendingAutoLayout(new Error("Draw.io reported an error during auto layout: " + message));
      }
      const pendingSerialization = pendingSaveConfirmationsRef.current.size > 0;
      const pendingDiagramStyle = Array.from(pendingDiagramStylesRef.current.entries()).find((entry) => entry[1].apply && entry[1].awaitingExport);
      const pendingBaselineExport = pendingBaselineExportRef.current;
      const baselineExportOnly = data.event === "export" && data.format === "xml" && Boolean(pendingBaselineExport) &&
        !pendingDiagramStyle && !pendingAutoLayoutRef.current?.awaitingExport && !pendingSerialization;
      const exportSerialization = data.event === "export" && data.format === "xml" &&
        (pendingSerialization || pendingAutoLayoutRef.current?.awaitingExport === true || Boolean(pendingDiagramStyle) || Boolean(pendingBaselineExport));
      if ((data.event === "save" || data.event === "autosave" || exportSerialization) && typeof data.xml === "string") {
        const duplicateXml = data.xml === lastSent.current;
        try {
          if (!isDrawioXmlDocument(data.xml)) {
            setStartupError("Draw.io returned an invalid XML document. The previous saved source was preserved.");
            recordDiagnostic("drawio.document.xml.invalid", "Rejected a malformed native Draw.io XML payload", { event: data.event, xmlLength: data.xml.length }, "error");
            if (exportSerialization && pendingAutoLayoutRef.current?.awaitingExport) {
              rejectPendingAutoLayout(new Error("Draw.io auto layout returned invalid XML; the previous saved source was preserved."));
            }
            if (exportSerialization && pendingDiagramStyle) settleDiagramStyle(pendingDiagramStyle[0], { error: new Error("Draw.io diagram-style operation returned invalid XML; the previous saved source was preserved.") });
            if (baselineExportOnly && pendingBaselineExport) settleBaselineExport({ error: new Error("Draw.io returned invalid XML while reading the current document.") });
            return;
          }
          if (baselineExportOnly && pendingBaselineExport) {
            settleBaselineExport({ xml: data.xml });
            return;
          }
          const pendingSaves = exportSerialization ? Array.from(pendingSaveConfirmationsRef.current.entries()) : [];
          const deferredBatchAcks: NativeEditResult[] = [];
          for (const [requestId, pending] of pendingSaves) {
            const reflected = pending.captureOnFailure === true || nativeEditIsReflectedInXml({
              beforeXml: pending.beforeXml, xml: data.xml, cellId: pending.cellId, pageId: pending.pageId,
              path: pending.path, value: pending.value
            });
            if (!reflected) {
              recordDiagnostic("drawio.selection.property.save-confirmation.unmatched",
                "Ignored a serialized XML snapshot that did not reflect the requested native edit",
                { requestId, cellId: pending.cellId, pageId: pending.pageId, property: pending.path,
                  durationMs: Date.now() - pending.startedAt, xmlLengthBefore: pending.beforeXml.length,
                  xmlLengthAfter: data.xml.length, saveEvent: data.event, serializedByExport: exportSerialization }, "warn");
              continue;
            }
            const nativeDiff = pending.captureOnFailure
              ? summarizeNativeDiagramXmlDiff(pending.beforeXml, data.xml)
              : null;
            if (pending.deferredBatchAck) {
              let acknowledgement: NativeEditResult = { ...pending.deferredBatchAck, serializedXml: data.xml };
              if (pending.captureOnFailure) {
                const rollbackConfirmed = acknowledgement.batchRolledBack === true &&
                  nativeDiff?.available === true && nativeDiff.changed === false;
                if (!rollbackConfirmed) {
                  const reason = nativeDiff?.available === false
                    ? "The post-failure XML could not be compared with the pre-script snapshot."
                    : nativeDiff?.changed
                      ? "The serialized document differs from the pre-script snapshot."
                      : "The editor did not explicitly confirm rollback.";
                  acknowledgement = {
                    ...acknowledgement,
                    batchRolledBack: false,
                    rollbackErrors: [...(acknowledgement.rollbackErrors || []), { cellId: "__document__", error: reason }]
                  };
                }
              }
              deferredBatchAcks.push(acknowledgement);
            }
            recordDiagnostic(pending.captureOnFailure ? "drawio.script-failure.serialization.captured" : "drawio.selection.property.save_confirmed",
              pending.captureOnFailure
                ? "Captured actual native Draw.io XML after script failure for persistence/versioning and agent diagnosis"
                : "Native Draw.io XML serialization reflects the requested edit",
              { requestId, cellId: pending.cellId, pageId: pending.pageId, property: pending.path, value: pending.value,
                captureOnFailure: pending.captureOnFailure === true, durationMs: Date.now() - pending.startedAt,
                xmlLengthBefore: pending.beforeXml.length, xmlLengthAfter: data.xml.length, saveEvent: data.event, serializedByExport: exportSerialization,
                nativeDiff });
            if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
            pendingSaveConfirmationsRef.current.delete(requestId);
          }
          if (duplicateXml) {
            for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
            if (exportSerialization && pendingDiagramStyle) settleDiagramStyle(pendingDiagramStyle[0], { xml: data.xml });
            if (exportSerialization && pendingAutoLayoutRef.current?.awaitingExport) finishPendingAutoLayout(data.xml);
            return;
          }
          lastSent.current = data.xml;
          recordDiagnostic("drawio.document.saved", "Native Draw.io XML autosave captured as the authoritative source", {
            event: data.event, xmlLength: data.xml.length
          });
          onDocumentChangeRef.current(data.xml);
          if (exportSerialization && pendingDiagramStyle) settleDiagramStyle(pendingDiagramStyle[0], { xml: data.xml });
          for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
          if (exportSerialization && pendingAutoLayoutRef.current?.awaitingExport) finishPendingAutoLayout(data.xml);
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

  function retryEditor(recovery = false) {
    rejectPendingAutoLayout(new Error("Draw.io editor was re-initialised before auto layout completed."));
    for (const pending of pendingSaveConfirmationsRef.current.values()) {
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
    }
    pendingSaveConfirmationsRef.current.clear();
    pendingNativeEditsRef.current.clear();
    for (const pending of pendingRuntimeInspectionsRef.current.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error("Draw.io editor was reloaded before runtime inspection completed."));
    }
    pendingRuntimeInspectionsRef.current.clear();
    recordDiagnostic(recovery ? "drawio.script-watchdog.recovery" : "drawio.retry",
      recovery ? "Reloading the Draw.io iframe from Studio's latest saved XML after a script execution timeout" : "The user asked to re-initialise the Draw.io editor",
      { previousFrameKey: frameKey, recoverySource: recovery ? "latest-studio-xml" : "manual" }, recovery ? "error" : "warn");
    lastSent.current = "";
    setEditorReady(false);
    setIframeLoaded(false);
    iframeLoadedRef.current = false;
    nativeDocumentLoadedRef.current = false;
    setBridgeReady(false);
    setStartupError(recovery ? "A Draw.io script timed out. The editor was reloaded from Studio's latest saved XML snapshot." : null);
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
        <span>{startupError}</span><button type="button" onClick={() => retryEditor()}>Re-initialise</button>
      </div>}
      <iframe key={frameKey} ref={iframeRef} className="drawio-iframe" title="Native Draw.io editor"
        sandbox="allow-scripts allow-same-origin allow-modals"
        referrerPolicy="strict-origin"
        src={DRAWIO_EMBED_URL}
        onLoad={() => {
          setIframeLoaded(true);
          iframeLoadedRef.current = true;
          recordDiagnostic("drawio.iframe.loaded", "The Draw.io iframe fired its browser load event; still waiting for embed init", { url: DRAWIO_EMBED_URL, frameKey });
        }}
        onError={() => {
          setStartupError("The browser could not load the isolated Draw.io origin. Check that the local Draw.io static server is running.");
          recordDiagnostic("drawio.iframe.load.failed", "The browser could not load the local Draw.io iframe", { url: DRAWIO_EMBED_URL }, "error");
        }}
        allow="clipboard-read; clipboard-write" />
    </div>
  );
});

export default DrawioFrame;
