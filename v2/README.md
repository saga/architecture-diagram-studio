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

The top-bar Diagram colors selector applies a named palette directly to native Draw.io XML. Vertices receive fill, stroke and font colors; connectors receive stroke and font colors. Existing colors are intentionally overwritten when a preset is chosen, while non-color style properties, labels, geometry, edges, page backgrounds and grid settings remain unchanged. Compressed and uncompressed pages are supported. The selector does not switch Studio's own UI theme, and Draw.io remains responsible for rendering its native page background and grid. Preset changes use the same workspace or standalone-file save and history path as other document edits; see [ADR-0020](../docs/adr/0020-native-drawio-diagram-theme-presets.md).

## Runtime storage scope

V2 resolves all runtime persistence paths through `v2/server/storage-layout.ts`. Workspace state, version history, application/agent logs and Copilot SDK state live under `~/.architecture-diagram-studio/workspaces/<workspace-key>/`; single-file mode uses `~/.architecture-diagram-studio/{data,logs,copilot}/`. Switching scope invalidates in-memory state/version caches and resets the SDK client before the next operation. The workspace registry and model/settings revision history remain global under `~/.architecture-diagram-studio/data/`.

Legacy workspace state and logs are copied only when their records explicitly identify that workspace. Existing global files are kept as recovery sources. `STUDIO_HOME`, `STUDIO_GLOBAL_DATA_DIR`, `STUDIO_DATA_DIR`, `COPILOT_LOG_DIR` and `COPILOT_HOME` remain operator/test overrides. See [ADR-0017](../docs/adr/0017-unified-runtime-storage-scope.md).

## Studio-owned automatic layout — core feature

Automatic layout is calculated in Studio using ELK, Dagre, Graphviz WASM, MSAGL.js, Cytoscape.js and D3 adapters; V2 does not call Draw.io's built-in `action: "layout"`. `src/layout/native-layout.ts` derives a temporary, per-operation projection from the selected page's native mxCells, calculates positions and connector waypoints, and returns a revision/page-bound plan. The bridge validates current cell IDs, geometry and connector endpoints before applying only native geometry changes through the Draw.io model. It never converts the full document to another saved model.

The toolbar exposes ELK, Dagre, Graphviz, MSAGL.js, Cytoscape.js and D3 layouts. ELK provides Layered, Mr. Tree, Radial, Stress, Force, Box, Fixed, Rectangle Packing, Random, SPOrE Overlap and SPOrE Compaction (Box/Rectangle Packing are restricted to diagrams without connectors; Fixed preserves absolute node coordinates and uses temporary edge sections; SPOrE optimizes existing positions). DisCo is absent from the installed elkjs 0.12.0 algorithm registry, so it is not offered. Dagre provides directed layered placement; Graphviz provides dot/neato/fdp/sfdp/circo/twopi; MSAGL.js provides layered, MDS and IPSepCola; Cytoscape.js provides breadth-first/circle/concentric/grid/random/CoSE and the fCoSE extension; D3 provides tree/cluster/force. All engines calculate against a temporary native-cell projection and only the resulting node geometry and connector waypoints are applied by the native Draw.io bridge. Settings persist in this browser. The first implementation lays out top-level vertices and connectors in the default layer; other pages, layers and nested group contents remain unchanged.

The embedded Draw.io shape library panel is enabled by default, and its initial library list includes C4 alongside General, UML, ER, BPMN, Flowchart, Basic and Arrows. Users do not need to enable C4 manually from More Shapes. Copilot uses the same typed `auto_layout` operation and Studio planner as the toolbar. Whole-page layouts always require explicit confirmation and cannot be combined with unrelated edits in one batch. The bridge rejects stale cell sets or geometry and attempts to restore prior geometry if mutation fails. See [ADR-0013](../docs/adr/0013-studio-owned-layout-engines.md).

## Extension points for future native capabilities

V2 intentionally does not ship the legacy semantic graph, DiagramDocument-based layout pipeline, or semantic quality pipeline. It preserves a small extension contract in `src/model/native-diagram-capabilities.ts` for additional native editing and analysis features without porting the old renderer or introducing a parallel model:

- `NativeDiagramOperationProvider` receives the authoritative XML, base revision, active page, selection and a lightweight native-cell index, and returns a plan using the shared `NativeEditOperation` vocabulary.
- `NativeDiagramAnalysisProvider` returns read-only findings (for example geometry, routing, contrast or accessibility diagnostics) keyed by native page/cell IDs.
- `NativeDiagramCapabilityRegistry` is an interface for explicit capability discovery only. No generic registry or quality provider is currently installed; core native-cell layout is implemented through the shared planner in `src/layout/native-layout.ts` and engine adapters in `src/layout/additional-layout-engines.ts`, not via a generic provider registry.

