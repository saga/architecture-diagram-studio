# ADR 0002: Diagram-type-specific layout

- Status: Accepted
- Date: 2026-10-20

## Context
C4 views emphasize hierarchy, containment, and dependency readability. Sequence diagrams enforce participant and temporal ordering. A generic graph layout cannot satisfy both sets of invariants.

## Decision
Use a layered graph layout such as ELK for C4 and dependency views. Implement sequence layout separately using participant columns, ordered message rows, activation intervals, and structured fragments.

## Consequences
- The editor can share interaction primitives without sharing all layout algorithms.
- Sequence semantics remain stable during layout.
- Layout fixtures must be maintained per diagram type.
## Implementation note (2026-10-20)

The layout service now separates engine selection from ELK algorithm selection. ELK offers Layered (default), Mr. Tree, Radial, Stress, and Force; Dagre and D3 Hierarchy expose direction settings. Engine-specific options may not apply to every algorithm.

Routes and handles are part of the model-to-renderer pipeline: optional relation handle IDs, per-node port geometry, and edge waypoints are carried by the Diagram Document, rendered by React Flow, and mapped into draw.io endpoint anchors where available. The toolbar keeps engine, direction, advanced settings, and Auto Layout together; choosing a setting does not itself move nodes.

The six editor themes—Studio, Editorial, Midnight, Blueprint, Minimal Mono, and Vibrant—are presentation preferences only. They do not mutate the diagram or trigger layout. Sequence diagrams remain a separate future strategy because participant and message ordering are semantic constraints.
