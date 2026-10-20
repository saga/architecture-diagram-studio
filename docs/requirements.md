# Product Requirements

## Goal
Generate maintainable software architecture diagrams from business context, allow automatic and manual layout in React Flow, then export editable draw.io files while preserving geometry.

## Users and jobs
- Solution architects turn requirements, APIs, existing systems, and design notes into architecture views.
- Engineers refine component boundaries and dependency relationships.
- Reviewers inspect provenance and distinguish confirmed facts from inferred assumptions.

## Functional requirements
1. Extract candidate entities, system boundaries, components, relationships, interactions, constraints, and evidence from input context.
2. Represent C4 Context, Container, Component, and scenario-specific dynamic views.
3. Represent sequence participants, ordered messages, returns, activations, and structured fragments such as alt, opt, and loop.
4. Support automatic layout and manual movement/resize with persisted logical geometry.
5. Export editable draw.io XML with geometry, labels, styles, relations, and edge waypoints.
6. Validate graph references and diagram-type constraints before export.
7. Preserve source evidence and uncertainty on semantic elements.
8. Preserve manual layout during non-structural edits; support explicit full relayout.

## Non-functional requirements
- Deterministic export for a fixed model, layout, and style configuration.
- Versioned intermediate schema and migration strategy.
- No silent loss of relationships or manual geometry.
- Useful validation errors and regression fixtures for XML and visual differences.

## MVP acceptance criteria
- C4 Container example is editable in React Flow.
- Moving nodes changes exported draw.io geometry.
- Exported XML opens in diagrams.net with expected nodes and edges.
- Export does not trigger layout.
- Typecheck and production build pass.
- Rendering limitations are documented.

## Out of scope for MVP
- Arbitrary conversion of every React component into native draw.io shapes.
- Guaranteed pixel identity for arbitrary fonts, SVG filters, or browser-specific CSS.
- Autonomous architecture decisions without evidence and review.

## Implementation status (current)

Implemented in the current editor:
- C4 System Context, Container, and Component templates with semantic role cards, explicit system-boundary frames, node dragging, and graph auto-layout for C4 views.
- UML Sequence template with an independent sequence model, ordered participants/messages, call/return/async styles, activation intervals, and alt/opt/loop/par fragments; the sequence view does not use graph auto-layout.
- Kind-aware add/edit/delete operations for C4 elements and sequence participants/messages/fragments, including model validation and dependency cleanup.
- Schema-v1 legacy normalization for old C4 node bounds, ports, routes, and missing boundaries.
- Native draw.io export that dispatches by diagram kind and writes C4 boundaries/cards/relations or sequence lifelines/messages/activations/fragments.
- Full-page Agent execution trace with filtering, refresh, timing/provider metadata, and expandable payloads.
- Loopback API and VS Code MCP operations for diagram-kind switching and sequence CRUD in addition to existing C4 graph tools.

Not yet implemented or verified:
- General-purpose context extraction from requirements and source documents.
- Direct editing of activation start/end intervals and fragment message range/participant bounds in the sidebar.
- Automated opening/rendering of exported files in diagrams.net and screenshot-based visual regression.
- Pixel-level parity across browser and diagrams.net renderers.


## Copilot chat requirements

Implemented in the current MVP:
- Local Express API uses the official `@github/copilot-sdk` package, pinned to the same `1.0.14` version used by `saga/copilot-server-agent`.
- Chat receives the current diagram snapshot and can use diagram-kind-aware tools: C4 node/relation CRUD, sequence participant/message/fragment CRUD, diagram-kind switching, title changes, and graph auto-layout requests for C4 views.
- The browser applies the validated returned diagram snapshot; chat history and diagram state are stored locally.
- The API binds to loopback and does not register shell, filesystem, or repository tools.

Remaining:
- Token-by-token streaming of assistant text and tool progress.
- Durable server-side Copilot session restoration and persisted conversation audit.
- Automated tests with mocked SDK sessions for tool selection, malformed tool arguments, cancellation, and concurrent requests.
- Real authenticated end-to-end verification against a logged-in Copilot CLI runtime.
