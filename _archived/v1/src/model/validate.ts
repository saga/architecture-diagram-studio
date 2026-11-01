import type { DiagramDocument } from './diagram.js';
import { sequenceActivationKey } from './sequence.js';

export interface ValidationIssue {
  code: string;
  message: string;
  elementId?: string;
  severity: 'error' | 'warning';
}

/** Validate the semantic graph before layout or export. Never silently discard invalid references. */
export function validateDiagram(doc: DiagramDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const diagramKinds = ['c4-context', 'c4-container', 'c4-component', 'sequence'];
  if (!diagramKinds.includes(doc.kind)) issues.push({ code: 'DIAGRAM_KIND_INVALID', message: 'The diagram kind is not supported.', severity: 'error' });
  const ids = new Set<string>();
  const nodeTypes = ['person', 'system', 'service', 'component', 'database', 'external', 'boundary'];
  for (const node of doc.nodes) {
    if (!node.id.trim()) issues.push({ code: 'NODE_ID_EMPTY', message: 'A node has an empty ID.', severity: 'error' });
    if (ids.has(node.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate element ID "${node.id}".`, elementId: node.id, severity: 'error' });
    ids.add(node.id);
    if (!nodeTypes.includes(node.type)) issues.push({ code: 'NODE_TYPE_INVALID', message: `Node "${node.id}" has unsupported type "${node.type}".`, elementId: node.id, severity: 'error' });
    if (!node.label.trim()) issues.push({ code: 'NODE_LABEL_EMPTY', message: `Node "${node.id}" has no label.`, elementId: node.id, severity: 'warning' });
    const geometry = doc.layout[node.id];
    if (!geometry) {
      issues.push({ code: 'LAYOUT_MISSING', message: `Node "${node.id}" has no saved geometry; default geometry will be used.`, elementId: node.id, severity: 'warning' });
    } else {
      if (![geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0) {
        issues.push({ code: 'NODE_GEOMETRY_INVALID', message: `Node "${node.id}" has invalid or non-positive geometry.`, elementId: node.id, severity: 'error' });
      }
      const portIds = new Set<string>();
      for (const port of geometry.ports ?? []) {
        if (!port.id.trim() || portIds.has(port.id)) issues.push({ code: 'PORT_ID_INVALID', message: `Node "${node.id}" has an empty or duplicate port ID.`, elementId: node.id, severity: 'error' });
        portIds.add(port.id);
        if (!['LEFT', 'RIGHT', 'TOP', 'BOTTOM'].includes(port.side)) issues.push({ code: 'PORT_SIDE_INVALID', message: `Port "${port.id}" on node "${node.id}" has unsupported side "${port.side}".`, elementId: node.id, severity: 'error' });
        if (![port.x, port.y].every(Number.isFinite) || port.x < 0 || port.y < 0 || port.x > geometry.width || port.y > geometry.height) {
          issues.push({ code: 'PORT_GEOMETRY_INVALID', message: `Port "${port.id}" on node "${node.id}" is outside its node bounds or has non-finite coordinates.`, elementId: node.id, severity: 'error' });
        }
      }
    }
  }
  for (const boundary of doc.boundaries ?? []) {
    if (!boundary.id.trim()) issues.push({ code: 'BOUNDARY_ID_EMPTY', message: 'A C4 system boundary has an empty ID.', severity: 'error' });
    if (ids.has(boundary.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate diagram element ID "${boundary.id}".`, elementId: boundary.id, severity: 'error' });
    ids.add(boundary.id);
    if (!boundary.label.trim()) issues.push({ code: 'BOUNDARY_LABEL_EMPTY', message: `System boundary "${boundary.id}" has no label.`, elementId: boundary.id, severity: 'warning' });
    if (![boundary.x, boundary.y, boundary.width, boundary.height].every(Number.isFinite) || boundary.width <= 0 || boundary.height <= 0) {
      issues.push({ code: 'BOUNDARY_GEOMETRY_INVALID', message: `System boundary "${boundary.id}" has invalid geometry.`, elementId: boundary.id, severity: 'error' });
    }
    const memberIds = new Set<string>();
    for (const nodeId of boundary.memberNodeIds) {
      if (memberIds.has(nodeId)) issues.push({ code: 'BOUNDARY_MEMBER_DUPLICATE', message: `System boundary "${boundary.id}" lists element "${nodeId}" more than once.`, elementId: boundary.id, severity: 'error' });
      memberIds.add(nodeId);
      if (!doc.nodes.some((node) => node.id === nodeId)) {
        issues.push({ code: 'BOUNDARY_MEMBER_NOT_FOUND', message: `System boundary "${boundary.id}" refers to missing element "${nodeId}".`, elementId: boundary.id, severity: 'error' });
      }
    }
  }
  for (const relation of doc.relations) {
    if (!relation.id.trim()) issues.push({ code: 'RELATION_ID_EMPTY', message: 'A relation has an empty ID.', severity: 'error' });
    if (relation.kind && !['sync', 'async', 'data'].includes(relation.kind)) issues.push({ code: 'RELATION_KIND_INVALID', message: `Relation "${relation.id}" has unsupported kind "${relation.kind}".`, elementId: relation.id, severity: 'error' });
    if (!relation.label.trim()) issues.push({ code: 'RELATION_LABEL_EMPTY', message: `Relation "${relation.id}" has an empty label.`, elementId: relation.id, severity: 'warning' });
    if (relation.waypoints && relation.waypoints.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) issues.push({ code: 'RELATION_WAYPOINT_INVALID', message: `Relation "${relation.id}" has a non-finite waypoint.`, elementId: relation.id, severity: 'error' });
    if (ids.has(relation.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate element ID "${relation.id}".`, elementId: relation.id, severity: 'error' });
    ids.add(relation.id);
    if (!doc.nodes.some(node => node.id === relation.sourceId)) issues.push({ code: 'SOURCE_NOT_FOUND', message: `Relation "${relation.id}" refers to missing source "${relation.sourceId}".`, elementId: relation.id, severity: 'error' });
    if (!doc.nodes.some(node => node.id === relation.targetId)) issues.push({ code: 'TARGET_NOT_FOUND', message: `Relation "${relation.id}" refers to missing target "${relation.targetId}".`, elementId: relation.id, severity: 'error' });
    if (relation.sourceId === relation.targetId) issues.push({ code: 'SELF_RELATION', message: `Relation "${relation.id}" connects an element to itself.`, elementId: relation.id, severity: 'warning' });
  }
  if (doc.kind === 'sequence') {
    if (doc.nodes.length || doc.relations.length || Object.keys(doc.layout).length || (doc.boundaries?.length ?? 0)) {
      issues.push({ code: 'SEQUENCE_GRAPH_DATA_PRESENT', message: 'A UML Sequence document must store content only in sequence participants/messages/activations/fragments, not in generic graph nodes, relations, layout, or C4 boundaries.', severity: 'error' });
    }
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
      if (!['actor', 'system', 'container', 'database', 'external'].includes(participant.role)) issues.push({ code: 'SEQUENCE_PARTICIPANT_ROLE_INVALID', message: `Sequence participant "${participant.id}" has unsupported role "${participant.role}".`, elementId: participant.id, severity: 'error' });
      if (!participant.label.trim()) issues.push({ code: 'SEQUENCE_PARTICIPANT_LABEL_EMPTY', message: `Sequence participant "${participant.id}" has no label.`, elementId: participant.id, severity: 'warning' });
    }

    const messageIds = new Set<string>();
    const orderValues = new Set<number>();
    for (const message of sequence.messages) {
      if (!message.id.trim()) issues.push({ code: 'SEQUENCE_MESSAGE_ID_EMPTY', message: 'A sequence message has an empty ID.', severity: 'error' });
      if (ids.has(message.id) || messageIds.has(message.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate sequence message ID "${message.id}".`, elementId: message.id, severity: 'error' });
      ids.add(message.id);
      messageIds.add(message.id);
      if (!['call', 'return', 'async'].includes(message.kind)) issues.push({ code: 'SEQUENCE_MESSAGE_KIND_INVALID', message: `Message "${message.id}" has unsupported kind "${message.kind}".`, elementId: message.id, severity: 'error' });
      if (!message.label.trim()) issues.push({ code: 'SEQUENCE_MESSAGE_LABEL_EMPTY', message: `Message "${message.id}" has no label.`, elementId: message.id, severity: 'warning' });
      if (!participantIds.has(message.fromParticipantId)) issues.push({ code: 'SEQUENCE_SOURCE_NOT_FOUND', message: `Message "${message.id}" refers to missing source participant "${message.fromParticipantId}".`, elementId: message.id, severity: 'error' });
      if (!participantIds.has(message.toParticipantId)) issues.push({ code: 'SEQUENCE_TARGET_NOT_FOUND', message: `Message "${message.id}" refers to missing target participant "${message.toParticipantId}".`, elementId: message.id, severity: 'error' });
      if (!Number.isInteger(message.order) || message.order < 1) issues.push({ code: 'SEQUENCE_ORDER_INVALID', message: `Message "${message.id}" must have a positive integer order.`, elementId: message.id, severity: 'error' });
      if (orderValues.has(message.order)) issues.push({ code: 'SEQUENCE_ORDER_DUPLICATE', message: `Sequence order "${message.order}" is assigned to more than one message.`, elementId: message.id, severity: 'error' });
      orderValues.add(message.order);
    }

    const activationKeys = new Set<string>();
    for (const activation of sequence.activations ?? []) {
      const activationKey = sequenceActivationKey(activation);
      if (activationKeys.has(activationKey)) issues.push({ code: 'SEQUENCE_ACTIVATION_DUPLICATE', message: `Activation range for participant "${activation.participantId}" is duplicated.`, elementId: activation.participantId, severity: 'error' });
      activationKeys.add(activationKey);
      if (!participantIds.has(activation.participantId)) issues.push({ code: 'SEQUENCE_ACTIVATION_PARTICIPANT_NOT_FOUND', message: `Activation refers to missing participant "${activation.participantId}".`, elementId: activation.participantId, severity: 'error' });
      if (!messageIds.has(activation.startMessageId) || !messageIds.has(activation.endMessageId)) {
        issues.push({ code: 'SEQUENCE_ACTIVATION_MESSAGE_NOT_FOUND', message: 'An activation refers to a missing start or end message.', elementId: activation.participantId, severity: 'error' });
      } else {
        const start = sequence.messages.find(message => message.id === activation.startMessageId);
        const end = sequence.messages.find(message => message.id === activation.endMessageId);
        if (start && end && start.order > end.order) issues.push({ code: 'SEQUENCE_ACTIVATION_ORDER_INVALID', message: `Activation for "${activation.participantId}" ends before it starts.`, elementId: activation.participantId, severity: 'error' });
      }
    }
    for (const fragment of sequence.fragments ?? []) {
      if (!fragment.id.trim()) issues.push({ code: 'SEQUENCE_FRAGMENT_ID_EMPTY', message: 'A sequence fragment has an empty ID.', severity: 'error' });
      if (!['alt', 'opt', 'loop', 'par'].includes(fragment.kind)) issues.push({ code: 'SEQUENCE_FRAGMENT_KIND_INVALID', message: `Fragment "${fragment.id}" has unsupported kind "${fragment.kind}".`, elementId: fragment.id, severity: 'error' });
      if (!fragment.title.trim()) issues.push({ code: 'SEQUENCE_FRAGMENT_TITLE_EMPTY', message: `Fragment "${fragment.id}" has no title.`, elementId: fragment.id, severity: 'warning' });
      if (ids.has(fragment.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate sequence fragment ID "${fragment.id}".`, elementId: fragment.id, severity: 'error' });
      ids.add(fragment.id);
      if (!messageIds.has(fragment.startMessageId) || !messageIds.has(fragment.endMessageId)) issues.push({ code: 'SEQUENCE_FRAGMENT_MESSAGE_NOT_FOUND', message: `Fragment "${fragment.id}" refers to a missing start or end message.`, elementId: fragment.id, severity: 'error' });
      else {
        const start = sequence.messages.find(message => message.id === fragment.startMessageId);
        const end = sequence.messages.find(message => message.id === fragment.endMessageId);
        if (start && end && start.order > end.order) issues.push({ code: 'SEQUENCE_FRAGMENT_ORDER_INVALID', message: `Fragment "${fragment.id}" ends before it starts.`, elementId: fragment.id, severity: 'error' });
      }
      if (fragment.participantStartId && !participantIds.has(fragment.participantStartId)) issues.push({ code: 'SEQUENCE_FRAGMENT_START_PARTICIPANT_NOT_FOUND', message: `Fragment "${fragment.id}" refers to missing start participant "${fragment.participantStartId}".`, elementId: fragment.id, severity: 'error' });
      if (fragment.participantEndId && !participantIds.has(fragment.participantEndId)) issues.push({ code: 'SEQUENCE_FRAGMENT_END_PARTICIPANT_NOT_FOUND', message: `Fragment "${fragment.id}" refers to missing end participant "${fragment.participantEndId}".`, elementId: fragment.id, severity: 'error' });
    }
  } else if (doc.sequence) {
    issues.push({ code: 'SEQUENCE_DATA_ON_GRAPH', message: 'A C4 diagram cannot contain UML Sequence data.', severity: 'error' });
  }
  return issues;
}
