import { describe, expect, it } from "vitest";
import { auditContrast, contrastRatio, relativeLuminance } from "./contrast";

describe("WCAG contrast utilities", () => {
  it("calculates known luminance and contrast values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("reports only pairs that fail their requested threshold", () => {
    const findings = auditContrast([
      { label: "body", foreground: "#0C1626", background: "#FFFFFF", minimum: 4.5 },
      { label: "weak", foreground: "#9A9A9A", background: "#FFFFFF", minimum: 4.5 }
    ]);
    expect(findings.map((finding) => finding.label)).toEqual(["weak"]);
  });
});
