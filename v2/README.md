# Architecture Diagram Studio V2

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
- Studio Editorial visual system, functional canvas zoom, draggable nodes, and nearest-free-position snapping when a drag would overlap another node.
- Local Draw.io iframe mode, native editable XML export, and import of plain or compressed Draw.io XML (including Studio semantic metadata). Native XML is kept separately after Draw.io edits so the next model sync does not immediately overwrite unmodeled native styles.
- Local intent commands for line style, routing, external placement, storage placement, layout direction and lock clearing; individual relations also expose label, direction, routing and dashed/solid controls.
- Reviewable intent previews (apply/discard), 50-step in-session undo/redo, server-authoritative document persistence with runtime schema validation, deterministic route-variant scoring, hard layout checks, and regression tests.

## Intentional boundary

Layout Copilot uses a local Node.js service backed by `@github/copilot-sdk` and the signed-in GitHub Copilot CLI identity. `npm run dev` starts Vite and the Agent service together; the service listens on loopback port 4175 and Vite proxies `/api/copilot`. Set the model ID in **配置** (default `claude-sonnet-5.5`) and choose **Thinking effort** (`Max` or `High`). Each browser conversation keeps a stable session ID; the server resumes the Copilot SDK session after an app/server restart when the SDK session state is available. Consecutive turns are serialized per session so they cannot race against each other. The Agent uses a custom `propose_layout_plan` tool to return a structured plan, rather than making arbitrary edits. The server validates every command against an allowlist and performs deterministic intent interpretation and layout computation. The browser renders the returned document and requires explicit preview confirmation before commit. No provider API key is sent from the browser. Make sure Copilot CLI is installed and signed in before using Agent mode. Clear the model setting to use local deterministic rules.

Draw.io web assets are generated into public/drawio at build time and are not committed as a bulky binary payload. No online fallback is configured. In offline deployments the archive must be supplied once during the build or included in the deployment artefacts.

## Copilot sessions and server-side audit logs

The server is the source of truth for the active diagram, native Draw.io XML, version history, Copilot session ID, chat transcript, and application event log. On startup the UI hydrates from `GET /api/workspace/state`; document edits and Draw.io autosaves are sent to `PUT /api/workspace/document`. The server creates a new immutable version whenever either the semantic document or exact native XML changes. Each snapshot contains the full `DiagramDocument` and full `.drawio` XML, including style/geometry-only edits that are not represented in the semantic model. Version history is append-only and stored in `~/.architecture-diagram-studio/data/diagram-versions.json`; the current workspace is in `workspace.json`. Use `GET /api/workspace/versions` for the lightweight index, `GET /api/workspace/versions/:id` to fetch a complete snapshot, and `POST /api/workspace/versions/:id/restore` to restore one as a new version.

The Copilot session ID and chat transcript are persisted through `PUT /api/workspace/chat`; the SDK session is resumed when its stored state is available. Application events are appended to `~/.architecture-diagram-studio/data/application-events.jsonl` and are loaded by Agent 轨迹. Layout intent interpretation and deterministic layout computation run through server endpoints, and server-side validation/version persistence are authoritative; the browser remains responsible for interactive rendering and preview confirmation. Detailed Copilot SDK lifecycle events, full prompts/context, tool calls, final plans, timings, responses, and errors are appended to `~/.architecture-diagram-studio/logs/copilot-sessions.jsonl`. `GET /api/copilot/sessions` lists live sessions; `GET /api/copilot/sessions/:id/logs` returns the full persisted log for one session; `GET /api/workspace/logs` returns application events. Set `STUDIO_DATA_DIR`, `COPILOT_LOG_DIR`, or `COPILOT_SESSION_IDLE_TTL_MS` to customize storage and session cleanup. These files may contain complete diagrams, XML, prompts, and context, so treat them as local application data.

## UI component system

