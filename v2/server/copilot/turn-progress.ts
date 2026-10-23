/**
 * Compact, content-free metrics for a single Copilot model call.
 * This observes event types and byte counts, never stores or logs the delta text itself.
 */
export interface TurnProgressSnapshot {
  phase: string;
  elapsedMs: number;
  quietMs: number;
  sinceLastDeltaMs: number | null;
  eventCount: number;
  eventsSinceLastLog: number;
  deltaBytesSinceLastLog: number;
  totalDeltaBytes: number;
  reasoningDeltaEvents: number;
  reasoningDeltaBytes: number;
  assistantDeltaEvents: number;
  assistantDeltaBytes: number;
  toolArgumentDeltaEvents: number;
  toolArgumentDeltaBytes: number;
  timeToFirstDeltaMs: number | null;
  lastEventType: string | null;
  lastProgressEventType: string | null;
  toolName: string | null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return "";
}

function toolNameOf(record: Record<string, unknown>): string | null {
  const direct = firstString(record, ["toolName", "tool_name", "toolCallName"]);
  if (direct) return direct.slice(0, 100);
  const tool = record.tool;
  if (tool && typeof tool === "object" && !Array.isArray(tool)) {
    const nested = firstString(tool as Record<string, unknown>, ["name", "toolName"]);
    if (nested) return nested.slice(0, 100);
  }
  return null;
}

export class CopilotTurnProgress {
  private readonly startedAt: number;
  private lastProgressAt: number;
  private lastDeltaAt: number | null = null;
  private firstDeltaAt: number | null = null;
  private lastEventType: string | null = null;
  private lastProgressEventType: string | null = null;
  private phase = "waiting_for_first_activity";
  private toolName: string | null = null;
  private eventCount = 0;
  private windowEventCount = 0;
  private windowDeltaBytes = 0;
  private totalDeltaBytes = 0;
  private reasoningDeltaEvents = 0;
  private reasoningDeltaBytes = 0;
  private assistantDeltaEvents = 0;
  private assistantDeltaBytes = 0;
  private toolArgumentDeltaEvents = 0;
  private toolArgumentDeltaBytes = 0;

  constructor(startedAt = Date.now()) {
    this.startedAt = startedAt;
    this.lastProgressAt = startedAt;
  }

  /** Returns true only when an event represents observable progress or a meaningful turn transition. */
  observe(eventType: string, payload?: unknown, now = Date.now()): boolean {
    const type = eventType.toLowerCase();
    const data = recordOf(payload);
    this.eventCount++;
    this.windowEventCount++;
    this.lastEventType = eventType;

    const inputDelta = typeof data.inputDelta === "string" ? data.inputDelta : undefined;
    const delta = firstString(data, ["delta", "inputDelta", "textDelta", "contentDelta"]);
    const hasDelta = /delta/i.test(eventType) || inputDelta !== undefined;
    const reasoningDelta = /reasoning/i.test(type) && hasDelta;
    const toolArgumentDelta = inputDelta !== undefined || (/tool/i.test(type) && /(delta|input|argument)/i.test(type));
    const assistantDelta = !reasoningDelta && !toolArgumentDelta && /(?:assistant\.)?(?:message|text).*delta/i.test(type);

    if (hasDelta) {
      const bytes = Buffer.byteLength(delta, "utf8");
      this.totalDeltaBytes += bytes;
      this.windowDeltaBytes += bytes;
      if (delta.length > 0) {
        this.firstDeltaAt ??= now;
        this.lastDeltaAt = now;
      }
      if (reasoningDelta) {
        this.reasoningDeltaEvents++;
        this.reasoningDeltaBytes += bytes;
      } else if (toolArgumentDelta) {
        this.toolArgumentDeltaEvents++;
        this.toolArgumentDeltaBytes += bytes;
      } else if (assistantDelta) {
        this.assistantDeltaEvents++;
        this.assistantDeltaBytes += bytes;
      }
    }

    const observedToolName = toolNameOf(data);
    if (observedToolName && /tool/i.test(type)) this.toolName = observedToolName;

    if (reasoningDelta) this.phase = "reasoning";
    else if (toolArgumentDelta) this.phase = this.toolName ? "tool_arguments:" + this.toolName : "tool_arguments";
    else if (assistantDelta) this.phase = "assistant_output";
    else if (/tool.*execution_start|tool.*execution_started/i.test(type)) this.phase = "tool_execution";
    else if (/assistant\.tool_call|tool.*call_start/i.test(type)) this.phase = this.toolName ? "tool_call:" + this.toolName : "tool_call";
    else if (/assistant\.turn_start|assistant\.turn_started/i.test(type)) this.phase = "model_call_started";
    else if (/assistant\.turn_end|session\.idle/i.test(type)) this.phase = "finalizing";

    const meaningfulDelta = hasDelta && delta.length > 0;
    const meaningfulTransition = /assistant\.turn_start|assistant\.turn_started|assistant\.tool_call(?:$|_(?:start|started|complete|completed))|tool.*execution_start|tool.*execution_started|tool.*execution_complete|tool.*execution_failed|session\.idle/i.test(eventType);
    const isProgress = meaningfulDelta || meaningfulTransition;
    if (isProgress) {
      this.lastProgressAt = now;
      this.lastProgressEventType = eventType;
    }
    return isProgress;
  }

  snapshot(now = Date.now(), resetWindow = false): TurnProgressSnapshot {
    const result: TurnProgressSnapshot = {
      phase: this.phase,
      elapsedMs: Math.max(0, now - this.startedAt),
      quietMs: Math.max(0, now - this.lastProgressAt),
      sinceLastDeltaMs: this.lastDeltaAt === null ? null : Math.max(0, now - this.lastDeltaAt),
      eventCount: this.eventCount,
      eventsSinceLastLog: this.windowEventCount,
      deltaBytesSinceLastLog: this.windowDeltaBytes,
      totalDeltaBytes: this.totalDeltaBytes,
      reasoningDeltaEvents: this.reasoningDeltaEvents,
      reasoningDeltaBytes: this.reasoningDeltaBytes,
      assistantDeltaEvents: this.assistantDeltaEvents,
      assistantDeltaBytes: this.assistantDeltaBytes,
      toolArgumentDeltaEvents: this.toolArgumentDeltaEvents,
      toolArgumentDeltaBytes: this.toolArgumentDeltaBytes,
      timeToFirstDeltaMs: this.firstDeltaAt === null ? null : Math.max(0, this.firstDeltaAt - this.startedAt),
      lastEventType: this.lastEventType,
      lastProgressEventType: this.lastProgressEventType,
      toolName: this.toolName
    };
    if (resetWindow) {
      this.windowEventCount = 0;
      this.windowDeltaBytes = 0;
    }
    return result;
  }
}
