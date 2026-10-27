import { describe, expect, it } from "vitest";
import { compareCopilotRequestContext, type CopilotRequestDiagramState } from "./copilot-stale-context";

const before = '<mxfile><diagram id="p1" name="Overview"><mxGraphModel dx="1086" dy="613"><root>' +
  '<mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="api" value="Old API" vertex="1" parent="1" style="rounded=0;"><mxGeometry x="10" y="20" width="100" height="40" as="geometry"/></mxCell>' +
  '<mxCell id="db" value="Database" vertex="1" parent="1"><mxGeometry x="200" y="20" width="100" height="40" as="geometry"/></mxCell>' +
  '</root></mxGraphModel></diagram></mxfile>';

function state(
  drawioXml = before,
  selectedNativeCellId: string | null = "api",
  selectedNativePageId: string | null = "p1"
): CopilotRequestDiagramState {
  return { drawioXml, selectedNativeCellId, selectedNativePageId };
}

describe("Copilot request stale-context classification", () => {
  it("does not abort when selection changes but the document and active page are stable", () => {
    const result = compareCopilotRequestContext(state(), state(before, "db"));

    expect(result).toMatchObject({
      stale: false,
      staleField: null,
      xmlChanged: false,
      pageChanged: false,
      selectionChanged: true,
      semanticDocumentChanged: false
    });
  });

  it("treats Draw.io viewport-only dx/dy serialization changes as semantically unchanged", () => {
    const panned = before.replace('dx="1086" dy="613"', 'dx="2566" dy="1314"');
    const result = compareCopilotRequestContext(state(), state(panned));

    expect(result).toMatchObject({
      stale: false,
      staleField: null,
      xmlChanged: true,
      pageChanged: false,
      selectionChanged: false,
      semanticDocumentChanged: false,
      semanticDiffAvailable: true,
      semanticDiffSummary: {
        pagesAdded: 0,
        pagesRemoved: 0,
        pagesRenamed: 0,
        cellsAdded: 0,
        cellsRemoved: 0,
        cellsChanged: 0
      }
    });
  });

  it("rejects a real cell-content or style change as stale document context", () => {
    const edited = before
      .replace('value="Old API"', 'value="New API"')
      .replace('style="rounded=0;"', 'style="rounded=0;strokeColor=#FFFF00;"');
    const result = compareCopilotRequestContext(state(), state(edited));

    expect(result.stale).toBe(true);
    expect(result.staleField).toBe("document");
    expect(result.semanticDocumentChanged).toBe(true);
    expect(result.semanticDiffAvailable).toBe(true);
  });

  it("rejects a page switch even when the XML snapshot itself is unchanged", () => {
    const result = compareCopilotRequestContext(state(), state(before, "api", "p2"));

    expect(result).toMatchObject({
      stale: true,
      staleField: "page",
      xmlChanged: false,
      pageChanged: true,
      selectionChanged: false,
      semanticDocumentChanged: false
    });
  });

  it("fails closed when the XML semantic diff cannot be established", () => {
    const result = compareCopilotRequestContext(state(), state("<not-valid"));

    expect(result.stale).toBe(true);
    expect(result.staleField).toBe("document");
    expect(result.semanticDocumentChanged).toBe(true);
    expect(result.semanticDiffAvailable).toBe(false);
  });
});
