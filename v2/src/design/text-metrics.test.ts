import { describe, expect, it } from "vitest";
import { containsWideCharacters, measureTextWidth, truncateTextToWidth, wrapTextToWidth } from "./text-metrics";

describe("Unicode-aware text metrics", () => {
  it("allocates full-em width to CJK glyphs and less than one em to Latin glyphs", () => {
    expect(measureTextWidth("界", 13)).toBe(13);
    expect(measureTextWidth("WW", 13)).toBeGreaterThan(measureTextWidth("ii", 13));
    expect(containsWideCharacters("API 服务")).toBe(true);
    expect(containsWideCharacters("API service")).toBe(false);
  });

  it("wraps wide CJK text and bounded English phrases without losing the source text", () => {
    const cjk = wrapTextToWidth("这是一个需要换行的架构组件描述", 39, 13);
    const english = wrapTextToWidth("Authentication boundary and session token validation", 75, 13);
    expect(cjk.length).toBeGreaterThan(1);
    expect(english.length).toBeGreaterThan(1);
    expect(cjk.every((line) => measureTextWidth(line, 13) <= 39)).toBe(true);
    expect(english.every((line) => measureTextWidth(line, 13) <= 75)).toBe(true);
  });

  it("truncates by rendered-width estimate without splitting a surrogate pair", () => {
    const value = "存储 Service";
    const truncated = truncateTextToWidth(value, 44, 13);
    expect(truncated.endsWith("…")).toBe(true);
    expect(measureTextWidth(truncated, 13)).toBeLessThanOrEqual(44);
  });
});
