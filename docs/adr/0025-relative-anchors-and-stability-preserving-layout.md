# ADR-0025: Relative Anchors and Mental-Map-Preserving Layout

- Status: Accepted
- Date: 2026-10-29
- Related: ADR-0013 (Studio-owned layout), ADR-0021 (layout engine adapters), ADR-0022 (atomic spatial regions), ADR-0024 (local grouping and layout density).

## Context

The current layout system already has several useful but distinct stability mechanisms:

- ADR-0022 treats eligible geometry-only regions as atomic layout units and preserves the region members' internal geometry.
- ADR-0024 conservatively infers tightly adjacent local groups, allowing them to move together while retaining their local composition.
- ADR-0024 also defines canvas-origin preservation, which keeps the final content bounding box aligned with its previous origin.
- ADR-0021 provides a set of alternative layout engines and adapters.

These mechanisms do not cover a user's explicit instruction to select several cells and tell the layout engine which spatial relationships matter most. A whole-page layout may preserve some groups while still changing the left/right or above/below ordering and the relative spacing of specifically selected cells. Conversely, pinning those cells to their original absolute coordinates can constrain the entire page too strongly and cause other elements to move excessively or create awkward routes.

The product needs a common definition of relative stability that is independent of the chosen layout engine. It must let a selected group of cells move together across the canvas, preserve their pairwise two-dimensional arrangement within a small tolerance, and allow other cells to be laid out around them. Existing containment and proximity relationships should remain stable where feasible rather than being flattened into unrelated vertices.

## Decision

### 1. A relative anchor is a selected spatial relationship set, not a fixed coordinate

Introduce an explicit relative-anchor mode for auto layout.

- The user selects two or more native Draw.io cells in the active page and enables **Preserve relative positions of selected cells**.
- The selected IDs identify the cells whose mutual spatial relationships deserve higher preservation priority. They do not require any selected cell to stay at its original absolute x/y coordinate.
- The anchor set may translate as a whole, and the entire canvas may still be normalized according to the separate canvas-origin option. Rotation or arbitrary reshaping of the selected constellation is not allowed as an ordinary layout outcome; the relative direction and vector between each eligible pair should remain recognisable.
- Relative anchors are per-run input. Persist the boolean setting if appropriate, but never persist the cell-ID selection in browser preferences. A selection belongs to one page and one source revision.
- If the mode is enabled, a run requires at least two distinct, eligible anchor units. The first implementation supports at most 32 selected cell IDs so pairwise relationship evaluation remains bounded. Duplicate IDs are removed before planning. If fewer than two eligible anchor units remain after mapping cells to their effective layout units, fail closed with a user-facing explanation instead of silently running an ordinary layout.
- Only cells from the current active page and supported layout scope are accepted. IDs must be resolved against the supplied native XML; the client or Copilot may not invent IDs. A nested child that cannot independently participate in the current outer layout must either map unambiguously to its movable parent/region unit or be rejected with a clear explanation.

This is a soft-constraint model. It is deliberately different from a hard pin: the solver can make a small relative adjustment to avoid a collision or preserve an existing containment/group invariant, while still strongly discouraging a large change.

### 2. Define what relative stability means

For each eligible anchor cell, capture its source geometry from the exact native XML revision used by the layout plan. For each pair of anchors, compare both its original and proposed relative center vector:

- Horizontal and vertical direction: if one anchor was clearly to the left, right, above or below the other, preserve that ordering. A pair that was nearly aligned or overlapping on an axis before layout does not acquire a fabricated direction constraint on that axis.
- Distance: preserve the pair's two-dimensional displacement vector, not only the scalar distance between centers. This retains the overall orientation of the selected constellation and prevents a layout from satisfying a distance-only rule by swapping or rotating cells.
- Visual gaps: where bounding boxes do not overlap on an axis, use the original edge-to-edge gap as a secondary check. Cell dimensions remain native geometry and are not changed by this feature.
- Pair coverage: consider every distinct pair of selected anchor units. Do not preserve only consecutive items in selection order; selection order has no geometric meaning.

