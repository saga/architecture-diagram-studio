import { deflateSync, inflateSync, strFromU8, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { findDrawioElements, parseDrawioXml } from "./drawio-xml-dom";
import {
  applyDrawioDiagramTheme,
  applyDrawioThemeBackground,
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

const sourceModel = '<mxGraphModel background="light-dark(#FFFF66,#121212)" grid="1" gridSize="4" page="1" customModelAttribute="keep-me"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="plain" value="Plain" vertex="1" parent="1"/><mxCell id="colored" value="Colored" style="shape=rectangle;fillColor=#ffffff;strokeColor=#000000;fontColor=#000000;rounded=1;html=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell><mxCell id="text" value="Text only" style="text;html=1;align=center;fillColor=none;strokeColor=none;whiteSpace=wrap;" vertex="1" parent="1"/><mxCell id="edge" edge="1" parent="1" source="colored" target="plain" style="endArrow=block;strokeColor=#111111;fontColor=#222222;rounded=0;"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="40" y="50"/></Array></mxGeometry></mxCell></root></mxGraphModel>';

describe("native Draw.io diagram theme presets", () => {
  it("colors unstyled vertices, recolors externally styled cells, and preserves non-color styles", () => {
    const source = '<mxfile host="app.diagrams.net" data-owner="external"><diagram id="p1" name="Main">' + sourceModel + '</diagram></mxfile>';
    const themed = applyDrawioDiagramTheme(source, "youth");

    expect(themed).not.toBe(source);
    expect(themed).toContain('data-owner="external"');
    expect(readDrawioModelBackground(themed)).toBe("light-dark(#FFFF66,#121212)");

    const plain = cellById(themed, "plain");
    expect(plain?.getAttribute("style")).toContain("fillColor=#FCE7F3");
    expect(plain?.getAttribute("style")).toContain("strokeColor=#BE185D");
    expect(plain?.getAttribute("style")).toContain("fontColor=#831843");

    const colored = cellById(themed, "colored");
    expect(colored?.getAttribute("style")).toContain("fillColor=#FCE7F3");
    expect(colored?.getAttribute("style")).toContain("strokeColor=#BE185D");
    expect(colored?.getAttribute("style")).toContain("fontColor=#831843");
    expect(colored?.getAttribute("style")).toContain("rounded=1");
    expect(colored?.getAttribute("style")).toContain("html=1");
    expect(colored?.getAttribute("style")).not.toContain("fillColor=#ffffff");

    const text = cellById(themed, "text");
    expect(text?.getAttribute("style")).toContain("fontColor=#831843");
    expect(text?.getAttribute("style")).toContain("fillColor=none");
    expect(text?.getAttribute("style")).toContain("strokeColor=none");

    const edge = cellById(themed, "edge");
    expect(edge?.getAttribute("style")).toContain("strokeColor=#DB2777");
    expect(edge?.getAttribute("style")).toContain("fontColor=#9D174D");
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

    const themed = applyDrawioDiagramTheme(source, "midnight");
    expect(themed).not.toBe(source);
    const outer = parseDrawioXml(themed);
    const page = findDrawioElements(outer, "diagram")[0];
    expect(page).toBeTruthy();
    const decoded = decompressPage(page?.textContent ?? "");
    const model = parseDrawioXml(decoded);
    const vertex = findDrawioElements(model, "mxCell").find((cell) => cell.getAttribute("id") === "colored");
    const edge = findDrawioElements(model, "mxCell").find((cell) => cell.getAttribute("id") === "edge");

    expect(vertex?.getAttribute("style")).toContain("fillColor=#27364E");
    expect(vertex?.getAttribute("style")).toContain("strokeColor=#93C5FD");
    expect(vertex?.getAttribute("style")).toContain("fontColor=#F8FAFC");
    expect(edge?.getAttribute("style")).toContain("strokeColor=#64748B");
    expect(decoded).toContain('background="#FFFF66"');
    expect(decoded).toContain('grid="1"');
    expect(decoded).toContain('customModelAttribute="keep-me"');
  });

  it("handles multiple uncompressed pages and keeps non-diagram XML untouched semantically", () => {
    const secondPage = sourceModel.replaceAll('id="plain"', 'id="plain-second"');
    const source = '<mxfile host="app.diagrams.net" custom="preserve"><diagram id="p1">' + sourceModel + '</diagram><diagram id="p2">' + secondPage + '</diagram></mxfile>';
    const themed = applyDrawioDiagramTheme(source, "warm");
    expect(findDrawioElements(parseDrawioXml(themed), "mxGraphModel").length).toBe(2);
    expect(cellById(themed, "plain")?.getAttribute("style")).toContain("fillColor=#FFF1E6");
    expect(cellById(themed, "plain-second")?.getAttribute("style")).toContain("fillColor=#FFF1E6");
  });

  it("leaves malformed XML and unchanged/unsupported input byte-for-byte intact", () => {
    const malformed = '<mxfile><diagram><mxGraphModel><root></mxfile>';
    const unsupported = '<mxlibrary><shapes/></mxlibrary>';
    expect(applyDrawioDiagramTheme(malformed, "youth")).toBe(malformed);
    expect(applyDrawioDiagramTheme(unsupported, "youth")).toBe(unsupported);
    expect(applyDrawioThemeBackground(malformed, "#101a2b")).toBe(malformed);
  });

  it("keeps explicit background editing separate from diagram palette selection", () => {
    const source = '<mxfile><diagram><mxGraphModel background="#ffffff"><root/></mxGraphModel></diagram></mxfile>';
    const result = applyDrawioThemeBackground(source, "#101a2b");
    expect(readDrawioModelBackground(result)).toBe("#101a2b");
    expect(applyDrawioThemeBackground(result, "#101a2b")).toBe(result);
    expect(applyDrawioThemeBackground(source, "var(--theme-canvas)")).toBe(source);
  });

  it("supports each documented diagram preset", () => {
    const themes: DrawioDiagramTheme[] = ["editorial", "youth", "warm", "midnight"];
    for (const theme of themes) {
      expect(applyDrawioDiagramTheme(sourceModel, theme)).not.toBe(sourceModel);
    }
  });
});
