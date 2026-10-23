# Architecture Diagram Studio V2

## Run

Requires Node.js 22.13 or later. From `v2/` run:

```sh
npm install
npm run dev
```

V2 bundles the pinned Draw.io v32.0.2 editor locally. It does not use the hosted embed. `npm run dev` starts both Vite and the loopback Copilot service.

## One diagram model

The original native Draw.io `mxfile` XML is the only diagram model. The embedded Draw.io editor owns the canvas, cell selection, geometry, styles, connectors, pages, undo/redo and native editing. V2 has no parallel `DiagramDocument`, semantic graph, model-to-XML exporter, semantic layout engine or proposal-preview graph.

Opening, importing, versioning, restoring and exporting keep native Draw.io XML as the source of truth. Editing happens inside the Draw.io graph; its serializer may normalize XML formatting or attribute order after a mutation. V2 never rebuilds a document from a reduced model, and supported edits must preserve unrelated pages, cells, relationships, wrappers, custom shapes, HTML labels and vendor-specific attributes.

## Extension points for future native capabilities

V2 intentionally does not ship the legacy semantic graph or its custom layout/quality pipeline. It does preserve a small extension contract in `src/model/native-diagram-capabilities.ts` so future features can be added without porting the old renderer or introducing a parallel model:

- `NativeDiagramOperationProvider` receives the authoritative XML, base revision, active page, selection and a lightweight native-cell index, and returns a plan using the shared `NativeEditOperation` vocabulary.
- `NativeDiagramAnalysisProvider` returns read-only findings (for example geometry, routing, contrast or accessibility diagnostics) keyed by native page/cell IDs.
- `NativeDiagramCapabilityRegistry` is an interface for explicit capability discovery only. No generic registry, layout provider or quality provider is currently installed.

Every mutation plan must be revalidated against the same page and current XML revision, executed by the native Draw.io bridge, and reported as successful only after editor acknowledgement and the normal save/version path. Analysis findings do not silently block ordinary native editing. See [ADR-0012](../docs/adr/0012-native-diagram-extension-contracts.md) for the contract and rules for reusing prior research.

## Copilot native cell edits

The server passes the selected page's native cell IDs, labels and cell types to the Copilot SDK. The model may request two kinds of action:

- `select_diagram_element` focuses an existing cell without changing the document.
- `propose_native_edits` submits a typed batch of allowlisted operations.

Supported edits are select, rename, fill/stroke/font color, move, resize, delete, `add_node_after` (add a connected vertex to the right), and `add_node_below` (add a connected vertex directly below its source). A small batch of typed, non-destructive operations can execute without a separate confirmation click after the server validates target uniqueness, page/revision and operation values. Raw `run_drawio_script` proposals still require explicit confirmation; script bodies are not shown in the chat. The browser applies every batch through the Draw.io bridge and waits for editor acknowledgement and persistence. Failed batches are rolled back when Draw.io confirms rollback; ambiguous targets and unsupported operations fail closed. The model cannot submit replacement XML or write workspace files.

## Copilot session permission and authentication callbacks

Every Studio session config registers `onPermissionRequest` and `onMcpAuthRequest` before either `resumeSession` or `createSession` is called. Missing permission handlers can leave SDK permission requests pending while the caller waits for `sendAndWait`; a returned `session.idle` event is not a substitute for registering the policy callback or resolving the pending permission RPC.

The current `approve-once` decision is application-specific: the client runs in `mode: "empty"`, and the session only exposes Studio-owned custom tools rather than ambient shell or filesystem tools. Do not move this approval decision into the shared runtime as a default. If the available tools or their side effects change, review this policy alongside the server-side operation allowlist and revision/version checks.

If a permission request carries `managedApprovalRequired`, or the SDK invocation says managed settings are enabled, Studio returns `user-not-available`. There is no managed-approval UI or broker, so it must fail closed rather than auto-approve or return `no-result` and leave the request pending.

Studio has no MCP OAuth UI or token broker, so the application explicitly cancels MCP authentication requests and emits a diagnostic event. Both callbacks schedule logging without awaiting it. Logging must not stall the SDK handshake, and even a synchronous logger exception must not escape from the callback.

The reusable interface and integration rules are documented in [common-agent-lib's Copilot runtime](https://github.com/saga/common-agent-lib/tree/main/packages/copilot-agent-runtime); the library exposes callback types but intentionally does not import Studio's policy.

## Persistence, versions and XML validation

Workspace and version state contain native XML and metadata, not a derived graph object. Workspace saves include the server-issued SHA-256 revision of the exact XML. A stale revision is rejected with HTTP 409. Version history stores full XML snapshots; legacy entries that have no native XML are skipped rather than regenerated from a lossy model.

The shared Zod schema validates native `mxfile`, bare `mxGraphModel`, supported compressed pages, geometry and shape-library formats. It intentionally leaves unknown attributes, styles, wrapper elements and custom cell types open. Malformed XML and DTD/custom entity declarations are rejected. Schema validation checks the source format; it does not require the file to fit a Studio-specific shape taxonomy.

Standalone files can be opened without configuring a workspace. When browser file access is available, changes can save to that file; otherwise use **Export**. A configured project workspace adds server autosave and server-side version history. Creating a diagram never overwrites an existing file.

## Settings and Agent Traces

Settings contains the SDK model and reasoning effort. Provider credentials stay in the local runtime environment; they are not sent from the browser. Sign in with the GitHub Copilot CLI or configure a supported local provider before using Copilot.

Agent Traces shows application events, SDK lifecycle, model calls and any token/cost/context usage reported by the SDK or provider. Missing counters are not estimated. Context-window occupancy is a snapshot, not tokens consumed. Local logs and history may include project labels, prompts and diagram data, so treat them as project data.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e -- e2e/02-canvas.spec.ts
```

The V2 GitHub Actions workflow runs typecheck, unit tests, a production build with the pinned Draw.io bundle, and native canvas E2E checks. Check the result of the latest run before treating a commit as validated.
