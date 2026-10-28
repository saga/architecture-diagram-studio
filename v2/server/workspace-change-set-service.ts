import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { writeTextAtomic, workspaceRevision, runCompensatingTransaction } from "./storage";
import type { ProjectWorkspace } from "./workspace-files";
import { validateDrawioXmlDocument } from "../src/model/drawio-xml-schema";
import { parseDrawioXml } from "../src/model/drawio-xml-dom";
import {
  WorkspaceDiagramChangeSetSchema,
  type WorkspaceDiagramChangeSet,
  type WorkspaceDiagramTarget
} from "../src/model/workspace-diagram-change-set";

export interface WorkspaceChangeSetFileAccess {
  getWorkspace(): Promise<ProjectWorkspace | null>;
  resolveWorkspaceFile(relativePath: string): Promise<{ workspace: ProjectWorkspace; absolutePath: string }>;
}

export interface PreparedWorkspaceDiagram {
  target: WorkspaceDiagramTarget;
  absolutePath: string;
  beforeXml: string;
  afterXml: string;
  beforeRevision: string;
  afterRevision: string;
}

export interface WorkspaceChangeSetJournal {
  id: string;
  workspaceId: string;
  status: "prepared" | "applied" | "rolled_back" | "recovery_required";
  createdAt: string;
  completedAt?: string;
  files: Array<{
    filePath: string;
    pageIds: string[];
    beforeRevision: string;
    afterRevision: string;
    status: "pending" | "applied" | "rolled_back" | "recovery_required";
    error?: string;
  }>;
}

function validateXml(xml: string, filePath: string): void {
  const validation = validateDrawioXmlDocument(xml);
  if (!validation.valid) {
    throw new Error("Invalid Draw.io XML for " + filePath + ": " + validation.errors.join("; "));
  }
}

function pageIds(xml: string): Set<string> | null {
  const document = parseDrawioXml(xml);
  if (document.documentElement.nodeName === "mxGraphModel") return null;
  if (document.documentElement.nodeName !== "mxfile") {
    throw new Error("Target is not a Draw.io mxfile or mxGraphModel document");
  }
  const ids = new Set<string>();
  for (const page of Array.from(document.getElementsByTagName("diagram"))) {
    const id = page.getAttribute("id");
    if (!id) throw new Error("Every page in a multi-page mxfile must have an id");
    if (ids.has(id)) throw new Error("Duplicate Draw.io page id: " + id);
    ids.add(id);
  }
  return ids;
}

/**
 * Server-side coordinator for prepared XML outputs. This deliberately accepts already
 * planned XML rather than executing model-generated JavaScript. It does not promise a
 * cross-file atomic filesystem transaction; failed commits are compensated in reverse.
 */
