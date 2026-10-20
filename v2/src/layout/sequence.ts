import type { DiagramDocument, DiagramRelation } from "../model/types";

export interface SequenceActivation {
  id: string;
  participantId: string;
  startOrder: number;
  endOrder: number;
}


export function normalizeSequenceDocument(document: DiagramDocument): DiagramDocument {
  if (document.kind !== "sequence") return document;
  const relations = [...document.relations]
    .sort((a, b) => (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER))
    .map((relation, index) => ({ ...relation, sequenceOrder: index }));
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const declared = document.sequence?.participants || [];
  const participants = [
    ...declared.filter((id) => nodeIds.has(id)),
    ...document.nodes.map((node) => node.id).filter((id) => !declared.includes(id))
  ];
  const maxOrder = Math.max(0, relations.length - 1);
  const fragments = (document.sequence?.fragments || []).map((fragment) => {
    const startOrder = Math.min(maxOrder, Math.max(0, Math.floor(fragment.startOrder)));
    const endOrder = Math.max(startOrder, Math.min(maxOrder, Math.max(0, Math.floor(fragment.endOrder))));
    return { ...fragment, startOrder, endOrder };
  });
  return { ...document, relations, sequence: { participants, fragments } };
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