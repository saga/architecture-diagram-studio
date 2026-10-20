import type { DiagramDocument, DiagramNode, SequenceMessage } from '../model/diagram';
import { validateDiagram } from '../model/validate';
import { ensureEdgeGeometry, relationPortIds } from '../model/routing';
import { ensureDiagramBoundaries } from '../model/boundaries';
import { sequenceActivationDomId } from '../model/sequence';

const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const number=(v:number)=>Number.isFinite(v)?String(Math.round(v*100)/100):'0';
const style=(type:DiagramNode['type'])=>{
 const common='whiteSpace=wrap;html=1;rounded=1;arcSize=10;strokeWidth=1.5;fontFamily=Arial;fontSize=12;align=center;verticalAlign=middle;spacing=7;';
 if(type==='person')return common+'fillColor=#08427b;strokeColor=#052c52;fontColor=#ffffff;';
 if(type==='system')return common+'fillColor=#1168bd;strokeColor=#0b4f92;fontColor=#ffffff;';
 if(type==='service')return common+'fillColor=#438dd5;strokeColor=#2d6fae;fontColor=#ffffff;';
 if(type==='component')return common+'fillColor=#85bbf0;strokeColor=#4c8cc8;fontColor=#102a43;';
 if(type==='database')return common+'fillColor=#e6f5ec;strokeColor=#39805b;fontColor=#214b37;';
 if(type==='external')return common+'fillColor=#fff4e5;strokeColor=#c7832e;dashed=1;fontColor=#6e4714;';
 if(type==='boundary')return common+'fillColor=#ffffff;strokeColor=#7b8da4;fontColor=#334e68;';
 return common+'fillColor=#ffffff;strokeColor=#7b8da4;fontColor=#334e68;';
};
const htmlText=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const stereotype=(type:DiagramNode['type'])=>{
 if(type==='person')return 'Person';
 if(type==='system')return 'Software System';
 if(type==='service')return 'Container';
 if(type==='component')return 'Component';
 if(type==='database')return 'Container · Database';
 if(type==='external')return 'Software System · External';
 return 'System Boundary';
};
const nodeLabel=(label:string,technology?:string,type:DiagramNode['type']='service',description?:string)=>{
 const title='<div style="font-size:14px;font-weight:700;line-height:1.25;">'+htmlText(label)+'</div>';
 const tag='<div style="font-size:10px;font-style:italic;line-height:1.2;opacity:.94;">«'+htmlText(stereotype(type))+'»</div>';
 const subtitle=technology?'<div style="margin-top:2px;font-size:11px;font-weight:400;line-height:1.2;">'+htmlText(technology)+'</div>':'';
 const detail=description?'<div style="margin-top:2px;font-size:10px;line-height:1.25;">'+htmlText(description)+'</div>':'';
 return '<div style="font-family:Arial,sans-serif;text-align:center;color:inherit;white-space:normal;overflow-wrap:anywhere;">'+tag+title+subtitle+detail+'</div>';
};


function portAnchorStyle(
  port: { side: 'LEFT'|'RIGHT'|'TOP'|'BOTTOM'; x: number; y: number } | undefined,
  geometry: { width: number; height: number } | undefined,
  anchor: 'exit'|'entry',
): string {
  if (!port || !geometry || geometry.width <= 0 || geometry.height <= 0) return '';
  const x = port.side === 'LEFT' ? 0 : port.side === 'RIGHT' ? 1 : port.x / geometry.width;
  const y = port.side === 'TOP' ? 0 : port.side === 'BOTTOM' ? 1 : port.y / geometry.height;
  return anchor + 'X=' + number(Math.min(1, Math.max(0, x))) + ';'
    + anchor + 'Y=' + number(Math.min(1, Math.max(0, y))) + ';'
    + anchor + 'Perimeter=1;';
}

/**
 * Convert the current semantic + layout snapshot into native mxGraph XML.
 * Export is intentionally pure: no layout, DOM measurement, or implicit geometry changes.
 */
