import { describe, expect, it } from "vitest";
import { auditContrast, contrastRatio, relativeLuminance } from "./contrast";
import { createC4Fixture, createFlowFixture } from "../model/fixtures";
import { nodePaint, relationPaint } from "./styles";
import { tokens } from "./tokens";

describe("WCAG contrast utilities", () => {
  it("calculates known luminance and contrast values", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBe(1);
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("keeps current semantic node and relation colors above contrast thresholds", () => {
    const documents = [createC4Fixture(), createFlowFixture()];
    for (const document of documents) {
      for (const node of document.nodes) {
        const paint = nodePaint(node);
        expect(contrastRatio(paint.text, paint.fill)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(paint.stroke, paint.fill)).toBeGreaterThanOrEqual(3);
      }
      for (const relation of document.relations) {
        expect(contrastRatio(relationPaint(relation).stroke, tokens.canvas)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("reports only pairs that fail their requested threshold", () => {
    const findings = auditContrast([
      { label: "body", foreground: "#0C1626", background: "#FFFFFF", minimum: 4.5 },
      { label: "weak", foreground: "#9A9A9A", background: "#FFFFFF", minimum: 4.5 }
    ]);
    expect(findings.map((finding) => finding.label)).toEqual(["weak"]);
  });
});
