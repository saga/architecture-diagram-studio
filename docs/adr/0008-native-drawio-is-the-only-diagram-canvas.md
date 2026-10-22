# ADR-0008: Native Draw.io Is the Only Diagram Canvas

- Status: Accepted
- Date: 2026-10-22
- Related: [ADR-0006 — Draw.io XML as the Single Source of Truth](./0006-drawio-xml-single-source-of-truth.md), [ADR-0007 — Unified Theme Adapter for Native Draw.io](./0007-unified-theme-adapter-for-native-drawio.md)

## Context

The application exposed two diagram canvases: a custom SVG/semantic canvas (Studio) and the embedded native Draw.io editor (Freeform). Both represented the same diagram through different renderers and editing interactions. This duplicated the user-facing editing experience, introduced visual and behavior parity work, and made it unclear which canvas was authoritative. ADR-0006 already establishes native Draw.io XML as the only source of truth, so a second production canvas is not justified.

## Decision

**The embedded native Draw.io editor is the only diagram canvas. The Studio/Freeform canvas mode and the custom SVG canvas are removed.**

1. The Diagram page renders the embedded native Draw.io editor directly. There is no canvas-mode state, toggle, fallback view, or second production renderer.
2. Native Draw.io XML remains the authoritative document for import, editing, autosave, versioning, recovery, export, and workspace writes.
3. Semantic properties, supported layout algorithms, quality checks, and Copilot remain as supporting capabilities around the native editor. They operate on a derived partial projection only when the relevant XML edit can be patched safely. They must not replace or regenerate the authoritative XML.
4. Copilot proposals are previewed through the native Draw.io editor when the proposed semantic change can be safely patched into the current XML. If it cannot be represented safely, the application must keep the current document unchanged and explain why; it must not silently switch to another canvas.
5. The custom SVG canvas and its dual-renderer parity tests are not production capabilities. Keep tests for native XML serialization, style contracts, safe XML patching, and layout behavior without asserting parity with a removed renderer.
6. The server has no separate Studio canvas mode. Server-side configuration, logs, Copilot orchestration, semantic/layout services, and the standalone diagram intent endpoint are backend capabilities, not canvas modes. Keep these where used; remove only UI-mode-specific state, branches, tools, or persistence.
7. The native selection inspector communicates with the pinned Draw.io bundle through a first-party local plugin loaded via `Draw.loadPlugin`. The host must not depend on a private `window.editorUi` global or assume the standard embed protocol emits selection events. Property edits are sent through a validated same-origin message bridge and are applied by Draw.io's own graph model so normal undo/autosave behavior is preserved. The plugin is part of the local bundle installation and must be refreshed on cached builds.
8. The product/repository name and existing configuration directory or log prefixes may continue to use Studio as branding/legacy storage naming. They must not imply that a second canvas or mode exists.

## Consequences

- Draw.io is the only visible diagram renderer/editor and owns native editing behavior.
- There is no renderer-switching UI or canvas-mode state to maintain.
- Existing native XML preservation and lossless-patching guards remain mandatory.
- Rendering tests focus on the native XML output and the shared style/geometry contracts consumed by that output. End-to-end tests must cover native selection, editable properties, and autosave to the authoritative file.
