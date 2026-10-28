import { describe, expect, it } from "vitest";
import { requiresNativeEditReview } from "./edit-confirmation-policy";

describe("native edit review policy", () => {
  it("applies edits directly when the variable is unset", () => {
    expect(requiresNativeEditReview(undefined)).toBe(false);
  });

  it("treats a blank value as unset", () => {
    expect(requiresNativeEditReview("")).toBe(false);
    expect(requiresNativeEditReview("   ")).toBe(false);
  });

  it("restores the review gate for common truthy values", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " On "]) {
      expect(requiresNativeEditReview(value)).toBe(true);
    }
  });

  it("ignores values that are not explicitly truthy", () => {
    for (const value of ["0", "false", "no", "off", "maybe"]) {
      expect(requiresNativeEditReview(value)).toBe(false);
    }
  });
});
