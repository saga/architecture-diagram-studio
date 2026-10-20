import 'dotenv/config';
import { homedir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { CopilotClient, defineTool, RuntimeConnection } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';
import { type DiagramDocument, type DiagramNode, type DiagramRelation, type SequenceMessage, type SequenceParticipant, type SequenceFragment, type SequenceActivation, type DiagramKind } from '../src/model/diagram.js';
import { appendAgentTrace, loadStudioStore, readAgentTraces, saveStudioStore, type StoredChatMessage } from './persistence.js';
import { validateDiagram } from '../src/model/validate.js';
import { addNodeToBoundary, removeNodesFromBoundaries, syncNodeBoundaryMembership } from '../src/model/boundaries.js';
import { createDiagramTemplate } from '../src/model/templates.js';
import { normalizeSequenceRanges, sequenceActivationIssue, sequenceActivationKey } from '../src/model/sequence.js';

const PORT = Number(process.env.PORT ?? 3001);
const MODEL = process.env.COPILOT_MODEL?.trim() || 'gpt-5';
const BASE_DIRECTORY = process.env.COPILOT_HOME?.trim() || path.join(homedir(), '.copilot');
const MAX_PROMPT_CHARS = 12_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

interface ChatState { diagram: DiagramDocument; requestAutoLayout: boolean }
const persisted = loadStudioStore();
let sharedDiagram: DiagramDocument | undefined = persisted.diagram ?? undefined;
let diagramRevision = persisted.revision;
let layoutRequestId = persisted.layoutRequestId;
const chatHistories = new Map<string, StoredChatMessage[]>(Object.entries(persisted.chats));
function persistStore(): void {
  saveStudioStore({
    version: 1,
    diagram: sharedDiagram ?? null,
    revision: diagramRevision,
    layoutRequestId,
    chats: Object.fromEntries(chatHistories),
  });
}
interface TraceContext { traceId: string; turnId: string; failure?: string }
function recordTrace(sessionId: string, type: string, data: unknown, context: Partial<TraceContext> & { category?: string; status?: string; durationMs?: number; provider?: string; model?: string; parentEventId?: string } = {}): string {
  const id = crypto.randomUUID();
  // Trace writes are part of the operation's audit boundary. Let failures reach the caller.
  appendAgentTrace({
    id, timestamp: new Date().toISOString(), sessionId, type, data,
    ...(context.traceId ? {traceId:context.traceId} : {}),
    ...(context.turnId ? {turnId:context.turnId} : {}),
    ...(context.parentEventId ? {parentEventId:context.parentEventId} : {}),
    ...(context.category ? {category:context.category} : {}),
    ...(context.status ? {status:context.status} : {}),
    ...(context.durationMs !== undefined ? {durationMs:context.durationMs} : {}),
    ...(context.provider ? {provider:context.provider} : {}),
    ...(context.model ? {model:context.model} : {}),
  });
  return id;
}
function saveChatMessage(sessionId: string, role: StoredChatMessage['role'], content: string): void {
  const previous = chatHistories.get(sessionId);
  const history = [...(previous ?? []), { id: crypto.randomUUID(), role, content, timestamp: new Date().toISOString() }].slice(-1000);
  chatHistories.set(sessionId, history);
  try { persistStore(); }
  catch (error) {
    if (previous) chatHistories.set(sessionId, previous);
    else chatHistories.delete(sessionId);
    throw error;
  }
}
interface ManagedSession { session: CopilotSession; state: ChatState; busy: boolean; traceContext: TraceContext }
const sessions = new Map<string, ManagedSession>();
const pendingSessions = new Map<string, Promise<ManagedSession>>();
let client: CopilotClient | undefined;
let clientStart: Promise<CopilotClient> | undefined;

function getClient(): Promise<CopilotClient> {
  if (client) return Promise.resolve(client);
  if (!clientStart) {
    clientStart = (async () => {
      // Follow saga/copilot-server-agent: one long-lived SDK client, local CLI identity by default,
      // and mode=empty so the model can only use the diagram-specific tools declared below.
      const next = new CopilotClient({
        mode: 'empty',
        baseDirectory: BASE_DIRECTORY,
        ...(process.env.GITHUB_TOKEN ? { gitHubToken: process.env.GITHUB_TOKEN, useLoggedInUser: false } : { useLoggedInUser: true }),
        ...(process.env.COPILOT_CLI_PATH ? { connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }) } : {}),
        ...(process.env.COPILOT_LOG_LEVEL ? { logLevel: process.env.COPILOT_LOG_LEVEL as 'none'|'error'|'warning'|'info'|'debug'|'all' } : {}),
      });
      await next.start();
      client = next;
      return next;
    })().catch((error) => { clientStart = undefined; throw error; });
  }
  return clientStart;
}

function validId(id: string): boolean { return ID_PATTERN.test(id); }
function hasId(state: ChatState, id: string): boolean {
  return state.diagram.nodes.some((n) => n.id === id)
    || state.diagram.relations.some((r) => r.id === id)
    || (state.diagram.boundaries ?? []).some((boundary) => boundary.id === id)
    || (state.diagram.sequence?.participants ?? []).some((participant) => participant.id === id)
    || (state.diagram.sequence?.messages ?? []).some((message) => message.id === id)
    || (state.diagram.sequence?.fragments ?? []).some((fragment) => fragment.id === id);
}
function toolError(message: string) { return { ok: false, error: message }; }
function ensureValid(state: ChatState): string | undefined {
  const errors = validateDiagram(state.diagram).filter((issue) => issue.severity === 'error');
  return errors.length ? errors.map((issue) => issue.message).join(' ') : undefined;
}

