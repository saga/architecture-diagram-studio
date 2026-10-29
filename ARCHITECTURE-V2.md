# Architecture Diagram Studio V2

- **Status:** Current architecture as of 2026-10-30.
- **Decisions:** [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md); [ADR-0012 — Native Diagram Extension Contracts](docs/adr/0012-native-diagram-extension-contracts.md); [ADR-0013 — Studio-Owned Layout Is a Core Feature](docs/adr/0013-studio-owned-layout-engines.md); [ADR-0020 — Native Script Assertion Contracts and Accurate Edit Outcomes](docs/adr/0020-native-script-assertion-contract-and-outcome-reporting.md); [ADR-0021 — Expanded Native Layout Engines](docs/adr/0021-expanded-native-layout-engines.md); [ADR-0022 — Atomic Spatial Region Layout](docs/adr/0022-atomic-spatial-region-layout.md); [ADR-0023 — Native Script Runtime Boundaries and Late Outcomes](docs/adr/0023-native-script-runtime-boundaries-and-late-outcomes.md); [ADR-0024 — Preserve Local Grouping and Offer Layout Density Presets](docs/adr/0024-local-grouping-and-layout-density-options.md).
- **Reference implementation:** v2/.
- **Capability and contract review:** [Native Copilot / Draw.io Capability Audit](docs/NATIVE-COPILOT-CAPABILITY-AUDIT.md).
- **Legacy:** V1 is read-only reference material.

## Core design

Draw.io's mxfile XML is the only authoritative diagram representation. The application does not persist a second graph or project edits back by regenerating XML. The embedded, locally bundled Draw.io editor owns rendering and interactive graph behavior. Copilot reads the current native XML and makes diagram mutations through the server-side `edit_drawio_xml` tool (ADR-0026). The server validates the revision-bound patch, validates and persists the resulting XML, then notifies the frontend to reload the authoritative revision. There is no model-facing typed-edit proposal, editor script, browser mutation or acknowledgement path. Workspace XML is persisted by the server; standalone source files remain browser-owned under ADR-0016. Automatic layout remains a separate Studio-owned path: it derives a temporary native-cell projection for the selected engine (ELK, Dagre, Graphviz, MSAGL.js, Cytoscape.js or D3), then applies a revision/page-bound geometry plan through the native editor bridge. The projection is discarded and is never an alternate document model.

Responsibilities are deliberately small:

1. The browser loads native XML in the iframe, reflects selection and sends the current XML snapshot/revision with Copilot requests. It does not apply model-generated typed edit operations or editor scripts. After a server-side XML commit it follows the authoritative persisted revision and reloads the editor; standalone files remain browser-owned and receive a revision-bound XML patch.
2. The Copilot service exposes native XML editing, read-only inspection/shape search, selection and outcome reporting. The XML editing tool is the only diagram mutation path for Copilot. It validates the source revision, applies a focused cell-scoped patch while preserving unrelated XML and metadata, validates the resulting document, and persists workspace changes.
3. The workspace service validates XML, applies optimistic revision checks, saves exact XML and stores immutable full-XML versions. The accepted workspace revision is the commit receipt; no browser-side mutation acknowledgement is required.
4. Agent Traces shows server-side Copilot/model-call records. Token and cost values are shown only when reported by the SDK/provider; missing metrics are not estimated.

## Studio-owned automatic layout

The toolbar exposes ELK, Dagre, Graphviz WASM, MSAGL.js, Cytoscape.js and D3 through one typed layout contract. Algorithm menus are engine-specific: ELK layered/Mr. Tree/radial/stress/force/box/Fixed/rectangle-packing/random/SPOrE overlap/SPOrE compaction; Dagre layered; Graphviz dot/neato/fdp/sfdp/circo/twopi; MSAGL layered/MDS/IPSepCola; Cytoscape breadth-first/circle/concentric/grid/random/CoSE/fCoSE; D3 tree/cluster/force. Box and rectangle packing are restricted to unconnected cells. Engines calculate against a disposable projection only; cell geometry and optional routes are applied to native Draw.io with revision checks, serialization acknowledgement and normal versioned persistence.

## Supported native operations

Copilot edits native XML directly on the server. The `run_drawio_script` tool and model-generated JavaScript execution path are removed entirely; do not retain a fallback under another name. Automatic layout remains on its existing typed planner/application path and is explicitly out of scope for ADR-0026; its engine set, algorithms, parameters and geometry application are unchanged. The model cannot write arbitrary workspace paths or bypass the server's validated document persistence service.

