# Architecture Diagram Studio V2

## Run

Requires Node.js 22.13 or later. From `v2/` run:

```sh
npm install
npm run dev
```

V2 bundles the pinned Draw.io v32.0.2 editor locally. It does not use the hosted embed. `npm run dev` starts Vite, the loopback Copilot API, and a dedicated loopback Draw.io static server (default port 4176). Draw.io runs on a separate origin inside a sandboxed iframe; CSP permits requests to its own origin for local assets but blocks cross-origin `fetch`/XHR/WebSocket-style connections and remote image loads. The separate origin prevents scripts from reading the Studio parent DOM or calling the Studio API origin. This is browser-origin isolation, not an OS-level sandbox: browser navigation itself is not restricted by CSP, so only use trusted local model providers/scripts for diagrams containing sensitive data. The paired `STUDIO_DRAWIO_PORT` and `VITE_STUDIO_DRAWIO_PORT` settings must match.

## One diagram model

The original native Draw.io `mxfile` XML is the only diagram model. The embedded Draw.io editor owns the canvas, selection, geometry, styles, connectors, pages, undo/redo and serialization. V2 has no parallel `DiagramDocument`, semantic graph, model-to-XML exporter or proposal-preview graph.

Opening, importing, versioning, restoring and exporting keep native Draw.io XML as the source of truth. V2 never rebuilds a document from a reduced model. Supported edits must preserve unrelated pages, cells, relationships, wrappers, custom shapes, HTML labels and vendor-specific attributes.

## Draw.io diagram color presets

The top-bar Diagram colors selector offers ten curated palettes based on established theme-design references. They style nodes, category fills/strokes, text and connectors while **leaving the canvas background unset**. The canvas should support the diagram, not compete with its blocks; white/default space is intentional, not a missing theme option. Node fills are now medium-toned rather than near-white: automated checks require at least 1.75:1 fill-to-white contrast, 3:1 outlines against both canvas and fill, and 4.5:1 connector/label contrast. Applying a preset removes the active page's explicit background attribute, including a prior custom or legacy pastel tint. Source colors establish stable roles stored as `studioColorRole`; later switches reuse those roles rather than inferring categories from theme colors. Text-only cells remain unfilled and outline-only shapes remain outlines. More than eight distinct source categories fails closed rather than merging colors. Background clearing and cell colors share one revision-bound Draw.io Undo/Redo transaction; Undo restores the exact previous background, and grid settings and other pages remain unchanged. See [ADR-0023](../docs/adr/0023-category-preserving-curated-diagram-palettes.md).

## Runtime storage scope

V2 resolves all runtime persistence paths through `v2/server/storage-layout.ts`. Workspace state, version history, application/agent logs and Copilot SDK state live under `~/.architecture-diagram-studio/workspaces/<workspace-key>/`; single-file mode uses `~/.architecture-diagram-studio/{data,logs,copilot}/`. Switching scope invalidates in-memory state/version caches and resets the SDK client before the next operation. The workspace registry and model/settings revision history remain global under `~/.architecture-diagram-studio/data/`.

Legacy workspace state and logs are copied only when their records explicitly identify that workspace. Existing global files are kept as recovery sources. `STUDIO_HOME`, `STUDIO_GLOBAL_DATA_DIR`, `STUDIO_DATA_DIR`, `COPILOT_LOG_DIR` and `COPILOT_HOME` remain operator/test overrides. See [ADR-0017](../docs/adr/0017-unified-runtime-storage-scope.md).

## Studio-owned automatic layout — core feature

Automatic layout is calculated in Studio using ELK, Dagre, Graphviz WASM, MSAGL.js, Cytoscape.js and D3 adapters; V2 does not call Draw.io's built-in `action: "layout"`. `src/layout/native-layout.ts` derives a temporary, per-operation projection from the selected page's native mxCells, calculates positions and connector waypoints, and returns a revision/page-bound plan. The bridge validates current cell IDs, geometry and connector endpoints before applying only native geometry changes through the Draw.io model. It never converts the full document to another saved model.

