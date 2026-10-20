# Architecture Diagram Studio

A React Flow-based architecture diagram editor with a versioned diagram model, native draw.io XML export, and a GitHub Copilot SDK chat assistant that can edit the diagram through constrained tools.

## Current status

MVP implementation in progress. The app provides an editable C4 Container example, four selectable auto-layout engines with five ELK algorithms, per-edge ports and route geometry, six editor themes, local Express persistence, deterministic draw.io XML export, and a local Copilot SDK API. Chat can add/update/delete nodes and relationships, change the title, and request auto-layout through an explicit tool allowlist. Sequence-diagram editing, business-context extraction, and automated draw.io rendering round-trip are not implemented yet. Pixel-identical rendering is not guaranteed by coordinate mapping alone.

## Quick start

Requirements: Node.js 22.13+, TypeScript 6+, and npm. Copilot SDK authentication must be available locally.

    npm install
    npm run dev
    npm run typecheck
    npm test
    npm run build

## Implemented

- React + TypeScript + React Flow editor.
- Example C4 Container view with people, services, database, and an external system.
- Add service nodes, rename/delete elements, create relations by connecting node handles, and select/edit/delete relation labels.
- Copilot SDK chat backed by a local Express API, with diagram-specific tools for node/relation CRUD, title changes, and optional ELK layout.
- Local stdio MCP server for VS Code GitHub Copilot, exposing the active diagram's read/modify/validate/layout-request tools and synchronizing through the same loopback API as the browser editor.
- SDK tool allowlist is limited to diagram operations; the chat agent is not given filesystem, shell, or repository tools.
- The active diagram, revisions, chat histories, and agent trace events are persisted by the local Express service; browser local storage remains a UI cache and offline recovery source.
- Four selectable layout engines: ELK (Layered default, plus Mr. Tree, Radial, Stress, and Force algorithms), Dagre directed graph, D3 Hierarchy tree/forest, and D3 Force force-directed layout.
- Main toolbar groups layout engine, direction, advanced settings, and Auto Layout. Changing settings only updates configuration; Auto Layout explicitly applies geometry. Dagre and D3 Hierarchy support four directions; ELK options are algorithm-dependent.
- Advanced settings expose ELK algorithm, direction, spacing, edge routing, iteration limit and seed; Dagre direction and spacing; D3 Hierarchy direction and spacing; and D3 Force link, repulsion, collision, and simulation-budget settings.
- Reusable named layout variants: edit the active variant, save the current configuration as a new variant, switch between variants, or delete a variant. Variants and the active selection are persisted in browser local storage; defaults are used if stored data is unavailable or invalid.
- Six visual themes: Studio, Editorial, Midnight, Blueprint, Minimal Mono, and Vibrant. Themes are editor-only presentation preferences stored in browser local storage; they do not alter diagram semantics or trigger layout. The draw.io exporter uses its own native style mapping.
- Layout trade-offs: ELK Layered is the default for architecture/dependency graphs, with named per-edge handles and routed bend points carried into React Flow and draw.io endpoint anchors. Mr. Tree is intended for rooted trees, Radial for hub-and-spoke diagrams, and Stress/Force for relationship maps; not every ELK setting applies to every algorithm. Dagre is a fast directed layout. D3 Hierarchy builds a spanning forest, so cross-links do not influence tree placement. D3 Force runs a bounded one-shot simulation rather than continuously moving nodes.
- Layout selection is also honored when Copilot requests an automatic layout; current node dimensions and resulting positions are persisted.
- Browser local storage remains a recovery cache for the diagram and current node geometry.
- Reset-to-example action.
- Validation of duplicate IDs and broken relation references before export.
- Native draw.io XML export preserving node positions, dimensions, labels, styles, relationships, and optional relation waypoints.
- React Flow uses draw.io-like SVG silhouettes for person and database nodes, the same title/technology hierarchy, and shared port/orthogonal route geometry. Export writes endpoint anchors and explicit bend points rather than letting a second router choose a different path; handles are hidden except during interaction.
- Deterministic XML for a fixed document snapshot; generated timestamps are omitted.
- Unit tests for validation, geometry/waypoint mapping, escaping, and deterministic export.
- GitHub Actions workflow for typecheck, tests, and production build.

## VS Code Copilot integration (MCP)

The workspace includes the .vscode/mcp.json file. Run npm install, start npm run dev, and open the browser editor before asking VS Code Copilot to inspect or change the active diagram. VS Code starts the stdio server directly with node --import tsx server/mcp.ts so stdout remains reserved for MCP protocol messages. The tools use the local API at 127.0.0.1:3001 to read or mutate the same diagram visible in the browser. Available tools cover diagram retrieval, node and relationship CRUD, title updates, validation, and requesting the currently selected layout engine. See [docs/vscode-copilot-mcp.md](docs/vscode-copilot-mcp.md) for setup, limitations, and security boundaries.

