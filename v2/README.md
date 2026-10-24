# Architecture Diagram Studio V2

## Run

Requires Node.js 22.13 or later. From `v2/` run:

```sh
npm install
npm run dev
```

V2 bundles the pinned Draw.io v32.0.2 editor locally. It does not use the hosted embed. `npm run dev` starts both Vite and the loopback Copilot service.

## One diagram model

The original native Draw.io `mxfile` XML is the only diagram model. The embedded Draw.io editor owns the canvas, selection, geometry, styles, connectors, pages, undo/redo and serialization. V2 has no parallel `DiagramDocument`, semantic graph, model-to-XML exporter or proposal-preview graph.

Opening, importing, versioning, restoring and exporting keep native Draw.io XML as the source of truth. V2 never rebuilds a document from a reduced model. Supported edits must preserve unrelated pages, cells, relationships, wrappers, custom shapes, HTML labels and vendor-specific attributes.

## Runtime storage scope

V2 resolves all runtime persistence paths through `v2/server/storage-layout.ts`. Workspace state, version history, application/agent logs and Copilot SDK state live under `~/.architecture-diagram-studio/workspaces/<workspace-key>/`; single-file mode uses `~/.architecture-diagram-studio/{data,logs,copilot}/`. Switching scope invalidates in-memory state/version caches and resets the SDK client before the next operation. The workspace registry and model/settings revision history remain global under `~/.architecture-diagram-studio/data/`.

Legacy workspace state and logs are copied only when their records explicitly identify that workspace. Existing global files are kept as recovery sources. `STUDIO_HOME`, `STUDIO_GLOBAL_DATA_DIR`, `STUDIO_DATA_DIR`, `COPILOT_LOG_DIR` and `COPILOT_HOME` remain operator/test overrides. See [ADR-0017](../docs/adr/0017-unified-runtime-storage-scope.md).

## Studio-owned automatic layout — core feature

Automatic layout is calculated in Studio using `@dagrejs/dagre` and `elkjs`; V2 does not call Draw.io's built-in `action: "layout"`. `src/layout/native-layout.ts` derives a temporary, per-operation projection from the selected page's native mxCells, calculates positions and connector waypoints, and returns a revision/page-bound plan. The bridge validates current cell IDs, geometry and connector endpoints before applying only native geometry changes through the Draw.io model. It never converts the full document to another saved model.

The toolbar exposes Dagre and ELK. Dagre supports directed layered placement in four directions; ELK supports Layered, Mr. Tree, Radial, Stress and Force, plus applicable direction, node/layer spacing, connector routing, iterations, seed and margin settings. Settings persist in this browser. The first implementation lays out top-level vertices and connectors in the default layer; other pages, layers and nested group contents remain unchanged.

The embedded Draw.io shape library panel is enabled by default, and its initial library list includes C4 alongside General, UML, ER, BPMN, Flowchart, Basic and Arrows. Users do not need to enable C4 manually from More Shapes. Copilot uses the same typed `auto_layout` operation and Studio planner as the toolbar. Whole-page layouts always require explicit confirmation and cannot be combined with unrelated edits in one batch. The bridge rejects stale cell sets or geometry and attempts to restore prior geometry if mutation fails. See [ADR-0013](../docs/adr/0013-studio-owned-layout-engines.md).

## Extension points for future native capabilities

V2 intentionally does not ship the legacy semantic graph, DiagramDocument-based layout pipeline, or semantic quality pipeline. It preserves a small extension contract in `src/model/native-diagram-capabilities.ts` for additional native editing and analysis features without porting the old renderer or introducing a parallel model:

- `NativeDiagramOperationProvider` receives the authoritative XML, base revision, active page, selection and a lightweight native-cell index, and returns a plan using the shared `NativeEditOperation` vocabulary.
- `NativeDiagramAnalysisProvider` returns read-only findings (for example geometry, routing, contrast or accessibility diagnostics) keyed by native page/cell IDs.
- `NativeDiagramCapabilityRegistry` is an interface for explicit capability discovery only. No generic registry or quality provider is currently installed; core Dagre/ELK layout is implemented as a direct shared capability path in `src/layout/native-layout.ts`, not via a generic provider registry.

Every mutation plan must be revalidated against the same page and current XML revision, executed by the native Draw.io bridge, and reported as successful only after editor acknowledgement and the normal save/version path. Analysis findings do not silently block ordinary native editing. See [ADR-0012](../docs/adr/0012-native-diagram-extension-contracts.md) for the contract and rules for reusing prior research.

