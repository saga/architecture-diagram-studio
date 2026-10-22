import { describe, expect, it } from "vitest";
import { createC4Fixture, createFlowFixture, createSequenceFixture } from "./model/fixtures";
import { interpretIntent } from "./intent/applyIntent";
import { mxEdgeStyle, relationPaint } from "./design/styles";
import { parseAIIntentResponse } from "./intent/aiProvider";
import { isDiagramDocument } from "./model/types";
import { layoutDiagram } from "./layout/layout";

describe("V2 semantic fixtures and intents", () => {
  it("keeps first-class diagram types limited to C4, flowchart and sequence", () => {
    expect(createC4Fixture().kind).toBe("c4");
    expect(createFlowFixture().kind).toBe("flowchart");
    expect(createSequenceFixture().kind).toBe("sequence");
  });

  it("changes line appearance without requiring geometry relayout", () => {
    const result = interpretIntent(createC4Fixture(), "把所有的线换成虚线");
    expect(result.changed).toBe(true);
    expect(result.requiresLayout).toBe(false);
    expect(result.document.relations.every((edge) => edge.dashed)).toBe(true);
  });

  it("reroutes geometry when curves are changed to polyline", () => {
    const document = createC4Fixture();
    document.layout.routing = "curved";
    document.relations = document.relations.map((edge) => ({ ...edge, routing: "curved", points: [{ x: 220, y: 100 }] }));
    const result = interpretIntent(document, "把曲线改成折线");
    expect(result.changed).toBe(true);
    expect(result.requiresLayout).toBe(true);
    expect(result.document.layout.routing).toBe("polyline");
    expect(result.document.relations.every((edge) => edge.points?.length === 0)).toBe(true);
  });

  it("keeps flowchart exception branches close to their connected main-path steps", async () => {
    const laidOut = await layoutDiagram(createFlowFixture());
    const centerX = (id: string) => {
      const node = laidOut.nodes.find((item) => item.id === id)!;
      return node.x + node.width / 2;
    };
    const branchCenterX = (id: string) => centerX(id);
    const reviewExpected = (centerX("valid") + centerX("enrich")) / 2;
    const approvalExpected = (centerX("approve") + centerX("submit")) / 2;
    expect(Math.abs(branchCenterX("review") - reviewExpected)).toBeLessThan(2);
    expect(Math.abs(branchCenterX("approval") - approvalExpected)).toBeLessThan(2);
    const primaryY = new Set((laidOut.flow?.primaryPath || []).map((id) => laidOut.nodes.find((node) => node.id === id)!.y));
    expect(primaryY.size).toBe(1);
    expect(laidOut.nodes.find((node) => node.id === "review")!.y)
      .toBeGreaterThan(laidOut.nodes.find((node) => node.id === "valid")!.y);

    const mainPath = laidOut.flow!.primaryPath.map((id) => laidOut.nodes.find((node) => node.id === id)!);
    expect(new Set(mainPath.map((node) => node.y)).size).toBe(1);
    const expectedGap = Math.max(36, Math.min(64, Math.round(laidOut.layout.layerSpacing * 0.55)));
    for (let index = 1; index < mainPath.length; index++) {
      expect(mainPath[index].x - (mainPath[index - 1].x + mainPath[index - 1].width))
        .toBe(expectedGap);
    }
  });

  it("models external placement as a semantic constraint", () => {
    const result = interpretIntent(createC4Fixture(), "把所有 external 放到右侧");
    expect(result.requiresLayout).toBe(true);
    expect(result.document.nodes.find((node) => node.role === "external")?.layoutHints?.preferredSide).toBe("RIGHT");
  });

  it("renames a single matching node without changing its geometry", () => {
    const document = createC4Fixture();
    const before = document.nodes.find((node) => node.id === "portal")!;
    const result = interpretIntent(document, "将 portal 节点重命名为 Web Portal");
    const after = result.document.nodes.find((node) => node.id === "portal")!;
    expect(result.changed).toBe(true);
    expect(after.name).toBe("Web Portal");
    expect(after.x).toBe(before.x);
    expect(after.y).toBe(before.y);
    expect(result.requiresLayout).toBe(false);
  });

  it("removes a node and all semantic references without moving other nodes", () => {
    const document = createC4Fixture();
    const result = interpretIntent(document, "删除节点 portal");
    expect(result.changed).toBe(true);
    expect(result.document.nodes.some((node) => node.id === "portal")).toBe(false);
    expect(result.document.relations.some((edge) => edge.source === "portal" || edge.target === "portal")).toBe(false);
    expect(result.document.boundaries.every((boundary) => !boundary.members.includes("portal"))).toBe(true);
  });

  it("adds a node while preserving existing node positions", () => {
    const document = createC4Fixture();
    const before = document.nodes.map((node) => ({ id: node.id, x: node.x, y: node.y }));
    const result = interpretIntent(document, "新增服务节点 Audit Service");
    expect(result.changed).toBe(true);
    expect(result.document.nodes.some((node) => node.name === "Audit Service")).toBe(true);
    for (const item of before) {
      const node = result.document.nodes.find((candidate) => candidate.id === item.id)!;
      expect([node.x, node.y]).toEqual([item.x, item.y]);
    }
  });

  it("updates one relation label without relayout", () => {
    const document = createC4Fixture();
    const result = interpretIntent(document, "将关系 e1 的标签改为 HTTPS request");
    expect(result.changed).toBe(true);
    expect(result.document.relations.find((edge) => edge.id === "e1")?.label).toBe("HTTPS request");
    expect(result.requiresLayout).toBe(false);
  });

  it("adds a relation by stable node IDs without relayout", () => {
    const document = createC4Fixture();
    const result = interpretIntent(document, "新增关系 portal -> domain，标签为 Calls");
    expect(result.changed).toBe(true);
    expect(result.requiresLayout).toBe(false);
    expect(result.document.relations.some((edge) => edge.source === "portal" && edge.target === "domain" && edge.label === "Calls")).toBe(true);
  });

  it("lets an explicit solid-line command override sequence return defaults", () => {
    const edge = createSequenceFixture().relations.find((relation) => relation.kind === "return")!;
    expect(relationPaint({ ...edge, dashed: false }).dash).toBe("");
    expect(mxEdgeStyle({ ...edge, dashed: false }, "polyline")).not.toContain("dashed=1");
  });

  it("accepts typed native Draw.io operations with a resolved cell id", () => {
    const response = parseAIIntentResponse(JSON.stringify({
      reply: "Add bbb after Database",
      nativeEdits: {
        operations: [
          { op: "add_node_after", target: "Database", cellId: "db", label: "Database", newLabel: "bbb" }
        ],
        summary: "Add bbb after Database",
        requiresClientExecution: true
      },
      model: "stub-model"
    }));
    expect(response.nativeEdits?.operations).toEqual([
      { op: "add_node_after", target: "Database", cellId: "db", label: "Database", newLabel: "bbb" }
    ]);
    expect(response.reply).toBe("Add bbb after Database");
    expect(response.sessionId).toBeUndefined();
  });

  it("rejects a native edit batch without a server-resolved cell id", () => {
    expect(() => parseAIIntentResponse(JSON.stringify({
      reply: "Rename Database",
      nativeEdits: {
        operations: [{ op: "set_label", target: "Database", label: "Store" }],
        summary: "Rename Database",
        requiresClientExecution: true
      }
    }))).toThrow("resolved cell id");
  });

  it("rejects invalid response JSON and unsupported native operations", () => {
    expect(() => parseAIIntentResponse("Change the diagram")).toThrow("valid native-edit response");
    expect(() => parseAIIntentResponse(JSON.stringify({
      nativeEdits: {
        operations: [{ op: "regenerate_document", target: "all" }],
        summary: "No",
        requiresClientExecution: true
      }
    }))).toThrow("invalid native edit batch");
  });

  it("validates local documents before restoring them", () => {
    const document = createC4Fixture();
    expect(isDiagramDocument(document)).toBe(true);
    expect(isDiagramDocument({ ...document, layout: undefined })).toBe(false);
    expect(isDiagramDocument({ ...document, nodes: [{ id: "broken" }] })).toBe(false);
  });

  it("validates sequence fragment order before persisting the model", () => {
    const document = createSequenceFixture();
    const valid = {
      ...document,
      sequence: { ...(document.sequence || { participants: [] }), fragments: [
        { id: "alt-1", kind: "alt", label: "Valid", startOrder: 1, endOrder: 3 }
      ] }
    };
    const invalid = {
      ...document,
      sequence: { ...(document.sequence || { participants: [] }), fragments: [
        { id: "bad", kind: "loop", label: "Invalid range", startOrder: 4, endOrder: 2 }
      ] }
    };
    expect(isDiagramDocument(valid)).toBe(true);
    expect(isDiagramDocument(invalid)).toBe(false);
  });
});