# ADR-0014: Typed Native Draw.io C4 Conversion

- Status: Accepted
- Date: 2026-10-23
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md), [ADR-0013 — Studio-Owned Dagre/ELK Layout](./0013-studio-owned-layout-engines.md)

## Context

A C4 conversion request was reported as successful even though the resulting cells used a UML actor and swimlane. The script had used `mxStencilRegistry.getStencil("mxgraph.c4.person2")` as a shape-existence check, then approximated the requested C4 elements when that lookup returned an empty result. The edit pipeline treated any serialized XML change as success and surfaced the model-authored summary without verifying the requested C4 shape and style.

That diagnosis was verified against the pinned Draw.io v32.0.2 bundle. C4 Person is registered in `mxCellRenderer.defaultShapes`, not as an `mxStencilRegistry` stencil. C4 Software System and External Software System are not named C4 shapes; the stock palette represents them as rounded cards with canonical styles.

## Decision

### 1. C4 conversions use a typed operation

The native edit contract includes `set_c4_type` with only three accepted kinds: `person`, `system`, and `external`. It targets one existing vertex with geometry and uses the standard Studio native edit dispatch, revision checks, editor serialization, and persistence flow.

Copilot must use this operation for the three supported C4 types. It must not write a custom script to imitate one of them when the typed operation can express the request.

The built-in C4 palette must also be available to people working directly on the canvas. The embedded editor must show its shape-library panel and include `c4` in `defaultLibraries` by default; C4 must not require the user to open More Shapes and enable the library manually. Because Draw.io may persist the previously enabled library list, update the editor configuration version when changing this default so existing preferences are rebuilt once.

### 2. Use the pinned Draw.io C4 definitions

- **Person:** use `shape=mxgraph.c4.person2`, the native `mxCellRenderer.defaultShapes` registration, the stock C4 colors (`#083F75` fill, `#06315C` stroke, white font), and the C4 Person label/placeholder metadata.
- **Software System:** use the stock rounded-card style (`#1061B0` fill, `#0D5091` stroke, white font), not a `mxgraph.c4.system` shape.
- **External Software System:** use the same stock rounded-card pattern with `#8C8496` fill and `#736782` stroke, not a swimlane.
- Use the stock label metadata (`placeholders=1`, `c4Name`, `c4Type`, `c4Description`, and `%c4Name%/%c4Type%/%c4Description%` template) so C4 names and type/description information render as intended.

For this pinned bundle, Studio sets the stock palette dimensions: Person 200×180; Software System and External Software System 240×120. Existing label text is used as `c4Name`; a missing description stays blank rather than being invented.

### 3. Never silently substitute another diagram notation

Do not substitute `umlActor`, `swimlane`, or arbitrary model-generated styling as a C4 approximation. If the Person shape is not registered, the conversion fails without mutation. It is better to report an actionable failure than to return an element that looks like another notation.

### 4. Successful status requires semantic postconditions

The bridge checks the requested native style, label metadata, dimensions and Person shape registration before returning. The host then verifies the serialized XML: a changed XML snapshot is insufficient. `set_c4_type` is considered reflected only if the resulting vertex has the canonical C4 color/shape style, placeholder-backed label metadata and expected dimensions. A UML actor or swimlane substitution must fail this check.

Batch rollback snapshots include the C4 style, cell value and geometry. The normal XML persistence/version acknowledgement remains mandatory.

## Prohibited regression

Do not remove the typed C4 operation, canonical C4 palette definitions, shape-registry check, or semantic XML postcondition while keeping C4 conversion exposed as a supported feature. A future C4 type requires its own verified stock definition and regression tests; the model cannot invent a fallback.

## Acceptance checklist

- [ ] The native edit schema/parser accepts only the three declared C4 kinds.
- [ ] Target resolution rejects edges and unknown targets.
- [ ] The native bridge writes the real Person shape and canonical Software System / External Software System rounded-card styles.
- [ ] The Person conversion uses `mxCellRenderer.defaultShapes`, never `mxStencilRegistry.getStencil`.
- [ ] Runtime inspection exposes a bounded, regression-tested shape-registration query against `mxCellRenderer.defaultShapes` for C4 and future native shape capabilities.
- [ ] Missing Person shape registration fails closed and does not use UML/swimlane fallback.
- [ ] Serialized-result tests reject wrong styles/shapes even when XML otherwise changed.
- [ ] Typecheck, unit tests, production build and native-canvas tests pass.
