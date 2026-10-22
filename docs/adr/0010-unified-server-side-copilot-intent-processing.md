# ADR-0010: Unified Server-Side Copilot Intent Processing

- Status: Accepted
- Date: 2026-10-22
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0003 — Server-authoritative diagram operations](./0003-server-authoritative-diagram-operations.md), [ADR-0005 — Internal Copilot Diagram Intelligence and Governed Edits](./0005-diagram-aware-mcp-intelligence.md), [ADR-0006 — Draw.io XML as the Single Source of Truth](./0006-drawio-xml-single-source-of-truth.md), [ADR-0009 — Centralized Draw.io XML Processing](./0009-centralized-drawio-xml-processing.md), [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md)

## Compatibility Note

ADR-0011 supersedes this ADR wherever it assumes that `DiagramDocument` is the active editing model or that a semantic projection is a prerequisite for ordinary native-cell edits. Keep the unified intent pipeline, typed native operations, native selection, revision validation, and explicit acknowledgement rules; remove the parallel semantic-document dependency. For future layout, style, structural-edit, or quality-analysis capabilities, use the extension contracts in ADR-0012. The older semantic examples below describe intended behavior, not currently installed providers.

## Context

Copilot intent handling currently diverges by execution mode. The standalone frontend contains regex-based command parsing, XML inspection, target-label matching and direct dispatch to the native Draw.io bridge. Workspace mode sends natural-language requests to the server-side GitHub Copilot SDK and exposes internal diagram tools. These paths do not share the same intent interpretation, target resolution, validation or result semantics.

This creates observable failures: equivalent requests behave differently by mode; natural-language variations such as “把 X 改名 Y” can miss a regex; references such as “当前选中的元素” can be lost because native Draw.io selection is not the same as the partial semantic projection's selected node; and frontend parsing can report or attempt an operation without using the server's governed execution path.

The complete Draw.io `mxfile` XML is the only authoritative diagram source. `DiagramDocument` is a derived, potentially partial projection and must never be treated as a complete inventory when projection completeness is false.

## Decision

### 1. One intent pipeline

All natural-language Copilot requests, in both workspace and standalone Draw.io modes, MUST enter the same server-side intent endpoint and intent-processing pipeline. The frontend MUST NOT parse natural language, choose an operation from regexes, resolve target labels, or independently decide whether a request is an edit, layout plan or proposal.

The shared pipeline is:

1. Validate the request envelope and mode-specific authorization.
2. Assemble authoritative context: current Draw.io XML or its server-validated snapshot/revision, projection completeness, current native selection (cell ID and page ID), diagram kind, and the available execution capabilities.
3. Use the configured Copilot SDK session and internal tools to interpret the request and resolve the target. Natural-language interpretation belongs to the model/tool pipeline, not browser regexes.
4. Convert the intent into an allowlisted, typed operation. Validate required arguments, target existence and uniqueness, selection freshness, operation scope, XML structure, and revision.
5. Execute through a mode-specific adapter behind the same server orchestration contract.
6. Return a structured outcome that distinguishes applied, proposal-required, unsupported, ambiguous, stale-context and failed states. The frontend displays this outcome and does not infer success from a submitted request.
7. Record the request, selected target, tool calls, validation decisions, base/current revision, execution result, persistence result and failure reason in the existing Copilot/diagnostic trajectory.

### 2. Frontend is a transport and presentation layer

The frontend may collect user text, selected native cell/page IDs, current session and document revision; submit these to the server; render progress and structured results; and forward an explicitly authorized native-editor command through the Draw.io bridge. It MUST NOT contain a second intent interpreter.

Remove standalone regex command handling, label-to-cell matching, batch natural-language parsing and mode-specific natural-language shortcuts from `useCopilotIntent.ts` and related UI modules. Do not replace them with another frontend parser or a parallel rules engine. Deterministic validation and execution remain on the server or in the native editor's narrow execution bridge.

The Draw.io iframe bridge is not an intent interpreter. It is a constrained adapter for applying server-authorized operations to the live native editor, returning an acknowledgement and the resulting XML/save state.

### 3. Shared orchestration, mode-specific adapters

Workspace and standalone modes share intent interpretation, operation schemas, ambiguity handling, authorization rules, audit events and result semantics. They differ only in state ownership and the final persistence/execution adapter:

