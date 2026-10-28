import { z } from "zod";

/**
 * Workspace-scoped identity for a diagram mutation. Never derive filePath or pageId
 * from whichever document happens to be open in the browser when the plan is applied.
 */
export const WorkspaceDiagramTargetSchema = z.object({
  workspaceId: z.string().trim().min(1),
  /** Canonical, workspace-relative POSIX path; absolute paths and traversal are invalid. */
  filePath: z.string().trim().min(1).refine(
    (value) => !value.startsWith("/") &&
      !/^[a-zA-Z]:[\\/]/.test(value) &&
      !value.split(/[\\/]+/).some((part) => part === "..") &&
      !value.includes("\0"),
    "filePath must be a workspace-relative path without traversal"
  ),
  /** Null is valid only for a bare mxGraphModel document. */
  pageId: z.string().trim().min(1).nullable(),
  /** SHA-256 revision of the exact XML snapshot used to prepare the change. */
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i)
}).strict();

export type WorkspaceDiagramTarget = z.infer<typeof WorkspaceDiagramTargetSchema>;

export const WorkspaceDiagramChangeSetSchema = z.object({
  id: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
  summary: z.string().trim().min(1).max(2000),
  targets: z.array(WorkspaceDiagramTargetSchema).min(1).max(50)
    .superRefine((targets, context) => {
      const seen = new Set<string>();
      for (const [index, target] of targets.entries()) {
        const key = JSON.stringify([target.workspaceId, target.filePath, target.pageId]);
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "Duplicate file/page target; merge its operations before creating a change set"
          });
        }
        seen.add(key);
      }
    })
}).strict().superRefine((changeSet, context) => {
  for (const [index, target] of changeSet.targets.entries()) {
    if (target.workspaceId !== changeSet.workspaceId) {
      context.addIssue({
        code: "custom",
        path: ["targets", index, "workspaceId"],
        message: "Every target must belong to the change set workspace"
      });
    }
  }
});

export type WorkspaceDiagramChangeSet = z.infer<typeof WorkspaceDiagramChangeSetSchema>;

/**
 * Validate the identity envelope before any file read/write. Filesystem containment,
 * symlink checks, XML/page validation, and revision comparison must still be performed
 * by the server-side workspace service; this schema deliberately does not pretend to
 * perform those I/O-dependent checks.
 */
export function validateWorkspaceDiagramChangeSet(input: unknown):
  | { ok: true; changeSet: WorkspaceDiagramChangeSet }
  | { ok: false; error: string } {
  const parsed = WorkspaceDiagramChangeSetSchema.safeParse(input);
  if (parsed.success) return { ok: true, changeSet: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues.map((issue) =>
      (issue.path.length ? issue.path.join(".") + ": " : "") + issue.message
    ).join("; ")
  };
}
