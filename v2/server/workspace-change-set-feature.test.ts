import { describe, expect, it } from "vitest";
import { isWorkspaceChangeSetApiEnabled } from "./workspace-change-set-feature";

describe("workspace change-set API feature gate", () => {
  it("is disabled unless explicitly opted in", () => {
    expect(isWorkspaceChangeSetApiEnabled({})).toBe(false);
    expect(isWorkspaceChangeSetApiEnabled({ STUDIO_ENABLE_CHANGE_SET_API: "true" })).toBe(false);
    expect(isWorkspaceChangeSetApiEnabled({ STUDIO_ENABLE_CHANGE_SET_API: "1" })).toBe(true);
  });
});
