# Native Copilot / Draw.io Capability Audit

- Date: 2026-10-23
- Scope: V2 tool schema, Copilot HTTP contract, native Draw.io bridge, persistence, and ADR alignment.
- Reference: [Architecture V2](../ARCHITECTURE-V2.md), [ADR-0010](adr/0010-unified-server-side-copilot-intent-processing.md), [ADR-0011](adr/0011-native-drawio-only-model.md), [ADR-0012](adr/0012-native-diagram-extension-contracts.md).
- Ground rule: the bundled Draw.io editor and its `mxCell` model are the only active diagram model. More internal editor methods do not automatically become Copilot permissions.

## Executive finding

The seven-operation allowlist is deliberately narrower than Draw.io's native API and should remain so. The substantive problems were in state binding and completion semantics, not simply a short schema: server target resolution depended on the model-facing cell list, a request did not carry a verifiable source revision, move compilation used stale coordinates, and the UI could report success before native XML serialization and workspace persistence had completed.

Those paths have now been tightened, and the browser now posts a correlated final execution/persistence acknowledgement to the server. The initial HTTP response is explicitly `command_ready`, not `applied`; the acknowledgement endpoint records a final `applied` or `failed` outcome. The remaining contract gap is that clarification, unsupported, stale-context and no-operation replies are not yet represented by one complete discriminated outcome union. Broader native operations also remain intentionally unexposed.

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

**Changed:** for batch edits, the bridge waits for Draw.io's save/autosave XML event and returns the serialized XML with its acknowledgement. Workspace mode then waits for the revision-checked persistence call before resolving the Copilot edit as successful. The browser posts a second, correlated acknowledgement to `/api/copilot/intent/ack`; the server checks the saved workspace revision before recording the final outcome. A persistence error is reported separately from an editor rejection; it does not falsely claim that the edit was never applied. Late acknowledgements after the UI timeout still reach the server for audit but do not turn the chat message into a late success. The final server log is client-reported evidence from this local single-user UI, not independent proof suitable for a regulated audit trail.

Relevant code: `v2/src/components/DrawioFrame.tsx`, `v2/src/App.tsx`, `v2/src/hooks/useCopilotIntent.ts`.

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
| Final native execution/persistence audit event | **Server API + browser acknowledgement** | Correlated acknowledgement endpoint now records applied/failed and revision data; route-level tests and a stronger trust model remain outstanding |

### Follow-up architecture work

1. The correlated acknowledgement endpoint is now implemented. Add route-level tests for success, native rejection, persistence failure, acknowledgement replay/expiry, and a workspace revision mismatch between save and acknowledgement.
2. Complete the result union beyond `command_ready` / `applied` / `failed`: `stale_context`, `needs_clarification`, `unsupported` and non-edit replies should use explicit outcomes as well. This is still required by ADR-0010 section 7.
3. Consider re-reading the actual active diagram file from disk when obtaining the workspace snapshot if V2 is expected to tolerate edits made by another process while it remains open. The current snapshot accessor validates the server's stored workspace state; it is not itself a guaranteed filesystem change detector.
4. Add route-level tests for forged/mismatched XML revision, stale workspace revision before and after model latency, a duplicate label beyond the first 200 cells, page mismatch, edge-vs-vertex operation type checks, and standalone/workspace context isolation. The current unit and E2E tests are useful but do not yet cover the whole HTTP-to-SDK contract.
5. Standalone execution receipts explicitly say persistence is not managed by the server. If product expectations require server-visible local-file save state, add a browser-owned save acknowledgement; do not imply that an editor serialization proves the user's local file was written.

## ADR alignment matrix

| Decision | Alignment |
| --- | --- |
| ADR-0011: one native Draw.io model; no `DiagramDocument` editing round-trip | Aligned; keep it that way |
| ADR-0012: typed revision-bound native operation plans, no raw XML replacement, no parallel graph model | Mostly aligned; current Copilot operations now carry a revision/page and the plugin operates on native mxCells |
| ADR-0010 sections 1–6: unified server interpretation, validated revision/page, constrained bridge and explicit acknowledgement | Improved and largely aligned for the native-edit path; route-level coverage still needed |
| ADR-0010 section 7: server-visible discriminated final outcome and complete audit of editor + persistence result | **Partially aligned**; server now receives a correlated final applied/failed acknowledgement, but the full outcome union and route-level tests are incomplete |
| ADR-0010 checklist: mode parity, broad operation examples (alignment/grouping/relation edits), failure and E2E coverage | **Not complete**; current allowlist is intentionally smaller and must be described as such |

## Verification status

Code and regression tests have been updated in the repository. GitHub Actions runs were repeatedly cancelled by the repository's cancel-in-progress behavior as sequential commits landed; do not treat a cancelled/queued run as a pass. Record the final typecheck, unit, production build and E2E result here only after a run for the final commit finishes.
