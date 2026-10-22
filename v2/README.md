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

## Copilot native cell edits

The server passes the selected page's native cell IDs, labels and cell types to the Copilot SDK. The model may request two kinds of action:

- `select_diagram_element` focuses an existing cell without changing the document.
- `propose_native_edits` submits a typed batch of allowlisted operations.

Supported edits are select, rename, fill/stroke/font color, move, resize, delete and `add_node_after` (add a vertex to the right of a target and connect it). The server resolves exact IDs or unique exact labels and validates each operation. The browser applies the batch through the Draw.io bridge and waits for editor acknowledgement. Failed batches are rolled back when Draw.io confirms rollback; ambiguous targets and unsupported operations fail closed. The model cannot submit replacement XML or write workspace files.

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
