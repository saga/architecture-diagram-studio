# ADR 0005: Diagram-Aware MCP Intelligence and Reviewable Edits

- Status: Accepted
- Date: 2026-10-21
- Scope: V2 MCP tools, diagram analysis, reference retrieval, proposed edits

## Context

The official `jgraph/drawio-mcp` project separates diagram creation from its guidance, retrieves format references on demand, searches shape examples before emitting styles, and offers both an MCP tool interface and editor-oriented output. Those ideas reduce prompt size and help an agent produce more usable diagrams. V2 already owns a semantic `DiagramDocument`, deterministic layout/quality operations, native XML export, a workspace boundary, version snapshots, and a Copilot SDK service. A second diagram model or a second write path would undermine those guarantees.

## Decision

Extend the existing read-only workspace MCP server with a small set of diagram-aware, review-first capabilities. Keep the current workspace tools and their single `project-workspace.json` configuration.

1. **On-demand reference retrieval.** Add `get_diagram_reference` for the semantic model, native Draw.io XML conventions, and supported Mermaid authoring guidance. Return only the requested reference rather than putting a large format manual in every tool description or Agent prompt. Be explicit that V2 does not currently parse Mermaid into a diagram document.
2. **Diagram inspection.** Add `inspect_primary_diagram` to retrieve the active persisted semantic document through the existing HTTP service and return a compact, structured summary: kind, variant, layout, nodes, relations, boundaries, and sequence/flow metadata. The MCP process must not create a competing state store.
3. **Quality evaluation.** Add `evaluate_diagram_quality` that delegates to the existing server quality endpoint and returns its score, issues, and metrics. The quality implementation remains single-source.
4. **Reviewable natural-language edit proposal.** Add `propose_diagram_edit` that delegates to the existing intent endpoint and returns the proposed semantic document, summary, and quality evaluation. This tool must never persist the result, write a project file, or create a version. The calling Agent/user decides whether to apply the proposal through Studio's existing preview/confirmation flow. Unsupported requests must be reported as unsupported rather than presented as successful edits.
5. **Workspace-local examples, not a bundled 10,000-shape index.** Reuse the existing workspace listing/search tools to find project diagrams and documentation. Do not add an external icon service, remote shape index, or vendor-specific shape catalog in this change; project examples are more relevant and avoid an index refresh pipeline.
6. **Single authority and transport.** MCP calls the existing loopback HTTP API for semantic state, quality, and intent interpretation. It does not import a second copy of domain logic or write JSON/Draw.io files directly. The API base URL is configurable through `STUDIO_API_URL` and defaults to `http://127.0.0.1:4175`. Existing workspace-only MCP tools continue to work when the HTTP service is unavailable; diagram-aware tools return a clear service-unavailable error.
7. **Bounded and safe results.** Keep the MCP tool descriptions concise, return structured JSON as text, cap user-provided intent length and response sizes, and treat project content as untrusted data. No arbitrary filesystem writes, shell execution, or silent diagram mutation are introduced.

## Alternatives considered

- **Copy all official Draw.io MCP tools and shape index:** rejected because V2 uses a semantic model and custom editorial renderer, and a large vendor index would add maintenance and prompt/context cost without guaranteeing compatibility with Studio's styles.
- **Generate raw Draw.io XML directly from the LLM:** rejected because XML generation already has a deterministic exporter and direct XML edits can discard semantic metadata or bypass versioning.
- **Let MCP mutate persisted documents directly:** rejected because it would bypass the UI's review flow and risks bypassing the server's snapshot/autosave invariants.
- **Duplicate layout and quality logic in the MCP process:** rejected because algorithm behavior would drift from Studio's HTTP API and UI.

## Consequences

- MCP clients can inspect the active diagram, request focused format guidance, evaluate layout quality, and obtain a non-persistent edit proposal.
- Existing domain algorithms, configuration, and persistence remain authoritative in the HTTP service.
- This is not full parity with Draw.io's shape search or Mermaid conversion. Those require separate evidence of demand and a compatible parser/index before being considered.
- The MCP process and HTTP service must run under the same OS user and point at the same `STUDIO_DATA_DIR` for workspace consistency.
- Proposal tools depend on the local HTTP service being available; they never fall back to direct file writes.
