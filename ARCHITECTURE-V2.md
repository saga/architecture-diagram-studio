# Architecture Diagram Studio V2

- **Status:** Current architecture as of 2026-10-23.
- **Decisions:** [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md); [ADR-0012 — Native Diagram Extension Contracts](docs/adr/0012-native-diagram-extension-contracts.md).
- **Reference implementation:** v2/.
- **Capability and contract review:** [Native Copilot / Draw.io Capability Audit](docs/NATIVE-COPILOT-CAPABILITY-AUDIT.md).
- **Legacy:** V1 is read-only reference material.

## Core design

Draw.io's mxfile XML is the only diagram representation. The application does not parse a second graph and project edits back into XML. The embedded, locally bundled Draw.io editor owns rendering and interactive graph behavior.

Responsibilities are deliberately small:

1. The browser loads native XML in the iframe, reflects selected-cell properties, sends typed Copilot requests with a source hash, displays review-required proposals, forwards only confirmed/revision-valid operations through the first-party plugin bridge, waits for serialized XML, persists workspace edits, and posts the final result to the server's acknowledgement endpoint.
2. The Copilot service returns discriminated outcomes for commands, proposals, selection, ordinary answers, clarification, unsupported requests, stale context and failures. It validates the XML snapshot/revision, resolves targets against the full active-page cell index, validates operation arguments, and exposes only typed native-edit/selection/outcome tools. The model-facing cell summary is bounded for prompt size; server-side uniqueness checks use the full index.
3. The workspace service validates XML, applies optimistic revision checks, saves exact XML, stores immutable full-XML versions, and verifies final applied receipts against the version ID and XML hash.
4. Agent Traces shows browser events and server-side Copilot/model-call records. Token and cost values are shown only when reported by the SDK/provider; missing metrics are not estimated.

## Supported native operations

The current allowlist covers selection, label changes, fillColor/strokeColor/fontColor, move, resize, deletion, and add_node_after (insert a vertex to the right of a target and connect it). The model cannot submit raw replacement XML or arbitrary workspace writes.

## Extension contracts without porting the old implementation

V2 does not currently include the former `DiagramDocument` model, semantic fixtures/templates, custom layout/quality engine, semantic proposal pipeline, semantic XML importer/exporter, or secondary canvas. Their removal is an implementation decision, not a ban on future layout, geometry, style, or quality capabilities.

`v2/src/model/native-diagram-capabilities.ts` defines the seam for such work:

| Contract | Future use | Return type / rule |
| --- | --- | --- |
| `NativeDiagramCapabilityContext` | Exact XML revision, active page, selection and native cell index | Transient, read-only context; never persisted as a second model |
| `NativeDiagramOperationProvider` | Layout, routing, style and structural edits | A revision-bound plan using `NativeEditOperation[]`; never raw replacement XML |
| `NativeDiagramAnalysisProvider` | Geometry, contrast, routing and accessibility checks | Findings linked to native page/cell IDs; no mutation side effects |
| `NativeDiagramCapabilityRegistry` | Explicit discovery of installed providers | Interface only; no generic registry or optional provider is currently installed |

A future provider should reuse the shared XML parser/schema, target resolver, typed operation validation, plugin bridge, editor acknowledgement, and XML revision/version path. Adding a new native operation requires synchronized updates to the operation union/schema, server validation, bridge execution and tests. The old reports under `docs/` remain research references for principles and use cases; their renderer and semantic-model code is not copied into active V2.

## Explicit non-goals

V2 does not restore the old semantic graph model or directly port the old SVG/React Flow renderer, layout engines, or quality pipeline. New capability work requires a concrete use case and must operate against native mxCells through the extension contracts, without introducing a parallel persisted model or replacing the complete XML.

## Code map

| Area | Responsibility |
| --- | --- |
| src/components/DrawioFrame.tsx | Native editor lifecycle, autosave and plugin bridge |
| src/components/NativeSelectionInspector.tsx | Read/edit selected native-cell properties |
| src/model/drawio-xml-schema.ts | Draw.io XML and encoded-page validation |
| src/model/native-edit-operations.ts | Typed native operations and active-page cell index |
| src/model/native-diagram-capabilities.ts | Extension contracts for future native operation planners and read-only analyzers |
| src/model/drawio-theme.ts | Editor background/theme adapter |
| src/hooks/useWorkspaceBootstrap.ts | Loads XML without conversion |
| src/hooks/useWorkspacePersistence.ts | Persists exact XML and chat state |
| src/intent/aiProvider.ts | Native edit request/response contract |
| server/copilot/intent-route.ts | Copilot SDK tool registration and native operations |
| server/copilot-server.ts | Workspace, XML revisions and version persistence |
| plugins/studio-selection-plugin.js | Native Draw.io graph operations |



## Validation

Run typecheck, unit tests, end-to-end tests and build after code changes. Tests should focus on native XML preservation, unknown attributes/cells/pages, operation allowlists, atomic batch rollback, revision conflicts, and version recovery. Do not add parity tests for a removed semantic graph.
