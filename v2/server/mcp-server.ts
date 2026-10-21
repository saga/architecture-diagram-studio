import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { readFile, readdir, realpath, stat } from "node:fs/promises";

const DATA_DIR = process.env.STUDIO_DATA_DIR || path.join(os.homedir(), ".architecture-diagram-studio", "data");
const CONFIG_FILE = path.join(DATA_DIR, "project-workspace.json");
type Workspace = { schemaVersion: number; id: string; name: string; rootPath: string; primaryDiagram: string | null; includePatterns: string[]; excludePatterns: string[]; createdAt: string; updatedAt: string };
type FileEntry = { path: string; name: string; kind: string; size: number; modifiedAt: string };
const EXCLUDED_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".venv", "venv", "vendor"]);
const DIAGRAM_EXTS = new Set([".drawio", ".dio", ".mmd", ".mermaid", ".puml", ".plantuml"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".kt", ".go", ".rs", ".cs", ".cpp", ".h", ".sql", ".sh", ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css"]);
const DOC_EXTS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

async function getWorkspace(): Promise<Workspace> {
  const workspace = JSON.parse(await readFile(CONFIG_FILE, "utf8")) as Workspace;
  const root = await realpath(workspace.rootPath);
  if (root !== workspace.rootPath) throw new Error("Workspace root changed; reconfigure the workspace to confirm the canonical path.");
  if (!(await stat(root)).isDirectory()) throw new Error("Configured workspace root is not a directory.");
  return workspace;
}
function kindFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (DIAGRAM_EXTS.has(ext)) return "diagram";
  if (CODE_EXTS.has(ext)) return "code";
  if (DOC_EXTS.has(ext)) return "document";
  return "other";
}
async function listFiles(workspace: Workspace): Promise<FileEntry[]> {
  const root = await realpath(workspace.rootPath);
  const files: FileEntry[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || files.length >= 10000) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= 10000) break;
      if (EXCLUDED_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (workspace.excludePatterns?.some((p) => relative === p || relative.startsWith(p.replace(/\/$/, "") + "/"))) continue;
      if (entry.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const info = await stat(absolute).catch(() => null);
      if (info) files.push({ path: relative, name: entry.name, kind: kindFor(relative), size: info.size, modifiedAt: info.mtime.toISOString() });
    }
  }
  await walk(root, 0);
  return files.sort((a, b) => (a.kind === "diagram" ? 0 : 1) - (b.kind === "diagram" ? 0 : 1) || a.path.localeCompare(b.path));
}
async function readWorkspaceFile(relativePath: string): Promise<string> {
  const workspace = await getWorkspace();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === "..")) throw new Error("Invalid relative file path.");
  const root = await realpath(workspace.rootPath);
  const target = await realpath(path.resolve(root, relativePath));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("File is outside the configured workspace.");
  if (!(await stat(target)).isFile()) throw new Error("Target is not a file.");
  const info = await stat(target);
  if (info.size > 1024 * 1024) throw new Error("File exceeds the 1 MiB context-read limit.");
  return readFile(target, "utf8");
}
const tools = [
  { name: "workspace_info", description: "Get the active project workspace name, root path, and primary Draw.io diagram. Always call this before project analysis.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_workspace_files", description: "List project files classified as diagram, code, document, or other. Draw.io files sort first.", inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["diagram", "code", "document", "other", "all"] } }, additionalProperties: false } },
  { name: "list_drawio_diagrams", description: "List native Draw.io and diagram source files in the configured project workspace.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "read_workspace_file", description: "Read a UTF-8 text file from the configured workspace. Paths must be workspace-relative; maximum size is 1 MiB.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "search_workspace", description: "Search UTF-8 source, documentation, and diagram files for a literal case-insensitive text query.", inputSchema: { type: "object", properties: { query: { type: "string" }, kind: { type: "string", enum: ["diagram", "code", "document", "all"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }, required: ["query"], additionalProperties: false } }
];
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const workspace = await getWorkspace();
  if (name === "workspace_info") return { id: workspace.id, name: workspace.name, rootPath: workspace.rootPath, primaryDiagram: workspace.primaryDiagram, schemaVersion: workspace.schemaVersion };
  const files = await listFiles(workspace);
  if (name === "list_workspace_files") {
    const kind = typeof args.kind === "string" ? args.kind : "all";
    return files.filter((f) => kind === "all" || f.kind === kind);
  }
  if (name === "list_drawio_diagrams") return { primaryDiagram: workspace.primaryDiagram, diagrams: files.filter((f) => f.kind === "diagram") };
  if (name === "read_workspace_file") return { path: args.path, content: await readWorkspaceFile(String(args.path || "")) };
  if (name === "search_workspace") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new Error("query must not be empty");
    const kind = typeof args.kind === "string" ? args.kind : "all";
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 50));
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const file of files) {
      if (matches.length >= limit) break;
      if (kind !== "all" && file.kind !== kind) continue;
      if (file.kind === "other" || file.size > 512 * 1024) continue;
      const body = await readWorkspaceFile(file.path).catch(() => "");
      const lines = body.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < limit; i++) if (lines[i].toLowerCase().includes(query.toLowerCase())) matches.push({ path: file.path, line: i + 1, text: lines[i].slice(0, 500) });
    }
    return { query, matches, truncated: matches.length >= limit };
  }
  throw new Error("Unknown tool: " + name);
}
function send(message: unknown): void { process.stdout.write(JSON.stringify(message) + "\n"); }
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  void (async () => {
    let request: any;
    try {
      request = JSON.parse(line);
      const id = request.id;
      if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
      if (request.method === "initialize") {
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "architecture-diagram-studio-workspace", version: "1.0.0" } } });
      } else if (request.method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (request.method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools } });
      } else if (request.method === "tools/call") {
        try {
          const result = await callTool(String(request.params?.name || ""), (request.params?.arguments || {}) as Record<string, unknown>);
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: false } });
        } catch (error) {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } });
        }
      } else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + request.method } });
    } catch (error) {
      send({ jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32700, message: error instanceof Error ? error.message : String(error) } });
    }
  })();
});
