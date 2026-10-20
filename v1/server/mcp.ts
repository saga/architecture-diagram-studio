import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
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

server.registerTool('set_diagram_kind', {
  description: 'Switch the active diagram to C4 Context, C4 Container, C4 Component, or UML Sequence using a matching starter template.',
  inputSchema: z.object({ kind: z.enum(['c4-context','c4-container','c4-component','sequence']), title: z.string().max(200).optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('set_diagram_kind', args), null, 2) }] }));

server.registerTool('add_sequence_participant', {
  description: 'Add a participant to the active UML sequence diagram. Participant order determines horizontal lifeline order.',
  inputSchema: z.object({ id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), label: z.string().min(1), role: z.enum(['actor','system','container','database','external']), technology: z.string().optional(), description: z.string().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('add_sequence_participant', args), null, 2) }] }));

server.registerTool('update_sequence_participant', {
  description: 'Change a participant name, role, technology or description.',
  inputSchema: z.object({ id: z.string().min(1), label: z.string().min(1).optional(), role: z.enum(['actor','system','container','database','external']).optional(), technology: z.string().optional(), description: z.string().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('update_sequence_participant', args), null, 2) }] }));

server.registerTool('delete_sequence_participant', {
  description: 'Delete a sequence participant and dependent messages, activations and fragments.',
  inputSchema: z.object({ id: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('delete_sequence_participant', args), null, 2) }] }));

server.registerTool('add_sequence_message', {
  description: 'Add a chronological call, return, or asynchronous message between existing sequence participants.',
  inputSchema: z.object({ id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), fromParticipantId: z.string().min(1), toParticipantId: z.string().min(1), label: z.string().min(1), kind: z.enum(['call','return','async']).optional(), order: z.number().int().positive().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('add_sequence_message', args), null, 2) }] }));

server.registerTool('update_sequence_message', {
  description: 'Edit a sequence message label, sender, receiver, kind, or chronological order.',
  inputSchema: z.object({ id: z.string().min(1), fromParticipantId: z.string().min(1).optional(), toParticipantId: z.string().min(1).optional(), label: z.string().min(1).optional(), kind: z.enum(['call','return','async']).optional(), order: z.number().int().positive().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('update_sequence_message', args), null, 2) }] }));

server.registerTool('delete_sequence_message', {
  description: 'Delete a sequence message and remove invalid activation/fragment references.',
  inputSchema: z.object({ id: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('delete_sequence_message', args), null, 2) }] }));

server.registerTool('add_sequence_activation', {
  description: 'Create an activation bar for a participant across an inclusive chronological range of sequence messages.',
  inputSchema: z.object({ participantId: z.string().min(1), startMessageId: z.string().min(1), endMessageId: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('add_sequence_activation', args), null, 2) }] }));

server.registerTool('update_sequence_activation', {
  description: 'Change the participant or start/end message range of an existing sequence activation.',
  inputSchema: z.object({ participantId: z.string().min(1), startMessageId: z.string().min(1), endMessageId: z.string().min(1), newParticipantId: z.string().optional(), newStartMessageId: z.string().optional(), newEndMessageId: z.string().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('update_sequence_activation', args), null, 2) }] }));

server.registerTool('delete_sequence_activation', {
  description: 'Delete an activation by participant and message range.',
  inputSchema: z.object({ participantId: z.string().min(1), startMessageId: z.string().min(1), endMessageId: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('delete_sequence_activation', args), null, 2) }] }));

server.registerTool('add_sequence_fragment', {
  description: 'Add an alt, opt, loop, or par frame around an inclusive range of sequence messages.',
  inputSchema: z.object({ id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/), kind: z.enum(['alt','opt','loop','par']), title: z.string().min(1), guard: z.string().optional(), startMessageId: z.string().min(1), endMessageId: z.string().min(1), participantStartId: z.string().optional(), participantEndId: z.string().optional() }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('add_sequence_fragment', args), null, 2) }] }));

server.registerTool('delete_sequence_fragment', {
  description: 'Delete a sequence fragment by ID.',
  inputSchema: z.object({ id: z.string().min(1) }),
}, async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await mutate('delete_sequence_fragment', args), null, 2) }] }));

server.registerTool('add_diagram_node', {
  description: 'Add a person, system, service, database, external system, or boundary to the active diagram. Use a stable unique ID.',
  inputSchema: z.object({
    id: z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    type: z.enum(['person', 'system', 'service', 'component', 'database', 'external']),
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
    type: z.enum(['person', 'system', 'service', 'component', 'database', 'external']).optional(),
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

serveStdio(() => server);
