import type { DiagramDocument, DiagramRelation } from "../model/types";

export interface SequenceActivation {
  id: string;
  participantId: string;
  startOrder: number;
  endOrder: number;
}

export function deriveSequenceActivations(document: DiagramDocument): SequenceActivation[] {
  if (document.kind !== "sequence") return [];
  const ordered = document.relations
    .map((relation, index) => ({ relation, order: relation.sequenceOrder ?? index }))
    .sort((a, b) => a.order - b.order);
  const openCalls: Array<{ relation: DiagramRelation; order: number }> = [];
  const activations: SequenceActivation[] = [];

  for (const item of ordered) {
    const relation = item.relation;
    if (relation.kind === "return") {
      let matchIndex = -1;
      for (let index = openCalls.length - 1; index >= 0; index--) {
        const opened = openCalls[index].relation;
        if (opened.source === relation.target && opened.target === relation.source) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) continue;
      const [opened] = openCalls.splice(matchIndex, 1);
      if (item.order > opened.order) {
        activations.push({
          id: "activation-" + opened.relation.id,
          participantId: opened.relation.target,
          startOrder: opened.order,
          endOrder: item.order
        });
      }
    } else if (relation.kind === "call") {
      openCalls.push({ relation, order: item.order });
    }
  }
  return activations.sort((a, b) => a.startOrder - b.startOrder || b.endOrder - a.endOrder);
}