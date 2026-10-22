# ADR 0003: Server-authoritative diagram operations

- Status: Superseded by [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md)
- Date: 2026-10-21

> Historical decision. Where this ADR describes DiagramDocument, semantic layout/quality, templates, semantic proposals, XML projection, or semantic completeness gates as current capabilities, ADR-0011 takes precedence. Retained material explains the prior design only.

## Context

Diagram operations must behave consistently when initiated from the UI or the Studio's internal Copilot Agent. Keeping layout algorithms, node-placement rules, and quality scoring in browser code allows those entry points to drift and makes execution difficult to audit. Draw.io XML generation must also use the same domain implementation as other diagram operations.

## Decision

The HTTP server is the execution boundary for deterministic diagram operations. The server exposes endpoints for layout, intent application, layout quality evaluation, node movement, sequence normalization, and Draw.io XML export. The server invokes the existing domain modules rather than maintaining duplicate implementations. Operations are logged with document identifiers, inputs relevant to audit, timing, and outcomes.

The browser remains responsible for rendering the native Draw.io editor, pointer/keyboard interactions, temporary previews, and confirmation for proposals that require review. It requests server-side operations instead of independently applying domain transformations. Native Draw.io XML remains preserved and versioned by the existing workspace document persistence path.

The UI and internal Copilot SDK tools call the same domain services or HTTP operations; they must not reimplement layout or document mutation rules. No standalone MCP server or external MCP surface is provided.

## Consequences

- Layout and document-operation behavior has one authoritative implementation.
- Server logs provide an audit trail for supported operations.
- Browser rendering remains responsive and framework-specific.
- The frontend currently parses Draw.io XML to derive the partial semantic projection, while sequence normalization, layout, quality evaluation, node placement, and intent interpretation use server endpoints. XML validation and persistence remain server-authoritative. Any future parser move must preserve the complete XML source and must not make the projection authoritative.
- API validation and regression tests are required for malformed documents, missing nodes, XML round-trips, and layout invariants.
