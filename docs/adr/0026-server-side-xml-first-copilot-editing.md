# ADR-0026: Server-Side XML-First Copilot Editing and Frontend Version Synchronization

- **Status:** Accepted; implementation pending.
- **Date:** 2026-10-29
- **Scope:** Copilot diagram edits, native XML validation/versioning, and frontend synchronization.
- **Supersedes:** The script-first Copilot execution decision in ADR-0018 and any conflicting requirement in ADR-0010, ADR-0011, ADR-0012, AGENTS.md, or ARCHITECTURE-V2.md that prevents the model from directly editing native XML on the server.
- **Related:** ADR-0001, ADR-0009, ADR-0011, ADR-0013, ADR-0016, ADR-0017, ADR-0020, ADR-0023.

## Context

The current Copilot path commonly asks the model to generate JavaScript for the live Draw.io runtime, dispatches it across the iframe bridge, exports XML, and then coordinates persistence and acknowledgement. This adds runtime coupling and multiple state transitions even for edits that can be expressed directly in the native XML. The saved artifact is already native Draw.io XML, so requiring a Draw.io script as the normal write interface has no demonstrated additional value for ordinary edits.

The product must continue to preserve the complete open Draw.io format. Removing the script-first path must not reintroduce DiagramDocument, a shadow graph, a closed shape whitelist, or lossy reconstruction. The existing Studio-owned automatic-layout subsystem is a deliberate exception to the scope of this change and must remain unchanged.

## Decisions

### 1. Server-side XML editing is the default Copilot path

- The Copilot agent reads the current authoritative native XML and edits it directly on the server.
- The model must not be required to translate its intended changes into `NativeEditOperation[]` or JavaScript for the Draw.io Graph/Model API.
- Prefer targeted changes that preserve the original XML. A full-document replacement is acceptable only when the workflow needs it and preservation checks pass; it must not be the default reasoner behavior.
- Keep Draw.io's native XML/mxGraph structure as the only persisted diagram model. Parsed cells, indexes, summaries and diff structures are transient helpers, never a second writable authority.
- The server owns validation, revision conflict detection, persistence, version history and the final outcome. The agent cannot write arbitrary filesystem paths or bypass the document service.

### 2. Every edit is bound to a source revision and produces a persisted revision

For each edit, carry a stable document identity, source revision/hash and applicable page identity. Before committing, verify that the authoritative source has not advanced. If it has, reject the stale write and let the agent re-read/re-plan rather than silently overwriting newer changes.

Before a result is marked successful:
1. Parse and validate the native XML using the shared XML validation entry points.
2. Check structural invariants including unique IDs, valid cell/edge references, valid page payloads and preservation of unknown attributes, wrappers, shapes, styles, layers, groups and unrelated pages.
3. Produce a before/after native-XML diff and identify unexpected out-of-scope changes where the comparison can determine them.
4. Persist the exact resulting XML as the next authoritative document revision and immutable version.
5. Return a receipt containing request/document IDs, source and resulting revisions/hashes, version ID, diff summary, validation result and persistence outcome.

XML parsing alone is not proof that the diagram renders correctly or that the user's intent was achieved. The frontend/Draw.io rendering result and semantic postconditions should be checked where appropriate; failures must be reported distinctly rather than collapsing into a generic success/failure flag.

### 3. Frontend follows the authoritative document revision

After the server commits a new XML revision, it publishes a document-changed notification with document identity, revision/hash and version metadata. Prefer a push event over a polling loop when the existing local application transport supports it. A revision poll is an acceptable fallback, not a second source of truth.

On receiving a newer revision, the frontend must:
- Ignore duplicate or older events.
- Avoid applying the revision to the wrong workspace/document/page.
- Load the exact persisted XML revision into the embedded Draw.io editor and update its local revision/hash baseline.
- Suppress treating the refresh itself as a new user edit/autosave.
- Prevent stale in-memory editor XML from overwriting the newer server revision.
- Handle an unsaved user edit explicitly: detect the local/server revision mismatch and reconcile or surface the conflict rather than silently discarding either version.
- Acknowledge the loaded revision where needed so the Copilot outcome can distinguish “persisted on server” from “frontend refreshed”.

The server-persisted XML version is authoritative. A successful server write must not be reported as a failed edit solely because the frontend notification is delayed; instead expose the synchronization state and reconcile the late event.

