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

describe("hideNativeScriptDetails review headers", () => {
  it("removes the localized proposal review section", () => {
    const result = hideNativeScriptDetails(
      "Proposed changes: Give every connector a curved route.\n\n" +
      "原生 Draw.io 脚本（完整内容）：\nvar root = model.getRoot();\nmodel.beginUpdate();\n\n" +
      "只有实际结果检查全部通过并且序列化 XML 符合预期，才会确认成功。\n\n" +
      "Nothing has been changed yet. Confirm to apply this proposal to the current diagram."
    );
    expect(result).toBe("Proposed changes: Give every connector a curved route.");
    expect(result).not.toContain("model.getRoot");
  });

  it("removes a localized header written with an ASCII colon", () => {
    const result = hideNativeScriptDetails("Summary line.\n\n原生 Draw.io 脚本（完整内容）:\nvar a = 1;");
    expect(result).toBe("Summary line.");
  });
});