function buildTools(state: ChatState) {
  const addNode = defineTool('add_diagram_node', {
    description: 'Add a person, system, service, database, or external system to the current diagram. Choose a stable unique ID using letters, numbers, underscore, or hyphen.',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: 'Unique machine ID, e.g. notification_service' },
      type: { type: 'string', enum: ['person','system','service','component','database','external','boundary'], description: 'C4 element type' },
      label: { type: 'string', description: 'Human-readable element name' },
      description: { type: 'string' }, technology: { type: 'string' },
    }, required: ['id','type','label'] },
    handler: async (args: {id:string;type:DiagramNode['type'];label:string;description?:string;technology?:string}) => {
      if(state.diagram.kind==='sequence') return toolError('This is a sequence diagram. Use sequence participant/message tools, or switch back to a C4 diagram first.');
      if (!validId(args.id)) return toolError('ID must start with a letter or number and contain only letters, numbers, _ or - (max 80 characters).');
      if (hasId(state,args.id)) return toolError('That ID already exists. Choose a different ID.');
      if (!args.label.trim()) return toolError('Label cannot be empty.');
      const node: DiagramNode = { id: args.id, type: args.type, label: args.label.trim(),
        ...(args.description ? {description:args.description} : {}), ...(args.technology ? {technology:args.technology} : {}) };
      const i=state.diagram.nodes.length;
      state.diagram.nodes.push(node);
      state.diagram.layout[node.id]={x:80+(i%4)*260,y:100+Math.floor(i/4)*160,width:220,height:112};
      state.diagram=addNodeToBoundary(state.diagram,node.id);
      return {ok:true,node};
    },
  });
  const updateNode = defineTool('update_diagram_node', {
    description: 'Update an existing diagram node label, description, or technology. Only supplied fields are changed.',
    parameters: { type: 'object', properties: {
      id:{type:'string'}, label:{type:'string'}, description:{type:'string'}, technology:{type:'string'},
    }, required:['id'] },
    handler: async (args:{id:string;label?:string;description?:string;technology?:string}) => {
      if(state.diagram.kind==='sequence') return toolError('This is a sequence diagram. Use sequence participant/message tools, or switch back to a C4 diagram first.');
      const node=state.diagram.nodes.find((n)=>n.id===args.id);
      if(!node) return toolError('Node not found.');
      if(args.label !== undefined) node.label=args.label;
      if(args.description !== undefined) node.description=args.description;
      if(args.technology !== undefined) node.technology=args.technology;
      return {ok:true,node};
    },
  });
  const removeNode = defineTool('delete_diagram_node', {
    description: 'Delete a node and all relations connected to it.',
    parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},
    handler:async(args:{id:string})=>{
      if(state.diagram.kind==='sequence') return toolError('This is a sequence diagram. Use sequence participant/message tools, or switch back to a C4 diagram first.');
      if(!state.diagram.nodes.some((n)=>n.id===args.id)) return toolError('Node not found.');
      state.diagram=removeNodesFromBoundaries({
        ...state.diagram,
        nodes:state.diagram.nodes.filter((n)=>n.id!==args.id),
        relations:state.diagram.relations.filter((r)=>r.sourceId!==args.id&&r.targetId!==args.id),
        layout:Object.fromEntries(Object.entries(state.diagram.layout).filter(([nodeId])=>nodeId!==args.id)),
      },[args.id]);
      return {ok:true,deletedNodeId:args.id};
    },
  });
  const addRelation = defineTool('add_diagram_relation', {
    description:'Connect two existing diagram nodes with a labeled relationship. Source and target must be existing node IDs.',
    parameters:{type:'object',properties:{
      id:{type:'string'},sourceId:{type:'string'},targetId:{type:'string'},label:{type:'string'},
      kind:{type:'string',enum:['sync','async','data']},
    },required:['id','sourceId','targetId','label']},
    handler:async(args:{id:string;sourceId:string;targetId:string;label:string;kind?:DiagramRelation['kind']})=>{
      if(state.diagram.kind==='sequence') return toolError('This is a sequence diagram. Use sequence participant/message tools, or switch back to a C4 diagram first.');
      if(!validId(args.id)) return toolError('Invalid relation ID.');
      if(hasId(state,args.id)) return toolError('That ID already exists. Choose a different ID.');
      if(!state.diagram.nodes.some((n)=>n.id===args.sourceId)||!state.diagram.nodes.some((n)=>n.id===args.targetId)) return toolError('Both source and target must refer to existing nodes.');
      const relation:DiagramRelation={id:args.id,sourceId:args.sourceId,targetId:args.targetId,label:args.label,...(args.kind?{kind:args.kind}:{})};
      state.diagram.relations.push(relation);
      return {ok:true,relation};
    },
  });
  const updateRelation = defineTool('update_diagram_relation', {
    description:'Change the label or kind of an existing relationship.',
    parameters:{type:'object',properties:{id:{type:'string'},label:{type:'string'},kind:{type:'string',enum:['sync','async','data']}},required:['id']},
    handler:async(args:{id:string;label?:string;kind?:DiagramRelation['kind']})=>{
      if(state.diagram.kind==='sequence') return toolError('This is a sequence diagram. Use sequence participant/message tools, or switch back to a C4 diagram first.');
      const relation=state.diagram.relations.find((r)=>r.id===args.id);
      if(!relation) return toolError('Relation not found.');
      if(args.label!==undefined) relation.label=args.label;
      if(args.kind!==undefined) relation.kind=args.kind;
      return {ok:true,relation};
    },
  });
  const removeRelation = defineTool('delete_diagram_relation', {
    description:'Delete an existing relationship by ID.',
    parameters:{type:'object',properties:{id:{type:'string'}},required:['id']},
    handler:async(args:{id:string})=>{
      if(state.diagram.kind==='sequence') return toolError('This is a sequence diagram. Use sequence participant/message tools, or switch back to a C4 diagram first.');
      if(!state.diagram.relations.some((r)=>r.id===args.id)) return toolError('Relation not found.');
      state.diagram.relations=state.diagram.relations.filter((r)=>r.id!==args.id);
      return {ok:true,deletedRelationId:args.id};
    },
  });
  const setTitle = defineTool('set_diagram_title', {
    description:'Change the title of the current diagram.',
    parameters:{type:'object',properties:{title:{type:'string'}},required:['title']},
    handler:async(args:{title:string})=>{state.diagram.title=args.title.trim()||state.diagram.title;return {ok:true,title:state.diagram.title};},
  });
  const requestLayout = defineTool('request_diagram_auto_layout', {
    description:'Request the editor to run its ELK auto-layout after applying the requested structural changes. Use only when layout is helpful; users can always adjust positions manually.',
    parameters:{type:'object',properties:{reason:{type:'string'}},required:[]},
    handler:async(args:{reason?:string})=>{state.requestAutoLayout=true;return {ok:true,requested:true,reason:args.reason??'Structural changes'};},
  });
  const setDiagramKind = defineTool('set_diagram_kind', {
    description: 'Switch the active diagram to a C4 Context, Container, Component, or UML Sequence template. Use this before sequence-specific tools when the user asks to create a sequence diagram.',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['c4-context','c4-container','c4-component','sequence'] }, title: { type: 'string' } }, required: ['kind'] },
    handler: async (args: { kind: DiagramKind; title?: string }) => {
      if (state.diagram.kind === args.kind) return { ok: true, kind: args.kind, unchanged: true };
      const next = createDiagramTemplate(args.kind);
      if (args.title?.trim()) next.title = args.title.trim().slice(0, 200);
      state.diagram = next;
      state.requestAutoLayout = args.kind !== 'sequence';
      return { ok: true, kind: next.kind, title: next.title, participantCount: next.sequence?.participants.length ?? 0, elementCount: next.nodes.length };
    },
  });

  const addSequenceParticipant = defineTool('add_sequence_participant', {
    description: 'Add an actor, system, container, database, or external system to a UML sequence diagram. Participant order determines the horizontal lifeline order.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' },
      role: { type: 'string', enum: ['actor','system','container','database','external'] },
      technology: { type: 'string' }, description: { type: 'string' },
    }, required: ['id','label','role'] },
    handler: async (args: { id: string; label: string; role: SequenceParticipant['role']; technology?: string; description?: string }) => {
      if (state.diagram.kind !== 'sequence' || !state.diagram.sequence) return toolError('Switch to a UML Sequence diagram before adding a participant.');
      if (!validId(args.id)) return toolError('Participant ID is invalid.');
      if (hasId(state, args.id)) return toolError('That ID already exists. Choose a different ID.');
      if (!args.label.trim()) return toolError('Participant label cannot be empty.');
      const participant: SequenceParticipant = {
        id: args.id, label: args.label.trim(), role: args.role,
        ...(args.technology?.trim() ? { technology: args.technology.trim() } : {}),
        ...(args.description?.trim() ? { description: args.description.trim() } : {}),
      };
      state.diagram.sequence.participants.push(participant);
      return { ok: true, participant, participantIndex: state.diagram.sequence.participants.length - 1 };
    },
  });

  const updateSequenceParticipant = defineTool('update_sequence_participant', {
    description: 'Update the label, role, technology, or description of a participant in a UML sequence diagram.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' },
      role: { type: 'string', enum: ['actor','system','container','database','external'] },
      technology: { type: 'string' }, description: { type: 'string' },
    }, required: ['id'] },
    handler: async (args: { id: string; label?: string; role?: SequenceParticipant['role']; technology?: string; description?: string }) => {
      const participant = state.diagram.sequence?.participants.find((item) => item.id === args.id);
      if (state.diagram.kind !== 'sequence' || !participant) return toolError('Sequence participant not found.');
      if (args.label !== undefined) {
        if (!args.label.trim()) return toolError('Participant label cannot be empty.');
        participant.label = args.label.trim();
      }
      if (args.role !== undefined) participant.role = args.role;
      if (args.technology !== undefined) participant.technology = args.technology.trim();
      if (args.description !== undefined) participant.description = args.description.trim();
      return { ok: true, participant };
    },
  });

  const deleteSequenceParticipant = defineTool('delete_sequence_participant', {
    description: 'Delete a sequence participant and all messages, activations, and fragments that depend on it.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args: { id: string }) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence?.participants.some((participant) => participant.id === args.id)) return toolError('Sequence participant not found.');
      sequence.participants = sequence.participants.filter((participant) => participant.id !== args.id);
      sequence.messages = sequence.messages.filter((message) => message.fromParticipantId !== args.id && message.toParticipantId !== args.id);
      const messageIds = new Set(sequence.messages.map((message) => message.id));
      sequence.activations = sequence.activations?.filter((activation) => activation.participantId !== args.id && messageIds.has(activation.startMessageId) && messageIds.has(activation.endMessageId));
      sequence.fragments = sequence.fragments?.filter((fragment) => messageIds.has(fragment.startMessageId) && messageIds.has(fragment.endMessageId));
      return { ok: true, deletedParticipantId: args.id, messageCount: sequence.messages.length };
    },
  });

  const addSequenceMessage = defineTool('add_sequence_message', {
    description: 'Add a time-ordered message between two existing sequence participants. The message may be a synchronous call, return, or asynchronous message.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, fromParticipantId: { type: 'string' }, toParticipantId: { type: 'string' },
      label: { type: 'string' }, kind: { type: 'string', enum: ['call','return','async'] }, order: { type: 'number' },
    }, required: ['id','fromParticipantId','toParticipantId','label'] },
    handler: async (args: { id: string; fromParticipantId: string; toParticipantId: string; label: string; kind?: SequenceMessage['kind']; order?: number }) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence) return toolError('Switch to a UML Sequence diagram before adding a message.');
      if (!validId(args.id)) return toolError('Message ID is invalid.');
      if (hasId(state, args.id)) return toolError('That ID already exists. Choose a different ID.');
      if (!args.label.trim()) return toolError('Message label cannot be empty.');
      const participantIds = new Set(sequence.participants.map((participant) => participant.id));
      if (!participantIds.has(args.fromParticipantId) || !participantIds.has(args.toParticipantId)) return toolError('Both source and target participants must exist.');
      const order = args.order ?? Math.max(0, ...sequence.messages.map((message) => message.order)) + 1;
      if (!Number.isInteger(order) || order < 1 || sequence.messages.some((message) => message.order === order)) return toolError('Message order must be a unique positive integer.');
      const message: SequenceMessage = { id: args.id, fromParticipantId: args.fromParticipantId, toParticipantId: args.toParticipantId, label: args.label.trim(), kind: args.kind ?? 'call', order };
      sequence.messages.push(message);
      return { ok: true, message };
    },
  });

  const updateSequenceMessage = defineTool('update_sequence_message', {
    description: 'Edit a sequence message label, source/target participant, type, or order.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' }, fromParticipantId: { type: 'string' }, toParticipantId: { type: 'string' },
      kind: { type: 'string', enum: ['call','return','async'] }, order: { type: 'number' },
    }, required: ['id'] },
    handler: async (args: { id: string; label?: string; fromParticipantId?: string; toParticipantId?: string; kind?: SequenceMessage['kind']; order?: number }) => {
      const sequence = state.diagram.sequence;
      const message = sequence?.messages.find((item) => item.id === args.id);
      if (state.diagram.kind !== 'sequence' || !sequence || !message) return toolError('Sequence message not found.');
      const participants = new Set(sequence.participants.map((participant) => participant.id));
      if (args.fromParticipantId && !participants.has(args.fromParticipantId)) return toolError('Source participant not found.');
      if (args.toParticipantId && !participants.has(args.toParticipantId)) return toolError('Target participant not found.');
      if (args.label !== undefined) {
        if (!args.label.trim()) return toolError('Message label cannot be empty.');
        message.label = args.label.trim();
      }
      if (args.fromParticipantId) message.fromParticipantId = args.fromParticipantId;
      if (args.toParticipantId) message.toParticipantId = args.toParticipantId;
      if (args.kind) message.kind = args.kind;
      if (args.order !== undefined) {
        if (!Number.isInteger(args.order) || args.order < 1 || sequence.messages.some((other) => other.id !== message.id && other.order === args.order)) return toolError('Message order must be a unique positive integer.');
        message.order = args.order;
        state.diagram.sequence = normalizeSequenceRanges(sequence);
        return { ok: true, message: state.diagram.sequence.messages.find((item) => item.id === message.id) };
      }
      return { ok: true, message };
    },
  });

  const deleteSequenceMessage = defineTool('delete_sequence_message', {
    description: 'Delete a sequence message and any activation or fragment whose bounds refer to it.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args: { id: string }) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence?.messages.some((message) => message.id === args.id)) return toolError('Sequence message not found.');
      sequence.messages = sequence.messages.filter((message) => message.id !== args.id);
      const ids = new Set(sequence.messages.map((message) => message.id));
      sequence.activations = sequence.activations?.filter((activation) => ids.has(activation.startMessageId) && ids.has(activation.endMessageId));
      sequence.fragments = sequence.fragments?.filter((fragment) => ids.has(fragment.startMessageId) && ids.has(fragment.endMessageId));
      return { ok: true, deletedMessageId: args.id, messageCount: sequence.messages.length };
    },
  });

  const addSequenceActivation = defineTool('add_sequence_activation', {
    description: 'Create an activation bar for a participant across an inclusive, chronological range of sequence messages.',
    parameters: { type: 'object', properties: {
      participantId: { type: 'string' }, startMessageId: { type: 'string' }, endMessageId: { type: 'string' },
    }, required: ['participantId','startMessageId','endMessageId'] },
    handler: async (args: SequenceActivation) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence) return toolError('Switch to a UML Sequence diagram before adding an activation.');
      const issue = sequenceActivationIssue(sequence, args);
      if (issue) return toolError(issue);
      sequence.activations ??= [];
      sequence.activations.push({ ...args });
      return { ok: true, activation: args };
    },
  });

  const updateSequenceActivation = defineTool('update_sequence_activation', {
    description: 'Change the participant or inclusive message range of an existing activation bar.',
    parameters: { type: 'object', properties: {
      participantId: { type: 'string' }, startMessageId: { type: 'string' }, endMessageId: { type: 'string' },
      newParticipantId: { type: 'string' }, newStartMessageId: { type: 'string' }, newEndMessageId: { type: 'string' },
    }, required: ['participantId','startMessageId','endMessageId'] },
    handler: async (args: { participantId: string; startMessageId: string; endMessageId: string; newParticipantId?: string; newStartMessageId?: string; newEndMessageId?: string }) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence?.activations) return toolError('Switch to a UML Sequence diagram before editing an activation.');
      const currentKey = sequenceActivationKey(args);
      const index = sequence.activations.findIndex((activation) => sequenceActivationKey(activation) === currentKey);
      if (index < 0) return toolError('Sequence activation not found.');
      const current = sequence.activations[index];
      const next: SequenceActivation = {
        participantId: args.newParticipantId ?? current.participantId,
        startMessageId: args.newStartMessageId ?? current.startMessageId,
        endMessageId: args.newEndMessageId ?? current.endMessageId,
      };
      const issue = sequenceActivationIssue(sequence, next, currentKey);
      if (issue) return toolError(issue);
      sequence.activations[index] = next;
      return { ok: true, activation: next };
    },
  });

  const deleteSequenceActivation = defineTool('delete_sequence_activation', {
    description: 'Delete an activation by its participant and message range.',
    parameters: { type: 'object', properties: {
      participantId: { type: 'string' }, startMessageId: { type: 'string' }, endMessageId: { type: 'string' },
    }, required: ['participantId','startMessageId','endMessageId'] },
    handler: async (args: SequenceActivation) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence?.activations) return toolError('Switch to a UML Sequence diagram before deleting an activation.');
      const key = sequenceActivationKey(args);
      const index = sequence.activations.findIndex((activation) => sequenceActivationKey(activation) === key);
      if (index < 0) return toolError('Sequence activation not found.');
      const [deleted] = sequence.activations.splice(index, 1);
      return { ok: true, deletedActivation: deleted };
    },
  });

  const addSequenceFragment = defineTool('add_sequence_fragment', {
    description: 'Add a UML sequence fragment frame (alt, opt, loop, or par) around an inclusive range of messages, optionally with a guard condition.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, kind: { type: 'string', enum: ['alt','opt','loop','par'] }, title: { type: 'string' }, guard: { type: 'string' },
      startMessageId: { type: 'string' }, endMessageId: { type: 'string' }, participantStartId: { type: 'string' }, participantEndId: { type: 'string' },
    }, required: ['id','kind','title','startMessageId','endMessageId'] },
    handler: async (args: { id: string; kind: SequenceFragment['kind']; title: string; guard?: string; startMessageId: string; endMessageId: string; participantStartId?: string; participantEndId?: string }) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence) return toolError('Switch to a UML Sequence diagram before adding a fragment.');
      if (!validId(args.id) || hasId(state, args.id)) return toolError('Fragment ID is invalid or already used.');
      if (!args.title.trim()) return toolError('Fragment title cannot be empty.');
      const messages = [...sequence.messages].sort((a, b) => a.order - b.order);
      const start = messages.findIndex((message) => message.id === args.startMessageId);
      const end = messages.findIndex((message) => message.id === args.endMessageId);
      if (start < 0 || end < 0 || start > end) return toolError('Fragment start/end must reference messages in chronological order.');
      const participants = new Set(sequence.participants.map((participant) => participant.id));
      if (args.participantStartId && !participants.has(args.participantStartId)) return toolError('Fragment start participant not found.');
      if (args.participantEndId && !participants.has(args.participantEndId)) return toolError('Fragment end participant not found.');
      const fragment: SequenceFragment = { id: args.id, kind: args.kind, title: args.title.trim(), startMessageId: args.startMessageId, endMessageId: args.endMessageId, ...(args.guard?.trim() ? { guard: args.guard.trim() } : {}), ...(args.participantStartId ? { participantStartId: args.participantStartId } : {}), ...(args.participantEndId ? { participantEndId: args.participantEndId } : {}) };
      (sequence.fragments ??= []).push(fragment);
      return { ok: true, fragment };
    },
  });

  const deleteSequenceFragment = defineTool('delete_sequence_fragment', {
    description: 'Delete a UML sequence fragment by ID.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (args: { id: string }) => {
      const sequence = state.diagram.sequence;
      if (state.diagram.kind !== 'sequence' || !sequence?.fragments?.some((fragment) => fragment.id === args.id)) return toolError('Sequence fragment not found.');
      sequence.fragments = sequence.fragments.filter((fragment) => fragment.id !== args.id);
      return { ok: true, deletedFragmentId: args.id };
    },
  });

    return [setDiagramKind,addNode,updateNode,removeNode,addRelation,updateRelation,removeRelation,addSequenceParticipant,updateSequenceParticipant,deleteSequenceParticipant,addSequenceMessage,updateSequenceMessage,deleteSequenceMessage,addSequenceActivation,updateSequenceActivation,deleteSequenceActivation,addSequenceFragment,deleteSequenceFragment,setTitle,requestLayout];
}

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'1mb'}));
app.get('/api/health',(_req,res)=>res.json({ok:true,provider:'copilot-sdk',model:MODEL,connected:!!client}));