## Copilot native cell edits

The server passes the selected page's native cell IDs, labels and cell types to the Copilot SDK. The model may request two kinds of action:

- `select_diagram_element` focuses an existing cell without changing the document.
- `propose_native_edits` submits a typed batch of allowlisted operations.

Supported edits include select, rename, fill/stroke/font color, move, resize, delete, `add_node_after`, `add_node_below`, typed C4 conversion (`set_c4_type`: Person, Software System, External Software System), and the configurable `auto_layout` operation. C4 conversion uses the pinned Draw.io palette styles, placeholder-backed labels and semantic XML postconditions. It never substitutes a UML actor or swimlane; if the C4 Person shape is unavailable, the operation fails without a fallback. See [ADR-0014](../docs/adr/0014-typed-native-drawio-c4-conversion.md). A bounded typed batch that does not trigger the server's review gate executes after target uniqueness, page and revision checks without a separate confirmation click. Every whole-page `auto_layout` and all review-gated batches require explicit confirmation. A narrowly allowlisted insert-only script may auto-dispatch only after the server-side AST, runtime-manifest and revision checks; scripts are not a substitute for layout, and script bodies are not shown in chat. The browser applies edits through the Draw.io bridge and waits for editor acknowledgement and persistence. Failed batches are rolled back when Draw.io confirms rollback; ambiguous targets and unsupported operations fail closed. The model cannot submit replacement XML or write workspace files.

## Copilot session permission and authentication callbacks

Every Studio session config registers `onPermissionRequest` and `onMcpAuthRequest` before either `resumeSession` or `createSession` is called. Missing permission handlers can leave SDK permission requests pending while the caller waits for `sendAndWait`; a returned `session.idle` event is not a substitute for registering the policy callback or resolving the pending permission RPC.

The current `approve-once` decision is application-specific: the client runs in `mode: "empty"`, and the session only exposes Studio-owned custom tools rather than ambient shell or filesystem tools. Do not move this approval decision into the shared runtime as a default. If the available tools or their side effects change, review this policy alongside the server-side operation allowlist and revision/version checks.

If a permission request carries `managedApprovalRequired`, or the SDK invocation says managed settings are enabled, Studio returns `user-not-available`. There is no managed-approval UI or broker, so it must fail closed rather than auto-approve or return `no-result` and leave the request pending.

Studio has no MCP OAuth UI or token broker, so the application explicitly cancels MCP authentication requests and emits a diagnostic event. Both callbacks schedule logging without awaiting it. Logging must not stall the SDK handshake, and even a synchronous logger exception must not escape from the callback.

The reusable interface and integration rules are documented in [common-agent-lib's Copilot runtime](https://github.com/saga/common-agent-lib/tree/main/packages/copilot-agent-runtime); the library exposes callback types but intentionally does not import Studio's policy.

## Persistence, versions and XML validation

Workspace and version state contain native XML and metadata, not a derived graph object. Workspace saves include the server-issued SHA-256 revision of the exact XML. A stale revision is rejected with HTTP 409. Server history keeps a small metadata index and immutable per-version XML files; retention is capped by both version count and byte budgets. Legacy entries without native XML are skipped rather than regenerated from a lossy model.

The shared Zod schema validates native `mxfile`, bare `mxGraphModel`, supported compressed pages, geometry and shape-library formats. It intentionally leaves unknown attributes, styles, wrapper elements and custom cell types open. Malformed XML and DTD/custom entity declarations are rejected. Schema validation checks the source format; it does not require the file to fit a Studio-specific shape taxonomy.

Standalone files can be opened without configuring a workspace. All local Draw.io file operations—browse, open, import, direct autosave, standalone history and export—go through the local Node.js service and Node.js filesystem APIs; the browser no longer needs a file-write permission grant. The picker is limited to the user's home directory and the configured workspace, and symbolic links are skipped. Saves use a revision check and fail with a conflict rather than overwriting an external edit. Export writes a new file and refuses to overwrite an existing path. Standalone history is stored under ~/.architecture-diagram-studio/data/standalone-history/ as a metadata index plus separate XML snapshots, capped at 100 entries and 128 MiB per diagram. A configured project workspace continues to use server-side autosave and version history.

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
