import {useCallback,useMemo,useState} from 'react';
import {Background,Controls,MiniMap,ReactFlow,ReactFlowProvider,applyEdgeChanges,applyNodeChanges,type Edge,type Node,type EdgeChange,type NodeChange,MarkerType} from '@xyflow/react';
import ELK from 'elkjs/lib/elk.bundled.js';
import {initialDiagram,type DiagramDocument} from './model/diagram';
import {downloadDrawio} from './export/drawio';
const elk=new ELK();
function flowData(doc:DiagramDocument){
 const nodes:Node[]=doc.nodes.map(n=>{const g=doc.layout[n.id];return {id:n.id,position:{x:g.x,y:g.y},style:{width:g.width,height:g.height},data:{label:<div className="node-label"><strong>{n.label}</strong>{n.technology&&<small>{n.technology}</small>}</div>},type:'default',className:'diagram-node node-'+n.type};});
 const edges:Edge[]=doc.relations.map(e=>({id:e.id,source:e.sourceId,target:e.targetId,label:e.label,type:'smoothstep',markerEnd:{type:MarkerType.ArrowClosed},style:{stroke:'#64748b',strokeWidth:1.5},labelStyle:{fill:'#475569',fontSize:11},labelBgStyle:{fill:'#fff',fillOpacity:.92}}));
 return {nodes,edges};
}
function Editor(){
 const [doc]=useState(initialDiagram);const initial=useMemo(()=>flowData(doc),[]);const [nodes,setNodes]=useState<Node[]>(initial.nodes);const [edges,setEdges]=useState<Edge[]>(initial.edges);
 const [status,setStatus]=useState('Drag nodes to adjust layout, then export an editable draw.io file.');
 const onNodesChange=useCallback((c:NodeChange[])=>setNodes(ns=>applyNodeChanges(c,ns)),[]);
 const onEdgesChange=useCallback((c:EdgeChange[])=>setEdges(es=>applyEdgeChanges(c,es)),[]);
 const snapshot=useCallback(():DiagramDocument=>({...doc,layout:Object.fromEntries(nodes.map(n=>[n.id,{x:n.position.x,y:n.position.y,width:Number(n.measured?.width??n.style?.width??180),height:Number(n.measured?.height??n.style?.height??84)}]))}),[doc,nodes]);
 const autoLayout=useCallback(async()=>{
  setStatus('Calculating layered layout…');
  try{
   const graph={id:doc.id,layoutOptions:{'elk.algorithm':'layered','elk.direction':'RIGHT','elk.spacing.nodeNode':'64','elk.layered.spacing.nodeNodeBetweenLayers':'90'},children:nodes.map(n=>({id:n.id,width:Number(n.style?.width??180),height:Number(n.style?.height??84)})),edges:edges.map(e=>({id:e.id,sources:[e.source],targets:[e.target]}))};
   const result=await elk.layout(graph);const positions=new Map((result.children??[]).map(n=>[n.id,{x:n.x??0,y:n.y??0}]));
   setNodes(ns=>ns.map(n=>({...n,position:positions.get(n.id)??n.position})));setStatus('Auto-layout complete. Review before exporting.');
  }catch(e){setStatus('Layout failed: '+(e instanceof Error?e.message:String(e)));}
 },[doc.id,edges,nodes]);
 const exportFile=useCallback(()=>{downloadDrawio(snapshot());setStatus('Exported draw.io using current node geometry.');},[snapshot]);
 return <main className="app-shell"><header className="topbar"><div className="brand-mark">AD</div><div className="brand-copy"><strong>Architecture Diagram Studio</strong><span>Model · Layout · Export</span></div><div className="topbar-spacer"/><button className="secondary-button" onClick={()=>void autoLayout()}>Auto layout</button><button className="primary-button" onClick={exportFile}>Export .drawio</button></header>
 <section className="workspace"><aside className="sidebar"><span className="eyebrow">DIAGRAM</span><h1>{doc.title}</h1><span className="kind-pill">C4 · Container view</span><div className="sidebar-rule"/><span className="eyebrow">ELEMENTS</span>{doc.nodes.map(n=><div className="element-row" key={n.id}><span className={'element-dot dot-'+n.type}/><div><strong>{n.label}</strong><small>{n.technology??n.type}</small></div></div>)}<div className="sidebar-note"><strong>Layout is data</strong><p>Node coordinates and dimensions are captured on export. Export does not run a new layout.</p></div></aside>
 <section className="canvas-area"><div className="canvas-toolbar"><span><span className="live-dot"/> EDITING CANVAS</span><span>Drag nodes · Zoom · Pan</span></div><div className="canvas-frame"><ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} fitView fitViewOptions={{padding:.18}} minZoom={.2} maxZoom={2}><Background color="#dbe3ed" gap={20} size={1}/><Controls/><MiniMap pannable zoomable/></ReactFlow></div><footer className="statusbar"><span>{status}</span><span>{nodes.length} nodes · {edges.length} relations</span></footer></section></section></main>;
}
export default function App(){return <ReactFlowProvider><Editor/></ReactFlowProvider>;}