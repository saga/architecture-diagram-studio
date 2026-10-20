# Architecture Diagram Studio

A React Flow-based architecture diagram editor with a versioned diagram model, native draw.io XML export, and a GitHub Copilot SDK chat assistant that can edit the diagram through constrained tools.

## Current status

MVP implementation in progress. The app provides an editable C4 Container example, ELK layered auto-layout, browser-local persistence, deterministic draw.io XML export, and a local Copilot SDK API. Chat can add/update/delete nodes and relationships, change the title, and request auto-layout through an explicit tool allowlist. Sequence-diagram editing, business-context extraction, and automated draw.io rendering round-trip are not implemented yet. Pixel-identical rendering is not guaranteed by coordinate mapping alone.

## Quick start

Requirements: Node.js 22.13+ and npm. Copilot SDK authentication must be available locally.

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
- Copilot SDK chat backed by a local Express API, with diagram-specific tools for node/relation CRUD, title changes, and optional ELK layout.
- SDK tool allowlist is limited to diagram operations; the chat agent is not given filesystem, shell, or repository tools.
- Chat history and current diagram are stored in browser local storage; recent history is sent to reconstruct context if the local API restarts.
- ELK layered layout as an explicit action; export does not invoke layout.
- Persisted browser-local diagram snapshot and current node geometry.
- Reset-to-example action.
- Validation of duplicate IDs and broken relation references before export.
- Native draw.io XML export preserving node positions, dimensions, labels, styles, relationships, and optional relation waypoints.
- Deterministic XML for a fixed document snapshot; generated timestamps are omitted.
- Unit tests for validation, geometry/waypoint mapping, escaping, and deterministic export.
- GitHub Actions workflow for typecheck, tests, and production build.

## Copilot setup\n\nThe development command starts the Vite client and the Express Copilot API together. Vite proxies `/api` to `127.0.0.1:3001`. The API binds to loopback only.\n\n1. Sign in to GitHub Copilot through the local Copilot CLI/runtime, or provide `GITHUB_TOKEN` through your shell environment. The SDK client uses the logged-in CLI identity by default.\n2. Copy `.env.example` to `.env` only if you need to override the model or runtime settings. Never commit a real token.\n3. Run `npm run dev`. The editor opens in Vite; the API starts alongside it.\n4. In the chat panel, ask for a concrete edit, for example: “Add a notification service and connect it to the Order API.” The updated diagram is applied to the editor and can then be exported.\n\nThe model defaults to `gpt-5` and can be changed with `COPILOT_MODEL`. Model availability depends on the account and current Copilot CLI runtime. See [`.env.example`](.env.example).\n\n## Design documents

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
- Business context extraction and evidence/provenance UI are planned, not implemented.\n- Chat uses request/response rather than token-by-token streaming; tool execution is complete before the returned diagram is applied.\n- The SDK session registry is in memory; after an API restart, recent browser-side conversation history is replayed as context, but the runtime session itself is not durably restored.
