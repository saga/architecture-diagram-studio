import type { DiagramDocument, IntentResult } from "../model/types";
import { layoutDiagram } from "../layout/layout";

function cloneDocument(document: DiagramDocument): DiagramDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}) } })),
    relations: document.relations.map((relation) => ({ ...relation, points: [...(relation.points || [])] })),
    boundaries: document.boundaries.map((boundary) => ({ ...boundary, members: [...boundary.members] })),
    layout: { ...document.layout }
  };
}

export function interpretIntent(document: DiagramDocument, raw: string): IntentResult {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const next = cloneDocument(document);
  const summaries: string[] = [];
  let requiresLayout = false;
  let changed = false;

  const renameMatch = text.match(/^(?:将|把)\s*[“"']?(.+?)[”"']?\s*(?:节点)?\s*(?:重命名为|改名为|改为)\s*[“"']?(.+?)[”"']?$/)
    || text.match(/^rename\s+(?:node\s+)?["']?(.+?)["']?\s+to\s+["']?(.+?)["']?$/i);
  if (renameMatch) {
    const target = renameMatch[1].trim(), replacement = renameMatch[2].trim();
    const matches = next.nodes.filter((node) => node.id.toLowerCase() === target.toLowerCase() || node.name.toLowerCase() === target.toLowerCase());
    if (matches.length === 1 && replacement && replacement.length <= 500) {
      next.nodes = next.nodes.map((node) => node.id === matches[0].id ? { ...node, name: replacement } : node);
      summaries.push(`Renamed node "${matches[0].name}" to "${replacement}"; its position is unchanged`);
      changed = true;
    }
  }

  const relationLabelMatch = text.match(/^(?:将|把)\s*关系\s*[“"']?(.+?)[”"']?\s*(?:的)?标签(?:改为|设为)\s*[“"']?(.+?)[”"']?$/)
    || text.match(/^set\s+relation\s+["']?(.+?)["']?\s+label\s+to\s+["']?(.+?)["']?$/i);
  if (relationLabelMatch && !changed) {
    const target = relationLabelMatch[1].trim(), replacement = relationLabelMatch[2].trim();
    const matches = next.relations.filter((edge) => edge.id.toLowerCase() === target.toLowerCase() || edge.label.toLowerCase() === target.toLowerCase());
    if (matches.length === 1 && replacement.length <= 1000) {
      next.relations = next.relations.map((edge) => edge.id === matches[0].id ? { ...edge, label: replacement } : edge);
      summaries.push(`Updated the label of relation "${matches[0].label}"; the node layout is unchanged`);
      changed = true;
    }
  }

  const removeMatch = text.match(/^(?:删除|移除)节点\s*[“"']?(.+?)[”"']?$/) || text.match(/^delete\s+node\s+["']?(.+?)["']?$/i);
  if (removeMatch && !changed) {
    const target = removeMatch[1].trim();
    const matches = next.nodes.filter((node) => node.id.toLowerCase() === target.toLowerCase() || node.name.toLowerCase() === target.toLowerCase());
    if (matches.length === 1) {
      const id = matches[0].id;
      next.nodes = next.nodes.filter((node) => node.id !== id);
      next.relations = next.relations.filter((edge) => edge.source !== id && edge.target !== id);
      next.boundaries = next.boundaries.map((boundary) => ({ ...boundary, members: boundary.members.filter((member) => member !== id) }));
      if (next.sequence) next.sequence = { ...next.sequence, participants: next.sequence.participants.filter((participant) => participant !== id) };
      if (next.flow) next.flow = { ...next.flow, primaryPath: next.flow.primaryPath.filter((nodeId) => nodeId !== id) };
      summaries.push(`Deleted node "${matches[0].name}" and its relations; other nodes keep their positions`);
      changed = true;
    }
  }

  const addMatch = text.match(/^(?:新增|添加)(?:一个|一条)?(?:服务|service)?节点(?:，|,)?(?:名称为|名为|叫)?\s*[“"']?(.+?)[”"']?$/)
    || text.match(/^add\s+(?:a\s+)?(?:service\s+)?node\s+["']?(.+?)["']?$/i);
  if (addMatch && !changed) {
    const name = addMatch[1].trim();
    if (name && name.length <= 500 && !next.nodes.some((node) => node.name.toLowerCase() === name.toLowerCase())) {
      const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "service";
      let id = idBase, suffix = 2;
      while (next.nodes.some((node) => node.id === id)) id = idBase + "-" + suffix++;
      const x = next.nodes.length ? Math.max(...next.nodes.map((node) => node.x + node.width)) + 60 : 80;
      const y = next.nodes.length ? Math.min(...next.nodes.map((node) => node.y)) : 80;
      next.nodes.push({ id, name, role: "service", visualRole: "primary", x, y, width: 190, height: 82, layoutHints: {} });
      summaries.push(`Added node "${name}"; existing nodes keep their positions — add relations as needed`);
      changed = true;
    }
  }

  const addRelationMatch = text.match(/^(?:新增|添加)关系\s*[“"']?(.+?)[”"']?\s*(?:->|→|到|连接到)\s*[“"']?(.+?)[”"']?(?:[，, ]+(?:标签为|标签|label)\s*[“"']?(.+?)[”"']?)?$/i)
    || text.match(/^add\s+relation\s+["']?(.+?)["']?\s*(?:->|to)\s*["']?(.+?)["']?(?:\s+label\s+["']?(.+?)["']?)?$/i);
  if (addRelationMatch && !changed) {
    const sourceName = addRelationMatch[1].trim(), targetName = addRelationMatch[2].trim(), label = (addRelationMatch[3] || "Depends on").trim();
    const sources = next.nodes.filter((node) => node.id.toLowerCase() === sourceName.toLowerCase() || node.name.toLowerCase() === sourceName.toLowerCase());
    const targets = next.nodes.filter((node) => node.id.toLowerCase() === targetName.toLowerCase() || node.name.toLowerCase() === targetName.toLowerCase());
    if (sources.length === 1 && targets.length === 1 && sources[0].id !== targets[0].id && label.length <= 1000) {
      const baseId = (sources[0].id + "-" + targets[0].id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80) || "relation";
      let id = baseId, suffix = 2;
      while (next.relations.some((edge) => edge.id === id)) id = baseId + "-" + suffix++;
      next.relations.push({ id, source: sources[0].id, target: targets[0].id, label, kind: "dependency", points: [] });
      summaries.push(`Added relation "${sources[0].name}" → "${targets[0].name}" labelled "${label}"; existing nodes keep their positions`);
      changed = true;
    }
  }

  const removeRelationMatch = text.match(/^(?:删除|移除)关系\s*[“"']?(.+?)[”"']?$/) || text.match(/^delete\s+relation\s+["']?(.+?)["']?$/i);
  if (removeRelationMatch && !changed) {
    const target = removeRelationMatch[1].trim();
    const matches = next.relations.filter((edge) => edge.id.toLowerCase() === target.toLowerCase() || edge.label.toLowerCase() === target.toLowerCase());
    if (matches.length === 1) {
      next.relations = next.relations.filter((edge) => edge.id !== matches[0].id);
      summaries.push(`Deleted relation "${matches[0].label}"; node positions are unchanged`);
      changed = true;
    }
  }

  const moveMatch = text.match(/^(?:将|把)节点\s*[“"']?(.+?)[”"']?\s*移动到\s*x\s*=\s*(-?\d+(?:\.\d+)?)\s*[,， ]\s*y\s*=\s*(-?\d+(?:\.\d+)?)$/i)
    || text.match(/^move\s+node\s+["']?(.+?)["']?\s+to\s+x\s*=\s*(-?\d+(?:\.\d+)?),?\s*y\s*=\s*(-?\d+(?:\.\d+)?)$/i);
  if (moveMatch && !changed) {
    const target = moveMatch[1].trim(), x = Number(moveMatch[2]), y = Number(moveMatch[3]);
    const matches = next.nodes.filter((node) => node.id.toLowerCase() === target.toLowerCase() || node.name.toLowerCase() === target.toLowerCase());
    if (matches.length === 1 && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100000 && Math.abs(y) <= 100000) {
      next.nodes = next.nodes.map((node) => node.id === matches[0].id ? { ...node, x, y, layoutHints: { ...(node.layoutHints || {}), locked: true } } : node);
      summaries.push(`Moved node "${matches[0].name}" to the requested coordinates and locked it`);
      changed = true;
    }
  }

  if (/虚线|dashed|dash(ed)? line/.test(lower)) {
    next.relations = next.relations.map((relation) => ({ ...relation, dashed: true }));
    summaries.push("All relations now use a dashed line");
    changed = true;
  }
  if (/实线|solid line/.test(lower)) {
    next.relations = next.relations.map((relation) => ({ ...relation, dashed: false }));
    summaries.push("All relations now use a solid line");
    changed = true;
  }
  if (/曲线.{0,8}(折线|直角)|curve.{0,12}(polyline|orthogonal)|改成折线|改为折线/.test(lower)) {
    next.layout.routing = /直角|orthogonal/.test(lower) ? "orthogonal" : "polyline";
    next.relations = next.relations.map((relation) => ({ ...relation, routing: next.layout.routing, points: [] }));
    summaries.push(next.layout.routing === "orthogonal" ? "Switched to orthogonal routing and recomputed the paths" : "Switched to polyline routing and recomputed the paths");
    requiresLayout = true;
    changed = true;
  } else if (/所有线|关系线|连线/.test(lower) && /曲线/.test(lower)) {
    next.layout.routing = "curved";
    next.relations = next.relations.map((relation) => ({ ...relation, routing: "curved" }));
    summaries.push("Relations now use curved routing");
    requiresLayout = true;
    changed = true;
  }
  if (/(external|vendor|外部|供应商)/.test(lower) && /(右边|右侧|right)/.test(lower)) {
    next.layout.externalSide = "RIGHT";
    next.nodes = next.nodes.map((node) =>
      node.role === "external" || node.role === "vendor"
        ? { ...node, layoutHints: { ...(node.layoutHints || {}), preferredSide: "RIGHT" } }
        : node
    );
    summaries.push("External and vendor nodes moved to a separate area on the right");
    requiresLayout = true;
    changed = true;
  }
  if (/(db|database|storage|存储|数据库|数据仓库)/.test(lower) && /(底部|下方|最下面|bottom)/.test(lower)) {
    next.layout.storageSide = "BOTTOM";
    next.nodes = next.nodes.map((node) =>
      node.role === "storage" || node.role === "data"
        ? { ...node, layoutHints: { ...(node.layoutHints || {}), preferredSide: "BOTTOM" } }
        : node
    );
    summaries.push("Database and storage nodes moved to the bottom data band");
    requiresLayout = true;
    changed = true;
  }
  if (/从左到右|左到右|left.to.right|rightward/.test(lower)) {
    next.layout.direction = "RIGHT";
    summaries.push("Main layout direction set to left-to-right");
    requiresLayout = true;
    changed = true;
  } else if (/从上到下|上到下|top.to.bottom|vertical/.test(lower)) {
    next.layout.direction = "DOWN";
    summaries.push("Main layout direction set to top-to-bottom");
    requiresLayout = true;
    changed = true;
  }
  if (/重新排版|重新布局|自动排版|自动布局|relayout|auto.?layout/.test(lower)) {
    summaries.push("Re-ran layout and overlap repair");
    requiresLayout = true;
    changed = true;
  }
  if (/解锁|忽略手动位置|clear locks/.test(lower)) {
    next.nodes = next.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}), locked: false } }));
    summaries.push("Cleared manual locks; the layout engine may rearrange every node");
    requiresLayout = true;
    changed = true;
  }
  if (!changed) {
    return {
      document: next,
      summary: "Deterministic edits cover renaming, adding, deleting, and moving nodes, relation labels, line style and routing, external or storage placement, layout direction, and auto layout. More complex semantic changes need extra modelling support.",
      requiresLayout: false,
      changed: false
    };
  }
  return { document: next, summary: summaries.join("; "), requiresLayout, changed };
}

export async function applyIntent(document: DiagramDocument, raw: string): Promise<IntentResult> {
  const result = interpretIntent(document, raw);
  if (result.changed && result.requiresLayout) {
    return { ...result, document: await layoutDiagram(result.document) };
  }
  return result;
}