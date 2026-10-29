# ADR-0018: AI-First Native Draw.io Execution

- **Status:** Retired and superseded by [ADR-0026 — Server-Side XML-First Copilot Editing](./0026-server-side-xml-first-copilot-editing.md).
- **Date:** 2026-10-24
- **Scope:** V2 local, single-user Architecture Diagram Studio

## Retirement notice

This ADR records a former design that executed model-authored JavaScript inside the live Draw.io iframe. That execution model is no longer part of the product and must not be restored as a fallback.

The current contract is defined by ADR-0026:
- Native Draw.io XML is the only authoritative diagram representation.
- Copilot edits XML on the server using revision-bound, cell-scoped patches.
- The server validates each result and persists workspace changes through the versioned persistence path.
- The frontend reloads the exact committed revision; standalone mode applies a validated patch through the browser-owned file handle.
- Read-only questions use native inspection/search tools and do not enter the mutation path.
- Studio-owned automatic layout remains governed by ADR-0013 and is unchanged.

Historical implementation details below this retirement notice have intentionally been removed to avoid presenting the former script-first architecture as current guidance.
