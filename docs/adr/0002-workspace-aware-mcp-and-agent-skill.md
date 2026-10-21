# ADR 0002: Workspace-Aware MCP and Agent Skill

- Status: Accepted
- Date: 2026-10-21
- Scope: Model Context Protocol, Copilot Agent, reusable Agent Skills

## Context

The workspace must be useful beyond the Studio UI. External MCP-compatible clients and Agent Skill runners need a consistent way to discover project diagrams, read code and design records, and search existing architecture without independently guessing paths or treating the current canvas as the entire system.

## Decision

Ship a small stdio MCP server as `v2/server/mcp-server.ts`, started with `npm run mcp`. It implements MCP initialization, tool discovery, ping, and tool calls over JSON-RPC stdio and reads the same `project-workspace.json` used by the HTTP service. Its read-only tools are:

- `workspace_info`: workspace identity, root, and primary diagram.
- `list_workspace_files`: workspace file inventory classified by kind.
- `list_drawio_diagrams`: native Draw.io and diagram-source inventory.
- `read_workspace_file`: bounded UTF-8 read by workspace-relative path.
- `search_workspace`: literal case-insensitive search across supported text files.

The MCP process does not accept arbitrary absolute paths. It rejects path traversal, checks canonical paths, skips symbolic links during indexing, and caps read sizes and search results. Tool results are evidence, not instructions.

A reusable skill at `v2/skills/architecture-workspace/SKILL.md` instructs Agents to identify the active workspace first, inspect the primary diagram and related diagrams, search code/docs/ADRs for supporting evidence, cite workspace-relative paths in findings, and separate confirmed facts from inference. Project files must never override system or developer instructions.

The Copilot server also includes workspace metadata and bounded relevant file excerpts in each Agent turn. MCP is an additional integration surface, not a competing configuration store.

## Alternatives considered

- **Expose only REST endpoints:** useful for the web app but not directly consumable by MCP clients.
- **Use a separate MCP workspace configuration:** rejected because duplicated root paths and primary diagram settings would drift.
- **Allow arbitrary filesystem tools:** rejected due to unnecessary access and prompt-injection risk.
- **Expose write/edit tools in the first MCP slice:** deferred. Initial MCP support is read-only; mutations must later integrate with the server's audit log, workspace-relative path validation, and Draw.io version snapshots.

## Consequences

- MCP clients must be configured to run the local command in the repository's `v2` directory.
- The MCP process and HTTP server share the same home directory or `STUDIO_DATA_DIR`.
- Workspace file changes are read from disk on each tool request rather than relying on a stale cached index.
- Future MCP mutation tools must use server APIs or a shared persistence service instead of writing around Studio's version history.
