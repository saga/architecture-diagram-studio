/** Shared lifecycle vocabulary for one native Draw.io operation request. */
export type NativeExecutionStatus =
  | "requested"
  | "executing"
  | "exported"
  | "persistence-pending"
  | "committed"
  | "completed-readonly"
  | "failed"
  | "timed-out-pending-reconciliation"
  | "partial";

export type NativeExecutionStage = "dispatch" | "editor-export" | "persistence" | "version-receipt";

export interface NativeExecutionReceipt {
  requestId: string;
  documentRevision: string;
  pageId: string | null;
  status: NativeExecutionStatus;
  startedAt: string;
  updatedAt: string;
  beforeXmlHash: string;
  afterXmlHash?: string;
  versionId?: string | null;
  persistenceRevision?: string | null;
  summary?: string;
  failureStage?: NativeExecutionStage;
  error?: string;
  /** A timeout is not proof of failure; reconciliation may still produce a committed receipt. */
  reconciliationRequired?: boolean;
}

const TERMINAL = new Set<NativeExecutionStatus>(["committed", "completed-readonly", "failed", "partial"]);
const ALLOWED: Record<NativeExecutionStatus, ReadonlySet<NativeExecutionStatus>> = {
  requested: new Set(["executing", "failed"]),
  executing: new Set(["exported", "persistence-pending", "committed", "completed-readonly", "failed", "partial", "timed-out-pending-reconciliation"]),
  exported: new Set(["persistence-pending", "committed", "failed", "partial", "timed-out-pending-reconciliation"]),
  "persistence-pending": new Set(["committed", "failed", "partial", "timed-out-pending-reconciliation"]),
  "timed-out-pending-reconciliation": new Set(["exported", "persistence-pending", "committed", "completed-readonly", "failed", "partial"]),
  committed: new Set(),
  "completed-readonly": new Set(),
  failed: new Set(),
  partial: new Set()
};

export function transitionNativeExecution(
  receipt: NativeExecutionReceipt,
  status: NativeExecutionStatus,
  patch: Partial<Omit<NativeExecutionReceipt, "requestId" | "documentRevision" | "pageId" | "startedAt" | "status">> = {},
  now = new Date().toISOString()
): NativeExecutionReceipt {
  if (TERMINAL.has(receipt.status) && status !== receipt.status) {
    throw new Error("A terminal native execution receipt cannot transition to another status.");
  }
  if (status !== receipt.status && !ALLOWED[receipt.status].has(status)) {
    throw new Error("Invalid native execution transition: " + receipt.status + " -> " + status);
  }
  return { ...receipt, ...patch, status, updatedAt: now };
}

export function createNativeExecutionReceipt(input: {
  requestId: string;
  documentRevision: string;
  pageId: string | null;
  beforeXmlHash: string;
  summary?: string;
  now?: string;
}): NativeExecutionReceipt {
  const now = input.now ?? new Date().toISOString();
  return {
    requestId: input.requestId,
    documentRevision: input.documentRevision,
    pageId: input.pageId,
    status: "requested",
    startedAt: now,
    updatedAt: now,
    beforeXmlHash: input.beforeXmlHash,
    ...(input.summary ? { summary: input.summary } : {})
  };
}
