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
    if (ch === "*") {
      if (source[i + 1] === "*") {
        i++;
        if (source[i + 1] === "/") { escaped += "(?:.*/)?"; i++; }
        else escaped += ".*";
      } else escaped += "[^/]*";
    } else if (ch === "?") escaped += "[^/]";
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
  // Cache bounded excerpts only, never the authoritative file list or workspace state.
  const snippetCache = new Map<string, { excerpt: string; truncated: boolean }>();
  let snippetCacheCharacters = 0;
  const MAX_SNIPPET_CACHE_ENTRIES = 400;
  const MAX_SNIPPET_CACHE_CHARACTERS = 1_500_000;

  function getCachedSnippet(key: string): { excerpt: string; truncated: boolean } | undefined {
    const cached = snippetCache.get(key);
    if (!cached) return undefined;
    snippetCache.delete(key);
    snippetCache.set(key, cached);
    return cached;
  }

  function setCachedSnippet(key: string, value: { excerpt: string; truncated: boolean }): void {
    const existing = snippetCache.get(key);
    if (existing) {
      snippetCacheCharacters -= existing.excerpt.length;
      snippetCache.delete(key);
    }
    if (value.excerpt.length > MAX_SNIPPET_CACHE_CHARACTERS) return;
    snippetCache.set(key, value);
    snippetCacheCharacters += value.excerpt.length;
    while (snippetCache.size > MAX_SNIPPET_CACHE_ENTRIES || snippetCacheCharacters > MAX_SNIPPET_CACHE_CHARACTERS) {
      const oldestKey = snippetCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = snippetCache.get(oldestKey);
      if (oldest) snippetCacheCharacters -= oldest.excerpt.length;
      snippetCache.delete(oldestKey);
    }
  }

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
  async function resolveWorkspaceFile(relativePath: string, options: { allowMissingFile?: boolean } = {}): Promise<{ workspace: ProjectWorkspace; absolutePath: string }> {
    const workspace = await getWorkspace();
    if (!workspace) throw new Error("Configure a project workspace first");
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === "..")) throw new Error("Invalid file path");
    const root = await realpath(workspace.rootPath);
    const unresolved = path.resolve(root, relativePath);
    const lexical = path.relative(root, unresolved);
    if (lexical.startsWith("..") || path.isAbsolute(lexical)) throw new Error("File path escapes the workspace");
    const parts = lexical.split(path.sep).filter(Boolean);
    let cursor = root;
    for (let index = 0; index < parts.length; index++) {
      cursor = path.join(cursor, parts[index]);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Reading workspace files through symlinks is not allowed");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const isFinalPart = index === parts.length - 1;
        if (code === "ENOENT" && isFinalPart && options.allowMissingFile) {
          // A configured primary diagram may have been deleted or moved. Permit atomic
          // recreation of the final file only; parent directories must already exist.
          const parent = await realpath(path.dirname(cursor));
          if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error("File path escapes the workspace");
          return { workspace, absolutePath: cursor };
        }
        throw error;
      }
    }
    const absolutePath = await realpath(unresolved);
    if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) throw new Error("File path escapes the workspace");
    if (!(await stat(absolutePath)).isFile()) throw new Error("The target is not a file");
    return { workspace, absolutePath };
  }
  async function collectAgentWorkspaceContext(prompt = ""): Promise<unknown> {
    const workspace = await getWorkspace();
    if (!workspace) return { configured: false, instruction: "No project workspace is configured. Do not claim project-specific findings.", cacheHits: 0, cacheMisses: 0 };

    const files = await scanWorkspaceFiles(workspace);
    const diagrams = files.filter((file) => file.kind === "diagram")
      .sort((a, b) => (a.path === workspace.primaryDiagram ? -1 : b.path === workspace.primaryDiagram ? 1 : 0));
    const codeAndDocs = files.filter((file) => file.kind === "code" || file.kind === "document");
    const terms = new Set<string>();
    const tokens = prompt.toLowerCase().match(/[a-z0-9_+-]{3,}|[\u4e00-\u9fff]{2,}/g) || [];
    const stopwords = new Set(["please", "change", "update", "make", "diagram", "current", "selected", "element", "node", "add", "move", "rename", "with", "from", "into", "that", "this", "为我", "帮我", "这个", "一下", "修改", "添加", "节点", "元素"]);
    for (const token of tokens) {
      if (token.length <= 1 || stopwords.has(token)) continue;
      if (/^[\u4e00-\u9fff]+$/.test(token)) {
        for (let index = 0; index + 1 < token.length; index++) terms.add(token.slice(index, index + 2));
      } else terms.add(token);
    }
    const guidePattern = /(^|\/)(readme|agents|architecture|design|contributing)(\.[^/]*)?$/i;
    const ranked = codeAndDocs.map((file) => {
      const normalizedPath = file.path.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ");
      let score = guidePattern.test(file.path) ? 4 : 0;
      for (const term of terms) if (normalizedPath.includes(term)) score += Math.min(3, Math.max(1, term.length / 4));
      return { file, score };
    }).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));

    const selected: WorkspaceFileEntry[] = [];
    const selectedPaths = new Set<string>();
    const add = (file: WorkspaceFileEntry | undefined) => {
      if (!file || selectedPaths.has(file.path) || selected.length >= 40) return;
      selectedPaths.add(file.path);
      selected.push(file);
    };
    add(diagrams.find((file) => file.path === workspace.primaryDiagram) || diagrams[0]);
    for (const file of diagrams.filter((item) => item.path !== workspace.primaryDiagram).slice(0, 2)) add(file);
    for (const item of ranked.slice(0, 37)) add(item.file);

    const snippets: Array<{ path: string; kind: string; content: string; truncated: boolean }> = [];
    let budget = 26000;
    let cacheHits = 0;
    let cacheMisses = 0;
    for (const item of selected) {
      if (budget <= 0) break;
      const extension = path.extname(item.path).toLowerCase();
      if (item.size > (item.kind === "diagram" ? 20 * 1024 * 1024 : 512 * 1024) ||
          item.kind === "other" ||
          [".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".lock", ".min.js"].includes(extension)) continue;
      const maxLength = item.kind === "diagram" ? 12000 : item.kind === "document" ? 5000 : 3500;
      const cacheKey = [workspace.id, item.path, item.size, item.modifiedAt].join("\0");
      let cached = getCachedSnippet(cacheKey);
      if (cached) {
        cacheHits++;
      } else {
        cacheMisses++;
        const content = await resolveWorkspaceFile(item.path)
          .then(({ absolutePath }) => readFile(absolutePath, "utf8"))
          .catch(() => "");
        cached = {
          excerpt: content.slice(0, Math.min(content.length, maxLength)),
          truncated: content.length > maxLength
        };
        if (cached.excerpt) setCachedSnippet(cacheKey, cached);
      }
      const clipped = cached.excerpt.slice(0, Math.min(cached.excerpt.length, budget, maxLength));
      if (clipped) {
        snippets.push({ path: item.path, kind: item.kind, content: clipped, truncated: cached.truncated || clipped.length < cached.excerpt.length });
        budget -= clipped.length;
      }
    }
    return {
      configured: true,
      workspace: { id: workspace.id, name: workspace.name, rootPath: workspace.rootPath, primaryDiagram: workspace.primaryDiagram },
      files: selected.map(({ path: filePath, kind, size }) => ({ path: filePath, kind, size })),
      snippets,
      cacheHits,
      cacheMisses,
      characterBudget: 26000 - budget
    };
  }
  return { resolveWorkspaceRoot, scanWorkspaceFiles, resolveWorkspaceFile, collectAgentWorkspaceContext };
}
