# ADR-0007: Unified Theme Adapter for Native Draw.io

- Status: Superseded by [ADR-0019 — Native Draw.io Document Style Library](./0019-native-drawio-document-style-library.md)
- Date: 2026-10-22
- Superseded: 2026-10-25
- Related: [ADR-0006 — Draw.io XML as the Single Source of Truth](./0006-drawio-xml-single-source-of-truth.md), [ADR-0019 — Native Draw.io Document Style Library](./0019-native-drawio-document-style-library.md)

## Historical context

The original implementation tried to make the embedded editor visually match the application's UI theme. It read `.app-shell` CSS tokens and injected CSS into Draw.io. The selector was also wired to the application's UI theme dropdown, which blurred the distinction between a UI presentation preference and a document style operation.

One rule, `body, #geDiagramContainer, .geDiagramContainer, .geDiagramContainer svg { background-color: … !important }`, painted the graph SVG with an opaque colour. Draw.io renders nodes/connectors in that SVG above its own page surface, where the document background and grid are drawn. As a result, existing documents could appear to lose their page background and grid even though their XML remained intact. The former decision also described graph/page background updates via XML and reserved bookkeeping attributes, which is contrary to the current requirement that application presentation settings must not modify document XML.

## Current decision

This ADR is historical and must not be used to implement diagram styles.

- The application's UI theme and the Draw.io document style are separate concepts.
- The document style dropdown applies an explicit native Draw.io XML style transformation; it never switches the Studio UI theme.
- UI chrome CSS may style Draw.io menus/toolbars and the whitespace surrounding the canvas. It must not paint an opaque background onto the graph SVG or override a document's page background/grid.
- Opening/importing a diagram or changing the Studio UI theme must not rewrite the diagram XML.
- Original, named style definitions, native style transactions, Undo/Redo and JSON style-library import/export are governed by [ADR-0019](./0019-native-drawio-document-style-library.md).

## Migration note

The prior statements about a single shared palette, graph background mutation, reserved `studioTheme*Background` XML attributes and coupling four named styles to the application theme are superseded. Keep the CSS adapter only for narrowly scoped editor chrome; do not reintroduce those XML/background mechanisms.
