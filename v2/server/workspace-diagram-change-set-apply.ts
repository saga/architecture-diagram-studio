import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseDrawioXml } from "../src/model/drawio-xml-dom";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";
import { runCompensatingTransaction, writeTextAtomic } from "./storage";
import type { WorkspaceDiagramFileResolver } from "./workspace-diagram-change-set";

const ApplyTargetSchema = z.object({
  filePath: z.string().trim().min(1),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i),
  /** Complete replacement XML for this file, preserving all pages and file metadata. */
  resultXml: z.string().min(1).max(20 * 1024 * 1024),
  /** Page IDs this proposal intends to change. Every ID must exist before and after. */
  changedPageIds: z.array(z.string().trim().min(1)).min(1).max(100)
}).strict();

const ApplyRequestSchema = z.object({
  changeSetId: z.string().trim().min(1).max(200).default(() => randomUUID()),
  workspaceId: z.string().trim().min(1),
  targets: z.array(ApplyTargetSchema).min(1).max(25)
}).strict().superRefine((request, context) => {
  const paths = new Set<string>();
  request.targets.forEach((target, index) => {
    if (paths.has(target.filePath)) {
      context.addIssue({ code: "custom", path: ["targets", index, "filePath"], message: "Each file must appear once; merge page edits into one resultXml per file." });
    }
    paths.add(target.filePath);
  });
});

export interface WorkspaceDiagramApplyResolver extends WorkspaceDiagramFileResolver {
  writeLog?: (event: string, fields: Record<string, unknown>) => Promise<void>;
}

export type ApplyWorkspaceDiagramChangeSetResult =
  | { ok: true; changeSetId: string; applied: Array<{ filePath: string; beforeRevision: string; afterRevision: string; changedPageIds: string[] }> }
  | { ok: false; error: string; failedPath?: string; rolledBack?: boolean };

const fileQueues = new Map<string, Promise<void>>();