## Extension contracts without porting the old implementation

V2 does not include the former `DiagramDocument` model, semantic fixtures/templates, DiagramDocument-based layout/quality pipeline, semantic proposal pipeline, semantic XML importer/exporter, or secondary canvas. Its removal does not remove core layout: ADR-0013 and ADR-0021 define the active Studio-owned multi-engine path over temporary native-cell facts.

`v2/src/model/native-diagram-capabilities.ts` defines the seam for such work:

| Contract | Future use | Return type / rule |
| --- | --- | --- |
| `NativeDiagramCapabilityContext` | Exact XML revision, active page, selection and native cell index | Transient, read-only context; never persisted as a second model |
| `NativeDiagramOperationProvider` | Layout, routing, style and structural edits | A revision-bound geometry plan for the Studio-owned layout bridge; Copilot XML editing does not use this contract |
| `NativeDiagramAnalysisProvider` | Geometry, contrast, routing and accessibility checks | Findings linked to native page/cell IDs; no mutation side effects |
| `NativeDiagramCapabilityRegistry` | Explicit discovery of installed optional providers | Interface only; core layout is implemented separately and no optional quality provider is installed |

Future XML-first edits use the shared XML parser/schema, revision checks, native diff, version persistence and frontend synchronization. The existing layout planner and geometry-application path remain unchanged. Adding a new native operation requires synchronized updates to the operation union/schema, server validation, bridge execution and tests. The old reports under `docs/` remain research references for principles and use cases; their renderer and semantic-model code is not copied into active V2.

## Native Draw.io diagram color presets

The Diagram colors selector is a document operation, not a Studio appearance setting. Ten curated palettes define node/category fills, outlines, text and connectors; all leave the canvas background unset. A neutral default canvas keeps blocks visually separate instead of adding a large pastel field close to their fills. Fills use more visible mid-light tones; regression checks require 1.75:1 fill-to-white contrast, 3:1 outline-to-canvas/fill contrast, and 4.5:1 connector/label contrast. Applying a palette removes any explicit background from the active page, while stable `studioColorRole` markers preserve source category distinctions across switches. Text-only cells remain unfilled and outline-only shapes remain outlines. Pages with more than eight distinct source categories fail closed. Background clearing and cell styles share the same native Draw.io undoable transaction, so Undo restores the prior background and colors together; grid settings and other pages remain unchanged. Studio does not overlay the native Draw.io SVG. See [ADR-0023](docs/adr/0023-category-preserving-curated-diagram-palettes.md).

## Explicit non-goals

V2 does not restore the old semantic graph model or directly port the old SVG/React Flow renderer or DiagramDocument-based quality pipeline. V2 explicitly ships Studio-owned Dagre/ELK layout against native mxCells (ADR-0013). Future capabilities must not introduce a parallel persisted model or replace the complete XML.

## Code map

| Area | Responsibility |
| --- | --- |
| src/components/DrawioFrame.tsx | Native editor lifecycle, autosave and plugin bridge |
| src/components/NativeSelectionInspector.tsx | Read/edit selected native-cell properties |
| src/model/drawio-xml-schema.ts | Draw.io XML and encoded-page validation |
| src/model/native-edit-operations.ts | Native XML page identity and active-page cell index |
| src/model/native-diagram-capabilities.ts | Extension contracts for future native operation planners and read-only analyzers |
| src/model/drawio-theme.ts | Native Draw.io cell palette and clearing of active-page background; grid remains Draw.io-owned |
| src/hooks/useWorkspaceBootstrap.ts | Loads XML without conversion |
| src/hooks/useWorkspacePersistence.ts | Persists exact XML and chat state |
| src/intent/aiProvider.ts | XML-first Copilot request/response contract |
| server/copilot/intent-route.ts | Copilot SDK tool registration, XML patching and persistence |
| server/copilot-server.ts | Workspace, XML revisions and version persistence |
| plugins/studio-selection-plugin.js | Native Draw.io graph operations |



## Validation

Run typecheck, unit tests, end-to-end tests and build after code changes. Tests should focus on native XML preservation, unknown attributes/cells/pages, cell-scoped patch validation, stale revision conflicts, workspace persistence, standalone patch receipts and version recovery. Do not add parity tests for a removed semantic graph.