function sequenceParticipantStyle(role: 'actor'|'system'|'container'|'database'|'external'):string{
 const common='whiteSpace=wrap;html=1;rounded=1;arcSize=6;strokeWidth=1.5;fontFamily=Arial;fontSize=12;align=center;verticalAlign=middle;spacing=6;';
 if(role==='actor')return 'shape=umlActor;html=1;whiteSpace=wrap;verticalLabelPosition=bottom;verticalAlign=top;align=center;fontFamily=Arial;fontSize=12;strokeColor=#4976b8;fillColor=none;fontColor=#24344b;';
 if(role==='database')return common+'fillColor=#edf8f0;strokeColor=#39805b;fontColor=#24344b;';
 if(role==='external')return common+'fillColor=#fff7e9;strokeColor=#b7791f;dashed=1;fontColor=#24344b;';
 return common+'fillColor=#ffffff;strokeColor=#60738c;fontColor=#24344b;';
}
const sequenceParticipantLabel=(label:string,technology:string|undefined,role:'actor'|'system'|'container'|'database'|'external')=>{
 const roleName=role==='actor'?'Actor':role==='system'?'System':role==='container'?'Container':role==='database'?'Database':'External System';
 const tag=role==='actor'?'':'<div style="font-size:9px;font-style:italic;line-height:1.2;color:#687d95;">'+htmlText(roleName)+'</div>';
 const title='<div style="font-size:12px;font-weight:700;line-height:1.25;margin-top:4px;">'+htmlText(label)+'</div>';
 const subtitle=technology?'<div style="font-size:10px;line-height:1.2;color:#748196;margin-top:4px;">'+htmlText(technology)+'</div>':'';
 return '<div style="font-family:Arial,sans-serif;text-align:center;color:#24344b;white-space:normal;overflow-wrap:anywhere;">'+tag+title+subtitle+'</div>';
};

function sequenceMessageLabel(message:SequenceMessage):string{
 return String(message.order)+'. '+message.label;
}

