import 'dotenv/config';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { CopilotClient, defineTool } from '@github/copilot-sdk';
import type { CopilotSession } from '@github/copilot-sdk';
import { initialDiagram, type DiagramDocument, type DiagramNode, type DiagramRelation } from '../src/model/diagram.js';
import { validateDiagram } from '../src/model/validate.js';

const PORT = Number(process.env.PORT ?? 3001);
const MODEL = process.env.COPILOT_MODEL?.trim() || 'gpt-5';
const BASE_DIRECTORY = process.env.COPILOT_HOME?.trim() || path.join(homedir(), '.copilot');
const MAX_PROMPT_CHARS = 12_000;
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;

interface ChatState { diagram: DiagramDocument; requestAutoLayout: boolean }
interface ManagedSession { session: CopilotSession; state: ChatState; busy: boolean }
const sessions = new Map<string, ManagedSession>();
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
        ...(process.env.COPILOT_CLI_PATH ? { cliPath: process.env.COPILOT_CLI_PATH } : {}),
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
  return state.diagram.nodes.some((n) => n.id === id) || state.diagram.relations.some((r) => r.id === id);
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
      type: { type: 'string', enum: ['person','system','service','database','external','boundary'], description: 'C4 element type' },
      label: { type: 'string', description: 'Human-readable element name' },
      description: { type: 'string' }, technology: { type: 'string' },
    }, required: ['id','type','label'] },
    handler: async (args: {id:string;type:DiagramNode['type'];label:string;description?:string;technology?:string}) => {
      if (!validId(args.id)) return toolError('ID must start with a letter or number and contain only letters, numbers, _ or - (max 80 characters).');
      if (hasId(state,args.id)) return toolError('That ID already exists. Choose a different ID.');
      if (!args.label.trim()) return toolError('Label cannot be empty.');
      const node: DiagramNode = { id: args.id, type: args.type, label: args.label.trim(),
        ...(args.description ? {description:args.description} : {}), ...(args.technology ? {technology:args.technology} : {}) };
      const i=state.diagram.nodes.length;
      state.diagram.nodes.push(node);
      state.diagram.layout[node.id]={x:80+(i%4)*230,y:100+Math.floor(i/4)*140,width:190,height:84};
      return {ok:true,node};
    },
  });
  const updateNode = defineTool('update_diagram_node', {
    description: 'Update an existing diagram node label, description, or technology. Only supplied fields are changed.',
    parameters: { type: 'object', properties: {
      id:{type:'string'}, label:{type:'string'}, description:{type:'string'}, technology:{type:'string'},
    }, required:['id'] },
    handler: async (args:{id:string;label?:string;description?:string;technology?:string}) => {
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
      if(!state.diagram.nodes.some((n)=>n.id===args.id)) return toolError('Node not found.');
      state.diagram.nodes=state.diagram.nodes.filter((n)=>n.id!==args.id);
      state.diagram.relations=state.diagram.relations.filter((r)=>r.sourceId!==args.id&&r.targetId!==args.id);
      delete state.diagram.layout[args.id];
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
  return [addNode,updateNode,removeNode,addRelation,updateRelation,removeRelation,setTitle,requestLayout];
}

const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'1mb'}));
app.get('/api/health',(_req,res)=>res.json({ok:true,provider:'copilot-sdk',model:MODEL,connected:!!client}));

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
  let managed=sessions.get(chatSessionId);
  if(managed?.busy) return res.status(409).json({error:'This chat is already processing a request.'});
  try{
    if(!managed){
      const state:ChatState={diagram:structuredClone(incoming),requestAutoLayout:false};
      const sdk=await getClient();
      const systemMessage=[
        'You are the architecture-diagram assistant in Architecture Diagram Studio.',
        'Use the supplied diagram tools to make concrete edits when the user asks to change the diagram. Do not merely describe edits.',
        'Only change what the user requested. Preserve existing IDs unless changing them is necessary. Add meaningful labels and descriptions. Every relation endpoint must reference an existing node.',
        'For questions or analysis that do not request a change, answer in natural language and do not mutate the diagram.',
        'The application has a visual editor and native draw.io exporter. Tool changes are applied to the semantic model and returned to the browser.',
      ].join(' ');
      const session=await sdk.createSession({model:MODEL,streaming:true,systemMessage:{content:systemMessage},tools:buildTools(state)});
      managed={session,state,busy:false};
      sessions.set(chatSessionId,managed);
    }
    managed.state.diagram=structuredClone(incoming);
    managed.state.requestAutoLayout=false;
    managed.busy=true;
    const promptWithSnapshot=[
      'Current authoritative diagram document (JSON):',
      JSON.stringify(managed.state.diagram),
      '',
      'User request:',
      prompt,
    ].join('\n');
    const result=await managed.session.sendAndWait({prompt:promptWithSnapshot});
    const errors=ensureValid(managed.state);
    if(errors) return res.status(500).json({error:'Copilot produced an invalid diagram; changes were not applied. '+errors});
    const content=(result as {data?:{content?:string}}|undefined)?.data?.content??'Done.';
    return res.json({content,diagram:managed.state.diagram,requestAutoLayout:managed.state.requestAutoLayout,model:MODEL});
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    return res.status(502).json({error:'Copilot request failed: '+message});
  }finally{
    const current=sessions.get(chatSessionId);
    if(current) current.busy=false;
  }
});

const server=app.listen(PORT,()=>console.log(`[architecture-diagram-studio] API listening on http://127.0.0.1:${PORT}; model=${MODEL}`));
async function shutdown(){server.close();if(client)await client.stop().catch(()=>undefined);process.exit(0);}
process.on('SIGINT',()=>void shutdown());
process.on('SIGTERM',()=>void shutdown());
