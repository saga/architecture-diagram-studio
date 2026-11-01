import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AgentTraceRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  traceId?: string;
  turnId?: string;
  parentEventId?: string;
  sequence?: number;
  payloadComplete?: boolean;
  category?: string;
  type: string;
  status?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  data: unknown;
}

const dataDirectory = process.env.ARCHITECTURE_DIAGRAM_DATA_DIR?.trim()
  || path.join(homedir(), '.architecture-diagram-studio');
const databasePath = path.join(dataDirectory, 'agent-traces.sqlite');
const legacyPath = path.join(dataDirectory, 'agent-traces.jsonl');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const database = new DatabaseSync(databasePath);
database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
database.exec(`
  CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    session_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    turn_id TEXT,
    parent_event_id TEXT,
    sequence INTEGER NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT,
    duration_ms INTEGER,
    provider TEXT,
    model TEXT,
    data_json TEXT NOT NULL,
    payload_complete INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_trace_session_time ON trace_events(session_id,timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_trace_id_sequence ON trace_events(trace_id,sequence);
  CREATE INDEX IF NOT EXISTS idx_trace_turn ON trace_events(turn_id,sequence);
  CREATE TABLE IF NOT EXISTS trace_migrations(name TEXT PRIMARY KEY,completed_at TEXT NOT NULL);
`);
try { chmodSync(databasePath, 0o600); } catch { /* File permissions differ by platform. */ }

function redact(value: unknown, key = ''): unknown {
  if (/authorization|(^|[_-])token($|[_-])|api[_-]?key|password|secret|cookie|credential/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

function migrateLegacyTrace(): void {
  if (database.prepare('SELECT name FROM trace_migrations WHERE name=?').get('jsonl-v1')) return;
  database.exec('BEGIN IMMEDIATE');
  try {
    if (existsSync(legacyPath)) {
      const insert = database.prepare(`INSERT OR IGNORE INTO trace_events
        (id,timestamp,session_id,trace_id,turn_id,parent_event_id,sequence,category,type,status,duration_ms,provider,model,data_json,payload_complete)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
      for (const line of readFileSync(legacyPath, 'utf8').split('\n').filter(Boolean)) {
        try {
          const item = JSON.parse(line) as Partial<AgentTraceRecord>;
          if (typeof item.id !== 'string' || typeof item.timestamp !== 'string' || typeof item.sessionId !== 'string' || typeof item.type !== 'string') continue;
          insert.run(item.id,item.timestamp,item.sessionId,item.traceId??item.sessionId,item.turnId??null,item.parentEventId??null,0,item.category??'legacy',item.type,item.status??null,item.durationMs??null,item.provider??null,item.model??null,JSON.stringify(redact(item.data??null)));
        } catch { /* A malformed legacy line is skipped, never used to erase valid rows. */ }
      }
    }
    database.prepare('INSERT INTO trace_migrations(name,completed_at) VALUES(?,?)').run('jsonl-v1',new Date().toISOString());
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
migrateLegacyTrace();

export function appendAgentTrace(record: AgentTraceRecord): void {
  const traceId = record.traceId ?? record.sessionId;
  const data = redact(record.data ?? null);
  const serialized = JSON.stringify(data);
  const maxBytes = 1024 * 1024;
  const payloadComplete = Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  const storedData = payloadComplete ? serialized : JSON.stringify({
    payloadOmitted: true,
    reason: 'event payload exceeded the 1 MiB audit record limit',
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
    preview: serialized.slice(0, 4000),
  });
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS next_sequence FROM trace_events WHERE trace_id=?').get(traceId) as {next_sequence:number};
    database.prepare(`INSERT INTO trace_events
      (id,timestamp,session_id,trace_id,turn_id,parent_event_id,sequence,category,type,status,duration_ms,provider,model,data_json,payload_complete)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(record.id,record.timestamp,record.sessionId,traceId,record.turnId??null,record.parentEventId??null,row.next_sequence,record.category??'agent',record.type,record.status??null,record.durationMs??null,record.provider??null,record.model??null,storedData,payloadComplete?1:0);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function readAgentTraces(sessionIds: string[], limit = 200, traceId?: string): AgentTraceRecord[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (sessionIds.length) {
    filters.push('session_id IN (' + sessionIds.map(() => '?').join(',') + ')');
    params.push(...sessionIds);
  }
  if (traceId) { filters.push('trace_id=?'); params.push(traceId); }
  params.push(safeLimit);
  const rows = database.prepare(`SELECT id,timestamp,session_id,trace_id,turn_id,parent_event_id,sequence,category,type,status,duration_ms,provider,model,data_json,payload_complete
    FROM trace_events ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
    ORDER BY timestamp DESC,rowid DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
  return rows.reverse().map((row) => ({
    id:String(row.id),timestamp:String(row.timestamp),sessionId:String(row.session_id),traceId:String(row.trace_id),
    ...(row.turn_id ? {turnId:String(row.turn_id)} : {}),...(row.parent_event_id ? {parentEventId:String(row.parent_event_id)} : {}),
    sequence:Number(row.sequence),payloadComplete:Number(row.payload_complete)===1,
    category:String(row.category),type:String(row.type),...(row.status ? {status:String(row.status)} : {}),
    ...(row.duration_ms !== null ? {durationMs:Number(row.duration_ms)} : {}),
    ...(row.provider ? {provider:String(row.provider)} : {}),...(row.model ? {model:String(row.model)} : {}),
    data:JSON.parse(String(row.data_json)),
  }));
}
