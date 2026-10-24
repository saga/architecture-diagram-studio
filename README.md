# Architecture Diagram Studio

This repository contains two implementations.

- **V2** (v2/) is the active application. It uses native Draw.io XML as the only diagram model and the bundled Draw.io editor as the only canvas.
- **V1** (v1/) is retained as a reference snapshot. V2 does not import from or depend on V1.

Run V2 from the v2 directory with Node.js 22.13 or later: install dependencies with npm install, then run npm run dev.

Architecture decisions: [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md), [ADR-0018 — AI-First Native Draw.io Execution](docs/adr/0018-ai-first-native-drawio-execution.md). Setup and current capabilities: [V2 README](v2/README.md).

V2 intentionally does not maintain a parallel semantic graph, generate diagrams from a reduced model, or run a custom layout/quality pipeline. Copilot uses typed native operations for common deterministic edits and `run_drawio_script` for full access to the live Draw.io APIs. Typed operations are convenience shortcuts, not a capability allowlist; both paths must use native Draw.io XML serialization and the normal persistence/version acknowledgement. Scripts run in a separately-originated sandboxed Draw.io iframe, not in Node.js, and this browser-origin isolation is not an OS-level sandbox. The old layout/style/shape research remains available as design input; future analysis and editing capabilities should follow [ADR-0012](docs/adr/0012-native-diagram-extension-contracts.md) and [ADR-0018](docs/adr/0018-ai-first-native-drawio-execution.md), not port the old renderer or parallel semantic pipeline. The current runtime has no generic capability registry or quality-analysis provider; whole-page layout is a concrete Studio-owned Dagre/ELK feature described by ADR-0013.
