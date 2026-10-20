# ADR 0006: Local persistence and agent execution trace

- Status: Accepted
- Date: 2026-10-20

## Context

The first trace implementation used JSONL and reread the entire file on every UI refresh. It lacked per-turn correlation, query indexes, credential redaction, and a clear response to trace-write failures. The user's other Saga agent projects follow a stronger rule: persistent audit events are the source of truth; console logs, UI state, and live events are projections. Model and tool attempts must be tied to the owning turn and its outcome.

## Decision

- Keep the active diagram, revision counters, layout-request counter, and chat history in the local atomic state snapshot under `~/.architecture-diagram-studio`; support `ARCHITECTURE_DIAGRAM_DATA_DIR`.
- Store agent events in `agent-traces.sqlite` using Node.js `node:sqlite`, WAL, and indexes for session/time, trace sequence, and turn ID. Node.js 22.13+ is required; the built-in SQLite API remains experimental in this Node release line.
- Give each chat turn a stable `traceId` and `turnId`. Each event records its own ID, timestamp, session, trace/turn IDs, sequence, category, type, status, duration when available, provider/model, and structured data. MCP start and completion events share a trace ID.
- Persist SDK lifecycle and tool events for each active turn. Do not persist model reasoning content or ephemeral stream deltas.
- Redact credential-shaped fields before persistence. Payloads larger than 1 MiB are explicitly marked incomplete with a size and preview; they must not be represented as complete audit evidence.
- Do not silently swallow audit write failures. An MCP mutation must not begin if its start event cannot be saved. If an SDK event write fails during a Copilot turn, mark the turn as failed/incomplete instead of returning success.
- Import existing `agent-traces.jsonl` events once into SQLite, preserving event IDs and payloads where parseable.
- Expose recent events through a bounded, indexed API and show trace/turn IDs, status, provider/model, and duration in the Agent trace panel.
- Keep browser local storage as a UI/recovery cache. A live Copilot SDK Session object does not survive an Express restart.

## Consequences

Positive:
- Events can be filtered and ordered without rereading the full log.
- A reviewer can correlate a request, SDK events, diagram persistence, and MCP mutations using trace IDs.
- Credential-shaped fields are redacted, and incomplete payloads are labelled rather than silently truncated.
- Existing JSONL history is migrated rather than discarded.

Trade-offs:
- SQLite writes are synchronous; this suits the current local single-user workload but should be revisited if event volume or concurrency grows substantially.
- The active diagram/chat snapshot and trace ledger are separate stores, so they are not one cross-file transaction. If trace persistence fails after a diagram snapshot is committed, the request must surface an error and the trace may show an incomplete operation.
- Trace payloads may contain prompts, architecture details, and tool results. The local data directory must be treated as sensitive.
- The Copilot SDK session object remains in memory and is recreated after restart.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. Test ordering and trace filtering, credential redaction, one-time JSONL migration, malformed state handling, and trace-write failure. Then restart the API and verify diagram/chat recovery, and exercise both Copilot and VS Code MCP operations to confirm their events share trace IDs and record failures as well as successes.
