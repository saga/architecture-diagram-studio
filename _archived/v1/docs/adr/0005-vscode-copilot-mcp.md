# ADR 0005: Local VS Code Copilot integration through MCP

- Status: Accepted
- Date: 2026-10-20

## Context

Architects want to ask GitHub Copilot in local VS Code to inspect and change the diagram that is open in Architecture Diagram Studio. The browser editor, local Copilot SDK chat, and VS Code Copilot must share the same versioned Diagram Document rather than maintain unrelated copies.

## Decision

- Add a local stdio MCP server using the official TypeScript SDK.
- Configure it through the workspace-level `.vscode/mcp.json`.
- Expose explicit diagram operations only: read, node CRUD, relationship CRUD, title update, validation, and a request to run the active layout engine.
- Keep the local Express API as the shared state boundary. It validates mutations and returns revision numbers; the browser synchronizes the active document and geometry with the API.
- Keep the API bound to `127.0.0.1`. The MCP server has no shell, filesystem, repository, or arbitrary-network tools.
- Defer A2A until there is a concrete requirement to delegate work between independently operated agents. MCP is the appropriate interface for Copilot invoking application tools.

## Consequences

Positive:
- VS Code Copilot can work against the diagram currently visible in the browser.
- The web editor, local Copilot SDK chat, and MCP tools use the same semantic model and validation rules.
- Tools have narrow schemas and cannot directly manipulate React Flow state.

Trade-offs:
- The Studio API and browser editor must be running for active-diagram operations.
- The active diagram and revision metadata are persisted by the Express service. MCP operations write correlated start/completion events to the SQLite audit ledger; browser synchronization remains single-editor only.
- Synchronization is intended for one active editor, not concurrent multi-tab or multi-user collaboration.
- A real Copilot-authenticated smoke test is required in a developer's local VS Code environment.

## Verification

Run `npm install`, `npm run typecheck`, `npm test`, and `npm run build`. Then start the app, start the workspace MCP server from VS Code, and verify that a Copilot tool call changes the visible diagram and that a browser-side edit is reflected by `get_current_diagram`.
