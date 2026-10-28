# ADR-0020: Native Script Assertion Contracts and Accurate Edit Outcomes

- **Status:** Accepted
- **Date:** 2026-10-27
- **Scope:** V2 Copilot native Draw.io script execution, XML verification, and user-facing outcomes
- **Related:** [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md), [ADR-0015 — Tool-Guided Copilot Instructions and Draw.io Shape Discovery](./0015-tool-guided-copilot-shape-discovery.md), [ADR-0018 — AI-First Native Draw.io Execution](./0018-ai-first-native-drawio-execution.md)

## Context

The 2026-10-27 sequence-diagram edit requested a single `a → b` call labelled `启动`. The first script used `mxCell.getSource()`, which does not exist in the bundled JavaScript mxGraph runtime, and included an invalid whole-diagram cell-count assumption. The native bridge reported the script exception and confirmed rollback.

The automatic correction then changed the native diagram, but supplied `xmlAssertions[].style` as the complete style string. The host contract requires a map of expected style keys to values. The assertion validator returned only `false`, so a malformed assertion was indistinguishable from a genuine mismatch between the expected and serialized diagram. The host preserved and serialized the changed document, while the chat result described the operation as failed with rollback status unknown. The root-level incident report `SEQUENCE-QIDONG-SCRIPT-FAILURE-2026-10-27.md` records the file-level evidence and reproductions.

This exposed contract gaps in API guidance, assertion shape and diagnostics. The 2026-10-27 Task 7 rename then showed a related execution failure: exact-label search suppressed partial matches; scripts stringified UserObject DOM values and silently skipped wrapped labels; and a false live-model postcondition prevented the host from validating otherwise-useful serialized XML assertions. The same accessor was used in a postcondition, creating a false positive.

## Decision

### 1. Define an explicit, strict assertion format

A modifying script returns a JSON-safe object with `ok: true`, non-empty `postconditions` containing only checked true booleans, and a non-empty `xmlAssertions` array.

Each assertion includes a non-empty `cellId` and concrete, typed facts. The `xmlAssertions` object is Studio's host-side verification schema, not a set of Draw.io attributes. The single substring assertion field is `labelContains`; it is checked directly against the serialized label and can verify a title embedded in a rich label. The previous names `chineseTitle` and `expectedTitle` were redundant and misleading because they implied language-specific or title-specific schema fields; `labelContainsTitle` was a redundant Boolean echo. None is part of the supported contract. An assertion with `exists: true` alone is not sufficient: it proves only that some cell with that ID exists, not that the requested outcome occurred. Every existing-cell assertion must include at least one concrete property. Supported fields are `exists`, `kind`, `label`, `labelContains`, `parentId`, `sourceId`, `targetId`, `style`, and `geometry`. Unknown extra fields are recorded as warnings and ignored, but never count as concrete evidence. An assertion containing only unknown fields remains invalid. This is important because a script may include helpful self-check metadata (such as `bodyTailPreserved`) that has no independent XML field the host can verify. Invalid field types, empty style maps, and empty geometry maps remain invalid assertions. `style` is a non-empty key/value map, for example `{ "endArrow": "block" }`; it is not a full `mxCell.style` string. Geometry expectations must explicitly identify at least one supported field.

Assertion-shape failures and actual XML mismatches are distinct outcomes, using the stable diagnostic kinds `invalid-result`, `invalid-assertion`, `invalid-document`, and `mismatch`. Diagnostics carry the assertion index, cell ID, field, reason, expected value, and actual value when available. Unknown extra fields are emitted through the validator's warning collection and do not mask valid, host-verifiable fields; if no supported evidence remains, validation still fails. The host always validates serialized XML assertions and runs the before/after scope audit, independently of live-model postconditions or assertion-shape validation. A failed postcondition is added as a separate diagnostic; it must not suppress cell-level mismatches or scope violations in the serialized document. The existing boolean helper remains as a compatibility wrapper; code needing a useful receipt uses the detailed validator.

Cell assertions cannot prove changes to Draw.io page structure or ordering. Until a dedicated page-assertion contract exists, page creation/removal/rename/reorder must fail closed as changed-but-unverified; the native bridge must not label those outcomes applied-and-verified.

### 2. Make the native API guidance executable and concrete

The local contract, on-demand reference, tool description, and always-on prompt must agree on common method signatures. Resolve display labels with `graph.convertValueToString(cell)`: `model.getValue(cell)` may be a DOM Element for a `<object>`/UserObject cell and must never be blindly converted with `String()`. To rename a wrapped value, clone the element, change only its `label` attribute and call `model.setValue(cell, clone)` so placeholders and metadata survive. Postconditions must independently re-read labels instead of reusing the mutation count. For an edge, use `edge.getTerminal(true/false)` or `model.getTerminal(edge, true/false)`; do not invent `getSource()` or `getTarget()`. `model.getChildCount(parent)` counts direct children only. Scripts that need a recursive count must traverse the tree and should not assert a guessed total number of cells for a local edit. Exact-label search results must rank first without suppressing substring matches.

### 3. Preserve the distinction between execution, verification, and persistence

A script may execute and serialize a document without satisfying its declared assertions. The states remain distinct:

- `applied-and-verified`: declared assertions match the serialized XML.
- `changed-unverified`: the serialized document changed, but its requested outcome was not verified.
- `not-applied`: the serialized document appears unchanged.
- `unknown`: the available snapshot cannot reliably establish whether it changed.

A `changed-unverified` result is **not evidence of rollback**. The product must preserve the resulting XML for inspection and must not tell the user that nothing was applied, that rollback is unknown without qualification, or that they should restore an earlier version automatically. It should identify the changed-but-unverified state and tell the user to inspect the current diagram and persistence/history evidence before any corrective action.

### 4. Do not blindly retry a mutation that may already have applied

Automatic script repair after a thrown runtime error is permitted only when rollback is explicitly confirmed and the pre-edit document/page/selection still match. If execution reached mutation and the serialized outcome is `changed-unverified`, do not rerun the original insertion automatically: the operation could be duplicated. Surface actionable assertion diagnostics instead. Any future recovery that continues after a changed document must first inspect the current XML and derive a new, revision-bound correction from the actual state.

## Consequences

- Assertion validation failures are diagnosable without guessing which field failed.
- Agent instructions explicitly state object shape and common API signatures, while rare recipes remain on demand.
- Empty assertion objects cannot act as vacuous evidence.
- A correct native edit is not represented as a confirmed rollback merely because verification failed.
- Native XML remains the sole saved diagram model; this ADR adds no shadow graph, new confirmation gate, or script allowlist.

## Verification requirements

Regression tests must cover: valid style/geometry assertions; full-style-string rejection; empty style/geometry rejection; mismatched source/target and expected/actual diagnostics; unknown-page and ambiguous-cell rejection; and preservation of the existing boolean validator contract. End-to-end coverage should prove that a changed-but-unverified mutation is surfaced as such and is not automatically replayed.
