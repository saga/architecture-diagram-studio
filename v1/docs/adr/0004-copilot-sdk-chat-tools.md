# ADR 0004: Copilot SDK chat edits through constrained diagram tools

- Status: Accepted
- Date: 2026-10-20

## Context

The diagram editor needs natural-language interaction without letting the model manipulate React Flow state directly or access the host filesystem and repository. Diagram edits must remain inspectable, validate against the shared Diagram Document, and preserve the current manual layout unless layout is explicitly requested.

The existing `saga/copilot-server-agent` implementation uses a long-lived `CopilotClient`, creates SDK sessions with explicit configuration, and separates app-defined tools from ambient runtime tools. The project follows that pattern and pins `@github/copilot-sdk` to `1.0.14`.

## Decision

- Run the SDK in a local Express API process; the browser never receives credentials.
- Reuse one Copilot SDK client, with a session per browser chat ID.
- Set client `mode: "empty"` and session `availableTools: []`; register only diagram-specific tools.
- Expose node CRUD, relationship CRUD, diagram title update, and an explicit request for ELK auto-layout.
- Send the current diagram snapshot on every turn. The browser snapshot is authoritative over stale model context.
- Apply tool calls to a draft copy, validate IDs and relationship endpoints, then return the whole document to the editor.
- Bind the API to loopback and avoid enabling CORS for arbitrary origins. Network deployment requires an explicit authentication and authorization layer.

## Consequences

Positive:
- The model performs real semantic edits instead of only suggesting changes in prose.
- The tool boundary is narrow and testable; model-generated text is not parsed as an operation language.
- The existing React Flow editor and draw.io exporter continue to consume the same document model.

Trade-offs:
- SDK session objects are held in process memory; the UI replays recent history after an API restart rather than restoring the runtime session itself.
- The first implementation waits for the complete SDK turn before applying changes; token-level streaming and progress events remain future work.
- Natural-language instructions may be ambiguous. The tool schema enforces structural constraints but cannot guarantee that the resulting architecture is semantically correct; the user remains responsible for review.

## Verification

The code path is covered by TypeScript/CI configuration, but a real Copilot-authenticated end-to-end run is still required to verify model availability, tool invocation, and returned edits in the user's local environment.
