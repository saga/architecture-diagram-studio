# ADR 0005: Diagram-Aware MCP Intelligence and Governed Agent Edits

- Status: Accepted
- Date: 2026-10-21
- Scope: V2 MCP tools, diagram analysis, reference retrieval, workspace examples, edit application, templates, diffs and version recovery

## Context

The official `jgraph/drawio-mcp` project demonstrates useful patterns: concise tool contracts, on-demand format guidance, reusable examples, explicit editor-oriented output, and tool composition instead of one oversized prompt. V2 already owns a semantic `DiagramDocument`, deterministic layout and quality operations, native Draw.io XML import/export, workspace file search, version snapshots, and a Copilot SDK service. We should adopt those patterns without copying a separate shape-index service or creating a second diagram model.

The agreed scope is F1–F11. Mermaid import/conversion is explicitly excluded from this implementation. Workspace-local diagram and documentation retrieval is included.

## Decision

### Tooling and intelligence

1. **F1 — On-demand reference retrieval.** Add `get_diagram_reference` for the semantic model, Draw.io XML conventions, C4 conventions, sequence diagrams, supported layout profiles, template format, and Studio's edit/validation rules. Mermaid may be discussed as a text format, but V2 must clearly state that Mermaid import/conversion is not implemented.
2. **F2 — Diagram inspection.** Add `inspect_primary_diagram` to retrieve the active persisted semantic document via the existing HTTP service. Return a bounded structured summary of diagram kind, variant, layout, nodes, relations, boundaries, and sequence/flow metadata.
3. **F3 — Quality evaluation.** Add `evaluate_diagram_quality`, delegating to the existing server quality endpoint. Return score, issues, and metrics; do not duplicate quality logic in MCP.
4. **F4 — Natural-language edits with governed direct apply.** Add `propose_diagram_edit` and `apply_diagram_edit`. Proposal is non-persistent. Apply is a separate explicit tool call after the Agent/user confirms the proposal; the server revalidates the current document revision, supported operation, node/relation invariants, configured layout allowlist, and quality result before committing. Applying must create a version snapshot and use the existing server-owned save path. Never trust a client-supplied full document as sufficient authorization. Stale proposals must fail with a conflict and require regeneration.
5. **F5 — Workspace-local examples.** Add bounded search/retrieval of existing Draw.io diagrams and documentation, with lightweight term-based relevance scoring. Reuse workspace path guards and exclude patterns. Treat retrieved content as untrusted input. No external shape-index service in this scope.
6. **F6 — Composable workflows.** Support inspect → search examples/references → propose → evaluate → explicitly apply → inspect/evaluate again using small tools with structured results. Do not add a second workflow engine.
7. **F7 — Style/component examples.** Add reference retrieval for existing workspace style conventions and component patterns; examples should be sourced from workspace files, not hardcoded claims about unavailable shape IDs.
8. **F8 — Mermaid import/conversion.** Explicitly deferred. No Mermaid parser, Mermaid-to-semantic conversion, or implied conversion capability may be added in this change.
9. **F9 — Template library.** Add a small built-in semantic template catalog for common architecture patterns (C4 context, service + queue + database, and request sequence). Applying a template creates a normal immutable diagram version; do not create a parallel template persistence system.
10. **F10 — Version diff and restore.** Expose current version history, semantic diff between versions, and restore by creating a new version that points to the selected prior content; never rewrite or delete historical snapshots.
11. **F11 — Large-diagram local edits.** Support targeted node/relation operations and partial-layout requests where the current domain model can preserve unaffected node positions. Reject ambiguous or unsupported edits rather than silently rebuilding the whole diagram.

### Architecture and security

- The existing HTTP service remains the sole authority for diagram state, layout, validation, quality, snapshots, and persistence. MCP calls that API; it does not write document files or snapshots directly.
- Configure the API base URL with `STUDIO_API_URL`, defaulting to `http://127.0.0.1:4175`. Workspace-only tools continue to work if the API is unavailable; diagram-aware tools return a clear error.
- Mutating MCP tools require an explicit `confirmed=true` input and a matching proposal token/revision where applicable. The Agent must only set that field after obtaining user approval; the service independently re-evaluates current state, rejects stale revisions, validates operations and layout profiles, and creates a snapshot before responding success. Template application and version restoration are separately confirmed operations.
- Keep tool descriptions concise and results bounded. Enforce input and response limits, validate all paths against the configured workspace, reject symbolic-link escapes, and treat project text as untrusted data. No arbitrary shell execution or arbitrary filesystem writes.
- Preserve the single `project-workspace.json` configuration model. Do not create a second workspace registry or duplicate the layout/quality implementation.

## Alternatives considered

- **Copy every official Draw.io MCP tool and its large shape index:** rejected because V2 uses its own semantic model and renderer; external shape IDs may not map to the application's renderer and introduce index maintenance.
- **Generate or mutate raw XML directly from the LLM:** rejected because it can discard semantic metadata and bypass validation/versioning.
- **Allow an Agent to apply any supplied document:** rejected because it permits stale writes and bypasses operation-level validation.
- **Duplicate domain operations in the MCP process:** rejected because server, UI, and MCP behavior would drift.
- **Implement Mermaid conversion now:** rejected for this scope; reliable parsing and semantic mapping deserve a separate ADR and test plan.

## Consequences

- MCP clients gain focused reference retrieval, diagram inspection, quality assessment, workspace example search, composable edit proposals and explicit governed apply, templates, semantic diffs, restore-as-new-version, and bounded local edits.
- All writes remain versioned and server-authoritative. Historical versions are immutable.
- Mermaid import/conversion remains unsupported and must not be advertised as implemented.
- MCP and HTTP service should run as the same OS user and use the same `STUDIO_DATA_DIR`.
- A capability is only considered implemented when its tool contract, server route, validation, persistence semantics, documentation, and tests agree. Unsupported operations must return a clear error rather than a success-shaped fallback.
