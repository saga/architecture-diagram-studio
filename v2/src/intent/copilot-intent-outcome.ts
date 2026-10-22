import type { ResolvedNativeEditOperation } from "../model/native-edit-operations";

export type CopilotIntentOutcomeCode =
  | "command_ready"
  | "applied"
  | "answered"
  | "selected"
  | "needs_clarification"
  | "unsupported"
  | "proposal_required"
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

export interface CopilotNativeEditCommand {
  operations: ResolvedNativeEditOperation[];
  summary: string;
  pageId: string | null;
  documentRevision: string;
  requestId: string;
}

export interface CopilotSelection {
  cellId: string;
  pageId: string | null;
  label: string;
}

export interface CopilotNativeEditProposal {
  id: string;
  summary: string;
  operations: ResolvedNativeEditOperation[];
  pageId: string | null;
  documentRevision: string;
}

interface OutcomeBase extends CopilotResponseMetadata {
  reply: string;
}

export type CopilotIntentResponse =
  | (OutcomeBase & {
      outcome: "command_ready";
      nativeEdits: CopilotNativeEditCommand;
      selection?: CopilotSelection;
    })
  | (OutcomeBase & {
      outcome: "applied";
      requestId: string;
      documentRevision: string;
      persistedRevision?: string | null;
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
      outcome: "proposal_required";
      proposal: CopilotNativeEditProposal;
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
  "command_ready", "applied", "answered", "selected", "needs_clarification",
  "unsupported", "proposal_required", "stale_context", "failed"
] as const;

export function isCopilotIntentOutcome(value: unknown): value is CopilotIntentOutcomeCode {
  return typeof value === "string" && (COPILOT_INTENT_OUTCOMES as readonly string[]).includes(value);
}
