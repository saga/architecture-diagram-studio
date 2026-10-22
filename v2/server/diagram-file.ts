import path from "node:path";

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

function xmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Create an empty native Draw.io file directly; no intermediate semantic graph is involved. */
export function createEmptyDrawioXml(fileName: string): string {
  const title = path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ").trim() || "Untitled diagram";
  return '<mxfile host="app.diagrams.net" agent="Architecture Diagram Studio V2">' +
    '<diagram id="page-1" name="' + xmlAttribute(title) + '">' +
    '<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1200" pageHeight="800" math="0" shadow="0">' +
    '<root><mxCell id="0"/><mxCell id="1" parent="0"/></root>' +
    '</mxGraphModel></diagram></mxfile>';
}
