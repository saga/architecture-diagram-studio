# draw.io Export Fidelity and Verification Plan

## Renderer contract

The exporter is kind-dispatched. C4 Context, Container and Component use semantic card vertices, explicit stereotypes, system-boundary frames, native relations and saved orthogonal bend points. UML Sequence uses a different exporter with participant headers, free-standing dashed lifelines, chronological messages, activations and fragment frames. Sequence messages are not exported as generic C4 relations.

| Visual element | React Flow editor | Native draw.io XML | Shared source |
|---|---|---|---|
| C4 element card | Semantic card with stereotype, title, technology and optional description | Editable mxGraph vertex with matching role color and HTML label hierarchy | DiagramNode type, label, technology, description and saved bounds |
| C4 boundary | Non-interactive dashed background frame | Editable dashed container vertex | DiagramBoundary bounds and memberNodeIds |
| C4 relationship | Custom edge with endpoint handles and orthogonal waypoint path | Editable mxGraph edge with named anchors and explicit mxPoint bend list | DiagramRelation endpoints, handle IDs and waypoints |
| Sequence participant | Participant header above a vertical dotted lifeline | Editable participant vertex plus a separate dotted edge cell | SequenceParticipant and computed column geometry |
| Sequence message | Time-ordered horizontal arrow; call, return and async use distinct line styles | Editable edge with source/target points and call/return/async style | SequenceMessage.kind and order |
| Sequence activation | Narrow rectangle over the participant lifeline for a message interval | Editable rectangle over the same message interval | SequenceActivation |
| Sequence fragment | Frame with alt / opt / loop / par header and optional guard | Editable dashed frame with title and guard | SequenceFragment |
| Export side effects | None | Pure XML conversion | Current normalized snapshot; export never invokes layout |

## What is preserved

- Semantic C4 types and relationships, including C4 system-boundary membership.
- Node bounds and relation endpoints in logical diagram coordinates.
- Named source/target handles, their anchors, and explicit orthogonal bend points for C4 edges.
- Sequence participant order, message order/kind/labels, activation intervals, and fragment bounds/guards.
- XML/HTML escaping for user-provided labels and descriptions.
- Deterministic XML output for an unchanged model snapshot; generated modification timestamps are omitted.

## Legacy geometry normalization

Older schema-v1 browser or server snapshots may have 84-pixel node bounds from the prior generic node renderer. Before rendering, normalizeDiagramDocument raises C4 bounds to the minimum readable card size while preserving saved x/y positions. Port coordinates are rescaled proportionally when dimensions change. Cached waypoints are discarded only when their original geometry has become incompatible. Older C4 Container/Component documents without a boundary receive a boundary derived from eligible members. Sequence documents are kept out of this C4-boundary path.

## Known visual limits

Matching geometry does not guarantee pixel-identical rasterization between the browser and diagrams.net: HTML layout, available fonts, antialiasing, line joins, zoom and mxGraph labels may differ. The implementation avoids the previous major mismatch—independent shape conventions and independent orthogonal route calculation—but still requires rendered integration verification.

For true screenshot identity, explicitly choose one of these product contracts:

1. **Editable diagram:** keep native draw.io nodes and edges, and accept renderer-specific differences within a documented tolerance.
2. **Exact appearance:** embed the browser-rendered diagram as SVG/image, sacrificing native editability of depicted elements.
3. **Hybrid:** include an SVG visual reference alongside the native editable cells.

## Verification plan

1. Run `npm run typecheck`, `npm test`, and `npm run build` when GitHub Actions provides a runner.
2. Verify legacy geometry migration preserves x/y and rescales old ports.
3. Create, drag, and delete elements within a C4 boundary; confirm boundary dimensions and membership update and no stale member IDs remain.
4. Render and export all three C4 views, including long labels, Unicode, descriptions, several relations sharing a node, and external systems.
5. Exercise sequence calls, returns, async messages, self-calls, activations and alt / opt / loop / par fragments. Check that editing or removing one message keeps the remaining order valid and drops dependent activation/fragment references.
6. Open exported files in diagrams.net and compare screenshots with the editor at a documented scale. XML string tests validate structure but do not prove visible route fidelity.

## Coordinate contract

- All persisted geometry and waypoints use logical canvas coordinates, not CSS screen pixels.
- C4 node x/y are top-left positions for both React Flow's default node origin and mxGraph geometry.
- Zoom and pan do not affect exported positions.
- Waypoints must never be reconstructed from screen pixels during export.
- Sequence x positions are participant columns and y positions are derived from message order. Generic graph layout is not applied to sequence views.
