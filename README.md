# Architecture Diagram Studio

This repository contains two implementations.

- **V2** (v2/) is the active application. It uses native Draw.io XML as the only diagram model and the bundled Draw.io editor as the only canvas.
- **V1** (v1/) is retained as a reference snapshot. V2 does not import from or depend on V1.

Run V2 from the v2 directory with Node.js 22.13 or later: install dependencies with npm install, then run npm run dev.

Architecture decisions: [ADR-0011 — Native Draw.io Is the Only Diagram Model](docs/adr/0011-native-drawio-only-model.md), [ADR-0026 — Server-Side XML-First Copilot Editing](docs/adr/0026-server-side-xml-first-copilot-editing.md). Setup and current capabilities: [V2 README](v2/README.md).

V2 does not maintain a parallel semantic graph or generate diagrams from a reduced model. Copilot edits native Draw.io XML directly on the server; the server validates and versions the result, then notifies the frontend to load the authoritative revision. The `run_drawio_script` tool and model-generated JavaScript execution path are removed. Automatic layout remains a separate Studio-owned capability and is unchanged by the XML-first migration. Follow [ADR-0012](docs/adr/0012-native-diagram-extension-contracts.md) and [ADR-0026](docs/adr/0026-server-side-xml-first-copilot-editing.md). The current runtime has no generic capability registry or quality-analysis provider; whole-page layout is a concrete Studio-owned Dagre/ELK feature described by ADR-0013.