app.get('/api/diagram',(_req,res)=>{
  res.json({diagram:sharedDiagram??null,revision:diagramRevision,layoutRequestId});
});

app.put('/api/diagram',(req,res)=>{
  const incoming=req.body?.diagram as DiagramDocument|undefined;
  const expectedRevision=Number(req.body?.expectedRevision);
  if(!incoming||incoming.schemaVersion!==1||!Array.isArray(incoming.nodes)||!Array.isArray(incoming.relations)||!incoming.layout||typeof incoming.layout!=='object')
    return res.status(400).json({error:'Invalid diagram document.'});
  const errors=validateDiagram(incoming).filter((issue)=>issue.severity==='error');
  if(errors.length)return res.status(400).json({error:'Diagram is invalid: '+errors.map((issue)=>issue.message).join(' ')});
  if(Number.isFinite(expectedRevision)&&expectedRevision!==diagramRevision)
    return res.status(409).json({error:'Diagram changed in another client.',revision:diagramRevision});
  const traceId=crypto.randomUUID();
  recordTrace('browser-editor','diagram.snapshot_save_started',{expectedRevision,nodeCount:incoming.nodes.length,relationCount:incoming.relations.length},{traceId,category:'diagram',status:'started'});
  const previousDiagram=sharedDiagram;
  const previousRevision=diagramRevision;
  sharedDiagram=structuredClone(incoming);
  diagramRevision+=1;
  try { persistStore(); } catch (error) { sharedDiagram=previousDiagram; diagramRevision=previousRevision; throw error; }
  recordTrace('browser-editor','diagram.snapshot_saved',{revision:diagramRevision,nodeCount:incoming.nodes.length,relationCount:incoming.relations.length},{traceId,category:'diagram',status:'completed'});
  return res.json({ok:true,revision:diagramRevision});
});

