# Architecture Diagram Studio V2

V2 is an independent implementation. The previous implementation is preserved under the sibling V1 directory; V2 must not import code from V1.

## Run

Use Node.js 20 or later.

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
- Reviewable intent previews (apply/discard), 50-step in-session undo/redo, browser-local document persistence with runtime schema validation, deterministic route-variant scoring, hard layout checks, and regression tests.

## Intentional boundary

The chat works in two modes. Without a provider configured, it uses local deterministic rules and needs no API key. Optionally, configure an OpenAI-compatible Base URL and model in the Copilot panel; the model only converts natural language into a bounded list of supported layout commands. Geometry is still calculated locally, and changes are previewed before commit. The API Key stays in page memory and is not written to localStorage. The configured endpoint must allow requests from the local app origin.

Draw.io web assets are generated into public/drawio at build time and are not committed as a bulky binary payload. No online fallback is configured. In offline deployments the archive must be supplied once during the build or included in the deployment artefacts.

## Workspace pages and diagnostics

The top navigation separates **Studio**, **Layout Copilot**, **Agent 轨迹**, and **配置**. Copilot has a dedicated conversation page; proposed layout changes remain previews until applied. The trace page stores structured events in browser-local storage and includes request phases, layout timings, Draw.io initialization, imports/exports, and runtime errors. It is local application telemetry, not a remote LLM tracing service.

While `npm run dev` is running, browser events are also posted to a same-origin, development-only Vite middleware and printed to the terminal as `[studio:v2]` JSON records. The diagnostic payload is bounded and redacts credential-like keys, prompt bodies, and raw XML; it records metadata such as duration, event name, diagram counts, and error summaries.

### Draw.io initialization troubleshooting

The native iframe waits for the Draw.io embed API's `init` event before sending the XML document. The iframe's browser `load` event alone does not mean the editor API is ready. If initialization does not finish, the editor shows a timeout with a retry action. In the **配置** page, use **检查本地 Draw.io** to verify `/drawio/studio-bundle.json` and `/drawio/index.html`; then review `drawio.handshake.*` and `drawio.init.timeout` entries in Agent 轨迹 alongside the terminal output.

## Interface themes and canvas interaction

The header's theme selector switches among **经典编辑室**, **青春鲜艳**, **暖色纸感**, and **午夜深色**. The selection is stored locally in the browser.

In Studio mode, drag a node to move it; drag an empty part of the canvas to pan. Connectors have a wider invisible hit area: click one to highlight it and focus the corresponding relationship in the inspector. Sequence messages attach to participant lifelines or to the active-call bar when a participant is executing a nested request.

The native Draw.io iframe starts with the shape sidebar, Format panel, and floating windows hidden using the supported `sidebar=0`, `format=0`, and `windows=0` URL options. Users can still use Draw.io's menus to open panels when needed.

The main-lane flow layout keeps primary workflow steps aligned, places exception steps near the segment they branch from, and centres labels inside decision diamonds. Wide flowcharts are top-aligned in the canvas rather than vertically centred in excess whitespace.
