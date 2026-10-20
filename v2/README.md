# Architecture Diagram Studio V2

V2 is an independent implementation. The previous implementation is preserved under the sibling V1 directory; V2 must not import code from V1.

## Run

Use Node.js 20 or later.

1. Install dependencies in this directory with npm install.
2. Run npm run dev.
3. Open the local Vite address printed in the terminal.

The pre-dev and pre-build hooks install a pinned Draw.io web bundle (v32.0.2, SHA-256 verified). After it is installed, the editor loads Draw.io from the same origin and does not use online embed. For an offline setup, provide a previously downloaded release archive using the environment variable DRAWIO_WAR and run npm run drawio:fetch.

## Implemented in this first V2 slice

- Standalone Vite + React + TypeScript app.
- First-class C4, flowchart and sequence fixtures.
- DiagramDocument V2 semantic model.
- ELK layered layout, semantic external/storage lanes, deterministic sequence layout, routing repair and node locks.
- Studio Editorial visual system and draggable Studio preview.
- Local Draw.io iframe mode, native editable XML export, and read-back of saved Draw.io XML.
- Local intent commands for line style, routing, external placement, storage placement, layout direction and lock clearing.
- Deterministic layout-quality measurements and regression tests.

## Intentional boundary

The chat currently uses a local deterministic intent interpreter, not an LLM. This keeps the canvas usable without API keys and prevents the UI from claiming a model was called when it was not. An LLM provider and preview/commit orchestration can be added behind the same intent interface.

Draw.io web assets are generated into public/drawio at build time and are not committed as a bulky binary payload. No online fallback is configured. In offline deployments the archive must be supplied once during the build or included in the deployment artefacts.