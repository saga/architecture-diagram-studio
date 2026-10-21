import { isDiagramDocument, type DiagramDocument } from "../model/types";

/** Never hydrate state persisted for a different project workspace. */
export function selectCompatibleWorkspaceDocument(value: unknown, workspaceMismatch: boolean): DiagramDocument | null {
  if (workspaceMismatch || !isDiagramDocument(value)) return null;
  return value;
}