function exportSequenceDrawio(doc:DiagramDocument):string{
 const sequence=doc.sequence;
 if(!sequence)throw new Error('Cannot export sequence diagram without participants and messages.');
 const participants=sequence.participants;
 const messages=[...sequence.messages].sort((a,b)=>a.order-b.order);
 const participantWidth=176;
 const participantGap=72;
 const participantLeft=52;
 const headerTop=36;
 const rowTop=156;
 const rowGap=72;
 const xById=new Map(participants.map((participant,index)=>[participant.id,participantLeft+index*(participantWidth+participantGap)+participantWidth/2] as const));
 const yById=new Map(messages.map((message,index)=>[message.id,rowTop+index*rowGap+30] as const));
 const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
 const finalY=16+Math.max(520,rowTop+messages.length*rowGap+76);
 // Lifelines are free-standing dotted edges so the header and messages remain editable native cells.
 for(const participant of participants){
  const center=xById.get(participant.id)!;
  const lifelineTop=headerTop+65;
  cells.push('<mxCell id="'+xml('lifeline-'+participant.id)+'" style="edgeStyle=none;html=1;endArrow=none;dashed=1;dashPattern=3 4;strokeColor=#8a9bb0;strokeWidth=1.5;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="'+number(center)+'" y="'+number(lifelineTop)+'" as="sourcePoint"/><mxPoint x="'+number(center)+'" y="'+number(finalY)+'" as="targetPoint"/></mxGeometry></mxCell>');
 }
 // Fragment frames and activation rectangles sit behind the messages.
 for(const fragment of sequence.fragments??[]){
  const startIndex=messages.findIndex(message=>message.id===fragment.startMessageId);
  const endIndex=messages.findIndex(message=>message.id===fragment.endMessageId);
  if(startIndex<0||endIndex<startIndex)continue;
  const startX=xById.get(fragment.participantStartId??participants[0]?.id)??participantLeft;
  const endX=xById.get(fragment.participantEndId??participants[participants.length-1]?.id)??startX;
  const x=Math.min(startX,endX)-participantWidth/2-18;
  const width=Math.max(180,Math.abs(endX-startX)+participantWidth+36);
  const y=rowTop+startIndex*rowGap-14;
  const height=(endIndex-startIndex)*rowGap+58;
  const value='<div style="font-family:Arial,sans-serif;font-size:10px;font-weight:700;">'+htmlText(fragment.kind)+' &nbsp; '+htmlText(fragment.title)+'</div>'
    +(fragment.guard?'<div style="font-family:Arial,sans-serif;font-size:10px;font-style:italic;">'+htmlText(fragment.guard)+'</div>':'');
  cells.push('<mxCell id="'+xml('fragment-'+fragment.id)+'" value="'+xml(value)+'" style="rounded=0;html=1;whiteSpace=wrap;dashed=1;strokeColor=#7c8da3;fillColor=none;fontColor=#344b66;fontSize=10;align=left;verticalAlign=top;spacingTop=5;spacingLeft=8;" vertex="1" parent="1"><mxGeometry x="'+number(x)+'" y="'+number(y)+'" width="'+number(width)+'" height="'+number(height)+'" as="geometry"/></mxCell>');
 }
 for(const activation of sequence.activations??[]){
  const startIndex=messages.findIndex(message=>message.id===activation.startMessageId);
  const endIndex=messages.findIndex(message=>message.id===activation.endMessageId);
  const center=xById.get(activation.participantId);
  if(startIndex<0||endIndex<startIndex||center===undefined)continue;
  cells.push('<mxCell id="'+xml(sequenceActivationDomId(activation))+'" value="" style="rounded=0;html=1;fillColor=#ffffff;strokeColor=#536b86;strokeWidth=1.5;" vertex="1" parent="1"><mxGeometry x="'+number(center-7)+'" y="'+number(rowTop+startIndex*rowGap+16)+'" width="14" height="'+number((endIndex-startIndex)*rowGap+18)+'" as="geometry"/></mxCell>');
 }
 for(const message of messages){
  const sourceX=xById.get(message.fromParticipantId);
  const targetX=xById.get(message.toParticipantId);
  const rowY=yById.get(message.id);
  if(sourceX===undefined||targetX===undefined||rowY===undefined)continue;
  const isReturn=message.kind==='return';
  const isAsync=message.kind==='async';
  const edgeStyle='edgeStyle=none;html=1;rounded=0;endArrow='+(isReturn||isAsync?'open':'block')+';endFill='+(isReturn||isAsync?'0':'1')+';dashed='+(isReturn?'1':'0')+';dashPattern=5 4;strokeColor='+(isAsync?'#0f766e':'#536b86')+';strokeWidth=1.5;fontColor=#344b66;fontFamily=Arial;fontSize=11;labelBackgroundColor=#ffffff;align=center;verticalLabelPosition=top;verticalAlign=bottom;';
  let geometry='<mxPoint x="'+number(sourceX)+'" y="'+number(rowY)+'" as="sourcePoint"/><mxPoint x="'+number(targetX)+'" y="'+number(rowY)+'" as="targetPoint"/>';
  if(Math.abs(sourceX-targetX)<1){
   // Match the browser's rectangular self-call loop and keep every segment orthogonal.
   geometry='<mxPoint x="'+number(sourceX)+'" y="'+number(rowY)+'" as="sourcePoint"/><Array as="points"><mxPoint x="'+number(sourceX+40)+'" y="'+number(rowY)+'"/><mxPoint x="'+number(sourceX+40)+'" y="'+number(rowY-22)+'"/></Array><mxPoint x="'+number(targetX)+'" y="'+number(rowY-22)+'" as="targetPoint"/>';
  }
  cells.push('<mxCell id="'+xml(message.id)+'" value="'+xml(sequenceMessageLabel(message))+'" style="'+edgeStyle+'" edge="1" parent="1"><mxGeometry relative="1" as="geometry">'+geometry+'</mxGeometry></mxCell>');
 }
 for(const participant of participants){
  const center=xById.get(participant.id)!;
  const styleText=sequenceParticipantStyle(participant.role);
  const label=sequenceParticipantLabel(participant.label,participant.technology,participant.role);
  cells.push('<mxCell id="'+xml('participant-'+participant.id)+'" value="'+xml(label)+'" style="'+styleText+'" vertex="1" parent="1"><mxGeometry x="'+number(center-participantWidth/2)+'" y="'+number(headerTop)+'" width="'+number(participantWidth)+'" height="64" as="geometry"/></mxCell>');
 }
 const pageWidth=Math.max(1169,participantLeft+participants.length*(participantWidth+participantGap)+80);
 const pageHeight=Math.max(827,finalY+90);
 return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" agent="Architecture Diagram Studio" version="24.7.17" type="device"><diagram id="'+xml(doc.id)+'" name="'+xml(doc.title)+'"><mxGraphModel dx="'+number(pageWidth)+'" dy="'+number(pageHeight)+'" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="'+number(pageWidth)+'" pageHeight="'+number(pageHeight)+'" math="0" shadow="0"><root>'+cells.join('')+'</root></mxGraphModel></diagram></mxfile>';
}

