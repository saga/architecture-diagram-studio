import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDirectory = '';

beforeEach(() => {
  dataDirectory = mkdtempSync(path.join(tmpdir(), 'diagram-studio-trace-'));
  process.env.ARCHITECTURE_DIAGRAM_DATA_DIR = dataDirectory;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.ARCHITECTURE_DIAGRAM_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('SQLite trace ledger', () => {
  it('orders and filters events by trace ID', async () => {
    const ledger = await import('./trace-ledger.js');
    ledger.appendAgentTrace({ id: 'event-1', timestamp: '2026-10-20T10:00:00.000Z', sessionId: 'chat-1', traceId: 'turn-1', type: 'turn.started', data: { prompt: 'draw a service', token: 'example-value' } });
    ledger.appendAgentTrace({ id: 'event-2', timestamp: '2026-10-20T10:00:01.000Z', sessionId: 'chat-1', traceId: 'turn-1', type: 'turn.completed', data: { result: 'done' } });
    const events = ledger.readAgentTraces(['chat-1'], 20, 'turn-1');
    expect(events.map((event) => event.type)).toEqual(['turn.started', 'turn.completed']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(ledger.readAgentTraces(['chat-1'], 20, 'another-turn')).toEqual([]);
  });
});
