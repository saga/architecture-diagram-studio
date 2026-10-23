import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_COPILOT_TURN_TIMEOUT_MS,
  MAX_COPILOT_TURN_TIMEOUT_MS,
  MIN_COPILOT_TURN_TIMEOUT_MS,
  resolveCopilotTurnTimeoutMs,
  DEFAULT_COPILOT_TURN_IDLE_TIMEOUT_MS,
  MAX_COPILOT_TURN_IDLE_TIMEOUT_MS,
  MIN_COPILOT_TURN_IDLE_TIMEOUT_MS,
  resolveCopilotTurnIdleTimeoutMs
} from "./turn-timeout";

describe("Copilot turn timeout configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to five minutes", () => {
    expect(resolveCopilotTurnTimeoutMs(undefined)).toBe(300_000);
    expect(resolveCopilotTurnTimeoutMs("")).toBe(DEFAULT_COPILOT_TURN_TIMEOUT_MS);
  });

  it("accepts configured milliseconds", () => {
    expect(resolveCopilotTurnTimeoutMs("120000")).toBe(120_000);
    expect(resolveCopilotTurnTimeoutMs("600000")).toBe(600_000);
  });

  it("falls back to the default for invalid values", () => {
    for (const value of ["NaN", "abc", "3.5", "-1000", "Infinity"]) {
      expect(resolveCopilotTurnTimeoutMs(value)).toBe(DEFAULT_COPILOT_TURN_TIMEOUT_MS);
    }
  });

  it("bounds unsafe values", () => {
    expect(resolveCopilotTurnTimeoutMs("1")).toBe(MIN_COPILOT_TURN_TIMEOUT_MS);
    expect(resolveCopilotTurnTimeoutMs("3600000")).toBe(MAX_COPILOT_TURN_TIMEOUT_MS);
  });

  it("reads the environment variable used by the local server", () => {
    vi.stubEnv("STUDIO_COPILOT_TURN_TIMEOUT_MS", "420000");
    expect(resolveCopilotTurnTimeoutMs()).toBe(420_000);
  });
});

describe("Copilot idle timeout configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to a 90-second no-progress deadline", () => {
    expect(resolveCopilotTurnIdleTimeoutMs(undefined)).toBe(90_000);
    expect(resolveCopilotTurnIdleTimeoutMs("")).toBe(DEFAULT_COPILOT_TURN_IDLE_TIMEOUT_MS);
  });

  it("accepts configured milliseconds and bounds extreme values", () => {
    expect(resolveCopilotTurnIdleTimeoutMs("120000")).toBe(120_000);
    expect(resolveCopilotTurnIdleTimeoutMs("1")).toBe(MIN_COPILOT_TURN_IDLE_TIMEOUT_MS);
    expect(resolveCopilotTurnIdleTimeoutMs("900000")).toBe(MAX_COPILOT_TURN_IDLE_TIMEOUT_MS);
    expect(resolveCopilotTurnIdleTimeoutMs("not-a-number")).toBe(DEFAULT_COPILOT_TURN_IDLE_TIMEOUT_MS);
  });

  it("reads the environment variable used by the local server", () => {
    vi.stubEnv("STUDIO_COPILOT_TURN_IDLE_TIMEOUT_MS", "42000");
    expect(resolveCopilotTurnIdleTimeoutMs()).toBe(42_000);
  });
});
