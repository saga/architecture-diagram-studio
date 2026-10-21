# Architecture Diagram Studio

This repository now separates the preserved first implementation from the new independent V2 app.

- V2 architecture design: ARCHITECTURE-V2.md
- Run V2 application: v2/README.md
- Original V1 application snapshot: v1/README.md

V1 is preserved byte-for-byte at the file level under v1/ for reference only. V2 does not import, depend on, or modify V1 implementation files.

Start the new application:

    cd v2
    npm install
    npm run dev

V2 focuses on C4, sequence and process-flow diagrams, with a Studio Editorial design system, semantic ELK layout, route-quality scoring, preview-before-commit Copilot, Copilot SDK agent-backed intent planning, manual relation editing, and a pinned locally bundled Draw.io editor. See v2/README.md for supported features and offline setup.