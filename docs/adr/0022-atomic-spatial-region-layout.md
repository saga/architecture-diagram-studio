# ADR-0022: Atomic Layout for Geometry-Only Spatial Regions

- Status: Accepted
- Date: 2026-10-26
- Related: ADR-0011 (native Draw.io is the only diagram model), ADR-0012 (native capability contracts), ADR-0013 (Studio-owned layout core), ADR-0021 (expanded native layout engines).

## Context

Some existing Draw.io diagrams use large plain rectangles and nearby text cells to show semantic regions such as IT Network and OT Network, without setting the enclosed cells' native `parent` relationship. The visual enclosure is meaningful to readers, but it is not a native Group. A normal whole-page layout therefore treats the boundary, its title and enclosed nodes as unrelated vertices.

Phase 1 introduced a read-only region analyzer. Phase 2 must use that analysis in the shared layout projection without persisting a parallel model or converting source cells to native Groups.

## Decision

- Native Draw.io XML remains the sole source of truth. Region candidates and membership are transient facts recomputed from the exact page XML supplied to the current layout plan.
- Use the shared `detectSpatialRegionsForLayout` analysis result to create eligible transient region proxies. A candidate is eligible only when confidence, nesting, overlap, member assignment and selected-layer membership are unambiguous.
- Unsupported or ambiguous regions remain outside atomic grouping. Phase 2 does not silently convert them to Groups, flatten or rewrite XML ancestry, or move a node that cannot be assigned safely.
- The existing region-boundary vertex is the proxy node presented to each layout engine. Enclosed top-level member cells and probable boundary title cells are removed from the outer solver graph and receive the same final x/y delta as the region; their dimensions, styles, native parent IDs and relative geometry remain unchanged.
- Direct internal edges of an eligible region are excluded from the outer solver. Edges with explicit waypoint arrays receive those same region deltas. Waypoint-free edges retain their original native source/target IDs and allow Draw.io to recalculate the rendered route from the translated endpoints.
- Cross-boundary connectors use the region ID only as a temporary layout terminal. The plan preserves their original native source/target IDs and adds a waypoint at the translated region boundary. A node that straddles a region border remains a separate outer vertex.
- Extend layout coverage so the user can see regions applied/skipped, member count, boundary elements, and internal connectors with explicit waypoints translated.
- Every actual geometry mutation still travels through the existing page/revision/cell-set-bound native layout plan and one Draw.io model transaction. The native bridge validates every planned vertex/edge and retains rollback, XML serialization acknowledgement, workspace/standalone persistence, and version history. No alternate mutation route is introduced.

## Explicit limitation

Phase 2 preserves the geometry **inside each region**, not the existing relative placement of different regions. The selected layout engine may move region proxies relative to one another or other top-level nodes. It does not guarantee an existing IT-above-OT order, inter-region spacing, or boundary-node position. Such constraints require explicit user-confirmed rules and engine-aware constraint handling; they must not be implied by the current implementation.

Nested region candidates are skipped as atomic units in Phase 2. Supporting nested region trees, automatic constraints between regions and a user-driven “layout inside this region” command are deferred.

## Consequences

- All layout engines share the same region projection and mutation semantics; individual adapters do not implement their own region inference.
- Position plans include each eligible region member as a native vertex target so Draw.io moves the real sibling cells together with the boundary, and stale-geometry guards cover those cells.
- Region-internal edges with explicit waypoints join the expected-cell guard set and the returned edge-route set. Internal edges without explicit waypoints are not mutated directly.
- Candidate detection remains heuristic. Low-confidence, nested, overlapping, or conflicting candidates are not auto-grouped; users retain native Draw.io editing and version rollback as recovery paths.

## Validation

- Unit test a controlled region with a boundary title, three members, one internal edge with explicit waypoints and one cross-boundary edge.
- Verify member deltas exactly match the region delta, sizes and native parents stay unchanged, internal waypoints translate by that delta, and the external connector keeps its native terminals while routing through the region boundary.
- Exercise the real upstream `industrial-iot-example.drawio` fixture and verify all eligible region/member IDs participate in the native layout plan.
- Playwright E2E opens a real Draw.io workspace, performs a layout transaction, verifies the region and members move together, checks internal waypoints and cross-boundary native terminals, and observes saved XML.
- Keep all existing engine, multi-page, nested native Group, stale revision, XML preservation, rollback, undo/redo and persistence tests passing.
