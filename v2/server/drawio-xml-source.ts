import type { DiagramDocument } from "../src/model/types";
import { toDrawioXml } from "../src/export/drawio";
import { canEditInStudio, patchDrawioXml } from "../src/model/drawio-xml-source";

/** XML persistence is format-level validation; semantic rules belong to explicit semantic operations. */
export function isDrawioXmlEnvelope(xml: string): boolean {
  const value = xml.trim();
  if (!value || /<!DOCTYPE/i.test(value)) return false;
  const root = value.match(/^(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(mxfile|mxGraphModel)\b/);
  if (!root) return false;
  if (root[1] === "mxfile") {
    return /<\/mxfile>\s*$/.test(value) && /<diagram\b/.test(value) && /<\/diagram>/.test(value);
  }
  return /<\/mxGraphModel>\s*$/.test(value) && /<root\b/.test(value) && /<\/root>/.test(value);
}

/** Reject a semantic operation unless the persisted XML is exactly represented by the projection. */
export function isStudioProjectionCurrent(xml: string, document: DiagramDocument): boolean {
  return canEditInStudio(xml, toDrawioXml(document), document);
}

/** Apply a semantic edit as a cell-identity patch to the current XML source. */
export function patchStudioDocumentXml(xml: string, previous: DiagramDocument, next: DiagramDocument): string | null {
  const currentProjection = toDrawioXml(previous);
  if (!canEditInStudio(xml, currentProjection, previous)) return null;
  return patchDrawioXml(xml, toDrawioXml(next), previous);
}
