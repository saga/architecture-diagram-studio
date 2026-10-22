import { validateDrawioXmlDocument } from "./drawio-xml-schema";
export {
  DrawioXmlElementSchema, MxCellSchema, MxGeometrySchema, MxGraphModelSchema, MxLibrarySchema,
  MxLibraryEntrySchema, MxRootSchema, MxfileSchema, DrawioDiagramPageSchema, DrawioXmlRootSchema,
  DrawioDiagramXmlSchema, validateDrawioXmlDocument, validateDrawioXmlFile
} from "./drawio-xml-schema";

export interface DrawioXmlDiagnostics {
  pageCount: number;
  warnings: string[];
  issues: string[];
}

/** Validate native XML and report document-level issues without converting or normalizing it. */
export function getDrawioXmlDiagnostics(xml: string): DrawioXmlDiagnostics {
  const trimmed = xml.trimStart();
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<mxlibrary\b/i.test(trimmed)) {
    return {
      pageCount: 0, warnings: [],
      issues: ["This is a Draw.io custom shape library (<mxlibrary>), not a diagram file. Open a .drawio or diagram XML file instead."]
    };
  }
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<templates\b/i.test(trimmed)) {
    return {
      pageCount: 0, warnings: [],
      issues: ["This is a Draw.io template index (<templates>), not a diagram file. Open an individual .drawio template instead."]
    };
  }
  const validation = validateDrawioXmlDocument(xml);
  if (!validation.success) {
    return { pageCount: 0, warnings: [], issues: validation.issues.length ? validation.issues : ["This XML is not a supported Draw.io diagram."] };
  }
  const pageCount = validation.format === "mxfile"
    ? validation.root.children.filter((child) => child.name === "diagram").length
    : 1;
  return { pageCount, warnings: [...new Set(validation.warnings)], issues: [] };
}

export function isDrawioXmlDocument(xml: string): boolean {
  return validateDrawioXmlDocument(xml).success;
}