### 4. Workspace and standalone files retain their established ownership boundaries

- In workspace mode, the server edits and persists the configured workspace XML using the existing filesystem and version services.
- In standalone mode, the browser continues to own the user's selected source file through its File System Access handle, as defined by ADR-0016. The server may produce and version the next XML document revision, but the browser must write it to the selected source file through the existing handle and external-change check. Do not send a local absolute path to the server or imply that a server-side version automatically changed the original standalone file.
- Keep these modes explicit in the receipt: server document revision, standalone source-file write outcome, and frontend-loaded revision are distinct facts.

### 5. Remove the Draw.io script tool and execution path

Remove `run_drawio_script` as a Copilot tool entirely. Do not retain it as a fallback, hidden capability, feature flag, deprecated tool schema, retry path or prompt-only prohibition. Remove its tool registration/schema, script-specific instruction text, execution/dispatch bridge, watchdog and confirmation-policy branches, script-only telemetry/configuration, and tests that exist solely to support it. Remove or simplify `NativeEditOperation` script variants and validation branches that only exist to route this tool.

Do not replace the script with another way to execute model-generated JavaScript inside Draw.io. Copilot edits native XML directly through the server-side document service. If a future requirement genuinely cannot be expressed as XML, it needs a separate architecture decision; this ADR does not authorize retaining the current script tool under another name.

Do not create new typed operations merely to preserve the former script-first design. Small shared XML helpers are acceptable where they reduce repeated reasoning or make preservation/validation reliable; they must not grow into a second diagram model.

### 6. Automatic layout is explicitly unchanged

This ADR does not redesign, remove, replace, or refactor automatic layout. ADR-0013 and the expanded layout ADRs remain authoritative. Keep the current Studio-owned Dagre, ELK, Graphviz WASM, MSAGL.js, Cytoscape.js and D3 algorithms, adapters, configuration, temporary layout projection and geometry-application pipeline unchanged.

Copilot-triggered automatic layout continues through its existing layout workflow for now. A later, separately scoped decision may consider how layout output is applied, but it must not be bundled into this XML-first migration.

## Consequences

- The Copilot path removes the live Draw.io script execution round trip entirely.
- XML validation, revision checks, native diff, persistence and version history become the core write contract.
- Frontend synchronization is an explicit part of the document lifecycle, not an incidental side effect of editor script acknowledgement.
- The implementation must prevent races between server commits, frontend refresh, Draw.io autosave and standalone source-file writes.
- Script-runtime infrastructure that exists only for `run_drawio_script` should be removed with the tool.
- Automatic layout behavior and its current implementation are out of scope.

## Migration and acceptance criteria

1. Update architecture guidance and repository instructions so no document still says Copilot must use scripts/typed operations or may not submit XML.
2. Implement a server-side XML-edit tool/contract with source revision binding, shared validation, native diff, immutable persistence and structured receipts.
3. Implement frontend revision notifications with push-first delivery and polling fallback; load only the matching, persisted document revision and suppress refresh-triggered autosave.
4. Cover races: concurrent server edits, user edits while Copilot is working, duplicate/out-of-order notifications, stale autosave, failed persistence, frontend disconnection, and standalone file changes outside the app.
5. Regression-test preservation of multiple pages, compressed/plain page payloads, UserObject wrappers, custom shapes/stencils, unknown attributes/style keys, layers, groups, edge terminals and unrelated cells.
6. Verify that `run_drawio_script` is absent from tool registration, schemas, prompts, execution bridge, confirmation logic, runtime configuration and active documentation. No script fallback remains.
7. Verify automatic-layout source files, adapters, configuration and behavior are unchanged by this migration.
8. Run typecheck, unit tests, production build and relevant Playwright E2E tests. The decision is accepted now; implementation is not complete until these checks pass and the change is integrated into `main`.

## Non-goals

- Reintroducing `DiagramDocument`, a second persisted graph model or a parallel renderer.
- Rewriting automatic layout algorithms or their adapters.
- Moving standalone source-file I/O to Node.js or exposing local file paths to the server.
- Treating XML parse success as proof of correct rendering or successful user intent.
- Retaining a model-generated Draw.io JavaScript execution path under this or another name.
