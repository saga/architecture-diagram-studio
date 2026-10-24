# ADR-0015: Tool-Guided Copilot Instructions and Draw.io Shape Discovery

- Status: Accepted
- Date: 2026-10-24
- Related: [ADR-0011 — Native Draw.io Is the Only Diagram Model](./0011-native-drawio-only-model.md), [ADR-0012 — Native Diagram Extension Contracts](./0012-native-diagram-extension-contracts.md), [ADR-0019 — Additive Native C4 Elements](./0019-additive-native-c4-elements.md). ADR-0014 records the superseded approach.

## Context

The always-on Copilot instructions had grown to about 11.5K characters. They repeated operation-schema details, Graph/Model/View ownership, rare curved-edge recipes, script repair rules, C4 details and postcondition checks in one prompt. This consumes context and makes it harder for the model to prioritize the rules relevant to the current request.

The C4 failure also exposed a category error: mxStencilRegistry.getStencil() is not a universal shape-availability API. Draw.io resolves shapes through different mechanisms, including JavaScript shape classes, stencil definitions, basic shapes and palette-backed styles. A negative result from one registry must not be treated as proof that all forms of a shape are unavailable.

The official jgraph/drawio-mcp project offers two useful patterns: keep tool descriptions short and load detailed reference material only when needed; search an index that returns the exact style, dimensions and title. Studio has a pinned, locally bundled Draw.io runtime and must preserve offline operation, so it must not add a runtime dependency on an external MCP server or remote shape service.

## Decision

### 1. Keep the permanent prompt short

The always-on instructions contain only high-frequency invariants: native Draw.io XML is the sole model, typed operations are shortcuts, targets must be unambiguous, and success requires verified editor/XML/persistence outcomes. C4 composition uses the generic native editor path rather than an application-owned conversion preset.

Detailed API recipes remain in the local Draw.io Agent API Contract and are served through the read-only get_drawio_reference tool on demand. Tool descriptions stay short. Typed operation schemas carry the fields and constraints for each operation; the system prompt must not duplicate every schema rule.

### 2. Separate shape lookup from live JavaScript-class inspection

The runtime contract is explicitly named capabilityManifest.jsShapeClasses. It reports whether requested identifiers are own properties of mxCellRenderer.defaultShapes in the pinned editor. It is evidence only about JavaScript shape classes, not a complete shape inventory or a stencil-availability check.

search_drawio_shapes queries a curated local catalogue and returns exact vetted style strings, dimensions, category and title. The initial catalogue covers common primitives and selected flowchart/UML symbols; it is intentionally non-exhaustive. A search miss does not mean that Draw.io lacks that shape. The Agent must not guess styles or shape IDs to fill a catalogue gap.

Use the catalogue for extended-library symbols when it returns a matching verified entry. Ordinary common shapes do not need an explicit search. For C4 additions, use the bundled Draw.io C4 library or a verified native C4 example through `run_drawio_script`; preserve original cells and labels instead of applying an in-place conversion preset.

### 3. Search live diagram elements separately from shape definitions

The model-facing diagram context remains compact and may omit cells beyond its prompt cap. That cap must not become a capability boundary: the server already holds the authoritative native-cell index parsed from the current Draw.io XML. The read-only `search_drawio_elements` tool queries that full active-page index by exact ID, exact label or distinctive label text, and returns a bounded result set with ambiguity metadata. The Agent uses it when the requested target is not visible in the prompt or the diagram is large; ambiguous results require narrowing by ID rather than guessing.

Element search is distinct from `search_drawio_shapes`: the former discovers existing cells in the current document, while the latter discovers candidate shape definitions. Search does not mutate XML or bypass server-side target resolution, document revision validation, confirmation rules, or versioned persistence.

### 4. Enforce policy where code can enforce it

Do not treat `mxStencilRegistry.getStencil()` as a universal shape lookup or substitute a different notation after a lookup miss. The native script path may create C4 elements using Draw.io’s own available definitions; verification should focus on the created cells, meaningful label/context, connectors and preservation of the originals. These are behavioral instructions, not a second shape engine or application-owned C4 preset table.

### 5. Preserve offline operation and native XML ownership

Shape discovery and reference lookup are local and read-only. There is no external MCP runtime dependency, no parallel graph model and no replacement-XML path. The catalogue is a conservative starter index, not a closed-world registry. Generating a complete index from the pinned Draw.io bundle is future work that needs its own versioned extraction and regression tests; until then, out-of-catalogue shapes must not be guessed.

## Consequences

- The always-on instruction string stays below 2,500 characters, with a regression test.
- Detailed Graph/Model/View ownership and rare script recipes are retrieved only when a task requires them.
- Shape search returns exact styles and dimensions for vetted local entries, while JS class registration has a separate name and narrower semantics.
- A catalogue miss remains an explicit information gap instead of causing invented styles, confusion between stencil and JS registries, or silent substitution.
- Common typed edits retain the short path; additional tool calls occur only when relevant.

## Validation policy

- Test prompt size and core safety principles.
- Test local catalogue search, exact styles/dimensions, result caps and non-exhaustive misses.
- Test on-demand reference section routing and response bounds.
- Test that C4 additions preserve original cells and do not leak internal IDs into display labels.
- Preserve native runtime inspection, serialized XML validation and persistence acknowledgement without reintroducing an in-place C4 conversion shortcut.
