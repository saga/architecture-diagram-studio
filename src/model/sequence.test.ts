import { describe, expect, it } from 'vitest';
import { createDiagramTemplate } from './templates';
import { sequenceActivationIssue, sequenceActivationKey } from './sequence';

describe('sequence activation invariants', () => {
  it('uses a stable key for a participant message interval', () => {
    expect(sequenceActivationKey({ participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-5' }))
      .toBe('api|msg-2|msg-5');
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

  it('rejects duplicate ranges but allows updating the same activation in place', () => {
    const sequence = createDiagramTemplate('sequence').sequence!;
    const current = sequence.activations![0];
    expect(sequenceActivationIssue(sequence, { ...current })).toBe('An activation with the same participant and message range already exists.');
    expect(sequenceActivationIssue(sequence, { ...current }, sequenceActivationKey(current))).toBeUndefined();
  });
});