The toolbar exposes ELK, Dagre, Graphviz, MSAGL.js, Cytoscape.js and D3 layouts. ELK provides Layered, Mr. Tree, Radial, Stress, Force, Box, Fixed, Rectangle Packing, Random, SPOrE Overlap and SPOrE Compaction (Box/Rectangle Packing are restricted to diagrams without connectors; Fixed preserves absolute node coordinates and uses temporary edge sections; SPOrE optimizes existing positions). DisCo is absent from the installed elkjs 0.12.0 algorithm registry, so it is not offered. Dagre provides directed layered placement; Graphviz provides dot/neato/fdp/sfdp/circo/twopi; MSAGL.js provides layered, MDS and IPSepCola; Cytoscape.js provides breadth-first/circle/concentric/grid/random/CoSE and the fCoSE extension; D3 provides tree/cluster/force. All engines calculate against a temporary native-cell projection and only the resulting node geometry and connector waypoints are applied by the native Draw.io bridge. Settings persist in this browser. The planner resolves the graph root and layers from native parent relationships; conventional IDs `0` and `1` are preferred when present, but generated/prefixed IDs are valid too. If there is no conventional default layer, a sole visible layer can be selected directly. If the default is empty and exactly one other visible layer contains layoutable content, it uses that layer and reports the fallback; it does not guess between multiple populated layers. Other pages, unselected layers, nested group contents, and nonstandard cells remain unchanged.

The embedded Draw.io shape library panel is enabled by default, and its initial library list includes C4 alongside General, UML, ER, BPMN, Flowchart, Basic and Arrows. Users do not need to enable C4 manually from More Shapes. Copilot does not use a separate typed mutation operation for layout; it uses the XML-first edit path for explicit cell changes. Toolbar auto layout remains Studio-owned and uses the existing geometry planner and native editor bridge. See [ADR-0013](../docs/adr/0013-studio-owned-layout-engines.md).

## Extension points for future native capabilities

V2 retains native XML page/cell indexing for target resolution and a small read-only analysis contract used by the spatial-region analyzer. There is no generic operation-provider registry. Copilot diagram mutations use the server-side `edit_drawio_xml` tool; Studio-owned automatic layout remains a separate concrete geometry planner. See [ADR-0012](../docs/adr/0012-native-diagram-extension-contracts.md).

## Copilot XML editing

Copilot edits the authoritative native Draw.io XML directly on the server through one revision-bound patch path. The server validates the source revision, applies the focused patch, validates the resulting XML, checks the before/after diff, persists a new version and emits a document-change notification. The frontend loads that exact persisted revision and updates its revision baseline; stale editor state must never overwrite a newer server revision. Standalone mode receives a validated patch and writes it through the browser's selected file handle. See [ADR-0026](../docs/adr/0026-server-side-xml-first-copilot-editing.md).

The `run_drawio_script` tool, `propose_native_edits`, the typed Copilot edit contract, browser-side Copilot mutation dispatch, and their proposal/confirmation/acknowledgement paths are removed. Copilot diagram mutations use only `edit_drawio_xml`; selection and read-only inspection remain separate tools. Copilot edits do not execute model-authored JavaScript inside the Draw.io iframe.

Native Draw.io `mxfile` XML remains the sole diagram model; there is no reduced shadow graph or XML reconstruction. The current design and implementation contract is [ADR-0026](../docs/adr/0026-server-side-xml-first-copilot-editing.md). ADR-0018 is retired history.


## Copilot session permission and authentication callbacks

Every Studio session config registers `onPermissionRequest` and `onMcpAuthRequest` before either `resumeSession` or `createSession` is called. Missing permission handlers can leave SDK permission requests pending while the caller waits for `sendAndWait`; a returned `session.idle` event is not a substitute for registering the policy callback or resolving the pending permission RPC.

The current `approve-once` decision is application-specific: the client runs in `mode: "empty"`, and the session only exposes Studio-owned custom tools rather than ambient shell or filesystem tools. Do not move this approval decision into the shared runtime as a default. If the available tools or their side effects change, review this policy alongside the server-side operation allowlist and revision/version checks.

If a permission request carries `managedApprovalRequired`, or the SDK invocation says managed settings are enabled, Studio returns `user-not-available`. There is no managed-approval UI or broker, so it must fail closed rather than auto-approve or return `no-result` and leave the request pending.

