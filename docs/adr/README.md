# Architecture Decision Records

| ADR | Decision | Status |
|---|---|---|
| [0001](./0001-project-workspace-as-authoritative-context.md) | Project Workspace as the Authoritative Project Context | Accepted |
| [0002](./0002-workspace-aware-mcp-and-agent-skill.md) | Workspace-Aware MCP and Agent Skill | Accepted |
| [0003](./0003-server-authoritative-diagram-operations.md) | Server-Authoritative Diagram Operations | Superseded by 0011 |
| [0004](./0004-versioned-studio-configuration-jsonl.md) | Versioned Server Configuration in JSONL | Accepted |
| [0005](./0005-diagram-aware-mcp-intelligence.md) | Internal Copilot Diagram Intelligence and Governed Agent Edits (no external MCP surface) | Superseded by 0011 |
| [0006](./0006-drawio-xml-single-source-of-truth.md) | Draw.io XML as the Single Source of Truth | Superseded by 0011 |
| [0007](./0007-unified-theme-adapter-for-native-drawio.md) | Unified Theme Adapter for Native Draw.io | Superseded by 0020 |
| [0008](./0008-native-drawio-is-the-only-diagram-canvas.md) | Native Draw.io as the Only Diagram Canvas | Superseded by 0011 |
| [0009](./0009-centralized-drawio-xml-processing.md) | Centralized Draw.io XML Processing | Partially superseded by 0011 |
| [0010](./0010-unified-server-side-copilot-intent-processing.md) | Unified Server-Side Copilot Intent Processing | Superseded by 0026 for Copilot mutations |
| [0011](./0011-native-drawio-only-model.md) | Native Draw.io Is the Only Diagram Model | Accepted |
| [0012](./0012-native-diagram-extension-contracts.md) | Native Diagram Extension Contracts Without a Parallel Model | Accepted; Copilot mutation guidance superseded by 0026 |
| [0013](./0013-studio-owned-layout-engines.md) | Studio-Owned Dagre/ELK Layout Is a Core Feature | Accepted |
| [0014](./0014-typed-native-drawio-c4-conversion.md) | Typed Native Draw.io C4 Conversion (historical) | Superseded by 0019 |
| [0015](./0015-tool-guided-copilot-shape-discovery.md) | Tool-Guided Copilot Instructions and Draw.io Shape Discovery | Accepted |
| [0016](./0016-node-owned-local-drawio-file-io.md) | Browser-Owned Standalone Draw.io File I/O | Accepted |
| [0017](./0017-unified-runtime-storage-scope.md) | Unified Runtime Storage Scope for Workspace and Single-File Modes | Accepted |
| [0018](./0018-ai-first-native-drawio-execution.md) | AI-First Native Draw.io Execution (historical script-first design) | Retired by 0026 |
| [0019](./0019-additive-native-c4-elements.md) | Additive Native C4 Elements, No In-Place Conversion | Accepted |
| [0020](./0020-native-drawio-diagram-theme-presets.md) | Native Draw.io Diagram Theme Presets | Accepted |
| [0021](./0021-expanded-native-layout-engines.md) | Expanded Native Layout Engines and Algorithm Adapters | Accepted |
| [0022](./0022-atomic-spatial-region-layout.md) | Atomic Layout for Geometry-Only Spatial Regions | Accepted |
| [0023](./0023-category-preserving-curated-diagram-palettes.md) | Category-Preserving Curated Diagram Palettes | Accepted |
| [0024](./0024-local-grouping-and-layout-density-options.md) | Preserve Local Grouping and Offer Layout Density Presets | Accepted |
| [0025](./0025-relative-anchors-and-stability-preserving-layout.md) | Relative Anchors and Mental-Map-Preserving Layout | Accepted |
| [0026](./0026-server-side-xml-first-copilot-editing.md) | Server-Side XML-First Copilot Editing | Accepted; implementation cleanup in PR #31 |
