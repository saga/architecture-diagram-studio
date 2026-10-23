import { describe, expect, it } from "vitest";
import { DRAWIO_EDITOR_CONFIG, DRAWIO_EMBED_URL } from "./DrawioFrame";

describe("embedded Draw.io shape-library defaults", () => {
  it("keeps the shape panel visible and enables built-in libraries in embed mode", () => {
    const parameters = new URL(DRAWIO_EMBED_URL, "http://localhost").searchParams;

    expect(parameters.get("libraries")).toBe("1");
    expect(parameters.get("sidebar")).not.toBe("0");
    expect(parameters.get("embed")).toBe("1");
    expect(parameters.get("configure")).toBe("1");
  });

  it("includes the built-in C4 palette in the initial shape library list", () => {
    const libraries = DRAWIO_EDITOR_CONFIG.defaultLibraries.split(";");

    expect(libraries).toContain("c4");
    expect(libraries).toContain("general");
    expect(libraries).toContain("uml");
  });

  it("bumps the editor preference version when palette defaults change", () => {
    expect(DRAWIO_EDITOR_CONFIG.version).toBe("2026-10-c4-default-library-v2");
  });
});
