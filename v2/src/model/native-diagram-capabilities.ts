import type { NativeEditTarget } from "./native-edit-operations";

/**
 * Minimal read-only analysis contract used by the installed spatial-region analyzer.
 * Copilot mutations use the server-side XML patch path; this module does not define
 * mutation planners or a generic capability registry.
 */
export interface NativeDiagramCapabilityDescriptor {
  id: string;
  apiVersion: 1;
  kind: "quality";
  title: string;
  description: string;
}

export interface NativeDiagramCapabilityContext {
  /** Exact authoritative source XML used to build this context. */
  documentXml: string;
  /** Revision of documentXml, supplied by the trusted request boundary. */
  documentRevision: string;
  /** Native page identity; null for a bare mxGraphModel. */
  pageId: string | null;
  selectedCellId: string | null;
  /** Lightweight native-cell index, not a persisted graph model. */
  cells: readonly NativeEditTarget[];
}

export interface NativeDiagramFinding {
  ruleId: string;
  severity: "info" | "warning" | "error";
  message: string;
  pageId: string | null;
  cellIds: readonly string[];
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NativeDiagramAnalysisResult {
  capabilityId: string;
  apiVersion: 1;
  documentRevision: string;
  pageId: string | null;
  findings: readonly NativeDiagramFinding[];
}

export type NativeDiagramAnalysisResponse =
  | { status: "analyzed"; result: NativeDiagramAnalysisResult }
  | { status: "unsupported" | "invalid" | "stale"; message: string };

export interface NativeDiagramAnalysisProvider {
  descriptor: NativeDiagramCapabilityDescriptor;
  analyze(context: NativeDiagramCapabilityContext, request: unknown): NativeDiagramAnalysisResponse | Promise<NativeDiagramAnalysisResponse>;
}