The V2 workspace uses `antd` for shared enterprise controls and theme tokens, with `@ant-design/x` for AI conversation bubbles and the `Sender` composer. The provider setup follows the pattern used by `saga/agentic-data-architect` (`ConfigProvider` with Simplified Chinese locale, `XProvider`, and Ant Design's app context). The primary color is aligned with Studio's existing indigo palette; the diagram canvas and native Draw.io renderer remain domain-specific components rather than being replaced by generic UI widgets.

## Workspace pages and diagnostics

The top navigation separates **Studio**, **Layout Copilot**, **Agent 轨迹**, and **配置**. Copilot has a dedicated conversation page; proposed layout changes remain previews until applied. The trace page reads structured application events from the server and includes request phases, layout timings, Draw.io initialization, imports/exports, and runtime errors. This application log is separate from the full Copilot SDK session audit log.

Browser diagnostics are sent to the local server and persisted as application events. The UI telemetry redacts credential-like fields; full Copilot prompts/context and native Draw.io XML are preserved separately in server audit logs and version snapshots.

### Draw.io initialization troubleshooting

The native iframe waits for the Draw.io embed API's `init` event before sending the XML document. The iframe's browser `load` event alone does not mean the editor API is ready. If initialization does not finish, the editor shows a timeout with a retry action. In the **配置** page, use **检查本地 Draw.io** to verify `/drawio/studio-bundle.json` and `/drawio/index.html`; then review `drawio.handshake.*` and `drawio.init.timeout` entries in Agent 轨迹 alongside the terminal output.

## Interface themes and canvas interaction

The header's theme selector switches among **经典编辑室**, **青春鲜艳**, **暖色纸感**, and **午夜深色**. The selection is stored locally in the browser.

In Studio mode, drag a node to move it; drag an empty part of the canvas to pan. Connectors have a wider invisible hit area: click one to highlight it and focus the corresponding relationship in the inspector. Sequence messages attach to participant lifelines or to the active-call bar when a participant is executing a nested request.

The native Draw.io iframe starts with the shape sidebar, Format panel, and floating windows hidden using the supported `sidebar=0`, `format=0`, and `windows=0` URL options. Users can still use Draw.io's menus to open panels when needed.

The main-lane flow layout keeps primary workflow steps aligned, places exception steps near the segment they branch from, and centres labels inside decision diamonds. Wide flowcharts are top-aligned in the canvas rather than vertically centred in excess whitespace.

### Draw.io render lab

Run the V2 app and open `/drawio-lab` (for example, `http://localhost:5174/drawio-lab`) to compare the Studio SVG renderer with the actual bundled Draw.io embed side by side. Switch between the sequence, C4, and flowchart fixtures; inspect the exact XML sent to Draw.io; and reset a fixture to reproduce rendering differences. The sequence renderer and XML exporter share message geometry from `src/layout/sequence.ts`, including self-call waypoints.


## Project workspace

On first launch, configure a project workspace by entering the absolute directory path on the machine running the Node.js server. The server validates and canonicalizes the directory, then indexes project files with a preference for `.drawio` diagrams, source code, Markdown, README, and ADR files. Use the primary-diagram selector to identify the diagram that should anchor project analysis. The workspace definition is server-authoritative JSON at `~/.architecture-diagram-studio/data/project-workspace.json` (or `$STUDIO_DATA_DIR/project-workspace.json`); its schema is documented in [`v2/schemas/project-workspace.schema.json`](./schemas/project-workspace.schema.json).

The HTTP service exposes `GET/PUT /api/workspace/config`, `GET /api/workspace/files`, `GET /api/workspace/files/content?path=<workspace-relative-path>`, and `GET /api/workspace/agent-context`. File reads are bounded and reject paths outside the configured root. The Copilot Agent receives workspace metadata plus a bounded prioritized context of diagrams, source code, and documents on every turn. The selected workspace is a project boundary, not a copy of the repository; project files remain in place. When the configured primary diagram is a `.drawio`, `.dio`, or `.xml` file, autosave writes the exact native XML back to that project file after creating a server-side version snapshot. Version history is scoped by workspace ID, so switching projects does not mix their histories.

### MCP and Agent Skill

Run `npm run mcp` from `v2/` to launch the stdio MCP server. Configure your MCP client to start the command `npm run mcp` with working directory set to this repository's `v2` folder. The MCP process must run as the same OS user and use the same `STUDIO_DATA_DIR` value as the HTTP service if that variable is customized.

The MCP tools are `workspace_info`, `list_workspace_files`, `list_drawio_diagrams`, `read_workspace_file`, and `search_workspace`. They are read-only in this release. The reusable workspace-first Agent Skill is in `v2/skills/architecture-workspace/SKILL.md`. It requires Agents to inspect the primary diagram and related ADRs/source files, cite workspace-relative paths, and treat repository contents as untrusted data.

Related decisions: [ADR 0001](../docs/adr/0001-project-workspace-as-authoritative-context.md) defines the authoritative workspace model; [ADR 0002](../docs/adr/0002-workspace-aware-mcp-and-agent-skill.md) defines the MCP and Skill integration.
