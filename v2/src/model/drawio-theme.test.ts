import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { findDrawioElements, parseDrawioXml, serializeDrawioXml } from "./drawio-xml-dom";
import {
  applyDrawioDiagramTheme,
  DRAWIO_DIAGRAM_THEMES,
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

function compressStencil(xml: string): string {
  const compressed = deflateSync(strToU8(encodeURIComponent(xml)));
  let binary = "";
  for (const byte of compressed) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decompressStencil(encoded: string): string {
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
    expect(readDrawioModelBackground(themed)).toBe("#C5DDE7");

    const plain = cellById(themed, "plain");
    expect(plain?.getAttribute("style")).toContain("fillColor=#D9EDF6");
    expect(plain?.getAttribute("style")).toContain("strokeColor=#1F617A");
    expect(plain?.getAttribute("style")).toContain("fontColor=#153548");

    const colored = cellById(themed, "colored");
    expect(colored?.getAttribute("style")).toContain("fillColor=#B7DDEB");
    expect(colored?.getAttribute("style")).toContain("strokeColor=#176B85");
    expect(colored?.getAttribute("style")).toContain("fontColor=#153548");
    expect(colored?.getAttribute("style")).toContain("rounded=1");
    expect(colored?.getAttribute("style")).toContain("html=1");
    expect(colored?.getAttribute("style")).not.toContain("fillColor=#ffffff");

    const text = cellById(themed, "text");
    expect(text?.getAttribute("style")).toContain("fontColor=#153548");
    expect(text?.getAttribute("style")).toContain("fillColor=none");
    expect(text?.getAttribute("style")).toContain("strokeColor=none");
    expect(text?.getAttribute("style")).not.toContain("fillColor=#ffffff");
    expect(text?.getAttribute("style")).not.toContain("strokeColor=#000000");

    const edge = cellById(themed, "edge");
    expect(edge?.getAttribute("style")).toContain("strokeColor=#146D59");
    expect(edge?.getAttribute("style")).toContain("fontColor=#153548");
    expect(edge?.getAttribute("style")).toContain("endArrow=block");
    expect(edge?.getAttribute("style")).toContain("rounded=0");
    expect(themed).toContain('x="40" y="50"');
    expect(themed).toContain('grid="1"');
    expect(themed).toContain('gridSize="4"');
  });

  it("applies a preset to compressed pages and changes the canvas while preserving grid settings", () => {
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

    expect(vertex?.getAttribute("style")).toContain("fillColor=#27375A");
    expect(vertex?.getAttribute("style")).toContain("strokeColor=#6AC7FF");
    expect(vertex?.getAttribute("style")).toContain("fontColor=#F5F7FF");
    expect(edge?.getAttribute("style")).toContain("strokeColor=#67E8C7");
    expect(decoded).toContain('background="#10172A"');
    expect(decoded).toContain('grid="1"');
    expect(decoded).toContain('customModelAttribute="keep-me"');
  });

  it("handles multiple uncompressed pages and keeps non-diagram XML untouched semantically", () => {
    const secondPage = sourceModel.replaceAll('id="plain"', 'id="plain-second"');
    const source = '<mxfile host="app.diagrams.net" custom="preserve"><diagram id="p1">' + sourceModel + '</diagram><diagram id="p2">' + secondPage + '</diagram></mxfile>';
    const themed = applyDrawioDiagramTheme(source, "sunset-boulevard");
    expect(findDrawioElements(parseDrawioXml(themed), "mxGraphModel").length).toBe(2);
    expect(cellById(themed, "plain")?.getAttribute("style")).toContain("fillColor=#FFE0CF");
    expect(cellById(themed, "plain-second")?.getAttribute("style")).toContain("fillColor=#FFE0CF");
    expect(readDrawioModelBackground(themed, "p1")).toBe("#F3C9B3");
    expect(readDrawioModelBackground(themed, "p2")).toBe("#F3C9B3");
  });

  it("leaves malformed XML and unchanged/unsupported input byte-for-byte intact", () => {
    const malformed = '<mxfile><diagram><mxGraphModel><root></mxfile>';
    const unsupported = '<mxlibrary><shapes/></mxlibrary>';
    expect(applyDrawioDiagramTheme(malformed, "ocean-depths")).toBe(malformed);
    expect(applyDrawioDiagramTheme(unsupported, "ocean-depths")).toBe(unsupported);
    expect(applyDrawioThemeBackground(malformed, "#101a2b")).toBe(malformed);
  });

  it("keeps the explicit background editing helper available independently of diagram presets", () => {
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
    expect(plan.expectedBackground).toBe("light-dark(#FFFF66,#121212)");
    expect(plan.background).toBe("#F3C9B3");
    expect(plan.expectedPageCellIds).toContain("plain-second");
    expect(plan.changes.map((change) => change.cellId)).toContain("plain-second");
    expect(plan.changes.map((change) => change.cellId)).not.toContain("plain");
    expect(plan.changes.find((change) => change.cellId === "plain-second")?.style).toContain("fillColor=#FFE0CF");
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
    expect(plan.changes.some((change) => change.cellId === "colored" && change.style.includes("fillColor=#27375A"))).toBe(true);
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
      findDrawioElements(planned, "mxGraphModel")[0]?.setAttribute("background", plan.background);
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
      findDrawioElements(parsed, "mxGraphModel")[0]?.setAttribute("background", plan.background);
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
    expect(outlineFirst).toContain("strokeColor=#176B85");

    const second = applyDrawioDiagramTheme(first, "sunset-boulevard");
    const outlineSecond = cellById(second, "outline")?.getAttribute("style") ?? "";
    expect(outlineSecond).toContain("fillColor=none");
    expect(outlineSecond).toContain("studioColorRole=category-1");
    expect(outlineSecond).toContain("strokeColor=#B33F1D");
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


describe("native theme page backgrounds", () => {
  it("plans the active page background and leaves other pages unchanged", () => {
    const source = '<mxfile><diagram id="one"><mxGraphModel background="#FFFFFF" grid="1" gridSize="10"><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="a" value="A" vertex="1" parent="1" style="fillColor=#FFFFFF;strokeColor=#000000;"/>' +
      '</root></mxGraphModel></diagram><diagram id="two"><mxGraphModel background="#F0F0F0" grid="1"><root>' +
      '<mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="b" value="B" vertex="1" parent="1"/>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const plan = calculateNativePalettePlan(source, "one", "a".repeat(64), "tech-innovation");
    expect(plan.expectedBackground).toBe("#FFFFFF");
    expect(plan.background).toBe("#C0CDF2");
    const parsed = parseDrawioXml(source);
    const targetPage = findDrawioElements(parsed, "diagram").find((page) => page.getAttribute("id") === "one");
    const targetModel = targetPage ? findDrawioElements(targetPage as never, "mxGraphModel")[0] : undefined;
    targetModel?.setAttribute("background", plan.background);
    for (const change of plan.changes) {
      const cell = findDrawioElements(parsed, "mxCell").find((candidate) => candidate.getAttribute("id") === change.cellId);
      cell?.setAttribute("style", change.style);
    }
    const after = serializeDrawioXml(parsed);
    expect(detectDrawioDiagramTheme(after, "one")).toBe("tech-innovation");
    expect(readDrawioModelBackground(after, "one")).toBe("#C0CDF2");
    expect(readDrawioModelBackground(after, "two")).toBe("#F0F0F0");
    expect(after).toContain('gridSize="10"');
  });
});

describe("native theme page identity", () => {
  it("requires an explicit page ID when multiple pages exist and rejects an empty ID", () => {
    const multipage = '<mxfile><diagram id="p1">' + sourceModel +
      '</diagram><diagram id="p2">' + sourceModel + '</diagram></mxfile>';
    expect(() => calculateNativePalettePlan(multipage, null, "a".repeat(64), "ocean-depths"))
      .toThrow(/multiple pages.*active page ID/i);
    expect(calculateNativePalettePlan(multipage, "p2", "a".repeat(64), "ocean-depths").pageId).toBe("p2");
    expect(() => calculateNativePalettePlan(multipage, "", "a".repeat(64), "ocean-depths"))
      .toThrow(/active Draw\.io page no longer exists/i);
  });
});


describe("theme color coverage and contrast", () => {
  it("recolors existing native gradient, label, swimlane and indicator colors without adding absent properties", () => {
    const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="themed" value="Zone" vertex="1" parent="1" style="shape=rect;fillColor=#808080;strokeColor=#333333;fontColor=#111111;gradientColor=#AAAAAA;labelBackgroundColor=#FFFFFF;labelBorderColor=#222222;swimlaneFillColor=#CCCCCC;indicatorColor=#444444;indicatorGradientColor=#BBBBBB;separatorColor=#555555;"/>' +
      '<mxCell id="plain" value="Plain" vertex="1" parent="1" style="fillColor=none;strokeColor=#808080;labelBackgroundColor=none;"/>' +
    '</root></mxGraphModel>';
    const themed = applyDrawioDiagramTheme(source, "forest-canopy");
    const zone = cellById(themed, "themed")?.getAttribute("style") ?? "";
    const plain = cellById(themed, "plain")?.getAttribute("style") ?? "";
    expect(zone).toContain("fillColor=#B4D7A8");
    expect(zone).toContain("gradientColor=#B4D7A8");
    expect(zone).toContain("labelBackgroundColor=#D5E7C8");
    expect(zone).toContain("labelBorderColor=#285C38");
    expect(zone).toContain("swimlaneFillColor=#B4D7A8");
    expect(zone).toContain("indicatorColor=#285C38");
    expect(zone).toContain("indicatorGradientColor=#B4D7A8");
    expect(zone).toContain("separatorColor=#285C38");
    expect(plain).toContain("fillColor=none");
    expect(plain).toContain("labelBackgroundColor=none");
    expect(plain).toContain("strokeColor=#285C38");
    expect(plain).not.toContain("gradientColor=");
    expect(plain).not.toContain("swimlaneFillColor=");
  });

  it("gives each curated theme a distinct visual signature and keeps category fills distinct", () => {
    const entries = Object.entries(DRAWIO_DIAGRAM_THEMES);
    const signatures = entries.map(([, palette]) => [
      palette.background, palette.baseFill, palette.baseStroke, palette.ink, palette.edgeStroke,
      ...palette.categories.map((color) => color.fill),
      ...palette.categories.map((color) => color.stroke)
    ].join("|"));
    expect(new Set(signatures).size).toBe(entries.length);
    for (const [name, palette] of entries) {
      expect(new Set(palette.categories.map((color) => color.fill)).size, name + " should have eight distinct fills").toBe(8);
      expect(new Set(palette.categories.map((color) => color.stroke)).size, name + " should have eight distinct strokes").toBe(8);
      expect(/^#[0-9A-F]{6}$/.test(palette.background), name + " should have a fixed canvas color").toBe(true);
      expect(palette.background).not.toBe(palette.baseFill);
    }
    expect(new Set(entries.map(([, palette]) => palette.background)).size).toBe(10);
    expect(DRAWIO_DIAGRAM_THEMES["forest-canopy"].baseFill).not.toBe(DRAWIO_DIAGRAM_THEMES["modern-minimalist"].baseFill);
    expect(DRAWIO_DIAGRAM_THEMES["forest-canopy"].edgeStroke).not.toBe(DRAWIO_DIAGRAM_THEMES["modern-minimalist"].edgeStroke);
  });
});


describe("neutral native stencil theme coverage", () => {
  function stencilXml(fillColor: string, extraColor = ""): string {
    return '<shape w="400" h="300" aspect="variable" strokewidth="inherit"><foreground>' +
      '<strokecolor color="#ffffff"/><fillcolor color="' + fillColor + '"/>' +
      extraColor + '<path><move x="0" y="0"/><line x="400" y="0"/><line x="400" y="300"/><close/></path>' +
      '</foreground></shape>';
  }
  function stencilCellXml(id: string, stencil: string, geometry = 'x="0" y="0" width="400" height="300"'): string {
    return '<mxCell id="' + id + '" value="" vertex="1" parent="1" style="shape=stencil(' + compressStencil(stencil) + ');">' +
      '<mxGeometry ' + geometry + ' as="geometry"/></mxCell>';
  }
  function stencilFill(xml: string): string {
    return xml.match(/<fillcolor\b[^>]*\bcolor="([^"]+)"/i)?.[1] ?? "";
  }

  it("themes large neutral stencil backplates and preserves stencil geometry", () => {
    const sourceStencil = stencilXml("#e6e7e8");
    const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      stencilCellXml("region", sourceStencil) + '</root></mxGraphModel>';
    const forest = parseDrawioXml(applyDrawioDiagramTheme(source, "forest-canopy"));
    const forestCell = findDrawioElements(forest, "mxCell").find((cell) => cell.getAttribute("id") === "region");
    const forestStyle = forestCell?.getAttribute("style") ?? "";
    const forestPayload = forestStyle.match(/shape=stencil\(([^)]+)\)/)?.[1];
    expect(forestPayload).toBeTruthy();
    const forestXml = decompressStencil(forestPayload!);
    expect(stencilFill(forestXml)).toBe("#D5E7C8");
    expect(forestXml.replace(/(<fillcolor\b[^>]*\bcolor=")[^"]+(")/gi, "$1__FILL__$2"))
      .toBe(sourceStencil.replace(/(<fillcolor\b[^>]*\bcolor=")[^"]+(")/gi, "$1__FILL__$2"));
    expect(forestStyle).toContain("studioColorRole=base");

    const midnight = parseDrawioXml(applyDrawioDiagramTheme(serializeDrawioXml(forest), "midnight-galaxy"));
    const midnightCell = findDrawioElements(midnight, "mxCell").find((cell) => cell.getAttribute("id") === "region");
    const midnightPayload = midnightCell?.getAttribute("style")?.match(/shape=stencil\(([^)]+)\)/)?.[1];
    expect(midnightPayload).toBeTruthy();
    expect(stencilFill(decompressStencil(midnightPayload!))).toBe("#1D2540");
  });

  it("does not recolor brand stencil assets and still detects the theme of surrounding native cells", () => {
    const sourceStencil = stencilXml("#e6e7e8", '<strokecolor color="#4286c5"/>');
    const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="normal" value="Service" vertex="1" parent="1" style="fillColor=#808080;strokeColor=#333333;"/>' +
      stencilCellXml("brand", sourceStencil) + '</root></mxGraphModel>';
    const themed = parseDrawioXml(applyDrawioDiagramTheme(source, "ocean-depths"));
    const brand = findDrawioElements(themed, "mxCell").find((item) => item.getAttribute("id") === "brand");
    const normal = findDrawioElements(themed, "mxCell").find((item) => item.getAttribute("id") === "normal");
    expect(brand?.getAttribute("style")).toBe("shape=stencil(" + compressStencil(sourceStencil) + ");");
    expect(normal?.getAttribute("style")).toContain("fillColor=#B7DDEB");
    expect(detectDrawioDiagramTheme(serializeDrawioXml(themed), null)).toBe("ocean-depths");
  });

  it("does not modify small neutral stencils or their outer styles", () => {
    const sourceStencil = stencilXml("#e6e7e8");
    const source = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      stencilCellXml("small", sourceStencil, 'x="0" y="0" width="100" height="100"') + '</root></mxGraphModel>';
    const themed = parseDrawioXml(applyDrawioDiagramTheme(source, "ocean-depths"));
    const cell = findDrawioElements(themed, "mxCell").find((item) => item.getAttribute("id") === "small");
    expect(cell?.getAttribute("style")).toBe("shape=stencil(" + compressStencil(sourceStencil) + ");");
  });
});
