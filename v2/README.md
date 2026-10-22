# Architecture Diagram Studio V2

## Startup and diagram files

A project workspace is optional and represents a project directory, not a diagram. Use **Open Draw.io** to open any local `.drawio`, `.dio`, or `.xml` file as a standalone document; when the browser supports the File System Access API, edits autosave to the selected file. Browsers without direct file-write access can still open the file, but use **Export** to save edits. Copilot can analyze the standalone diagram and propose supported layout-intent changes without reading or modifying the configured project workspace; workspace-only semantic Agent tools remain unavailable in standalone mode. Standalone files do not require workspace scanning. Use **New Draw.io** when you want a diagram tracked in a configured project workspace; autosave and version history are scoped to that workspace diagram. Creating a new diagram never overwrites an existing file.

## Native Draw.io editor

The embedded native Draw.io editor is the only diagram canvas. The separate Studio SVG canvas and Studio/Freeform mode switch have been removed to avoid maintaining two competing editing experiences. The application keeps native Draw.io XML as the authoritative diagram source; semantic properties, layout operations, Copilot previews, theme changes and workspace versioning must preserve the complete document. Theme changes may update only the graph background and its reserved reversible-theme metadata; they must not recolour cell styles or replace unsupported cells, labels, pages or hierarchy. Draw.io import records supported style overrides on the semantic projection and patches changes back into the native XML only when the round-trip is safe.


V2 is an independent implementation. The previous implementation is preserved under the sibling V1 directory; V2 must not import code from V1.

## Run

Use Node.js 22.13 or later (required by the Copilot SDK runtime).

1. Install dependencies in this directory with npm install.
2. Run npm run dev.
3. Open the local Vite address printed in the terminal.

The pre-dev and pre-build hooks install a pinned Draw.io web bundle (v32.0.2, SHA-256 verified). After it is installed, the editor loads Draw.io from the same origin and does not use online embed. For an offline setup, provide a previously downloaded release archive using the environment variable DRAWIO_WAR and run npm run drawio:fetch.

## Implemented in this first V2 slice

- Standalone Vite + React + TypeScript app.
- First-class C4, flowchart and sequence fixtures.
- DiagramDocument V2 semantic model.
- A modular layout-engine registry: ELK Layered / Mr. Tree / Radial / Stress / Force and Dagre Layered are selectable independently from layout direction. ELK Layered retains C4 semantic ranks and flowchart lanes; Dagre provides a lightweight directed-graph alternative. Both support horizontal (left-to-right) and vertical (top-to-bottom) layouts. Sequence diagrams use their dedicated participant/timeline layout rather than generic graph engines.
- Deterministic sequence layout with call/return-derived activation bars, multi-variant route scoring, routing repair and node locks.
- Native Draw.io editing as the sole canvas, with semantic properties and layout controls around the editor.
- Embedded native Draw.io editor, native editable XML export, and import of plain or compressed Draw.io XML (including Studio semantic metadata). Native XML is kept separately after Draw.io edits so the next model sync does not immediately overwrite unmodeled native styles.
- Local intent commands for line style, routing, external placement, storage placement, layout direction and lock clearing; individual relations also expose label, direction, routing and dashed/solid controls.
- Reviewable intent previews (apply/discard), 50-step in-session undo/redo, server-authoritative document persistence with runtime schema validation, deterministic route-variant scoring, hard layout checks, and regression tests.

## Intentional boundary

Layout Copilot uses a local Node.js service backed by `@github/copilot-sdk` and the signed-in GitHub Copilot CLI identity. `npm run dev` starts Vite and the Agent service together; the service listens on loopback port 4175 and Vite proxies `/api/copilot`. Set the model ID in **配置** (default `claude-sonnet-5.5`) and choose **Thinking effort** (`Max` or `High`). Each browser conversation keeps a stable session ID; the server resumes the Copilot SDK session after an app/server restart when the SDK session state is available. Consecutive turns are serialized per session so they cannot race against each other. The Agent uses a custom `propose_layout_plan` tool to return a structured plan, rather than making arbitrary edits. The server validates every command against an allowlist and performs deterministic intent interpretation and layout computation. Broad or ambiguous changes use a preview and explicit confirmation; a focused change explicitly requested by the user may be applied directly after inspection and revision checks. No provider API key is sent from the browser. Make sure Copilot CLI is installed and signed in before using Agent mode. Clear the model setting to use local deterministic rules.

