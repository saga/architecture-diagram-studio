import { describe, expect, it } from "vitest";
import { interpretNativeXmlChange } from "./drawio-xml-diff";

const diagram = (cells: string) => `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel>`;

describe("native Draw.io XML impact interpreter", () => {
  it("reports additions, removals, labels, geometry, style and edge terminals", async () => {
    const before = diagram('<mxCell id="a" value="Alpha" vertex="1" parent="1" style="rounded=0;" ><mxGeometry x="0" y="0" width="80" height="30" as="geometry"/></mxCell><mxCell id="b" value="Beta" vertex="1" parent="1"><mxGeometry x="100" y="0" width="80" height="30" as="geometry"/></mxCell><mxCell id="e" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"/></mxCell>');
    const after = diagram('<mxCell id="a" value="Alpha updated" vertex="1" parent="1" style="rounded=1;" ><mxGeometry x="10" y="0" width="80" height="30" as="geometry"/></mxCell><mxCell id="c" value="Gamma" vertex="1" parent="1"><mxGeometry x="200" y="0" width="80" height="30" as="geometry"/></mxCell><mxCell id="e" edge="1" parent="1" source="a" target="c"><mxGeometry relative="1" as="geometry"/></mxCell>');
    const report = await interpretNativeXmlChange(before, after);
    expect(report.summary.added).toBe(1);
    expect(report.summary.removed).toBe(1);
    expect(report.summary.changed).toBe(2);
    expect(report.changes.find((item) => item.cellId === "a")?.fields).toEqual(expect.arrayContaining(["label", "style", "geometry"]));
    expect(report.changes.find((item) => item.cellId === "e")?.fields).toContain("targetId");
    expect(report.beforeHash).not.toBe(report.afterHash);
  });

  it("detects nested edge waypoints and geometry metadata changes", async () => {
    const before = diagram('<mxCell id="edge" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="10" y="20"/></Array><mxPoint x="1" y="2" as="sourcePoint"/><mxPoint x="90" y="20" as="targetPoint"/></mxGeometry></mxCell>');
    const after = diagram('<mxCell id="edge" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="10" y="40"/></Array><mxPoint x="1" y="2" as="sourcePoint"/><mxPoint x="90" y="20" as="targetPoint"/></mxGeometry></mxCell>');
    const report = await interpretNativeXmlChange(before, after);
    expect(report.summary.changed).toBe(1);
    expect(report.changes[0].fields).toContain("geometryContent");
  });

  it("preserves page identity and does not mutate source XML", async () => {
    const xml = '<mxfile><diagram id="page-a" name="Page A"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
    const report = await interpretNativeXmlChange(xml, xml);
    expect(report.changed).toBe(false);
    expect(report.pageIdsBefore).toEqual(["page-a"]);
    expect(report.changes).toEqual([]);
    expect(xml).toContain('id="page-a"');
  });
});
