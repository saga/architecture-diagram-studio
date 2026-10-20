# ADR 0003: Native-first draw.io export

- Status: Accepted
- Date: 2026-10-20

## Context
Exporting the entire canvas as one SVG can preserve appearance but makes individual architecture elements difficult to edit in diagrams.net.

## Decision
Export nodes and relations as native mxGraph cells by default. Permit embedded SVG only for visual elements that cannot be represented adequately with native shapes. Never silently flatten the entire diagram.

## Consequences
- Native cells are independently editable.
- Some browser-rendered details cannot be pixel-identical and need an explicit style mapping.
- Export regression tests must validate geometry and rendered appearance.