/** Convert the current diagram snapshot into native, editable draw.io XML. */
export function exportDrawio(doc:DiagramDocument):string{
 const errors=validateDiagram(doc).filter(issue=>issue.severity==='error');
 if(errors.length) throw new Error('Cannot export invalid diagram:\n'+errors.map(issue=>issue.message).join('\n'));
 if(doc.kind==='sequence')return exportSequenceDrawio(doc);
 const routed=ensureEdgeGeometry(ensureDiagramBoundaries(doc));
 const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
 for(const boundary of routed.boundaries??[]){
  const label='<div style="font-family:Arial,sans-serif;text-align:left;color:#1168bd;"><div style="font-size:12px;font-weight:700;line-height:1.2;">'+htmlText(boundary.label)+'</div><div style="font-size:9px;font-style:italic;color:#647b94;line-height:1.2;margin-top:3px;">'+htmlText(boundary.description??'Software system boundary')+'</div></div>';
  const boundaryStyle='rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#1168bd;strokeWidth=1.5;dashed=1;verticalAlign=top;align=left;fontStyle=1;fontSize=12;fontColor=#1168bd;spacingTop=7;spacingLeft=10;container=0;collapsible=0;';
  cells.push('<mxCell id="'+xml('diagram-boundary-'+boundary.id)+'" value="'+xml(label)+'" style="'+boundaryStyle+'" vertex="1" parent="1"><mxGeometry x="'+number(boundary.x)+'" y="'+number(boundary.y)+'" width="'+number(boundary.width)+'" height="'+number(boundary.height)+'" as="geometry"/></mxCell>');
 }
 const pageWidth=Math.max(1169,...routed.nodes.map(node=>(routed.layout[node.id]?.x??0)+(routed.layout[node.id]?.width??220)+80));
 const pageHeight=Math.max(827,...routed.nodes.map(node=>(routed.layout[node.id]?.y??0)+(routed.layout[node.id]?.height??112)+80));
 for(const n of routed.nodes){
  const g=routed.layout[n.id]??{x:0,y:0,width:220,height:112};
  const label=xml(nodeLabel(n.label,n.technology,n.type,n.description));
  cells.push('<mxCell id="'+xml(n.id)+'" value="'+label+'" style="'+style(n.type)+'" vertex="1" parent="1"><mxGeometry x="'+number(g.x)+'" y="'+number(g.y)+'" width="'+number(g.width)+'" height="'+number(g.height)+'" as="geometry"/></mxCell>');
 }
 for(const e of routed.relations){
  const points=(e.waypoints?.length??0)>0?'<Array as="points">'+e.waypoints!.map(p=>'<mxPoint x="'+number(p.x)+'" y="'+number(p.y)+'"/>').join('')+'</Array>':'';
  const sourceGeometry=routed.layout[e.sourceId];
  const targetGeometry=routed.layout[e.targetId];
  const ids=relationPortIds(e);
  const sourcePort=sourceGeometry?.ports?.find(p=>p.id===ids.source);
  const targetPort=targetGeometry?.ports?.find(p=>p.id===ids.target);
  const edgeStyle='edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#334e68;strokeWidth=1.5;fontColor=#334e68;fontSize=11;fontFamily=Arial;align=center;verticalAlign=middle;labelBackgroundColor=#ffffff;'
    +portAnchorStyle(sourcePort,sourceGeometry,'exit')
    +portAnchorStyle(targetPort,targetGeometry,'entry');
  cells.push('<mxCell id="'+xml(e.id)+'" value="'+xml(e.label)+'" style="'+edgeStyle+'" edge="1" parent="1" source="'+xml(e.sourceId)+'" target="'+xml(e.targetId)+'"><mxGeometry relative="1" as="geometry">'+points+'</mxGeometry></mxCell>');
 }
 return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" agent="Architecture Diagram Studio" version="24.7.17" type="device"><diagram id="'+xml(routed.id)+'" name="'+xml(routed.title)+'"><mxGraphModel dx="'+number(pageWidth)+'" dy="'+number(pageHeight)+'" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="'+number(pageWidth)+'" pageHeight="'+number(pageHeight)+'" math="0" shadow="0"><root>'+cells.join('')+'</root></mxGraphModel></diagram></mxfile>';
}
export function downloadDrawio(doc:DiagramDocument):void{
 const blob=new Blob([exportDrawio(doc)],{type:'application/xml;charset=utf-8'});
 const url=URL.createObjectURL(blob);
 const a=window.document.createElement('a');
 a.href=url;a.download=doc.id+'.drawio';
 window.document.body.appendChild(a);a.click();a.remove();
 // Delay revocation so browsers have consumed the object URL.
 window.setTimeout(()=>URL.revokeObjectURL(url),0);
}
