export type CopilotIntentOutcomeCode =
  | "xml_committed"
  | "xml_patch_ready"
  | "answered"
  | "selected"
  | "needs_clarification"
  | "unsupported"
  | "stale_context"
  | "failed";

export interface CopilotResponseMetadata {
  sessionId?: string;
  model?: string;
  provider?: string;
  durationMs?: number;
  reasoningEffort?: string;
  toolsUsed?: string[];
  usage?: unknown;
  modelCallUsages?: unknown[];
  contextUsage?: unknown;
}

export interface CopilotSelection {
  cellId: string;
  pageId: string | null;
  label: string;
}

interface OutcomeBase extends CopilotResponseMetadata {
  reply: string;
}

export type CopilotIntentResponse =
  | (OutcomeBase & {
      outcome: "xml_committed";
      requestId: string;
      persistence: { workspaceRevision?: string | null; version?: { id?: string } | null; saved?: boolean; [key: string]: unknown };
    })
  | (OutcomeBase & {
      outcome: "xml_patch_ready";
      requestId: string;
      drawioXml: string;
      documentRevision: string;
      patchedRevision: string;
      changedCellIds: string[];
    })
  | (OutcomeBase & { outcome: "answered" })
  | (OutcomeBase & {
      outcome: "selected";
      selection: CopilotSelection;
    })
  | (OutcomeBase & {
      outcome: "needs_clarification";
      question?: string;
    })
  | (OutcomeBase & {
      outcome: "unsupported";
      reason?: string;
    })
  | (OutcomeBase & {
      outcome: "stale_context";
      error: string;
      documentRevision?: string | null;
    })
  | (OutcomeBase & {
      outcome: "failed";
      error: string;
      requestId?: string;
    });

export const COPILOT_INTENT_OUTCOMES: readonly CopilotIntentOutcomeCode[] = [
  "xml_committed", "xml_patch_ready", "answered", "selected", "needs_clarification",
  "unsupported", "stale_context", "failed"
] as const;

export function isCopilotIntentOutcome(value: unknown): value is CopilotIntentOutcomeCode {
  return typeof value === "string" && (COPILOT_INTENT_OUTCOMES as readonly string[]).includes(value);
}
