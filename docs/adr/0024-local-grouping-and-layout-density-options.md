# ADR-0024: Preserve Local Grouping and Offer Layout Density Presets

- Status: Accepted
- Date: 2026-10-28
- Related: ADR-0013 (Studio-owned layout), ADR-0021 (layout engine adapters), ADR-0022 (atomic spatial regions), ADR-0023 (native script runtime boundaries).

## Context

Users often arrange adjacent nodes as a meaningful local composition without creating a native Draw.io Group or enclosing the nodes in a recognised visual region. A whole-page layout that treats every node independently can break this composition when the user changes the overall direction. The layout settings also expose numeric node and layer spacing, but require users to understand those parameters to choose a compact or roomy result.

## Decision

### 1. Preserve local grouping is an explicit option

- Add `preserveLocalGrouping` to `NativeAutoLayoutOptions` and the Copilot-visible `auto_layout` contract. Its default is `true`; users may turn it off to allow free rearrangement.
- When enabled, analyse top-level visible sibling nodes using their current bounding-box gaps. Merge only high-confidence proximity neighbours. Complete-link clustering prevents a chain of individually near neighbours from combining an entire flow into one cluster. A cluster has at most eight members.
- Existing geometry-only region candidates and their members/boundaries are excluded from this inference; the explicit region projection remains authoritative. Existing overlaps are not treated as grouping evidence. Directly connected nodes may form a local cluster when their old separation is very small; larger gaps remain free for the graph layout to reorganise.
- Each inferred cluster is represented by a unique, transient bounding-box proxy only in the common layout projection. All layout engines receive the same projection. After layout, each native member receives the proxy's translation delta, retaining its size, style, XML parent, and offset from the other members. The proxy ID must never appear in the native layout plan.
- Internal connectors are removed from the outer solver graph. Existing explicit waypoints translate by the cluster delta; edges with no explicit waypoints retain their original source/target IDs and remain eligible for native Draw.io routing. Connectors crossing the cluster boundary are routed using the real native member geometry, not proxy IDs.
- Local grouping is a conservative heuristic rather than semantic truth. It does not create native Groups, infer a permanent relationship, or persist a parallel graph model. It must be possible to disable it when the author wants a complete rearrangement.

### 2. Layout density presets reuse the existing spacing controls

The UI offers three presets that set the existing `nodeSpacing` and `layerSpacing` values:

| Preset | Node spacing | Layer spacing |
|---|---:|---:|
| Compact | 40 | 60 |
| Balanced | 64 | 90 |
| Spacious | 96 | 140 |

- Density is derived from the current spacing values; it is not a second persisted layout setting. If either numeric value differs from a preset, the selector displays Custom.
- Users may continue editing node and layer spacing directly. Selecting a preset updates those two values only; it does not alter the algorithm, routing, direction, seed, or iteration budget.
- Engine-specific support remains authoritative. A density preset does not claim that every algorithm consumes both spacing parameters.

### 3. One contract for UI, Copilot and the native editor

- The UI and Copilot operation use the same typed options, planner and native geometry apply path. The `auto_layout` Zod schema defaults the new boolean for older callers that omit it.
- The calculated plan must match the requested grouping option as well as the engine, algorithm, direction, spacing and routing options before it is accepted. The native bridge validates that the option is a boolean.
- Planning remains bound to the exact native XML revision, active page and expected native cell set. Only original native cell IDs can be emitted as geometry targets.

## Validation

- Test the density-to-spacing mapping, including Custom detection.
- Test that tightly adjacent uncontained nodes move by one shared translation when preservation is enabled, including a connected pair, and that no transient proxy ID is emitted.
- Test that disabling preservation leaves nodes independently exposed to the selected layout algorithm.
- Keep existing engine, region atomicity, connector-routing, stale-revision, native XML integrity and rollback tests in force.
