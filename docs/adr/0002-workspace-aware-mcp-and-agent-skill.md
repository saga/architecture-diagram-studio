# ADR 0002: Workspace-aware Agent Skill and internal Copilot tools

- Status: Accepted (supersedes the original standalone MCP decision)
- Date: 2026-10-21
- Scope: Workspace grounding, Copilot SDK tool use, reusable Agent Skills

## Context

The workspace must provide consistent project context to diagram analysis without creating a second external tool surface. The Studio already owns the active workspace configuration and a local Copilot SDK server.

## Decision

Do not ship or register a standalone MCP server for Studio workspace or diagram capabilities. The stdio server and VS Code MCP configuration are removed. Workspace retrieval, diagram inspection, quality evaluation, example search, governed edit proposals, templates, semantic diffs and version operations are internal capabilities of the Studio server registered through the GitHub Copilot SDK.

Keep the repository Agent Skill at `.github/skills/architecture-workspace/SKILL.md` as workflow documentation. It requires Agents to ground analysis in the configured workspace, inspect the primary diagram and related source, distinguish evidence from assumptions, and require user approval for mutations. It must not instruct users to start an MCP process.

Workspace path validation, file-size limits, semantic validation, revision checks, quality gates and version snapshots are enforced by server code, not by model prompts.

## Alternatives considered

- **Standalone read-only MCP server:** rejected because the Studio does not require a separate external integration surface.
- **Register graph-edit operations as MCP tools:** rejected; these capabilities are internal Studio Agent tools.
- **Let the model write Draw.io XML or workspace files directly:** rejected because it bypasses semantic validation, stale-revision checks and versioning.

## Consequences

- There is no `.vscode/mcp.json` or `npm run mcp` entry point.
- Studio Agent tools share the same server-side domain services and persisted workspace state.
- Workspace context is bounded. Retrieved project files are untrusted evidence, not instructions.
- Mermaid import/conversion remains out of scope.
