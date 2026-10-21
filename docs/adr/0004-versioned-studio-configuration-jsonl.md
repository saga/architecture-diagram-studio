# ADR 0004: Versioned server configuration in JSONL

- Status: Accepted
- Date: 2026-10-21

## Context

Layout algorithm availability and Copilot instructions need to be editable without changing source code. Configuration changes must be auditable and recoverable, and the requested persistence format is JSON Lines.

## Decision

The server owns Studio configuration. The settings page edits the supported layout algorithm allowlist and the shared Copilot system/task/plan-tool prompt sections. The server validates the allowlist against algorithms implemented by the application and validates prompt values and length.

Each successful save appends a complete configuration snapshot plus revision ID, timestamp, actor, and change summary to `studio-config-history.jsonl` under `STUDIO_DATA_DIR`. The latest valid line is the active configuration; historical lines are not overwritten. Reads expose revision metadata for the settings UI. The shared Copilot system-message builder injects the saved prompt sections for both newly created and resumed sessions.

## Consequences and limitations

- Configuration is server-authoritative and versioned independently of diagram document versions.
- JSONL is append-only and human-inspectable; it is not a transactional database.
- This first iteration exposes the shared system/task/plan-tool prompt sections. Any additional prompt literals introduced in future Copilot flows must be promoted into this configuration schema before claiming every prompt path is configurable.
- Algorithm selection is restricted to implementations shipped in the application. Removing an algorithm from the allowlist blocks new server layout requests using it but does not rewrite existing diagrams.
- Version restoration and multi-process write locking are not implemented in this iteration.