app.get('/api/diagram/validate',(_req,res)=>{
  if(!sharedDiagram)return res.status(409).json({error:'No active diagram. Open Architecture Diagram Studio in a browser first.'});
  return res.json({valid:validateDiagram(sharedDiagram).every((issue)=>issue.severity!=='error'),issues:validateDiagram(sharedDiagram)});
});

app.use('/api/diagram/mutate',(req,res,next)=>{
  const traceId=crypto.randomUUID();
  try {
    recordTrace('vscode-mcp','mcp.tool.started',{operation:req.body?.operation,args:req.body?.args},{traceId,category:'mcp-tool',status:'started'});
    res.on('finish',()=>{
      if(res.statusCode<400)return;
      try {
        recordTrace('vscode-mcp','mcp.tool.failed',{operation:req.body?.operation,statusCode:res.statusCode},{traceId,category:'mcp-tool',status:'failed'});
      } catch (error) {
        console.error('[architecture-diagram-studio] Could not persist the MCP failure outcome.',error);
      }
    });
    (req as typeof req & {traceId?:string}).traceId=traceId;
    next();
  } catch (error) {
    console.error('[architecture-diagram-studio] Could not persist MCP audit start.',error);
    res.status(500).json({error:'The operation was not run because its audit record could not be saved.'});
  }
});

