# ADR-0011: Native Draw.io Is the Only Diagram Model

- Status: Accepted
- Date: 2026-10-22
- Supersedes: the `DiagramDocument`-centric editing, layout and proposal flows in ADR-0005, ADR-0006 and ADR-0010 where they require a complete semantic projection.

## Context

Studio already embeds the native Draw.io editor and persists its complete XML. The additional `DiagramDocument` model duplicates only a subset of mxGraph: it cannot faithfully represent arbitrary cells, wrappers, custom attributes, custom shapes, page structure, nested cells or all style keys. The adapter between XML and this model is lossy by design. Requiring the projection to be complete before allowing any semantic operation blocks even simple edits, such as adding one node and one edge, because an unrelated native attribute or root-cell style is not projected.

Maintaining two graph models, import/export conversion, completeness checks, projection caches and XML reconciliation is more code than the product needs. A renamed projection or another adapter would preserve the same conceptual complexity.

## Decision

**Delete `DiagramDocument` from the active v2 architecture. Do not replace it with another persisted or parallel graph model.**

1. The native Draw.io model/XML is the only document representation used by the application, server, Copilot, persistence, revisions, snapshots and export.
2. The bundled Draw.io editor owns interactive editing, selection, undo/redo, geometry, styles and relationships. Use its native model for editor-side changes.
3. Workspace-side automation may use small, typed, allowlisted cell operations against the authoritative XML. Operations validate target IDs, cell kinds, parent/page, attributes and revision; they patch only the cells they touch and preserve all other XML verbatim. The model must not author arbitrary replacement XML.
4. Delete the `DiagramDocument` import/export projection, fixture model, semantic mutation pipeline, and layout/quality/template features that require that parallel representation. Do not rebuild their full behavior on a second custom graph abstraction.
5. Keep only small XML utilities that have direct value: schema validation, page/cell lookup, source-preserving patching, cell selection/property inspection, and revision/version management. These utilities operate on the native document and are not a second model.
6. A document being unfamiliar or containing unsupported cell attributes is not an edit blocker. Block only an operation whose own target, page, or patch cannot be validated safely.
7. Agent inspection must describe the native cells it actually inspected. It must not report a semantic completeness flag or infer that the file is unusable because a projection is incomplete.

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
- [x] Route supported edits through native Draw.io or typed, source-preserving native-cell operations.
- [x] Simplify App, workspace hydration/persistence and Agent tools so they carry the authoritative XML and revision, not a parallel document.
- [x] Remove semantic layout/quality/templates from the active UI/server path if they require the deleted model; do not retain them through a renamed duplicate abstraction.
- [ ] Test simple add-node/add-edge, rename, delete and move on native XML containing opaque cells and unknown attributes; assert unchanged cells/pages/metadata remain byte-identical.
- [ ] Test malformed XML and stale revisions are rejected without writing changes.
- [ ] Run typecheck, unit tests and build after the migration. Report actual results separately.

This ADR defines the end state. A commit must not claim the migration complete until the checklist is backed by code and tests.
