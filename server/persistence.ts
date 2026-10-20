import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DiagramDocument } from '../src/model/diagram.js';

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface StudioStore {
  version: 1;
  diagram: DiagramDocument | null;
  revision: number;
  layoutRequestId: number;
  chats: Record<string, StoredChatMessage[]>;
}

export interface AgentTraceRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  type: string;
  data: unknown;
}

const DATA_DIRECTORY = process.env.ARCHITECTURE_DIAGRAM_DATA_DIR?.trim()
  || path.join(homedir(), '.architecture-diagram-studio');
const STORE_FILE = path.join(DATA_DIRECTORY, 'studio-state.json');
const TRACE_FILE = path.join(DATA_DIRECTORY, 'agent-traces.jsonl');

function ensureDataDirectory(): void {
  mkdirSync(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
}

export function loadStudioStore(): StudioStore {
  const fallback: StudioStore = { version: 1, diagram: null, revision: 0, layoutRequestId: 0, chats: {} };
  try {
    if (!existsSync(STORE_FILE)) return fallback;
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Partial<StudioStore>;
    if (parsed.version !== 1 || !parsed.chats || typeof parsed.chats !== 'object') return fallback;
    return {
      version: 1,
      diagram: parsed.diagram ?? null,
      revision: Number.isSafeInteger(parsed.revision) ? Number(parsed.revision) : 0,
      layoutRequestId: Number.isSafeInteger(parsed.layoutRequestId) ? Number(parsed.layoutRequestId) : 0,
      chats: parsed.chats,
    };
  } catch (error) {
    console.error('[architecture-diagram-studio] Could not read persisted state:', error);
    return fallback;
  }
}

/** Atomically replace the state snapshot; the append-only trace is stored separately. */
export function saveStudioStore(store: StudioStore): void {
  ensureDataDirectory();
  const temporaryFile = STORE_FILE + '.' + process.pid + '.tmp';
  writeFileSync(temporaryFile, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryFile, STORE_FILE);
}

export function appendAgentTrace(record: AgentTraceRecord): void {
  ensureDataDirectory();
  appendFileSync(TRACE_FILE, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function readAgentTraces(sessionIds: string[], limit = 200): AgentTraceRecord[] {
  try {
    if (!existsSync(TRACE_FILE)) return [];
    const allowed = new Set(sessionIds);
    const lines = readFileSync(TRACE_FILE, 'utf8').split('\n').filter(Boolean);
    const records: AgentTraceRecord[] = [];
    for (let index = lines.length - 1; index >= 0 && records.length < limit; index -= 1) {
      try {
        const record = JSON.parse(lines[index]) as AgentTraceRecord;
        if (allowed.has(record.sessionId)) records.push(record);
      } catch {
        // Ignore an incomplete/corrupt line and continue reading earlier records.
      }
    }
    return records.reverse();
  } catch (error) {
    console.error('[architecture-diagram-studio] Could not read agent trace:', error);
    return [];
  }
}
