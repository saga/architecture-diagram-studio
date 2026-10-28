import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseDrawioXml } from "../src/model/drawio-xml-dom";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";
import {
  validateWorkspaceDiagramChangeSet,
  type WorkspaceDiagramChangeSet,
  type WorkspaceDiagramTarget
} from "../src/model/workspace-diagram-change-set";

export interface WorkspaceDiagramFileResolver {
  workspaceId: string;
  resolveWorkspaceFile(relativePath: string): Promise<{ workspace: { id: string }; absolutePath: string }>;
}

export interface PreparedWorkspaceDiagramTarget extends WorkspaceDiagramTarget {
  title: string | null;
  contentRevision: string;
  xml: string;
}

export type PrepareWorkspaceDiagramChangeSetResult =
  | { ok: true; changeSet: WorkspaceDiagramChangeSet; targets: PreparedWorkspaceDiagramTarget[] }
  | { ok: false; error: string; targetPath?: string };

/**
 * Resolve and freeze the exact XML snapshots a multi-file plan was based on.
 * This is deliberately preparation-only: it never writes files and never uses
 * the live iframe's active file/page as a fallback.
 */
export async function prepareWorkspaceDiagramChangeSet(
  input: unknown,
  resolver: WorkspaceDiagramFileResolver
): Promise<PrepareWorkspaceDiagramChangeSetResult> {
  const validated = validateWorkspaceDiagramChangeSet(input);
  if (!validated.ok) return validated;
  const changeSet = validated.changeSet;
  if (changeSet.workspaceId !== resolver.workspaceId) {
    return { ok: false, error: "The change set belongs to a different workspace." };
  }

  const prepared: PreparedWorkspaceDiagramTarget[] = [];
  for (const target of changeSet.targets) {
    try {
      const resolved = await resolver.resolveWorkspaceFile(target.filePath);
      if (resolved.workspace.id !== changeSet.workspaceId) {
        return { ok: false, error: "Resolved file belongs to a different workspace.", targetPath: target.filePath };
      }
      const xml = await readFile(resolved.absolutePath, "utf8");
      const parsed = parseDrawioXml(xml);
      const validation = validateDrawioXmlDocument(xml);
      if (!validation.success) {
        return { ok: false, error: "Target is not valid Draw.io XML: " + validation.issues.slice(0, 3).join("; "), targetPath: target.filePath };
      }
      const rootName = parsed.documentElement.nodeName;
      let title: string | null = null;
      if (rootName === "mxfile") {
        const pages = Array.from(parsed.getElementsByTagName("diagram"));
        const page = target.pageId === null ? undefined : pages.find((item) => item.getAttribute("id") === target.pageId);
        if (!page) {
          return {
            ok: false,
            error: target.pageId === null
              ? "A multi-page mxfile target requires an explicit pageId."
              : "The requested pageId does not exist in the target file.",
            targetPath: target.filePath
          };
        }
        title = page.getAttribute("name");
      } else if (rootName === "mxGraphModel") {
        if (target.pageId !== null) {
          return { ok: false, error: "A bare mxGraphModel has no pageId; use null for its single page.", targetPath: target.filePath };
        }
      } else {
        return { ok: false, error: "Target XML root must be mxfile or mxGraphModel.", targetPath: target.filePath };
      }

      const contentRevision = createHash("sha256").update(xml, "utf8").digest("hex");
      if (contentRevision !== target.expectedRevision.toLowerCase()) {
        return { ok: false, error: "Target revision changed since planning; refresh the change set before applying.", targetPath: target.filePath };
      }
      prepared.push({ ...target, title, contentRevision, xml });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        targetPath: target.filePath
      };
    }
  }
  return { ok: true, changeSet, targets: prepared };
}
