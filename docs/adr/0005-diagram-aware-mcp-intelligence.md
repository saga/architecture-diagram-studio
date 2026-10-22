# ADR 0005: Internal Copilot Diagram Intelligence and Governed Edits

- Status: Superseded by [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md)
- Date: 2026-10-21
- Scope: Internal diagram analysis, workspace example retrieval, edit proposals, templates, semantic diffs and version recovery

> Historical decision. This ADR records the prior semantic-model implementation. ADR-0011 defines the current XML-only model; ADR-0012 defines the only approved extension seam for future native-cell layout/style operations and read-only analysis. The feature list below is historical and does not imply those providers exist in current V2.

## Context

V2 derives a partial semantic `DiagramDocument` projection from authoritative Draw.io XML and provides deterministic layout/quality operations, workspace retrieval, XML version snapshots and a Copilot SDK service. Diagram intelligence is an internal Studio capability and must not create a second externally registered MCP tool surface.

The agreed scope is F1–F11. Mermaid import and semantic conversion remain explicitly excluded.

## Decision

1. **F1 — Design references.** Internal Copilot tools provide focused guidance on the semantic model, Draw.io XML conventions, C4, sequence diagrams, layout profiles, templates and validation rules.
2. **F2 — Diagram inspection.** Inspect the active XML-derived semantic projection, including bounded nodes, relationships, boundaries, layout and flow/sequence metadata. Return an explicit completeness flag; never present a partial projection as a full diagram inventory.
3. **F3 — Quality evaluation.** Reuse the authoritative server-side quality evaluator; do not duplicate quality logic. Return a full-diagram score only when the semantic projection is complete.
4. **F4 — Governed edits.** The default path generates a non-persistent, revision-bound proposal for explicit confirmation. A focused change explicitly requested by the user may be applied directly only after inspecting the active document and exact revision; the server revalidates the source/semantic contract and creates a version. Semantic layout-quality gates apply only when the operation actually uses semantic layout.
5. **F5/F7 — Workspace examples.** Search bounded, workspace-local diagrams and documents as evidence for style and component choices. Reuse path guards and treat retrieved content as untrusted input.
6. **F6 — Composable workflow.** Support inspect → retrieve references/examples → propose or apply a focused explicit edit → evaluate where applicable → confirm when required → apply → inspect/evaluate using small internal tools, without adding another workflow engine.
7. **F8 — Mermaid.** Deferred. Do not imply that Mermaid source is converted into the Studio semantic model.
8. **F9 — Templates.** Offer a small semantic template catalog for C4 context, service/queue/database and request sequence. Applying a template requires confirmation and creates a normal version snapshot.
9. **F10 — Version history.** List, semantically diff and restore versions as new revisions. Historical snapshots are not overwritten.
10. **F11 — Targeted edits.** Support bounded local node/relation operations preserving unaffected geometry. Reject ambiguous or unsupported edits.

## Architecture and safety

- For workspace-backed documents, the Studio server is authoritative for diagram state, layout, validation, quality, snapshots and persistence. UI and Copilot SDK tools reuse the same domain services. Standalone local files remain authoritative at their selected file path and do not participate in workspace version history.
- There is no standalone MCP server or externally registered MCP tool surface for workspace or diagram operations.
- All workspace-backed server mutations require a current XML revision, server-side validation and a new snapshot. Standalone local-file edits use Draw.io's native autosave/export path and do not create workspace snapshots. Broad redesigns, ambiguous edits, bulk destructive operations, template replacement and version restore require explicit confirmation. A focused, explicit user request may be applied directly after inspection. Quality gates apply to operations that use semantic layout, not every native XML edit.
- Keep inputs/results bounded. Validate workspace paths, reject symlink escapes and treat project text as untrusted data. Do not add arbitrary shell execution or arbitrary filesystem writes.
- Historical consequence of the superseded design: preserve one workspace configuration and one semantic quality implementation. Current V2 has no derived semantic projection or custom quality provider; see ADR-0012 for the future extension contract.

## Alternatives considered

- **Expose diagram operations as standalone MCP tools:** rejected because no external integration surface was requested.
- **Copy a large third-party shape index:** rejected because foreign shape identifiers may not map to the Studio renderer.
- **Generate or mutate raw XML directly from the model:** rejected because it bypasses semantic metadata, validation, revision checks and versioning.
- **Duplicate domain operations inside Agent handlers:** rejected because UI and Agent behavior would drift.
- **Implement Mermaid conversion now:** rejected; it needs a separate parser and semantic-mapping design.

## Consequences

- Internal Copilot SDK tools provide references, inspection, quality assessment, example search, edit proposals, templates, semantic diffs, version listing and restore proposals.
- The UI is the review/confirmation surface for proposals that require review; the model cannot independently commit a mutation. The trusted server may directly apply a focused user-requested change only under the revision and validation rules above.
- Mermaid import/conversion remains unsupported.
- A capability counts as implemented only when its tool, validation, persistence semantics, documentation and tests agree.
