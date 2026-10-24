# ADR-0019: Additive Native C4 Elements

- Status: Accepted
- Date: 2026-10-24
- Scope: V2 Copilot operations against native Draw.io XML
- Supersedes: The in-place C4 conversion implementation in [ADR-0014](./0014-typed-native-drawio-c4-conversion.md)

## Context

The typed `set_c4_type` operation changed an existing cell's style, value wrapper and geometry. It introduced an application-owned preset table, a fixed size per C4 kind, a mandatory placeholder label template, and a non-empty-name postcondition. When the original cell was blank, the bridge replaced its blank label with the cell's internal ID so the postcondition would pass. The resulting diagram displayed implementation IDs as user-visible titles.

That behavior was not required by Draw.io or requested by the user. It conflated three independent concepts: native cell identity, visible cell content, and C4 notation metadata. The typed operation also made C4 conversion a privileged special case even though V2 already provides a general native Draw.io script path.

## Decision

1. **Do not perform an in-place C4 conversion by default.** When the user asks to express an existing ordinary element as C4, create an additional native C4 element using the bundled Draw.io C4 library or a verified native C4 example. Preserve the original cell and its existing relationships.
2. **Carry forward context, not implementation artifacts.** Reuse a meaningful visible label and relevant description/context where present. An empty visible label remains empty unless the user supplies one. A cell ID is only an identifier and must never become display text as a fallback.
3. **Create only the requested connection.** Connect the new C4 element as the user requests. Do not invent a relationship label or meaning. If the relationship or direction is materially ambiguous, inspect the diagram context or ask for clarification rather than guessing.
4. **Use the generic native editor path.** C4 creation and richer graph changes use `run_drawio_script` with the live Draw.io APIs and the normal XML serialization and persistence acknowledgement. Do not add another dedicated typed conversion operation, application-owned C4 preset table, forced dimensions, or placeholder rewrite just to handle C4.
5. **Do not substitute notation.** Use a definition available in the bundled native Draw.io library or a verified native example. A failed lookup is not proof that a shape does not exist; do not silently replace C4 with UML, a swimlane, or another approximate shape.
6. **Verify preservation as well as creation.** After execution, verify that the new node and requested connection were serialized, the original cell and its labels/geometry/relationships remain present, and unrelated document content was preserved. The normal native XML revision and workspace-persistence acknowledgement remains mandatory.

## Consequences

- The `set_c4_type` schema operation and its special bridge, fixed geometry/style presets, and C4-only XML postconditions are removed.
- Typed operations remain concise shortcuts for common edits; unusual notation work uses the full-capability native Draw.io script path.
- Blank labels are valid native document state. Target resolution carries the native ID separately from the visible label.
- Tests cover blank-label handling and ensure the retired conversion path cannot mutate an existing cell.
- The original typed-conversion ADR remains in the repository as a historical record and is superseded by this decision.
