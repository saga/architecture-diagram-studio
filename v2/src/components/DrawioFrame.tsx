import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { normalizeDrawioRuntimeInspection, PINNED_DRAWIO_VERSION, type DrawioRuntimeInspection } from "../model/drawio-runtime-contract";
import { isDrawioXmlDocument } from "../model/drawio-xml-source";
import { findUndeclaredNativeScriptChanges, nativeEditIsReflectedInXml, summarizeNativeDiagramXmlDiff, validateNativeScriptResultAgainstXml, type NativeScriptScopeViolation, type NativeScriptXmlAssertionFailure, type NativeScriptXmlValidationResult } from "../model/native-edit-confirmation";
import { recordDiagnostic } from "../diagnostics";
import { calculateDrawioXmlRevision } from "../intent/aiProvider";
import type { NativePalettePlan } from "../model/drawio-theme";
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
const NATIVE_PALETTE_TIMEOUT_MS = 30_000;

export { DEFAULT_NATIVE_AUTO_LAYOUT_OPTIONS };
export type { NativeAutoLayoutOptions, NativeLayoutPlan };

export interface NativeHistoryState { canUndo: boolean; canRedo: boolean; }

export interface DrawioFrameHandle {
  undo(): void;
  redo(): void;
  /** Applies an active-page color plan in one native Draw.io model transaction. */
  applyPalette(plan: NativePalettePlan): Promise<string>;
  inspectRuntime(input: { documentRevision: string; pageId: string | null; jsShapeClassNames?: string[] }): Promise<DrawioRuntimeInspection>;
  /** Applies a revision/page-bound Studio layout geometry plan to native Draw.io cells. */
  applyAutoLayout(plan: NativeLayoutPlan): Promise<string>;
  /** Reloads the editor from the latest XML retained by Studio after a synchronous script hangs. */
  recoverFromLastSavedXml(): void;
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
  /** Bounded JSON-safe value returned by a native script. */
  scriptResult?: unknown;
  /** Field-level verification failures used in diagnostics and safe repair context. */
  assertionFailures?: NativeScriptXmlAssertionFailure[];
  scopeViolations?: NativeScriptScopeViolation[];
  scriptMode?: "read" | "mutate";
  /** Semantic before/after XML result for a validated script; false means no semantic change occurred. */
  semanticChanged?: boolean;
  applicationState?: "applied-and-verified" | "changed-unverified" | "not-applied" | "unknown";
};
type PendingNativeEdit = { cellId: string; pageId: string | null; path: string; value: string; startedAt: number; beforeXml: string };
type PendingSaveConfirmation = PendingNativeEdit & { deferredBatchAck?: NativeEditResult; scriptResult?: unknown; timeoutId?: number; captureOnFailure?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scriptModeFromBatchValue(value: string): "read" | "mutate" | null {
  try {
    const operations = JSON.parse(value) as Array<{ path?: unknown; value?: unknown }>;
    const operation = Array.isArray(operations)
      ? operations.find((item) => item?.path === "cell:execute-script")
      : undefined;
    if (!operation) return null;
    if (typeof operation.value === "string") {
      try {
        const payload = JSON.parse(operation.value) as { mode?: unknown; script?: unknown };
        if (payload && typeof payload === "object" && typeof payload.script === "string" &&
            (payload.mode === "read" || payload.mode === "mutate")) return payload.mode;
      } catch { /* Older persisted batches store raw JavaScript instead of an envelope. */ }
    }
    return "mutate";
  } catch {
    return null;
  }
}

function isScriptBatchValue(value: string): boolean {
  return scriptModeFromBatchValue(value) !== null;
}

function allPostconditionsTrue(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(allPostconditionsTrue);
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every(allPostconditionsTrue);
}

/** Script execution is verified only when the returned JSON explicitly records passing postconditions. */
function hasVerifiedScriptPostconditions(scriptResult: unknown): boolean {
  if (!isRecord(scriptResult) || scriptResult.available !== true || !isRecord(scriptResult.value)) return false;
  const value = scriptResult.value;
  return value.ok === true && allPostconditionsTrue(value.postconditions);
}

function failedPostconditionPaths(value: unknown, prefix = "postconditions"): string[] {
  if (value === true) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix + " must not be empty"];
    return value.flatMap((condition, index) => failedPostconditionPaths(condition, prefix + "[" + index + "]"));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [prefix + " must not be empty"];
    return entries.flatMap(([name, condition]) => failedPostconditionPaths(condition, prefix + "." + name));
  }
  return [prefix + " expected true but received " + (value === undefined ? "missing" : String(value))];
}

function scriptPostconditionFailureReason(scriptResult: unknown): string {
  if (!isRecord(scriptResult) || scriptResult.available !== true || !isRecord(scriptResult.value)) {
    return "The script did not return an available JSON result with passing postconditions.";
  }
  const value = scriptResult.value;
  const failures = value.ok === true ? [] : [
    "ok expected true but received " + (value.ok === undefined ? "missing" : String(value.ok))
  ];
  failures.push(...failedPostconditionPaths(value.postconditions));
  return failures.length
    ? "The script did not satisfy its declared postconditions: " + failures.slice(0, 8).join("; ") + "."
    : "The script did not return passing, verifiable postconditions.";
}