## Local persistence and agent trace

The Express service stores the active diagram, revision counters, and chat histories in ~/.architecture-diagram-studio/studio-state.json; the append-only agent audit ledger is ~/.architecture-diagram-studio/agent-traces.sqlite. Existing agent-traces.jsonl records are imported once into SQLite on startup. Override the directory with ARCHITECTURE_DIAGRAM_DATA_DIR. Trace events carry a traceId/turnId, sequence, lifecycle status, provider/model, duration, and event payload; indexed queries avoid rereading the entire log on each UI refresh. Credential-shaped fields are redacted. Payloads over 1 MiB are explicitly marked as omitted instead of being presented as complete evidence. Trace-write failures are not swallowed, and a turn whose SDK event could not be persisted is not reported as successful. The chat panel's **Agent trace** view refreshes while open. The files can contain prompts, diagram data, and tool arguments/results, so treat them as sensitive local application data. This remains a single-user local store, not a backup service and not a multi-user database.

## Copilot setup

The development command starts the Vite client and the Express Copilot API together. Vite proxies /api to 127.0.0.1:3001. The API binds to loopback only.

1. Sign in to GitHub Copilot through the local Copilot CLI/runtime, or provide GITHUB_TOKEN through your shell environment. The SDK client uses the logged-in CLI identity by default.
2. Copy .env.example to .env only if you need to override the model or runtime settings. Never commit a real token.
3. Run npm run dev. The editor opens in Vite; the API starts alongside it.
4. In the chat panel, ask for a concrete edit, for example: “Add a notification service and connect it to the Order API.” The updated diagram is applied to the editor and can then be exported.

The model defaults to gpt-5 and can be changed with COPILOT_MODEL. Model availability depends on the account and current Copilot CLI runtime. See [.env.example](.env.example).

## Design documents

- [Product requirements](docs/requirements.md)
- [Architecture and flow diagrams](docs/architecture.md)
- [Export fidelity and verification plan](docs/export-fidelity.md)
- [draw.io rendering, layout and Desktop CLI analysis](docs/drawio-rendering-layout-analysis.md)
- [ADR 0001: Editor-independent IR](docs/adr/0001-editor-independent-ir.md)
- [ADR 0002: Diagram-specific layout](docs/adr/0002-diagram-specific-layout.md)
- [ADR 0003: Native-first export](docs/adr/0003-native-first-export.md)
- [ADR 0004: Copilot SDK chat tools](docs/adr/0004-copilot-sdk-chat-tools.md)
- [VS Code Copilot MCP setup and tool reference](docs/vscode-copilot-mcp.md)
- [ADR 0005: VS Code Copilot through MCP](docs/adr/0005-vscode-copilot-mcp.md)
- [ADR 0006: Local persistence and agent execution trace](docs/adr/0006-local-persistence-and-agent-trace.md)

## Architecture principles

1. Keep business semantics separate from editor state and visual layout.
2. Treat logical geometry as persisted data; export must not invoke layout.
3. Use graph layout for C4 views and a dedicated constraint-based layout for sequence diagrams.
4. Prefer editable native draw.io cells; use SVG selectively for complex visual elements.
5. Track source evidence and uncertainty when context extraction is added.
6. Validate model invariants before export and keep export deterministic for a fixed snapshot.

## Known gaps

- Diagram semantics start from sample data; the UI supports basic service creation, node renaming/deletion, and relation creation, but not full property editing for technology, descriptions, types, and provenance.
- The active diagram is persisted locally by the Express service, but named projects and a project import/open library are not implemented yet.
- Sequence diagrams and their ordered messages, activations, and alt/opt/loop fragments are not implemented.
- Nested C4 boundaries and relationship waypoint editing are not implemented.
- XML generation has unit-level regression coverage, but opening/rendering in diagrams.net has not been verified by an automated round-trip.
- Browser-to-draw.io pixel parity is not guaranteed; font metrics, shape implementations, and edge routing can differ.
- Business context extraction and evidence/provenance UI are planned, not implemented.
- Chat uses request/response rather than token-by-token streaming; tool execution is complete before the returned diagram is applied.
- The active diagram and chat history are persisted in a local JSON snapshot; the indexed agent audit ledger is stored in SQLite. Copilot SDK session objects remain process-local and are recreated after an API restart; recent stored conversation is available to rebuild context.
- MCP synchronization is intended for one active browser editor per local API process; concurrent multi-tab or multi-user collaboration is not supported.