For an anchor pair i and j, the target is that the new relative vector remains close to the source vector: new-position(j) minus new-position(i) should approximate source-position(j) minus source-position(i). This constraint is invariant under translation, so the entire anchor constellation can move without weakening the pairwise relationship.

Use a small initial tolerance band, measured in Draw.io canvas units, for the difference between the source and resulting pairwise vectors. The initial policy is 8–24 px: use the larger of 8 px and 3% of the original pairwise distance, capped at 24 px. This is a default target for the initial implementation, not a promise that every infeasible layout can meet it. Tune it with representative diagrams and recorded layout deltas rather than exposing several tolerance sliders in the first UI. Direction reversals for clearly ordered pairs are a more significant stability failure than a small gap change and must be reported explicitly.

### 3. Keep selected anchors, inferred groups and containment as separate concepts

These mechanisms solve different problems and must not be merged into a single ambiguous “preserve” flag.

| Mechanism | Source of relationship | Expected behavior |
|---|---|---|
| Relative anchors | Explicit user selection for one layout run | Preserve pairwise direction and distance among selected cells, allowing the constellation to translate and permitting only small relative drift |
| Local grouping | High-confidence proximity heuristic from ADR-0024 | Keep tightly adjacent uncontained cells together without treating them as a permanent semantic group |
| Spatial regions | High-confidence containment analysis from ADR-0022 | Preserve region membership and exact member-to-region geometry when the region is moved |
| Native Draw.io Group | Native parent/child structure | Keep the existing group atomic in outer layout; do not flatten its children |
| Canvas-origin preservation | Explicit global bounding-box preference from ADR-0024 | Preserve the final content bounding-box origin; it does not preserve individual pairwise relationships |

If a selected anchor belongs to an eligible spatial region, adjacency cluster or native Group that is already an atomic layout unit, map the selected cell to that effective movable unit. Selecting a member must not cause the parent region or cluster to be split or its local geometry to be destroyed. If several selected cells map to the same effective unit, their internal relationship is already protected by that unit and must not create duplicate outer constraints. Anchoring a member of a local adjacency cluster suppresses the optional axis reflow that would otherwise change the member's internal offsets for the current run.

Region detection remains independent. Relative-anchor mode must not promote ambiguous or rejected region candidates, modify Draw.io parent IDs, or create persistent groups. Eligible region members retain the exact internal geometry guarantees already specified in ADR-0022. Relative anchors add a stability preference to the outer layout; they do not change the region analyzer's membership rules.

### 4. Use an engine-independent stability refinement pass

A layout engine's native constraint support is useful, but it is not a common contract. The shared planner owns the user-visible semantics.

The planning path is:

1. Read the active page's native XML and capture the exact source revision, page, selected anchor IDs, native geometry, and existing region/adjacency-group mappings.
2. Build the same disposable layout projection used by the current planner. Resolve each selected cell to its effective movable layout unit; reject ambiguous or unsupported selections.
3. Run the selected engine adapter to obtain its normal layout target positions and any supported routing information.
4. Run a shared constrained-refinement pass over the resulting movable layout units. It jointly adjusts anchor units and unselected units, using engine positions as the baseline, rather than simply moving the anchors back after layout.
5. Apply canvas-origin normalization only after the refinement pass, if that independent option is enabled.
6. Emit a revision-bound plan containing original native cell IDs only. Transient region, cluster and anchor proxy IDs must never reach the Draw.io mutation bridge.
7. Reuse the existing native bridge validation, single model transaction, serialization acknowledgement, persistence, version history and rollback path from ADR-0013.

The refinement pass must balance the following objectives:

- **Anchor-relative error:** a high-priority penalty when a selected pair's horizontal/vertical displacement changes beyond its tolerance band or its clear directional order is reversed.
- **Atomic-region and local-group preservation:** retain the current region-member geometry and the original shape of a local group; an anchor that belongs to a local group prevents its internal axis reflow for this run.
- **Engine target quality:** retain the selected engine's useful layering, topology, direction, edge-crossing and spacing preferences for cells that are not explicitly anchored.
- **Unnecessary movement:** use a lower-priority movement penalty as a tie-breaker when multiple candidate layouts have similar structural quality. This term must not make the entire original drawing immovable.
- **Collision handling:** avoid introducing new unintended node overlaps while respecting native group and region boundaries. A pre-existing overlap is not automatically treated as a grouping signal or silently assumed to be an error; use the existing region/group analysis and surface unresolved overlap diagnostics.