function classifyUnverifiedSnapshot(beforeXml: string, xml: string): "changed-unverified" | "not-applied" | "unknown" {
  const diff = summarizeNativeDiagramXmlDiff(beforeXml, xml);
  if (!diff.available || typeof diff.changed !== "boolean") return "unknown";
  return diff.changed ? "changed-unverified" : "not-applied";
}
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
type PendingNativePalette = {
  resolve: (xml: string) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  startedAt: number;
  awaitingExport: boolean;
  requestId: string;
  plan: NativePalettePlan;
};
interface Props {
  onNativeEditResult?: (result: NativeEditResult) => void;
  xml: string;
  onDocumentChange: (nativeXml: string) => void;
  onSelectionChange: (cellId: string | null, pageId: string | null) => void;
  onHistoryStateChange?: (state: NativeHistoryState) => void;
  cellEdit: CellPropertyEdit | null;
  /** Reports the embed handshake state so the app's single status bar can show it. */
  onEditorStatusChange?: (ready: boolean) => void;
}

const DrawioFrame = forwardRef<DrawioFrameHandle, Props>(function DrawioFrame({ xml, onDocumentChange, onSelectionChange, onHistoryStateChange, onNativeEditResult, cellEdit, onEditorStatusChange }: Props, ref) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const xmlRef = useRef(xml);
  xmlRef.current = xml;
  const onDocumentChangeRef = useRef(onDocumentChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onHistoryStateChangeRef = useRef(onHistoryStateChange);
  const onNativeEditResultRef = useRef(onNativeEditResult);
  const lastHandledCellEditRequestRef = useRef<number | null>(null);
  const pendingNativeEditsRef = useRef(new Map<number, PendingNativeEdit>());
  const pendingSaveConfirmationsRef = useRef(new Map<number, PendingSaveConfirmation>());
  const pendingRuntimeInspectionsRef = useRef(new Map<string, PendingRuntimeInspection>());
  const pendingAutoLayoutRef = useRef<PendingAutoLayout | null>(null);
  const pendingNativePaletteRef = useRef<PendingNativePalette | null>(null);
  const runtimeInspectionSequenceRef = useRef(0);
  const iframeLoadedRef = useRef(false);
  const nativeDocumentLoadedRef = useRef(false);
  onDocumentChangeRef.current = onDocumentChange;
  onSelectionChangeRef.current = onSelectionChange;
  onHistoryStateChangeRef.current = onHistoryStateChange;
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

  function finishPendingNativePalette(xml: string) {
    const pending = pendingNativePaletteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingNativePaletteRef.current = null;
    recordDiagnostic("drawio.palette.completed", "Native Draw.io applied a color preset, serialized the active page, and retained native history", {
      durationMs: Date.now() - pending.startedAt, xmlLength: xml.length,
      theme: pending.plan.theme, pageId: pending.plan.pageId, changeCount: pending.plan.changes.length,
      documentRevision: pending.plan.documentRevision
    });
    pending.resolve(xml);
  }

  function rejectPendingNativePalette(error: Error) {
    const pending = pendingNativePaletteRef.current;
    if (!pending) return;
    window.clearTimeout(pending.timeoutId);
    pendingNativePaletteRef.current = null;
    recordDiagnostic("drawio.palette.rejected", "Native Draw.io could not confirm an active-page color transaction", {
      durationMs: Date.now() - pending.startedAt, errorMessage: error.message,
      theme: pending.plan.theme, pageId: pending.plan.pageId, documentRevision: pending.plan.documentRevision
    }, "error");
    pending.reject(error);
  }

  useImperativeHandle(ref, () => ({
    undo: () => {
      const target = iframeRef.current?.contentWindow;
      if (!editorReady || !bridgeReady || !target) return;
      target.postMessage(JSON.stringify({ event: "studioHistoryCommand", action: "undo" }), DRAWIO_ORIGIN);
    },
    redo: () => {
      const target = iframeRef.current?.contentWindow;
      if (!editorReady || !bridgeReady || !target) return;
      target.postMessage(JSON.stringify({ event: "studioHistoryCommand", action: "redo" }), DRAWIO_ORIGIN);
    },
    applyPalette: async (plan) => {
      const currentRevision = await calculateDrawioXmlRevision(xmlRef.current);
      if (currentRevision !== plan.documentRevision) {
        throw new Error("The native Draw.io XML changed after the color preset was calculated. No colors were applied; select the preset again.");
      }
      return await new Promise<string>((resolve, reject) => {
        const target = iframeRef.current?.contentWindow;
        if (!editorReady || !bridgeReady || !target) {
          reject(new Error("The native Draw.io editor is not ready for diagram colors."));
          return;
        }
        if (pendingNativePaletteRef.current || pendingAutoLayoutRef.current) {
          reject(new Error("Wait for the current canvas transaction to finish before applying diagram colors."));
          return;
        }
        if (pendingNativeEditsRef.current.size > 0 || pendingSaveConfirmationsRef.current.size > 0) {
          reject(new Error("Wait for the current native edit to finish saving before applying diagram colors."));
          return;
        }
        if ((!plan.changes.length && plan.expectedBackground === plan.background) || plan.changes.length > 10000 ||
            !plan.expectedPageCellIds.length || plan.expectedPageCellIds.length > 20000) {
          reject(new Error("The color plan is empty or exceeds native editor limits."));
          return;
        }
        const requestId = "palette-" + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
        const timeoutId = window.setTimeout(() => {
          rejectPendingNativePalette(new Error("Draw.io did not confirm the color transaction and XML serialization within 30 seconds."));
        }, NATIVE_PALETTE_TIMEOUT_MS);
        pendingNativePaletteRef.current = { resolve, reject, timeoutId, startedAt: Date.now(), awaitingExport: false, requestId, plan };
        try {
          target.postMessage(JSON.stringify({ event: "studioNativePaletteRequest", requestId, plan }), DRAWIO_ORIGIN);
          recordDiagnostic("drawio.palette.requested", "Sent a revision- and active-page-bound palette plan to the native Draw.io editor", {
            requestId, theme: plan.theme, pageId: plan.pageId, documentRevision: plan.documentRevision,
            expectedCellCount: plan.expectedPageCellIds.length, changeCount: plan.changes.length,
            expectedBackground: plan.expectedBackground, nextBackground: plan.background
          });
        } catch (error) {
          rejectPendingNativePalette(new Error("Could not send the color plan to Draw.io: " +
            (error instanceof Error ? error.message : String(error))));
        }
      });
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
        recordDiagnostic("drawio.layout.requested", "Sent a revision-bound Studio layout plan to the native Draw.io editor", {
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
    // Close every in-flight operation explicitly before dropping its bookkeeping. A component
    // unmount/reload must not leave a Copilot batch waiting forever or imply that an unverified
    // editor mutation succeeded.
    for (const [requestId, pending] of pendingSaveConfirmationsRef.current.entries()) {
      if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
      if (pending.deferredBatchAck) {
        onNativeEditResultRef.current?.({
          ...pending.deferredBatchAck,
          success: false,
          applicationState: "unknown",
          error: "The Draw.io editor closed before the native XML serialization could be confirmed.",
          failureStage: "editor",
          auditWarning: "The edit may have been applied. Inspect the current diagram and History before retrying."
        });
      }
      recordDiagnostic("drawio.selection.property.save-confirmation.aborted",
        "Closed an in-flight native edit confirmation because the Draw.io editor unmounted",
        { requestId, cellId: pending.cellId, path: pending.path }, "warn");
    }
    pendingSaveConfirmationsRef.current.clear();
    for (const [requestId, pending] of pendingNativeEditsRef.current.entries()) {
      recordDiagnostic("drawio.selection.property.request.aborted",
        "Closed an in-flight native edit request because the Draw.io editor unmounted",
        { requestId, cellId: pending.cellId, path: pending.path }, "warn");
    }
    pendingNativeEditsRef.current.clear();
    rejectPendingAutoLayout(new Error("Draw.io editor closed before auto layout completed."));
    rejectPendingNativePalette(new Error("Draw.io editor closed before the color transaction completed."));
    for (const pending of pendingRuntimeInspectionsRef.current.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(new Error("Draw.io editor was closed before runtime inspection completed."));
    }
    pendingRuntimeInspectionsRef.current.clear();
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
    // Draw.io's export protocol has no request correlation ID. Never dispatch a second
    // property mutation while a prior mutation is awaiting its XML serialization receipt:
    // otherwise one export could incorrectly acknowledge multiple unrelated edits.
    if (pendingNativeEditsRef.current.size > 0 || pendingSaveConfirmationsRef.current.size > 0 ||
        pendingAutoLayoutRef.current !== null || pendingNativePaletteRef.current !== null) {
      lastHandledCellEditRequestRef.current = cellEdit.requestId;
      const blockingTransactions = [
        ...Array.from(pendingNativeEditsRef.current.keys()).map((id) => `native-edit:${id}`),
        ...Array.from(pendingSaveConfirmationsRef.current.keys()).map((id) => `serialization:${id}`),
        ...(pendingAutoLayoutRef.current ? ["auto-layout"] : []),
        ...(pendingNativePaletteRef.current ? ["palette"] : [])
      ];
      onNativeEditResultRef.current?.({
        requestId: cellEdit.requestId,
        success: false,
        cellId: cellEdit.cellId,
        path: cellEdit.path,
        applicationState: "not-applied",
        error: "Another canvas transaction is still in flight. Wait for its completion before submitting another property edit."
      });
      recordDiagnostic("drawio.selection.property.blocked-pending-serialization",
        "Blocked a concurrent property edit because Draw.io XML export receipts cannot be correlated to individual requests",
        { requestId: cellEdit.requestId, blockingTransactions }, "warn");
      return;
    }
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
        onHistoryStateChangeRef.current?.({ canUndo: false, canRedo: false });
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
      if (data.event === "studioSelectionChanged") {
        const cellId = typeof data.cellId === "string" && data.cellId ? data.cellId : null;
        const pageId = typeof data.pageId === "string" && data.pageId ? data.pageId : null;
        onSelectionChangeRef.current(cellId, pageId);
      }
      if (data.event === "studioHistoryState") {
        onHistoryStateChangeRef.current?.({ canUndo: data.canUndo === true, canRedo: data.canRedo === true });
      }
      if (data.event === "studioHistoryCommandResult" && data.success !== true) {
        recordDiagnostic("drawio.history.command.rejected", "The native Draw.io history manager rejected the host Undo/Redo command", {
          action: typeof data.action === "string" ? data.action : null,
          errorMessage: typeof data.error === "string" ? data.error : "No additional error details"
        }, "warn");
      }
      if (data.event === "studioPropertyEditResult") {
        const requestId = typeof data.requestId === "number" ? data.requestId : null;
        if (data.success === true) {
          const nativeResult: NativeEditResult = {
            requestId, success: true,
            cellId: typeof data.cellId === "string" ? data.cellId : null,
            path: typeof data.path === "string" ? data.path : null,
            batchResults: Array.isArray(data.batchResults) ? data.batchResults as NativeEditResult["batchResults"] : null,
            ...(data.scriptResult !== undefined ? { scriptResult: data.scriptResult } : {}),
            ...(data.scriptMode === "read" || data.scriptMode === "mutate" ? { scriptMode: data.scriptMode } : {})
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
              const latestXml = lastSent.current;
              const latestChanged = latestXml !== confirmation.beforeXml && isDrawioXmlDocument(latestXml);
              const errorMessage = confirmation.captureOnFailure
                ? "The failed script's resulting XML could not be serialized within 30 seconds; the last saved XML was preserved." +
                  (originalError ? " Original script error: " + originalError : "")
                : latestChanged
                  ? "The document changed, but the requested edit could not be verified because no matching XML export arrived within 30 seconds."
                  : "No matching XML export arrived within 30 seconds; the edit state is unknown.";
              recordDiagnostic("drawio.selection.property.save-confirmation.timeout",
                confirmation.captureOnFailure
                  ? "Timed out while capturing the native XML state after a failed script"
                  : latestChanged
                    ? "The document changed but the native edit confirmation timed out"
                    : "Timed out waiting for a matching serialized XML snapshot",
                { requestId, cellId: confirmation.cellId, property: confirmation.path, captureOnFailure: confirmation.captureOnFailure === true,
                  latestChanged, timeoutMs: NATIVE_SAVE_CONFIRMATION_TIMEOUT_MS,
                  durationMs: Date.now() - confirmation.startedAt }, "warn");
              if (confirmation.deferredBatchAck) {
                const applicationState = confirmation.captureOnFailure
                  ? "unknown"
                  : latestChanged
                    ? "changed-unverified"
                    : "unknown";
                onNativeEditResultRef.current?.({
                  ...confirmation.deferredBatchAck,
                  success: false,
                  applicationState,
                  ...(latestChanged ? { serializedXml: latestXml } : {}),
                  error: errorMessage,
                  failureStage: "editor",
                  auditWarning: latestChanged
                    ? "Changes may already be present and saved. Do not retry this edit until the current diagram has been inspected."
                    : "The edit state is unknown. Inspect the current diagram and History before retrying."
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
            batchRolledBack: typeof data.batchRolledBack === "boolean" ? data.batchRolledBack : null,
            ...(data.scriptMode === "read" || data.scriptMode === "mutate" ? { scriptMode: data.scriptMode } : {})
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
        // A document load is a native history boundary. Ordinary page navigation is not.
        onHistoryStateChangeRef.current?.({ canUndo: false, canRedo: false });
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
      if (data.event === "studioNativePaletteResult") {
        const pending = pendingNativePaletteRef.current;
        if (!pending || data.requestId !== pending.requestId) {
          recordDiagnostic("drawio.palette.acknowledgement.unmatched", "Ignored a native palette result without a matching request", {
            requestId: typeof data.requestId === "string" ? data.requestId : null
          }, "warn");
        } else if (data.success !== true) {
          const message = typeof data.error === "string" ? data.error.slice(0, 500) : "The native editor rejected the color plan.";
          rejectPendingNativePalette(new Error(message + (data.rollbackConfirmed === true ? " Previous styles were restored." : "")));
        } else if (!pending.awaitingExport) {
          pending.awaitingExport = true;
          recordDiagnostic("drawio.palette.acknowledged", "Draw.io applied the color transaction; requesting the serialized native XML", {
            requestId: pending.requestId, theme: pending.plan.theme, pageId: pending.plan.pageId,
            changedCells: typeof data.changedCells === "number" ? data.changedCells : null,
            documentRevision: pending.plan.documentRevision
          });
          try {
            iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: "export", format: "xml" }), DRAWIO_ORIGIN);
          } catch (error) {
            rejectPendingNativePalette(new Error("Draw.io applied the colors but the updated XML could not be requested: " +
              (error instanceof Error ? error.message : String(error))));
          }
        }
      }
      if (data.event === "error") {
        const message = typeof data.message === "string" ? data.message.slice(0, 300) : "Draw.io returned an unspecified error.";
        setStartupError("Draw.io error: " + message);
        recordDiagnostic("drawio.editor.error", "The Draw.io editor reported an error", { message }, "error");
        rejectPendingAutoLayout(new Error("Draw.io reported an error during auto layout: " + message));
        rejectPendingNativePalette(new Error("Draw.io reported an error during diagram color application: " + message));
      }
      const pendingSerialization = pendingSaveConfirmationsRef.current.size > 0;
      const exportSerialization = data.event === "export" && data.format === "xml" &&
        (pendingSerialization || pendingAutoLayoutRef.current?.awaitingExport === true || pendingNativePaletteRef.current?.awaitingExport === true);
      if ((data.event === "save" || data.event === "autosave") && typeof data.xml === "string") {
        const pendingReadOnlyEntry = Array.from(pendingSaveConfirmationsRef.current.entries())
          .find(([, pending]) => scriptModeFromBatchValue(pending.value) === "read");
        const pendingReadOnly = pendingReadOnlyEntry?.[1];
        if (pendingReadOnly) {
          const readOnlyDiff = summarizeNativeDiagramXmlDiff(pendingReadOnly.beforeXml, data.xml);
          if (readOnlyDiff.available && readOnlyDiff.changed === false) {
            recordDiagnostic("drawio.script.read-only.autosave-suppressed",
              "Suppressed a viewport/serialization-only autosave while a read-only script awaits its export receipt",
              { event: data.event, requestId: pendingReadOnlyEntry?.[0] ?? null, xmlLengthBefore: pendingReadOnly.beforeXml.length,
                xmlLengthAfter: data.xml.length, diffAvailable: readOnlyDiff.available, semanticChanged: readOnlyDiff.changed });
            return;
          }
        }
      }
      if ((data.event === "save" || data.event === "autosave" || exportSerialization) && typeof data.xml === "string") {
        const duplicateXml = data.xml === lastSent.current;
        try {
          if (!isDrawioXmlDocument(data.xml)) {
            setStartupError("Draw.io returned an invalid XML document. The previous saved source was preserved.");
            recordDiagnostic("drawio.document.xml.invalid", "Rejected a malformed native Draw.io XML payload", { event: data.event, xmlLength: data.xml.length }, "error");
            if (exportSerialization && pendingAutoLayoutRef.current?.awaitingExport) {
              rejectPendingAutoLayout(new Error("Draw.io auto layout returned invalid XML; the previous saved source was preserved."));
            }
            if (exportSerialization && pendingNativePaletteRef.current?.awaitingExport) {
              rejectPendingNativePalette(new Error("Draw.io returned invalid XML after applying diagram colors; the previous saved source was preserved."));
            }
            return;
          }
          const pendingSaves = exportSerialization ? Array.from(pendingSaveConfirmationsRef.current.entries()) : [];
          const deferredBatchAcks: NativeEditResult[] = [];
          let readOnlyNoopSerialization = false;
          for (const [requestId, pending] of pendingSaves) {
            const scriptMode = scriptModeFromBatchValue(pending.value);
            if (scriptMode === "read" && pending.deferredBatchAck) {
              const readOnlyDiff = summarizeNativeDiagramXmlDiff(pending.beforeXml, data.xml);
              if (readOnlyDiff.available && readOnlyDiff.changed === false) {
                if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
                pendingSaveConfirmationsRef.current.delete(requestId);
                if (pending.captureOnFailure) {
                  const rollbackConfirmed = pending.deferredBatchAck.batchRolledBack === true;
                  deferredBatchAcks.push({
                    ...pending.deferredBatchAck,
                    success: false,
                    applicationState: "not-applied",
                    serializedXml: pending.beforeXml,
                    auditWarning: rollbackConfirmed
                      ? "The read-only script failed and the editor confirmed rollback. The document and file were left unchanged."
                      : "The read-only script failed, but rollback was not confirmed. Inspect the live editor before continuing."
                  });
                  readOnlyNoopSerialization = rollbackConfirmed;
                  recordDiagnostic("drawio.script.read-only.failure-noop",
                    "A failed read-only script produced no semantic document change",
                    { requestId, rollbackConfirmed, xmlLengthBefore: pending.beforeXml.length,
                      xmlLengthAfter: data.xml.length, semanticChanged: false }, rollbackConfirmed ? "warn" : "error");
                } else {
                  deferredBatchAcks.push({
                    ...pending.deferredBatchAck,
                    success: true,
                    applicationState: "not-applied",
                    serializedXml: pending.beforeXml,
                    scriptMode: "read",
                    auditWarning: "Read-only inspection completed. No diagram change was made and no autosave/history snapshot was created."
                  });
                  readOnlyNoopSerialization = true;
                  recordDiagnostic("drawio.script.read-only.completed",
                    "Read-only script returned a result without changing semantic diagram content; serialization was not persisted",
                    { requestId, xmlLengthBefore: pending.beforeXml.length, xmlLengthAfter: data.xml.length,
                      semanticChanged: false, scriptResultAvailable: isRecord(pending.scriptResult) && pending.scriptResult.available === true });
                }
                continue;
              }
              if (readOnlyDiff.available && readOnlyDiff.changed === true && pending.deferredBatchAck.success) {
                if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
                pendingSaveConfirmationsRef.current.delete(requestId);
                deferredBatchAcks.push({
                  ...pending.deferredBatchAck,
                  success: false,
                  applicationState: "changed-unverified",
                  serializedXml: data.xml,
                  error: "The read-only script changed semantic diagram content; the resulting XML was captured but the inspection was rejected.",
                  auditWarning: "A read-only script unexpectedly changed the diagram. Inspect the current XML and History before continuing; do not retry blindly."
                });
                recordDiagnostic("drawio.script.read-only.mutated",
                  "A script declared read-only changed semantic XML and was rejected",
                  { requestId, xmlLengthBefore: pending.beforeXml.length, xmlLengthAfter: data.xml.length,
                    pagesChanged: readOnlyDiff.pagesChanged, cellsAdded: readOnlyDiff.cellsAdded?.length,
                    cellsRemoved: readOnlyDiff.cellsRemoved?.length, cellsChanged: readOnlyDiff.cellsChanged?.length }, "error");
                continue;
              }
            }
            const reflected = pending.captureOnFailure === true || nativeEditIsReflectedInXml({
              beforeXml: pending.beforeXml, xml: data.xml, cellId: pending.cellId, pageId: pending.pageId,
              path: pending.path, value: pending.value
            });
            if (!reflected) {
              recordDiagnostic("drawio.selection.property.save-confirmation.unmatched",
                "Received valid serialized XML, but it did not satisfy the native edit confirmation rule",
                { requestId, cellId: pending.cellId, pageId: pending.pageId, property: pending.path,
                  durationMs: Date.now() - pending.startedAt, xmlLengthBefore: pending.beforeXml.length,
                  xmlLengthAfter: data.xml.length, saveEvent: data.event, serializedByExport: exportSerialization }, "warn");
              // Do not wait 30 seconds when an exported snapshot has already proved that a script
              // changed the document but failed confirmation. Preserve that exact XML and report
              // an explicit unverified state so the Agent cannot automatically retry an insertion.
              if (pending.deferredBatchAck?.success && isScriptBatchValue(pending.value)) {
                const applicationState = classifyUnverifiedSnapshot(pending.beforeXml, data.xml);
                if (pending.timeoutId !== undefined) window.clearTimeout(pending.timeoutId);
                pendingSaveConfirmationsRef.current.delete(requestId);
                deferredBatchAcks.push({
                  ...pending.deferredBatchAck,
                  success: false,
                  applicationState,
                  serializedXml: data.xml,
                  error: applicationState === "changed-unverified"
                    ? "The document changed, but the exported XML did not pass the script confirmation checks."
                    : applicationState === "not-applied"
                      ? "The script result was not confirmed and the serialized document appears unchanged."
                      : "The serialized document could not be compared with the pre-edit snapshot.",
                  auditWarning: applicationState === "changed-unverified"
                    ? "Changes may already be present and saved. Do not retry this edit until the current diagram has been inspected."
                    : applicationState === "unknown"
                      ? "The edit state is unknown. Inspect the current diagram and History before retrying."
                      : "No document change was detected in the serialized snapshot."
                });
                recordDiagnostic("drawio.script.postcondition.unverified",
                  "Native script XML was captured without a passing confirmation result",
                  { requestId, applicationState, xmlLengthBefore: pending.beforeXml.length, xmlLengthAfter: data.xml.length }, "warn");
              }
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
              } else if (acknowledgement.success && isScriptBatchValue(pending.value)) {
                const scriptResult = pending.scriptResult ?? acknowledgement.scriptResult;
                const scriptChecksPassed = hasVerifiedScriptPostconditions(scriptResult);
                // XML assertions and the before/after scope audit are independent evidence. A
                // false live-model postcondition must not suppress checks against serialized XML:
                // those checks can identify the exact cells the script silently skipped.
                const xmlAssertionValidation = validateNativeScriptResultAgainstXml(scriptResult, data.xml, pending.pageId);
                const postconditionFailures = scriptChecksPassed ? [] : [{
                  kind: "invalid-result" as const, index: null, field: "postconditions",
                  reason: scriptPostconditionFailureReason(scriptResult)
                }];
                const assertionValidation: NativeScriptXmlValidationResult = {
                  ok: xmlAssertionValidation.ok && scriptChecksPassed,
                  failures: [...xmlAssertionValidation.failures, ...postconditionFailures],
                  ...(xmlAssertionValidation.warnings ? { warnings: xmlAssertionValidation.warnings } : {})
                };
                const serializedAssertionsPassed = xmlAssertionValidation.ok;
                const scriptScope = findUndeclaredNativeScriptChanges(
                  pending.beforeXml, data.xml, scriptResult, 20, pending.pageId
                );
                const undeclaredChangesPassed = scriptScope.ok;
                // When the entire assertion contract fails, promote ignored-key warnings into
                // the repair diagnostics so the model sees the allowed field list. If supported
                // evidence passes, keep advisory metadata as warnings only.
                const assertionIssues = assertionValidation.failures.length
                  ? [...assertionValidation.failures, ...(assertionValidation.warnings || [])]
                  : assertionValidation.failures;
                const deduplicatedAssertionFailures = [...new Map(assertionIssues.map((failure) => [
                  [failure.cellId || "", failure.field, failure.kind].join("::"), failure
                ] as const)).values()];
                const summarizedAssertionFailures = [...new Map(deduplicatedAssertionFailures.map((failure) => [
                  [failure.kind, failure.field].join("::"), failure
                ] as const)).values()];
                const assertionDiagnostic = deduplicatedAssertionFailures.slice(0, 8)
                  .map((failure) => "[" + failure.kind + "]" +
                    (failure.cellId ? " cell " + failure.cellId : "") + " " + failure.field + ": " + failure.reason)
                  .join("; ");
                const rawAssertionWarnings = assertionValidation.warnings || [];
                const deduplicatedAssertionWarnings = [...new Map(rawAssertionWarnings.map((warning) => [
                  warning.field, warning
                ] as const)).values()];
                if (deduplicatedAssertionWarnings.length) {
                  recordDiagnostic("drawio.script.postcondition.assertion-metadata-ignored",
                    "Ignored non-contract assertion metadata while validating independently supported XML evidence",
                    {
                      requestId,
                      rawWarningCount: rawAssertionWarnings.length,
                      warningCount: deduplicatedAssertionWarnings.length,
                      warningFields: deduplicatedAssertionWarnings.map((warning) => warning.field).slice(0, 20),
                      sampleCellIds: deduplicatedAssertionWarnings.map((warning) => warning.cellId ?? null).slice(0, 20),
                      warnings: deduplicatedAssertionWarnings.slice(0, 20).map((warning) => ({
                        cellId: warning.cellId ?? null, field: warning.field, reason: warning.reason
                      }))
                    }, "warn");
                }
                const scopeDiagnostic = scriptScope && !scriptScope.ok
                  ? (scriptScope.available
                      ? scriptScope.violations.slice(0, 8).map((violation) =>
                          violation.kind + " cell " + violation.cellId +
                          (violation.label ? " (" + violation.label.slice(0, 80) + ")" : "") +
                          (violation.changedFields?.length ? " [" + violation.changedFields.join(",") + "]" : "")
                        ).join("; ")
                      : scriptScope.error || "The before/after XML could not be compared.")
                  : "";
                if (scriptChecksPassed && serializedAssertionsPassed && undeclaredChangesPassed === true) {
                  acknowledgement = {
                    ...acknowledgement, applicationState: "applied-and-verified",
                    ...(typeof scriptScope?.changed === "boolean" ? { semanticChanged: scriptScope.changed } : {})
                  };
                } else {
                  const applicationState = classifyUnverifiedSnapshot(pending.beforeXml, data.xml);
                  const diagnosticParts = [
                    assertionDiagnostic ? "Assertion diagnostics: " + assertionDiagnostic : "",
                    scopeDiagnostic ? "Undeclared changes: " + scopeDiagnostic : ""
                  ].filter(Boolean).join(" ");
                  const detail = diagnosticParts ? " " + diagnosticParts : "";
                  const postconditionFailed = deduplicatedAssertionFailures.some((failure) => failure.field === "postconditions");
                  const mismatchFailures = deduplicatedAssertionFailures.filter((failure) => failure.kind === "mismatch");
                  const contractFailures = deduplicatedAssertionFailures.filter((failure) =>
                    failure.kind === "invalid-assertion" || failure.kind === "invalid-document" ||
                    (failure.kind === "invalid-result" && failure.field !== "postconditions")
                  );
                  const mismatchTargets = [...new Set(mismatchFailures.map((failure) =>
                    failure.cellId ? failure.cellId + " (" + failure.field + ")" : failure.field
                  ))].slice(0, 8);
                  const failureHeadlines = [
                    ...(postconditionFailed ? ["The script's own postconditions failed"] : []),
                    ...(mismatchTargets.length ? ["Serialized XML did not match declared assertions for " + mismatchTargets.join(", ")] : []),
                    ...(contractFailures.length ? ["The native script assertion contract is invalid"] : []),
                    ...(undeclaredChangesPassed === false ? ["The document changed beyond the declared assertions"] : []),
                    ...(scriptScope && !scriptScope.available ? ["The before/after scope audit could not verify the changes"] : [])
                  ];
                  const verificationFailure = (failureHeadlines.length
                    ? failureHeadlines.join(". ") + "."
                    : "The script result could not be verified against the serialized document.");
                  acknowledgement = {
                    ...acknowledgement,
                    success: false,
                    applicationState,
                    assertionFailures: deduplicatedAssertionFailures.slice(0, 25),
                    scopeViolations: !scriptScope.ok ? scriptScope.violations.slice(0, 25) : [],
                    error: (applicationState === "changed-unverified"
                      ? verificationFailure
                      : applicationState === "not-applied"
                        ? verificationFailure + " The document appears unchanged."
                        : verificationFailure + " The serialized document state is uncertain.") + detail,
                    auditWarning: applicationState === "changed-unverified"
                      ? "Changes may already be present and saved. Do not retry this edit until the current diagram has been inspected."
                      : applicationState === "unknown"
                        ? "The edit state is unknown. Inspect the current diagram and History before retrying."
                        : "No document change was detected in the serialized snapshot."
                  };
                  recordDiagnostic("drawio.script.postcondition.xml-mismatch",
                    "The script's native-cell assertions were invalid or did not match the serialized native XML",
                    { requestId, applicationState, booleanPostconditionsPassed: scriptChecksPassed,
                      serializedAssertionsPassed, undeclaredChangesPassed,
                      undeclaredViolations: scriptScope?.violations.slice(0, 25) ?? [],
                      undeclaredScopeAvailable: scriptScope?.available ?? null,
                      assertionFailureCount: assertionValidation.failures.length,
                      unknownAssertionWarningCount: rawAssertionWarnings.length,
                      uniqueAssertionFailureCount: summarizedAssertionFailures.length,
                      uniqueAssertionFailureFields: summarizedAssertionFailures.map((failure) => failure.field).slice(0, 25),
                      assertionFailures: deduplicatedAssertionFailures.slice(0, 25),
                      xmlLengthBefore: pending.beforeXml.length, xmlLengthAfter: data.xml.length }, "warn");
                  if (scriptScope && !scriptScope.ok) {
                    recordDiagnostic("drawio.script.postcondition.undeclared-change",
                      "The serialized document changed existing cells that the script did not declare in xmlAssertions",
                      { requestId, applicationState, declaredCellIds: scriptScope.declaredCellIds.slice(0, 25),
                        violations: scriptScope.violations.slice(0, 25), available: scriptScope.available,
                        error: scriptScope.error ?? null }, "warn");
                  }
                }
              } else if (acknowledgement.success) {
                acknowledgement = { ...acknowledgement, applicationState: "applied-and-verified" };
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
          const onlyReadOnlyNoopResults = readOnlyNoopSerialization &&
            pendingSaves.length > 0 &&
            deferredBatchAcks.length === pendingSaves.length &&
            pendingSaves.every(([, pending]) => scriptModeFromBatchValue(pending.value) === "read") &&
            pendingAutoLayoutRef.current?.awaitingExport !== true &&
            pendingNativePaletteRef.current?.awaitingExport !== true;
          if (onlyReadOnlyNoopResults) {
            for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
            recordDiagnostic("drawio.script.read-only.persistence-skipped",
              "Read-only script result was acknowledged without updating the authoritative XML, writing the local file, or creating a history snapshot",
              { event: data.event, xmlLengthBefore: pendingSaves[0]?.[1].beforeXml.length ?? null,
                xmlLengthSerialized: data.xml.length, duplicateXml, pendingAcknowledgementCount: deferredBatchAcks.length });
            return;
          }
          if (duplicateXml) {
            for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
            if (exportSerialization && pendingAutoLayoutRef.current?.awaitingExport) finishPendingAutoLayout(data.xml);
            if (exportSerialization && pendingNativePaletteRef.current?.awaitingExport) finishPendingNativePalette(data.xml);
            return;
          }
          lastSent.current = data.xml;
          recordDiagnostic("drawio.document.saved", "Native Draw.io XML autosave captured as the authoritative source", {
            event: data.event, xmlLength: data.xml.length
          });
          onDocumentChangeRef.current(data.xml);
          for (const acknowledgement of deferredBatchAcks) onNativeEditResultRef.current?.(acknowledgement);
          if (exportSerialization && pendingAutoLayoutRef.current?.awaitingExport) finishPendingAutoLayout(data.xml);
          if (exportSerialization && pendingNativePaletteRef.current?.awaitingExport) finishPendingNativePalette(data.xml);
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
