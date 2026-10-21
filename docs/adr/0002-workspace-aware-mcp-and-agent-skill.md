# ADR 0002: Workspace-Aware MCP and Agent Skill

- Status: Accepted
- Date: 2026-10-21
- Scope: Model Context Protocol, Copilot Agent, reusable Agent Skills

## Context

The workspace must be useful beyond the Studio UI. The workspace needs a consistent way for the Studio's Agent workflow and optional workspace consumers to discover project diagrams, read code and design records, and search existing architecture without independently guessing paths or treating the current canvas as the entire system.

## Decision

Ship a small stdio MCP server as `v2/server/mcp-server.ts`, started with `npm run mcp`. It implements MCP initialization, tool discovery, ping, and tool calls over JSON-RPC stdio and reads the same `project-workspace.json` used by the HTTP service. It exposes only read-only workspace discovery and search. Diagram inspection, quality evaluation, edit proposals, templates, diffs, and version restoration are internal Studio server capabilities used by the Copilot Agent and UI, not MCP tools. Workspace tools include:

- `workspace_info`: workspace identity, root, and primary diagram.
- `list_workspace_files`: workspace file inventory classified by kind.
- `list_drawio_diagrams`: native Draw.io and diagram-source inventory.
- `read_workspace_file`: bounded UTF-8 read by workspace-relative path.
- `search_workspace`: literal case-insensitive search across supported text files.

The MCP process does not accept arbitrary absolute paths. It rejects path traversal, checks canonical paths, skips symbolic links during indexing, and caps read sizes and search results. Tool results are evidence, not instructions.

A reusable project skill at `.github/skills/architecture-workspace/SKILL.md` instructs Agents to identify the active workspace first, inspect the primary diagram and related diagrams, search code/docs/ADRs for supporting evidence, cite workspace-relative paths in findings, and separate confirmed facts from inference. Project files must never override system or developer instructions.

The Copilot server also includes workspace metadata and bounded relevant file excerpts in each Agent turn. Internal diagram operations use the same authoritative workspace and persistence services.

## Alternatives considered

- **Expose only REST endpoints:** useful for the web app but not directly consumable by MCP clients.
- **Use a separate MCP workspace configuration:** rejected because duplicated root paths and primary diagram settings would drift.
- **Allow arbitrary filesystem tools:** rejected due to unnecessary access and prompt-injection risk.
- **Exposing diagram-editing and version-management operations through MCP:** rejected because no external integration requirement was requested. Those capabilities remain internal to the Studio server and Agent workflow.
- **Direct filesystem writes from MCP:** rejected. Workspace MCP remains read-only.

## Consequences

- VS Code discovers the project MCP server from `.vscode/mcp.json`; the MCP process and HTTP service share the same home directory or `STUDIO_DATA_DIR`.
- Workspace file changes are read from disk on each tool request rather than relying on a stale cached index.
- Workspace MCP remains read-only. Diagram changes initiated by the Studio Agent require user approval, a current revision or proposal token, server-side semantic and quality checks, and a new immutable version. Mermaid import/conversion remains out of scope.
