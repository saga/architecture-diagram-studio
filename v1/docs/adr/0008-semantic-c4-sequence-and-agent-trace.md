# ADR 0008: Semantic C4, UML Sequence, and full-page Agent Trace

- Status: Accepted
- Date: 2026-10-20

## Context

The former editor treated architecture and sequence diagrams as the same node-and-edge graph, then tried to compensate with CSS and export-specific shape substitutions. This produced the wrong visual vocabulary, small or stale node bounds, and a second edge router in draw.io that did not follow the routes visible in React Flow. It also put execution-trace details in a short panel inside the diagram assistant, where payloads were difficult to inspect.

C4 views and UML sequence diagrams have different semantics. C4 needs element stereotypes and system boundaries. A sequence diagram needs participant columns, lifelines, chronological messages, activations, and structured fragments. They may share the editor shell, but should not share the same semantic graph or layout algorithm.

## Decision

### Diagram model and normalization

- Keep DiagramDocument as the persisted, editor-independent intermediate representation. Retain schema version 1 with optional boundaries and sequence fields so existing documents remain loadable.
- Represent C4 system boundaries separately from semantic elements using DiagramBoundary.memberNodeIds. A boundary is a visual container, not a normal graph node and must not participate in dependency layout or element counts.
- Represent UML sequence content using SequenceParticipant[], ordered SequenceMessage[], optional activation intervals, and optional alt / opt / loop / par fragments. For sequence documents, the generic nodes, relations, and graph layout are empty; message order is authoritative.
- Normalize legacy browser and server snapshots before rendering: enlarge old C4 bounds to readable minimum dimensions, rescale existing port coordinates when necessary, discard stale routes only when bounds change, and reconstruct missing C4 boundaries. Preserve the saved top-left positions.

### Diagram-specific renderer and exporter

- Use C4 semantic cards with explicit stereotypes and consistent meaning: Person, Software System, Container, Component, database container, and external system. Do not use a UML actor stick figure or database-cylinder glyph to represent a C4 element merely because it was used in the previous renderer.
- Calculate C4 boundaries around member elements after layout and manual movement. Add/delete operations—whether from the canvas, Copilot tools, or the local mutation API—must maintain boundary membership.
- Render sequence participants horizontally, lifelines vertically, and message rows in increasing order from top to bottom. Return messages use dashed lines; activations and fragments are independent visual objects.
- Export each diagram kind with its own native draw.io mapper. C4 export writes editable cards, system-boundary frames, relations, anchors and bend points. Sequence export writes participant heads, lifelines, messages, activations and fragments. Neither exporter triggers auto-layout.
- Use the same semantic data and geometry contract in the editor and exporter. Do not ask the renderer in one environment to independently infer a different route after the other environment has chosen it.

### User interface and trace inspection

- Offer explicit C4 Context, C4 Container, C4 Component, and UML Sequence templates. The add-element affordance is diagram-aware: it creates an appropriate C4 element or sequence participant.
- Keep the toolbar in separate brand/navigation and diagram-operation rows. The diagram type, layout controls, theme, and export action must wrap without compressing the canvas into an unusable strip.
- Keep Agent execution trace out of the assistant's chat column. Open it as a full-page view with an event list, search/filter, refresh, timing and provider metadata, and expandable payload details. Returning to Studio should preserve the current editor and conversation state.

## Consequences and constraints

- C4 and sequence semantics are now explicit and testable; sequence order no longer depends on generic graph coordinates.
- Schema-v1 records written by earlier releases can be normalized without a forced destructive migration.
- Native editable C4 and sequence XML should preserve structure and useful geometry. Exact pixel identity is not promised across browser and diagrams.net fonts, HTML implementations and shape rendering; a rendered integration test is still required.
- Copilot and MCP tools must be diagram-kind-aware. Generic node/relation operations should not silently mutate a sequence diagram; sequence edits must use participant/message/fragment operations.
- The Express service remains local and loopback-only. Multi-user collaboration and conflict resolution are not implied by this design.

## Verification checklist

- Run TypeScript typecheck, unit tests and production build when a workflow runner is available.
- Verify old 84-pixel C4 nodes migrate to readable card dimensions without moving their top-left coordinates.
- Move and delete C4 member elements; ensure boundaries recalculate and validation/export contain no stale member references.
- Exercise C4 Context, Container and Component templates in React Flow and draw.io.
- Exercise a sequence with calls, returns, async messages, activations, and alt / opt / loop / par fragments. Confirm chronological order remains stable after edits and round-trip export.
- Confirm Agent trace opens as a full page, supports filtering and payload inspection, refreshes events, and returns to the same editor state.
- Open representative .drawio files in diagrams.net. Treat visual screenshots as integration evidence; XML string tests alone cannot prove renderer fidelity.
