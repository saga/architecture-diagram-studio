# ADR-0017 — Workspace-Scoped Multi-File, Multi-Page Copilot Changes

- Status: Accepted
- Date: 2026-10-28
- Related: [ADR-0001 — Project Workspace as the Authoritative Project Context](./0001-project-workspace-as-authoritative-context.md), [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0016 — Node-Owned Local Draw.io File I/O](./0016-node-owned-local-drawio-file-io.md)

## Context

The editor currently has a single live Draw.io document. Its page-scoped operations bind to a page ID and document revision, while workspace APIs can enumerate and read files. These are not equivalent to a Copilot transaction that changes multiple diagram files and pages in one request. Reusing the live iframe for every target would make the active tab/page an implicit target and could apply a valid plan to the wrong document.

## Decision

A multi-target change is a workspace-scoped change set. Each target is identified by the canonical workspace-relative file path, stable Draw.io page ID, and expected content revision. The currently open file/page is UI context only; it must never be used as a fallback target.

The server owns target resolution, path containment, XML parsing/validation, revision checks, and the durable change-set record. The browser/Draw.io iframe remains the mutation adapter for the currently open document. It must not be treated as a headless editor for arbitrary files.

### Change-set contract

Each planned operation must resolve to a target with:

- `workspaceId`
- canonical workspace-relative `filePath`
- `pageId` (required for multi-page `mxfile`; null only for a bare `mxGraphModel`)
- `expectedRevision` (content hash of the exact XML snapshot)
- validated operations and a stable target identifier

Before proposing changes, the server reads every target from the workspace, rejects path escapes/symlink escapes and non-Draw.io/binary files, validates XML, resolves page IDs, and captures revisions. The model receives only bounded, relevant target context, never unrestricted file-system access.

### Apply protocol

1. Discover candidate files using workspace file metadata and explicit user intent; do not infer that every diagram in the workspace should be edited.
2. Build a plan grouped by file and page. The proposal UI shows every file, page, operation summary, and validation status.
3. On confirmation, re-read every target and compare its revision with the planned revision. If any target is stale, reject the entire change set before the first write.
4. Validate all resulting XML documents before persistence.
5. Persist the prepared outputs through a workspace-owned staging/commit service. Use atomic rename per file where supported, and keep before-images/version IDs for recovery. Do not claim cross-file filesystem atomicity: if a write fails after earlier files are committed, report partial application and provide a deterministic rollback/recovery operation.
6. Return per-target results, resulting revisions, version IDs, and rollback status. Never silently substitute the currently active file or first page.
7. Log the request/change-set ID, target paths, page IDs, revisions, validation, persistence, and recovery outcomes. Do not log secrets or full document contents by default.

### UI and live editor

The current Draw.io iframe remains the editor for one open document. A multi-file change set must not navigate the iframe between files to simulate a transaction. It should use server-side XML transformations for operations that can be safely applied to XML without invoking Draw.io runtime behavior, or use a serialized per-file open/apply/save adapter only if the adapter can verify file identity, page identity, revision, and save acknowledgement at each boundary. Until that adapter exists, multi-file execution must be explicitly gated and must not be represented as supported merely because the workspace can read multiple files.

### Concurrency and recovery

- Acquire per-file write locks in sorted canonical-path order to avoid deadlocks.
- Recheck all revisions after acquiring locks and before committing.
- Prepare and validate all outputs before writing any target.
- Record an immutable change-set journal with before/after revisions and version IDs.
- On partial commit, stop further writes, report exactly which targets committed, and expose recovery; never blindly retry the whole set.
- Duplicate target entries for the same file/page must be merged or rejected deterministically.

## Consequences

- The active editor state is no longer sufficient to represent a multi-target plan.
- Existing single-document operations remain unchanged and continue to bind to the live page and revision.
- Multi-file support is enabled only after the server-side change-set service, safe XML operation path, durable journal/recovery, and UI preview/confirmation are integrated and tested.
- Workspace discovery alone does not grant permission to modify arbitrary files. Only explicitly selected and validated Draw.io targets can be written.


## Implementation status (2026-10-28)

The initial implementation adds a validated target contract and a preparation endpoint at `POST /api/workspace/diagram-change-set/prepare`. The endpoint resolves every target through the workspace file service, validates Draw.io XML, verifies each page ID and SHA-256 content revision, and returns a target manifest without returning document XML. It is preparation-only: it does not apply operations or persist changed files. Multi-file mutation remains gated until the apply/journal/recovery service and proposal UI are implemented.
