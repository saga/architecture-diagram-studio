# ADR 0005: Internal Copilot Diagram Intelligence and Governed Edits

- Status: Accepted
- Date: 2026-10-21
- Scope: Internal diagram analysis, workspace example retrieval, edit proposals, templates, semantic diffs and version recovery

## Context

V2 owns a semantic `DiagramDocument`, deterministic layout and quality operations, native Draw.io import/export, workspace retrieval, version snapshots and a Copilot SDK service. Diagram intelligence is an internal Studio capability and must not create a second externally registered MCP tool surface.

The agreed scope is F1–F11. Mermaid import and semantic conversion remain explicitly excluded.

## Decision

1. **F1 — Design references.** Internal Copilot tools provide focused guidance on the semantic model, Draw.io XML conventions, C4, sequence diagrams, layout profiles, templates and validation rules.
2. **F2 — Diagram inspection.** Inspect the active persisted semantic document, including bounded nodes, relationships, boundaries, layout and flow/sequence metadata.
3. **F3 — Quality evaluation.** Reuse the authoritative server-side quality evaluator; do not duplicate quality logic.
4. **F4 — Governed edits.** Generate non-persistent, revision-bound proposals. The Studio UI obtains explicit user confirmation; the server revalidates the current revision, semantic invariants, layout allowlist and quality regression before saving a new version.
5. **F5/F7 — Workspace examples.** Search bounded, workspace-local diagrams and documents as evidence for style and component choices. Reuse path guards and treat retrieved content as untrusted input.
6. **F6 — Composable workflow.** Support inspect → retrieve references/examples → propose → evaluate → user confirmation → apply → inspect/evaluate using small internal tools, without adding another workflow engine.
7. **F8 — Mermaid.** Deferred. Do not imply that Mermaid source is converted into the Studio semantic model.
8. **F9 — Templates.** Offer a small semantic template catalog for C4 context, service/queue/database and request sequence. Applying a template requires confirmation and creates a normal version snapshot.
9. **F10 — Version history.** List, semantically diff and restore versions as new revisions. Historical snapshots are not overwritten.
10. **F11 — Targeted edits.** Support bounded local node/relation operations preserving unaffected geometry. Reject ambiguous or unsupported edits.

## Architecture and safety

- The Studio server is authoritative for diagram state, layout, validation, quality, snapshots and persistence. UI and Copilot SDK tools reuse the same domain services.
- There is no standalone MCP server or externally registered MCP tool surface for workspace or diagram operations.
- All mutations require UI confirmation, a current semantic/XML revision, server-side validation, a quality gate and a new snapshot.
- Keep inputs/results bounded. Validate workspace paths, reject symlink escapes and treat project text as untrusted data. Do not add arbitrary shell execution or arbitrary filesystem writes.
- Preserve the single workspace configuration, semantic model and authoritative quality implementation.

## Alternatives considered

- **Expose diagram operations as standalone MCP tools:** rejected because no external integration surface was requested.
- **Copy a large third-party shape index:** rejected because foreign shape identifiers may not map to the Studio renderer.
- **Generate or mutate raw XML directly from the model:** rejected because it bypasses semantic metadata, validation, revision checks and versioning.
- **Duplicate domain operations inside Agent handlers:** rejected because UI and Agent behavior would drift.
- **Implement Mermaid conversion now:** rejected; it needs a separate parser and semantic-mapping design.

## Consequences

- Internal Copilot SDK tools provide references, inspection, quality assessment, example search, edit proposals, templates, semantic diffs, version listing and restore proposals.
- The UI is the confirmation surface; the model cannot independently commit a mutation.
- Mermaid import/conversion remains unsupported.
- A capability counts as implemented only when its tool, validation, persistence semantics, documentation and tests agree.
