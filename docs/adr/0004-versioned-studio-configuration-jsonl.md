# ADR 0004: Versioned server configuration in JSONL

- Status: Accepted
- Date: 2026-10-21

## Context

Layout algorithm availability and Copilot instructions need to be editable without changing source code. Configuration changes must be auditable and recoverable, and the requested persistence format is JSON Lines.

## Decision

The server owns Studio configuration. The settings page edits the supported layout algorithm allowlist and every natural-language instruction supplied by the application to Copilot: system role, task planning, plan-tool usage, behavior/safety constraints, workspace-context rules, supported-command instructions, tool description, and tool result. The server validates the allowlist against algorithms implemented by the application and validates prompt values and length.

Each successful save appends a complete configuration snapshot plus revision ID, timestamp, actor, and change summary to `studio-config-history.jsonl` under `STUDIO_DATA_DIR`. The latest valid line is the active configuration; historical lines are not overwritten. Reads expose revision metadata for the settings UI. The server builds the system message and structured-tool description/result from the saved prompt configuration. SDK session identity is scoped to the configuration revision so the next request after a save does not silently continue with stale system instructions. Older three-prompt records are migrated in memory by filling newly introduced keys from defaults; malformed trailing JSONL records are skipped in favor of the latest valid record.

## Consequences and limitations

- Configuration is server-authoritative and versioned independently of diagram document versions.
- JSONL is append-only and human-inspectable; it is not a transactional database.
- Structured tool schema constraints (for example the command enum and maximum command count) remain code-enforced validation rather than editable natural-language prompts. Any new natural-language instruction added to a Copilot flow must be promoted into the configuration schema.
- Algorithm selection is restricted to implementations shipped in the application. Removing an algorithm from the allowlist blocks new server layout requests using it but does not rewrite existing diagrams.
- Version restoration and multi-process write locking are not implemented in this iteration.
