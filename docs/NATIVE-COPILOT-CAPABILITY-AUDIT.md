# Native Copilot / Draw.io Capability Audit

- Date: 2026-10-23
- Scope: V2 tool schema, Copilot HTTP contract, native Draw.io bridge, persistence, and ADR alignment.
- Reference: [Architecture V2](../ARCHITECTURE-V2.md), [ADR-0010](adr/0010-unified-server-side-copilot-intent-processing.md), [ADR-0011](adr/0011-native-drawio-only-model.md), [ADR-0012](adr/0012-native-diagram-extension-contracts.md).
- Ground rule: the bundled Draw.io editor and its `mxCell` model are the only active diagram model. More internal editor methods do not automatically become Copilot permissions.

## Executive finding

The seven-operation allowlist is deliberately narrower than Draw.io's native API and should remain so. The substantive problems were in state binding and completion semantics, not simply a short schema: server target resolution depended on the model-facing cell list, a request did not carry a verifiable source revision, move compilation used stale coordinates, and the UI could report success before native XML serialization and workspace persistence had completed.

Those paths have now been tightened. The API uses a discriminated outcome union for `command_ready`, `proposal_required`, `selected`, `answered`, `needs_clarification`, `unsupported`, `stale_context` and `failed`; the separate final acknowledgement returns `applied` or `failed`. Review-required batches stay server-side until the user confirms them against the same revision. The acknowledgement is bound to the request, resolved targets, serialized XML revision and immutable version ID. Broader native operations remain intentionally unexposed.

## Findings and code changes

### P1 — Request and response were not bound to one document state

**Before:** the browser sent an editable-cell list; the server resolved against that session context. The contract had no document hash/page on the response, so a valid operation could outlive the state against which it was interpreted.

**Changed:**
- The request now sends the exact Draw.io XML snapshot, SHA-256 revision, current page, and selected cell/page context.
- The server validates XML and recomputes the hash, derives cells from the XML itself, checks the selected cell on that page, and (in workspace mode) compares the snapshot against the server's current workspace state both before and after the model turn.
- The response binds native operations to `pageId` and `documentRevision`; the browser validates both before dispatch.
- The model-facing cell list is capped to control prompt size, but the private server-side target index now includes *all* editable cells on the active page. Label uniqueness is therefore not decided using only the first 200 prompt-visible cells.
- The browser performs a final current-document/page/selection check before sending the operation to Draw.io.
- Express accepts a 25 MB JSON envelope while the route itself limits XML to 20 MB.

Relevant code: `v2/server/copilot/intent-route.ts`, `v2/server/copilot-server.ts`, `v2/src/intent/aiProvider.ts`, `v2/src/hooks/useCopilotIntent.ts`.

### P1 — Move must be relative to the live native geometry

**Before:** the browser converted a requested delta into absolute coordinates from the XML snapshot captured before the model call. If a person moved the cell while the model was thinking, the generated absolute coordinates could overwrite that more recent edit.

**Changed:** `move` is now one `geometry:translate` bridge step. The local Draw.io plugin adds the bounded delta to the current `mxGeometry` at execution time. Server resolution now rejects `move` and `resize` on connector cells because edge geometry represents routing/label offsets rather than node position/size. A client-side target/page preflight remains as a second guard; it does not replace server validation.

Relevant code: `v2/src/model/native-edit-operations.ts`, `v2/plugins/studio-selection-plugin.js`.

### P1 — “Applied” needed to mean more than an mxGraph mutation

**Before:** the bridge acknowledged an in-memory graph mutation and the chat could immediately print success while XML serialization and workspace persistence were still asynchronous.

**Changed:** for batch edits, the bridge waits for Draw.io to serialize XML and returns that XML with its acknowledgement. Workspace mode waits for revision-checked persistence and captures the returned immutable version ID. The browser then posts a correlated acknowledgement to `/api/copilot/intent/ack`; the server resolves the claimed version ID from its version store and verifies that its XML hash equals the serialized revision. It records the resolved cell IDs/labels, editor acknowledgement, persistence status, XML revision, version ID and final outcome together. This is checked against the immutable version, not just the latest active revision, so a valid earlier operation is not discarded merely because a later user edit advances the workspace. The final server log remains client-reported execution evidence from a local single-user UI, not independent proof suitable for a regulated audit trail.

Relevant code: `v2/src/components/DrawioFrame.tsx`, `v2/src/App.tsx`, `v2/src/hooks/useCopilotIntent.ts`.

### P1 — Outcomes and destructive confirmation must be explicit

**Changed:** `v2/src/intent/copilot-intent-outcome.ts` defines one discriminated outcome contract. The server returns `answered`, `selected`, `needs_clarification`, `unsupported`, `proposal_required`, `stale_context`, `failed` or `command_ready` as appropriate. An edit command is not considered applied until the separate final acknowledgement succeeds. If the model omits a terminal tool call, the server retries once and then returns a typed failure rather than treating free-form prose as a result. Deterministic target-resolution errors map to clarification/unsupported outcomes.

