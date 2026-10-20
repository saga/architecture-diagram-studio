# Architecture Diagram Studio

A React Flow-based architecture diagram editor with a native draw.io XML export path.

## Current status

Early MVP scaffold. It contains a C4 Container example, editable React Flow nodes, ELK layered auto-layout, and an XML exporter that maps the current logical node geometry to native mxGraph cells. Pixel-identical rendering and sequence-diagram editing are not yet implemented or verified.

## Quick start

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
npm run typecheck
npm run build
```

## Current features

- React + TypeScript + React Flow editor.
- Example C4 Container view with people, services, database, and external system.
- ELK layered layout action.
- Export current node geometry and relations to editable `.drawio` XML.
- Initial product requirements, architecture diagrams, and ADRs.

## Design documents

- [Product requirements](docs/requirements.md)
- [Architecture and flow diagrams](docs/architecture.md)
- [ADR 0001: Editor-independent IR](docs/adr/0001-editor-independent-ir.md)
- [ADR 0002: Diagram-specific layout](docs/adr/0002-diagram-specific-layout.md)
- [ADR 0003: Native-first export](docs/adr/0003-native-first-export.md)

## Architecture principles

1. Keep business semantics separate from editor state and visual layout.
2. Treat logical geometry as persisted data; export must not invoke layout.
3. Use graph layout for C4 views and a dedicated constraint-based layout for sequence diagrams.
4. Prefer editable native draw.io cells; use SVG selectively for complex visual elements.
5. Track source evidence and uncertainty when context extraction is added.

## Known gaps

- No automated tests yet.
- Manual geometry is currently captured at export time; persistent save/load is not implemented.
- Edge waypoint editing and export are not implemented.
- Nested C4 boundaries and sequence-diagram fragments are planned, not implemented.
- Draw.io XML is generated but has not yet been validated through an automated open/render round-trip.
- Browser-to-draw.io pixel parity is not guaranteed.
