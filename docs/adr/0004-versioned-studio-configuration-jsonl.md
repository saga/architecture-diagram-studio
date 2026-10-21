# ADR 0004: Versioned server configuration in JSONL

- Status: Accepted
- Date: 2026-10-21

## Context

Layout algorithm availability, Copilot instructions, model selection, and reasoning effort need to be editable without changing source code. Every configuration change must be auditable, recoverable by selecting a prior snapshot, and stored as JSON Lines.

## Decision

The server owns the complete Studio runtime configuration: supported layout algorithm allowlist, all natural-language Copilot instructions (system role, task planning, plan-tool usage, behavior/safety constraints, workspace-context rules, supported-command instructions, tool description, and tool result), model ID, and reasoning effort. The settings UI may update one section at a time, but the server merges the change into the current configuration and persists a complete snapshot. The server validates the allowlist against algorithms implemented by the application, validates prompt values and length, and validates model ID and reasoning-effort shape.

Each successful save appends a complete configuration snapshot plus revision ID, timestamp, actor, and change summary to `studio-config-history.jsonl` under `STUDIO_DATA_DIR`. The snapshot includes layout algorithms, every prompt, model ID, and reasoning effort. The latest valid record is active; history is not overwritten. Older records are migrated in memory by filling missing fields from defaults. The server builds the system message and structured-tool description/result from the saved prompt configuration. SDK session identity is scoped to the configuration revision, model, and requested reasoning effort. When a session is superseded, the server waits for its active turn and disconnects it before replacement.

## Consequences and limitations

- Configuration is server-authoritative and versioned independently of diagram document versions.
- JSONL is append-only and human-inspectable; it is not a transactional database.
- Structured tool schema constraints (for example the command enum and maximum command count) remain code-enforced validation rather than editable natural-language prompts. Any new natural-language instruction added to a Copilot flow must be promoted into the configuration schema.
- Algorithm selection is restricted to implementations shipped in the application. Removing an algorithm from the allowlist blocks new server layout requests using it but does not rewrite existing diagrams.
- Configuration history is append-only, but restoring a previous revision through the UI is not implemented yet. Multi-process write locking is also not implemented; run one Studio server per `STUDIO_DATA_DIR`.
