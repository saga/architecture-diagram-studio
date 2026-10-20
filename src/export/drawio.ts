import type { DiagramDocument } from '../model/diagram';
import { validateDiagram } from '../model/validate';

const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const number=(v:number)=>Number.isFinite(v)?String(Math.round(v*100)/100):'0';
const style=(type:string)=>{
 const common='whiteSpace=wrap;html=1;rounded=1;arcSize=12;strokeWidth=1.5;';
 if(type==='person')return common+'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;fillColor=#eaf2ff;strokeColor=#4976b8;';
 if(type==='database')return common+'shape=cylinder3;size=15;boundedLbl=1;fillColor=#e6f5ec;strokeColor=#39805b;';
 if(type==='external')return common+'fillColor=#fff4e5;strokeColor=#b7791f;dashed=1;';
 if(type==='boundary')return common+'swimlane;startSize=28;fillColor=#f8fafc;strokeColor=#94a3b8;';
 return common+'fillColor=#f1f5f9;strokeColor=#64748b;';
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
export function exportDrawio(doc:DiagramDocument):string{
 const errors=validateDiagram(doc).filter(issue=>issue.severity==='error');
 if(errors.length) throw new Error('Cannot export invalid diagram:\n'+errors.map(issue=>issue.message).join('\n'));
 const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
 for(const n of doc.nodes){
  const g=doc.layout[n.id]??{x:0,y:0,width:180,height:80};
  const label=[n.label,n.technology].filter(Boolean).join('\n');
  cells.push('<mxCell id="'+xml(n.id)+'" value="'+xml(label)+'" style="'+style(n.type)+'" vertex="1" parent="1"><mxGeometry x="'+number(g.x)+'" y="'+number(g.y)+'" width="'+number(g.width)+'" height="'+number(g.height)+'" as="geometry"/></mxCell>');
 }
 for(const e of doc.relations){
  const points=(e.waypoints?.length??0)>0?'<Array as="points">'+e.waypoints!.map(p=>'<mxPoint x="'+number(p.x)+'" y="'+number(p.y)+'"/>').join('')+'</Array>':'';
  const sourceGeometry=doc.layout[e.sourceId];
  const targetGeometry=doc.layout[e.targetId];
  const sourcePort=sourceGeometry?.ports?.find(p=>p.id===(e.sourceHandleId??'out-'+e.id));
  const targetPort=targetGeometry?.ports?.find(p=>p.id===(e.targetHandleId??'in-'+e.id));
  const edgeStyle='edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#64748b;fontSize=11;'
    +portAnchorStyle(sourcePort,sourceGeometry,'exit')
    +portAnchorStyle(targetPort,targetGeometry,'entry');
  cells.push('<mxCell id="'+xml(e.id)+'" value="'+xml(e.label)+'" style="'+edgeStyle+'" edge="1" parent="1" source="'+xml(e.sourceId)+'" target="'+xml(e.targetId)+'"><mxGeometry relative="1" as="geometry">'+points+'</mxGeometry></mxCell>');
 }
 // Omit generated timestamps so equivalent snapshots produce byte-for-byte stable XML.
 return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" agent="Architecture Diagram Studio" version="24.7.17" type="device"><diagram id="'+xml(doc.id)+'" name="'+xml(doc.title)+'"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root>'+cells.join('')+'</root></mxGraphModel></diagram></mxfile>';
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
