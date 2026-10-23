import { describe, expect, it } from "vitest";
import { isMissingSdkSessionError } from "./session-resume-errors";

describe("isMissingSdkSessionError", () => {
  it("recognizes an SDK session whose event history is missing", () => {
    expect(isMissingSdkSessionError(
      "Failed to load session events: Session not found: 933a38a0-cfg-c934579094123153"
    )).toBe(true);
    expect(isMissingSdkSessionError("No such session")).toBe(true);
    expect(isMissingSdkSessionError("Unknown session id")).toBe(true);
    expect(isMissingSdkSessionError("The session has been deleted")).toBe(true);
  });

  it("does not misclassify missing models or unrelated resources as missing sessions", () => {
    expect(isMissingSdkSessionError("model does not exist")).toBe(false);
    expect(isMissingSdkSessionError("The configured provider has been deleted")).toBe(false);
  });

  it("does not treat authentication, quota, or transport failures as recoverable misses", () => {
    expect(isMissingSdkSessionError("401 Unauthorized")).toBe(false);
    expect(isMissingSdkSessionError("Quota exceeded")).toBe(false);
    expect(isMissingSdkSessionError("ECONNRESET")).toBe(false);
    expect(isMissingSdkSessionError("Failed to connect to provider")).toBe(false);
  });
});
