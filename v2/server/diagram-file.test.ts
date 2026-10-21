import { describe, expect, it } from "vitest";
import { createEmptyDrawioDocument, normalizeNewDrawioFileName } from "./diagram-file";
import { isDiagramDocument } from "../src/model/types";

describe("new Draw.io file setup", () => {
  it("normalizes simple names to the native Draw.io extension", () => {
    expect(normalizeNewDrawioFileName("  architecture  ")).toBe("architecture.drawio");
    expect(normalizeNewDrawioFileName("architecture.drawio")).toBe("architecture.drawio");
  });
  it("rejects paths, empty names and non-Draw.io extensions", () => {
    expect(() => normalizeNewDrawioFileName("")).toThrow(/file name/i);
    expect(() => normalizeNewDrawioFileName("../architecture.drawio")).toThrow(/file name/i);
    expect(() => normalizeNewDrawioFileName("subfolder\\architecture.drawio")).toThrow(/file name/i);
    expect(() => normalizeNewDrawioFileName(".drawio")).toThrow(/name before/i);
    expect(() => normalizeNewDrawioFileName("architecture.xml")).toThrow(/\.drawio/i);
  });
  it("creates a valid empty C4 diagram with independent identity", () => {
    const first = createEmptyDrawioDocument("payments-platform.drawio");
    const second = createEmptyDrawioDocument("payments-platform.drawio");
    expect(isDiagramDocument(first)).toBe(true);
    expect(first.title).toBe("payments platform");
    expect(first.nodes).toEqual([]);
    expect(first.relations).toEqual([]);
    expect(first.id).not.toBe(second.id);
  });
});