export function createWorkspaceChangeSetService(access: WorkspaceChangeSetFileAccess) {
  async function prepare(input: unknown, outputs: Array<{ filePath: string; xml: string }>) {
    const parsed = WorkspaceDiagramChangeSetSchema.safeParse(input);
    if (!parsed.success) throw new Error("Invalid change set: " + parsed.error.issues.map((issue) => issue.message).join("; "));
    const changeSet: WorkspaceDiagramChangeSet = parsed.data;
    const workspace = await access.getWorkspace();
    if (!workspace || workspace.id !== changeSet.workspaceId) throw new Error("The target workspace is no longer active");
    const outputByPath = new Map<string, string>();
    for (const output of outputs) {
      if (outputByPath.has(output.filePath)) throw new Error("Multiple XML outputs were supplied for " + output.filePath);
      outputByPath.set(output.filePath, output.xml);
    }
    const expectedPaths = new Set(changeSet.targets.map((target) => target.filePath));
    if (outputByPath.size !== expectedPaths.size || [...outputByPath.keys()].some((filePath) => !expectedPaths.has(filePath))) {
      throw new Error("Every target file must have exactly one prepared XML output");
    }

    const prepared: PreparedWorkspaceDiagram[] = [];
    for (const target of changeSet.targets) {
      const resolved = await access.resolveWorkspaceFile(target.filePath);
      if (resolved.workspace.id !== changeSet.workspaceId || resolved.workspace.id !== target.workspaceId) {
        throw new Error("Workspace changed while resolving " + target.filePath);
      }
      const beforeXml = await readFile(resolved.absolutePath, "utf8");
      const beforeRevision = workspaceRevision(beforeXml);
      if (beforeRevision !== target.expectedRevision) {
        throw new Error("Stale target " + target.filePath + ": expected " + target.expectedRevision + ", found " + beforeRevision);
      }
      validateXml(beforeXml, target.filePath);
      const beforePages = pageIds(beforeXml);
      if (beforePages === null && target.pageId !== null) {
        throw new Error("Bare mxGraphModel target must use pageId=null: " + target.filePath);
      }
      if (beforePages !== null && (!target.pageId || !beforePages.has(target.pageId))) {
        throw new Error("Page id does not exist in " + target.filePath + ": " + String(target.pageId));
      }
      const afterXml = outputByPath.get(target.filePath)!;
      validateXml(afterXml, target.filePath);
      const afterPages = pageIds(afterXml);
      if (target.pageId === null && afterPages !== null) {
        throw new Error("Prepared output changed a bare graph model into a multi-page mxfile: " + target.filePath);
      }
      if (target.pageId !== null && (!afterPages || !afterPages.has(target.pageId))) {
        throw new Error("Prepared output removed the targeted page " + target.pageId + " from " + target.filePath);
      }
      prepared.push({
        target, absolutePath: resolved.absolutePath, beforeXml, afterXml,
        beforeRevision, afterRevision: workspaceRevision(afterXml)
      });
    }
    // Re-read every target after all outputs have been validated, before any writes.
    for (const item of prepared) {
      const current = await readFile(item.absolutePath, "utf8");
      if (workspaceRevision(current) !== item.beforeRevision) {
        throw new Error("Target changed during preparation: " + item.target.filePath);
      }
    }
    return {
      id: changeSet.id || randomUUID(),
      workspaceId: changeSet.workspaceId,
      summary: changeSet.summary,
      prepared
    };
  }

  async function apply(plan: Awaited<ReturnType<typeof prepare>>): Promise<WorkspaceChangeSetJournal> {
    const journal: WorkspaceChangeSetJournal = {
      id: plan.id, workspaceId: plan.workspaceId, status: "prepared",
      createdAt: new Date().toISOString(),
      files: plan.prepared.map((item) => ({
        filePath: item.target.filePath, pageIds: plan.prepared.filter((candidate) => candidate.target.filePath === item.target.filePath)
          .map((candidate) => candidate.target.pageId).filter((id): id is string => id !== null),
        beforeRevision: item.beforeRevision, afterRevision: item.afterRevision, status: "pending"
      }))
    };
    // Sort writes to make concurrent coordinators use a consistent lock/order strategy.
    const ordered = [...plan.prepared].sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
    const latestWorkspace = await access.getWorkspace();
    if (!latestWorkspace || latestWorkspace.id !== plan.workspaceId) throw new Error("Workspace changed before commit");
    for (const item of ordered) {
      const current = await readFile(item.absolutePath, "utf8");
      if (workspaceRevision(current) !== item.beforeRevision) {
        throw new Error("Stale target before commit: " + item.target.filePath);
      }
    }
    try {
      await runCompensatingTransaction(ordered.map((item) => ({
        name: item.target.filePath,
        apply: async () => {
          const current = await readFile(item.absolutePath, "utf8");
          if (workspaceRevision(current) !== item.beforeRevision) {
            throw new Error("Target changed during commit: " + item.target.filePath);
          }
          await writeTextAtomic(item.absolutePath, item.afterXml);
          const record = journal.files.find((file) => file.filePath === item.target.filePath)!;
          record.status = "applied";
        },
        rollback: async () => {
          await writeTextAtomic(item.absolutePath, item.beforeXml);
          const record = journal.files.find((file) => file.filePath === item.target.filePath)!;
          record.status = "rolled_back";
        }
      })));
      journal.status = "applied";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const recoveryRequired = message.includes("compensation was incomplete");
      journal.status = recoveryRequired ? "recovery_required" : "rolled_back";
      for (const file of journal.files) {
        if (file.status === "applied" && recoveryRequired) {
          file.status = "recovery_required";
          file.error = message;
        }
      }
      journal.completedAt = new Date().toISOString();
      throw Object.assign(new Error(message), { journal });
    }
    journal.completedAt = new Date().toISOString();
    return journal;
  }

  return { prepare, apply };
}
