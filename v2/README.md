# Architecture Diagram Studio V2

## Run

Use Node.js 22.13 or later. From this directory, run npm install and npm run dev.

The pre-dev and pre-build scripts install and verify the pinned Draw.io web bundle (v32.0.2). Runtime assets are served locally; the app does not use the online embed.

## Diagram model

**Native Draw.io XML is the only diagram model.** The embedded Draw.io editor is the only canvas. V2 does not keep a DiagramDocument, import/export converter, semantic templates, custom layout engine, quality scorer, or proposal/preview graph pipeline.

A project workspace is optional. Use **Open Draw.io** to open a standalone .drawio, .dio, or supported XML file. Where the browser supports local file access, edits can save to that file; otherwise use **Export**. A configured workspace provides server-side autosave and XML version history. Creating a new diagram never overwrites an existing file.

## Copilot

The Copilot SDK service passes the active page's native cells and selected cell to the model. The model can call two tools:

- select_diagram_element for focusing an existing cell.
- propose_native_edits for a typed, allowlisted edit batch.

Supported operations are selection, label changes, fillColor/strokeColor/fontColor, move, resize, delete, and add_node_after (insert a vertex to the right of a target and connect it). Edits run through Draw.io's graph model; the browser waits for editor acknowledgement. The model cannot provide replacement XML or write project files. Unsupported or ambiguous operations leave the diagram unchanged.

In **Settings**, choose the SDK model and reasoning effort. The browser does not hold provider credentials. Sign in with the GitHub Copilot CLI or configure a supported provider on the local runtime.

## Persistence and revisions

The server validates native XML, checks the expected SHA-256 revision on workspace saves, writes the exact XML, and records full-XML snapshots. Standalone files use native autosave/export and local recovery snapshots. Old version entries without native XML are not regenerated from an incomplete model.

The schema validator accepts native mxfile and mxGraphModel roots, multiple pages and supported compressed page payloads, while leaving unknown attributes, styles, wrapper elements and custom cells open for forward compatibility. DTD and custom entity declarations are rejected.

## Agent traces and token usage

Agent Traces shows browser events, SDK lifecycle, model calls and available usage details. Input/output/cached/reasoning tokens, provider cost and context-window occupancy appear only when the SDK/provider reports them. Missing usage values are not estimated. Local trace and history files may include diagrams and prompts, so treat them as project data.

## Architecture

See [ARCHITECTURE-V2.md](../ARCHITECTURE-V2.md) and [ADR-0011](../docs/adr/0011-native-drawio-only-model.md). V1 remains in the sibling v1/ directory as a reference and is not imported by V2.
