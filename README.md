# Architecture Diagram Studio

A React Flow-based architecture diagram editor with a versioned diagram model and a native draw.io XML export path.

## Current status

MVP implementation in progress. The current app provides an editable C4 Container example, ELK layered auto-layout, browser-local persistence of the current diagram and node geometry, model validation before export, and deterministic native mxGraph XML generation. Sequence-diagram editing, business-context extraction, and automated draw.io rendering round-trip are not implemented yet. Pixel-identical rendering is not guaranteed by coordinate mapping alone.

## Quick start

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

## Implemented

- React + TypeScript + React Flow editor.
- Example C4 Container view with people, services, database, and an external system.
- Add service nodes, rename/delete elements, create relations by connecting node handles, and select/edit/delete relation labels.
- ELK layered layout as an explicit action; export does not invoke layout.
- Persisted browser-local diagram snapshot and current node geometry.
- Reset-to-example action.
- Validation of duplicate IDs and broken relation references before export.
- Native draw.io XML export preserving node positions, dimensions, labels, styles, relationships, and optional relation waypoints.
- Deterministic XML for a fixed document snapshot; generated timestamps are omitted.
- Unit tests for validation, geometry/waypoint mapping, escaping, and deterministic export.
- GitHub Actions workflow for typecheck, tests, and production build.

## Design documents

- [Product requirements](docs/requirements.md)
- [Architecture and flow diagrams](docs/architecture.md)
- [Export fidelity and verification plan](docs/export-fidelity.md)
- [ADR 0001: Editor-independent IR](docs/adr/0001-editor-independent-ir.md)
- [ADR 0002: Diagram-specific layout](docs/adr/0002-diagram-specific-layout.md)
- [ADR 0003: Native-first export](docs/adr/0003-native-first-export.md)

## Architecture principles

1. Keep business semantics separate from editor state and visual layout.
2. Treat logical geometry as persisted data; export must not invoke layout.
3. Use graph layout for C4 views and a dedicated constraint-based layout for sequence diagrams.
4. Prefer editable native draw.io cells; use SVG selectively for complex visual elements.
5. Track source evidence and uncertainty when context extraction is added.
6. Validate model invariants before export and keep export deterministic for a fixed snapshot.

## Known gaps

- Diagram semantics start from sample data; the UI supports basic service creation, node renaming/deletion, and relation creation, but not full property editing for technology, descriptions, types, and provenance.
- Persistence is browser-local only; there is no named project library or import/open workflow yet.
- Sequence diagrams and their ordered messages, activations, and alt/opt/loop fragments are not implemented.
- Nested C4 boundaries and relationship waypoint editing are not implemented.
- XML generation has unit-level regression coverage, but opening/rendering in diagrams.net has not been verified by an automated round-trip.
- Browser-to-draw.io pixel parity is not guaranteed; font metrics, shape implementations, and edge routing can differ.
- Business context extraction and evidence/provenance UI are planned, not implemented.
