import type { DiagramDocument } from '../model/diagram';
const xml=(v:string)=>v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const style=(type:string)=>{
 const common='whiteSpace=wrap;html=1;rounded=1;arcSize=12;strokeWidth=1.5;';
 if(type==='person')return common+'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;fillColor=#eaf2ff;strokeColor=#4976b8;';
 if(type==='database')return common+'shape=cylinder3;size=15;boundedLbl=1;fillColor=#e6f5ec;strokeColor=#39805b;';
 if(type==='external')return common+'fillColor=#fff4e5;strokeColor=#b7791f;dashed=1;';
 return common+'fillColor=#f1f5f9;strokeColor=#64748b;';
};
/** Deterministic geometry mapping: export must never trigger layout. */
export function exportDrawio(doc:DiagramDocument):string{
 const cells=['<mxCell id="0"/>','<mxCell id="1" parent="0"/>'];
 for(const n of doc.nodes){
  const g=doc.layout[n.id]??{x:0,y:0,width:180,height:80};
  const label=[n.label,n.technology].filter(Boolean).join('\n');
  cells.push('<mxCell id="'+xml(n.id)+'" value="'+xml(label)+'" style="'+style(n.type)+'" vertex="1" parent="1"><mxGeometry x="'+g.x+'" y="'+g.y+'" width="'+g.width+'" height="'+g.height+'" as="geometry"/></mxCell>');
 }
 for(const e of doc.relations){
  cells.push('<mxCell id="'+xml(e.id)+'" value="'+xml(e.label)+'" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;strokeColor=#64748b;fontSize=11;" edge="1" parent="1" source="'+xml(e.sourceId)+'" target="'+xml(e.targetId)+'"><mxGeometry relative="1" as="geometry"/></mxCell>');
 }
 return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net" modified="'+new Date().toISOString()+'" agent="Architecture Diagram Studio" version="24.7.17" type="device"><diagram id="'+xml(doc.id)+'" name="'+xml(doc.title)+'"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="827" math="0" shadow="0"><root>'+cells.join('')+'</root></mxGraphModel></diagram></mxfile>';
}
export function downloadDrawio(doc:DiagramDocument):void{
 const blob=new Blob([exportDrawio(doc)],{type:'application/xml;charset=utf-8'});
 const url=URL.createObjectURL(blob);const a=window.document.createElement('a');a.href=url;a.download=doc.id+'.drawio';a.click();URL.revokeObjectURL(url);
}