- **Workspace mode:** the server reads and mutates the authoritative workspace XML, validates the expected revision, preserves unsupported/native XML, creates an immutable version for successful mutations, and reports the resulting workspace revision. A semantic operation is allowed only when its required projection is complete. Native XML operations must not reconstruct the full file from a partial `DiagramDocument`.
- **Standalone Draw.io mode:** the server receives the current XML snapshot and its content hash/revision token plus the native selection. It validates and authorizes the requested operation, then returns a typed command for the native Draw.io bridge where the live editor is the execution surface. The bridge acknowledges success/failure and returns the resulting XML/save acknowledgement; the server must not report an edit as applied before that acknowledgement. Standalone mode does not create workspace version records, but must retain request/operation/result diagnostics and must not overwrite a newer local XML snapshot.

The server must not expose workspace-bound tools or filesystem access to standalone sessions. The mode flag is authorization input, not a prompt-only convention; the server validates it against the request and available state.

### 4. Native selection is first-class context

The request contract MUST carry the current native `cellId` and `pageId` (nullable when there is no selection), plus the document revision/hash from which the selection was observed. “Current selected element” resolves to this native selection, not to `selectedNode` in the semantic projection.

Before execution, validate that the selected cell still exists in the same page and current XML revision. If the selection is absent, stale, or incompatible with the requested operation, ask for clarification or return a structured non-applied result. Never guess a target based solely on a duplicate label. Label-based references must resolve uniquely against the authoritative XML or return an ambiguity result.

### 5. Typed operations and safe execution

The model must select from server-defined operation tools/schemas; it must not emit executable JavaScript, arbitrary commands, or raw replacement XML. Native XML edits must use the shared XML parse/validation boundary and a loss-preserving, allowlisted cell operation. Preserve unknown attributes, cells, pages and metadata. If the intended change cannot be applied safely without reconstructing unsupported XML, fail closed and explain why.

Examples such as rename, move by a delta, resize, delete, selection alignment, grouping and relation edits must be represented as explicit typed operations with validated arguments. A request like “move the currently selected element up by 10px” must resolve to the selected cell and a bounded geometry delta; “rename X to Y” must resolve the target unambiguously and validate the new label. These examples define expected behavior, not permission to bypass the operation allowlist.

Focused, explicit edits may be directly applied only under the existing ADR-0005 governance rules. Broad, ambiguous, bulk-destructive, template replacement and restore requests require a reviewable proposal and explicit confirmation. Every workspace mutation must use an expected revision and create a version snapshot. A failed operation must not be reported as successful.

### 6. Prompt and tool contract

The server constructs one canonical instruction set for intent interpretation and execution. Legacy configurable prompt fragments that contradict the canonical governance rules must be migrated or normalized; appending a final “supersedes previous instructions” paragraph is not an adequate substitute for removing contradictions.

Tool descriptions and schemas must agree with the actual mode capabilities. Standalone sessions must expose supported native-edit tools through the same orchestration contract, not only a global-layout-plan tool. Workspace sessions may use workspace inspection, retrieval, proposal and governed edit tools. A tool result is the source of truth for whether an operation was applied.

If the model returns text without a tool call, retries are bounded and logged. A retry may improve tool selection but must not weaken validation, invent a successful result, or silently convert a failed mutation into a success.

### 7. Result and audit contract

Every request returns a discriminated outcome, at minimum:

- `applied`: includes operation ID, resolved target, execution acknowledgement and resulting revision/hash; workspace edits also include the immutable version ID.
- `proposal_required`: includes proposal ID, base revision and confirmation requirement.
- `needs_clarification`: identifies the unresolved target or missing argument; no mutation occurred.
- `unsupported`: explains the unsupported operation or capability; no mutation occurred.
- `stale_context`: asks the caller to refresh the document/selection; no mutation occurred.
- `failed`: includes a safe user-facing reason and diagnostic correlation ID; no success is implied.

Audit logs must distinguish model interpretation, tool invocation, validation, native-editor acknowledgement, persistence acknowledgement and final response. Never log secrets. Bound prompt/context/log payload sizes and treat XML labels and workspace content as untrusted evidence rather than instructions.

## Consequences

- Workspace and standalone Copilot requests follow the same interpretation and governance path.
- Natural-language handling and target resolution no longer drift between browser and server implementations.
- Native Draw.io selection is available to the server as explicit, revision-bound context.
- Native XML remains authoritative even when the semantic projection is incomplete.
- The frontend and Draw.io bridge remain small: transport/presentation and constrained native execution respectively.
- A capability is not considered complete until both modes, selection handling, execution acknowledgement, persistence, audit events and regression tests satisfy the criteria below.

## Rejected alternatives