Studio has no MCP OAuth UI or token broker, so the application explicitly cancels MCP authentication requests and emits a diagnostic event. Both callbacks schedule logging without awaiting it. Logging must not stall the SDK handshake, and even a synchronous logger exception must not escape from the callback.

The reusable interface and integration rules are documented in [common-agent-lib's Copilot runtime](https://github.com/saga/common-agent-lib/tree/main/packages/copilot-agent-runtime); the library exposes callback types but intentionally does not import Studio's policy.

## Persistence, versions and XML validation

Workspace and version state contain native XML and metadata, not a derived graph object. Workspace saves include the server-issued SHA-256 revision of the exact XML. A stale revision is rejected with HTTP 409. Server history keeps a small metadata index and immutable per-version XML files; retention is capped by both version count and byte budgets. Legacy entries without native XML are skipped rather than regenerated from a lossy model.

The shared Zod schema validates native `mxfile`, bare `mxGraphModel`, supported compressed pages, geometry and shape-library formats. It intentionally leaves unknown attributes, styles, wrapper elements and custom cell types open. Malformed XML and DTD/custom entity declarations are rejected. Schema validation checks the source format; it does not require the file to fit a Studio-specific shape taxonomy.

Standalone files can be opened without configuring a workspace. Standalone open/import/export uses the browser’s native File System Access API: `showOpenFilePicker()` and `FileSystemFileHandle.getFile()` read the selected XML, and `createWritable()` writes the source file. The browser keeps the handle and does not send the source path to Node.js. Before each write Studio compares the current file’s SHA-256 with the last observed revision and blocks obvious external modifications; this is best-effort detection, because the browser API does not provide atomic compare-and-swap. Node.js only validates and stores standalone XML history snapshots under `~/.architecture-diagram-studio/data/standalone-history/`, keyed by an opaque document ID, capped at 100 entries and 128 MiB per diagram. If snapshot sync fails after the source was saved, the UI reports the two outcomes separately. Standalone file access requires a supported Chromium-based desktop browser. A configured project workspace is unchanged: Node.js owns its fs reads/writes, revision checks and version history.

## Settings and Agent Traces

Settings exposes Low, Medium, High and Max reasoning effort; new configurations default to Medium for routine diagram edits. The browser intent request and server overall Copilot turn deadline are both 300000 ms (five minutes). The server deadline is configurable with `STUDIO_COPILOT_TURN_TIMEOUT_MS` and accepts `10000`–`900000` milliseconds; the same overall deadline covers the first model call and fallback retry. `STUDIO_COPILOT_TURN_IDLE_TIMEOUT_MS` defaults to `90000` (90 seconds without meaningful SDK progress; accepted range `10000`–`300000` milliseconds). The idle watchdog is refreshed by reasoning/text/tool-argument deltas and meaningful tool/turn transitions, but the overall deadline remains a hard cap. Copilot edits use the server-side XML-first path. Existing confirmation policy for whole-page automatic layout and other typed deterministic workflows remains as currently implemented; script-specific confirmation settings are removed with the script tool. New SDK sessions enable automatic context compaction at 75% context utilization, with a 90% buffer-exhaustion threshold; existing persisted sessions keep their original session configuration. Terminal output and Agent Traces include compact call-start, call-end and five-second progress summaries without copying raw streamed delta text into terminal summaries. SDK event summaries remain in the local JSONL trace (individual event details are length-limited). Restart the local Copilot server after changing the environment file. Provider credentials stay in the local runtime environment; they are not sent from the browser. Sign in with the GitHub Copilot CLI or configure a supported local provider before using Copilot.

Agent Traces shows application events, SDK lifecycle, model calls and any token/cost/context usage reported by the SDK or provider. Missing counters are not estimated. Context-window occupancy is a snapshot, not tokens consumed. Local logs and history may include project labels, prompts and diagram data, so treat them as project data.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e -- e2e/02-canvas.spec.ts
```

The V2 GitHub Actions workflow runs typecheck, unit tests, a production build with the pinned Draw.io bundle, and native canvas E2E checks. Check the result of the latest run before treating a commit as validated.
