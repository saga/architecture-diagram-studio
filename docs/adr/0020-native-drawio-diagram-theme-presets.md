# ADR-0020: Native Draw.io Diagram Theme Presets

- Status: Accepted
- Date: 2026-10-25
- Supersedes: [ADR-0007 — Unified Theme Adapter for Native Draw.io](./0007-unified-theme-adapter-for-native-drawio.md)
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md)

## Context

The former theme selector changed the Studio application's CSS theme and injected CSS into the Draw.io iframe. It did not apply a color preset to diagram elements. Worse, the injected rule targeting the diagram SVG painted an opaque background over Draw.io's own page-background/grid layer. The original XML remained intact, but the editor view no longer showed the document's actual background or grid.

The source document may have no explicit element colors (Draw.io defaults), or existing colors may have been authored by another application. Applying a selected diagram theme must therefore be an explicit operation on native Draw.io XML, not a CSS-only presentation effect and not a delta based on assumptions about the original style.

## Decision

1. The theme selector is a **Draw.io diagram color-preset selector**. Selecting a preset changes the diagram, not the Studio application theme. Studio's own interface appearance remains independent and does not switch when a diagram preset is applied.
2. Apply the preset directly to native mxCell style strings in the authoritative mxfile/mxGraphModel XML. For vertices, set the preset's fillColor, strokeColor, and fontColor; for edges, set strokeColor and fontColor. Text-only vertices receive a font color without being turned into filled boxes.
3. Apply the preset to all diagram pages, including compressed Draw.io pages. Use the shared XML parser and the existing fflate dependency for compressed pages; do not build a shadow graph or regenerate an XML document from a reduced model.
4. Replace only the relevant color properties in each cell's native style string. Keep non-color style entries, IDs, labels, geometry, edge endpoints and waypoints, layers, page settings, unknown attributes/elements, and unrelated XML metadata intact.
5. A preset is an explicit recoloring operation and intentionally replaces existing cell colors, including colors authored outside Studio. It does not edit the mxGraphModel page background or grid settings. Draw.io's own renderer remains responsible for page backgrounds and grids.
6. Remove the Studio-to-Draw.io CSS injection used to theme the editor/canvas. Do not apply an opaque background to the graph SVG or other element that can cover the native page-background/grid layer.
7. Treat applying a preset as a document edit: validate the resulting XML, save through the active workspace or standalone-file persistence path, and retain the usual version/history behavior. Do not report success when persistence fails.

## Consequences

- Choosing a preset changes native element and connector colors and can be saved/exported as ordinary Draw.io XML.
- Diagram page background and grid configuration are not changed by a preset.
- App UI appearance is no longer coupled to the diagram color-preset selector.
- Compressed pages are decoded, styled and re-encoded; unsupported or malformed page payloads are left unchanged rather than rebuilt.
- Tests must cover unstyled cells, previously colored cells, text-only cells, edges, compressed pages, preservation of non-color style properties, and preservation of the native canvas background/grid.
