# ADR-0006: Draw.io XML as the Single Source of Truth

- Status: Accepted
- Date: 2026-10-22
- Supersedes: the semantic-source-of-truth wording in `ARCHITECTURE-V2.md` and earlier design notes where it conflicts with this decision.

## Context

The Studio originally modeled C4, flowchart and sequence diagrams in `DiagramDocument`, then generated a Draw.io `mxfile` as an output projection. That model cannot represent the full Draw.io document format: arbitrary stencils and custom shapes, nested cells, groups and swimlanes, edge-to-edge connections, layers, multiple pages, HTML labels, UserObject wrappers and custom attributes. Importing these documents into the semantic model and exporting them again is inherently lossy. Automatic layout and semantic validation also make assumptions that are not valid for every Draw.io diagram.

Supporting all diagram types must not mean rebuilding mxGraph's data model inside this application or choosing between two independent document representations.

## Decision

**The native Draw.io XML (`mxfile`) is the only authoritative source of truth for every diagram.**

1. The complete XML document, including all pages and metadata, is the durable source for editing, autosave, version snapshots, recovery, export and workspace-file writes.
2. `DiagramDocument` is a derived, partial projection for supported C4/flowchart/sequence semantic operations. It is not a second source of truth and must never replace the original XML wholesale.
3. Any supported semantic edit must be translated into a narrowly scoped XML cell update against the current authoritative XML. It must preserve untouched cells, geometry, style keys, nesting, pages and custom attributes. If safe patching cannot be established, reject or disable that edit; never fall back to serializing the projection as a new document.
4. The bundled native Draw.io editor is the general-purpose editor for every Draw.io-supported shape and document feature. The native Draw.io editor is the only diagram canvas for every document. Semantic layout, validation and editing tools are optional capabilities and are unavailable for a document unless a lossless operation can be proven.
5. Import and workspace bootstrap must retain the original XML and must not automatically relayout it. Layout is an explicit opt-in operation and only runs through a supported semantic view.
6. Persistence and versioning store the full authoritative XML. Server validation for document persistence checks the XML envelope, size, optimistic revision and workspace boundaries; semantic/layout validation applies to semantic operations, not as a gate for arbitrary valid Draw.io documents.
7. Copilot must not author arbitrary XML text. Native-document AI editing, when enabled, uses typed, allowlisted cell operations (for example, set text, move/resize cell, update approved style keys, add/delete edge, add page) applied by server code to the authoritative XML, with revision checks and an immutable version snapshot. Raw XML remains untrusted input and is never directly executed.
8. Multi-page, unknown and custom cells are retained even when the current semantic projection cannot display or understand them. A partial projection must not be mistaken for a complete inventory of the file.

## XML schema boundary

The shared Zod validation module is `v2/src/model/drawio-xml-schema.ts`. It validates native XML roots (`mxfile`, legacy `mxGraphModel`) and the distinct `mxlibrary` root, including page payload decoding. The schema deliberately uses open attribute maps and preserves unknown child elements: custom shape names, arbitrary style IDs, user-object wrapper names and extension metadata are part of Draw.io's extensible format, not a finite enum. Standalone `.drawio.svg`, `.drawio.png`, HTML viewer exports and PDF containers require container-specific extraction before their embedded XML can be validated; they are not themselves native `mxfile` XML inputs to this validator.

### Zod validation contract

The validator is implemented in `v2/src/model/drawio-xml-schema.ts` and is shared by browser import and server persistence. It covers `mxfile`, one or more `diagram` pages, inline and compressed/raw-DEFLATE page payloads, bare `mxGraphModel`, the root cell inventory, `mxCell`, `mxGeometry`, points/rectangles/arrays, `defs/def`, UserObject/custom wrappers, and the separate `mxlibrary` library format.

The upstream Draw.io implementation inspected for this decision is the codec/page machinery, not a closed shape catalogue: [mxCellCodec](https://github.com/jgraph/drawio/blob/17b367b91dbab91804f852645788d7ffb46dcb79/src/main/webapp/mxgraph/src/io/mxCellCodec.js), [mxModelCodec](https://github.com/jgraph/drawio/blob/17b367b91dbab91804f852645788d7ffb46dcb79/src/main/webapp/mxgraph/src/io/mxModelCodec.js), [Pages.js](https://github.com/jgraph/drawio/blob/17b367b91dbab91804f852645788d7ffb46dcb79/src/main/webapp/js/diagramly/Pages.js), and [StorageFile.js](https://github.com/jgraph/drawio/blob/17b367b91dbab91804f852645788d7ffb46dcb79/src/main/webapp/js/diagramly/StorageFile.js). Zod validates structural invariants but intentionally leaves custom shapes, style keys, XML attributes, user-object metadata and extension elements open. DTD/custom entity declarations are rejected.

## Consequences

- We do not introduce `SemanticDocument | NativeDocument` as two competing persistent document sources.
- We do not expand `DiagramDocument` to duplicate all mxGraph features.
- The application can keep optimized semantic layout, quality evaluation and design-language tools for supported diagrams, but those features are optional derived capabilities.
- Semantic operations are enabled only when a completeness check confirms that the source can be safely projected and patched. The native Draw.io canvas remains available for every valid document; unsafe semantic operations are disabled with an explanation.
- XML patching must preserve outer `mxfile` and page/model metadata, merge changes by cell identity, retain cells unknown to the semantic projection, and never regenerate the whole document from the projection.
- Tests must cover lossless no-op round trips, preservation of unknown cells and page metadata, safe patch refusal, raw XML save/reopen, and protection against automatic layout on import.

## Rejected alternatives

### Keep `DiagramDocument` as the canonical source and add passthrough XML

Rejected because edits still require reconciling two durable states and a general-purpose XML payload. Version history, undo/redo and concurrent changes would have to decide which source wins.

### Introduce separate semantic and native document tracks

Rejected because it creates two persistence contracts and a classification/migration boundary that the product does not need. All documents are Draw.io documents; semantic editing is a capability over a projection, not a different document type.

### Expand the semantic model to cover every Draw.io shape and feature

Rejected because the shape/stencil space is open-ended and user-extensible. Reimplementing arbitrary labels, parent trees, layers, pages, custom shapes and embedded metadata would duplicate the native model while still lagging behind it.

## Implementation plan

1. **P0 safety:** XML-first import and persistence; preserve XML across editor callbacks; remove automatic layout from import/bootstrap; make semantic editing conditional on a lossless projection; never drop back to whole-document regeneration for unsupported XML.
2. **P1 XML patching:** introduce a tested source adapter that verifies projection completeness and applies cell-level patches while preserving unknown XML.
3. **P2 typed XML operations:** expose safe server-side cell operations to Copilot and the UI, each guarded by source revision, validation and versioning.
4. **P3 optional semantic capabilities:** keep C4/flowchart/sequence algorithms as plug-in operations over a derived projection. Add new semantic algorithms only where they provide value; do not require them for opening, editing or saving a Draw.io document.

## Acceptance criteria

- Opening and saving a valid multi-page or custom-shape `.drawio` document without changes preserves its full XML content.
- No import path invokes automatic layout.
- Editing a supported application-authored diagram updates the canonical XML by cell identity while retaining page/model metadata.
- If the source has opaque or structurally unsupported content, semantic edit controls and automatic layout are disabled rather than allowing destructive writes.
- Workspace files and version snapshots always persist the authoritative `mxfile`, not XML reconstructed from `DiagramDocument`.
