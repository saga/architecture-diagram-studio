import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { appendAgentTrace, readAgentTraces } from './trace-ledger.js';
export { appendAgentTrace, readAgentTraces } from './trace-ledger.js';
export type { AgentTraceRecord } from './trace-ledger.js';
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


const DATA_DIRECTORY = process.env.ARCHITECTURE_DIAGRAM_DATA_DIR?.trim()
  || path.join(homedir(), '.architecture-diagram-studio');
const STORE_FILE = path.join(DATA_DIRECTORY, 'studio-state.json');

function ensureDataDirectory(): void {
  mkdirSync(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
}

export function loadStudioStore(): StudioStore {
  const fallback: StudioStore = { version: 1, diagram: null, revision: 0, layoutRequestId: 0, chats: {} };
  try {
    if (!existsSync(STORE_FILE)) return fallback;
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Partial<StudioStore>;
    if (parsed.version !== 1 || !parsed.chats || typeof parsed.chats !== 'object') throw new Error('Persisted Studio state has an unsupported format; refusing to start with an empty state.');
    return {
      version: 1,
      diagram: parsed.diagram ?? null,
      revision: Number.isSafeInteger(parsed.revision) ? Number(parsed.revision) : 0,
      layoutRequestId: Number.isSafeInteger(parsed.layoutRequestId) ? Number(parsed.layoutRequestId) : 0,
      chats: parsed.chats,
    };
  } catch (error) {
    console.error('[architecture-diagram-studio] Could not read persisted state:', error);
    throw new Error('Persisted Studio state could not be read. The original file was preserved; refusing to start with an empty diagram.');
  }
}

/** Atomically replace the state snapshot. Agent events live in the indexed SQLite ledger. */
export function saveStudioStore(store: StudioStore): void {
  ensureDataDirectory();
  const temporaryFile = STORE_FILE + '.' + process.pid + '.tmp';
  writeFileSync(temporaryFile, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  renameSync(temporaryFile, STORE_FILE);
}
