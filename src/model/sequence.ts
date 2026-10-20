import type { SequenceActivation, SequenceDiagramData } from './diagram';

/** Stable identity for an activation; the model uses references rather than a separate activation ID. */
export function sequenceActivationKey(activation: SequenceActivation): string {
  return JSON.stringify([activation.participantId, activation.startMessageId, activation.endMessageId]);
}

/** Apply the sequence-model invariants consistently across UI, REST and Copilot tools. */
/** Stable, renderer-safe DOM/mxGraph cell identity for an activation range. */
export function sequenceActivationDomId(activation: SequenceActivation): string {
  return 'activation-' + encodeURIComponent(sequenceActivationKey(activation));
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
