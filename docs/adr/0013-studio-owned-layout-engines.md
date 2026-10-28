# ADR-0013: Studio-Owned Layout Is a Core Feature

- Status: Accepted
- Date: 2026-10-23
- Supersedes: layout-removal statements in [ADR-0011](./0011-native-drawio-only-model.md) and [ADR-0012](./0012-native-diagram-extension-contracts.md) that treated native-cell layout as retired or only future work
- Related: [ADR-0009 — Centralized Draw.io XML Processing](./0009-centralized-drawio-xml-processing.md), [ADR-0025 — Relative Anchors and Mental-Map-Preserving Layout](./0025-relative-anchors-and-stability-preserving-layout.md)

## Context

Automatic layout is a primary user-facing feature of Architecture Diagram Studio, not an optional extension or cleanup candidate. The previous migration correctly removed the incomplete `DiagramDocument` editing model, but incorrectly removed the Dagre/ELK layout implementations and their npm dependencies along with that model. The remaining Draw.io `action: "layout"` path did not provide equivalent behavior or configuration.

The V2 architecture must keep native Draw.io XML and its editor as the only source of truth without sacrificing layout quality. A temporary projection of native cells for one calculation is not a second authoritative document model.

## Decision

### 1. Layout is a core product capability

- Dagre and ELK are supported layout engines in active V2; the shared native-cell layout path also supports Graphviz, MSAGL.js, Cytoscape.js and D3 through adapter modules. They are not legacy dependencies that may be removed as "unused" while auto layout remains in the product.
- Dagre provides directed layered placement with LR, RL, TB and BT directions.
- ELK provides the algorithms documented in [ADR-0021](./0021-expanded-native-layout-engines.md), with engine-specific direction, spacing, routing, iteration and seed support. Do not remove algorithms simply because a specific adapter does not use all shared settings.
- The Studio toolbar must expose the engine selection, applicable algorithm/direction settings, spacing and routing controls, as well as an explicit Auto layout action. Applicable algorithm parameters must remain configurable, not hard-coded in a one-off script.

### 2. Calculate with Studio-owned engines; do not call Draw.io's built-in layout

- Run layout in Studio code through the selected engine adapter (ELK, Dagre, Graphviz WASM, MSAGL.js, Cytoscape.js or D3). Never delegate the feature to Draw.io's `action: "layout"` or present Draw.io's built-in algorithms as equivalent.
- Read the active page's native XML and derive a short-lived layout input from native mxCells: IDs, vertex sizes, parent/layer, edge endpoints and geometry. Do not persist the projection, make it a second source of truth, or create a replacement XML exporter.
- Return a revision/page-bound layout plan containing node coordinates and connector waypoints. Apply that plan through the native Draw.io model transaction, then accept the editor's serialized native XML through the existing save/version flow.
- Automatic layout targets top-level vertices and edges in the active page's visible native layer. It discovers the graph root and layer cells by their parent relationships, preferring conventional IDs `0` and `1` when present; Draw.io files with generated/prefixed IDs are valid and must remain supported. If there is no conventional default layer, a sole visible layer is unambiguous. If the default layer has no eligible vertices and exactly one other visible layer contains layoutable content, the planner may target that layer and records the fallback in the plan/diagnostics; it refuses to guess between multiple populated layers. Other pages, unselected layers, nested group contents, cell styles, labels, wrappers, shapes and unknown XML attributes are not rebuilt or implicitly rearranged.

### 3. UI and Agent share one typed configuration and layout path

- `NativeAutoLayoutOptions` is the shared contract for the UI and Agent. It includes engine, algorithm, direction, node spacing, layer spacing, edge routing, iteration limit, random seed and margin.
- The Copilot native-edit contract includes `auto_layout` as a typed operation targeting `active_page`. The agent must use this operation for whole-page layout or requests to change the layout engine/algorithm/spacing. It must not author a layout script or call the Draw.io built-in layout action.
- `auto_layout` is the only operation allowed in its batch and always requires explicit user confirmation because it rearranges an entire page. The user can also trigger the configured layout explicitly from the toolbar.
- The same planner and native geometry applier serve both entry points; no separate AI-only layout algorithm is allowed. The engine-independent stability refinement and relative-anchor semantics are defined in [ADR-0025](./0025-relative-anchors-and-stability-preserving-layout.md); adapters may use native constraints as an optimization but must not change those user-visible semantics.

### 4. Preserve safety and native-document integrity

Before mutation, the native bridge validates the active page, native cell set, expected node geometry, edge endpoints, unique targets, plan size and finite coordinate/waypoint ranges. A stale or malformed plan fails closed. If applying the plan fails, restore the captured native geometries before reporting whether rollback succeeded.

Only geometry and connector waypoint fields required by the accepted plan may change. Draw.io remains responsible for the final XML serialization; the Studio must not reconstruct the file from a reduced graph. Success is not reported until the native editor acknowledges the operation and returns a valid serialized document. Existing revision-checked persistence and version history remain in force.

## Prohibited regression

Do not remove Dagre, ELK, the Studio layout planner, its toolbar/settings, native geometry application, or the Agent's `auto_layout` operation as incidental cleanup. The following changes require an explicit replacement decision and equivalent regression coverage before removal:

1. Removing or replacing a supported layout engine dependency from `v2/package.json` / `v2/package-lock.json`.
2. Removing the native layout planner or switching the toolbar back to Draw.io's built-in `action: "layout"`.
3. Removing the layout settings or the typed Agent operation.
4. Changing layout application so it bypasses the native bridge, source revision/page checks, serialization acknowledgement or persistence/version chain.

A code search showing an npm package is not imported by the App directly is not evidence that the dependency is unused: layout engine usage is encapsulated in `v2/src/layout/native-layout.ts`.

## Acceptance checklist

- [ ] Unit tests exercise Dagre, supported ELK algorithms and each additional layout adapter against native mxCell XML.
- [ ] Tests verify the layout planner is non-mutating, returns finite coordinates and routes, and targets only the selected page/default layer.
- [ ] Native bridge tests cover active-page mismatch, changed cell sets, stale geometry/endpoints, invalid coordinates and rollback on mutation failure.
- [ ] Agent schema/parser/resolver tests cover `auto_layout`, option validation and the single-operation rule.
- [ ] UI and Agent use the same options type and planner.
- [ ] Typecheck, unit tests, production build and canvas E2E checks pass before release.

The first four items are architecture invariants. The checklist may only be marked complete when corresponding tests exist and pass.
