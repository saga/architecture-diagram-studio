# Architecture Diagram Studio V2

- **Status:** Current architecture as of 2026-10-25.
- **Decisions:** [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md); [ADR-0012 — Native Diagram Extension Contracts](docs/adr/0012-native-diagram-extension-contracts.md); [ADR-0013 — Studio-Owned Layout Is a Core Feature](docs/adr/0013-studio-owned-layout-engines.md); [ADR-0021 — Expanded Native Layout Engines](docs/adr/0021-expanded-native-layout-engines.md).
- **Reference implementation:** v2/.
- **Capability and contract review:** [Native Copilot / Draw.io Capability Audit](docs/NATIVE-COPILOT-CAPABILITY-AUDIT.md).
- **Legacy:** V1 is read-only reference material.

## Core design

Draw.io's mxfile XML is the only authoritative diagram representation. The application does not persist a second graph or project edits back by regenerating XML. The embedded, locally bundled Draw.io editor owns rendering and interactive graph behavior. Automatic layout is a core exception only in the computational sense: Studio derives a temporary native-cell projection for the selected layout engine (ELK, Dagre, Graphviz, MSAGL.js, Cytoscape.js or D3), then applies a revision/page-bound geometry plan through the native editor bridge. The projection is discarded and is never an alternate document model.

Responsibilities are deliberately small:

1. The browser loads native XML in the iframe, reflects selected-cell properties, and sends typed Copilot requests with a source hash. It directly dispatches validated typed operations when the risk gate allows them, displays summary-only proposals for review-gated changes, and only dispatches those after explicit confirmation and revision checks. It then waits for serialized XML, persists workspace edits, and posts the final result to the server's acknowledgement endpoint.
2. The Copilot service returns discriminated outcomes for commands, proposals, selection, ordinary answers, clarification, unsupported requests, stale context and failures. It validates the XML snapshot/revision, resolves targets against the full active-page cell index, validates operation arguments, and exposes only typed native-edit/selection/outcome tools. The model-facing cell summary is bounded for prompt size; server-side uniqueness checks use the full index.
3. The workspace service validates XML, applies optimistic revision checks, saves exact XML, stores immutable full-XML versions, and verifies final applied receipts against the version ID and XML hash.
4. Agent Traces shows browser events and server-side Copilot/model-call records. Token and cost values are shown only when reported by the SDK/provider; missing metrics are not estimated.

## Studio-owned automatic layout

The toolbar exposes ELK, Dagre, Graphviz WASM, MSAGL.js, Cytoscape.js and D3 through one typed layout contract. Algorithm menus are engine-specific: ELK layered/Mr. Tree/radial/stress/force/DisCo/box/Fixed/rectangle-packing/random/SPOrE overlap/SPOrE compaction; Dagre layered; Graphviz dot/neato/fdp/sfdp/circo/twopi; MSAGL layered/MDS/IPSepCola; Cytoscape breadth-first/circle/concentric/grid/random/CoSE/fCoSE; D3 tree/cluster/force. Box and rectangle packing are restricted to unconnected cells. Engines calculate against a disposable projection only; cell geometry and optional routes are applied to native Draw.io with revision checks, serialization acknowledgement and normal versioned persistence.

## Supported native operations

The current allowlist covers selection, label changes, fillColor/strokeColor/fontColor, move, resize, deletion, `add_node_after`, `add_node_below`, and `auto_layout`. Whole-page `auto_layout` is an Agent-native typed operation, must be alone in its batch, and always requires user confirmation. It uses the same configurable multi-engine planner as the toolbar; it never calls Draw.io's built-in layout action or asks the model to write a layout script. A typed batch that does not trigger the server's review gate otherwise executes after page/revision/target validation without a separate confirmation click. Broad batches and review-gated scripts require explicit confirmation; chat proposals show the intended changes, not script source. The model cannot submit raw replacement XML or arbitrary workspace writes.

## Extension contracts without porting the old implementation

V2 does not include the former `DiagramDocument` model, semantic fixtures/templates, DiagramDocument-based layout/quality pipeline, semantic proposal pipeline, semantic XML importer/exporter, or secondary canvas. Its removal does not remove core layout: ADR-0013 and ADR-0021 define the active Studio-owned multi-engine path over temporary native-cell facts.

`v2/src/model/native-diagram-capabilities.ts` defines the seam for such work:

| Contract | Future use | Return type / rule |
| --- | --- | --- |
| `NativeDiagramCapabilityContext` | Exact XML revision, active page, selection and native cell index | Transient, read-only context; never persisted as a second model |
| `NativeDiagramOperationProvider` | Layout, routing, style and structural edits | A revision-bound plan using `NativeEditOperation[]`; never raw replacement XML |
| `NativeDiagramAnalysisProvider` | Geometry, contrast, routing and accessibility checks | Findings linked to native page/cell IDs; no mutation side effects |
| `NativeDiagramCapabilityRegistry` | Explicit discovery of installed optional providers | Interface only; core layout is implemented separately and no optional quality provider is installed |

A future provider should reuse the shared XML parser/schema, target resolver, typed operation validation, plugin bridge, editor acknowledgement, and XML revision/version path. Adding a new native operation requires synchronized updates to the operation union/schema, server validation, bridge execution and tests. The old reports under `docs/` remain research references for principles and use cases; their renderer and semantic-model code is not copied into active V2.

## Native Draw.io diagram color presets

The Diagram colors selector is an explicit document operation, not a Studio appearance setting. It updates the native XML style properties of vertices and connectors across ordinary and compressed pages, then follows the active workspace or standalone-file save/version path. Existing cell colors are intentionally replaced by the selected palette; non-color styles, geometry, labels, connections, page backgrounds, grid settings, and unrelated XML metadata are preserved. Studio does not inject a stylesheet that paints over the native Draw.io graph SVG. See [ADR-0020](docs/adr/0020-native-drawio-diagram-theme-presets.md).

## Explicit non-goals

V2 does not restore the old semantic graph model or directly port the old SVG/React Flow renderer or DiagramDocument-based quality pipeline. V2 explicitly ships Studio-owned Dagre/ELK layout against native mxCells (ADR-0013). Future capabilities must not introduce a parallel persisted model or replace the complete XML.

## Code map

| Area | Responsibility |
| --- | --- |
| src/components/DrawioFrame.tsx | Native editor lifecycle, autosave and plugin bridge |
| src/components/NativeSelectionInspector.tsx | Read/edit selected native-cell properties |
| src/model/drawio-xml-schema.ts | Draw.io XML and encoded-page validation |
| src/model/native-edit-operations.ts | Typed native operations and active-page cell index |
| src/model/native-diagram-capabilities.ts | Extension contracts for future native operation planners and read-only analyzers |
| src/model/drawio-theme.ts | Native Draw.io cell color-preset transformation; page backgrounds/grid remain Draw.io-owned |
| src/hooks/useWorkspaceBootstrap.ts | Loads XML without conversion |
| src/hooks/useWorkspacePersistence.ts | Persists exact XML and chat state |
| src/intent/aiProvider.ts | Native edit request/response contract |
| server/copilot/intent-route.ts | Copilot SDK tool registration and native operations |
| server/copilot-server.ts | Workspace, XML revisions and version persistence |
| plugins/studio-selection-plugin.js | Native Draw.io graph operations |



## Validation

Run typecheck, unit tests, end-to-end tests and build after code changes. Tests should focus on native XML preservation, unknown attributes/cells/pages, operation allowlists, atomic batch rollback, revision conflicts, and version recovery. Do not add parity tests for a removed semantic graph.
