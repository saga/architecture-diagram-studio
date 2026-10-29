# ADR-0012: Native Diagram Extension Contracts Without a Parallel Model

- Status: Accepted; Copilot mutation guidance superseded by [ADR-0026](./0026-server-side-xml-first-copilot-editing.md)
- Date: 2026-10-23
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0013 — Studio-Owned Dagre/ELK Layout Is a Core Feature](./0013-studio-owned-layout-engines.md), [ADR-0018 — AI-First Native Draw.io Execution](./0018-ai-first-native-drawio-execution.md), [ADR-0009 — Centralized Draw.io XML Processing](./0009-centralized-drawio-xml-processing.md), [ADR-0010 — Unified Server-Side Copilot Intent Processing](./0010-unified-server-side-copilot-intent-processing.md)

 > **Execution policy update (retired):** The script-first decision in ADR-0018 is retired by [ADR-0026](./0026-server-side-xml-first-copilot-editing.md). Copilot edits native XML directly on the server. The no-shadow-model principle remains in force; automatic layout retains its existing implementation under ADR-0013 and is outside the migration.

## Context

ADR-0011 correctly removed the incomplete `DiagramDocument` model, the secondary SVG canvas, and the semantic layout/quality pipeline that operated on that model. This avoids duplicating the native Draw.io model and prevents unsupported cells or metadata from being lost.

The removal must not imply that geometry analysis, layout, style generation, quality checks, shape inspection, or richer native editing are permanently out of scope. Existing research documents (including `docs/drawio-shape-support-analysis.md`, `docs/diagram-design-implementation-plan.md`, and `docs/diagram-design-style-report.md`) contain useful design principles, but their old implementations and file references must not be copied directly into V2.

The missing piece is an explicit extension seam: future capabilities should be able to analyze the current native document and propose narrowly scoped operations without creating another authoritative graph model.

**Layout status update:** The statements in this ADR that describe layout as future work or say that no layout provider exists are superseded by [ADR-0013](./0013-studio-owned-layout-engines.md). Active V2 includes a Studio-owned Dagre/ELK planner at `v2/src/layout/native-layout.ts` and a first-class `auto_layout` Copilot operation. It uses transient facts derived from native mxCells, not the retired `DiagramDocument` layout pipeline.

## Decision

Keep the native Draw.io XML and editor as the only document model and canvas. The only active contract in `v2/src/model/native-diagram-capabilities.ts` is the read-only analysis interface consumed by spatial-region analysis. Do not introduce unused generic operation providers or registries.

### Contract boundaries

1. **Input context is native and revision-bound.** A capability receives the authoritative XML snapshot, its server-issued revision, active page ID, selected cell ID, and the lightweight native-cell target index. This context is transient and read-only, not a persisted graph model.
2. **Copilot mutations use native XML patches.** Every Copilot diagram mutation uses the server-side `edit_drawio_xml` path defined by ADR-0026. Do not reintroduce typed Copilot mutation operations, editor scripts, browser-side model dispatch, or proposal/acknowledgement variants.
3. **Automatic layout is separate.** Whole-page Dagre/ELK and the other installed Studio-owned layout engines use the typed geometry planner and native editor bridge defined by ADR-0013 and ADR-0021. This is not a Copilot XML-edit fallback and its algorithms are unchanged by ADR-0026.
4. **Analysis capabilities return findings only.** Quality, contrast, geometry and routing analyzers return native page/cell IDs and diagnostics. A finding does not itself block ordinary native editing or saving. A separately approved operation may define its own validation policy.
5. **No implicit semantic model.** Providers may use the shared XML DOM/schema utilities and derive temporary facts needed for one operation. They must not persist nodes/edges as a substitute for mxCells, assign a closed Studio-specific shape taxonomy to the document, or serialize a derived representation over the original XML.
6. **Capability availability is explicit.** A type or descriptor is not proof of an implemented capability. Expose a capability only when a concrete implementation, validation and tests exist.
7. **Keep the native editor as the renderer.** Copilot changes native cell properties through revision-bound XML patches; Studio layout changes only planned geometry through its native editor bridge. UI theme changes remain presentation-only and must not rewrite cell styles implicitly.

## How to reuse prior research

- **Whole-page automatic layout** uses the shared Dagre/ELK planner and typed `auto_layout` operation described by ADR-0013. It calculates positions against temporary native-cell facts and applies geometry/waypoints through the native bridge. Copilot performs grouping, routing, endpoint, shape and other diagram changes through focused revision-bound XML patches. Do not add a second mutation path for tasks that are not represented by a typed operation.
- **Quality and accessibility rules** belong in a read-only analysis provider that returns rule IDs, severity, page/cell IDs and evidence. Warnings are diagnostics unless a specific user-requested operation has an explicit validation policy.
- **Style tokens and style resolution** may help construct explicit `set_style` or future typed style operations. They must not be applied merely because the UI theme changes.
- **Shape and XML compatibility research** remains relevant to the shared schema and property inspector. Unknown stencils, wrapper elements and custom attributes remain legal native content; no closed shape registry is required for opening or basic editing.
- **Old SVG/React Flow implementation details, semantic layouts and `DiagramDocument` examples** are historical reference only. Do not port them directly into active V2.

## Consequences

- V2 remains small today while retaining a stable contract for future native operations and analysis.
- There is no generic capability registry. The installed spatial-region analyzer is a concrete read-only analysis implementation; the core layout path is implemented separately.
- Future capability work should not add an operation for every UI action. Use the single XML patch path for Copilot mutations, keep whole-page layout on the Studio-owned planner, and add focused tests for XML preservation, stale revisions, page scope and persistence.
