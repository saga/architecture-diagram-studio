import { afterEach, describe, expect, it } from "vitest";
import { workspaceRevision } from "../storage";
import { clearDiagramSnapshotCacheForTests, getCachedNativeDiagramSnapshot } from "./diagram-snapshot-cache";

const XML = '<mxfile><diagram id="p1" name="Page 1"><mxGraphModel><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

afterEach(() => clearDiagramSnapshotCacheForTests());

describe("native Draw.io parsed snapshot cache", () => {
  it("reuses validation and targets for the same revision and page", () => {
    const revision = workspaceRevision(XML);
    const first = getCachedNativeDiagramSnapshot(XML, revision, "p1");
    const second = getCachedNativeDiagramSnapshot(XML, revision, "p1");

    expect(first.ok).toBe(true);
    expect(first.ok && first.cacheHit).toBe(false);
    expect(second.ok).toBe(true);
    expect(second.ok && second.cacheHit).toBe(true);
    expect(second.ok && second.snapshot.targets.map((cell) => cell.id)).toEqual(["db"]);
  });

  it("keys page-specific target indexes independently", () => {
    const revision = workspaceRevision(XML);
    const first = getCachedNativeDiagramSnapshot(XML, revision, "p1");
    const second = getCachedNativeDiagramSnapshot(XML, revision, null);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.ok && second.cacheHit).toBe(false);
  });

  it("distinguishes a missing page in a valid multi-page document from invalid XML", () => {
    const multiPage = '<mxfile>' +
      '<diagram id="p1" name="Page 1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>' +
      '<diagram id="p2" name="Page 2"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>' +
      '</mxfile>';
    const result = getCachedNativeDiagramSnapshot(multiPage, workspaceRevision(multiPage), "deleted-page");
    expect(result).toEqual({ ok: false, cacheHit: false, reason: "page-not-found" });
  });

  it("does not cache failed XML validation", () => {
    const invalid = "<not-drawio>";
    const revision = workspaceRevision(invalid);
    expect(getCachedNativeDiagramSnapshot(invalid, revision, null)).toEqual({ ok: false, cacheHit: false, reason: "invalid-xml" });
    expect(getCachedNativeDiagramSnapshot(invalid, revision, null)).toEqual({ ok: false, cacheHit: false, reason: "invalid-xml" });
  });
});