The ordering of priorities is intentional: native-document integrity and valid group/containment geometry are invariants; selected pairwise relationships and existing high-confidence local structures receive strong preservation weight; normal layout quality then arranges unselected nodes; minimal displacement breaks ties. These are not absolute pins. When constraints conflict, the refinement may relax a soft relationship, but it must report that the requested stability target was not fully met.

For the first implementation, use a deterministic, iterative energy-based refinement with prioritized projection. Do not leave the feature as an unspecified collection of adapter-specific heuristics.

- **Optimization variables:** use one position variable per movable layout unit. Ordinary top-level cells may move individually; a native Group, eligible spatial region, or anchored local cluster exposes a shared outer translation while retaining its required internal geometry.
- **Engine targets:** initialize each unit at the selected engine's output position. Keep a strong attraction to that target for ordinary unselected units, so the refinement does not turn into a second unconstrained layout from the source coordinates. Reduce the target-attraction weight for anchor units so their pairwise relationships can take priority.
- **Anchor springs with a dead band:** for every pair of distinct anchor units, compare the resulting relative vector with the source vector. Apply no correction while its vector error is within the configured tolerance band; outside the band, apply a correction toward the source vector. The anchor objective must outweigh the engine-target attraction for those units, while still allowing the whole anchor set to translate.
- **Group and region constraints:** treat native-group and eligible region membership geometry as invariants. Preserve the local shape of a cluster containing an anchor by suppressing its optional internal axis reflow for this run. Keep high-confidence local grouping and region adjacency preferences above ordinary layout aesthetics but below native-document invariants.
- **Collision projection:** after each position update, use a spatial index to find candidate rectangle intersections and project away newly introduced unintended overlaps. Do not use an all-pairs node scan for large pages. A pre-existing overlap is not automatically removed or reinterpreted as a group by this feature.
- **Determinism and stopping:** process units and constraints in a stable order based on native IDs, apply damping to avoid oscillation, and use a bounded internal iteration budget with an early-stop threshold. The first implementation should cap refinement at 200 iterations and stop early when the maximum unit movement is below 0.5 px for five consecutive iterations. If the budget expires before satisfying the stability target, report the measured drift as degraded rather than silently claiming success.
- **Routing:** edge waypoints produced by the base engine must not be reused unchanged after refinement moves their endpoints. Recompute routes from the refined geometry where the adapter supports it; otherwise invalidate stale waypoints and let the existing native Draw.io routing path recalculate them under its established contract.

This refinement is joint because anchor units and unselected units are optimized together: the solver may translate or slightly adjust the anchor constellation while making room for other nodes. It must expose the same user-visible semantics and diagnostics for every engine. Do not substitute a post-layout “restore anchor coordinates” transform for joint refinement.

### 5. Keep the request and plan contracts explicit

Extend the shared UI/Agent/native-plan contract with:

- **preserveRelativeAnchors**: an explicit boolean option, defaulting to false for backward compatibility.
- **anchorCellIds**: the exact native IDs selected for this run. This is request/plan context, not a persistent auto-layout preference.
- **anchor diagnostics**: requested and resolved anchor counts, effective anchor-unit count, evaluated pair count, maximum and mean pairwise vector drift, directional-order violations, and an outcome such as applied, degraded, skipped or not applicable.

The UI should make it clear that the setting preserves relative positions, not absolute coordinates. It should be unavailable or explained when fewer than two eligible cells are selected. The Agent's auto-layout operation uses the same planner and must resolve explicit anchor IDs from the active native document; it cannot guess IDs or infer that a cell is anchored merely because it is mentioned in prose.

The layout plan and the native bridge must validate that:

