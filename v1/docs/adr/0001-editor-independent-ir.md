# ADR 0001: Editor-independent diagram model

- Status: Accepted
- Date: 2026-10-20

## Context
React Flow nodes and edges are UI implementation details. Storing business semantics only in those structures couples future editors, importers, and exporters to a rendering library.

## Decision
Maintain a versioned Diagram Document storing diagram type, semantic elements, relations, provenance, logical geometry, and presentation hints. React Flow and draw.io are adapters around this model.

## Consequences
- Semantic validation and export can be tested without rendering the UI.
- Schema evolution requires explicit versions and migrations.
- UI state must be synchronized back to the model before export.