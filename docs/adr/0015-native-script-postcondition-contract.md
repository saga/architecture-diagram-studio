# ADR-0015: Declarative Postconditions for Native Draw.io Scripts

- **Status:** Accepted
- **Date:** 2026-10-23
- **Decision owners:** Architecture Diagram Studio V2

## Context

The typed native-edit operations verify operation-specific outcomes in serialized XML. The fallback `run_drawio_script` operation previously had a weaker completion rule: a change to the active page's XML could be treated as success even when the requested effect had not occurred. A successful JavaScript call, a non-empty result, or an XML diff does not establish that the intended diagram change is present.

This affects every script-backed capability, not one particular shape library: connector routing, edge reconnection, grouping, shape/style changes and other structural edits can all produce an unrelated or partial XML change.

## Decision

Every `run_drawio_script` request must include between one and twelve declarative postconditions, validated by the shared native-edit parser and the tool schema. The supported assertions are:

- `cell_added`: exactly one new cell with the declared label and optional vertex/edge type exists.
- `cell_absent`: a previously resolvable cell no longer exists.
- `label_equals`: a target cell has the expected label.
- `style_equals`: a target cell has the expected native style key/value.
- `geometry_matches`: one or more specified coordinates or dimensions match.
- `edge_connects`: a native edge connects the resolved source and target cells.
- `parent_is`: a target cell belongs to the expected parent.

Targets use exact IDs or unique visible labels; IDs are preferred for renamed or duplicate-label cells. The model must assert the concrete requested outcome, not merely an unrelated condition that happened to remain true.

The same JSON payload, containing the script and conditions, is passed to the native iframe bridge. The bridge captures the active page's original cell state, executes the synchronous script, then verifies every condition against the live Draw.io model before it emits a successful editor acknowledgement. If any condition is absent, ambiguous or false, the operation throws into the existing atomic batch rollback path.

Afterward, the host independently checks those conditions against the final serialized XML. The operation is acknowledged only when the scoped XML changed and every condition can be verified from that serialized result. Editor acknowledgement alone, a non-empty `scriptResult`, and XML change alone are not sufficient. Typed operations retain their operation-specific postcondition checks.

## Failure behavior

- Missing or malformed postconditions: reject before script execution.
- A live-model condition fails: fail the script operation and roll back through the existing native batch recovery path.
- A serialized XML condition fails or is ambiguous: do not acknowledge success; report the verification failure through the existing save-confirmation timeout/failure path.
- Rollback cannot reverse arbitrary external side effects. Scripts remain synchronous, revision-bound, constrained to the local Draw.io editing flow, and subject to the existing review/AST/capability checks.

Declarative cell facts do not prove subjective visual quality, rendered curve quality or aesthetic layout. Scripts performing visual changes must also inspect the relevant rendered state and avoid making claims beyond what was verified. If an outcome needs a new assertion kind, add it to the shared type, parser, schema, iframe verifier and serialized-XML verifier together, with tests.

## Consequences

This adds a small, common contract instead of a one-off validator for each shape or diagram technique. Scripts that cannot state their intended final state are rejected and should be replaced by typed operations or a narrower, verifiable script. Tests cover missing conditions, serialized node/style/geometry/edge assertions and rollback after an unmet live-model condition.
