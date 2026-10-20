# Architecture Diagram Studio

A React Flow-based architecture diagram editor with a versioned diagram model, native draw.io XML export, and a GitHub Copilot SDK chat assistant that can edit the diagram through constrained tools.

## Current status

MVP implementation in progress. The app provides an editable C4 Container example, four selectable auto-layout engines (ELK, Dagre, D3-Hierarchy, and D3-Force), browser-local persistence, deterministic draw.io XML export, and a local Copilot SDK API. Chat can add/update/delete nodes and relationships, change the title, and request auto-layout through an explicit tool allowlist. Sequence-diagram editing, business-context extraction, and automated draw.io rendering round-trip are not implemented yet. Pixel-identical rendering is not guaranteed by coordinate mapping alone.

## Quick start

Requirements: Node.js 22.13+, TypeScript 6+, and npm. Copilot SDK authentication must be available locally.

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
- Local stdio MCP server for VS Code GitHub Copilot, exposing the active diagram's read/modify/validate/layout-request tools and synchronizing through the same loopback API as the browser editor.
- SDK tool allowlist is limited to diagram operations; the chat agent is not given filesystem, shell, or repository tools.
- Chat history and current diagram are stored in browser local storage; recent history is sent to reconstruct context if the local API restarts.
- Four selectable layout engines: ELK layered (default), Dagre directed graph, D3-Hierarchy tree/forest, and D3-Force force-directed layout.
- A Layout settings page exposes the tunable parameters for all four engines, including direction, spacing, edge routing, force strengths, collision behavior, and simulation budget.
- Reusable named layout variants: edit the active variant, save the current configuration as a new variant, switch between variants, or delete a variant. Variants and the active selection are persisted in browser local storage; defaults are used if stored data is unavailable or invalid.
- Two visual styles: the existing Studio theme and an optional Diagram Design-inspired editorial theme with warm paper, restrained burnt-orange accents, hairline borders, minimal shadows, and compact technical labels. The preference is browser-local and does not alter diagram semantics or export geometry. Layout is explicit; export never invokes it.
- Layout trade-offs: ELK is the default for general architecture graphs and configurable edge routing; Dagre is a fast directed layout; D3-Hierarchy uses a spanning forest for cycles/disconnected nodes, so cross-links do not influence tree placement; D3-Force runs a bounded one-shot simulation for a force-directed arrangement rather than continuously moving nodes.
- Layout selection is also honored when Copilot requests an automatic layout; current node dimensions and resulting positions are persisted.
- Persisted browser-local diagram snapshot and current node geometry.
- Reset-to-example action.
- Validation of duplicate IDs and broken relation references before export.
- Native draw.io XML export preserving node positions, dimensions, labels, styles, relationships, and optional relation waypoints.
- Deterministic XML for a fixed document snapshot; generated timestamps are omitted.
- Unit tests for validation, geometry/waypoint mapping, escaping, and deterministic export.
- GitHub Actions workflow for typecheck, tests, and production build.

## VS Code Copilot integration (MCP)

The workspace includes `.vscode/mcp.json`. Run `npm install`, start `npm run dev`, and open the browser editor before asking VS Code Copilot to inspect or change the active diagram. VS Code starts the stdio server directly with `node --import tsx server/mcp.ts` so stdout remains reserved for MCP protocol messages. The tools use the local API at `127.0.0.1:3001` to read or mutate the same diagram visible in the browser. Available tools cover diagram retrieval, node and relationship CRUD, title updates, validation, and requesting the currently selected layout engine. See [`docs/vscode-copilot-mcp.md`](docs/vscode-copilot-mcp.md) for setup, limitations, and security boundaries.

## Copilot setup

The development command starts the Vite client and the Express Copilot API together. Vite proxies `/api` to `127.0.0.1:3001`. The API binds to loopback only.

1. Sign in to GitHub Copilot through the local Copilot CLI/runtime, or provide `GITHUB_TOKEN` through your shell environment. The SDK client uses the logged-in CLI identity by default.
2. Copy `.env.example` to `.env` only if you need to override the model or runtime settings. Never commit a real token.
3. Run `npm run dev`. The editor opens in Vite; the API starts alongside it.
4. In the chat panel, ask for a concrete edit, for example: “Add a notification service and connect it to the Order API.” The updated diagram is applied to the editor and can then be exported.

The model defaults to `gpt-5` and can be changed with `COPILOT_MODEL`. Model availability depends on the account and current Copilot CLI runtime. See [`.env.example`](.env.example).

## Design documents

- [Product requirements](docs/requirements.md)
- [Architecture and flow diagrams](docs/architecture.md)
- [Export fidelity and verification plan](docs/export-fidelity.md)
- [ADR 0001: Editor-independent IR](docs/adr/0001-editor-independent-ir.md)
- [ADR 0002: Diagram-specific layout](docs/adr/0002-diagram-specific-layout.md)
- [ADR 0003: Native-first export](docs/adr/0003-native-first-export.md)
- [ADR 0004: Copilot SDK chat tools](docs/adr/0004-copilot-sdk-chat-tools.md)
- [VS Code Copilot MCP setup and tool reference](docs/vscode-copilot-mcp.md)
- [ADR 0005: VS Code Copilot through MCP](docs/adr/0005-vscode-copilot-mcp.md)

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
- Chat uses request/response rather than token-by-token streaming; tool execution is complete before the returned diagram is applied.
- The SDK session registry and active MCP-shared diagram are in memory; after an API restart, the browser reseeds the active diagram from its local persisted snapshot. The runtime Copilot session itself is not durably restored.
- MCP synchronization is intended for one active browser editor per local API process; concurrent multi-tab or multi-user collaboration is not supported.
