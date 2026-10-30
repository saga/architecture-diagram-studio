# ADR-0019: Additive Native C4 Elements

- Status: Accepted
- Date: 2026-10-24
- Scope: V2 Copilot operations against native Draw.io XML
- Supersedes: The in-place C4 conversion implementation in [ADR-0014](./0014-typed-native-drawio-c4-conversion.md)

## Context

The former `set_c4_type` operation changed an existing cell's style, value wrapper and geometry. It introduced an application-owned preset table, a fixed size per C4 kind, a mandatory placeholder label template, and a non-empty-name postcondition. When the original cell was blank, the bridge replaced its blank label with the cell's internal ID so the postcondition would pass. The resulting diagram displayed implementation IDs as user-visible titles.

That behavior was not required by Draw.io or requested by the user. It conflated three independent concepts: native cell identity, visible cell content, and C4 notation metadata. C4 authoring now uses the same server-side XML-first editing path as every other Copilot diagram mutation, without a special typed conversion or script path.

## Decision

1. **Do not perform an in-place C4 conversion by default.** When the user asks to express an existing ordinary element as C4, create an additional native C4 element using the bundled Draw.io C4 library or a verified native C4 example. Preserve the original cell and its existing relationships.
2. **Carry forward context, not implementation artifacts.** Reuse a meaningful visible label and relevant description/context where present. An empty visible label remains empty unless the user supplies one. A cell ID is only an identifier and must never become display text as a fallback.
3. **Create only the requested connection.** Connect the new C4 element as the user requests. Do not invent a relationship label or meaning. If the relationship or direction is materially ambiguous, inspect the diagram context or ask for clarification rather than guessing.
4. **Use the shared XML-first path.** C4 creation and richer graph changes use the server-side `edit_drawio_xml` tool defined by ADR-0026. Do not add a dedicated typed conversion operation, application-owned C4 preset table, forced dimensions, or placeholder rewrite just to handle C4.
5. **Do not substitute notation.** Use a definition available in the bundled native Draw.io library or a verified native example. A failed lookup is not proof that a shape does not exist; do not silently replace C4 with UML, a swimlane, or another approximate shape.
6. **Verify preservation as well as creation.** The XML patcher validates the requested cell changes against the source revision, verifies the resulting document and persists workspace changes as a new version. The new node and requested connection must be present, while the original cell, labels, geometry, relationships and unrelated document content remain intact.

## Consequences

- The `set_c4_type` schema operation and its special bridge, fixed geometry/style presets, and C4-only XML postconditions are removed.
- Copilot diagram mutations share one server-side XML patch path; C4 is not a special execution mode.
- Blank labels are valid native document state. Target resolution carries the native ID separately from the visible label.
- Tests cover blank-label handling and ensure the retired conversion path cannot mutate an existing cell.
- The original typed-conversion ADR remains in the repository as a historical record and is superseded by this decision.
