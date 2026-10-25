# ADR-0021: Expanded Native Layout Engines and Algorithm Adapters

- Status: Accepted
- Date: 2026-10-25
- Related: ADR-0011 (native Draw.io is the only diagram model), ADR-0012 (native capability contracts), ADR-0013 (Studio-owned layout core).

## Context

Dagre and ELK remain important, but they do not cover every layout objective. Graphviz, MSAGL.js, Cytoscape.js, and D3 provide alternatives for layered, radial, force-directed, distance-based, and tree layouts. These engines must not create another persistent graph model or bypass the native Draw.io mutation/persistence pipeline.

## Decision

- Keep native Draw.io XML and the live Draw.io editor as the only source of truth.
- Calculate positions from a disposable projection of native cells. Layout adapters return node coordinates and optional edge waypoints only.
- Route every result through the existing revision/page-bound NativeLayoutPlan and native bridge. Preserve model transaction, serialization acknowledgement, persistence, version history, validation and rollback behavior.
- Expose engine-specific algorithm lists; do not show combinations that the selected engine cannot execute.
- Retain Dagre and ELK. Additional adapters are Graphviz WASM (dot, neato, fdp, sfdp, circo, twopi), MSAGL.js (layered, mds, ipsepcola), Cytoscape.js core layouts (breadthfirst, circle, concentric, grid, random, cose) and D3 (tree, cluster, force).
- Extend ELK with the additional algorithms available in bundled elkjs: DisCo, Box, Rectangle Packing, Random, SPOrE Overlap and SPOrE Compaction. `fixed` is a position-preserving primitive rather than an auto-layout choice; Top-down Packing and VertiFlex are not exposed unless verified in the actual bundled runtime. Box/rectangle packing are rejected when the selected page contains connectors. DisCo uses Layered for component internals; SPOrE starts from existing native positions.
- Apply direction and spacing only where the engine/algorithm supports them. Settings are disabled where an option is not supported rather than silently pretending to pass unsupported constraints. MSAGL's IPSepCola option invokes the actual IPSepCola runner; adapters without verified route conversion return positions and allow native Draw.io to recompute routes.
- A missing position for any target vertex, invalid coordinate, incompatible option, or stale native revision fails closed before applying changes. Engines never replace cell styles, values, XML wrappers, custom attributes, page settings or unrelated cells.

## Non-goals

- Do not add an alternative canvas renderer.
- Do not persist an intermediate graph representation.
- Do not force one layout engine to implement all routing features. Adapters may return no waypoints; the shared planner explicitly clears outdated connector waypoints, as its existing contract specifies.
- Do not include Cytoscape extensions that require additional plugin packages until their licensing, bundle size and regression coverage have been reviewed.

## Validation

- Unit-test every engine/algorithm combination exposed in the UI against native mxCell input.
- Verify positions are finite and complete, missing output is rejected, and source XML is not modified during calculation.
- Verify engine selection survives reload and changing engine chooses a supported algorithm.
- Verify each result is applied and serialized by native Draw.io, then persists through the standard workspace/standalone save and version flow.
- Test existing page/cell/revision stale checks and rollback; no adapter may bypass them.
