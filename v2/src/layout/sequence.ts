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
    const participants = fragment.participants === undefined
      ? undefined
      : [...new Set(fragment.participants.filter((id) => nodeIds.has(id)))];
    return { ...fragment, startOrder, endOrder, ...(participants ? { participants } : {}) };
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
export interface SequenceMessageGeometry {
  start: { x: number; y: number };
  end: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
}

/**
 * Canonical sequence message geometry shared by layout, quality checks and Draw.io XML generation
 * XML exporter. Keeping this here prevents the two renderers from disagreeing
 * about message order, activation-bar endpoints, and self-call loops.
 */
export function sequenceMessageGeometry(
  document: DiagramDocument,
  relation: DiagramRelation
): SequenceMessageGeometry | null {
  if (document.kind !== "sequence") return null;
  const source = document.nodes.find((node) => node.id === relation.source);
  const target = document.nodes.find((node) => node.id === relation.target);
  if (!source || !target) return null;

  const order = relation.sequenceOrder ?? 0;
  const y = 148 + order * 72;
  const centerX = (node: typeof source) => node.x + node.width / 2;
  const activations = deriveSequenceActivations(document);
  const activeActivation = (participantId: string) => activations
    .filter((activation) => activation.participantId === participantId &&
      activation.startOrder <= order && activation.endOrder >= order)
    .sort((a, b) => b.startOrder - a.startOrder || a.endOrder - b.endOrder)[0];
  const endpointX = (participant: typeof source, towardX: number) => {
    const activation = activeActivation(participant.id);
    if (!activation) return centerX(participant);
    return centerX(participant) + (towardX >= centerX(participant) ? 7 : -7);
  };

  if (source.id === target.id) {
    const x = centerX(source) + (activeActivation(source.id) ? 7 : 0);
    const start = { x, y };
    const end = { x, y: y + 24 };
    const loopX = centerX(source) + 34;
    return { start, end, points: [{ x: loopX, y }, { x: loopX, y: y + 24 }] };
  }

  const sourceCenter = centerX(source);
  const targetCenter = centerX(target);
  return {
    start: { x: endpointX(source, targetCenter), y },
    end: { x: endpointX(target, sourceCenter), y },
    points: []
  };
}