- The active page and native XML revision still match the source snapshot.
- The anchor IDs are unique, within the supported limit, present in the expected native cell set and resolvable to eligible movable units.
- The option values and anchor IDs match the request that produced the plan.
- Every emitted target and coordinate is valid and finite; no temporary proxy ID is emitted as a native geometry target.
- Existing rollback and serialization-acknowledgement behavior remains unchanged.

Older Agent callers that omit the new fields use the documented defaults: relative-anchor mode disabled and no anchor IDs. Unsupported or stale anchors fail closed before any native model mutation.

### 6. Define degradation and conflict behavior

Relative stability is a preference, not a guarantee that may violate other layout invariants. The planner must distinguish a cleanly applied result from a degraded result.

- If a requested anchor cannot be resolved or the selection contains too few distinct eligible units, do not silently ignore it. Explain the reason and require recalculation or a corrected selection.
- If the layout is valid but the optimizer cannot meet the requested tolerance because of collision, containment or routing constraints, a plan may be applied only if all hard validation checks pass. Return a degraded outcome and show a warning with measured drift and any direction reversals.
- Invalid geometry, a stale revision, invalid native IDs, or failed hard constraints reject the plan; they are not degradations.
- Do not claim that relative stability was preserved based solely on the selected algorithm name or on the presence of a native constraint option. Report measured output geometry.

### 7. Keep the option orthogonal to existing settings

| Setting | Controls | Does not mean |
|---|---|---|
| preserveRelativeAnchors | Relative vectors and ordering within the explicitly selected anchor set | Keeping any selected cell at its original absolute coordinates |
| preserveLocalGrouping | Automatically inferred local clusters | Anchoring an arbitrary user-selected set |
| preserveCanvasOrigin | Overall content bounding-box origin | Preserving internal node relationships |
| Engine, algorithm and direction | Base layout strategy | A guarantee of relative-anchor stability |
| Node/layer spacing and density | Preferred whitespace | A constraint on the anchor constellation |

These options compose. In particular, preserveCanvasOrigin may translate the final whole layout without changing anchor-relative vectors. A relative anchor constraint must not be discarded simply because an engine does not natively support the same constraint type.

## Alternatives considered

### Pin selected nodes to their original x/y coordinates

Rejected as the default. It prevents the anchor constellation from moving as a whole and can force unnecessary movement, longer routes and awkward empty space elsewhere. It remains a distinct potential future mode for users who explicitly require absolute positions, but is not part of this decision.

### Rely only on each engine's native constraints

Rejected. The supported adapters expose different semantics. Graphviz neato/fdp can pin absolute positions; fCoSE supports fixed-position, alignment and relative-placement constraints; WebCola provides directional/order/alignment constraints and overlap avoidance; ELK Layered Interactive can use previous positions to influence within-layer ordering. None of these capabilities alone defines the required cross-engine policy for pairwise two-dimensional distance preservation plus existing region and local-group stability.

### Run the engine normally and then move anchors back

Rejected. Restoring anchor coordinates after layout can reintroduce overlaps and invalidate the solver's spacing and edge-route assumptions. It optimizes neither anchors nor the surrounding cells jointly.

### Treat only anchors as one rigid bounding-box proxy

Rejected as the complete solution. A rigid proxy is a useful projection technique for existing atomic groups, but combining unrelated anchors into one opaque proxy can hide meaningful graph edges between anchor members and distort the rest of the topology. Relative constraints must retain each cell's graph identity and connector relationships while preserving the selected constellation.

### Preserve only left/right and above/below ordering

Rejected as insufficient. Ordering alone permits the gap between anchors to change arbitrarily. The model must also penalize changes to the pairwise displacement vector and report excessive drift.

## Validation and acceptance criteria

The feature is complete only when tests cover both layout geometry and the end-to-end native mutation contract.

