import type { DiagramDocument, QualityIssue } from "../model/types";

/**
 * Style budgets are advisory. Real production architecture diagrams may be
 * larger than editorial examples, so these rules never reject a document.
 */
export function evaluateComplexityBudget(document: DiagramDocument): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message, severity: "warning" });

  if (document.kind === "sequence") {
    const participantCount = (document.sequence?.participants || document.nodes.map((node) => node.id)).length;
    const fragmentCount = document.sequence?.fragments?.length || 0;
    const alternativeCount = (document.sequence?.fragments || []).filter((fragment) => fragment.kind === "alt").length;
    if (participantCount > 5) add("complexity-sequence-lifelines", `Sequence diagram has ${participantCount} lifelines; the recommended editorial budget is 5.`);
    if (document.relations.length > 12) add("complexity-sequence-messages", `Sequence diagram has ${document.relations.length} messages; consider splitting it after 12.`);
    if (fragmentCount > 2) add("complexity-sequence-fragments", `Sequence diagram has ${fragmentCount} combined fragments; consider splitting nested alternatives.`);
    if (alternativeCount > 2) add("complexity-sequence-alt-regions", `Sequence diagram has ${alternativeCount} alt fragments; readability may improve if split.`);
    return issues;
  }

  const nodeBudget = document.kind === "c4" ? 24 : 32;
  const edgeBudget = document.kind === "c4" ? 32 : 40;
  if (document.nodes.length > nodeBudget) {
    add("complexity-nodes", `${document.kind.toUpperCase()} diagram has ${document.nodes.length} nodes; the recommended editorial budget is ${nodeBudget}, not a hard limit.`);
  }
  if (document.relations.length > edgeBudget) {
    add("complexity-relations", `Diagram has ${document.relations.length} relations; consider splitting an overview from detailed relationships.`);
  }
  return issues;
}
