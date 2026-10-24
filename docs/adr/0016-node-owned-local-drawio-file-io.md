# ADR-0016: Browser-Owned Standalone Draw.io File I/O

- Status: Accepted
- Date: 2026-10-24
- Scope: V2 standalone Draw.io open, import, save, history restore and export
- Replaces: The previous decision that routed all standalone file I/O through Node.js fs
- Related: [ADR-0001 — Project Workspace as the Authoritative Project Context](./0001-project-workspace-as-authoritative-context.md), [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md)

## Context

The standalone file browser previously simulated a filesystem UI over a Node.js directory-listing API. It imposed its own navigation UX and required the browser to send a local absolute path to the server. A browser's standard File System Access API deliberately exposes a file handle and file contents, not the file's absolute path, so path-based server ownership adds a bridge the application does not otherwise need.

The project needs the same native Draw.io XML editing model in both modes, but that does not require the same original-file writer. Workspace mode has a configured project root and continues to use server-owned filesystem persistence. Standalone mode starts from a user-selected local file and can use the browser's file handle directly.

## Decision

### Standalone source-file ownership

1. The browser opens the operating-system file chooser with `showOpenFilePicker()`. It reads the selected file with `FileSystemFileHandle.getFile()` and passes the XML to the embedded native Draw.io editor. The browser does not attempt to obtain or infer a local absolute path.
2. The browser retains the selected `FileSystemFileHandle` for the active standalone document. It requests read/write permission as part of opening the file and writes changes with `createWritable()`, `write()` and `close()`.
3. The browser owns source-file open, read, autosave, import, history restore writes and export. Export uses `showSaveFilePicker()` and writes through the returned handle. The old Studio-simulated filesystem picker and path-based standalone source-file APIs are removed.
4. Before an autosave or history restore, the browser rereads the selected file and compares its SHA-256 content revision with the last revision observed by the Studio session. A mismatch blocks the write and asks the user to reopen the file.
5. This comparison is best-effort conflict detection, not an atomic compare-and-swap: another application can still change the file between the check and the browser's write. Do not describe this guarantee as equivalent to the previous server-side atomic revision check.

### Node.js snapshot and history ownership

1. Node.js no longer reads or writes the standalone source file and never receives its absolute path. The browser sends a random/stable document ID, display filename and validated native XML to the local service.
2. The browser stores the file handle and document ID in IndexedDB. When the user selects the same file again, `FileSystemFileHandle.isSameEntry()` is used to recover the associated document ID. The ID is opaque; the server hashes it before using it as a history directory key.
3. The local Node.js service validates XML and writes version snapshots only under `~/.architecture-diagram-studio/data/standalone-history/`. Each document has a compact history index and separate XML snapshots, with retention capped at 100 entries and 128 MiB. A server-issued expiring session token and history revision protect snapshot operations; this revision governs the snapshot stream, not the source file on disk.
4. History restore is split into two stages: Node.js validates and returns the selected snapshot while archiving the current XML; the browser then writes the returned XML through the selected file handle and synchronizes a snapshot of the restored result.
5. If the source-file write succeeds but the later Node.js history snapshot fails, the UI must say that the source file was saved and history synchronization failed. It must not report that the source-file save failed. A later snapshot attempt can synchronize the already-saved content. A source-file write failure, by contrast, must not advance the browser's last-saved revision.
6. A user-selected filename is display metadata only. Never interpret it or the document ID as a filesystem path, and do not reintroduce server-side path guessing to recover the original file.

### Workspace mode

Workspace mode is unchanged. The configured workspace's files, XML persistence, server-issued revision checks, path validation, version history and safe writes continue to use Node.js fs through the existing workspace services. Native Draw.io XML remains the only diagram model in both modes.

## Consequences

- Standalone open/save/export uses the browser's native file picker rather than a Studio-built filesystem browser, and Node.js has no authority to overwrite the user's source file in standalone mode.
- The File System Access API is not available in every browser. Standalone open/import/export requires a supported browser (currently targeted at modern Chromium-based desktop browsers) and a secure context such as localhost. Unsupported browsers must receive a clear message rather than silently falling back to path matching.
- Handle-to-document identity is stored in IndexedDB when available. If the browser cannot persist/compare a handle, the current open session can still edit the file, but its history ID may be session-specific.
- Conflict detection reduces accidental overwrites but cannot eliminate the check/write race exposed by browser APIs. Workloads requiring strict atomic conflict protection should use workspace mode.
- Existing server-side standalone snapshots that were keyed by canonical file path cannot be automatically matched to the new opaque document ID. They are not silently merged by filename, because two different directories may contain files with the same name.
- Full native XML—including unknown shapes, pages, styles and metadata—continues to be the durable source. A snapshot is a recovery copy, never a second diagram model.

## Validation

- Unit tests cover document-ID validation, XML validation, initial snapshots, revision-checked snapshot appends, snapshot integrity, and history-restore preparation without source-file writes.
- Playwright tests cover standalone open/import/autosave/export through a browser-handle adapter, Node.js history snapshots, workspace persistence and external modification checks in workspace mode.
