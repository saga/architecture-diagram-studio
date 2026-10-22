# ADR-0007: Unified Theme Adapter for Native Draw.io

- Status: Accepted
- Date: 2026-10-22
- Related: [ADR-0006 — Draw.io XML as the Single Source of Truth](./0006-drawio-xml-single-source-of-truth.md)

## Context

The application theme is defined by the existing CSS custom properties on `.app-shell`. Those tokens update application controls, but the bundled native Draw.io editor runs inside an iframe and has its own UI and graph renderer. Consequently, changing the application theme did not reliably update the native editor controls or its canvas background.

Maintaining a second user-facing theme palette would cause drift. Rewriting every cell style on theme changes would also destroy intentional diagram colours and business-semantic styling.

## Decision

**The existing application CSS theme tokens are the single palette source; the only diagram canvas, native Draw.io, consumes them through an adapter.**

1. Read the resolved `--theme-*` tokens from the active `.app-shell` after the selected theme is applied. Do not duplicate per-theme colour tables in TypeScript.
2. Inject a narrowly scoped stylesheet into the same-origin Native Draw.io iframe to theme editor chrome and controls.
3. Set the Draw.io graph view background through the editor graph API. This covers compressed Draw.io pages as well as uncompressed XML.
4. For uncompressed XML pages, update only the `mxGraphModel` `background` attribute in the authoritative XML. Preserve all other XML bytes and metadata. Do not recolour vertex or edge styles.
5. Never rewrite individual cell `fillColor`, `strokeColor`, or `fontColor` values merely because the UI theme changed. User-authored and business-semantic colours remain intact.
6. Keep the existing theme selector and local preference behavior. There is no second Native-only theme configuration.

## Consequences

- The four existing themes provide a consistent palette for application controls and the native Draw.io editor.
- Native editor chrome and graph background are themed separately because they use different rendering mechanisms.
- Uncompressed page backgrounds can be reflected in the XML model while preserving unrelated XML. Compressed page backgrounds are applied through the Draw.io graph API and must be verified through the editor's normal save/autosave path.
- CSS selector compatibility and the Draw.io graph API must be checked against the bundled Draw.io version during runtime validation.
- Theme adaptation is presentation-only except for the intentional `mxGraphModel background` attribute update; cell-level business styling is not changed.
