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
  it("returns native C4 style recipes for Person, Software System, and Container", () => {
    expect(searchDrawioShapeCatalog("C4 Person")[0]).toMatchObject({
      id: "c4.person", category: "C4", width: 200, height: 180,
      style: "shape=mxgraph.c4.person2;whiteSpace=wrap;html=1;align=center;metaEdit=1;points=[[0.5,0,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0]];fillColor=#08427b;fontColor=#ffffff;strokeColor=#073763;fontSize=11;"
    });
    expect(searchDrawioShapeCatalog("C4 Software System")[0]).toMatchObject({
      id: "c4.software-system", width: 240, height: 120,
      style: "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontColor=#ffffff;fillColor=#1168bd;strokeColor=#0D5091;fontSize=11;"
    });
    expect(searchDrawioShapeCatalog("C4 Container")[0]).toMatchObject({
      id: "c4.container", width: 240, height: 120,
      style: "rounded=1;arcSize=10;html=1;whiteSpace=wrap;fontColor=#ffffff;fillColor=#23a2d9;strokeColor=#0E7DAD;fontSize=11;"
    });
  });
  it("does not imply exhaustive availability when there is no match", () => {
    expect(searchDrawioShapeCatalog("aws transit gateway")).toEqual([]);
    expect(DRAWIO_SHAPE_CATALOG_VERSION).toBe("drawio-v32.0.2-curated-2");
  });
  it("caps the result count", () => {
    expect(searchDrawioShapeCatalog("service", 100).length).toBeLessThanOrEqual(8);
  });
});