- **Keep regex parsing in standalone mode and tune it:** rejected because it preserves divergent behavior and cannot robustly interpret contextual natural language.
- **Move the regexes to another frontend helper:** rejected because it only relocates the duplicate intent interpreter.
- **Force all native XML edits through the semantic projection:** rejected because the projection may be partial and must not replace authoritative XML.
- **Let the model author raw XML or JavaScript:** rejected because it bypasses allowlisted operations, source preservation, revision checks and validation.
- **Treat a tool call as proof of success:** rejected because native execution and persistence can still fail after dispatch.

## Implementation and verification checklist

See [Native Copilot / Draw.io Capability Audit](../NATIVE-COPILOT-CAPABILITY-AUDIT.md) for the current implementation status, operation gaps and verification caveats.

This ADR records the required architecture; it does not assert that the migration is already implemented or tested. Mark each item complete only with code and regression-test evidence.

- [x] Remove natural-language regex parsing and direct intent decisions from frontend Copilot hooks/components; the V2 hook submits a typed snapshot and handles explicit server outcomes only.
- [x] Route standalone and workspace requests through the same server intent endpoint and orchestration.
- [x] Add validated request fields for native selected cell/page and document revision/hash.
- [x] Implement allowlisted native-cell operations through the server-to-Draw.io bridge, with explicit editor acknowledgement and returned XML/save state; workspace mode waits for the revision-checked save.
- [x] Ensure workspace XML mutation is loss-preserving, revision-checked, server-validated and versioned.
- [x] Normalize conflicting legacy prompts and make tool schemas/descriptions consistent with mode capabilities.
- [x] Return the discriminated outcome contract for `command_ready`, `proposal_required`, `selected`, `answered`, `needs_clarification`, `unsupported`, `stale_context`, and `failed`; final `applied` results require editor acknowledgement, resolved targets, XML revision and immutable version reference.
- [x] Add route-level tests for typed no-mutation outcomes, invalid source hashes, stale page/selection, workspace changes during model latency, duplicate labels beyond the first 200 cells, standalone isolation, review-proposal confirmation/replay, acknowledgement expiry/replay, immutable-version mismatch, and conflicting terminal tool calls.
- [ ] Complete the remaining intent/browser matrix: Chinese and English rename variants; all four selected-cell move directions; resize/delete; selection alignment/grouping and relation edits if supported; malformed XML; native-editor/save failure; and standalone/workspace browser-adapter parity. Unsupported capabilities must return `unsupported` rather than silently mutating the diagram.
- [ ] Add integration tests proving the same intent resolves consistently in workspace and standalone modes while using their respective adapters.
- [x] Verify that no frontend regex or local-rules path interprets natural-language edit requests in the active V2 Copilot path.
- [x] Verify diagnostics distinguish model interpretation, tool calls, request/revision validation, native-editor acknowledgement, persistence/version acknowledgement, and final outcome.
- [ ] Run relevant tests and build checks, then report actual results and any remaining gaps separately.

## Session-level SDK callback policy

Copilot SDK permission and MCP authentication callbacks are part of the session configuration, not implicit behavior supplied by the client. The application MUST install the intended `onPermissionRequest` and `onMcpAuthRequest` callbacks in the configuration passed to both `resumeSession` and `createSession`. Otherwise, a permission request may be emitted as a pending event without a consumer resolving it, leaving a turn waiting indefinitely.

Studio's current policy is deliberately local to this application:

- The client uses `mode: "empty"`; a session exposes only Studio-owned custom tools, not ambient shell or filesystem tools.
- Studio approves those tool requests once. The server still validates each requested operation, resolves targets against the native Draw.io XML and current revision, waits for editor acknowledgement, and follows the normal save/version path before reporting an edit as applied.
- If a permission request carries `managedApprovalRequired`, or the SDK invocation reports that managed settings are enabled, Studio returns `user-not-available`. This is fail-closed behavior because Studio has no managed-approval UI or broker; returning `no-result` here would leave the request awaiting another participant rather than producing a user-facing denial.
- Studio has no MCP OAuth user interface or token broker, so MCP auth requests are explicitly cancelled and logged. The caller must surface an actionable message if an operation requires external authentication.

The callbacks MUST NOT await logging or other nonessential I/O. Diagnostics are scheduled separately and their synchronous exceptions and rejected promises are isolated from the SDK callback result. A callback must always settle promptly.

This policy is not a common runtime default. `common-agent-lib` provides a `CopilotSessionPolicy` type seam and documents the SDK contract, but leaves permission decisions, OAuth handling, available-tool scope and user-facing error behavior to each host application. Any future change to the session's tool set or side effects requires reviewing this application's approval decision and the server-side operation governance together.

