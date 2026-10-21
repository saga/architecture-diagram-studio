import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DiagramDocument, DiagramRenderTheme } from "../src/model/types";
import { normalizeRenderTheme } from "../src/design/render-spec";

export function normalizeNewDrawioFileName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 180 || trimmed === "." || trimmed === ".." ||
      trimmed.includes(String.fromCharCode(0)) || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("Enter a file name only, with no directory path.");
  }
  if (trimmed.toLowerCase() === ".drawio") throw new Error("Enter a name before the .drawio extension.");
  const fileName = path.extname(trimmed) ? trimmed : trimmed + ".drawio";
  if (path.extname(fileName).toLowerCase() !== ".drawio") {
    throw new Error("New Draw.io files must use the .drawio extension.");
  }
  if (!path.basename(fileName, path.extname(fileName)).trim()) {
    throw new Error("Enter a name before the .drawio extension.");
  }
  return fileName;
}

/** Create a valid empty architecture document; the workspace remains the containing folder. */
export function createEmptyDrawioDocument(fileName: string, theme?: DiagramRenderTheme | string): DiagramDocument {
  const title = path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ").trim() || "Untitled diagram";
  return {
    schemaVersion: 2, id: randomUUID(), title, kind: "c4", variant: "container", theme: "studio-editorial",
    renderTheme: normalizeRenderTheme(theme),
    nodes: [], relations: [], boundaries: [],
    layout: {
      profile: "elk-layered", direction: "RIGHT", routing: "orthogonal",
      nodeSpacing: 52, layerSpacing: 104, boundaryPadding: 32, externalSide: "RIGHT", storageSide: "BOTTOM"
    }
  };
}