Every mutation plan must be revalidated against the same page and current XML revision, executed by the native Draw.io bridge, and reported as successful only after editor acknowledgement and the normal save/version path. Analysis findings do not silently block ordinary native editing. See [ADR-0012](../docs/adr/0012-native-diagram-extension-contracts.md) for the contract and rules for reusing prior research.

## Copilot native cell edits

The server gives Copilot the active page's native cell IDs, labels and cell types. The editing surface has two paths:

- `propose_native_edits`: a typed fast path for common operations such as select, rename, style, move, resize, delete, simple connected-node insertion and Studio-owned automatic layout.
- `run_drawio_script`: the primary full-capability path for native Draw.io operations. Copilot can write JavaScript against the live `ui`, `editor`, `graph`, `model` and runtime-inspection bindings to create/reconnect edges, change waypoints, choose shapes, apply styles, group/reparent cells, manage layers/pages and use other APIs available in the bundled editor. New native capabilities do not require a new typed operation or schema branch.

Typed operations are convenience shortcuts, not an allowlist. Local single-user mode does not add a second confirmation just because a script is arbitrary, a batch is large, or a change deletes elements. The runtime method manifest remains diagnostic and never disables the direct script tool. Target/page/revision checks continue to prevent dispatch against a stale diagram snapshot; these are document-coherence checks, not a per-capability permission gate.

The script runs synchronously inside a separately-originated Draw.io iframe, not in Node.js. The iframe has sandbox flags, is hosted by a loopback-only static server, and receives a CSP that permits same-origin asset requests but blocks cross-origin `connect-src` requests and external image loads; the script cannot access the Studio parent DOM or the Studio API origin. This is not an OS-level network sandbox, and CSP does not prevent all frame navigations. Configure the paired `STUDIO_DRAWIO_PORT` and `VITE_STUDIO_DRAWIO_PORT` values together in `v2/.env`. The browser watchdog defaults to 75 seconds and can be configured with `VITE_NATIVE_SCRIPT_WATCHDOG_TIMEOUT_MS` (30000–180000 ms); it cannot interrupt a synchronous script, so timeout recovery reloads from the latest saved XML. Studio archives the prior state, executes through the native editor bridge, exports and validates the resulting native XML, then follows the normal save/version acknowledgement path. The full script and correlated execution evidence are written to local traces. A thrown script error is reported with runtime details; the bridge attempts to roll back cell-model mutations. If a script blocks the iframe past the host-side watchdog, Studio can reload the editor from its latest saved XML checkpoint. Recovery/version history replaces per-operation approval as the expected response to mistakes.

Native Draw.io `mxfile` XML remains the sole diagram model; there is no reduced shadow graph or XML reconstruction. Use [ADR-0018](../docs/adr/0018-ai-first-native-drawio-execution.md) for the design and implementation details.


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

Settings contains the SDK model and reasoning effort. The overall Copilot turn deadline is configurable in `v2/.env` with `STUDIO_COPILOT_TURN_TIMEOUT_MS`; it defaults to `300000` (five minutes) and accepts `10000`–`900000` milliseconds. The same overall deadline covers the first model call and the fallback retry. `STUDIO_COPILOT_TURN_IDLE_TIMEOUT_MS` defaults to `90000` (90 seconds without meaningful SDK progress; accepted range `10000`–`300000` milliseconds). The idle watchdog is refreshed by reasoning/text/tool-argument deltas and meaningful tool/turn transitions, but the overall deadline remains a hard cap. Terminal output prints compact call-start, call-end and 30-second progress summaries without the raw prompt or streamed delta text; SDK event summaries remain in the local JSONL trace (individual event details are length-limited). Restart the local Copilot server after changing the environment file. Provider credentials stay in the local runtime environment; they are not sent from the browser. Sign in with the GitHub Copilot CLI or configure a supported local provider before using Copilot.

Agent Traces shows application events, SDK lifecycle, model calls and any token/cost/context usage reported by the SDK or provider. Missing counters are not estimated. Context-window occupancy is a snapshot, not tokens consumed. Local logs and history may include project labels, prompts and diagram data, so treat them as project data.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e -- e2e/02-canvas.spec.ts
```

The V2 GitHub Actions workflow runs typecheck, unit tests, a production build with the pinned Draw.io bundle, and native canvas E2E checks. Check the result of the latest run before treating a commit as validated.
