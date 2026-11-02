# ADR-0026: Generic File I/O for Direct Native Draw.io XML Editing

- **Status:** Accepted; implementation in progress on `feat/copilot-generic-file-xml-editing`.
- **Date:** 2026-11-02
- **Scope:** Copilot file tools, direct native XML editing, revision checks, persistence and frontend synchronization.
- **Supersedes:** The XML Patch DSL and `edit_drawio_xml` contract previously introduced by this ADR. Continues to supersede the script-first Copilot execution decision in ADR-0018.
- **Related:** ADR-0001, ADR-0009, ADR-0011, ADR-0013, ADR-0016, ADR-0017, ADR-0020, ADR-0023.

## Context

Draw.io's saved artifact is already native XML. The previous XML-first implementation removed the iframe script round trip but replaced it with a Studio-defined XML Patch DSL: a fixed list of cell-level operations, one edit call per turn, and a server-side patch engine that interpreted UserObject wrappers, styles, geometry and cell relationships.

That is still an application-specific mutation language. It makes the model translate ordinary file edits into a narrow operation vocabulary and prevents it from using the same read/edit/write workflow it uses for source code, Markdown and other project files.

The desired interface is ordinary file I/O. The model should read the actual XML, edit that XML directly, and write the complete resulting file. No DiagramDocument, shadow graph, XML patch language, cell-operation whitelist or Draw.io JavaScript is needed.

## Decisions

### 1. Use general file tools, not a diagram-specific mutation API

The Copilot session exposes three general capabilities:

- `read(path)`: read a workspace-relative file. The virtual path `$active-diagram` reads the current native Draw.io document. Large files support offset/limit reads.
- `write(path, content)`: write complete file contents. Writing `$active-diagram` queues the complete native XML for the versioned document save. Other workspace files are written directly through the workspace file service.
- `write_code(path, content)`: create or replace a source-code file using complete source text.

The model may read, write, read again and write again within one turn. For the active diagram, the latest complete XML is the version that is committed after the model turn. The model does not submit a sequence of application-defined cell operations.

The active diagram is the only diagram exposed in standalone mode. Other workspace files are available through workspace-relative paths. Absolute paths, path traversal and symlink escapes are rejected by the existing workspace resolver. The tools do not expose arbitrary host filesystem paths.

### 2. The model edits native Draw.io XML directly

- The model reads the original `mxfile` / `mxGraphModel` content and modifies it as a normal text file.
- The complete resulting XML is written back. The model may use any native Draw.io XML element, attribute, shape, stencil, style, wrapper, geometry or relationship supported by the format.
- There is no XML Patch DSL, typed cell-operation allowlist, special style-token API, or single-write-call restriction.
- Do not create or persist a DiagramDocument, semantic graph, or reduced replacement representation.
- Preserve unrelated pages, cells, wrappers, custom shapes, unknown attributes, styles, geometry, groups, layers, labels and edge relationships.
- The agent may use read-only search and shape-discovery tools as supplementary context, but those tools do not define the set of editable XML features.

### 3. Keep document integrity and persistence in the server

General file tools do not bypass the diagram document lifecycle.

For a write to `$active-diagram`:

1. Bind the write to the source XML revision supplied with the request.
2. Validate the complete resulting document using the shared Draw.io XML validation entry point.
3. Reject stale source revisions and external modifications to the configured primary diagram.
4. Persist the exact resulting XML through the existing immutable version and workspace-state transaction.
5. Return the persistence receipt only after the save transaction succeeds.
6. Notify the frontend to load the authoritative persisted revision.

For writes to other workspace files, use the existing workspace-relative path resolver, reject path traversal and symlink escapes, and use atomic file writes. These writes do not mutate the active diagram state.

XML parsing validates document integrity; it does not prove that the diagram renders as intended or that the user's semantic intent was satisfied. Do not add application-specific shape taxonomies or mandatory semantic postconditions.

### 4. Workspace and standalone ownership remain unchanged

- Workspace mode: the server owns workspace file reads/writes, primary diagram revision checks, XML persistence and version history.
- Standalone mode: the browser continues to own the selected source file through its File System Access handle. The server returns the complete validated XML and source/result revisions; the browser writes the result through the selected handle and checks for external changes.
- Never send a standalone absolute path to the server or imply that a server-side history snapshot alone modified the source file.

### 5. Keep Draw.io JavaScript execution removed

The `run_drawio_script` tool and model-generated JavaScript execution path remain removed. Do not reintroduce script execution under another tool name. General file tools write file contents; they do not evaluate code in the Draw.io iframe.

The former `edit_drawio_xml` tool, `DrawioXmlPatch` type, patch engine, patch-specific confirmation/dispatch state and XML Patch DSL tests are removed. Do not replace them with another XML operation language.

### 6. Automatic layout remains unchanged

This ADR does not redesign automatic layout. ADR-0013 and the expanded layout ADRs remain authoritative. Keep the Studio-owned Dagre, ELK, Graphviz WASM, MSAGL.js, Cytoscape.js and D3 algorithms, adapters, configuration, temporary layout projection and geometry-application pipeline unchanged.

## Consequences

- The model works with Draw.io XML like any other project file.
- Complex Draw.io structures are no longer blocked by a Studio-specific operation list.
- Repeated read/write iterations are possible within one Agent turn.
- The server remains responsible for path boundaries, XML integrity, revision conflicts, atomic persistence, version history and frontend synchronization.
- Workspace text/code writes are ordinary file writes; active diagram writes retain the stronger versioned document-save lifecycle.
- Automatic layout is independent and unchanged.

## Acceptance criteria

1. Copilot exposes `read`, `write` and `write_code`; it does not expose `edit_drawio_xml` or a replacement patch tool.
2. The model can read the active XML, make a direct complete-document edit, read the result again, and write a revised complete document in the same turn.
3. Workspace diagram writes use source-revision checks, complete XML validation, external-file conflict detection and immutable version persistence.
4. Standalone diagram writes use the browser-owned file handle and verify source/result revisions.
5. Generic workspace file writes reject absolute paths, traversal and symlink escapes.
6. Regression tests cover plain/compressed XML, multiple pages, UserObject wrappers, custom shapes, unknown attributes, labels, groups, edge terminals, stale revisions and persistence failures.
7. No active tool, schema or handler exposes the retired XML Patch DSL or `edit_drawio_xml`; any remaining mentions are explicit prohibitions or historical explanations.
8. Automatic layout code and behavior are unchanged.
9. Typecheck, unit tests, production build and relevant Playwright E2E tests pass, and the changes are integrated into `main`.

## Non-goals

- Reintroducing a semantic graph model or parallel renderer.
- Moving standalone source-file I/O to Node.js.
- Exposing arbitrary host absolute paths.
- Executing model-generated JavaScript in the Draw.io iframe.
- Rewriting automatic layout algorithms or adapters.
