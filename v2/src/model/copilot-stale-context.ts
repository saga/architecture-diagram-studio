import { summarizeNativeDiagramXmlDiff } from "./native-edit-confirmation";

export interface CopilotRequestDiagramState {
  drawioXml: string;
  selectedNativeCellId: string | null;
  selectedNativePageId: string | null;
}

export type CopilotStaleField = "document" | "page" | null;

export interface CopilotRequestContextComparison {
  stale: boolean;
  staleField: CopilotStaleField;
  xmlChanged: boolean;
  pageChanged: boolean;
  selectionChanged: boolean;
  semanticDocumentChanged: boolean;
  semanticDiffAvailable: boolean;
  semanticDiffSummary?: {
    pagesAdded: number;
    pagesRemoved: number;
    pagesRenamed: number;
    cellsAdded: number;
    cellsRemoved: number;
    cellsChanged: number;
    error?: string;
  };
}

/**
 * Selection is prompt context, not a document precondition. A user may select another cell
 * while the model is thinking; this alone must not cancel an edit that targets explicit IDs or
 * labels. Document XML is compared semantically so Draw.io viewport metadata such as dx/dy does
 * not invalidate a plan. An unavailable diff fails closed.
 */
export function compareCopilotRequestContext(
  source: CopilotRequestDiagramState,
  current: CopilotRequestDiagramState
): CopilotRequestContextComparison {
  const xmlChanged = source.drawioXml !== current.drawioXml;
  const diff = xmlChanged ? summarizeNativeDiagramXmlDiff(source.drawioXml, current.drawioXml) : null;
  const semanticDiffAvailable = diff ? diff.available : true;
  const semanticDocumentChanged = xmlChanged && (!diff || !diff.available || diff.changed !== false);
  const pageChanged = source.selectedNativePageId !== current.selectedNativePageId;
  const selectionChanged = source.selectedNativeCellId !== current.selectedNativeCellId;
  const staleField: CopilotStaleField = semanticDocumentChanged ? "document" : pageChanged ? "page" : null;

  return {
    stale: staleField !== null,
    staleField,
    xmlChanged,
    pageChanged,
    selectionChanged,
    semanticDocumentChanged,
    semanticDiffAvailable,
    ...(diff ? {
      semanticDiffSummary: diff.available ? {
        pagesAdded: diff.pagesAdded?.length ?? 0,
        pagesRemoved: diff.pagesRemoved?.length ?? 0,
        pagesRenamed: diff.pagesRenamed?.length ?? 0,
        cellsAdded: diff.cellsAdded?.length ?? 0,
        cellsRemoved: diff.cellsRemoved?.length ?? 0,
        cellsChanged: diff.cellsChanged?.length ?? 0
      } : {
        pagesAdded: 0,
        pagesRemoved: 0,
        pagesRenamed: 0,
        cellsAdded: 0,
        cellsRemoved: 0,
        cellsChanged: 0,
        error: diff.error?.slice(0, 500) || "Semantic XML comparison was unavailable."
      }
    } : {})
  };
}
