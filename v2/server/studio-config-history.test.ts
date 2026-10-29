import { describe, expect, it } from "vitest";
import { isValidConfigHistoryRecord, parseConfigHistory } from "./studio-config-history";

describe("studio config history parser", () => {
  it("reads complete JSON objects while ignoring malformed fragments", () => {
    const records = parseConfigHistory('prefix {"model":"m1","reasoningEffort":"low"}\n{broken}\n{"model":"m2","reasoningEffort":"high"}');
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.model)).toEqual(["m1", "m2"]);
  });

  it("rejects unsupported schema versions and malformed settings", () => {
    expect(isValidConfigHistoryRecord({ schemaVersion: 2, model: "m" })).toBe(false);
    expect(isValidConfigHistoryRecord({ schemaVersion: 1, model: "m", reasoningEffort: "high" })).toBe(true);
    expect(isValidConfigHistoryRecord({ model: 42 })).toBe(false);
  });
});
