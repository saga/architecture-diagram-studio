# ADR-0023: Native Script Runtime Boundaries and Late Outcomes

- **Status:** Retired by [ADR-0026](./0026-server-side-xml-first-copilot-editing.md); retained as historical runtime analysis
- **Date:** 2026-10-27
- **Scope:** V2 native Draw.io script execution, transaction integrity, edit watchdogs, XML validation, and user-visible outcomes
- **Related:** [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md), [ADR-0018 — AI-First Native Draw.io Execution](./0018-ai-first-native-drawio-execution.md), [ADR-0020 — Native Script Assertion Contracts and Accurate Edit Outcomes](./0020-native-script-assertion-contract-and-outcome-reporting.md)

## Scope after ADR-0026

This ADR records runtime issues from the former script-execution path. That path is removed by ADR-0026; do not preserve its script-specific source scanning, transaction balancing or iframe watchdog solely for the removed tool. The general requirements remain: timeouts are not proof of failure, late results must be reconciled, and user-visible outcomes must follow the actual persisted revision. Automatic layout remains unchanged.

## Context

V2 intentionally gives the agent direct access to native Draw.io APIs. Earlier reviews found that checking whether a script *returns* a Promise does not prevent fire-and-forget callbacks from mutating the diagram after the batch has been acknowledged. They also found that an agent script could leave a nested model update transaction open, and that the App watchdog could report a wait timeout while DrawioFrame was still serializing or persisting a valid result. A late edit could then be saved without correcting the user-visible failure message. Separately, style assertions that accepted any duplicate occurrence of a key could pass even when the effective final style value differed.

## Decisions

### 1. Enforce a best-effort synchronous script contract at the native bridge

Before executing a script, mask ordinary string/comment content and inspect executable source, including template interpolation expressions. Reject common async constructs and deferred APIs, including `async`/`await`, timers, Promise callbacks, network/event callback registration, dynamic evaluation, and parent/global execution-context access. Do not monkey-patch `window` scheduling APIs or `Promise.prototype` around the mutation: Draw.io itself uses timers in legitimate insert/render paths, so a global guard can break ordinary native edits. Use source inspection and transactional before/after checks instead. This catches common accidental deferred mutations while avoiding changes to the editor runtime.

This is a **correctness boundary, not a security sandbox**. Arbitrary JavaScript remains powerful; source scanning cannot prove every program is synchronous, and the current same-thread runtime still cannot interrupt an infinite loop. True containment and hard cancellation require an isolated editor runtime and a restricted command bridge. The UI and documentation must not imply otherwise.

### 2. Keep the bridge-owned model transaction intact

During script execution, wrap the active model's `beginUpdate`/`endUpdate` calls. A script may not close the bridge-owned outer transaction or replace the model transaction methods. Balanced nested calls are permitted; any unbalanced nested calls are unwound (bounded to avoid an unbounded cleanup loop) and the batch is failed so normal native rollback runs. Cleanup failures must remain visible in the reported error instead of being masked by the original script exception.

### 3. A watchdog timeout is not a final editor outcome

Treat the App watchdog as a waiting deadline, not proof that an edit failed or rolled back. Give the editor its XML-export confirmation window plus a scheduling buffer. When DrawioFrame sends a result, cancel the App watchdog immediately, before awaiting workspace/file persistence or the server receipt.

If the App watchdog fires first, remove the waiter but retain the request's acknowledgement context and mark the request as pending reconciliation. Do not submit a terminal failed acknowledgement to the server and do not automatically reload the editor from the last saved XML: either action can contradict or erase a still-running edit. Block new native edits while that request is unresolved.

When a late result arrives with serialized XML or explicit rollback/no-change evidence, persist and acknowledge it through the normal path, update the visible action and chat, and clear the pending state. If it returns without a final XML snapshot or explicit rollback evidence, keep it unresolved, tell the user not to retry, and require inspection/reload before another edit. This deliberately fails closed rather than risk duplicated insertions.

### 4. Compare effective style values, not any duplicate occurrence

Draw.io style parsing uses the last occurrence of a repeated key as the effective value. XML assertions must compare against that effective value. An earlier duplicate must not satisfy a style assertion if a later occurrence overrides it.

## Consequences

- Common fire-and-forget timer, Promise, network, event, and async/await patterns are rejected before they can be treated as a verified edit.
- The outer Draw.io update transaction remains owned by the bridge; scripts cannot silently leave its nesting level unbalanced or close it prematurely.
- App timeout, editor acknowledgement, XML serialization, persistence, and final user-visible outcome remain distinct states.
- Unresolved timed-out mutations temporarily block further Copilot native edits. Reloading the document resets that in-memory guard; the user must inspect the current persisted document/history before continuing.
- Script execution is still not safely interruptible and is not a hostile-code sandbox. The pinned Draw.io runtime remains the sole diagram model; no shadow model is introduced.

## Verification requirements

Regression coverage must include harmless timer/API words in strings/comments; async/await inside template interpolation; timer scheduling; Promise continuation patterns; balanced and unbalanced nested model transactions; an attempt to close the bridge-owned transaction; duplicate style keys where the final value overrides an earlier one; and late edit receipts both with a serialized XML snapshot and without one. The integration suite must validate that a timeout never emits a terminal failed receipt before the final editor outcome is known, that no new edit dispatches while reconciliation is pending, and that a late verified result corrects the visible status.

