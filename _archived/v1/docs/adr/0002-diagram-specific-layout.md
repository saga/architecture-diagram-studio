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

The six editor themes—Studio, Editorial, Midnight, Blueprint, Minimal Mono, and Vibrant—are presentation preferences only. They do not mutate the diagram or trigger layout. The original separate sequence-layout decision is now implemented: a sequence diagram stores participants, ordered messages, activation intervals, and fragments in `DiagramDocument.sequence`; it does not model messages as graph relations or send sequence content to ELK/Dagre.

## Renderer parity follow-up (2026-10-20)

The editor and exporter must not independently invent shape or edge geometry. The Diagram Document's logical node bounds, named port IDs/positions, and relation waypoints are the shared rendering contract. React Flow uses C4 semantic cards (Person, Software System, Container, Component and external-system types), explicit system-boundary frames, HTML title/technology/description hierarchy, and a custom edge that renders shared orthogonal waypoints. Sequence views have a separate participant/lifeline/message/activation/fragment renderer. draw.io emits the same vertex bounds, matching shape styles and text hierarchy, endpoint anchors, and explicit bend points with `edgeStyle=none`; it must not ask mxGraph's independent orthogonal router to reinterpret a route already computed by the application. For older documents that have no port metadata or routes, a deterministic non-mutating normalization provides ports and orthogonal paths before rendering/export.

Handles stay measurable and connectable but are visually hidden outside node hover/selection, so editor affordances do not appear as black dots in the exported visual comparison. This improves visual equivalence, but different font metrics and renderer implementations mean pixel identity still requires a rendered integration test in diagrams.net and the browser.
