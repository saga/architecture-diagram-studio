import { describe, expect, it } from 'vitest';
import { createDiagramTemplate } from './templates';
import { normalizeSequenceRanges, sequenceActivationDomId, sequenceActivationIssue, sequenceActivationKey } from './sequence';

describe('sequence activation invariants', () => {
  it('uses a stable key for a participant message interval', () => {
    expect(sequenceActivationKey({ participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-5' }))
      .toBe('["api","msg-2","msg-5"]');
  });

  it('rejects missing participants/messages and reversed ranges', () => {
    const sequence = createDiagramTemplate('sequence').sequence!;
    expect(sequenceActivationIssue(sequence, { participantId: 'missing', startMessageId: 'msg-1', endMessageId: 'msg-2' }))
      .toBe('Activation participant does not exist.');
    expect(sequenceActivationIssue(sequence, { participantId: 'api', startMessageId: 'missing', endMessageId: 'msg-2' }))
      .toBe('Activation start and end must reference existing messages.');
    expect(sequenceActivationIssue(sequence, { participantId: 'api', startMessageId: 'msg-6', endMessageId: 'msg-2' }))
      .toBe('Activation end must not precede its start.');
  });

  it('builds a unique renderer ID from the participant and both message bounds', () => {
    expect(sequenceActivationDomId({ participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-5' }))
      .toBe('activation-%5B%22api%22%2C%22msg-2%22%2C%22msg-5%22%5D');
    expect(sequenceActivationDomId({ participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-6' }))
      .not.toBe(sequenceActivationDomId({ participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-5' }));
  });

  it('keeps activation and fragment ranges chronological after message order changes', () => {
    const sequence = createDiagramTemplate('sequence').sequence!;
    sequence.messages = sequence.messages.map(message => {
      if (message.id === 'msg-1') return { ...message, order: 2 };
      if (message.id === 'msg-2') return { ...message, order: 1 };
      return message;
    });
    sequence.activations = [{ participantId: 'web', startMessageId: 'msg-1', endMessageId: 'msg-2' }];
    sequence.fragments = [{
      id: 'fragment-swap', kind: 'opt', title: 'Swap boundary',
      startMessageId: 'msg-1', endMessageId: 'msg-2',
    }];

    const normalized = normalizeSequenceRanges(sequence);
    expect(normalized.activations?.[0]).toMatchObject({ startMessageId: 'msg-2', endMessageId: 'msg-1' });
    expect(normalized.fragments?.[0]).toMatchObject({ startMessageId: 'msg-2', endMessageId: 'msg-1' });
  });

  it('deduplicates activation intervals that collapse to the same range after reordering', () => {
    const sequence = createDiagramTemplate('sequence').sequence!;
    sequence.messages = sequence.messages.map(message => {
      if (message.id === 'msg-1') return { ...message, order: 2 };
      if (message.id === 'msg-2') return { ...message, order: 1 };
      return message;
    });
    sequence.activations = [
      { participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-1' },
      { participantId: 'api', startMessageId: 'msg-1', endMessageId: 'msg-2' },
    ];
    const normalized = normalizeSequenceRanges(sequence);
    expect(normalized.activations).toHaveLength(1);
    expect(normalized.activations?.[0]).toMatchObject({ startMessageId: 'msg-2', endMessageId: 'msg-1' });
  });

  it('rejects duplicate ranges but allows updating the same activation in place', () => {
    const sequence = createDiagramTemplate('sequence').sequence!;
    const current = sequence.activations![0];
    expect(sequenceActivationIssue(sequence, { ...current })).toBe('An activation with the same participant and message range already exists.');
    expect(sequenceActivationIssue(sequence, { ...current }, sequenceActivationKey(current))).toBeUndefined();
  });
});
