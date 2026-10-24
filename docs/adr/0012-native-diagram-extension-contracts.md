# ADR-0012: Native Diagram Extension Contracts Without a Parallel Model

- Status: Accepted
- Date: 2026-10-23
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0013 — Studio-Owned Dagre/ELK Layout Is a Core Feature](./0013-studio-owned-layout-engines.md), [ADR-0018 — AI-First Native Draw.io Execution](./0018-ai-first-native-drawio-execution.md), [ADR-0009 — Centralized Draw.io XML Processing](./0009-centralized-drawio-xml-processing.md), [ADR-0010 — Unified Server-Side Copilot Intent Processing](./0010-unified-server-side-copilot-intent-processing.md)

> **Execution policy update:** ADR-0018 supersedes any interpretation of this ADR that treats `run_drawio_script` as only a fallback for gaps in the typed vocabulary. The script tool is the primary full-capability native-editor path; typed operations and `auto_layout` remain validated shortcuts for common deterministic workflows. The no-shadow-model, current-revision, native bridge, XML acknowledgement and persistence contracts below remain in force.

## Context

ADR-0011 correctly removed the incomplete `DiagramDocument` model, the secondary SVG canvas, and the semantic layout/quality pipeline that operated on that model. This avoids duplicating the native Draw.io model and prevents unsupported cells or metadata from being lost.

The removal must not imply that geometry analysis, layout, style generation, quality checks, shape inspection, or richer native editing are permanently out of scope. Existing research documents (including `docs/drawio-shape-support-analysis.md`, `docs/diagram-design-implementation-plan.md`, and `docs/diagram-design-style-report.md`) contain useful design principles, but their old implementations and file references must not be copied directly into V2.

The missing piece is an explicit extension seam: future capabilities should be able to analyze the current native document and propose narrowly scoped operations without creating another authoritative graph model.

**Layout status update:** The statements in this ADR that describe layout as future work or say that no layout provider exists are superseded by [ADR-0013](./0013-studio-owned-layout-engines.md). Active V2 includes a Studio-owned Dagre/ELK planner at `v2/src/layout/native-layout.ts` and a first-class `auto_layout` Copilot operation. It uses transient facts derived from native mxCells, not the retired `DiagramDocument` layout pipeline.

## Decision

Keep the native Draw.io XML and editor as the only document model and canvas. Add shared TypeScript contracts for future capabilities in `v2/src/model/native-diagram-capabilities.ts`. These are extension interfaces only; they do not install a registry, enable new UI features, or claim that layout/quality providers already exist.

### Contract boundaries

1. **Input context is native and revision-bound.** A capability receives the authoritative XML snapshot, its server-issued revision, active page ID, selected cell ID, and the lightweight native-cell target index. This context is transient and read-only, not a persisted graph model.
2. **Mutation capabilities target the native editor.** Use shared typed operations as the fast path for common deterministic edits. Whole-page Dagre/ELK layout must use the typed, configurable `auto_layout` operation defined by ADR-0013; do not replace it with a Draw.io built-in layout action or hand-written layout script. `run_drawio_script` is the primary full-capability path for native editing outside those shortcuts and can use the actual Draw.io Graph/Model API. Scripts must not return replacement XML, write host files, or create a parallel graph model.
3. **Analysis capabilities return findings only.** Quality, contrast, geometry and routing analyzers return native page/cell IDs and diagnostics. A finding does not itself block ordinary native editing or saving. A separately approved operation may define its own validation policy.
4. **Execution remains centralized.** Server revision checks, the native editor bridge, acknowledgement handling, XML save path and versioning remain the execution boundary. The generic script operation lets AI use new native editor capabilities without adding each one to the shared operation union/schema. Script mutations are wrapped in a model update and active-page cells are snapshotted for rollback on script errors.
5. **No implicit semantic model.** Providers may use the shared XML DOM/schema utilities and derive temporary facts needed for one operation. They must not persist nodes/edges as a substitute for mxCells, assign a closed Studio-specific shape taxonomy to the document, or serialize a derived representation over the original XML.
6. **Capability availability is explicit.** A descriptor or future registry entry is not proof of an implemented capability. Only registered providers with concrete handlers, validation and tests may be exposed to the UI or Copilot.
7. **Keep the native editor as the renderer.** Styling or layout operations change explicitly targeted native cell properties through the typed operation bridge. UI theme changes remain presentation-only and must not rewrite cell styles implicitly.

## Intended extension flow

```mermaid
flowchart TD
  XML[("Authoritative mxfile XML")] --> Context["Read-only native context<br/>revision + active page + cell IDs"]
  Context --> Provider["Optional capability provider"]
  Provider --> Kind{"Result kind"}
  Kind -->|Analysis| Findings["Diagnostics / quality findings"]
  Kind -->|Mutation plan| Plan["Typed NativeEditOperation plan"]
  Plan --> Gate["Validate schema, target, page and base revision"]
  Gate -->|Valid| Bridge["Execute through native Draw.io bridge"]
  Gate -->|Invalid or stale| Reject["Reject without mutation"]
  Bridge --> Ack["Editor acknowledgement and saved XML"]
  Ack --> History["Workspace persistence and XML snapshot"]
```

## How to reuse prior research

- **Whole-page automatic layout** uses the shared Dagre/ELK planner and typed `auto_layout` operation described by ADR-0013. It calculates positions against temporary native-cell facts and applies geometry/waypoints through the native bridge. For other specific grouping, routing, endpoint and shape tasks that the typed contract does not cover, `run_drawio_script` can operate on real `mxCell` objects; it must not rebuild a complete graph document.
- **Quality and accessibility rules** belong in a read-only analysis provider that returns rule IDs, severity, page/cell IDs and evidence. Warnings are diagnostics unless a specific user-requested operation has an explicit validation policy.
- **Style tokens and style resolution** may help construct explicit `set_style` or future typed style operations. They must not be applied merely because the UI theme changes.
- **Shape and XML compatibility research** remains relevant to the shared schema and property inspector. Unknown stencils, wrapper elements and custom attributes remain legal native content; no closed shape registry is required for opening or basic editing.
- **Old SVG/React Flow implementation details, semantic layouts and `DiagramDocument` examples** are historical reference only. Do not port them directly into active V2.

## Consequences

- V2 remains small today while retaining a stable contract for future native operations and analysis.
- The current runtime has no generic capability registry or quality-analysis engine. The core Dagre/ELK layout path is implemented separately and is not a generic provider registry.
- Future capability work should not add an operation for every UI action. Keep the typed path for common deterministic workflows, use `run_drawio_script` for broader native runtime access, and keep whole-page layout on `auto_layout`. Add tests for shared helpers or concrete editor/API failure cases. Keep coverage for stale revisions, script/layout failure recovery, page scope, and XML/persistence acknowledgement.