1. **Translation invariance:** selected anchors may all move by a common translation, and the layout remains valid while their pairwise vectors remain unchanged.
2. **Relative distance and direction:** tests preserve left/right and above/below ordering, relative distance and two-axis displacement for two, three and larger anchor sets; reversing or swapping clearly ordered anchors is reported.
3. **Bounded drift:** changes inside the tolerance are accepted; excessive drift produces a degraded outcome with measured diagnostics rather than a success claim.
4. **Unselected-node freedom:** unselected nodes can move to improve the engine result and do not remain locked merely because anchors exist.
5. **Region behavior:** a selected region member maps to the eligible region unit; member-to-region offsets remain exact; ambiguous regions stay ineligible; no parent IDs change.
6. **Local grouping behavior:** a selected member of a local adjacency cluster prevents that cluster's internal axis reflow for the run; an unrelated unselected cluster retains ADR-0024 behavior.
7. **Native Groups and unsupported cells:** nested children are resolved to an unambiguous unit or rejected with a useful explanation. Hidden, stale or non-layoutable cells are never silently treated as valid anchors.
8. **Engine consistency:** run the same fixtures through every engine/algorithm combination exposed by the UI. The base layout aesthetics may differ, but anchor semantics and diagnostics must not.
9. **No-edge diagrams:** explicit spatial/packing algorithms still execute according to their existing contract; anchor constraints preserve the selected relationship set. Graph-structural algorithms that retain source coordinates continue to follow ADR-0024 and the existing no-edge safeguards.
10. **Native safety:** the plan emits real native IDs only and remains page/revision/cell-set bound. Tests cover duplicate/missing IDs, anchor-count limits, changed selection, stale revisions, invalid coordinates, rollback and serialization acknowledgement.
11. **Option composition:** test relative anchors with preserveLocalGrouping both on and off, preserveCanvasOrigin both on and off, region proxies, connector routing, and non-zero/negative source coordinates.
12. **Quality and runtime:** compare before/after diagrams using pairwise-vector drift, directional-order preservation, node displacement, newly introduced overlaps, edge crossings and layout runtime. Keep representative Draw.io fixtures so tuning decisions are evidence-based.

## Implementation sequence

1. Add typed request/plan fields, selection resolution, validation and explicit diagnostics without changing the default layout behavior.
2. Implement the shared layout-unit stability context and pairwise anchor objective; integrate it after each engine's base result and before origin normalization.
3. Add region, local-group, compound-group and connector regression fixtures, followed by the common native bridge and Agent contract tests.
4. Add the UI affordance and equivalent Agent behavior; show clean, degraded and rejected outcomes distinctly.
5. Benchmark representative small, medium and large diagrams, adjust the initial 8–24 px tolerance only from observed results, and document any algorithm-specific limitations without changing the user-facing semantics.

## References

- Hasan Balci and Ugur Dogrusoz, “fCoSE: A Fast Compound Graph Layout Algorithm with Constraint Support,” IEEE Transactions on Visualization and Computer Graphics, 28(12), 4582–4593 (2022). The fCoSE model combines force-directed layout with fixed-position, alignment and relative-placement constraints. https://doi.org/10.1109/TVCG.2021.3095303
- Cytoscape.js-fcose, “fCoSE 2.0.0 released,” documenting fixed-node, alignment and relative-placement constraints. https://blog.js.cytoscape.org/2021/02/08/fcose-2.0.0-release/
- WebCola documentation, describing constraint-based layout, directional position constraints and overlap avoidance. https://hpla.lacity.org/static/webcola/WebCola/
- Eclipse Layout Kernel, “Layered: Constraining the Model,” describing interactive and model-order constraints for more stable layered layouts. https://eclipse.dev/elk/blog/posts/2023/23-01-09-constraining-the-model.html
- Graphviz neato documentation, describing stress-majorization layout and its absolute node pinning feature. https://graphviz.org/docs/layouts/neato/ and https://graphviz.org/doc/info/attrs.html
- Sheng et al., “Inverse Markov Process Based Constrained Dynamic Graph Layout,” Journal of Computer Science and Technology, 36, 707–718 (2021), on pairwise/structural constraints for preserving relatively stable substructures. https://doi.org/10.1007/s11390-021-9910-5
- Di Bartolomeo et al., “Evaluating Graph Layout Algorithms: A Systematic Review of Methods and Best Practices,” Computer Graphics Forum (2024), including movement, neighbourhood-preservation and distortion metrics. https://doi.org/10.1111/CGF.15073
