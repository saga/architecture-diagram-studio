# Architecture Diagram Studio

This repository contains two implementations.

- **V2** (v2/) is the active application. It uses native Draw.io XML as the only diagram model and the bundled Draw.io editor as the only canvas.
- **V1** (v1/) is retained as a reference snapshot. V2 does not import from or depend on V1.

Run V2 from the v2 directory with Node.js 22.13 or later: install dependencies with npm install, then run npm run dev.

Architecture decisions: [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md). Setup and current capabilities: [V2 README](v2/README.md).

V2 intentionally does not maintain a parallel semantic graph, generate diagrams from a reduced model, or run a custom layout/quality pipeline. Copilot uses typed, allowlisted native cell operations and applies them through Draw.io's own graph model. The old layout/style/shape research remains available as design input; future capabilities should use the native-cell extension contracts in [ADR-0012](docs/adr/0012-native-diagram-extension-contracts.md), not directly port the old renderer or semantic pipeline. The contracts exist, but no custom layout or quality provider is currently installed.
