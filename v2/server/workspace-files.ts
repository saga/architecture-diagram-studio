import path from "node:path";
import { readdir, readFile, stat, realpath, lstat } from "node:fs/promises";

export type ProjectWorkspace = { schemaVersion: 1; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
export type WorkspaceFileEntry = { path: string; name: string; kind: "diagram" | "code" | "document" | "other"; size: number; modifiedAt: string };
const DEFAULT_WORKSPACE_EXCLUDES = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv", ".idea", "vendor"]);
const DIAGRAM_EXTENSIONS = new Set([".drawio", ".dio", ".xml", ".mmd", ".mermaid", ".puml", ".plantuml"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".kt", ".go", ".rs", ".cs", ".cpp", ".h", ".sql", ".sh", ".yaml", ".yml", ".json", ".toml", ".html", ".css"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

export function classifyWorkspaceFile(filePath: string): WorkspaceFileEntry["kind"] {
  const ext = path.extname(filePath).toLowerCase();
  if (DIAGRAM_EXTENSIONS.has(ext)) return "diagram";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "other";
}
export function matchesWorkspacePattern(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  let escaped = "";
  const source = pattern.trim();
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "*") { if (source[i + 1] === "*") { escaped += ".*"; i++; } else escaped += "[^/]*"; }
    else if (ch === "?") escaped += "[^/]";
    else if (".+^$()|{}[]".includes(ch) || ch === "\\") escaped += "\\" + ch;
    else escaped += ch;
  }
  try { return new RegExp("^" + escaped + "$").test(normalized); } catch { return false; }
}
export async function resolveWorkspaceRoot(requestedPath: string): Promise<{ rootPath: string; repositoryRoot: boolean; requestedPath: string }> {
  const requested = await realpath(path.resolve(requestedPath));
  if (!(await stat(requested)).isDirectory()) throw new Error("The given path is not a directory");
  let current = requested;
  while (true) {
    try {
      const markerInfo = await lstat(path.join(current, ".git"));
      if (markerInfo.isDirectory() || markerInfo.isFile()) return { rootPath: current, repositoryRoot: true, requestedPath: requested };
    } catch { /* No Git metadata at this level. */ }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { rootPath: requested, repositoryRoot: false, requestedPath: requested };
}
export function createWorkspaceFileService(getWorkspace: () => Promise<ProjectWorkspace | null>) {
  async function scanWorkspaceFiles(workspace: ProjectWorkspace): Promise<WorkspaceFileEntry[]> {
    const root = await realpath(workspace.rootPath);
    const result: WorkspaceFileEntry[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8 || result.length >= 10000) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (result.length >= 10000) break;
        if (DEFAULT_WORKSPACE_EXCLUDES.has(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        const relativePath = path.relative(root, absolute).split(path.sep).join("/");
        if (workspace.excludePatterns.some((pattern) => matchesWorkspacePattern(relativePath, pattern))) continue;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await visit(absolute, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const info = await stat(absolute).catch(() => null);
        if (!info) continue;
        if (workspace.includePatterns.length && !workspace.includePatterns.some((pattern) => matchesWorkspacePattern(relativePath, pattern))) continue;
        result.push({ path: relativePath, name: entry.name, kind: classifyWorkspaceFile(relativePath), size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    };
    await visit(root, 0);
    return result.sort((a, b) => (a.kind === "diagram" ? 0 : 1) - (b.kind === "diagram" ? 0 : 1) || a.path.localeCompare(b.path));
  }
  async function resolveWorkspaceFile(relativePath: string): Promise<{ workspace: ProjectWorkspace; absolutePath: string }> {
    const workspace = await getWorkspace();
    if (!workspace) throw new Error("Configure a project workspace first");
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === "..")) throw new Error("Invalid file path");
    const root = await realpath(workspace.rootPath);
    const unresolved = path.resolve(root, relativePath);
    const lexical = path.relative(root, unresolved);
    if (lexical.startsWith("..") || path.isAbsolute(lexical)) throw new Error("File path escapes the workspace");
    let cursor = root;
    for (const part of lexical.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Reading workspace files through symlinks is not allowed");
    }
    const absolutePath = await realpath(unresolved);
    if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) throw new Error("File path escapes the workspace");
    if (!(await stat(absolutePath)).isFile()) throw new Error("The target is not a file");
    return { workspace, absolutePath };
  }
  async function collectAgentWorkspaceContext(): Promise<unknown> {
    const workspace = await getWorkspace();
    if (!workspace) return { configured: false, instruction: "No project workspace is configured. Do not claim project-specific findings." };
    const files = await scanWorkspaceFiles(workspace);
    const relevant = [
      ...files.filter((file) => file.kind === "diagram").sort((a, b) => (a.path === workspace.primaryDiagram ? -1 : b.path === workspace.primaryDiagram ? 1 : 0)),
      ...files.filter((file) => file.kind === "code").slice(0, 80),
      ...files.filter((file) => file.kind === "document").slice(0, 80)
    ].slice(0, 200);
    const snippets: Array<{ path: string; kind: string; content: string; truncated: boolean }> = [];
    let budget = 90000;
    for (const item of relevant) {
      if (budget <= 0) break;
      if (item.size > (item.kind === "diagram" ? 20 * 1024 * 1024 : 512 * 1024) || item.kind === "other" ||
          [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".lock"].includes(path.extname(item.path).toLowerCase())) continue;
      const content = await resolveWorkspaceFile(item.path).then(({ absolutePath }) => readFile(absolutePath, "utf8")).catch(() => "");
      const maxLength = item.kind === "diagram" ? 20000 : 4000;
      const excerpt = content.slice(0, Math.min(content.length, budget, maxLength));
      if (excerpt) { snippets.push({ path: item.path, kind: item.kind, content: excerpt, truncated: excerpt.length < content.length }); budget -= excerpt.length; }
    }
    return {
      configured: true,
      workspace: { id: workspace.id, name: workspace.name, rootPath: workspace.rootPath, primaryDiagram: workspace.primaryDiagram },
      files: relevant.map(({ path: filePath, kind, size }) => ({ path: filePath, kind, size })),
      snippets
    };
  }
  return { resolveWorkspaceRoot, scanWorkspaceFiles, resolveWorkspaceFile, collectAgentWorkspaceContext };
}
