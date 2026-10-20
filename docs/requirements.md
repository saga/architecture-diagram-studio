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

Implemented in the initial MVP:
- Editable C4 Container sample, node dragging, and explicit ELK auto-layout.
- Browser-local persistence of the current diagram snapshot and geometry.
- Validation for duplicate IDs and missing relationship endpoints.
- Native draw.io export for node geometry, labels, relationships, and optional waypoints.
- Unit tests and a GitHub Actions workflow for typecheck, test, and production build.

Not yet implemented or verified:
- General-purpose context extraction from requirements and source documents.
- Full semantic editing for all node/relation properties; the current UI only supports service creation, node rename/delete, and relation creation.
- Sequence diagram editing, including ordering, activations, and alt/opt/loop fragments.
- Automated opening/rendering of exported files in diagrams.net.
- Pixel-level visual regression and screenshot parity.