async function withFileLocks<T>(paths: string[], work: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths)].sort();
  const previous = keys.map((key) => fileQueues.get(key) ?? Promise.resolve());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  for (let index = 0; index < keys.length; index++) {
    const prior = previous[index];
    const queued = prior.catch(() => undefined).then(() => gate);
    fileQueues.set(keys[index], queued);
  }
  await Promise.all(previous.map((item) => item.catch(() => undefined)));
  try { return await work(); }
  finally {
    release();
    for (const key of keys) {
      const current = fileQueues.get(key);
      if (current) void current.then(() => { if (fileQueues.get(key) === current) fileQueues.delete(key); });
    }
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function pageIds(xml: string): Set<string> | null {
  const document = parseDrawioXml(xml);
  if (document.documentElement.nodeName === "mxGraphModel") return new Set(["__bare_graph_model__"]);
  if (document.documentElement.nodeName !== "mxfile") throw new Error("Draw.io XML root must be mxfile or mxGraphModel.");
  return new Set(Array.from(document.getElementsByTagName("diagram")).map((page) => page.getAttribute("id") ?? "").filter(Boolean));
}

/**
 * Apply complete, precomputed XML outputs as one guarded change set. All targets are
 * resolved, revision-checked and validated before the first write. Cross-file atomicity
 * is not claimed; completed writes are compensated in reverse order on failure.
 */
export async function applyWorkspaceDiagramChangeSet(
  input: unknown,
  resolver: WorkspaceDiagramApplyResolver
): Promise<ApplyWorkspaceDiagramChangeSetResult> {
  const parsed = ApplyRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join("; ") };
  const request = parsed.data;
  if (request.workspaceId !== resolver.workspaceId) return { ok: false, error: "The change set belongs to a different workspace." };

  return withFileLocks(request.targets.map((target) => request.workspaceId + "\0" + target.filePath), async () => {
    const prepared: Array<{
      filePath: string; absolutePath: string; beforeXml: string; resultXml: string;
      beforeRevision: string; afterRevision: string; changedPageIds: string[];
    }> = [];
    for (const target of request.targets) {
      try {
        const resolved = await resolver.resolveWorkspaceFile(target.filePath);
        if (resolved.workspace.id !== request.workspaceId) return { ok: false, error: "Resolved file belongs to a different workspace.", failedPath: target.filePath };
        const beforeXml = await readFile(resolved.absolutePath, "utf8");
        const beforeRevision = sha256(beforeXml);
        if (beforeRevision !== target.expectedRevision.toLowerCase()) {
          return { ok: false, error: "Target revision changed; no files were written.", failedPath: target.filePath };
        }
        const beforePages = pageIds(beforeXml);
        const afterPages = pageIds(target.resultXml);
        const validation = validateDrawioXmlDocument(target.resultXml);
        if (!validation.success) {
          return { ok: false, error: "Proposed XML is invalid: " + validation.issues.slice(0, 3).join("; "), failedPath: target.filePath };
        }
        if (beforePages === null || afterPages === null) return { ok: false, error: "Unsupported Draw.io XML root.", failedPath: target.filePath };
        const ids = target.changedPageIds;
        if (new Set(ids).size !== ids.length) return { ok: false, error: "Duplicate changed page IDs are not allowed.", failedPath: target.filePath };
        for (const id of ids) {
          const normalizedId = beforePages.has("__bare_graph_model__") && id === "__bare_graph_model__" ? id : id;
          if (!beforePages.has(normalizedId) || !afterPages.has(normalizedId)) {
            return { ok: false, error: "Every changed page must exist in both the original and proposed XML.", failedPath: target.filePath };
          }
        }
        if (beforePages.has("__bare_graph_model__") !== afterPages.has("__bare_graph_model__")) {
          return { ok: false, error: "A change cannot convert mxfile to mxGraphModel or vice versa.", failedPath: target.filePath };
        }
        prepared.push({
          filePath: target.filePath, absolutePath: resolved.absolutePath, beforeXml, resultXml: target.resultXml,
          beforeRevision, afterRevision: sha256(target.resultXml), changedPageIds: ids
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), failedPath: target.filePath };
      }
    }

    try {
      await runCompensatingTransaction(prepared.map((target) => ({
        name: target.filePath,
        apply: async () => {
          // Recheck immediately before each write to catch changes that bypassed this process's queue.
          const latest = await readFile(target.absolutePath, "utf8");
          if (sha256(latest) !== target.beforeRevision) throw new Error("Target changed during apply: " + target.filePath);
          await writeTextAtomic(target.absolutePath, target.resultXml);
        },
        rollback: async () => {
          const latest = await readFile(target.absolutePath, "utf8");
          if (sha256(latest) === target.afterRevision) await writeTextAtomic(target.absolutePath, target.beforeXml);
          else throw new Error("Refusing to overwrite an externally changed file during rollback: " + target.filePath);
        }
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await resolver.writeLog?.("workspace.diagram-change-set.failed", {
        workspaceId: request.workspaceId, changeSetId: request.changeSetId,
        targets: prepared.map((target) => ({ filePath: target.filePath, beforeRevision: target.beforeRevision })),
        error: message
      });
      return { ok: false, error: message, rolledBack: !message.includes("compensation was incomplete") };
    }

    await resolver.writeLog?.("workspace.diagram-change-set.applied", {
      workspaceId: request.workspaceId, changeSetId: request.changeSetId,
      targets: prepared.map(({ filePath, beforeRevision, afterRevision, changedPageIds }) => ({ filePath, beforeRevision, afterRevision, changedPageIds }))
    });
    return {
      ok: true, changeSetId: request.changeSetId,
      applied: prepared.map(({ filePath, beforeRevision, afterRevision, changedPageIds }) => ({ filePath, beforeRevision, afterRevision, changedPageIds }))
    };
  });
}
