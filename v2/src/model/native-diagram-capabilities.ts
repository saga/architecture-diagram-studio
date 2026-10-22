import type { NativeEditOperation, NativeEditTarget } from "./native-edit-operations";

/**
 * Extension contracts for future native-Draw.io capabilities.
 *
 * These types intentionally do not define or persist a second graph model. A capability
 * receives the authoritative XML plus the active-page cell index, then either returns
 * allowlisted native operations or read-only findings. It never returns replacement XML.
 */
export type NativeDiagramCapabilityKind = "layout" | "style" | "quality" | "structure";
export type NativeDiagramOperationCapabilityKind = Exclude<NativeDiagramCapabilityKind, "quality">;

export type NativeDiagramOperationCapabilityDescriptor =
  Omit<NativeDiagramCapabilityDescriptor, "kind"> & { kind: NativeDiagramOperationCapabilityKind };
export type NativeDiagramAnalysisCapabilityDescriptor =
  Omit<NativeDiagramCapabilityDescriptor, "kind"> & { kind: "quality" };

export interface NativeDiagramCapabilityDescriptor {
  /** Stable machine identifier, for example "layout.orthogonal" or "quality.edge-crossing". */
  id: string;
  /** Version of this capability's request/result contract, independent of the Draw.io version. */
  apiVersion: 1;
  kind: NativeDiagramCapabilityKind;
  title: string;
  description: string;
}

export interface NativeDiagramCapabilityContext {
  /** Exact authoritative source XML used to build this context. Treat it as untrusted data. */
  documentXml: string;
  /** Content hash/revision supplied by the trusted request boundary for documentXml. Workspace mode uses the server-issued revision; plans must echo it unchanged. */
  documentRevision: string;
  /** Native page identity. Null only for legacy bare mxGraphModel documents. */
  pageId: string | null;
  /** Native selection observed against the same revision, or null when nothing is selected. */
  selectedCellId: string | null;
  /** Lightweight native-cell index for target resolution; not a complete graph/model. Read geometry or other facts from documentXml via shared XML utilities. */
  cells: readonly NativeEditTarget[];
}

export interface NativeDiagramFinding {
  ruleId: string;
  severity: "info" | "warning" | "error";
  message: string;
  pageId: string | null;
  /** Exact native cell IDs implicated by this finding. Empty when the finding is page-level. */
  cellIds: readonly string[];
  /** Small, JSON-safe facts for diagnostics; never place full XML or secret data here. */
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NativeDiagramOperationPlan {
  capabilityId: string;
  apiVersion: 1;
  /** Optimistic concurrency token. The executor must reject a plan based on an older revision. */
  baseRevision: string;
  pageId: string | null;
  summary: string;
  /** Mutations use the shared typed operation vocabulary, never raw replacement XML. */
  operations: readonly NativeEditOperation[];
  findings?: readonly NativeDiagramFinding[];
}

export type NativeDiagramPlanResult =
  | { status: "planned"; plan: NativeDiagramOperationPlan }
  | { status: "unsupported" | "invalid" | "ambiguous" | "stale"; message: string; details?: Readonly<Record<string, string | number | boolean | null>> };

/**
 * Contract for future layout/style/structural planners. Implementations must validate their
 * own request shape, use only native page/cell facts, and return operations rather than mutate
 * XML or the editor directly. Plans still pass the shared operation validation and revision
 * checks before the native editor bridge may execute them.
 */
export interface NativeDiagramOperationProvider {
  descriptor: NativeDiagramOperationCapabilityDescriptor;
  plan(context: NativeDiagramCapabilityContext, request: unknown): NativeDiagramPlanResult | Promise<NativeDiagramPlanResult>;
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

/** Read-only checks such as overlap/routing/contrast diagnostics belong behind this contract. */
export interface NativeDiagramAnalysisProvider {
  descriptor: NativeDiagramAnalysisCapabilityDescriptor;
  analyze(context: NativeDiagramCapabilityContext, request: unknown): NativeDiagramAnalysisResponse | Promise<NativeDiagramAnalysisResponse>;
}

/**
 * Registry seam only; no registry or optional capability is installed by this file.
 * Runtime registration must be explicit and must not make planned capabilities appear enabled.
 */
export interface NativeDiagramCapabilityRegistry {
  list(): readonly NativeDiagramCapabilityDescriptor[];
  getOperationProvider(id: string): NativeDiagramOperationProvider | undefined;
  getAnalysisProvider(id: string): NativeDiagramAnalysisProvider | undefined;
}