Batches with two or more deletes or ten or more native operations are held as a 10-minute, single-use proposal. The UI offers an explicit confirmation action; the confirm endpoint validates the proposal ID, session/mode, latest XML hash, active page, workspace snapshot and every target again before it returns a new `command_ready` command. Multiple terminal tool calls in a single model turn fail closed.

Relevant code: `v2/src/intent/copilot-intent-outcome.ts`, `v2/src/intent/aiProvider.ts`, `v2/server/copilot/intent-route.ts`, `v2/src/hooks/useCopilotIntent.ts`, `v2/src/components/WorkspacePages.tsx`.

### P1 — Standalone and workspace must not share an edit context by accident

**Changed:** opening a standalone diagram creates a fresh Copilot session; returning to a workspace after a standalone file is open resets the conversation context. Switching workspace context will not save the standalone XML into the configured workspace file.

Relevant code: `v2/src/App.tsx`, `v2/server/copilot/intent-route.ts`.

**Remaining caution:** `standalone` is still a request field rather than a server-issued capability token. The current server does not offer workspace file tools to the standalone prompt, and session context is reset, but the API is designed for a local single-user process rather than an authenticated multi-tenant boundary. Do not treat this flag as a sufficient authorization model if the deployment model changes.

### P2 — Schema defaults must agree with the typed runtime

`set_style.key` is intentionally optional; `parseNativeEditOperations` normalizes an omitted key to `fillColor`. The tool Schema now documents that default and a regression assertion checks it. This is not a missing required field. Keep style keys allowlisted in the server parser even though the underlying plugin can accept `style:<arbitrary-key>`.

Relevant code: `v2/server/copilot/native-edit-tool-schema.ts`, `v2/server/copilot/native-edit-tool-schema.test.ts`, `v2/src/model/native-edit-operations.ts`.

## Capability comparison

Draw.io has multiple layers of capability: its standard iframe JSON protocol (load/save/export/merge/patch and other editor actions) and V2's own plugin bridge for focused `mxCell` mutations. The Copilot Schema exposes only a safe subset of the latter; standard editor protocol features are not automatically Copilot operations. See [Draw.io Embed Mode](https://www.drawio.com/docs/reference/embed-mode/) and [Draw.io Style Reference](https://www.drawio.com/docs/reference/diagram-generation/style-reference/).

| Capability | Native editor / plugin surface | Copilot allowlist now | Audit conclusion |
| --- | --- | --- | --- |
| Select an existing cell | Selection bridge | `select` | Covered |
| Rename a cell | `label` | `set_label` | Covered |
| Color a cell | `style:<key>` | `set_style` limited to fill, stroke, font color | Correctly restricted; arbitrary keys would be unsafe |
| Move / resize a node | Native geometry | `move`, `resize` | Covered for vertices; server rejects edges until routing-specific semantics exist |
| Delete a cell | Native remove | `delete` | Covered with batch rollback for affected cells/edges |
| Add a node connected to a target | Plugin inserts a vertex and an edge together | `add_node_after` | Basic path covered, but shape type and edge details are fixed |
| Add an independent edge / reconnect an existing edge | Plugin internals can manipulate edge terminals | None | **Functional gap**: no first-class `add_edge` or `set_edge_endpoints` operation |
| Shape/stencil choice for a new node | Draw.io supports many shape styles/stencils | None; new node uses fixed rectangle-like style | **Functional gap** for architecture diagrams; add only through a validated shape allowlist |
| Edge waypoints / routing | Plugin has `point:<index>:x/y`; Draw.io owns geometry | None | Candidate for a typed routing operation, not raw point paths |
| Group/reparent, hide/show, collapse/expand | Plugin supports `cell:parent`, `cell:visible`, `cell:collapsed`, etc. | None | Leave unexposed until group-cycle, scope, undo/rollback and target semantics have tests |
| Arbitrary style replacement / arbitrary style key | Plugin can accept `style` and `style:<key>` | None | Must stay blocked; the model should never overwrite a whole style string or choose arbitrary keys |
| Page creation/deletion/reordering; broad layout | Draw.io/editor has richer editor actions; local plugin does not provide a governed Copilot contract for them | None | Future feature work only, via explicit revision-bound typed contracts |

### Suggested capability order

1. **Independent edge creation and endpoint repair**: most material modeling gap; must validate both endpoints against the active page, reject edge-to-edge terminals, preserve labels/styles unless explicitly requested, and be covered by atomic rollback tests.
2. **Node shape selection**: allow a small, documented set of Draw.io shape keys for insertion. Avoid arbitrary style strings.
3. **Alignment/distribution and safe grouping**: add only as typed operations/plans against native cell IDs; don't revive a separate layout graph.
4. **Connector routing/waypoints**: defer until there is a concrete use case and tests for edge labels, terminal anchors and rollback.

