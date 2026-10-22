import type { DiagramDocument } from "../src/model/types";
import { toDrawioXml } from "../src/export/drawio";
import { canApplySemanticEdits, patchDrawioXml } from "../src/model/drawio-xml-source";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";

/** Persistence uses the same Zod schema as browser import; semantic completeness is a separate gate. */
export function isDrawioXmlEnvelope(xml: string): boolean {
  return validateDrawioXmlDocument(xml).success;
}

/** Reject a semantic operation unless the persisted XML is exactly represented by the projection. */
export function isStudioProjectionCurrent(xml: string, document: DiagramDocument): boolean {
  return canApplySemanticEdits(xml, toDrawioXml(document), document);
}

/** Apply a semantic edit as a cell-identity patch to the current XML source. */
export function patchStudioDocumentXml(xml: string, previous: DiagramDocument, next: DiagramDocument): string | null {
  const currentProjection = toDrawioXml(previous);
  // Do not require a complete semantic inventory for append-only operations. The patcher
  // retains every source cell whose semantic projection did not change and adds only new
  // cell XML. Callers must separately restrict partial-projection edits to this safe scope.
  return patchDrawioXml(xml, toDrawioXml(next), previous, currentProjection);
}
