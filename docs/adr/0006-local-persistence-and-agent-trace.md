# ADR 0006: Local durable state and agent execution trace

- Status: Accepted
- Date: 2026-10-20

## Context

The active diagram and conversation were previously dependent on browser local storage and process memory. Restarting the Express service could lose the shared diagram state, and there was no durable record of agent tool calls or failures. This makes investigation and recovery difficult when Copilot or VS Code MCP performs multiple edits.

## Decision

- Persist the active Diagram Document, revision counters, layout-request counter, and per-chat message history in a local JSON state snapshot under `~/.architecture-diagram-studio` by default.
- Support `ARCHITECTURE_DIAGRAM_DATA_DIR` to select another local data directory.
- Write state snapshots through a temporary file and atomic rename; use owner-only file/directory permissions where supported.
- Append agent events to `agent-traces.jsonl`, including turn start/completion/failure, user and assistant messages, tool invocation arguments/results, and MCP diagram mutations.
- Expose read-only APIs for restoring chat history and querying recent trace events. Provide an in-product Agent trace panel that refreshes while open.
- Exclude reasoning-content events and ephemeral streaming deltas; retain operational events needed to reconstruct what the agent attempted and what tools returned.
- Keep the browser local-storage snapshot as a recovery cache. Do not claim that the Copilot SDK session object itself survives an Express process restart.

## Consequences

Positive:
- The current diagram and chat history survive browser refreshes and local API restarts.
- Agent operations can be reviewed after the fact, including tool arguments, outcomes, and failures.
- No database server or native dependency is required for the local single-user workflow.

Trade-offs:
- JSON snapshot writes are synchronous and appropriate for the current local single-user workload, but a database is preferable if write volume, concurrency, querying, or multi-project support grows.
- The append-only trace grows until the user archives or removes it; log rotation is a future operational improvement.
- Trace files can contain prompts, architecture details, and tool results. They must be treated as sensitive local data.
- This is not a multi-user transaction store, backup service, or durable restoration of live SDK session objects.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. Then restart the API and confirm the diagram and chat history restore; perform a Copilot request and an MCP mutation; inspect the Agent trace panel and `agent-traces.jsonl`.
