# ADR-0019: Native Draw.io Document Style Library

- Status: Accepted
- Date: 2026-10-25
- Related: [ADR-0006 — Draw.io XML as the Single Source of Truth](./0006-drawio-xml-single-source-of-truth.md), [ADR-0007 — Unified Theme Adapter for Native Draw.io](./0007-unified-theme-adapter-for-native-drawio.md), [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md)

## Context

The existing "theme" selector was originally treated as an application presentation preference. Its label and wiring taught the wrong interaction model: a user choosing a Draw.io style expects the diagram XML to change, not the Studio's UI. The injected presentation CSS also applied an opaque background to `.geDiagramContainer svg`, which covers Draw.io's own page background and grid. CSS styling cannot replace a user-visible document-style operation.

The product needs a configurable set of visual styles that can be applied to existing native cells, used for subsequently created cells, imported/exported one style at a time, and deleted without damaging diagrams that already use its styles.

## Decision

### Style selection means a Draw.io document operation

1. The top-level style dropdown selects a **Draw.io document style**. Choosing a style explicitly rewrites the native cell style strings in the live Draw.io runtime and the resulting native XML is saved through the existing document pipeline. This dropdown does not change the Studio CSS theme or Ant Design theme.
2. The application UI theme remains a separate presentation preference. Its CSS may style editor chrome and the whitespace around the drawing but must not set opaque backgrounds on the graph SVG, page surface, or grid layer. The document's `mxGraphModel background`, `backgroundImage`, grid and page settings remain owned by Draw.io.
3. Opening/importing a diagram does not silently apply a document style. When the document has no recognized Studio style revision, the selector displays `Original` without changing source XML.
4. `Original` is a built-in, non-deletable style. Applying it removes explicit colour overrides (including fill, stroke, font and related colour properties) from native cell style strings while preserving other style keys, shape identity, labels, geometry, connections, group/layer structure, pages and unknown/custom XML content. It does not mean "rebuild the diagram" or rewrite its shape types.
5. A named style first removes the style properties owned by the Studio style engine, then applies the selected style's resolved generic and category-specific properties. A previous Studio-controlled value must not leak into the newly selected style. Shape/stencil identifiers, routing/anchor properties, labels, geometry and unknown properties outside the managed-property contract are retained.

### Extensible style library

1. Style definitions are stored separately from application CSS and diagram XML. The library has an explicit schema version. Each entry contains a stable ID, user-visible name, definition version, category matching/application rules and style properties.
2. The shipped Editorial, Vivid, Warm paper and Midnight definitions are editable initial presets, not a fixed enumeration. Users can import or export one style as versioned JSON, replace a conflicting style only after confirmation, and delete user styles. `Original` is reserved and cannot be imported over, renamed or deleted.
3. Import validates the entire file before mutating the local library. Style categories and property names are allowlisted; property values are bounded and reject delimiters or executable/URL-like input. No imported style can supply CSS, JavaScript, XML or a replacement document.
4. Classification uses native cell type and the native Draw.io `style`/shape identifier. It must not infer a semantic type from labels, IDs or descriptions. Unknown cells are styled with generic node/edge rules when they qualify as a native vertex/edge; all non-style XML content remains untouched.
5. The current style is also used when creating, pasting or copying new cells. Existing style transformations and new-cell creation run through the native Draw.io model. Draw.io's own undo manager remains the authority for diagram mutations.

### Undo, Redo and persistence

1. One style-application request is intended to be one native, undoable Draw.io operation, not one separate action per cell. The operation must serialize a valid full native XML document and then use the normal Workspace/standalone persistence and version acknowledgement path.
2. The style selected in the UI must follow the native XML revision. Studio maintains a small browser-local mapping from SHA-256 XML revision to style ID. The mapping is derived metadata only: XML remains authoritative, and the mapping never supplies or reconstructs diagram content.
3. Before changing styles, record the current XML revision's selected style ID. When Undo/Redo returns the document to a known XML revision, restore the mapped dropdown selection. An unmapped document revision defaults to `Original` until a style is explicitly applied.
4. Deleting a style removes only its definition. Already-styled diagrams remain unchanged; undo/history XML remains valid even when the configuration that originally produced it is no longer present.

### XML and presentation preservation

- Do not rebuild pages from a reduced graph, flatten groups, translate shape types, change labels, reroute connectors or run automatic layout as a side effect of styling.
- Native Draw.io XML is the only durable diagram model. Style metadata is not written into cell IDs, labels, custom XML attributes or background attributes.
- Style operations are explicit document edits; changing application UI theme, reloading the iframe, opening/importing a file or changing a style-library definition alone must not apply a diagram style.

## Consequences

- The dropdown's semantics are aligned with user expectation: choosing a style edits Draw.io; it does not recolour the Studio UI.
- The page background and grid remain visible because theme CSS no longer paints the graph SVG.
- Styles can evolve or be shared as individual JSON definitions without a source-code change to add another preset.
- Classification deliberately remains based on native shape identifiers. A custom stencil whose meaning is not encoded in its style identifier receives the generic node/edge style rather than guessed semantic colouring.
- The XML-revision-to-style map is best-effort browser-local metadata. Missing/cleared browser storage can lose the dropdown's remembered selection but cannot lose the native document or its applied visual styles.

## Validation criteria

- Theme CSS leaves the SVG/page/grid/background rendering under native Draw.io ownership.
- Applying any style changes only managed style keys on eligible native cells while preserving unrelated XML content across pages.
- Original only removes explicit colour overrides.
- Undo and Redo restore the correct XML style strings and corresponding dropdown value.
- New/pasted cells inherit the active document style.
- Single-style JSON import/export and deletion do not mutate an open diagram; malformed/unsafe import does not alter the library.
