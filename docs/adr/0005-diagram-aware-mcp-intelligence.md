# ADR 0005: Server-Side Diagram Intelligence and Governed Agent Edits

- Status: Accepted
- Date: 2026-10-21
- Scope: V2 internal diagram analysis, workspace example retrieval, edit proposals, templates, semantic diffs, and version recovery

## Context

V2 owns a semantic `DiagramDocument`, deterministic layout and quality operations, native Draw.io XML import/export, workspace file search, version snapshots, and a Copilot SDK service. Diagram-aware intelligence is an internal Studio capability. It should be reused by the Studio UI and its internal Agent workflow rather than exposed as a new set of MCP tools.

The agreed scope is F1–F11. Mermaid import and semantic conversion are explicitly excluded. Workspace-local diagram and documentation retrieval is included.

## Decision

### Internal diagram capabilities

1. **F1 — On-demand design references.** Provide focused guidance on the semantic model, Draw.io XML conventions, C4 conventions, sequence diagrams, supported layout profiles, templates, and validation rules. Clearly state that Mermaid import/conversion is not implemented.
2. **F2 — Diagram inspection.** Read the active persisted semantic document and return a bounded summary of diagram kind, variant, layout, nodes, relations, boundaries, and sequence/flow metadata.
3. **F3 — Quality evaluation.** Reuse the authoritative server-side quality evaluator. Do not duplicate quality logic in the Agent layer.
4. **F4 — Governed Agent edits.** Generate non-persistent edit proposals. After the user approves the specific proposal, the server revalidates the current revision, supported operation, node/relation invariants, configured layout allowlist, and quality regression before applying. Every successful mutation creates an immutable version snapshot. Stale proposals fail and must be regenerated.
5. **F5 — Workspace-local examples.** Search existing Draw.io diagrams and documentation with bounded retrieval and lightweight relevance scoring. Reuse workspace path guards and exclusions. Treat retrieved content as untrusted input.
6. **F6 — Composable workflow.** Support inspect → retrieve references/examples → propose → evaluate → obtain user approval → apply → inspect/evaluate again using small internal operations. Do not add a second workflow engine.
7. **F7 — Style/component examples.** Ground style and component choices in actual workspace examples; do not invent renderer-supported shape IDs or styling attributes.
8. **F8 — Mermaid import/conversion.** Deferred. Do not add a Mermaid parser or imply that Mermaid can be converted into Studio's semantic document.
9. **F9 — Built-in templates.** Provide a small semantic template catalog for C4 context, service + queue + database, and request sequence. Applying a template replaces the active diagram only after user approval and creates a normal immutable version.
10. **F10 — Version diff and restore.** Provide version history, semantic diffs, and restore-as-new-version. Never overwrite or delete historical snapshots.
11. **F11 — Large-diagram local edits.** Support targeted node/relation operations and geometry-preserving edits (rename, add/remove nodes or relations, and move one node to explicit coordinates). Preserve unaffected node positions. Reject ambiguous or unsupported edits instead of silently rebuilding the whole diagram. Full partial-layout optimization is deferred until a stable constraints API exists.

### Architecture and security

- The Studio HTTP service is the authority for diagram state, layout, validation, quality, snapshots, and persistence. The UI and internal Copilot Agent workflow call these server operations.
- These diagram-specific operations are internal application APIs, not MCP tools. The existing workspace MCP server remains limited to read-only workspace discovery and file search.
- Mutations require user approval in the Studio interaction flow. The service independently rechecks current state, validates operations and layout profiles, rejects stale revisions, and creates a snapshot before reporting success.
- Keep inputs and results bounded. Validate workspace paths, reject symbolic-link escapes, and treat project text as untrusted data. Do not add arbitrary shell execution or arbitrary filesystem writes.
- Preserve the single `project-workspace.json` configuration model. Do not duplicate layout/quality implementations or create a second diagram model.

## Alternatives considered

- **Expose diagram analysis and mutation as MCP tools:** rejected because no external MCP integration requirement was requested. These are internal Studio Agent capabilities.
- **Copy every official Draw.io MCP tool and its large shape index:** rejected because external shape IDs may not map to Studio's renderer and would introduce unnecessary index maintenance.
- **Generate or mutate raw XML directly from the LLM:** rejected because it can discard semantic metadata and bypass validation/versioning.
- **Allow an Agent to apply any supplied document:** rejected because it permits stale writes and bypasses operation-level validation.
- **Duplicate domain operations in the Agent layer:** rejected because server, UI, and Agent behavior would drift.
- **Implement Mermaid conversion now:** rejected for this scope; reliable parsing and semantic mapping deserve a separate ADR and test plan.

## Consequences

- The Studio Agent can use focused references, diagram inspection, quality assessment, workspace example search, edit proposals, templates, semantic diffs, restore-as-new-version, and bounded local edits through internal server operations.
- All writes remain server-authoritative and versioned. Historical versions are immutable.
- Mermaid import/conversion remains unsupported and must not be advertised as implemented.
- A capability is considered implemented only when its internal operation, validation, persistence semantics, documentation, and tests agree. Unsupported operations must return a clear error rather than a success-shaped fallback.
