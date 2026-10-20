import type { DiagramDocument } from './diagram.js';

export interface ValidationIssue {
  code: string;
  message: string;
  elementId?: string;
  severity: 'error' | 'warning';
}

/** Validate the semantic graph before layout or export. Never silently discard invalid references. */
export function validateDiagram(doc: DiagramDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    if (!node.id.trim()) issues.push({ code: 'NODE_ID_EMPTY', message: 'A node has an empty ID.', severity: 'error' });
    if (ids.has(node.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate element ID "${node.id}".`, elementId: node.id, severity: 'error' });
    ids.add(node.id);
    if (!node.label.trim()) issues.push({ code: 'NODE_LABEL_EMPTY', message: `Node "${node.id}" has no label.`, elementId: node.id, severity: 'warning' });
    if (!doc.layout[node.id]) issues.push({ code: 'LAYOUT_MISSING', message: `Node "${node.id}" has no saved geometry; default geometry will be used.`, elementId: node.id, severity: 'warning' });
  }
  for (const relation of doc.relations) {
    if (!relation.id.trim()) issues.push({ code: 'RELATION_ID_EMPTY', message: 'A relation has an empty ID.', severity: 'error' });
    if (ids.has(relation.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate element ID "${relation.id}".`, elementId: relation.id, severity: 'error' });
    ids.add(relation.id);
    if (!doc.nodes.some(node => node.id === relation.sourceId)) issues.push({ code: 'SOURCE_NOT_FOUND', message: `Relation "${relation.id}" refers to missing source "${relation.sourceId}".`, elementId: relation.id, severity: 'error' });
    if (!doc.nodes.some(node => node.id === relation.targetId)) issues.push({ code: 'TARGET_NOT_FOUND', message: `Relation "${relation.id}" refers to missing target "${relation.targetId}".`, elementId: relation.id, severity: 'error' });
    if (relation.sourceId === relation.targetId) issues.push({ code: 'SELF_RELATION', message: `Relation "${relation.id}" connects an element to itself.`, elementId: relation.id, severity: 'warning' });
  }
  if (doc.kind === 'sequence') {
    const sequence = doc.sequence;
    if (!sequence) {
      issues.push({ code: 'SEQUENCE_DATA_MISSING', message: 'A sequence diagram requires participants and ordered messages.', severity: 'error' });
      return issues;
    }
    const participantIds = new Set<string>();
    for (const participant of sequence.participants) {
      if (!participant.id.trim()) issues.push({ code: 'SEQUENCE_PARTICIPANT_ID_EMPTY', message: 'A sequence participant has an empty ID.', severity: 'error' });
      if (ids.has(participant.id) || participantIds.has(participant.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate sequence participant ID "${participant.id}".`, elementId: participant.id, severity: 'error' });
      participantIds.add(participant.id);
      ids.add(participant.id);
      if (!participant.label.trim()) issues.push({ code: 'SEQUENCE_PARTICIPANT_LABEL_EMPTY', message: `Sequence participant "${participant.id}" has no label.`, elementId: participant.id, severity: 'warning' });
    }

    const messageIds = new Set<string>();
    const orderValues = new Set<number>();
    for (const message of sequence.messages) {
      if (!message.id.trim()) issues.push({ code: 'SEQUENCE_MESSAGE_ID_EMPTY', message: 'A sequence message has an empty ID.', severity: 'error' });
      if (ids.has(message.id) || messageIds.has(message.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate sequence message ID "${message.id}".`, elementId: message.id, severity: 'error' });
      ids.add(message.id);
      messageIds.add(message.id);
      if (!participantIds.has(message.fromParticipantId)) issues.push({ code: 'SEQUENCE_SOURCE_NOT_FOUND', message: `Message "${message.id}" refers to missing source participant "${message.fromParticipantId}".`, elementId: message.id, severity: 'error' });
      if (!participantIds.has(message.toParticipantId)) issues.push({ code: 'SEQUENCE_TARGET_NOT_FOUND', message: `Message "${message.id}" refers to missing target participant "${message.toParticipantId}".`, elementId: message.id, severity: 'error' });
      if (!Number.isInteger(message.order) || message.order < 1) issues.push({ code: 'SEQUENCE_ORDER_INVALID', message: `Message "${message.id}" must have a positive integer order.`, elementId: message.id, severity: 'error' });
      if (orderValues.has(message.order)) issues.push({ code: 'SEQUENCE_ORDER_DUPLICATE', message: `Sequence order "${message.order}" is assigned to more than one message.`, elementId: message.id, severity: 'error' });
      orderValues.add(message.order);
    }

    for (const activation of sequence.activations ?? []) {
      if (!participantIds.has(activation.participantId)) issues.push({ code: 'SEQUENCE_ACTIVATION_PARTICIPANT_NOT_FOUND', message: `Activation refers to missing participant "${activation.participantId}".`, elementId: activation.participantId, severity: 'error' });
      if (!messageIds.has(activation.startMessageId) || !messageIds.has(activation.endMessageId)) issues.push({ code: 'SEQUENCE_ACTIVATION_MESSAGE_NOT_FOUND', message: 'An activation refers to a missing start or end message.', elementId: activation.participantId, severity: 'error' });
    }
    for (const fragment of sequence.fragments ?? []) {
      if (!messageIds.has(fragment.startMessageId) || !messageIds.has(fragment.endMessageId)) issues.push({ code: 'SEQUENCE_FRAGMENT_MESSAGE_NOT_FOUND', message: `Fragment "${fragment.id}" refers to a missing start or end message.`, elementId: fragment.id, severity: 'error' });
    }
  }
  return issues;
}