Draw.io web assets are generated into public/drawio at build time and are not committed as a bulky binary payload. No online fallback is configured. In offline deployments the archive must be supplied once during the build or included in the deployment artefacts.

## Draw.io XML schema and validation

All native diagram XML is validated by the Zod schemas in `src/model/drawio-xml-schema.ts` before it is imported or persisted. The validator accepts the documented `mxfile` and bare `mxGraphModel` diagram roots, multi-page files, inline models, plaintext-encoded pages, and Base64/raw-DEFLATE compressed pages. It also validates the separate `mxlibrary` root through `validateDrawioXmlFile`; library data is deliberately not accepted as a diagram document by `validateDrawioXmlDocument`.

The schema validates core `mxfile`, `diagram`, `mxGraphModel`, `root`, `mxCell`, geometry, point, rectangle, array, and definitions structures. Unknown attributes, style keys, custom elements and user-object wrappers remain open by design: Draw.io's shape and stencil ecosystem is extensible, so a closed shape/style whitelist would reject valid files. DTD and custom entity declarations are rejected; parsing is performed through `@xmldom/xmldom` in both browser and server code. A document that validates as native Draw.io XML can still be ineligible for Studio semantic editing when its projection cannot be proven lossless; this does not prevent preserving its source XML.

Validation is grounded in the [Draw.io File Format](https://github.com/jgraph/drawio/wiki/File-Format), [Graph Model](https://github.com/jgraph/drawio/wiki/Graph-Model), and the format handling in the upstream [drawio repository](https://github.com/jgraph/drawio), including `Editor.extractGraphModel`, page handling and mxCell/user-object codecs.

The upstream implementation is intentionally more extensible than a closed XSD-style model: `mxCellCodec` normalizes user-object wrappers, `mxModelCodec` handles the root-cell sequence and optional style compression, and page handling decodes individual pages. This Zod contract validates core invariants while keeping unknown attributes, child elements, shape names and style keys opaque. It is not a whitelist of all possible draw.io shapes.

## Copilot sessions and server-side audit logs

The complete native Draw.io `mxfile` XML is the single source of truth for every diagram. `DiagramDocument` is a derived, in-memory partial semantic projection for Studio's C4, flowchart and sequence features; it is not written to `workspace.json`, `diagram-versions.json`, or browser local storage. On startup the server validates and loads the XML, then rebuilds the projection; Draw.io autosaves and Studio cell patches send only XML to `PUT /api/workspace/document`. Each version snapshot persists the complete `.drawio` XML; projections are regenerated when version history is read. Version history is append-only and stored in `~/.architecture-diagram-studio/data/diagram-versions.json`; the current workspace is in `workspace.json`. Use `GET /api/workspace/versions` for the lightweight index, `GET /api/workspace/versions/:id` to fetch a complete snapshot, and `POST /api/workspace/versions/:id/restore` to restore one as a new version.

The Copilot session ID and chat transcript are persisted through `PUT /api/workspace/chat`; the SDK session is resumed when its stored state is available. Application events are appended to `~/.architecture-diagram-studio/data/application-events.jsonl` and are loaded by Agent 轨迹. Layout intent interpretation and deterministic layout computation run through server endpoints, and server-side validation/version persistence are authoritative; the browser remains responsible for interactive rendering and confirmation for proposals that require review. Detailed Copilot SDK lifecycle events, user request text, diagram context submitted with the request, tool calls, final plans, timings, responses, and errors are appended to `~/.architecture-diagram-studio/logs/copilot-sessions.jsonl`. The current implementation does not log the entire assembled workspace-context payload as one field. `GET /api/copilot/sessions` lists live sessions; `GET /api/copilot/sessions/:id/logs` returns the full persisted log for one session; `GET /api/workspace/logs` returns application events. Set `STUDIO_DATA_DIR`, `COPILOT_LOG_DIR`, or `COPILOT_SESSION_IDLE_TTL_MS` to customize storage and session cleanup. These files may contain complete diagrams, XML, prompts, and context, so treat them as local application data.

## UI component system

The V2 workspace uses `antd` for shared enterprise controls and theme tokens, with `@ant-design/x` for AI conversation bubbles and the `Sender` composer. The provider setup follows the pattern used by `saga/agentic-data-architect` (`ConfigProvider` with Simplified Chinese locale, `XProvider`, and Ant Design's app context). The primary color is aligned with Studio's existing indigo palette; the diagram canvas and native Draw.io renderer remain domain-specific components rather than being replaced by generic UI widgets.

## Workspace pages and diagnostics

The top navigation separates **Diagram**, **Layout Copilot**, **Agent 轨迹**, and **配置**. Copilot has a dedicated conversation page; proposed layout changes remain previews until applied. The trace page reads structured application events from the server and includes request phases, layout timings, Draw.io initialization, imports/exports, and runtime errors. This application log is separate from the full Copilot SDK session audit log.

Browser diagnostics are sent to the local server and persisted as application events. The UI telemetry redacts credential-like fields; server Copilot audit logs retain user request text and the submitted diagram context, while native Draw.io XML is preserved in document version snapshots. Treat local logs and snapshots as potentially sensitive project data.

### Draw.io initialization troubleshooting

The native iframe waits for the Draw.io embed API's `init` event before sending the XML document. The iframe's browser `load` event alone does not mean the editor API is ready. If initialization does not finish, the editor shows a timeout with a retry action. In the **配置** page, use **检查本地 Draw.io** to verify `/drawio/studio-bundle.json` and `/drawio/index.html`; then review `drawio.handshake.*` and `drawio.init.timeout` entries in Agent 轨迹 alongside the terminal output.

## Interface themes and native editor interaction

The header's theme selector switches among **经典编辑室**, **青春鲜艳**, **暖色纸感**, and **午夜深色**. The selection is stored locally in the browser. The theme adapter changes the native editor chrome and graph background only; it does not recolour existing cell styles.

The embedded Draw.io editor owns selection, dragging, panning, connector editing, undo/redo, and native shape-specific interactions. The right-side Properties panel reads the selected cell from the native editor and exposes supported editable fields; unsupported or structurally sensitive attributes remain visible as read-only values. Layout algorithms operate separately on the derived semantic projection and must not run automatically when a file is opened.

The native Draw.io iframe starts with the shape sidebar, Format panel, and floating windows hidden using the supported `sidebar=0`, `format=0`, and `windows=0` URL options. Users can still use Draw.io's menus to open panels when needed.

The main-lane flow layout keeps primary workflow steps aligned, places exception steps near the segment they branch from, and centres labels inside decision diamonds. Wide flowcharts are top-aligned in the native canvas rather than vertically centred in excess whitespace.


## Versioned Studio configuration

The Settings page exposes the server-supported automatic layout algorithm allowlist, all natural-language Copilot prompt surfaces, model ID, and reasoning effort. Configuration is stored on the server and each save appends a complete snapshot—including every algorithm option, every prompt, model ID, and reasoning effort—to `studio-config-history.jsonl` under `STUDIO_DATA_DIR`; each line includes revision ID, timestamp, actor, and change summary. The active configuration is the latest valid record, and legacy records are loaded with defaults for newly introduced fields. The previous browser-only model preference is migrated into the server history when no configuration revision exists. Endpoints: `GET/PUT /api/workspace/configuration` and `GET /api/workspace/configuration/history`. After a configuration revision, model, or reasoning-effort change, the next Copilot request uses a separate SDK session; superseded sessions are disconnected after their active turn finishes. Configuration history is append-only, but restoring an older configuration revision from the UI is not implemented yet. Diagram-specific layout selection remains part of the diagram document and is separately versioned with the document/Draw.io XML.

ADR: [0004 — Versioned Studio configuration in JSONL](../docs/adr/0004-versioned-studio-configuration-jsonl.md).

## Server-authoritative diagram operations

Deterministic diagram operations run through the HTTP server so the UI and the Studio's internal Copilot Agent workflow share the same implementation. These routes and SDK tools are internal server capabilities, not externally registered MCP tools. Focused edits explicitly requested by the user can be applied directly by Copilot after inspecting the active revision; the server rejects stale revisions, validates the applicable XML/semantic contract, and creates an immutable version before returning success. Semantic layout-quality gates apply to operations that use semantic layout. Broad or ambiguous changes continue through a reviewable proposal and explicit confirmation. The server currently provides:

- `POST /api/workspace/layout`: Dagre/ELK layout, route generation, and overlap repair.
- `POST /api/workspace/diagram/quality`: layout quality scoring.
- `POST /api/workspace/diagram/move-node`: snapped node placement, collision avoidance, lock hints, and relation routing.
- `POST /api/workspace/diagram/normalize-sequence`: sequence-document normalization.
- `POST /api/workspace/diagram/export-drawio`: export the active authoritative Draw.io XML; it does not rebuild XML from the semantic projection.
- `POST /api/workspace/intent/apply`: deterministic intent-to-document mutation.
- `GET /api/workspace/diagram/active`: the current XML source, its XML-based revision hash, and a derived semantic projection for internal Agent operations.
- `POST /api/workspace/diagram/proposals` and `POST /api/workspace/diagram/apply-proposal`: revision-bound, validated Agent edits with immutable version snapshots.
- `GET /api/workspace/diagram/templates` and `POST /api/workspace/diagram/apply-template`: built-in semantic templates, with confirmation and version creation.
- `POST /api/workspace/diagram/restore-version`: confirmed version restoration.

These endpoints support the Studio UI and internal Agent workflow. The application does not expose these diagram-specific operations through a standalone MCP server.

The React UI requests server-side layout scoring, node movement, sequence normalization, and XML generation. It still owns native editor interaction and temporary preview state; explicit confirmation is required for proposals that need review. Draw.io XML import parsing remains browser-side because the current parser depends on DOM APIs; moving it requires a portable parser implementation. The underlying domain modules are intentionally reused rather than duplicated in a second server-only implementation.

ADR: [0003 — Server-authoritative diagram operations](../docs/adr/0003-server-authoritative-diagram-operations.md).

## Project workspace

On first launch, configure a project workspace by entering the absolute directory path on the machine running the Node.js server. The server resolves a selected subdirectory to the enclosing Git repository root when `.git` metadata is present; a non-Git directory remains the root. It then indexes project files with a preference for `.drawio` diagrams, source code, Markdown, README, and ADR files. Use the primary-diagram selector to identify the diagram that should anchor project analysis. The workspace definition is server-authoritative JSON at `~/.architecture-diagram-studio/data/project-workspace.json` (or `$STUDIO_DATA_DIR/project-workspace.json`); its schema is documented in [`v2/schemas/project-workspace.schema.json`](./schemas/project-workspace.schema.json).

The HTTP service exposes `GET/PUT /api/workspace/config`, `GET /api/workspace/files`, `GET /api/workspace/files/content?path=<workspace-relative-path>`, and `GET /api/workspace/agent-context`. File reads are bounded and reject paths outside the configured root. The Copilot Agent receives workspace metadata plus a bounded prioritized context of diagrams, source code, and documents on every turn. The selected workspace is a project boundary, not a copy of the repository; project files remain in place. When the configured primary diagram is a `.drawio`, `.dio`, or `.xml` file, autosave writes the exact native XML back to that project file after creating a server-side version snapshot. Version history is scoped by workspace ID, so switching projects does not mix their histories.

### Internal Copilot Agent tools

Diagram intelligence is implemented as internal Studio capabilities registered through the GitHub Copilot SDK in the Studio server. There is no standalone MCP server or VS Code MCP registration. Internal tools provide design references, active diagram inspection, authoritative quality evaluation, bounded workspace-example search, semantic edit proposals, template previews, version listing/diffs, and restore proposals. Mutations are revision-bound and server-validated. Broad or ambiguous mutations use reviewable previews; focused changes explicitly requested by the user may apply directly after inspection. Every successful mutation receives a version snapshot.

The server retains the latest 100 diagram snapshots per workspace and at most 500 snapshots globally by default. Set `STUDIO_MAX_DIAGRAM_VERSIONS_PER_WORKSPACE` (10–500) and `STUDIO_MAX_TOTAL_DIAGRAM_VERSIONS` (100–5000) to adjust retention. On startup, older history is compacted on disk so storage does not depend on a future edit. Autosave compares a server-issued SHA-256 revision of the exact authoritative Draw.io XML; the derived `DiagramDocument` cache does not participate in revision identity. Stale saves receive HTTP 409 instead of overwriting a newer XML source.

Related decisions: [ADR 0001](../docs/adr/0001-project-workspace-as-authoritative-context.md) defines the authoritative workspace model; [ADR 0002](../docs/adr/0002-workspace-aware-mcp-and-agent-skill.md) defines workspace-grounded Agent behavior; [ADR 0005](../docs/adr/0005-diagram-aware-mcp-intelligence.md) defines internal Copilot tools and governed edits.
