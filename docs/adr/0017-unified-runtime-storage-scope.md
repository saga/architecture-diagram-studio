# ADR-0017: Unified Runtime Storage Scope for Workspace and Single-File Modes

- Status: Accepted
- Date: 2026-10-24
- Scope: V2 persistence paths, application/agent logs, Copilot SDK state and browser trace buffers
- Related: [ADR-0001 — Project Workspace as the Authoritative Project Context](./0001-project-workspace-as-the-authoritative-context.md), [ADR-0004 — Versioned Server Configuration in JSONL](./0004-versioned-studio-configuration-jsonl.md), [ADR-0016 — Node.js-Owned Local Draw.io File I/O](./0016-node-owned-local-drawio-file-io.md)

## Context

V2 had several independent path defaults. Workspace registration, diagram state, version history, server logs, browser diagnostic logs and the Copilot SDK state did not all share the same isolation boundary. Most notably, diagram state and versions lived in one global data directory, the agent log used a different global directory and the SDK defaulted to ~/.copilot. Log readers then filtered a global file by workspace ID. Browser-side diagnostic entries used one localStorage key for all workspaces and standalone diagrams.

That design made it possible for traces and runtime files to be mixed between modes and made workspace switching depend on mutable process-wide state, rather than an explicit storage contract.

## Decision

### One storage-layout resolver

All runtime paths are derived from resolveStudioStorageLayout in v2/server/storage-layout.ts. Route handlers, log writers and the Copilot SDK use the selected layout instead of defining independent defaults.

- **Workspace mode:** runtime state, native-XML version history, application logs, Copilot/agent logs and Copilot SDK persisted state live in a workspace-specific partition below ~/.architecture-diagram-studio/workspaces/<workspace-key>/. The key is a hash of the workspace ID and its resolved root path. Runtime data is outside the project repository, so workspace file discovery cannot accidentally index it.
- **Single-file mode:** those same categories use the shared ~/.architecture-diagram-studio/ root, organized into data/, logs/ and copilot/. The original diagram remains at its original filesystem path; only Studio runtime data goes under the Studio home.
- **Global application state:** project-workspace.json and studio-config-history.jsonl remain global under the Studio data directory. They describe the Studio configuration, not a particular diagram runtime.
- **Browser diagnostics:** the localStorage trace buffer is partitioned by the same logical scope. Server diagnostic events carry the workspace scope identifier and are written/read under the matching server layout.

### Scope switching

The request path resolves the effective storage scope before a workspace operation or Copilot turn. When the scope key changes, the server clears workspace-state/version caches and retires the current Copilot SDK client/session cache before switching the SDK base directory. Standalone Copilot requests explicitly identify themselves as standalone. Trace polling and global settings reads resolve their own destination and do not switch the active runtime as a side effect.

An explicit operator/test directory override remains supported: STUDIO_HOME, STUDIO_GLOBAL_DATA_DIR, STUDIO_DATA_DIR, COPILOT_LOG_DIR and COPILOT_HOME. A path override intentionally takes precedence over the default physical layout for the affected category while the logical scope key still changes and invalidates runtime caches.

### Legacy data migration

Legacy data is treated as untrusted history, not as a reason to merge multiple scopes:

- Workspace state is copied only when its stored workspaceId matches the selected workspace. The old Copilot SDK session ID is cleared because it refers to the former shared SDK directory.
- Version snapshots and JSONL events are copied only when each record explicitly carries the matching workspaceId.
- Unattributed legacy log entries are not copied into workspace scope. Single-file migration only carries unowned app events or events explicitly marked single-file.
- Source files are left untouched as a recovery source. Migration never truncates or deletes the old global log.

## Consequences

- Both modes use one path-resolution and persistence contract; only the storage root differs.
- Workspace state, history, logs and SDK files are no longer written into the project itself and are not mixed with other workspaces by default.
- The global workspace registry and model/settings revision history remain available after mode changes.
- Log readers no longer need to load one global log and filter all workspaces from it.
- Explicit environment overrides are retained for test isolation and operator-managed layouts; those overrides can intentionally relax physical path separation.

## Validation

- Unit tests cover single-file defaults, workspace-root hashing, workspace separation, stable identity, safe path components and override behavior.
- CI typecheck and unit tests cover scope-aware server paths and runtime resets.
- Manual acceptance: switch between workspace A, workspace B and a standalone file; inspect the returned trace paths and confirm that each mode shows only its own versions/logs and never resumes another scope's SDK session.
