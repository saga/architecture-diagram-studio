import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent,type CSSProperties} from 'react';
import {Background,BackgroundVariant,BaseEdge,Controls,EdgeLabelRenderer,Handle,MiniMap,Position,ReactFlow,ReactFlowProvider,applyEdgeChanges,applyNodeChanges,useUpdateNodeInternals,type Connection,type Edge,type EdgeChange,type Node,type NodeChange,type NodeProps,type EdgeProps,MarkerType} from '@xyflow/react';
import {applyLayout,LAYOUT_ENGINES,DEFAULT_LAYOUT_CONFIG,type LayoutConfig,type LayoutDirection,type LayoutEngine} from './layout/layout';
import {initialDiagram,type DiagramDocument,type DiagramKind,type DiagramPortLayout,type DiagramPortSide,type DiagramNode,type SequenceParticipant,type SequenceMessage} from './model/diagram';
import {createDiagramTemplate} from './model/templates';
import {ensureEdgeGeometry,layoutDirectionFor,orthogonalWaypoints,relationPortIds} from './model/routing';
import {validateDiagram} from './model/validate';
import {downloadDrawio} from './export/drawio';
type ChatMessage={id:string;role:'user'|'assistant';content:string};
type AgentTrace={id:string;timestamp:string;sessionId:string;traceId?:string;turnId?:string;sequence?:number;payloadComplete?:boolean;category?:string;type:string;status?:string;durationMs?:number;provider?:string;model?:string;data:unknown};
type VisualStyle='studio'|'editorial'|'midnight'|'blueprint'|'minimal'|'vibrant';
type LayoutVariant={id:string;name:string;config:LayoutConfig};
const DEFAULT_VARIANTS:LayoutVariant[]=[{id:'balanced',name:'Balanced',config:DEFAULT_LAYOUT_CONFIG}];
function normalizeLayoutConfig(value:unknown):LayoutConfig{
 const raw=value&&typeof value==='object'?value as Partial<LayoutConfig>:{};
 return {elk:{...DEFAULT_LAYOUT_CONFIG.elk,...(raw.elk??{})},dagre:{...DEFAULT_LAYOUT_CONFIG.dagre,...(raw.dagre??{})},hierarchy:{...DEFAULT_LAYOUT_CONFIG.hierarchy,...(raw.hierarchy??{})},force:{...DEFAULT_LAYOUT_CONFIG.force,...(raw.force??{})}} as LayoutConfig;
}
function readLayoutVariants():LayoutVariant[]{
 try{
  const raw=window.localStorage.getItem('architecture-diagram-studio.layout-variants.v1');
  if(raw){
   const parsed=JSON.parse(raw) as unknown;
   if(Array.isArray(parsed)){
    const valid=parsed.filter((v):v is LayoutVariant=>!!v&&typeof v==='object'&&typeof (v as LayoutVariant).id==='string'&&typeof (v as LayoutVariant).name==='string'&&!!(v as LayoutVariant).config&&typeof (v as LayoutVariant).config==='object')
      .map(v=>({...v,config:normalizeLayoutConfig(v.config)}));
    if(valid.length)return valid;
   }
  }
 }catch{/* use defaults */}
 return DEFAULT_VARIANTS.map(v=>({...v,config:normalizeLayoutConfig(v.config)}));
}
function reactFlowPosition(side:DiagramPortSide):Position{return side==='LEFT'?Position.Left:side==='RIGHT'?Position.Right:side==='TOP'?Position.Top:Position.Bottom;}
function portStyle(port:DiagramPortLayout):CSSProperties{
 if(port.side==='LEFT')return {left:0,top:port.y};
 if(port.side==='RIGHT')return {left:'100%',top:port.y};
 if(port.side==='TOP')return {left:port.x,top:0};
 return {left:port.x,top:'100%'};
}
type ArchitectureNodeData={label:string;technology?:string;description?:string;nodeType:DiagramNode['type'];ports:DiagramPortLayout[]};
type SequenceParticipantNodeData=SequenceParticipant&{totalHeight:number};
type SequenceParticipantFlowNode=Node<SequenceParticipantNodeData,'sequenceParticipant'>;
type SequenceMessageNodeData=SequenceMessage&{width:number;direction:'forward'|'reverse'|'self'};
type SequenceMessageFlowNode=Node<SequenceMessageNodeData,'sequenceMessage'>;
type SequenceActivationNodeData={participantId:string};
type SequenceActivationFlowNode=Node<SequenceActivationNodeData,'sequenceActivation'>;
type SequenceFragmentNodeData={kind:'alt'|'opt'|'loop'|'par';title:string;guard?:string};
type SequenceFragmentFlowNode=Node<SequenceFragmentNodeData,'sequenceFragment'>;
function c4Stereotype(type:DiagramNode['type']):string{
 switch(type){
  case 'person':return 'Person';
  case 'system':return 'Software System';
  case 'service':return 'Container';
  case 'component':return 'Component';
  case 'database':return 'Container · Database';
  case 'external':return 'Software System · External';
  case 'boundary':return 'System Boundary';
 }
}
function diagramKindLabel(kind:DiagramKind):string{
 if(kind==='c4-context')return 'C4 · System Context';
 if(kind==='c4-container')return 'C4 · Container';
 if(kind==='c4-component')return 'C4 · Component';
 return 'UML · Sequence';
}
type ArchitectureFlowNode=Node<ArchitectureNodeData,'architecture'>;
function ArchitectureNode({id,data}:NodeProps<ArchitectureFlowNode>){
 const updateNodeInternals=useUpdateNodeInternals();
 useEffect(()=>{updateNodeInternals(id);},[id,data.ports,updateNodeInternals]);
 return <>
  {data.ports.map(port=><Handle key={port.id} id={port.id} type={port.id.startsWith('out-')?'source':'target'} position={reactFlowPosition(port.side)} style={portStyle(port)} className="architecture-port" />)}
  <div className={'c4-card c4-card-'+data.nodeType}>
   <span className="c4-stereotype">{c4Stereotype(data.nodeType)}</span>
   <strong className="c4-title">{data.label}</strong>
   {data.technology&&<span className="c4-technology">{data.technology}</span>}
   {data.description&&<span className="c4-description">{data.description}</span>}
  </div>
 </>;
}
function SequenceParticipantNode({data}:NodeProps<SequenceParticipantFlowNode>){
 return <div className="sequence-participant-node" style={{height:data.totalHeight}}>
  <div className={'sequence-participant-head role-'+data.role}>
   <span className="sequence-stereotype">{data.role==='actor'?'Actor':data.role==='external'?'External System':data.role==='database'?'Database':data.role==='system'?'System':'Container'}</span>
   <strong>{data.label}</strong>
   {data.technology&&<small>{data.technology}</small>}
  </div>
  <div className="sequence-lifeline-stem"/>
 </div>;
}
function SequenceActivationNode(){
 return <div className="sequence-activation" aria-hidden="true"/>;
}
function SequenceFragmentNode({data}:NodeProps<SequenceFragmentFlowNode>){
 return <div className={'sequence-fragment fragment-'+data.kind}>
  <span className="sequence-fragment-kind">{data.kind}</span>
  <span className="sequence-fragment-title">{data.title}</span>
  {data.guard&&<span className="sequence-fragment-guard">{data.guard}</span>}
 </div>;
}
function SequenceMessageNode({id,data}:NodeProps<SequenceMessageFlowNode>){
 const markerId='sequence-arrow-'+id.replace(/[^A-Za-z0-9_-]/g,'-');
 const dashed=data.kind==='return';
 const forward=data.direction==='forward';
 const self=data.direction==='self';
 const path=self?'M 8 30 H 48 V 8 H 8':forward?'M 8 30 H '+Math.max(8,data.width-8):'M '+Math.max(8,data.width-8)+' 30 H 8';
 return <div className={'sequence-message sequence-message-'+data.kind}>
  <div className="sequence-message-label">{data.order}. {data.label}</div>
  <svg width={Math.max(18,data.width)} height="40" viewBox={'0 0 '+Math.max(18,data.width)+' 40'} preserveAspectRatio="none" aria-hidden="true">
   <defs><marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L8,4 L0,8 z" fill="currentColor"/></marker></defs>
   <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray={dashed?'5 4':undefined} markerEnd={'url(#'+markerId+')'}/>
  </svg>
 </div>;
}
const nodeTypes={architecture:ArchitectureNode,sequenceParticipant:SequenceParticipantNode,sequenceMessage:SequenceMessageNode,sequenceActivation:SequenceActivationNode,sequenceFragment:SequenceFragmentNode};
function ArchitectureEdge(props:EdgeProps<Edge>){
 const {id,sourceX,sourceY,targetX,targetY,data,markerStart,markerEnd,style,label}=props;
 const routeData=(data??{}) as {waypoints?:Array<{x:number;y:number}>;sourcePortSide?:DiagramPortSide;targetPortSide?:DiagramPortSide};
 const waypoints=Array.isArray(routeData.waypoints)?routeData.waypoints:orthogonalWaypoints(
  {x:sourceX,y:sourceY},{x:targetX,y:targetY},routeData.sourcePortSide??'RIGHT',routeData.targetPortSide??'LEFT',
 );
 const points=[{x:sourceX,y:sourceY},...waypoints,{x:targetX,y:targetY}];
 const path=points.map((point,index)=>(index===0?'M ':' L ')+point.x+' '+point.y).join('');
 let total=0;
 for(let i=1;i<points.length;i++)total+=Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
 let labelX=(sourceX+targetX)/2;let labelY=(sourceY+targetY)/2;let remaining=total/2;
 for(let i=1;i<points.length;i++){
  const from=points[i-1],to=points[i],length=Math.hypot(to.x-from.x,to.y-from.y);
  if(length>=remaining&&length>0){const ratio=remaining/length;labelX=from.x+(to.x-from.x)*ratio;labelY=from.y+(to.y-from.y)*ratio;break;}
  remaining-=length;
 }
 return <>
  <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style}/>
  {label&&<EdgeLabelRenderer><div className="architecture-edge-label nodrag nopan" style={{position:'absolute',transform:'translate(-50%, -50%) translate('+labelX+'px, '+labelY+'px)'}}>{label}</div></EdgeLabelRenderer>}
 </>;
}
const edgeTypes={architecture:ArchitectureEdge};
function sequenceFlowData(doc:DiagramDocument):{nodes:Node[];edges:Edge[]}{
 const sequence=doc.sequence;
 if(!sequence)return {nodes:[],edges:[]};
 const participants=sequence.participants;
 const messages=[...sequence.messages].sort((a,b)=>a.order-b.order);
 const participantWidth=176;
 const participantGap=72;
 const participantLeft=52;
 const headerTop=36;
 const rowTop=156;
 const rowGap=72;
 const messageY=new Map(messages.map((message,index)=>[message.id,rowTop+index*rowGap] as const));
 const participantX=new Map(participants.map((participant,index)=>[participant.id,participantLeft+index*(participantWidth+participantGap)] as const));
 const totalHeight=Math.max(520,rowTop+messages.length*rowGap+76);
 const nodes:Node[]=[];
 participants.forEach(participant=>{
  nodes.push({id:'lifeline-'+participant.id,type:'sequenceParticipant',className:'sequence-participant-node',position:{x:participantX.get(participant.id)!,y:headerTop},style:{width:participantWidth,height:totalHeight-20,pointerEvents:'none'},data:{...participant,totalHeight:totalHeight-20},draggable:false,selectable:false,connectable:false,zIndex:0});
 });
 for(const fragment of sequence.fragments??[]){
  const startIndex=messages.findIndex(message=>message.id===fragment.startMessageId);
  const endIndex=messages.findIndex(message=>message.id===fragment.endMessageId);
  if(startIndex<0||endIndex<startIndex)continue;
  const startParticipant=participantX.get(fragment.participantStartId??participants[0]?.id)??participantLeft;
  const endParticipant=participantX.get(fragment.participantEndId??participants[participants.length-1]?.id)??participantLeft;
  nodes.push({id:'fragment-'+fragment.id,type:'sequenceFragment',className:'sequence-fragment-node',position:{x:startParticipant-18,y:rowTop+startIndex*rowGap-14},style:{width:Math.max(180,endParticipant-startParticipant+participantWidth+36),height:(endIndex-startIndex)*rowGap+58},data:{kind:fragment.kind,title:fragment.title,guard:fragment.guard},draggable:false,selectable:false,connectable:false,zIndex:1});
 }
 for(const activation of sequence.activations??[]){
  const startIndex=messages.findIndex(message=>message.id===activation.startMessageId);
  const endIndex=messages.findIndex(message=>message.id===activation.endMessageId);
  const x=participantX.get(activation.participantId);
  if(startIndex<0||endIndex<startIndex||x===undefined)continue;
  nodes.push({id:'activation-'+activation.participantId+'-'+activation.startMessageId,type:'sequenceActivation',className:'sequence-activation-node',position:{x:x+participantWidth/2-7,y:rowTop+startIndex*rowGap+17},style:{width:14,height:(endIndex-startIndex)*rowGap+18},data:{participantId:activation.participantId},draggable:false,selectable:false,connectable:false,zIndex:2});
 }
 messages.forEach(message=>{
  const fromIndex=participants.findIndex(participant=>participant.id===message.fromParticipantId);
  const toIndex=participants.findIndex(participant=>participant.id===message.toParticipantId);
  if(fromIndex<0||toIndex<0)return;
  const fromCenter=participantX.get(message.fromParticipantId)!+participantWidth/2;
  const toCenter=participantX.get(message.toParticipantId)!+participantWidth/2;
  const isSelf=fromIndex===toIndex;
  const width=isSelf?76:Math.abs(toCenter-fromCenter);
  const x=isSelf?fromCenter-7:Math.min(fromCenter,toCenter);
  nodes.push({id:message.id,type:'sequenceMessage',className:'sequence-message-node',position:{x,y:messageY.get(message.id)!},style:{width:Math.max(18,width),height:40},data:{...message,width:Math.max(18,width),direction:isSelf?'self':fromCenter<toCenter?'forward':'reverse'},draggable:false,selectable:true,connectable:false,zIndex:3});
 });
 return {nodes,edges:[]};
}
function flowData(doc:DiagramDocument,engine:LayoutEngine='elk',config:LayoutConfig=DEFAULT_LAYOUT_CONFIG){
 if(doc.kind==='sequence')return sequenceFlowData(doc);
 const direction=layoutDirectionFor(engine,config);
 const routed=ensureEdgeGeometry(doc,direction);
 const nodes:Node[]=routed.nodes.map(n=>{
  const g=routed.layout[n.id]??{x:50,y:50,width:220,height:112};
  return {id:n.id,position:{x:g.x,y:g.y},style:{width:g.width,height:g.height},data:{label:n.label,technology:n.technology,description:n.description,nodeType:n.type,ports:g.ports??[]},type:'architecture',className:'diagram-node node-'+n.type};
 });
 const edges:Edge[]=routed.relations.map(relation=>{
  const ids=relationPortIds(relation);
  const sourcePort=routed.layout[relation.sourceId]?.ports?.find(port=>port.id===ids.source);
  const targetPort=routed.layout[relation.targetId]?.ports?.find(port=>port.id===ids.target);
  return {id:relation.id,source:relation.sourceId,target:relation.targetId,sourceHandle:ids.source,targetHandle:ids.target,label:relation.label,type:'architecture',markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:'#334e68',strokeWidth:1.5,strokeLinecap:'square',strokeLinejoin:'round'},labelStyle:{fill:'#334e68',fontSize:11},data:{waypoints:relation.waypoints,sourcePortSide:sourcePort?.side,targetPortSide:targetPort?.side}};
 });
 return {nodes,edges};
}
function snapshotFromCanvas(doc:DiagramDocument,nodes:Node[]):DiagramDocument{
 if(doc.kind==='sequence')return doc;
 return {...doc,layout:Object.fromEntries(nodes.map(n=>{
  const prior=doc.layout[n.id]??{x:n.position.x,y:n.position.y,width:180,height:84};
  const ports=(n.data as {ports?:DiagramPortLayout[]}).ports;
  return [n.id,{...prior,x:n.position.x,y:n.position.y,width:Number(n.measured?.width??n.style?.width??prior.width),height:Number(n.measured?.height??n.style?.height??prior.height),...(Array.isArray(ports)?{ports}:{})}];
 }))};
}
function Editor(){
 const [doc,setDoc]=useState<DiagramDocument>(()=>{try{const saved=window.localStorage.getItem('architecture-diagram-studio.document.v1');if(saved){const parsed=JSON.parse(saved) as DiagramDocument;if(parsed.schemaVersion===1&&Array.isArray(parsed.nodes)&&Array.isArray(parsed.relations)&&parsed.layout)return parsed;}}catch{/* Invalid or unavailable local storage falls back to the sample. */}return initialDiagram;});const initial=useMemo(()=>flowData(doc),[]);const [nodes,setNodes]=useState<Node[]>(initial.nodes);const [edges,setEdges]=useState<Edge[]>(initial.edges);
 const [status,setStatus]=useState('Drag nodes to adjust layout, connect handles to add relations, then export.');const [layoutEngine,setLayoutEngine]=useState<LayoutEngine>('elk');const [layoutVariants,setLayoutVariants]=useState<LayoutVariant[]>(readLayoutVariants);const [activeVariantId,setActiveVariantId]=useState(()=>{const variants=readLayoutVariants();try{const saved=window.localStorage.getItem('architecture-diagram-studio.active-layout-variant.v1');if(saved&&variants.some(v=>v.id===saved))return saved;}catch{/* use first available variant */}return variants[0].id;});const [layoutConfig,setLayoutConfig]=useState<LayoutConfig>(()=>layoutVariants.find(v=>v.id===activeVariantId)?.config??DEFAULT_LAYOUT_CONFIG);const [settingsOpen,setSettingsOpen]=useState(false);const [newVariantName,setNewVariantName]=useState('');const [visualStyle,setVisualStyle]=useState<VisualStyle>(()=>{try{const saved=window.localStorage.getItem('architecture-diagram-studio.style.v1');return ['studio','editorial','midnight','blueprint','minimal','vibrant'].includes(saved??'')?saved as VisualStyle:'studio';}catch{return 'studio';}});const [chatInput,setChatInput]=useState('');const [chatBusy,setChatBusy]=useState(false);const [traceOpen,setTraceOpen]=useState(false);const [traceFilter,setTraceFilter]=useState('');const [traceReloadTick,setTraceReloadTick]=useState(0);const [agentTraces,setAgentTraces]=useState<AgentTrace[]>([]);const [selectedSequenceParticipantId,setSelectedSequenceParticipantId]=useState<string|null>(null);const [selectedSequenceMessageId,setSelectedSequenceMessageId]=useState<string|null>(null);const [chatMessages,setChatMessages]=useState<ChatMessage[]>(()=>{try{const raw=window.localStorage.getItem('architecture-diagram-studio.chat.v1');const parsed=raw?JSON.parse(raw):[];return Array.isArray(parsed)?parsed.filter((m)=>m&&typeof m.id==='string'&&(m.role==='user'||m.role==='assistant')&&typeof m.content==='string'):[];}catch{return [];}});const [chatSessionId]=useState(()=>{try{const saved=window.localStorage.getItem('architecture-diagram-studio.chat-session.v1');if(saved&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(saved))return saved;}catch{/* storage may be unavailable */}return 'chat-'+crypto.randomUUID();});const [selectedNodeId,setSelectedNodeId]=useState<string|null>(null);const selectedNode=doc.nodes.find(n=>n.id===selectedNodeId);const [selectedRelationId,setSelectedRelationId]=useState<string|null>(null);const selectedRelation=doc.relations.find(r=>r.id===selectedRelationId);const selectedSequenceParticipant=doc.sequence?.participants.find(p=>p.id===selectedSequenceParticipantId);const selectedSequenceMessage=doc.sequence?.messages.find(m=>m.id===selectedSequenceMessageId);
 useEffect(()=>{try{window.localStorage.setItem('architecture-diagram-studio.style.v1',visualStyle);}catch{/* The visual preference remains active for this tab. */}},[visualStyle]);
 useEffect(()=>{try{window.localStorage.setItem('architecture-diagram-studio.layout-variants.v1',JSON.stringify(layoutVariants));window.localStorage.setItem('architecture-diagram-studio.active-layout-variant.v1',activeVariantId);}catch{setStatus('Layout settings are active in this session, but browser storage is unavailable.');}},[layoutVariants,activeVariantId]);
 const updateLayoutConfig=useCallback((engine:LayoutEngine,key:string,value:number|string)=>{const updated={...layoutConfig,[engine]:{...layoutConfig[engine],[key]:value}} as LayoutConfig;setLayoutConfig(updated);setLayoutVariants(prev=>prev.map(v=>v.id===activeVariantId?{...v,config:updated}:v));},[activeVariantId,layoutConfig]);
 const chooseVariant=useCallback((id:string)=>{const variant=layoutVariants.find(v=>v.id===id);if(!variant)return;setActiveVariantId(id);setLayoutConfig(variant.config);setStatus('Layout variant “'+variant.name+'” selected.');},[layoutVariants]);
 const saveVariant=useCallback(()=>{const name=newVariantName.trim();if(!name){setStatus('Enter a name for the new layout variant.');return;}const id='variant-'+Date.now();const variant={id,name,config:JSON.parse(JSON.stringify(layoutConfig)) as LayoutConfig};setLayoutVariants(prev=>[...prev,variant]);setActiveVariantId(id);setNewVariantName('');setStatus('Saved layout variant “'+name+'”.');},[newVariantName,layoutConfig]);
 const deleteVariant=useCallback(()=>{if(layoutVariants.length<=1){setStatus('Keep at least one layout variant.');return;}const remaining=layoutVariants.filter(v=>v.id!==activeVariantId);setLayoutVariants(remaining);setActiveVariantId(remaining[0].id);setLayoutConfig(remaining[0].config);setStatus('Layout variant deleted.');},[layoutVariants,activeVariantId]);
 const onNodesChange=useCallback((c:NodeChange[])=>{
  const changedNodes=applyNodeChanges(c,nodes);
  const removed=c.filter(change=>change.type==='remove').map(change=>change.id);
  if(!removed.length){
   setNodes(changedNodes);
   const movedIds=new Set(c.filter(change=>change.type==='position').map(change=>change.id));
   if(movedIds.size){
    setDoc(prev=>({...prev,relations:prev.relations.map(relation=>{
     if(!movedIds.has(relation.sourceId)&&!movedIds.has(relation.targetId))return relation;
     const {waypoints:_staleWaypoints,...withoutStaleRoute}=relation;
     return withoutStaleRoute;
    })}));
    setEdges(prev=>prev.map(edge=>movedIds.has(edge.source)||movedIds.has(edge.target)?{...edge,data:{...(edge.data??{}),waypoints:undefined}}:edge));
   }
   return;
  }
  const ids=new Set(removed);
  const current=snapshotFromCanvas(doc,changedNodes);
  const next:DiagramDocument={...current,nodes:current.nodes.filter(n=>!ids.has(n.id)),relations:current.relations.filter(r=>!ids.has(r.sourceId)&&!ids.has(r.targetId)),layout:Object.fromEntries(Object.entries(current.layout).filter(([id])=>!ids.has(id)))};
  const flow=flowData(next,layoutEngine,layoutConfig);
  setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);
  setSelectedNodeId(null);setSelectedRelationId(null);
 },[doc,nodes,layoutEngine,layoutConfig]);
 const onEdgesChange=useCallback((c:EdgeChange[])=>{
  const changedEdges=applyEdgeChanges(c,edges);
  const removed=c.filter(change=>change.type==='remove').map(change=>change.id);
  if(!removed.length){setEdges(changedEdges);return;}
  const ids=new Set(removed);
  const current=snapshotFromCanvas(doc,nodes);
  const next:DiagramDocument={...current,relations:current.relations.filter(r=>!ids.has(r.id))};
  const flow=flowData(next,layoutEngine,layoutConfig);
  setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);
  setSelectedRelationId(currentId=>currentId&&ids.has(currentId)?null:currentId);
 },[doc,nodes,edges,layoutEngine,layoutConfig]);
 const onConnect=useCallback((connection:Connection)=>{if(!connection.source||!connection.target)return;const id='relation-'+crypto.randomUUID();const relation={id,sourceId:connection.source,targetId:connection.target,sourceHandleId:connection.sourceHandle??undefined,targetHandleId:connection.targetHandle??undefined,label:'New relation'};const current=snapshotFromCanvas(doc,nodes);const next=ensureEdgeGeometry({...current,relations:[...current.relations,relation]},layoutDirectionFor(layoutEngine,layoutConfig));const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setStatus('Relation added.');},[doc,nodes,layoutEngine,layoutConfig]);
 const addService=useCallback(()=>{if(doc.kind==='sequence'){const id='participant-'+crypto.randomUUID();const sequence=doc.sequence??{participants:[],messages:[]};const next={...doc,sequence:{...sequence,participants:[...sequence.participants,{id,label:'New Participant',role:'container' as const}]}};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedSequenceParticipantId(id);setSelectedSequenceMessageId(null);setStatus('Participant added. Edit its name in the properties panel.');return;}const id='service-'+crypto.randomUUID();const position={x:80+(nodes.length%4)*250,y:100+Math.floor(nodes.length/4)*160};const item={id,type:(doc.kind==='c4-component'?'component':'service') as const,label:doc.kind==='c4-component'?'New Component':'New Container',technology:'Technology TBD'};const geometry={...position,width:220,height:112};const nextDoc={...doc,nodes:[...doc.nodes,item],layout:{...doc.layout,[id]:geometry}};const next=ensureEdgeGeometry(nextDoc,layoutDirectionFor(layoutEngine,layoutConfig));const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedNodeId(id);setSelectedSequenceParticipantId(null);setSelectedSequenceMessageId(null);setStatus('C4 element added. Select and edit its label below.');},[doc,nodes.length,layoutEngine,layoutConfig]);
 const renameSelectedNode=useCallback((label:string)=>{if(!selectedNodeId)return;setDoc(prev=>({...prev,nodes:prev.nodes.map(n=>n.id===selectedNodeId?{...n,label}:n)}));setNodes(ns=>ns.map(n=>n.id===selectedNodeId?{...n,data:{...n.data,label}}:n));},[selectedNodeId,selectedNode?.technology]);
 const renameSelectedRelation=useCallback((label:string)=>{if(!selectedRelationId)return;setDoc(prev=>({...prev,relations:prev.relations.map(r=>r.id===selectedRelationId?{...r,label}:r)}));setEdges(es=>es.map(e=>e.id===selectedRelationId?{...e,label}:e));},[selectedRelationId]);
 const deleteSelectedRelation=useCallback(()=>{if(!selectedRelationId)return;const current=snapshotFromCanvas(doc,nodes);const next:DiagramDocument={...current,relations:current.relations.filter(r=>r.id!==selectedRelationId)};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedRelationId(null);setStatus('Relation removed.');},[selectedRelationId,doc,nodes,layoutEngine,layoutConfig]);
 const deleteSelectedNode=useCallback(()=>{if(!selectedNodeId)return;const current=snapshotFromCanvas(doc,nodes);const next:DiagramDocument={...current,nodes:current.nodes.filter(n=>n.id!==selectedNodeId),relations:current.relations.filter(r=>r.sourceId!==selectedNodeId&&r.targetId!==selectedNodeId),layout:Object.fromEntries(Object.entries(current.layout).filter(([id])=>id!==selectedNodeId))};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedNodeId(null);setSelectedRelationId(null);setStatus('Node and its relations removed.');},[selectedNodeId,doc,nodes,layoutEngine,layoutConfig]);
 const snapshot=useCallback(():DiagramDocument=>ensureEdgeGeometry(snapshotFromCanvas(doc,nodes),layoutDirectionFor(layoutEngine,layoutConfig)),[doc,nodes,layoutEngine,layoutConfig]);
 const syncRevisionRef=useRef<number|null>(null);
 const lastSyncedDocumentRef=useRef('');
 const lastLayoutRequestIdRef=useRef(0);
 const syncWriteRef=useRef<Promise<void>>(Promise.resolve());
 const syncContextRef=useRef({snapshot:()=>doc,layoutEngine,layoutConfig});
 syncContextRef.current={snapshot,layoutEngine,layoutConfig};
 useEffect(()=>{
  let active=true;
  const synchronize=async()=>{
   try{
    const response=await fetch('/api/diagram');if(!response.ok)return;
    const remote=await response.json() as {diagram:DiagramDocument|null;revision:number;layoutRequestId?:number};if(!active)return;
    if(syncRevisionRef.current===null){
     syncRevisionRef.current=remote.revision;lastLayoutRequestIdRef.current=remote.layoutRequestId??0;
     if(remote.diagram){const serialized=JSON.stringify(remote.diagram);lastSyncedDocumentRef.current=serialized;setDoc(remote.diagram);const flow=flowData(remote.diagram,syncContextRef.current.layoutEngine,syncContextRef.current.layoutConfig);setNodes(flow.nodes);setEdges(flow.edges);setStatus('Synchronized with the local VS Code Copilot bridge.');}
     else{const local=syncContextRef.current.snapshot();const serialized=JSON.stringify(local);const seeded=await fetch('/api/diagram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({diagram:local,expectedRevision:remote.revision})});if(seeded.ok){const saved=await seeded.json() as {revision:number};syncRevisionRef.current=saved.revision;lastSyncedDocumentRef.current=serialized;}}
     return;
    }
    if(!remote.diagram&&syncRevisionRef.current!==null){
     const local=syncContextRef.current.snapshot();const serialized=JSON.stringify(local);
     const seeded=await fetch('/api/diagram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({diagram:local,expectedRevision:remote.revision})});
     if(seeded.ok){const saved=await seeded.json() as {revision:number};syncRevisionRef.current=saved.revision;lastSyncedDocumentRef.current=serialized;}
     return;
    }
    if(remote.revision!==syncRevisionRef.current&&remote.diagram){syncRevisionRef.current=remote.revision;lastSyncedDocumentRef.current=JSON.stringify(remote.diagram);setDoc(remote.diagram);const flow=flowData(remote.diagram,syncContextRef.current.layoutEngine,syncContextRef.current.layoutConfig);setNodes(flow.nodes);setEdges(flow.edges);setStatus('Diagram updated by VS Code Copilot.');}
    if((remote.layoutRequestId??0)>lastLayoutRequestIdRef.current&&remote.diagram){lastLayoutRequestIdRef.current=remote.layoutRequestId??0;const context=syncContextRef.current;const next=await applyLayout(remote.diagram,context.layoutEngine,context.layoutConfig);if(!active)return;const flow=flowData(next,context.layoutEngine,context.layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setStatus('Applied the layout requested by VS Code Copilot.');}
   }catch{/* Keep the editor usable while the local API restarts. */}
  };
  void synchronize();const timer=window.setInterval(()=>void synchronize(),1000);return()=>{active=false;window.clearInterval(timer);};
 },[]);
 useEffect(()=>{
  const serialized=JSON.stringify(snapshot());if(syncRevisionRef.current===null||serialized===lastSyncedDocumentRef.current)return;
  let cancelled=false;
  syncWriteRef.current=syncWriteRef.current.then(async()=>{if(cancelled)return;try{const response=await fetch('/api/diagram',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({diagram:JSON.parse(serialized),expectedRevision:syncRevisionRef.current})});if(response.status===409){syncRevisionRef.current=null;return;}if(!response.ok)return;const saved=await response.json() as {revision:number};syncRevisionRef.current=saved.revision;lastSyncedDocumentRef.current=serialized;}catch{/* A later snapshot retries synchronization. */}});
  return()=>{cancelled=true;};
 },[snapshot]);

 useEffect(()=>{try{window.localStorage.setItem('architecture-diagram-studio.document.v1',JSON.stringify(snapshot()));}catch{setStatus('Layout is active in this session, but browser storage is unavailable.');}},[snapshot]);
 useEffect(()=>{try{window.localStorage.setItem('architecture-diagram-studio.chat.v1',JSON.stringify(chatMessages));window.localStorage.setItem('architecture-diagram-studio.chat-session.v1',chatSessionId);}catch{/* Chat remains usable for this tab when storage is disabled. */}},[chatMessages,chatSessionId]);
 useEffect(()=>{let active=true;void fetch('/api/chat/history?chatSessionId='+encodeURIComponent(chatSessionId)).then(response=>response.ok?response.json():null).then(payload=>{if(!active||!Array.isArray(payload?.messages)||!payload.messages.length)return;setChatMessages(current=>current.length?current:payload.messages.filter((m:unknown)=>!!m&&typeof m==='object'&&typeof (m as ChatMessage).id==='string'&&((m as ChatMessage).role==='user'||(m as ChatMessage).role==='assistant')&&typeof (m as ChatMessage).content==='string').map((m:ChatMessage)=>({id:m.id,role:m.role,content:m.content})));}).catch(()=>undefined);return()=>{active=false;};},[chatSessionId]);
 useEffect(()=>{if(!traceOpen)return;let active=true;const refresh=()=>{void fetch('/api/agent/traces?chatSessionId='+encodeURIComponent(chatSessionId)+'&limit=200').then(response=>response.ok?response.json():null).then(payload=>{if(active&&Array.isArray(payload?.traces))setAgentTraces(payload.traces as AgentTrace[]);}).catch(()=>undefined);};refresh();const timer=window.setInterval(refresh,2000);return()=>{active=false;window.clearInterval(timer);};},[traceOpen,chatSessionId,traceReloadTick]);
 const autoLayout=useCallback(async(engine:LayoutEngine=layoutEngine,source:DiagramDocument=snapshot())=>{
  const selected=LAYOUT_ENGINES.find(item=>item.value===engine);
  setStatus('Calculating '+(selected?.label??engine)+' layout…');
  try{
   const next=await applyLayout(source,engine,layoutConfig);
   const flow=flowData(next,engine,layoutConfig);
   setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);
   setStatus((selected?.label??engine)+' layout complete. Review before exporting.');
  }catch(e){setStatus('Layout failed: '+(e instanceof Error?e.message:String(e)));}
 },[layoutEngine,snapshot,layoutConfig]);
 const submitChat=useCallback(async(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const prompt=chatInput.trim();if(!prompt||chatBusy)return;setChatInput('');setChatBusy(true);setChatMessages(prev=>[...prev,{id:crypto.randomUUID(),role:'user',content:prompt}]);try{const response=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chatSessionId,prompt,diagram:snapshot(),history:chatMessages.slice(-12).map(({role,content})=>({role,content}))})});const payload=await response.json() as {error?:string;content?:string;diagram?:DiagramDocument;requestAutoLayout?:boolean;model?:string};if(!response.ok)throw new Error(payload.error??'Copilot request failed.');if(!payload.diagram)throw new Error('Copilot response did not include a diagram snapshot.');let next=payload.diagram;if(payload.requestAutoLayout)next=await applyLayout(next,layoutEngine,layoutConfig);const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setStatus('Copilot updated the diagram. Review the changes before exporting.');setChatMessages(prev=>[...prev,{id:crypto.randomUUID(),role:'assistant',content:payload.content??'Diagram updated.'}]);}catch(error){const message=error instanceof Error?error.message:String(error);setChatMessages(prev=>[...prev,{id:crypto.randomUUID(),role:'assistant',content:'I could not complete that request: '+message}]);setStatus('Copilot request failed. Check authentication and the local API server.');}finally{setChatBusy(false);}},[chatInput,chatBusy,chatSessionId,snapshot,chatMessages,layoutEngine,layoutConfig]);
 const exportFile=useCallback(()=>{const current=snapshot();const issues=validateDiagram(current);const errors=issues.filter(issue=>issue.severity==='error');if(errors.length){setStatus('Export blocked: '+errors.map(issue=>issue.message).join(' '));return;}try{downloadDrawio(current);setStatus(issues.length?'Exported with '+issues.length+' validation warning(s).':'Exported draw.io using current node geometry.');}catch(e){setStatus('Export failed: '+(e instanceof Error?e.message:String(e)));}},[snapshot]);
 const resetExample=useCallback(()=>{const next=createDiagramTemplate(doc.kind);setDoc(next);const data=flowData(next,layoutEngine,layoutConfig);setNodes(data.nodes);setEdges(data.edges);setSelectedNodeId(null);setSelectedRelationId(null);setSelectedSequenceMessageId(null);setSelectedSequenceParticipantId(null);setStatus('Restored the '+next.kind+' template.');},[doc.kind,layoutEngine,layoutConfig]);
 const changeDiagramKind=useCallback((kind:DiagramKind)=>{const next=createDiagramTemplate(kind);const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedNodeId(null);setSelectedRelationId(null);setSelectedSequenceMessageId(null);setSelectedSequenceParticipantId(null);setSettingsOpen(false);setStatus('Loaded '+kind+' template.');},[layoutEngine,layoutConfig]);
 const renameSequenceParticipant=useCallback((participantId:string,label:string)=>{const next={...doc,sequence:doc.sequence?{...doc.sequence,participants:doc.sequence.participants.map(p=>p.id===participantId?{...p,label}:p)}:undefined};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);},[doc,layoutEngine,layoutConfig]);
 const deleteSequenceParticipant=useCallback(()=>{if(!selectedSequenceParticipantId||!doc.sequence)return;const sequence={...doc.sequence,participants:doc.sequence.participants.filter(p=>p.id!==selectedSequenceParticipantId),messages:doc.sequence.messages.filter(m=>m.fromParticipantId!==selectedSequenceParticipantId&&m.toParticipantId!==selectedSequenceParticipantId)};const messageIds=new Set(sequence.messages.map(m=>m.id));sequence.activations=sequence.activations?.filter(a=>a.participantId!==selectedSequenceParticipantId&&messageIds.has(a.startMessageId)&&messageIds.has(a.endMessageId));sequence.fragments=sequence.fragments?.filter(f=>messageIds.has(f.startMessageId)&&messageIds.has(f.endMessageId));const next={...doc,sequence};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedSequenceParticipantId(null);setSelectedSequenceMessageId(null);setStatus('Participant and its messages removed.');},[selectedSequenceParticipantId,doc,layoutEngine,layoutConfig]);
 const renameSequenceMessage=useCallback((messageId:string,label:string)=>{const next={...doc,sequence:doc.sequence?{...doc.sequence,messages:doc.sequence.messages.map(m=>m.id===messageId?{...m,label}:m)}:undefined};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);},[doc,layoutEngine,layoutConfig]);
 const updateSequenceMessageKind=useCallback((messageId:string,kind:SequenceMessage['kind'])=>{const next={...doc,sequence:doc.sequence?{...doc.sequence,messages:doc.sequence.messages.map(m=>m.id===messageId?{...m,kind}:m)}:undefined};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);},[doc,layoutEngine,layoutConfig]);
 const addSequenceMessage=useCallback(()=>{const sequence=doc.sequence;if(doc.kind!=='sequence'||!sequence||sequence.participants.length<2){setStatus('Add at least two participants before adding a message.');return;}const ordered=[...sequence.messages].sort((a,b)=>a.order-b.order);const previous=ordered[ordered.length-1];const from=sequence.participants.find(p=>p.id===previous?.toParticipantId)??sequence.participants[0];const to=sequence.participants.find(p=>p.id!==from.id)??sequence.participants[1];const message:SequenceMessage={id:'msg-'+crypto.randomUUID(),fromParticipantId:from.id,toParticipantId:to.id,label:'New message',kind:'call',order:Math.max(0,...ordered.map(m=>m.order))+1};const next={...doc,sequence:{...sequence,messages:[...sequence.messages,message]}};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedSequenceMessageId(message.id);setSelectedSequenceParticipantId(null);setStatus('Message added at the end of the sequence.');},[doc,layoutEngine,layoutConfig]);
 const deleteSequenceMessage=useCallback(()=>{if(!selectedSequenceMessageId||!doc.sequence)return;const sequence={...doc.sequence,messages:doc.sequence.messages.filter(m=>m.id!==selectedSequenceMessageId),activations:doc.sequence.activations?.filter(a=>a.startMessageId!==selectedSequenceMessageId&&a.endMessageId!==selectedSequenceMessageId),fragments:doc.sequence.fragments?.filter(f=>f.startMessageId!==selectedSequenceMessageId&&f.endMessageId!==selectedSequenceMessageId)};const next={...doc,sequence};const flow=flowData(next,layoutEngine,layoutConfig);setDoc(next);setNodes(flow.nodes);setEdges(flow.edges);setSelectedSequenceMessageId(null);setStatus('Sequence message removed.');},[selectedSequenceMessageId,doc,layoutEngine,layoutConfig]);
 const currentDirection:LayoutDirection=layoutEngine==='elk'?layoutConfig.elk.direction:layoutEngine==='hierarchy'?layoutConfig.hierarchy.direction:layoutEngine==='dagre'?({LR:'RIGHT',RL:'LEFT',TB:'DOWN',BT:'UP'} as const)[layoutConfig.dagre.direction]:'RIGHT';
 const changeDirection=(direction:LayoutDirection)=>{if(layoutEngine==='elk')updateLayoutConfig('elk','direction',direction);else if(layoutEngine==='hierarchy')updateLayoutConfig('hierarchy','direction',direction);else if(layoutEngine==='dagre')updateLayoutConfig('dagre','direction',({RIGHT:'LR',LEFT:'RL',DOWN:'TB',UP:'BT'} as const)[direction]);};
 const directionOptions=[{value:'RIGHT',label:'Left to right'},{value:'LEFT',label:'Right to left'},{value:'DOWN',label:'Top to bottom'},{value:'UP',label:'Bottom to top'}] as const;
 const filteredAgentTraces=agentTraces.filter(item=>[item.type,item.status,item.category,item.provider,item.model,item.traceId,item.turnId,JSON.stringify(item.data)].filter(Boolean).join(' ').toLowerCase().includes(traceFilter.toLowerCase()));
 const traceCount=new Set(agentTraces.map(item=>item.traceId??item.sessionId)).size;
 if(traceOpen)return <main className={'app-shell trace-app theme-'+visualStyle}>
  <header className="trace-topbar"><div className="topbar-brand-row"><div className="brand-mark">AD</div><div className="brand-copy"><strong>Agent execution trace</strong><span>Durable event ledger · current chat session</span></div><div className="topbar-spacer"/><button type="button" className="secondary-button" onClick={()=>setTraceOpen(false)}>← Back to Studio</button></div></header>
  <section className="trace-page">
   <div className="trace-page-heading"><div><h1>Agent execution trace</h1><p>Inspect recorded turns, tool calls, provider details, timing and payloads. The ledger refreshes automatically while this page is open.</p></div><button type="button" className="secondary-button" onClick={()=>setTraceReloadTick(value=>value+1)}>Refresh now</button></div>
   <div className="trace-summary-grid"><div className="trace-summary-card"><span>Recorded events</span><strong>{agentTraces.length}</strong></div><div className="trace-summary-card"><span>Trace groups</span><strong>{traceCount}</strong></div><div className="trace-summary-card"><span>Chat session</span><strong className="trace-session-id">{chatSessionId}</strong></div></div>
   <div className="trace-toolbar"><input type="search" value={traceFilter} onChange={event=>setTraceFilter(event.target.value)} placeholder="Filter by event type, provider, trace ID, or payload…"/><span>{filteredAgentTraces.length} of {agentTraces.length} events</span></div>
   {filteredAgentTraces.length===0?<div className="trace-empty">{agentTraces.length===0?'No trace events have been recorded for this chat session yet. Submit a Copilot request in Studio to create the first trace.':'No trace events match this filter.'}</div>:<div className="trace-event-list">{filteredAgentTraces.slice().reverse().map(item=><details className="trace-event" key={item.id}><summary><time>{new Date(item.timestamp).toLocaleString()}</time><span className="trace-event-type">{item.type}</span><span className="trace-event-meta">{item.durationMs===undefined?'—':item.durationMs+' ms'}{item.model?' · '+item.model:''}{item.provider?' · '+item.provider:''}</span><span className={'trace-event-status status-'+(item.status??'recorded')}>{item.status??'recorded'}</span></summary><div className="trace-event-body"><p className="trace-event-context">Trace: {item.traceId??'legacy'} · Turn: {item.turnId??'—'} · Session: {item.sessionId} · Sequence: {item.sequence??'—'} · Category: {item.category??'—'}{item.payloadComplete===false?' · Payload incomplete':''}</p><pre>{JSON.stringify(item.data,null,2)}</pre></div></details>)}</div>}
  </section>
 </main>;
 return <main className={'app-shell theme-'+visualStyle}><header className="topbar">
  <div className="topbar-brand-row"><div className="brand-mark">AD</div><div className="brand-copy"><strong>Architecture Diagram Studio</strong><span>Model · Layout · Export</span></div><div className="topbar-spacer"/><button type="button" className="secondary-button" onClick={()=>{setTraceOpen(true);setTraceFilter('');}}>Agent trace ↗</button></div>
  <div className="topbar-controls-row">
   <label className="layout-control-field" htmlFor="diagram-kind-select">Diagram type<select id="diagram-kind-select" className="diagram-kind-select" value={doc.kind} onChange={e=>changeDiagramKind(e.target.value as DiagramKind)}><option value="c4-context">C4 · System Context</option><option value="c4-container">C4 · Container</option><option value="c4-component">C4 · Component</option><option value="sequence">UML · Sequence</option></select></label>
   <button type="button" className="secondary-button" onClick={resetExample}>Reset template</button>
   {doc.kind==='sequence'?<div className="toolbar-group sequence-layout-note" role="status"><span className="toolbar-group-title">SEQUENCE</span><span>Messages flow top to bottom</span></div>:<><div className="toolbar-group layout-control-group" role="group" aria-label="Layout controls"><span className="toolbar-group-title">LAYOUT</span><label className="layout-control-field" htmlFor="layout-engine">Engine<select id="layout-engine" className="layout-select" value={layoutEngine} onChange={e=>setLayoutEngine(e.target.value as LayoutEngine)} title={LAYOUT_ENGINES.find(item=>item.value===layoutEngine)?.hint}>{LAYOUT_ENGINES.map(engine=><option key={engine.value} value={engine.value}>{engine.label}</option>)}</select></label>{layoutEngine!=='force'&&<label className="layout-control-field" htmlFor="layout-direction">Direction<select id="layout-direction" className="layout-select direction-select" value={currentDirection} onChange={e=>changeDirection(e.target.value as LayoutDirection)}>{directionOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}<button type="button" className="secondary-button" onClick={()=>setSettingsOpen(true)}>Advanced</button><button type="button" className="primary-button toolbar-auto-layout" onClick={()=>void autoLayout()}>Auto layout</button></div></>}
   <div className="toolbar-group style-control-group" role="group" aria-label="Editor theme"><span className="toolbar-group-title">THEME</span><label className="layout-control-field" htmlFor="visual-style"><select id="visual-style" className="layout-select visual-style-select" value={visualStyle} onChange={e=>setVisualStyle(e.target.value as VisualStyle)} title="Editor chrome theme"><option value="studio">Studio</option><option value="editorial">Editorial</option><option value="midnight">Midnight</option><option value="blueprint">Blueprint</option><option value="minimal">Minimal Mono</option><option value="vibrant">Vibrant</option></select></label></div>
   <button type="button" className="primary-button" onClick={exportFile}>Export .drawio</button>
  </div>
 </header>
 {settingsOpen&&<div className="settings-backdrop" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)setSettingsOpen(false);}}><section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="layout-settings-title"><header className="settings-heading"><div><span className="eyebrow">LAYOUT CONFIGURATION</span><h2 id="layout-settings-title">Layout settings</h2><p>Configure each engine independently. Settings are stored in this browser and can be saved as reusable variants.</p></div><button className="settings-close" onClick={()=>setSettingsOpen(false)} aria-label="Close settings">×</button></header><div className="variant-toolbar"><label>Active variant<select className="settings-select" value={activeVariantId} onChange={e=>chooseVariant(e.target.value)}>{layoutVariants.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label><button className="secondary-button" onClick={deleteVariant} disabled={layoutVariants.length<=1}>Delete variant</button></div><div className="variant-save"><input className="property-input" value={newVariantName} onChange={e=>setNewVariantName(e.target.value)} placeholder="Name a new variant, e.g. Wide landscape"/><button className="primary-button" onClick={saveVariant} disabled={!newVariantName.trim()}>Save as new variant</button></div><div className="settings-scroll"><section className="engine-settings"><div className="engine-settings-title"><h3>ELK · Algorithms</h3><span>Layered, tree, radial, stress and force; routing settings apply where supported</span></div><div className="settings-grid"><label>Algorithm<select className="settings-input" value={layoutConfig.elk.algorithm} onChange={e=>updateLayoutConfig('elk','algorithm',e.target.value as LayoutConfig['elk']['algorithm'])}><option value="layered">Layered · dependencies</option><option value="mrtree">Mr. Tree · rooted tree</option><option value="radial">Radial · hub and spoke</option><option value="stress">Stress · relationship map</option><option value="force">ELK Force · force-directed</option></select></label><label>Direction<select className="settings-input" value={layoutConfig.elk.direction} onChange={e=>updateLayoutConfig('elk','direction',e.target.value as LayoutConfig['elk']['direction'])}><option value="RIGHT">Left to right</option><option value="LEFT">Right to left</option><option value="DOWN">Top to bottom</option><option value="UP">Bottom to top</option></select></label><label>Node spacing (px)<input className="settings-input" type="number" min="0" max="500" value={layoutConfig.elk.nodeSpacing} onChange={e=>updateLayoutConfig('elk','nodeSpacing',Math.max(0,Number(e.target.value)||0))}/></label><label>Layer spacing (px)<input className="settings-input" type="number" min="0" max="800" value={layoutConfig.elk.layerSpacing} onChange={e=>updateLayoutConfig('elk','layerSpacing',Math.max(0,Number(e.target.value)||0))}/></label><label>Edge routing<select className="settings-input" value={layoutConfig.elk.edgeRouting} onChange={e=>updateLayoutConfig('elk','edgeRouting',e.target.value as LayoutConfig['elk']['edgeRouting'])}><option value="ORTHOGONAL">Orthogonal</option><option value="POLYLINE">Polyline</option><option value="SPLINES">Splines</option></select></label><label>Iterations<input className="settings-input" type="number" min="20" max="3000" step="20" value={layoutConfig.elk.iterations} onChange={e=>updateLayoutConfig('elk','iterations',Math.min(3000,Math.max(20,Math.round(Number(e.target.value)||20))))}/></label><label>Random seed<input className="settings-input" type="number" min="0" max="100000" value={layoutConfig.elk.randomSeed} onChange={e=>updateLayoutConfig('elk','randomSeed',Math.max(0,Math.round(Number(e.target.value)||0)))}/></label></div></section><section className="engine-settings"><div className="engine-settings-title"><h3>Dagre · Directed graph</h3><span>Ranks, separation, and outer margin</span></div><div className="settings-grid"><label>Direction<select className="settings-input" value={layoutConfig.dagre.direction} onChange={e=>updateLayoutConfig('dagre','direction',e.target.value as LayoutConfig['dagre']['direction'])}><option value="LR">Left to right</option><option value="RL">Right to left</option><option value="TB">Top to bottom</option><option value="BT">Bottom to top</option></select></label><label>Node spacing (px)<input className="settings-input" type="number" min="0" max="500" value={layoutConfig.dagre.nodeSpacing} onChange={e=>updateLayoutConfig('dagre','nodeSpacing',Math.max(0,Number(e.target.value)||0))}/></label><label>Layer spacing (px)<input className="settings-input" type="number" min="0" max="800" value={layoutConfig.dagre.layerSpacing} onChange={e=>updateLayoutConfig('dagre','layerSpacing',Math.max(0,Number(e.target.value)||0))}/></label><label>Margin (px)<input className="settings-input" type="number" min="0" max="300" value={layoutConfig.dagre.margin} onChange={e=>updateLayoutConfig('dagre','margin',Math.max(0,Number(e.target.value)||0))}/></label></div></section><section className="engine-settings"><div className="engine-settings-title"><h3>D3 Hierarchy · Tree / forest</h3><span>Sibling spacing, layer spacing and disconnected components</span></div><div className="settings-grid"><label>Direction<select className="settings-input" value={layoutConfig.hierarchy.direction} onChange={e=>updateLayoutConfig('hierarchy','direction',e.target.value as LayoutConfig['hierarchy']['direction'])}><option value="RIGHT">Left to right</option><option value="LEFT">Right to left</option><option value="DOWN">Top to bottom</option><option value="UP">Bottom to top</option></select></label><label>Sibling spacing (px)<input className="settings-input" type="number" min="20" max="800" value={layoutConfig.hierarchy.nodeSpacingX} onChange={e=>updateLayoutConfig('hierarchy','nodeSpacingX',Math.max(20,Number(e.target.value)||20))}/></label><label>Layer spacing (px)<input className="settings-input" type="number" min="20" max="1000" value={layoutConfig.hierarchy.nodeSpacingY} onChange={e=>updateLayoutConfig('hierarchy','nodeSpacingY',Math.max(20,Number(e.target.value)||20))}/></label><label>Component spacing (px)<input className="settings-input" type="number" min="0" max="500" value={layoutConfig.hierarchy.componentSpacing} onChange={e=>updateLayoutConfig('hierarchy','componentSpacing',Math.max(0,Number(e.target.value)||0))}/></label><label>Margin (px)<input className="settings-input" type="number" min="0" max="300" value={layoutConfig.hierarchy.margin} onChange={e=>updateLayoutConfig('hierarchy','margin',Math.max(0,Number(e.target.value)||0))}/></label></div></section><section className="engine-settings"><div className="engine-settings-title"><h3>D3 Force · Force-directed</h3><span>Link forces, repulsion, collision, and convergence budget</span></div><div className="settings-grid"><label>Link distance (px)<input className="settings-input" type="number" min="1" max="1500" value={layoutConfig.force.linkDistance} onChange={e=>updateLayoutConfig('force','linkDistance',Math.max(1,Number(e.target.value)||1))}/></label><label>Link strength (0–1)<input className="settings-input" type="number" min="0" max="1" step=".05" value={layoutConfig.force.linkStrength} onChange={e=>updateLayoutConfig('force','linkStrength',Math.min(1,Math.max(0,Number(e.target.value)||0)))}/></label><label>Repulsion<input className="settings-input" type="number" min="0" max="5000" value={layoutConfig.force.repulsion} onChange={e=>updateLayoutConfig('force','repulsion',Math.max(0,Number(e.target.value)||0))}/></label><label>Collision scale<input className="settings-input" type="number" min=".1" max="3" step=".05" value={layoutConfig.force.collisionScale} onChange={e=>updateLayoutConfig('force','collisionScale',Math.min(3,Math.max(.1,Number(e.target.value)||.1)))}/></label><label>Collision iterations<input className="settings-input" type="number" min="1" max="10" value={layoutConfig.force.collisionIterations} onChange={e=>updateLayoutConfig('force','collisionIterations',Math.min(10,Math.max(1,Math.round(Number(e.target.value)||1))))}/></label><label>Simulation ticks<input className="settings-input" type="number" min="20" max="2000" step="20" value={layoutConfig.force.simulationTicks} onChange={e=>updateLayoutConfig('force','simulationTicks',Math.min(2000,Math.max(20,Math.round(Number(e.target.value)||20))))}/></label><label>Margin (px)<input className="settings-input" type="number" min="0" max="300" value={layoutConfig.force.margin} onChange={e=>updateLayoutConfig('force','margin',Math.max(0,Number(e.target.value)||0))}/></label></div></section></div><footer className="settings-footer"><span>Changes are saved automatically to the active variant. Run Auto layout to apply them to the canvas.</span><button className="primary-button" onClick={()=>{setSettingsOpen(false);void autoLayout();}}>Apply and run layout</button></footer></section></div>}<section className="workspace"><aside className="sidebar"><span className="eyebrow">DIAGRAM</span><h1>{doc.title}</h1><span className="kind-pill">{diagramKindLabel(doc.kind)}</span><div className="sidebar-rule"/>
 <div className="element-heading"><span className="eyebrow">{doc.kind==='sequence'?'PARTICIPANTS':'ELEMENTS'}</span><button className="tiny-button" onClick={addService}>{doc.kind==='sequence'?'+ Participant':'+ Element'}</button></div>
 {doc.kind==='sequence'?(doc.sequence?.participants??[]).map(participant=><div className={'element-row'+(participant.id===selectedSequenceParticipantId?' selected':'')} key={participant.id} onClick={()=>{setSelectedSequenceParticipantId(participant.id);setSelectedSequenceMessageId(null);setSelectedNodeId(null);setSelectedRelationId(null);}} role="button" tabIndex={0}><span className={'element-dot dot-'+(participant.role==='actor'?'person':participant.role==='database'?'database':participant.role==='external'?'external':'service')}/><div><strong>{participant.label}</strong><small>{participant.technology??participant.role}</small></div></div>):doc.nodes.map(n=><div className={'element-row'+(n.id===selectedNodeId?' selected':'')} key={n.id} onClick={()=>{setSelectedNodeId(n.id);setSelectedSequenceParticipantId(null);setSelectedSequenceMessageId(null);setSelectedRelationId(null);}} role="button" tabIndex={0}><span className={'element-dot dot-'+n.type}/><div><strong>{n.label}</strong><small>{n.technology??c4Stereotype(n.type)}</small></div></div>)}
 {selectedNode&&<div className="property-panel"><span className="eyebrow">SELECTED ELEMENT</span><label htmlFor="node-label-input">Name</label><input id="node-label-input" className="property-input" value={selectedNode.label} onChange={e=>renameSelectedNode(e.target.value)}/><button className="danger-button" onClick={deleteSelectedNode}>Delete element</button></div>}
 {selectedSequenceParticipant&&<div className="property-panel"><span className="eyebrow">SEQUENCE PARTICIPANT</span><label htmlFor="participant-label-input">Name</label><input id="participant-label-input" className="property-input" value={selectedSequenceParticipant.label} onChange={e=>renameSequenceParticipant(selectedSequenceParticipant.id,e.target.value)}/><label>Role</label><span className="property-value">{selectedSequenceParticipant.role}</span><button className="danger-button" onClick={deleteSequenceParticipant}>Delete participant and messages</button></div>}
 <div className="relation-list"><div className="element-heading"><span className="eyebrow">{doc.kind==='sequence'?'MESSAGES':'RELATIONSHIPS'}</span><span className="relation-count">{doc.kind==='sequence'?(doc.sequence?.messages.length??0):doc.relations.length}</span>{doc.kind==='sequence'&&<button className="tiny-button" onClick={addSequenceMessage} disabled={(doc.sequence?.participants.length??0)<2}>+ Message</button>}</div>
 {doc.kind==='sequence'?(doc.sequence?.messages??[]).slice().sort((a,b)=>a.order-b.order).map(message=><button key={message.id} className={'relation-row'+(message.id===selectedSequenceMessageId?' selected':'')} onClick={()=>{setSelectedSequenceMessageId(message.id);setSelectedSequenceParticipantId(null);setSelectedNodeId(null);setSelectedRelationId(null);}}><span>{(doc.sequence?.participants.find(p=>p.id===message.fromParticipantId)?.label??message.fromParticipantId)+' → '+(doc.sequence?.participants.find(p=>p.id===message.toParticipantId)?.label??message.toParticipantId)}</span><small>{message.order}. {message.label} · {message.kind}</small></button>):doc.relations.map(r=><button key={r.id} className={'relation-row'+(r.id===selectedRelationId?' selected':'')} onClick={()=>{setSelectedRelationId(r.id);setSelectedNodeId(null);setSelectedSequenceParticipantId(null);setSelectedSequenceMessageId(null);}}><span>{doc.nodes.find(n=>n.id===r.sourceId)?.label??r.sourceId} → {doc.nodes.find(n=>n.id===r.targetId)?.label??r.targetId}</span><small>{r.label}</small></button>)}
 </div>
 {selectedRelation&&<div className="property-panel"><span className="eyebrow">SELECTED RELATION</span><label htmlFor="relation-label-input">Label</label><input id="relation-label-input" className="property-input" value={selectedRelation.label} onChange={e=>renameSelectedRelation(e.target.value)}/><button className="danger-button" onClick={deleteSelectedRelation}>Delete relation</button></div>}
 {selectedSequenceMessage&&<div className="property-panel"><span className="eyebrow">SEQUENCE MESSAGE</span><label htmlFor="sequence-message-label">Message label</label><input id="sequence-message-label" className="property-input" value={selectedSequenceMessage.label} onChange={e=>renameSequenceMessage(selectedSequenceMessage.id,e.target.value)}/><label htmlFor="sequence-message-kind">Message kind</label><select id="sequence-message-kind" className="settings-select" value={selectedSequenceMessage.kind} onChange={e=>updateSequenceMessageKind(selectedSequenceMessage.id,e.target.value as SequenceMessage['kind'])}><option value="call">Synchronous call</option><option value="return">Return message</option><option value="async">Asynchronous message</option></select><button className="danger-button" onClick={deleteSequenceMessage}>Delete message</button></div>}
 <div className="sidebar-note"><strong>{doc.kind==='sequence'?'Time moves downward':'C4 semantic model'}</strong><p>{doc.kind==='sequence'?'Participants run across the top, lifelines run vertically, and message order determines time. Select a message to edit its label.':'Nodes represent C4 elements; relationship labels explain the interaction. Geometry is preserved on export.'}</p></div></aside>
 <section className="canvas-area"><div className="canvas-toolbar"><span><span className="live-dot"/>{doc.kind==="sequence"?"UML SEQUENCE":"C4 ARCHITECTURE"}</span><span>{doc.kind==="sequence"?"Time moves downward · select a message to edit":"Move elements · connect handles · zoom · pan"}</span></div><div className="canvas-frame"><ReactFlow key={doc.kind+'-'+doc.id} nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onNodeClick={(_,node)=>{if(node.type==='sequenceMessage'){setSelectedSequenceMessageId(node.id);setSelectedSequenceParticipantId(null);setSelectedNodeId(null);}else{setSelectedSequenceMessageId(null);setSelectedSequenceParticipantId(null);setSelectedNodeId(node.id);}setSelectedRelationId(null);}} onEdgeClick={(_,edge)=>{setSelectedRelationId(edge.id);setSelectedNodeId(null);setSelectedSequenceMessageId(null);setSelectedSequenceParticipantId(null);}} fitView fitViewOptions={{padding:.18}} minZoom={.2} maxZoom={2}><Background id="minor-grid" variant={BackgroundVariant.Lines} color={visualStyle==='editorial'?"#e0ded9":visualStyle==='midnight'?"#1c2940":visualStyle==='blueprint'?"#c5dce9":visualStyle==='minimal'?"#ededed":visualStyle==='vibrant'?"#f2e5f4":"#f1f1f1"} gap={20} size={1}/><Background id="major-grid" variant={BackgroundVariant.Lines} color={visualStyle==='editorial'?"#c9c5bd":visualStyle==='midnight'?"#293750":visualStyle==='blueprint'?"#9ebbd0":visualStyle==='minimal'?"#d6d6d6":visualStyle==='vibrant'?"#dfc4e9":"#e1e1e1"} gap={100} size={1}/><Controls/><MiniMap pannable zoomable/></ReactFlow></div><footer className="statusbar"><span>{status}</span><span>{doc.kind==="sequence"?(doc.sequence?.participants.length??0)+" participants · "+(doc.sequence?.messages.length??0)+" messages":nodes.length+" elements · "+edges.length+" relationships"}</span></footer></section><aside className="chat-panel"><div className="chat-header"><div><strong>Diagram assistant</strong><span>GitHub Copilot SDK · persistent history</span></div><span className="copilot-mark">✦</span></div><div className="chat-messages">{chatMessages.length===0&&<div className="chat-empty"><div className="chat-empty-icon">✦</div><strong>What would you like to change?</strong><p>Ask Copilot to add services, connect components, rename elements, or explain the current architecture.</p><div className="prompt-examples"><button type="button" onClick={()=>setChatInput("Add a notification service and connect it to the Order API.")}>Add a notification service</button><button type="button" onClick={()=>setChatInput("Explain the current architecture without changing the diagram.")}>Explain this diagram</button><button type="button" onClick={()=>setChatInput("Rename the Order API to Order Management API.")}>Rename the Order API</button></div></div>}{chatMessages.map(m=><div key={m.id} className={"chat-message "+m.role}><div className="chat-message-role">{m.role==='user'?'YOU':'COPILOT'}</div><div className="chat-message-content">{m.content}</div></div>)}{chatBusy&&<div className="chat-thinking"><span className="thinking-dot"/> Copilot is working with the diagram…</div>}</div><form className="chat-composer" onSubmit={submitChat}><textarea value={chatInput} onChange={e=>setChatInput(e.target.value)} placeholder="Describe a change to the diagram…" rows={3} disabled={chatBusy}/><div className="chat-composer-footer"><span>Diagram tools only · no repository access</span><button type="submit" className="chat-send-button" disabled={chatBusy||!chatInput.trim()} aria-label="Send message">{chatBusy?'…':'Send'} <span>↗</span></button></div></form></aside></section></main>;
}
export default function App(){return <ReactFlowProvider><Editor/></ReactFlowProvider>;}