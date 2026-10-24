# ADR-0016: Node.js-Owned Local Draw.io File I/O

- Status: Accepted
- Date: 2026-10-24
- Scope: V2 standalone Draw.io open, import, save, history and export
- Related: [ADR-0001 — Project Workspace as the Authoritative Project Context](./0001-project-workspace-as-authoritative-context.md), [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md)

## Context

Workspace mode already reads and writes the active diagram through Node.js filesystem operations. Standalone mode used a different implementation: the browser opened a local file with File System Access API, attempted autosave through FileSystemFileHandle.createWritable(), stored history in localStorage and exported by triggering a browser download. Browser file-writing permissions could interrupt autosave, and the same diagram had different persistence behavior depending on how it was opened.

Import also read a browser File object rather than using the local service. The application therefore had two different authorities for local diagram I/O and could not apply one consistent save-conflict or history policy.

## Decision

All local Draw.io file operations are owned by the Node.js service and Node.js fs:

1. The UI browses allowed directories through a Studio file dialog backed by v2/server/local-diagram-files.ts. It no longer asks the browser for a writable file handle.
2. Open and import read the selected file through the server. A successful open returns an expiring random capability token, canonical path and SHA-256 revision; the browser never supplies an arbitrary destination on later saves.
3. Standalone autosave writes through the service. Before saving, the service verifies that the caller's revision is current and that the on-disk XML has not changed externally. It atomically replaces the file, preserving the existing mode where possible. Conflicts return HTTP 409 rather than silently overwriting external work.
4. Standalone history is stored as server-side snapshots under ~/.architecture-diagram-studio/data/standalone-history/, keyed by the canonical file path. History reads are on-demand so the UI does not load every full XML snapshot into memory.
5. Export writes a new file with Node.js fs and refuses to overwrite an existing file. Export no longer depends on browser blob downloads.
6. Browsing is limited to the user's home directory and the configured workspace. Symbolic links are skipped or rejected; paths outside the allowed roots are denied. The /api/local routes use the same same-host origin guard as the workspace and Copilot APIs.

Workspace mode retains its existing server-side save/version pipeline. Both modes preserve the native Draw.io XML as the only diagram source of truth; the choice of runtime mode affects the destination and persistence scope, not the file-I/O implementation.

## Consequences

- The browser no longer needs ongoing write permission to the opened file; saves are ordinary local service requests.
- Open/import/save/history/export share one implementation and consistent validation/conflict semantics.
- A standalone session's history survives browser cache clearing and is not mixed with another file that happens to have the same filename.
- External changes are detected and never automatically overwritten. The user must reopen the file to continue from its latest revision.
- The file dialog does not browse arbitrary filesystem roots: the initial supported roots are the home directory and configured workspace. Expanding this requires an explicit security review rather than dropping path validation.

## Validation

- Unit tests cover directory listing, Node.js read/write, external-edit conflicts, standalone history, export collision handling, path traversal, symlink rejection and invalid XML.
- Playwright tests cover workspace import/export through the Node.js file service and the standalone open → import → autosave path.
