import { describe, expect, it } from "vitest";
import { FIXTURES } from "../model/fixtures";
import { selectCompatibleWorkspaceDocument } from "./workspaceHydration";

describe("workspace document hydration", () => {
  it("does not hydrate a document that belongs to a different workspace", () => {
    const previousProjectDocument = FIXTURES.c4();
    expect(selectCompatibleWorkspaceDocument(previousProjectDocument, true)).toBeNull();
  });
  it("accepts only a valid document from the active workspace", () => {
    const activeProjectDocument = FIXTURES.c4();
    expect(selectCompatibleWorkspaceDocument(activeProjectDocument, false)).toBe(activeProjectDocument);
    expect(selectCompatibleWorkspaceDocument({ nodes: "not-an-array" }, false)).toBeNull();
  });
});
