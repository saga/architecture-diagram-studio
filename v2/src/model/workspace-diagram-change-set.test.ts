import { describe, expect, it } from "vitest";
import { validateWorkspaceDiagramChangeSet } from "./workspace-diagram-change-set";

const revision = "a".repeat(64);
const target = {
  workspaceId: "workspace-1",
  filePath: "diagrams/context.drawio",
  pageId: "page-2",
  expectedRevision: revision
};

describe("workspace diagram change-set contract", () => {
  it("accepts explicit targets across multiple files and pages", () => {
    const result = validateWorkspaceDiagramChangeSet({
      id: "change-1",
      workspaceId: "workspace-1",
      summary: "Update deployment and context diagrams",
      targets: [
        target,
        { ...target, filePath: "diagrams/deployment.drawio", pageId: "overview" },
        { ...target, pageId: "detail" }
      ]
    });
    expect(result.ok).toBe(true);
  });

  it.each(["../outside.drawio", "/tmp/outside.drawio", "C:\\private\\diagram.drawio"])(
    "rejects paths outside the workspace: %s",
    (filePath) => {
      const result = validateWorkspaceDiagramChangeSet({
        id: "change-1", workspaceId: "workspace-1", summary: "Update diagram",
        targets: [{ ...target, filePath }]
      });
      expect(result.ok).toBe(false);
    }
  );

  it("rejects a target from another workspace", () => {
    const result = validateWorkspaceDiagramChangeSet({
      id: "change-1", workspaceId: "workspace-1", summary: "Update diagram",
      targets: [{ ...target, workspaceId: "workspace-2" }]
    });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate file/page targets so operations cannot be ambiguously split", () => {
    const result = validateWorkspaceDiagramChangeSet({
      id: "change-1", workspaceId: "workspace-1", summary: "Update diagram",
      targets: [target, { ...target }]
    });
    expect(result.ok).toBe(false);
  });

  it("allows a null page only as an identity value; XML shape validation remains server-owned", () => {
    const result = validateWorkspaceDiagramChangeSet({
      id: "change-1", workspaceId: "workspace-1", summary: "Update diagram",
      targets: [{ ...target, pageId: null }]
    });
    expect(result.ok).toBe(true);
  });

  it("requires a SHA-256 revision", () => {
    const result = validateWorkspaceDiagramChangeSet({
      id: "change-1", workspaceId: "workspace-1", summary: "Update diagram",
      targets: [{ ...target, expectedRevision: "unknown" }]
    });
    expect(result.ok).toBe(false);
  });
});
