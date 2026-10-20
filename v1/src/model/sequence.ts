import type { SequenceActivation, SequenceDiagramData } from './diagram';

/** Stable identity for an activation; the model uses references rather than a separate activation ID. */
export function sequenceActivationKey(activation: SequenceActivation): string {
  return JSON.stringify([activation.participantId, activation.startMessageId, activation.endMessageId]);
}

/** Stable, renderer-safe DOM/mxGraph cell identity for an activation range. */
export function sequenceActivationDomId(activation: SequenceActivation): string {
  return 'activation-' + encodeURIComponent(sequenceActivationKey(activation));
}

/** Keep activation and fragment boundaries in chronological order after messages move. */
export function normalizeSequenceRanges(sequence: SequenceDiagramData): SequenceDiagramData {
  const orderByMessageId = new Map(sequence.messages.map((message) => [message.id, message.order] as const));
  const normalizeRange = <T extends { startMessageId: string; endMessageId: string }>(range: T): T => {
    const startOrder = orderByMessageId.get(range.startMessageId);
    const endOrder = orderByMessageId.get(range.endMessageId);
    if (startOrder !== undefined && endOrder !== undefined && startOrder > endOrder) {
      return { ...range, startMessageId: range.endMessageId, endMessageId: range.startMessageId };
    }
    return range;
  };
  const normalizedActivations = sequence.activations?.map(normalizeRange);
  // Swapping message order can make two previously distinct intervals identical.
  // Keep the first occurrence rather than leaving a model that cannot be exported.
  const uniqueActivations = normalizedActivations
    ? [...new Map(normalizedActivations.map((activation) => [sequenceActivationKey(activation), activation] as const)).values()]
    : undefined;
  return {
    ...sequence,
    ...(uniqueActivations ? { activations: uniqueActivations } : {}),
    ...(sequence.fragments ? { fragments: sequence.fragments.map(normalizeRange) } : {}),
  };
}

export function sequenceActivationIssue(
  sequence: SequenceDiagramData,
  activation: SequenceActivation,
  excludingKey?: string,
): string | undefined {
  if (!sequence.participants.some((participant) => participant.id === activation.participantId)) {
    return 'Activation participant does not exist.';
  }
  const start = sequence.messages.find((message) => message.id === activation.startMessageId);
  const end = sequence.messages.find((message) => message.id === activation.endMessageId);
  if (!start || !end) return 'Activation start and end must reference existing messages.';
  if (start.order > end.order) return 'Activation end must not precede its start.';
  const key = sequenceActivationKey(activation);
  if ((sequence.activations ?? []).some((item) => sequenceActivationKey(item) !== excludingKey && sequenceActivationKey(item) === key)) {
    return 'An activation with the same participant and message range already exists.';
  }
  return undefined;
}