app.post('/api/diagram/mutate',(req,res)=>{
  if(!sharedDiagram)return res.status(409).json({error:'No active diagram. Open Architecture Diagram Studio in a browser first.'});
  const operation=typeof req.body?.operation==='string'?req.body.operation:'';
  const args=req.body?.args&&typeof req.body.args==='object'?req.body.args as Record<string,unknown>:{};
  const previousDiagram=sharedDiagram;
  const previousRevision=diagramRevision;
  const previousLayoutRequestId=layoutRequestId;
  let draft=structuredClone(sharedDiagram);
  const stringArg=(key:string)=>typeof args[key]==='string'?args[key] as string:undefined;
  const id=stringArg('id');
  const nodeTypes=['person','system','service','component','database','external','boundary'];
  const relationKinds=['sync','async','data'];
  const hasAnyId=(candidate:string)=>draft.nodes.some((node)=>node.id===candidate)||draft.relations.some((relation)=>relation.id===candidate)||(draft.boundaries??[]).some((boundary)=>boundary.id===candidate)||(draft.sequence?.participants??[]).some((participant)=>participant.id===candidate)||(draft.sequence?.messages??[]).some((message)=>message.id===candidate)||(draft.sequence?.fragments??[]).some((fragment)=>fragment.id===candidate);
  let result:unknown;
  const genericGraphOperations=new Set(['add_node','update_node','delete_node','add_relation','update_relation','delete_relation']);
  const sequenceOperations=new Set(['add_sequence_participant','update_sequence_participant','delete_sequence_participant','add_sequence_message','update_sequence_message','delete_sequence_message','add_sequence_activation','update_sequence_activation','delete_sequence_activation','add_sequence_fragment','delete_sequence_fragment']);
  if(draft.kind==='sequence'&&genericGraphOperations.has(operation))return res.status(409).json({error:'The active diagram is UML Sequence. Use sequence participant/message/fragment operations, or switch diagram kind first.'});
  if(draft.kind!=='sequence'&&sequenceOperations.has(operation))return res.status(409).json({error:'Sequence operations require a UML Sequence diagram. Switch diagram kind first.'});
  switch(operation){
    case 'set_diagram_kind': {
      const kind=stringArg('kind');
      const kinds:DiagramKind[]=['c4-context','c4-container','c4-component','sequence'];
      if(!kind||!kinds.includes(kind as DiagramKind))return res.status(400).json({error:'Unsupported diagram kind.'});
      const title=stringArg('title')?.trim();
      if(draft.kind===kind){if(title)draft.title=title.slice(0,200);result={kind:draft.kind,title:draft.title,unchanged:true};break;}
      draft=createDiagramTemplate(kind as DiagramKind);
      if(title)draft.title=title.slice(0,200);
      result={kind:draft.kind,title:draft.title,nodeCount:draft.nodes.length,participantCount:draft.sequence?.participants.length??0};
      break;
    }
    case 'add_sequence_participant': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before adding a participant.'});
      const label=stringArg('label')?.trim();const role=stringArg('role');const technology=stringArg('technology')?.trim();const description=stringArg('description')?.trim();
      const roles:SequenceParticipant['role'][]=['actor','system','container','database','external'];
      if(!id||!ID_PATTERN.test(id)||hasAnyId(id))return res.status(400).json({error:'Participant ID is invalid or already used.'});
      if(!label||!role||!roles.includes(role as SequenceParticipant['role']))return res.status(400).json({error:'Participant label and supported role are required.'});
      const participant:SequenceParticipant={id,label,role:role as SequenceParticipant['role'],...(technology?{technology}:{}),...(description?{description}:{})};
      draft.sequence.participants.push(participant);result={participant,participantIndex:draft.sequence.participants.length-1};break;
    }
    case 'update_sequence_participant': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before editing a participant.'});
      const participant=draft.sequence.participants.find(item=>item.id===id);if(!participant)return res.status(404).json({error:'Sequence participant not found.'});
      const label=stringArg('label');const role=stringArg('role');const roles:SequenceParticipant['role'][]=['actor','system','container','database','external'];
      if(label!==undefined){if(!label.trim())return res.status(400).json({error:'Participant label cannot be empty.'});participant.label=label.trim();}
      if(role!==undefined){if(!roles.includes(role as SequenceParticipant['role']))return res.status(400).json({error:'Unsupported participant role.'});participant.role=role as SequenceParticipant['role'];}
      if(typeof args.technology==='string')participant.technology=args.technology.trim();
      if(typeof args.description==='string')participant.description=args.description.trim();
      result={participant};break;
    }
    case 'delete_sequence_participant': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before deleting a participant.'});
      if(!id||!draft.sequence.participants.some(item=>item.id===id))return res.status(404).json({error:'Sequence participant not found.'});
      const sequence=draft.sequence;
      sequence.participants=sequence.participants.filter(item=>item.id!==id);
      sequence.messages=sequence.messages.filter(message=>message.fromParticipantId!==id&&message.toParticipantId!==id);
      const liveMessages=new Set(sequence.messages.map(message=>message.id));
      sequence.activations=sequence.activations?.filter(activation=>activation.participantId!==id&&liveMessages.has(activation.startMessageId)&&liveMessages.has(activation.endMessageId));
      sequence.fragments=sequence.fragments?.filter(fragment=>liveMessages.has(fragment.startMessageId)&&liveMessages.has(fragment.endMessageId)&&(!fragment.participantStartId||sequence.participants.some(participant=>participant.id===fragment.participantStartId))&&(!fragment.participantEndId||sequence.participants.some(participant=>participant.id===fragment.participantEndId)));
      result={deletedParticipantId:id,remainingMessages:sequence.messages.length};break;
    }
    case 'add_sequence_message': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before adding a message.'});
      const fromParticipantId=stringArg('fromParticipantId');const toParticipantId=stringArg('toParticipantId');const label=stringArg('label')?.trim();const kind=stringArg('kind')??'call';
      const kinds:SequenceMessage['kind'][]=['call','return','async'];
      if(!id||!ID_PATTERN.test(id)||hasAnyId(id))return res.status(400).json({error:'Message ID is invalid or already used.'});
      if(!fromParticipantId||!toParticipantId||!draft.sequence.participants.some(p=>p.id===fromParticipantId)||!draft.sequence.participants.some(p=>p.id===toParticipantId))return res.status(400).json({error:'Both message endpoints must reference existing participants.'});
      if(!label)return res.status(400).json({error:'Message label cannot be empty.'});
      if(!kinds.includes(kind as SequenceMessage['kind']))return res.status(400).json({error:'Unsupported message kind.'});
      const order=typeof args.order==='number'?args.order:Math.max(0,...draft.sequence.messages.map(message=>message.order))+1;
      if(!Number.isInteger(order)||order<1||draft.sequence.messages.some(message=>message.order===order))return res.status(400).json({error:'Message order must be a unique positive integer.'});
      const message:SequenceMessage={id,fromParticipantId,toParticipantId,label,kind:kind as SequenceMessage['kind'],order};
      draft.sequence.messages.push(message);result={message};break;
    }
    case 'update_sequence_message': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before editing a message.'});
      const message=draft.sequence.messages.find(item=>item.id===id);if(!message)return res.status(404).json({error:'Sequence message not found.'});
      const label=stringArg('label');const from=stringArg('fromParticipantId');const to=stringArg('toParticipantId');const kind=stringArg('kind');
      const kinds:SequenceMessage['kind'][]=['call','return','async'];
      if(label!==undefined){if(!label.trim())return res.status(400).json({error:'Message label cannot be empty.'});message.label=label.trim();}
      if(from!==undefined){if(!draft.sequence.participants.some(item=>item.id===from))return res.status(400).json({error:'Source participant not found.'});message.fromParticipantId=from;}
      if(to!==undefined){if(!draft.sequence.participants.some(item=>item.id===to))return res.status(400).json({error:'Target participant not found.'});message.toParticipantId=to;}
      if(kind!==undefined){if(!kinds.includes(kind as SequenceMessage['kind']))return res.status(400).json({error:'Unsupported message kind.'});message.kind=kind as SequenceMessage['kind'];}
      if(typeof args.order==='number'){
        const order=args.order;
        if(!Number.isInteger(order)||order<1||draft.sequence.messages.some(item=>item.id!==id&&item.order===order))return res.status(400).json({error:'Message order must be a unique positive integer.'});
        message.order=order;
        draft.sequence=normalizeSequenceRanges(draft.sequence);
      }
      result={message:draft.sequence.messages.find(item=>item.id===id)};break;
    }
    case 'delete_sequence_message': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before deleting a message.'});
      if(!id||!draft.sequence.messages.some(item=>item.id===id))return res.status(404).json({error:'Sequence message not found.'});
      const sequence=draft.sequence;sequence.messages=sequence.messages.filter(item=>item.id!==id);
      const liveMessages=new Set(sequence.messages.map(message=>message.id));
      sequence.activations=sequence.activations?.filter(activation=>liveMessages.has(activation.startMessageId)&&liveMessages.has(activation.endMessageId));
      sequence.fragments=sequence.fragments?.filter(fragment=>liveMessages.has(fragment.startMessageId)&&liveMessages.has(fragment.endMessageId));
      result={deletedMessageId:id};break;
    }
    case 'add_sequence_activation': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before adding an activation.'});
      const participantId=stringArg('participantId');const startMessageId=stringArg('startMessageId');const endMessageId=stringArg('endMessageId');
      if(!participantId||!startMessageId||!endMessageId)return res.status(400).json({error:'Participant, start message, and end message are required.'});
      const activation:SequenceActivation={participantId,startMessageId,endMessageId};
      const issue=sequenceActivationIssue(draft.sequence,activation);
      if(issue)return res.status(400).json({error:issue});
      (draft.sequence.activations??=[]).push(activation);result={activation};break;
    }
    case 'update_sequence_activation': {
      if(draft.kind!=='sequence'||!draft.sequence?.activations)return res.status(409).json({error:'Switch to UML Sequence before editing an activation.'});
      const participantId=stringArg('participantId');const startMessageId=stringArg('startMessageId');const endMessageId=stringArg('endMessageId');
      if(!participantId||!startMessageId||!endMessageId)return res.status(400).json({error:'The current activation key is required.'});
      const currentKey=sequenceActivationKey({participantId,startMessageId,endMessageId});
      const index=draft.sequence.activations.findIndex(activation=>sequenceActivationKey(activation)===currentKey);
      if(index<0)return res.status(404).json({error:'Sequence activation not found.'});
      const current=draft.sequence.activations[index];
      const next:SequenceActivation={
        participantId:stringArg('newParticipantId')??current.participantId,
        startMessageId:stringArg('newStartMessageId')??current.startMessageId,
        endMessageId:stringArg('newEndMessageId')??current.endMessageId,
      };
      const issue=sequenceActivationIssue(draft.sequence,next,currentKey);
      if(issue)return res.status(400).json({error:issue});
      draft.sequence.activations[index]=next;result={activation:next};break;
    }
    case 'delete_sequence_activation': {
      if(draft.kind!=='sequence'||!draft.sequence?.activations)return res.status(409).json({error:'Switch to UML Sequence before deleting an activation.'});
      const participantId=stringArg('participantId');const startMessageId=stringArg('startMessageId');const endMessageId=stringArg('endMessageId');
      if(!participantId||!startMessageId||!endMessageId)return res.status(400).json({error:'Participant, start message, and end message are required.'});
      const key=sequenceActivationKey({participantId,startMessageId,endMessageId});
      const index=draft.sequence.activations.findIndex(activation=>sequenceActivationKey(activation)===key);
      if(index<0)return res.status(404).json({error:'Sequence activation not found.'});
      const [deletedActivation]=draft.sequence.activations.splice(index,1);result={deletedActivation};break;
    }
    case 'add_sequence_fragment': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before adding a fragment.'});
      const kind=stringArg('kind');const title=stringArg('title')?.trim();const startMessageId=stringArg('startMessageId');const endMessageId=stringArg('endMessageId');
      const kinds:SequenceFragment['kind'][]=['alt','opt','loop','par'];
      if(!id||!ID_PATTERN.test(id)||hasAnyId(id))return res.status(400).json({error:'Fragment ID is invalid or already used.'});
      if(!kind||!kinds.includes(kind as SequenceFragment['kind'])||!title)return res.status(400).json({error:'Supported fragment kind and non-empty title are required.'});
      const messages=[...draft.sequence.messages].sort((a,b)=>a.order-b.order);
      const start=messages.findIndex(message=>message.id===startMessageId);const end=messages.findIndex(message=>message.id===endMessageId);
      if(start<0||end<start)return res.status(400).json({error:'Fragment start/end must refer to messages in chronological order.'});
      const participantStartId=stringArg('participantStartId');const participantEndId=stringArg('participantEndId');
      if(participantStartId&&!draft.sequence.participants.some(p=>p.id===participantStartId))return res.status(400).json({error:'Fragment start participant not found.'});
      if(participantEndId&&!draft.sequence.participants.some(p=>p.id===participantEndId))return res.status(400).json({error:'Fragment end participant not found.'});
      const fragment:SequenceFragment={id,kind:kind as SequenceFragment['kind'],title,startMessageId:startMessageId!,endMessageId:endMessageId!,...(stringArg('guard')?.trim()?{guard:stringArg('guard')!.trim()}:{}),...(participantStartId?{participantStartId}:{}),...(participantEndId?{participantEndId}:{})};
      (draft.sequence.fragments??=[]).push(fragment);result={fragment};break;
    }
    case 'delete_sequence_fragment': {
      if(draft.kind!=='sequence'||!draft.sequence)return res.status(409).json({error:'Switch to UML Sequence before deleting a fragment.'});
      if(!id||!draft.sequence.fragments?.some(item=>item.id===id))return res.status(404).json({error:'Sequence fragment not found.'});
      draft.sequence.fragments=draft.sequence.fragments.filter(item=>item.id!==id);result={deletedFragmentId:id};break;
    }
    case 'add_node': {
      const type=stringArg('type');const label=stringArg('label');const nodeId=id;
      if(!nodeId||!ID_PATTERN.test(nodeId)||hasAnyId(nodeId))return res.status(400).json({error:'Node ID is invalid or already exists.'});
      if(!label?.trim()||!type||!nodeTypes.includes(type))return res.status(400).json({error:'Node type and non-empty label are required.'});
      const node:DiagramNode={id:nodeId,type:type as DiagramNode['type'],label:label.trim(),...(stringArg('description')?{description:stringArg('description')}:{}),...(stringArg('technology')?{technology:stringArg('technology')}:{})};
      draft.nodes.push(node);const i=draft.nodes.length-1;draft.layout[nodeId]={x:80+(i%4)*260,y:100+Math.floor(i/4)*160,width:220,height:112};Object.assign(draft,addNodeToBoundary(draft,nodeId));result={node};break;
    }
    case 'update_node': {
      const node=draft.nodes.find((item)=>item.id===id);if(!node)return res.status(404).json({error:'Node not found.'});
      const type=stringArg('type');if(type&&!nodeTypes.includes(type))return res.status(400).json({error:'Unsupported node type.'});
      for(const key of ['label','description','technology'] as const)if(typeof args[key]==='string')node[key]=args[key] as string;
      if(type){node.type=type as DiagramNode['type'];Object.assign(draft,syncNodeBoundaryMembership(draft,node.id));}result={node};break;
    }
    case 'delete_node': {
      if(!id||!draft.nodes.some((node)=>node.id===id))return res.status(404).json({error:'Node not found.'});
      Object.assign(draft,removeNodesFromBoundaries({...draft,nodes:draft.nodes.filter((node)=>node.id!==id),relations:draft.relations.filter((relation)=>relation.sourceId!==id&&relation.targetId!==id),layout:Object.fromEntries(Object.entries(draft.layout).filter(([nodeId])=>nodeId!==id))},[id]));result={deletedNodeId:id};break;
    }
    case 'add_relation': {
      const relationId=id;const sourceId=stringArg('sourceId');const targetId=stringArg('targetId');const label=stringArg('label');const kind=stringArg('kind');
      if(!relationId||!ID_PATTERN.test(relationId)||hasAnyId(relationId))return res.status(400).json({error:'Relationship ID is invalid or already exists.'});
      if(!sourceId||!targetId||!draft.nodes.some((node)=>node.id===sourceId)||!draft.nodes.some((node)=>node.id===targetId))return res.status(400).json({error:'Both relationship endpoints must exist.'});
      if(!label?.trim())return res.status(400).json({error:'Relationship label cannot be empty.'});
      if(kind&&!relationKinds.includes(kind))return res.status(400).json({error:'Unsupported relationship kind.'});
      const relation:DiagramRelation={id:relationId,sourceId,targetId,label:label.trim(),...(kind?{kind:kind as DiagramRelation['kind']}:{})};draft.relations.push(relation);result={relation};break;
    }
    case 'update_relation': {
      const relation=draft.relations.find((item)=>item.id===id);if(!relation)return res.status(404).json({error:'Relationship not found.'});
      if(typeof args.label==='string')relation.label=args.label;
      const kind=stringArg('kind');if(kind&&!relationKinds.includes(kind))return res.status(400).json({error:'Unsupported relationship kind.'});
      if(kind)relation.kind=kind as DiagramRelation['kind'];result={relation};break;
    }
    case 'delete_relation': {
      if(!id||!draft.relations.some((relation)=>relation.id===id))return res.status(404).json({error:'Relationship not found.'});
      draft.relations=draft.relations.filter((relation)=>relation.id!==id);result={deletedRelationId:id};break;
    }
    case 'set_title': {
      const title=stringArg('title')?.trim();if(!title)return res.status(400).json({error:'Diagram title cannot be empty.'});
      draft.title=title.slice(0,200);result={title:draft.title};break;
    }
    case 'request_layout': {
      if(draft.kind==='sequence')return res.status(409).json({error:'UML Sequence layout is driven by participant order and message chronology; graph auto-layout is not applicable.'});
      layoutRequestId+=1;result={requested:true,layoutRequestId,reason:stringArg('reason')??'Requested by VS Code Copilot'};break;
    }
    default:return res.status(400).json({error:'Unknown diagram operation.'});
  }
  const errors=validateDiagram(draft).filter((issue)=>issue.severity==='error');
  if(errors.length)return res.status(400).json({error:'Mutation rejected: '+errors.map((issue)=>issue.message).join(' ')});
  if(operation!=='request_layout'){sharedDiagram=draft;diagramRevision+=1;}
  try { persistStore(); }
  catch (error) { sharedDiagram=previousDiagram; diagramRevision=previousRevision; layoutRequestId=previousLayoutRequestId; throw error; }
  recordTrace('vscode-mcp','mcp.tool.completed',{operation,args,result,revision:diagramRevision,layoutRequestId},{traceId:(req as typeof req & {traceId?:string}).traceId,category:'mcp-tool',status:'completed'});
  return res.json({ok:true,operation,revision:diagramRevision,result,layoutRequestId});
});


