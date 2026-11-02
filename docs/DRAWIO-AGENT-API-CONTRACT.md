# Draw.io Agent API Contract

**Current contract:** [ADR-0026 — Server-Side XML-First Copilot Editing](./adr/0026-server-side-xml-first-copilot-editing.md).

The native Draw.io `mxfile` / `mxGraphModel` XML is the only authoritative diagram representation. Copilot must not execute model-authored JavaScript inside the Draw.io iframe, return a replacement document as an unvalidated blob, or write workspace files directly.

## File-based editing contract

Copilot uses the ordinary file tools `read`, `write` and `write_code`. There is no diagram-specific XML mutation language.

- Read the active diagram using the virtual path `$active-diagram`. Large XML can be read in chunks with `offset` and `limit`.
- Edit the native `mxfile` / `mxGraphModel` XML directly. Write the complete resulting XML to `$active-diagram`; the agent may read and write repeatedly in the same turn.
- Use `read` and `write` for other workspace files, and `write_code` for source files. Paths are relative to the configured workspace; absolute paths, traversal and symlink escapes are rejected.
- Workspace diagram writes are bound to the source revision and go through the existing versioned document-save transaction. The server validates the complete XML, checks external changes to the primary file, persists the exact XML and returns a persistence receipt.
- Standalone mode exposes only `$active-diagram`. The server returns the complete validated XML and the browser writes it through the selected File System Access handle after checking the source revision.
- Preserve all unrelated pages, cells, wrappers, shapes, styles, unknown attributes, labels, geometry, groups and edge relationships. Do not convert the document to a reduced model or reconstruct it from an index.
- XML validation establishes document-format integrity, not visual correctness or semantic correctness. The native Draw.io editor remains responsible for rendering and user interaction.
- Do not execute model-generated JavaScript in the Draw.io iframe. Automatic layout remains a separate Studio-owned capability.

The former `edit_drawio_xml` tool and XML Patch DSL are retired. The `run_drawio_script` execution path remains retired as well.


## Shape discovery

Use `search_drawio_shapes` to find relevant native Draw.io shape and stencil definitions. When the active iframe provides `liveShapeClasses`, treat them as a snapshot of the current runtime registry, not as an exhaustive catalogue or proof that a shape is visible in the sidebar.

A catalogue miss does not prove that a shape is unavailable. Inspect the source XML and use native shape identifiers, attributes and styles supported by the document. For C4 elements, use the established C4 shape recipes and verify the exact native definition before writing XML.
