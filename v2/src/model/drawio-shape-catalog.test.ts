import { describe, expect, it } from "vitest";
import { DRAWIO_SHAPE_CATALOG_VERSION, searchDrawioShapeCatalog } from "./drawio-shape-catalog";

describe("curated Draw.io shape catalogue", () => {
  it("returns vetted styles and dimensions for Chinese and English queries", () => {
    expect(searchDrawioShapeCatalog("数据库")[0]).toMatchObject({
      id: "flowchart.database", kind: "vertex",
      style: "shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;",
      width: 100, height: 70
    });
    expect(searchDrawioShapeCatalog("UML lifeline")[0]).toMatchObject({
      id: "uml.lifeline", style: "shape=umlLifeline;perimeter=lifelinePerimeter;size=16;"
    });
  });
  it("does not imply exhaustive availability when there is no match", () => {
    expect(searchDrawioShapeCatalog("aws transit gateway")).toEqual([]);
    expect(DRAWIO_SHAPE_CATALOG_VERSION).toBe("drawio-v32.0.2-curated-1");
  });
  it("caps the result count", () => {
    expect(searchDrawioShapeCatalog("service", 100).length).toBeLessThanOrEqual(8);
  });
});