app.get('/api/chat/history',(req,res)=>{
  const chatSessionId=typeof req.query.chatSessionId==='string'?req.query.chatSessionId:'';
  if(!validId(chatSessionId))return res.status(400).json({error:'Invalid chat session ID.'});
  return res.json({chatSessionId,messages:chatHistories.get(chatSessionId)??[]});
});

app.get('/api/agent/traces',(req,res)=>{
  const chatSessionId=typeof req.query.chatSessionId==='string'?req.query.chatSessionId:'';
  if(!validId(chatSessionId))return res.status(400).json({error:'Invalid chat session ID.'});
  const rawLimit=Number(req.query.limit??200);
  const limit=Number.isFinite(rawLimit)?Math.max(1,Math.min(1000,Math.floor(rawLimit))):200;
  const traceId=typeof req.query.traceId==='string'&&validId(req.query.traceId)?req.query.traceId:undefined;
  return res.json({traces:readAgentTraces([chatSessionId,'vscode-mcp','browser-editor'],limit,traceId)});
});

app.post('/api/chat',async(req,res)=>{
  const prompt=typeof req.body?.prompt==='string'?req.body.prompt.trim():'';
  const chatSessionId=typeof req.body?.chatSessionId==='string'?req.body.chatSessionId:'';
  const incoming=req.body?.diagram as DiagramDocument|undefined;
  if(!prompt) return res.status(400).json({error:'Enter a request for the diagram.'});
  if(prompt.length>MAX_PROMPT_CHARS) return res.status(413).json({error:'Prompt is too long (maximum 12,000 characters).'});
  if(!validId(chatSessionId)) return res.status(400).json({error:'Invalid chat session ID.'});
  if(!incoming||incoming.schemaVersion!==1||!Array.isArray(incoming.nodes)||!Array.isArray(incoming.relations)||!incoming.layout||typeof incoming.layout!=='object') return res.status(400).json({error:'Invalid diagram document.'});
  const incomingErrors=validateDiagram(incoming).filter((issue)=>issue.severity==='error');
  if(incomingErrors.length) return res.status(400).json({error:'Diagram is invalid: '+incomingErrors.map((x)=>x.message).join(' ')});
  const history=Array.isArray(req.body?.history)?req.body.history.filter((m:unknown)=>!!m&&typeof m==='object'&&((m as {role?:unknown}).role==='user'||(m as {role?:unknown}).role==='assistant')&&typeof (m as {content?:unknown}).content==='string').slice(-12) as Array<{role:'user'|'assistant';content:string}>:[];
  const turnId=crypto.randomUUID();
  const traceId=turnId;
  const turnStartedAt=Date.now();
  saveChatMessage(chatSessionId,'user',prompt);
  recordTrace(chatSessionId,'turn.requested',{prompt,diagramRevision,nodes:incoming.nodes.length,relations:incoming.relations.length,model:MODEL},{traceId,turnId,category:'turn',status:'started',provider:'github-copilot-sdk',model:MODEL});
  let managed=sessions.get(chatSessionId);
  const isNewSession=!managed;
  let claimedBusySlot=false;
  if(managed?.busy){recordTrace(chatSessionId,'turn.rejected',{reason:'session_busy'},{traceId,turnId,category:'turn',status:'rejected',provider:'github-copilot-sdk',model:MODEL});return res.status(409).json({error:'This chat is already processing a request.'});}
  try{
    if(!managed){
      let pending=pendingSessions.get(chatSessionId);
      if(!pending){
        pending=(async()=>{
          const state:ChatState={diagram:structuredClone(incoming),requestAutoLayout:false};
          const sdk=await getClient();
          const systemMessage=[
            'You are the architecture-diagram assistant in Architecture Diagram Studio.',
            'Use the supplied diagram tools to make concrete edits when the user asks to change the diagram. Do not merely describe edits.',
            'Only change what the user requested. Preserve existing IDs unless changing them is necessary. Add meaningful labels and descriptions. Every relation endpoint must reference an existing node.',
            'For questions or analysis that do not request a change, answer in natural language and do not mutate the diagram.',
            'The editor supports C4 Context, Container, Component, and UML Sequence views. Use set_diagram_kind when the requested diagram type differs from the active type. C4 edits use diagram node/relation tools; sequence edits use participants, ordered messages, activation-range and fragment tools. Do not put graph nodes or relations into a sequence diagram.',
            'The application has a visual editor and native draw.io exporter. Tool changes are applied to the semantic model and returned to the browser.',
          ].join(' ');
          const session=await sdk.createSession({model:MODEL,streaming:true,systemMessage:{content:systemMessage},availableTools:[],tools:buildTools(state)});
          const traceContext: TraceContext = {traceId:'',turnId:''};
          session.on((event) => {
            if (event.ephemeral || !traceContext.traceId) return;
            try {
              // Record SDK lifecycle/tool events, but never store model reasoning content.
              const data = event.type.toLowerCase().includes('reasoning') ? {contentOmitted:true} : event.data;
              recordTrace(chatSessionId,event.type,data,{...traceContext,category:'copilot-sdk',provider:'github-copilot-sdk',model:MODEL});
            } catch (error) {
              traceContext.failure = error instanceof Error ? error.message : String(error);
              console.error('[architecture-diagram-studio] Agent event could not be persisted; this turn will not be reported as successful.',error);
            }
          });
          const created:ManagedSession={session,state,busy:false,traceContext};
          sessions.set(chatSessionId,created);
          return created;
        })();
        pendingSessions.set(chatSessionId,pending);
      }
      try{managed=await pending;}finally{if(pendingSessions.get(chatSessionId)===pending)pendingSessions.delete(chatSessionId);}
    }
    if(managed.busy) return res.status(409).json({error:'This chat is already processing a request.'});
    managed.busy=true;
    claimedBusySlot=true;
    managed.state.diagram=structuredClone(incoming);
    managed.state.requestAutoLayout=false;
    managed.traceContext.traceId=traceId;
    managed.traceContext.turnId=turnId;
    managed.traceContext.failure=undefined;
    recordTrace(chatSessionId,'turn.execution_started',{diagramRevision},{traceId,turnId,category:'turn',status:'started',provider:'github-copilot-sdk',model:MODEL});
    const promptWithSnapshot=[
      ...(isNewSession&&history.length?['Previous conversation (context only; the current user request below takes precedence):',...history.map((m)=>m.role.toUpperCase()+': '+m.content),''] : []),
      'Current authoritative diagram document (JSON):',
      JSON.stringify(managed.state.diagram),
      '',
      'User request:',
      prompt,
    ].join('\n');
    const result=await managed.session.sendAndWait({prompt:promptWithSnapshot});
    if(managed.traceContext.failure) throw new Error('Agent execution trace could not be saved; this turn is marked incomplete. '+managed.traceContext.failure);
    const errors=ensureValid(managed.state);
    if(errors){const message='Copilot produced an invalid diagram; changes were not applied. '+errors;saveChatMessage(chatSessionId,'assistant',message);recordTrace(chatSessionId,'turn.failed',{error:message,reason:'diagram_validation'},{traceId,turnId,category:'turn',status:'failed',durationMs:Date.now()-turnStartedAt,provider:'github-copilot-sdk',model:MODEL});return res.status(500).json({error:message});}
    const content=(result as {data?:{content?:string}}|undefined)?.data?.content??'Done.';
    const previousDiagram=sharedDiagram;
    const previousRevision=diagramRevision;
    sharedDiagram=structuredClone(managed.state.diagram);
    diagramRevision+=1;
    try { persistStore(); } catch (error) { sharedDiagram=previousDiagram; diagramRevision=previousRevision; throw error; }
    recordTrace(chatSessionId,'diagram.persisted',{revision:diagramRevision,nodeCount:sharedDiagram.nodes.length,relationCount:sharedDiagram.relations.length},{traceId,turnId,category:'diagram',status:'completed',provider:'github-copilot-sdk',model:MODEL});
    saveChatMessage(chatSessionId,'assistant',content);
    recordTrace(chatSessionId,'turn.completed',{content,requestAutoLayout:managed.state.requestAutoLayout,nodeCount:managed.state.diagram.nodes.length,relationCount:managed.state.diagram.relations.length},{traceId,turnId,category:'turn',status:'completed',durationMs:Date.now()-turnStartedAt,provider:'github-copilot-sdk',model:MODEL});
    managed.traceContext.traceId='';managed.traceContext.turnId='';
    return res.json({content,diagram:managed.state.diagram,requestAutoLayout:managed.state.requestAutoLayout,model:MODEL});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    saveChatMessage(chatSessionId,'assistant','I could not complete that request: '+message);
    recordTrace(chatSessionId,'turn.failed',{error:message},{traceId,turnId,category:'turn',status:'failed',durationMs:Date.now()-turnStartedAt,provider:'github-copilot-sdk',model:MODEL});
    return res.status(502).json({error:'Copilot request failed: '+message});
  }finally{
    const current=sessions.get(chatSessionId);
    if(current?.traceContext.turnId===turnId){current.traceContext.traceId='';current.traceContext.turnId='';current.traceContext.failure=undefined;}
    if(claimedBusySlot&&current) current.busy=false;
  }
});

const server=app.listen(PORT,'127.0.0.1',()=>console.log(`[architecture-diagram-studio] API listening on http://127.0.0.1:${PORT}; model=${MODEL}`));
async function shutdown(){server.close();if(client)await client.stop().catch(()=>undefined);process.exit(0);}
process.on('SIGINT',()=>void shutdown());
process.on('SIGTERM',()=>void shutdown());
