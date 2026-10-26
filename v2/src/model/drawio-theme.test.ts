import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { findDrawioElements, parseDrawioXml, serializeDrawioXml } from "./drawio-xml-dom";
import {
  applyDrawioDiagramTheme,
  applyDrawioThemeBackground,
  calculateNativePalettePlan,
  detectDrawioDiagramTheme,
  readDrawioModelBackground,
  type DrawioDiagramTheme
} from "./drawio-theme";

function cellById(xml: string, id: string) {
  const document = parseDrawioXml(xml);
  return findDrawioElements(document, "mxCell").find((cell) => cell.getAttribute("id") === id);
}

function compressPage(xml: string): string {
  const encoded = encodeURIComponent(xml);
  const compressed = deflateSync(strToU8(encoded));
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decompressPage(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return decodeURIComponent(strFromU8(inflateSync(bytes)));
}

const sourceModel = '<mxGraphModel background="light-dark(#FFFF66,#121212)" grid="1" gridSize="4" page="1" customModelAttribute="keep-me"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="plain" value="Plain" vertex="1" parent="1"/><mxCell id="colored" value="Colored" style="shape=rectangle;fillColor=#ffffff;strokeColor=#000000;fontColor=#000000;rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell><mxCell id="text" value="Text only" style="text;html=1;align=center;fillColor=#ffffff;strokeColor=#000000;whiteSpace=wrap;" vertex="1" parent="1"/><mxCell id="edge" edge="1" parent="1" source="colored" target="plain" style="endArrow=block;strokeColor=#111111;fontColor=#222222;rounded=0;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="40" y="50"/></Array></mxGeometry></mxCell></root></mxGraphModel>';

describe("native Draw.io diagram theme presets", () => {
  it("colors unstyled vertices, recolors externally styled cells, and preserves non-color styles", () => {
    const source = '<mxfile host="app.diagrams.net" data-owner="external"><diagram id="p1" name="Main">' + sourceModel + '</diagram></mxfile>';
    const themed = applyDrawioDiagramTheme(source, "ocean-depths");

    expect(themed).not.toBe(source);
    expect(themed).toContain('data-owner="external"');
    expect(readDrawioModelBackground(themed)).toBe("light-dark(#FFFF66,#121212)");

    const plain = cellById(themed, "plain");
    expect(plain?.getAttribute("style")).toContain("fillColor=#F8FAFC");
    expect(plain?.getAttribute("style")).toContain("strokeColor=#64748B");
    expect(plain?.getAttribute("style")).toContain("fontColor=#17324D");

    const colored = cellById(themed, "colored");
    expect(colored?.getAttribute("style")).toContain("fillColor=#E0F2FE");
    expect(colored?.getAttribute("style")).toContain("strokeColor=#0369A1");
    expect(colored?.getAttribute("style")).toContain("fontColor=#17324D");
    expect(colored?.getAttribute("style")).toContain("rounded=1");
    expect(colored?.getAttribute("style")).toContain("html=1");
    expect(colored?.getAttribute("style")).not.toContain("fillColor=#ffffff");

    const text = cellById(themed, "text");
    expect(text?.getAttribute("style")).toContain("fontColor=#17324D");
    expect(text?.getAttribute("style")).toContain("fillColor=none");
    expect(text?.getAttribute("style")).toContain("strokeColor=none");
    expect(text?.getAttribute("style")).not.toContain("fillColor=#ffffff");
    expect(text?.getAttribute("style")).not.toContain("strokeColor=#000000");

    const edge = cellById(themed, "edge");
    expect(edge?.getAttribute("style")).toContain("strokeColor=#0F766E");
    expect(edge?.getAttribute("style")).toContain("fontColor=#334155");
    expect(edge?.getAttribute("style")).toContain("endArrow=block");
    expect(edge?.getAttribute("style")).toContain("rounded=0");
    expect(themed).toContain('x="40" y="50"');
    expect(themed).toContain('grid="1"');
    expect(themed).toContain('gridSize="4"');
  });

  it("applies a preset to compressed pages and leaves their page background/grid settings alone", () => {
    const inner = sourceModel.replace('background="light-dark(#FFFF66,#121212)"', 'background="#FFFF66"');
    const encoded = compressPage(inner);
    const source = '<mxfile host="app.diagrams.net"><diagram id="compressed" name="Compressed">' + encoded + '</diagram></mxfile>';

    const themed = applyDrawioDiagramTheme(source, "midnight-galaxy");
    expect(themed).not.toBe(source);
    const outer = parseDrawioXml(themed);
    const page = findDrawioElements(outer, "diagram")[0];
    expect(page).toBeTruthy();
    const decoded = decompressPage(page?.textContent ?? "");
    const model = parseDrawioXml(decoded);
    const vertex = findDrawioElements(model, "mxCell").find((cell) => cell.getAttribute("id") === "colored");
    const edge = findDrawioElements(model, "mxCell").find((cell) => cell.getAttribute("id") === "edge");

    expect(vertex?.getAttribute("style")).toContain("fillColor=#253B53");
    expect(vertex?.getAttribute("style")).toContain("strokeColor=#7DD3FC");
    expect(vertex?.getAttribute("style")).toContain("fontColor=#F8FAFC");
    expect(edge?.getAttribute("style")).toContain("strokeColor=#5EEAD4");
    expect(decoded).toContain('background="#FFFF66"');
    expect(decoded).toContain('grid="1"');
    expect(decoded).toContain('customModelAttribute="keep-me"');
  });

  it("handles multiple uncompressed pages and keeps non-diagram XML untouched semantically", () => {
    const secondPage = sourceModel.replaceAll('id="plain"', 'id="plain-second"');
    const source = '<mxfile host="app.diagrams.net" custom="preserve"><diagram id="p1">' + sourceModel + '</diagram><diagram id="p2">' + secondPage + '</diagram></mxfile>';
    const themed = applyDrawioDiagramTheme(source, "sunset-boulevard");
    expect(findDrawioElements(parseDrawioXml(themed), "mxGraphModel").length).toBe(2);
    expect(cellById(themed, "plain")?.getAttribute("style")).toContain("fillColor=#FFFAF5");
    expect(cellById(themed, "plain-second")?.getAttribute("style")).toContain("fillColor=#FFFAF5");
  });

  it("leaves malformed XML and unchanged/unsupported input byte-for-byte intact", () => {
    const malformed = '<mxfile><diagram><mxGraphModel><root></mxfile>';
    const unsupported = '<mxlibrary><shapes/></mxlibrary>';
    expect(applyDrawioDiagramTheme(malformed, "ocean-depths")).toBe(malformed);
    expect(applyDrawioDiagramTheme(unsupported, "ocean-depths")).toBe(unsupported);
    expect(applyDrawioThemeBackground(malformed, "#101a2b")).toBe(malformed);
  });

  it("keeps explicit background editing separate from diagram palette selection", () => {
    const source = '<mxfile><diagram><mxGraphModel background="#ffffff"><root/></mxGraphModel></diagram></mxfile>';
    const result = applyDrawioThemeBackground(source, "#101a2b");
    expect(readDrawioModelBackground(result)).toBe("#101a2b");
    expect(applyDrawioThemeBackground(result, "#101a2b")).toBe(result);
    expect(applyDrawioThemeBackground(source, "var(--theme-canvas)")).toBe(source);
  });


  it("builds a single-page native style plan and detects the current preset", () => {
    const secondPage = sourceModel.replaceAll('id="plain"', 'id="plain-second"');
    const source = '<mxfile><diagram id="p1" name="One">' + sourceModel +
      '</diagram><diagram id="p2" name="Two">' + secondPage + '</diagram></mxfile>';
    const plan = calculateNativePalettePlan(source, "p2", "a".repeat(64), "sunset-boulevard");

    expect(plan.pageId).toBe("p2");
    expect(plan.expectedPageCellIds).toContain("plain-second");
    expect(plan.changes.map((change) => change.cellId)).toContain("plain-second");
    expect(plan.changes.map((change) => change.cellId)).not.toContain("plain");
    expect(plan.changes.find((change) => change.cellId === "plain-second")?.style).toContain("fillColor=#FFFAF5");
    expect(detectDrawioDiagramTheme(source, "p2")).toBe("");
    const themed = applyDrawioDiagramTheme(source, "sunset-boulevard");
    expect(detectDrawioDiagramTheme(themed, "p2")).toBe("sunset-boulevard");
    expect(detectDrawioDiagramTheme(themed, "p1")).toBe("sunset-boulevard");
  });


  it("uses the outer object ID when the native mxCell has no own id attribute", () => {
    const source = '<mxfile><diagram id="page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<object id="wrapped-vertex" label="Wrapped"><mxCell vertex="1" parent="1" style="rounded=1;fillColor=#FFFFFF;strokeColor=#111111;">' +
      '<mxGeometry x="1" y="2" width="80" height="40" as="geometry"/></mxCell></object></root></mxGraphModel></diagram></mxfile>';
    const plan = calculateNativePalettePlan(source, "page", "e".repeat(64), "golden-hour");
    expect(plan.expectedPageCellIds).toContain("wrapped-vertex");
    expect(plan.changes.some((change) => change.cellId === "wrapped-vertex" && change.kind === "vertex")).toBe(true);
  });

  it("creates plans for compressed pages and rejects stale/missing active pages", () => {
    const encoded = compressPage(sourceModel);
    const source = '<mxfile><diagram id="compressed">' + encoded + '</diagram></mxfile>';
    const plan = calculateNativePalettePlan(source, "compressed", "b".repeat(64), "midnight-galaxy");
    expect(plan.changes.some((change) => change.cellId === "colored" && change.style.includes("fillColor=#253B53"))).toBe(true);
    expect(() => calculateNativePalettePlan(source, "missing", "b".repeat(64), "midnight-galaxy")).toThrow("active Draw.io page");
    expect(() => calculateNativePalettePlan(source, "compressed", "not-a-revision", "midnight-galaxy")).toThrow("exact native Draw.io XML snapshot");
  });


  it("keeps the native palette plan equivalent to the established color rules", () => {
    const source = '<mxfile host="app.diagrams.net"><diagram id="p1" name="Main">' + sourceModel + '</diagram></mxfile>';
    const themes: DrawioDiagramTheme[] = ["ocean-depths", "sunset-boulevard", "forest-canopy", "modern-minimalist", "golden-hour", "arctic-frost", "desert-rose", "tech-innovation", "botanical-garden", "midnight-galaxy"];
    for (const theme of themes) {
      const expected = applyDrawioDiagramTheme(source, theme);
      const plan = calculateNativePalettePlan(source, "p1", "c".repeat(64), theme);
      const planned = parseDrawioXml(source);
      for (const change of plan.changes) {
        const cell = findDrawioElements(planned, "mxCell").find((candidate) => candidate.getAttribute("id") === change.cellId);
        expect(cell, "planned cell " + change.cellId).toBeTruthy();
        cell?.setAttribute("style", change.style);
      }
      expect(serializeDrawioXml(planned)).toBe(expected);
      expect(detectDrawioDiagramTheme(expected, "p1")).toBe(theme);
      const alreadyApplied = calculateNativePalettePlan(expected, "p1", "d".repeat(64), theme);
      expect(alreadyApplied.changes).toHaveLength(0);
    }
  });

  it("keeps original color categories distinct through repeated theme switches", () => {
    const source = '<mxfile><diagram id="colors" name="Colors"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="green" value="Green category" vertex="1" parent="1" style="fillColor=#D9EAD3;strokeColor=#6AA84F;fontColor=#000000;"/>' +
      '<mxCell id="blue" value="Blue category" vertex="1" parent="1" style="fillColor=#D9E8FB;strokeColor=#6C8EBF;fontColor=#000000;"/>' +
      '<mxCell id="orange" value="Orange category" vertex="1" parent="1" style="fillColor=#FCE2C4;strokeColor=#D79B00;fontColor=#000000;"/>' +
      '<mxCell id="yellow" value="Yellow category" vertex="1" parent="1" style="fillColor=#FFF0BF;strokeColor=#D6B656;fontColor=#000000;"/>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const themes: DrawioDiagramTheme[] = [
      "ocean-depths", "sunset-boulevard", "forest-canopy", "modern-minimalist",
      "golden-hour", "arctic-frost", "desert-rose", "tech-innovation",
      "botanical-garden", "midnight-galaxy"
    ];
    let themedXml = source;
    const expectedRoles = ["category-1", "category-2", "category-3", "category-4"];
    for (const theme of themes) {
      const plan = calculateNativePalettePlan(themedXml, "colors", "f".repeat(64), theme);
      const parsed = parseDrawioXml(themedXml);
      for (const change of plan.changes) {
        const cell = findDrawioElements(parsed, "mxCell").find((candidate) => candidate.getAttribute("id") === change.cellId);
        expect(cell, "planned cell " + change.cellId).toBeTruthy();
        cell?.setAttribute("style", change.style);
      }
      themedXml = serializeDrawioXml(parsed);
      const cells = ["green", "blue", "orange", "yellow"].map((id) => cellById(themedXml, id));
      const roles = cells.map((cell) => cell?.getAttribute("style")?.split(";")
        .find((part) => part.startsWith("studioColorRole="))?.split("=", 2)[1]);
      expect(roles).toEqual(expectedRoles);
      const fills = cells.map((cell) => cell?.getAttribute("style")?.split(";")
        .find((part) => part.startsWith("fillColor="))?.split("=", 2)[1]);
      expect(new Set(fills).size).toBe(4);
      expect(detectDrawioDiagramTheme(themedXml, "colors")).toBe(theme);
    }
  });

  it("keeps outline-only region geometry unfilled across theme switches", () => {
    const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="outline" value="Region" vertex="1" parent="1" style="shape=rect;fillColor=none;strokeColor=#123456;"/>' +
      '<mxCell id="filled" value="Service" vertex="1" parent="1" style="rounded=1;fillColor=#ABCDEF;strokeColor=#123456;"/>' +
      '</root></mxGraphModel>';
    const first = applyDrawioDiagramTheme(source, "ocean-depths");
    const outlineFirst = cellById(first, "outline")?.getAttribute("style") ?? "";
    expect(outlineFirst).toContain("fillColor=none");
    expect(outlineFirst).toContain("studioColorRole=category-1");
    expect(outlineFirst).toContain("strokeColor=#0369A1");

    const second = applyDrawioDiagramTheme(first, "sunset-boulevard");
    const outlineSecond = cellById(second, "outline")?.getAttribute("style") ?? "";
    expect(outlineSecond).toContain("fillColor=none");
    expect(outlineSecond).toContain("studioColorRole=category-1");
    expect(outlineSecond).toContain("strokeColor=#C2410C");
    expect(cellById(second, "filled")?.getAttribute("style")).toContain("studioColorRole=category-2");
  });

  it("fails closed instead of merging more than eight distinct source color categories", () => {
    const vertices = Array.from({ length: 9 }, (_, index) =>
      '<mxCell id="category-' + index + '" value="Category ' + index +
      '" vertex="1" parent="1" style="fillColor=#' + (0x100000 + index).toString(16).toUpperCase() +
      ';strokeColor=#000000;"/>'
    ).join("");
    const source = '<mxfile><diagram id="oversize"><mxGraphModel><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' + vertices +
      '</root></mxGraphModel></diagram></mxfile>';
    expect(() => calculateNativePalettePlan(source, "oversize", "a".repeat(64), "ocean-depths"))
      .toThrow(/more than 8 distinct original color categories/i);
    expect(() => applyDrawioDiagramTheme(source, "ocean-depths"))
      .toThrow(/more than 8 distinct original color categories/i);
    // String input is immutable: neither planner nor helper can partially write the source.
    expect(source).not.toContain("studioColorRole");
  });

  it("supports each documented diagram preset", () => {
    const themes: DrawioDiagramTheme[] = ["ocean-depths", "sunset-boulevard", "forest-canopy", "modern-minimalist", "golden-hour", "arctic-frost", "desert-rose", "tech-innovation", "botanical-garden", "midnight-galaxy"];
    for (const theme of themes) {
      expect(applyDrawioDiagramTheme(sourceModel, theme)).not.toBe(sourceModel);
    }
  });
});
