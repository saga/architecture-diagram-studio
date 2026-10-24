# ADR-0011: Native Draw.io Is the Only Diagram Model

- Status: Accepted
- Date: 2026-10-22

> **Layout decision update:** Layout-specific removal statements in this ADR are superseded by [ADR-0013 — Studio-Owned Dagre/ELK Layout Is a Core Feature](./0013-studio-owned-layout-engines.md). The single native Draw.io model decision remains in force; only the implementation of layout capability is restored.
>
> **Copilot execution update:** The original typed-operation allowlist in Decision #3 and the migration checklist is superseded by [ADR-0018 — AI-First Native Draw.io Execution](./0018-ai-first-native-drawio-execution.md). Typed operations remain convenience shortcuts for common edits; `run_drawio_script` is the full-capability path. The native XML source-of-truth and no-replacement-XML constraints remain in force.
- Supersedes: the `DiagramDocument`-centric editing, layout and proposal flows in ADR-0005, ADR-0006 and ADR-0010 where they require a complete semantic projection.

## Context

Studio already embeds the native Draw.io editor and persists its complete XML. The additional `DiagramDocument` model duplicates only a subset of mxGraph: it cannot faithfully represent arbitrary cells, wrappers, custom attributes, custom shapes, page structure, nested cells or all style keys. The adapter between XML and this model is lossy by design. Requiring the projection to be complete before allowing any semantic operation blocks even simple edits, such as adding one node and one edge, because an unrelated native attribute or root-cell style is not projected.

Maintaining two graph models, import/export conversion, completeness checks, projection caches and XML reconciliation is more code than the product needs. A renamed projection or another adapter would preserve the same conceptual complexity.

## Decision

**Delete `DiagramDocument` from the active v2 architecture. Do not replace it with another persisted or parallel graph model.**

1. The native Draw.io model/XML is the only document representation used by the application, server, Copilot, persistence, revisions, snapshots and export.
2. The bundled Draw.io editor owns interactive editing, selection, undo/redo, geometry, styles and relationships. Use its native model for editor-side changes.
3. Copilot uses typed native-cell operations for common deterministic edits and `run_drawio_script` for direct access to the live Draw.io API. Typed operations are convenience shortcuts rather than a capability ceiling. The model must not author arbitrary replacement XML. Because Draw.io owns serialization, an edit may normalize XML formatting or attribute order; unrelated cells, relationships, pages, custom attributes and styles must remain present, but byte-for-byte identity after an edit is not promised.
4. Delete the `DiagramDocument` import/export projection, fixture model, semantic mutation pipeline, and layout/quality/template features that require that parallel representation. Do not rebuild their full behavior on a second custom graph abstraction.
5. Keep only small XML utilities that have direct value: schema validation, page/cell lookup, native-cell target/property inspection, and revision/version management. Do not retain a parallel source-patching subsystem to preserve lexical formatting when edits are executed and serialized by the native Draw.io editor.
6. A document being unfamiliar or containing unsupported cell attributes is not an edit blocker. Reject only an operation whose target, page, or requested mutation cannot be validated safely.
7. Agent inspection must describe the native cells it actually inspected. It must not report a semantic completeness flag or infer that the file is unusable because a projection is incomplete.

## Extension interface

ADR-0012 defines the allowed way to add future layout, style, structural-edit and quality-analysis capabilities without recreating a parallel graph model. The extension types are contracts only; they do not restore the retired semantic pipeline or imply that a provider is installed.

## Consequences

- There is one source of truth and no XML-to-`DiagramDocument`-to-XML round trip for editing.
- General Draw.io compatibility no longer depends on Studio's list of recognized roles, relation kinds, stencils or layout hints.
- Semantic C4/sequence classification and algorithms that only work over `DiagramDocument` are removed rather than maintained as a second subsystem.
- Existing architecture/layout/quality features that depend on `DiagramDocument` are intentionally retired unless reimplemented directly against native cells with a clear, concrete use case.
- The UI and Agent should fail closed only for invalid XML, stale revisions, ambiguous cell targets or an unsafe specific operation—not for unrelated unknown cell data.

## Migration and acceptance criteria

- [x] Remove `DiagramDocument` and its semantic type definitions from active v2 runtime code.
- [x] Remove runtime use of `fromDrawioXml` / `toDrawioXml` as the editing or persistence path.
- [x] Remove `projectionComplete` as a gate or Agent instruction for ordinary native cell edits.
- [x] Route common edits through typed native-cell operations and broader native API edits through the isolated `run_drawio_script` path, both executed by the bundled Draw.io editor and acknowledged through native XML persistence.
- [x] Simplify App, workspace hydration/persistence and Agent tools so they carry the authoritative XML and revision, not a parallel document.
- [x] Remove semantic layout/quality/templates from the active UI/server path if they require the deleted model; do not retain them through a renamed duplicate abstraction.
- [x] Add E2E coverage for add-node/add-edge, rename, delete and move with opaque XML attributes; verify unrelated cells, relationships and page metadata remain intact. Draw.io may normalize serialized XML formatting after edits, so tests assert preservation of content rather than byte-identical XML.
- [x] Add E2E coverage proving malformed XML and stale revisions are rejected without writing changes (`v2/e2e/04-history-io.spec.ts`).
- [x] Typecheck, unit tests and production build pass in GitHub Actions for the current migration branch; report end-to-end status separately until its latest run is green.

This ADR defines the end state. A commit must not claim the migration complete until the checklist is backed by code and tests.
