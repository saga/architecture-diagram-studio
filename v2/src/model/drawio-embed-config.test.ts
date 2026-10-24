import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const drawioFrameSource = readFileSync(new URL("../components/DrawioFrame.tsx", import.meta.url), "utf8");

describe("Draw.io embed button configuration", () => {
  it("hides Save, Save and Exit, and Exit instead of replacing Save with Save and Exit", () => {
    // In Draw.io embed mode, noSaveBtn=1 changes Save into Save and Exit.
    // saveAndExit=0 is required to suppress that extra action.
    expect(drawioFrameSource).toContain("saveAndExit=0&noSaveBtn=1&noExitBtn=1");
    expect(drawioFrameSource).toMatch(/saveAndExit:\\s*false/);
    expect(drawioFrameSource).toMatch(/noSaveBtn:\\s*true/);
    expect(drawioFrameSource).toMatch(/noExitBtn:\\s*true/);
  });
});
