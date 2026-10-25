import { describe, expect, it } from "vitest";
import {
  classifyDrawioStyleCell,
  parseDrawioStyleImport,
  rewriteDrawioStyleString,
  serializeDrawioStyleExport,
  validateDrawioDiagramStyle,
  type DrawioDiagramStyle
} from "./drawio-style-library";
import { DEFAULT_DRAWIO_STYLE_LIBRARY } from "./drawio-style-presets";

describe("Draw.io document style library", () => {
  it("ships four editable presets with explicit node and edge rules", () => {
    expect(DEFAULT_DRAWIO_STYLE_LIBRARY.styles).toHaveLength(4);
    for (const style of DEFAULT_DRAWIO_STYLE_LIBRARY.styles) {
      expect(validateDrawioDiagramStyle(style).categories.node).toBeTruthy();
      expect(style.categories.edge).toBeTruthy();
      expect(style.categories.database).toBeTruthy();
      expect(style.categories.edgeDashed).toBeTruthy();
    }
  });

  it("classifies by native style/type and not by labels", () => {
    expect(classifyDrawioStyleCell({ edge: false, vertex: true, style: "shape=cylinder;fillColor=#fff" })).toBe("database");
    expect(classifyDrawioStyleCell({ edge: false, vertex: true, style: "shape=mxgraph.c4.person" })).toBe("user");
    expect(classifyDrawioStyleCell({ edge: false, vertex: true, style: "rounded=1", hasChildren: true })).toBe("container");
    expect(classifyDrawioStyleCell({ edge: true, vertex: false, style: "dashed=1;dashPattern=1 4" })).toBe("edgeDotted");
    expect(classifyDrawioStyleCell({ edge: false, vertex: true, style: "rounded=1" })).toBe("node");
    expect(classifyDrawioStyleCell({ edge: false, vertex: false, style: "" })).toBeNull();
  });

  it("Original removes explicit colors but preserves other visual and structural keys", () => {
    const result = rewriteDrawioStyleString(
      "shape=mxgraph.c4.container;fillColor=#ffeeaa;strokeColor=#aa5500;fontColor=#111111;strokeWidth=4;dashed=1;edgeStyle=orthogonalEdgeStyle;customToken=keep",
      "service",
      null
    );
    expect(result).toContain("shape=mxgraph.c4.container");
    expect(result).toContain("strokeWidth=4");
    expect(result).toContain("dashed=1");
    expect(result).toContain("edgeStyle=orthogonalEdgeStyle");
    expect(result).toContain("customToken=keep");
    expect(result).not.toMatch(/(?:^|;)(?:fillColor|strokeColor|fontColor)=/);
  });

  it("replaces all Studio-managed visual keys while preserving shape, routing and unknown keys", () => {
    const style = DEFAULT_DRAWIO_STYLE_LIBRARY.styles.find((item) => item.id === "editorial")!;
    const result = rewriteDrawioStyleString(
      "shape=cylinder;fillColor=#ff0000;strokeColor=#990000;fontColor=#000000;strokeWidth=9;rounded=0;dashed=1;edgeStyle=orthogonalEdgeStyle;exitX=1;vendorFlag=preserve",
      "database",
      style
    );
    expect(result).toContain("shape=cylinder");
    expect(result).toContain("edgeStyle=orthogonalEdgeStyle");
    expect(result).toContain("exitX=1");
    expect(result).toContain("vendorFlag=preserve");
    expect(result).toContain("fillColor=#E3F2E8");
    expect(result).toContain("strokeColor=#3D8262");
    expect(result).toContain("strokeWidth=1.6");
    expect(result).not.toContain("fillColor=#ff0000");
    expect(result).not.toContain("strokeWidth=9");
  });

  it("exports and imports one style with a versioned JSON envelope", () => {
    const style = DEFAULT_DRAWIO_STYLE_LIBRARY.styles[0]!;
    expect(parseDrawioStyleImport(serializeDrawioStyleExport(style))).toEqual(style);
  });

  it("rejects unsupported style properties and unsafe style values", () => {
    const base = DEFAULT_DRAWIO_STYLE_LIBRARY.styles[0]!;
    expect(() => validateDrawioDiagramStyle({
      ...base, categories: { ...base.categories, node: { fillColor: "red;shape=ellipse" } }
    })).toThrow(/Invalid value/);
    expect(() => validateDrawioDiagramStyle({
      ...base, categories: { ...base.categories, node: { shape: "ellipse" } }
    })).toThrow(/Unsupported managed style property/);
    expect(() => parseDrawioStyleImport(JSON.stringify({ schemaVersion: 2, style: base }))).toThrow(/schemaVersion 1/);
  });
});
