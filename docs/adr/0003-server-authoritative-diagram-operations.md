# ADR 0003: Server-authoritative diagram operations

- Status: Accepted
- Date: 2026-10-21

## Context

Diagram operations must behave identically when initiated from the UI, Copilot, or MCP. Keeping layout algorithms, node-placement rules, and quality scoring in browser code allows those entry points to drift and makes execution difficult to audit. Draw.io XML generation must also use the same domain implementation as other diagram operations.

## Decision

The HTTP server is the execution boundary for deterministic diagram operations. The server exposes endpoints for layout, intent application, layout quality evaluation, node movement, sequence normalization, and Draw.io XML export. The server invokes the existing domain modules rather than maintaining duplicate implementations. Operations are logged with document identifiers, inputs relevant to audit, timing, and outcomes.

The browser remains responsible for rendering ReactFlow and the Draw.io editor, pointer/keyboard interactions, temporary previews, and user confirmation. It requests server-side operations instead of independently applying domain transformations. Native Draw.io XML remains preserved and versioned by the existing workspace document persistence path.

MCP and Copilot should call the same domain services or HTTP operations; they must not reimplement layout or document mutation rules.

## Consequences

- Layout and document-operation behavior has one authoritative implementation.
- Server logs provide an audit trail for supported operations.
- Browser rendering remains responsive and framework-specific.
- The frontend still contains Draw.io XML import parsing. The parser depends on browser DOM APIs and must be refactored behind a portable parser abstraction before it can safely run in Node.js. Move those import call sites after that refactor before claiming complete server authority.
- API validation and regression tests are required for malformed documents, missing nodes, XML round-trips, and layout invariants.
