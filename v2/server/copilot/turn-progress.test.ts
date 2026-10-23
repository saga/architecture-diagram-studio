import { describe, expect, it } from "vitest";
import { CopilotTurnProgress } from "./turn-progress";

describe("CopilotTurnProgress", () => {
  it("counts reasoning deltas without retaining their contents", () => {
    const progress = new CopilotTurnProgress(1_000);
    expect(progress.observe("assistant.reasoning_delta", { delta: "思考" }, 1_025)).toBe(true);
    const snapshot = progress.snapshot(1_050);
    expect(snapshot.phase).toBe("reasoning");
    expect(snapshot.reasoningDeltaEvents).toBe(1);
    expect(snapshot.reasoningDeltaBytes).toBe(Buffer.byteLength("思考", "utf8"));
    expect(snapshot.totalDeltaBytes).toBe(Buffer.byteLength("思考", "utf8"));
    expect(snapshot.timeToFirstDeltaMs).toBe(25);
    expect(JSON.stringify(snapshot)).not.toContain("思考");
  });

  it("recognizes tool input deltas and keeps the tool name as a phase hint", () => {
    const progress = new CopilotTurnProgress(10);
    expect(progress.observe("assistant.tool_call_delta", {
      toolName: "propose_native_edits",
      inputDelta: "{\"op\":"
    }, 20)).toBe(true);
    const snapshot = progress.snapshot(25);
    expect(snapshot.phase).toBe("tool_arguments:propose_native_edits");
    expect(snapshot.toolArgumentDeltaEvents).toBe(1);
    expect(snapshot.toolArgumentDeltaBytes).toBe(Buffer.byteLength("{\"op\":", "utf8"));
    expect(snapshot.toolName).toBe("propose_native_edits");
  });

  it("does not treat passive usage metadata as progress", () => {
    const progress = new CopilotTurnProgress(100);
    expect(progress.observe("session.usage_info", { currentTokens: 400 }, 5_000)).toBe(false);
    const snapshot = progress.snapshot(5_100);
    expect(snapshot.quietMs).toBe(5_000);
    expect(snapshot.eventCount).toBe(1);
    expect(snapshot.lastEventType).toBe("session.usage_info");
  });

  it("resets interval counters without losing cumulative counters", () => {
    const progress = new CopilotTurnProgress(0);
    progress.observe("assistant.message_delta", { delta: "hello" }, 50);
    const first = progress.snapshot(100, true);
    const second = progress.snapshot(150);
    expect(first.eventsSinceLastLog).toBe(1);
    expect(first.deltaBytesSinceLastLog).toBe(5);
    expect(second.eventsSinceLastLog).toBe(0);
    expect(second.deltaBytesSinceLastLog).toBe(0);
    expect(second.totalDeltaBytes).toBe(5);
  });
});