The current seven operations should not be expanded with a generic `set_property`, raw `style`, arbitrary `cell:<anything>`, or raw XML operation.

## Server vs. browser responsibility

| Responsibility | Correct home | Current status |
| --- | --- | --- |
| Canonical system prompt, Copilot SDK, tool schema, allowlist parsing | Server | Server-owned |
| Validate request XML/hash/page; resolve IDs and duplicate labels | Server | Server derives the full active-page index; the model sees a bounded subset |
| Protect the live editor against stale page/selection and dispatch protocol messages | Browser + local Draw.io bridge | Appropriate; this is adapter work, not a second intent interpreter |
| mxGraph mutation, rollback and serialization | Draw.io plugin | Appropriate; the server cannot call the in-iframe graph model directly |
| Workspace optimistic save and immutable XML versions | Server | Server save path; Copilot waits for persistence before showing success |
| Standalone file-system write | Browser File System Access API | Appropriate for a user-selected local file; never route it through workspace persistence |
| Final native execution/persistence outcome | **Server API + browser acknowledgement** | Correlated acknowledgement includes resolved targets, editor status, XML revision, immutable version ID and failure stage; client-reported status is not independent audit evidence |

### Follow-up architecture work

1. Route-level tests cover typed no-mutation outcomes, source hash/page/selection mismatch, workspace changes during model latency, duplicate labels beyond the first 200 cells, standalone workspace isolation, identical focused-rename resolution in both request modes, proposal confirmation and stale revision, acknowledgement replay/expiry, immutable-version mismatch, persistence failure, conflicting terminal tools, and assertions on the canonical multilingual rename/move prompt policy. Unit tests cover localized label values, all four numeric move directions, resize/delete mapping, and explicit rejection of alignment/grouping/relation operations not yet supported. Browser E2E covers workspace edits, bulk-delete confirmation, standalone local-file persistence, workspace/standalone isolation, and workspace-save failure. The full suite passed in [V2 CI run 39880294805](https://github.com/saga/architecture-diagram-studio/actions/runs/39880294805).
2. The discriminated result contract is implemented for the current allowlist. Remaining work is to expand the integration matrix for all error branches, not to add another outcome vocabulary.
3. The workspace snapshot accessor validates the server's stored workspace state, not changes written directly to disk by another process. If V2 must tolerate external file edits while open, add a filesystem-aware freshness check before issuing a command and document the trade-off between file I/O and latency.
4. Live-model natural-language paraphrase coverage remains incomplete: offline tests validate Chinese/English target values and preserve the prompt sent to the model, but do not assert every linguistic variant is interpreted identically by each live model release. Connector routing, node shape choice, alignment/grouping and richer relation edits are intentionally unsupported; do not expose them until typed native operations and rollback semantics exist.
5. Standalone execution receipts explicitly say persistence is not managed by the server. This is intentional: a serialized XML event is not proof that a user-selected local file was written. If UI/product needs that guarantee, post a separate File System Access save result without treating it as a workspace version.

## ADR alignment matrix

| Decision | Alignment |
| --- | --- |
| ADR-0011: one native Draw.io model; no `DiagramDocument` editing round-trip | Aligned; keep it that way |
| ADR-0012: typed revision-bound native operation plans, no raw XML replacement, no parallel graph model | Mostly aligned; current Copilot operations now carry a revision/page and the plugin operates on native mxCells |
| ADR-0010 sections 1–6: unified server interpretation, validated revision/page, constrained bridge, and explicit review gate | Verified by route tests and passing CI for the current native-edit allowlist |
| ADR-0010 section 7: discriminated final outcome, resolved targets, editor acknowledgement, saved revision and immutable version | Verified by unit/route tests and passing CI; final logs remain client-reported evidence, not independent regulated audit proof |
| ADR-0010 checklist: workspace/standalone mode parity and current allowlist failure paths | Browser parity and workspace-save-failure E2E passed. Alignment/grouping/relation edits remain intentionally unsupported, not silently approximated |

## Verification status

Final verification passed for commit `e44d3939c889c8382561218a22fdfb90f0a46480`: typecheck, native XML/cell-operation/persistence tests, production build, and expanded Playwright E2E all succeeded. Run: [V2 CI 39880294805](https://github.com/saga/architecture-diagram-studio/actions/runs/39880294805). Earlier failed/cancelled runs drove fixes to the standalone file loading and queued autosave race. Remaining known gaps are live-model paraphrase quality, awareness of external file edits made by other processes, and intentionally unsupported connector routing / shape choice / alignment / grouping / richer relation editing.
