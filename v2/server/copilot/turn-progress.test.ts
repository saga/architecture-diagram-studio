import { describe, expect, it } from "vitest";
import { CopilotTurnProgress } from "./turn-progress";

describe("CopilotTurnProgress", () => {
  it("counts reasoning deltas without retaining their contents", () => {
    const progress = new CopilotTurnProgress(1_000);
    expect(progress.observe("assistant.reasoning_delta", { deltaContent: "思考" }, 1_025)).toBe(true);
    const snapshot = progress.snapshot(1_050);
    expect(snapshot.phase).toBe("reasoning");
    expect(snapshot.reasoningDeltaEvents).toBe(1);
    expect(snapshot.reasoningDeltaBytes).toBe(Buffer.byteLength("思考", "utf8"));
    expect(snapshot.totalDeltaBytes).toBe(Buffer.byteLength("思考", "utf8"));
    expect(snapshot.timeToFirstDeltaMs).toBe(25);
    expect(JSON.stringify(snapshot)).not.toContain("思考");
  });

  it("reads the Copilot SDK deltaContent field for assistant message deltas", () => {
    const progress = new CopilotTurnProgress(1_000);
    expect(progress.observe("assistant.message_delta", { deltaContent: "response" }, 1_040)).toBe(true);
    const snapshot = progress.snapshot(1_050);
    expect(snapshot.phase).toBe("assistant_output");
    expect(snapshot.assistantDeltaEvents).toBe(1);
    expect(snapshot.assistantDeltaBytes).toBe(Buffer.byteLength("response", "utf8"));
    expect(snapshot.totalDeltaBytes).toBe(Buffer.byteLength("response", "utf8"));
    expect(snapshot.timeToFirstDeltaMs).toBe(40);
    expect(snapshot.quietMs).toBe(10);
    expect(snapshot.lastProgressEventType).toBe("assistant.message_delta");
    expect(JSON.stringify(snapshot)).not.toContain("response");
  });

  it("refreshes observable progress for reasoning_deltaContent chunks", () => {
    const progress = new CopilotTurnProgress(1_000);
    expect(progress.observe("assistant.reasoning_delta", { deltaContent: "reasoning" }, 1_075)).toBe(true);
    const snapshot = progress.snapshot(1_100);
    expect(snapshot.phase).toBe("reasoning");
    expect(snapshot.reasoningDeltaEvents).toBe(1);
    expect(snapshot.reasoningDeltaBytes).toBe(Buffer.byteLength("reasoning", "utf8"));
    expect(snapshot.quietMs).toBe(25);
    expect(snapshot.lastProgressEventType).toBe("assistant.reasoning_delta");
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

  it("does not treat empty tool-argument chunks as progress", () => {
    const progress = new CopilotTurnProgress(100);
    expect(progress.observe("assistant.tool_call_delta", {
      toolName: "propose_native_edits",
      inputDelta: ""
    }, 1_100)).toBe(false);
    expect(progress.snapshot(1_200).quietMs).toBe(1_100);
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
