import { describe, expect, it } from "vitest";
import { hideNativeScriptDetails } from "./hide-native-script-details";

describe("hideNativeScriptDetails", () => {
  it("keeps the change summary and removes the exact script review section", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const result = hideNativeScriptDetails(
      "Proposed changes: Add ddd below bbb.\n\n**Exact native script for review:**\n\n" +
      fence + "javascript\nwindow.alert('hidden');\n" + fence + "\n\nNo change has been applied yet."
    );
    expect(result).toBe("Proposed changes: Add ddd below bbb.");
    expect(result).not.toContain("window.alert");
    expect(result).not.toContain("Exact native script");
  });

  it("removes fenced JavaScript when a prior assistant turn included it inline", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const result = hideNativeScriptDetails("Planned edit:\n\n" + fence + "js\nmodel.setValue(cell, 'x');\n" + fence + "\n\nThis is only a summary.");
    expect(result).toBe("Planned edit:\n\n\n\nThis is only a summary.".replace(/\n{3,}/g, "\n\n"));
  });

  it("does not change ordinary prose", () => {
    expect(hideNativeScriptDetails("Added ddd below bbb and connected it."))
      .toBe("Added ddd below bbb and connected it.");
  });
});
