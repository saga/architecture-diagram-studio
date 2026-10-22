# Architecture Diagram Studio V2

- **Status:** Current architecture as of 2026-10-22.
- **Decision:** [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md).
- **Reference implementation:** v2/.
- **Legacy:** V1 is read-only reference material.

## Core design

Draw.io's mxfile XML is the only diagram representation. The application does not parse a second graph and project edits back into XML. The embedded, locally bundled Draw.io editor owns rendering and interactive graph behavior.

Responsibilities are deliberately small:

1. The browser loads native XML in the iframe, reflects selected-cell properties, sends typed Copilot requests, forwards operations through the first-party plugin bridge, and waits for an editor acknowledgement.
2. The Copilot service resolves targets against cells on the active Draw.io page, validates operation arguments, and exposes only the native edit and selection tools.
3. The workspace service validates XML, applies optimistic revision checks, saves exact XML, and stores snapshots containing the complete XML.
4. Agent Traces shows browser events and server-side Copilot/model-call records. Token and cost values are shown only when reported by the SDK/provider; missing metrics are not estimated.

## Supported native operations

The current allowlist covers selection, label changes, fillColor/strokeColor/fontColor, move, resize, deletion, and add_node_after (insert a vertex to the right of a target and connect it). The model cannot submit raw replacement XML or arbitrary workspace writes.

## Explicit non-goals

V2 has no DiagramDocument, semantic fixtures/templates, custom graph layout or quality-scoring pipeline, semantic proposal engine, semantic XML importer/exporter, or secondary canvas. If a future requirement needs a specific capability, it must operate directly on native mxGraph cells with a concrete use case and narrow validation. It must not reintroduce a parallel graph model.

## Code map

| Area | Responsibility |
| --- | --- |
| src/components/DrawioFrame.tsx | Native editor lifecycle, autosave and plugin bridge |
| src/components/NativeSelectionInspector.tsx | Read/edit selected native-cell properties |
| src/model/drawio-xml-schema.ts | Draw.io XML and encoded-page validation |
| src/model/native-edit-operations.ts | Typed native operations and active-page cell index |
| src/model/drawio-theme.ts | Editor background/theme adapter |
| src/hooks/useWorkspaceBootstrap.ts | Loads XML without conversion |
| src/hooks/useWorkspacePersistence.ts | Persists exact XML and chat state |
| src/intent/aiProvider.ts | Native edit request/response contract |
| server/copilot/intent-route.ts | Copilot SDK tool registration and native operations |
| server/copilot-server.ts | Workspace, XML revisions and version persistence |
| plugins/studio-selection-plugin.js | Native Draw.io graph operations |

## Validation

Run typecheck, unit tests, end-to-end tests and build after code changes. Tests should focus on native XML preservation, unknown attributes/cells/pages, operation allowlists, atomic batch rollback, revision conflicts, and version recovery. Do not add parity tests for a removed semantic graph.
