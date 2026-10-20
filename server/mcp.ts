import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const API_BASE = (process.env.ARCHITECTURE_DIAGRAM_API ?? 'http://127.0.0.1:3001').replace(/\/$/, '');

async function api(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new Error('Architecture Diagram Studio API is not reachable. Start the app with npm run dev and open the editor first.');
  }
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Studio API returned HTTP ${response.status}`);
  return payload;
}

async function mutate(operation: string, args: Record<string, unknown> = {}) {
  return api('/api/diagram/mutate', {
    method: 'POST',
    body: JSON.stringify({ operation, args }),
  });
}

const server = new McpServer({
  name: 'architecture-diagram-studio',
  version: '1.0.0',
});

server.registerTool('get_current_diagram', {
  description: 'Read the active diagram currently open in Architecture Diagram Studio, including nodes, relationships, layout geometry, diagram kind, and title. Open the Studio in a browser first.',
  inputSchema: z.object({}),
}, async () => ({
  content: [{ type: 'text', text: JSON.stringify(await api('/api/diagram'), null, 2) }],
}));

server.registerTool('add_diagram_node', {
  description: 'Add a person, system, service, database, external system, or boundary to the active diagram. Use a stable unique ID.',
  inputSchema: z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    type: z.enum(['person', 'system', 'service', 'database', 'external', 'boundary']),
    label: z.string().min(1),
    description: z.string().optional(),
    technology: z.string().optional(),
  }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('add_node', args), null, 2) }] }));

server.registerTool('update_diagram_node', {
  description: 'Update the label, description, technology, or element type of an existing diagram node. Only supplied fields are changed.',
  inputSchema: z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    description: z.string().optional(),
    technology: z.string().optional(),
    type: z.enum(['person', 'system', 'service', 'database', 'external', 'boundary']).optional(),
  }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('update_node', args), null, 2) }] }));

server.registerTool('delete_diagram_node', {
  description: 'Delete a node and all relationships connected to it from the active diagram.',
  inputSchema: z.object({ id: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('delete_node', args), null, 2) }] }));

server.registerTool('add_diagram_relation', {
  description: 'Connect two existing diagram nodes with a labeled relationship.',
  inputSchema: z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    sourceId: z.string().min(1),
    targetId: z.string().min(1),
    label: z.string().min(1),
    kind: z.enum(['sync', 'async', 'data']).optional(),
  }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('add_relation', args), null, 2) }] }));

server.registerTool('update_diagram_relation', {
  description: 'Change the label or communication kind of an existing diagram relationship.',
  inputSchema: z.object({
    id: z.string().min(1),
    label: z.string().optional(),
    kind: z.enum(['sync', 'async', 'data']).optional(),
  }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('update_relation', args), null, 2) }] }));

server.registerTool('delete_diagram_relation', {
  description: 'Delete an existing relationship by ID.',
  inputSchema: z.object({ id: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('delete_relation', args), null, 2) }] }));

server.registerTool('set_diagram_title', {
  description: 'Rename the active architecture diagram.',
  inputSchema: z.object({ title: z.string().min(1).max(200) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('set_title', args), null, 2) }] }));

server.registerTool('validate_diagram', {
  description: 'Validate the active diagram for duplicate IDs, missing relationship endpoints, empty labels, and missing geometry. Returns errors and warnings without changing the diagram.',
  inputSchema: z.object({}),
}, async () => ({ content: [{ type: 'text', text: JSON.stringify(await api('/api/diagram/validate'), null, 2) }] }));

server.registerTool('request_diagram_auto_layout', {
  description: 'Ask the open Studio editor to run its currently selected layout engine on the active diagram. The editor applies the layout and synchronizes the result back to the local API.',
  inputSchema: z.object({ reason: z.string().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('request_layout', args), null, 2) }] }));

const transport = new StdioServerTransport();
server.connect(transport).catch((error: unknown) => {
  console.error('[architecture-diagram-studio-mcp] failed to start:', error);
  process.exitCode = 1;
});
