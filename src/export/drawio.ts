import type { DiagramDocument } from '../model/diagram';
import { validateDiagram } from '../model/validate';
import { ensureEdgeGeometry, relationPortIds } from '../model/routing';

const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const number=(v:number)=>Number.isFinite(v)?String(Math.round(v*100)/100):'0';
const style=(type:string)=>{
 const common='whiteSpace=wrap;html=1;rounded=1;arcSize=12;strokeWidth=1.5;fontFamily=Arial;fontSize=12;fontColor=#24344b;align=center;verticalAlign=middle;spacing=6;';
 if(type==='person')return common+'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;fillColor=#eaf2ff;strokeColor=#4976b8;';
 if(type==='database')return common+'shape=cylinder3;size=15;boundedLbl=1;fillColor=#e6f5ec;strokeColor=#39805b;';
 if(type==='external')return common+'fillColor=#fff4e5;strokeColor=#b7791f;dashed=1;';
 if(type==='boundary')return common+'shape=swimlane;startSize=28;fillColor=#f8fafc;strokeColor=#94a3b8;';
 return common+'fillColor=#f1f5f9;strokeColor=#64748b;';
};
const htmlText=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const nodeLabel=(label:string,technology?:string)=>{
 const title='<div style="font-size:12px;font-weight:700;line-height:1.2;">'+htmlText(label)+'</div>';
 const subtitle=technology?'<div style="margin-top:7px;font-size:10px;font-weight:400;color:#748196;line-height:1.2;">'+htmlText(technology)+'</div>':'';
 return '<div style="font-family:Arial,sans-serif;text-align:center;color:#24344b;white-space:normal;overflow-wrap:anywhere;">'+title+subtitle+'</div>';
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
 const routed=ensureEdgeGeometry(doc);
 const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
 for(const n of routed.nodes){
  const g=routed.layout[n.id]??{x:0,y:0,width:180,height:80};
  // XML attribute newlines are normalized. Explicit HTML creates the same title/subtitle hierarchy as React Flow.
  const label=xml(nodeLabel(n.label,n.technology));
  cells.push('<mxCell id="'+xml(n.id)+'" value="'+label+'" style="'+style(n.type)+'" vertex="1" parent="1"><mxGeometry x="'+number(g.x)+'" y="'+number(g.y)+'" width="'+number(g.width)+'" height="'+number(g.height)+'" as="geometry"/></mxCell>');
 }
 for(const e of routed.relations){
  const points=(e.waypoints?.length??0)>0?'<Array as="points">'+e.waypoints!.map(p=>'<mxPoint x="'+number(p.x)+'" y="'+number(p.y)+'"/>').join('')+'</Array>':'';
  const sourceGeometry=routed.layout[e.sourceId];
  const targetGeometry=routed.layout[e.targetId];
  const ids=relationPortIds(e);
  const sourcePort=sourceGeometry?.ports?.find(p=>p.id===ids.source);
  const targetPort=targetGeometry?.ports?.find(p=>p.id===ids.target);
  const edgeStyle='edgeStyle=none;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#64748b;strokeWidth=1.5;fontColor=#475569;fontSize=11;fontFamily=Arial;align=center;verticalAlign=middle;'
    +portAnchorStyle(sourcePort,sourceGeometry,'exit')
    +portAnchorStyle(targetPort,targetGeometry,'entry');
  cells.push('<mxCell id="'+xml(e.id)+'" value="'+xml(e.label)+'" style="'+edgeStyle+'" edge="1" parent="1" source="'+xml(e.sourceId)+'" target="'+xml(e.targetId)+'"><mxGeometry relative="1" as="geometry">'+points+'</mxGeometry></mxCell>');
 }
 // Omit generated timestamps so equivalent snapshots produce byte-for-byte stable XML.
 return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" agent="Architecture Diagram Studio" version="24.7.17" type="device"><diagram id="'+xml(routed.id)+'" name="'+xml(routed.title)+'"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root>'+cells.join('')+'</root></mxGraphModel></diagram></mxfile>';
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
