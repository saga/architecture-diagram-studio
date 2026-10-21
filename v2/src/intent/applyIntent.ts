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

  const renameMatch = text.match(/^(?:将|把)\\s*[“"']?(.+?)[”"']?\\s*(?:节点)?\\s*(?:重命名为|改名为|改为)\\s*[“"']?(.+?)[”"']?$/)
    || text.match(/^rename\\s+(?:node\\s+)?["']?(.+?)["']?\\s+to\\s+["']?(.+?)["']?$/i);
  if (renameMatch) {
    const target = renameMatch[1].trim(), replacement = renameMatch[2].trim();
    const matches = next.nodes.filter((node) => node.id.toLowerCase() === target.toLowerCase() || node.name.toLowerCase() === target.toLowerCase());
    if (matches.length === 1 && replacement && replacement.length <= 500) {
      next.nodes = next.nodes.map((node) => node.id === matches[0].id ? { ...node, name: replacement } : node);
      summaries.push(`节点「${matches[0].name}」已重命名为「${replacement}」，位置保持不变`);
      changed = true;
    }
  }

  const relationLabelMatch = text.match(/^(?:将|把)\\s*关系\\s*[“"']?(.+?)[”"']?\\s*(?:的)?标签(?:改为|设为)\\s*[“"']?(.+?)[”"']?$/)
    || text.match(/^set\\s+relation\\s+["']?(.+?)["']?\\s+label\\s+to\\s+["']?(.+?)["']?$/i);
  if (relationLabelMatch && !changed) {
    const target = relationLabelMatch[1].trim(), replacement = relationLabelMatch[2].trim();
    const matches = next.relations.filter((edge) => edge.id.toLowerCase() === target.toLowerCase() || edge.label.toLowerCase() === target.toLowerCase());
    if (matches.length === 1 && replacement.length <= 1000) {
      next.relations = next.relations.map((edge) => edge.id === matches[0].id ? { ...edge, label: replacement } : edge);
      summaries.push(`关系「${matches[0].label}」的标签已更新，节点布局保持不变`);
      changed = true;
    }
  }

  const removeMatch = text.match(/^(?:删除|移除)节点\\s*[“"']?(.+?)[”"']?$/) || text.match(/^delete\\s+node\\s+["']?(.+?)["']?$/i);
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
      summaries.push(`节点「${matches[0].name}」及其关联关系已删除，其他节点位置保持不变`);
      changed = true;
    }
  }

  const addMatch = text.match(/^(?:新增|添加)(?:一个|一条)?(?:服务|service)?节点(?:，|,)?(?:名称为|名为|叫)?\\s*[“"']?(.+?)[”"']?$/)
    || text.match(/^add\\s+(?:a\\s+)?(?:service\\s+)?node\\s+["']?(.+?)["']?$/i);
  if (addMatch && !changed) {
    const name = addMatch[1].trim();
    if (name && name.length <= 500 && !next.nodes.some((node) => node.name.toLowerCase() === name.toLowerCase())) {
      const idBase = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "service";
      let id = idBase, suffix = 2;
      while (next.nodes.some((node) => node.id === id)) id = idBase + "-" + suffix++;
      const x = next.nodes.length ? Math.max(...next.nodes.map((node) => node.x + node.width)) + 60 : 80;
      const y = next.nodes.length ? Math.min(...next.nodes.map((node) => node.y)) : 80;
      next.nodes.push({ id, name, role: "service", visualRole: "primary", x, y, width: 190, height: 82, layoutHints: {} });
      summaries.push(`已添加节点「${name}」，原有节点位置保持不变；请按需补充关系`);
      changed = true;
    }
  }

  const moveMatch = text.match(/^(?:将|把)节点\\s*[“"']?(.+?)[”"']?\\s*移动到\\s*x\\s*=\\s*(-?\\d+(?:\\.\\d+)?)\\s*[,， ]\\s*y\\s*=\\s*(-?\\d+(?:\\.\\d+)?)$/i)
    || text.match(/^move\\s+node\\s+["']?(.+?)["']?\\s+to\\s+x\\s*=\\s*(-?\\d+(?:\\.\\d+)?),?\\s*y\\s*=\\s*(-?\\d+(?:\\.\\d+)?)$/i);
  if (moveMatch && !changed) {
    const target = moveMatch[1].trim(), x = Number(moveMatch[2]), y = Number(moveMatch[3]);
    const matches = next.nodes.filter((node) => node.id.toLowerCase() === target.toLowerCase() || node.name.toLowerCase() === target.toLowerCase());
    if (matches.length === 1 && Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 100000 && Math.abs(y) <= 100000) {
      next.nodes = next.nodes.map((node) => node.id === matches[0].id ? { ...node, x, y, layoutHints: { ...(node.layoutHints || {}), locked: true } } : node);
      summaries.push(`节点「${matches[0].name}」已移动到指定坐标并锁定位置`);
      changed = true;
    }
  }

  if (/虚线|dashed|dash(ed)? line/.test(lower)) {
    next.relations = next.relations.map((relation) => ({ ...relation, dashed: true }));
    summaries.push("所有关系线已改为虚线");
    changed = true;
  }
  if (/实线|solid line/.test(lower)) {
    next.relations = next.relations.map((relation) => ({ ...relation, dashed: false }));
    summaries.push("所有关系线已改为实线");
    changed = true;
  }
  if (/曲线.{0,8}(折线|直角)|curve.{0,12}(polyline|orthogonal)|改成折线|改为折线/.test(lower)) {
    next.layout.routing = /直角|orthogonal/.test(lower) ? "orthogonal" : "polyline";
    next.relations = next.relations.map((relation) => ({ ...relation, routing: next.layout.routing, points: [] }));
    summaries.push(next.layout.routing === "orthogonal" ? "已切换为直角折线路由，并重新计算路径" : "已切换为折线路由，并重新计算路径");
    requiresLayout = true;
    changed = true;
  } else if (/所有线|关系线|连线/.test(lower) && /曲线/.test(lower)) {
    next.layout.routing = "curved";
    next.relations = next.relations.map((relation) => ({ ...relation, routing: "curved" }));
    summaries.push("关系线已改为曲线路由");
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
    summaries.push("External / Vendor 已安排到右侧独立区域");
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
    summaries.push("数据库和存储节点已安排到底部数据区");
    requiresLayout = true;
    changed = true;
  }
  if (/从左到右|左到右|left.to.right|rightward/.test(lower)) {
    next.layout.direction = "RIGHT";
    summaries.push("主布局方向已设为从左到右");
    requiresLayout = true;
    changed = true;
  } else if (/从上到下|上到下|top.to.bottom|vertical/.test(lower)) {
    next.layout.direction = "DOWN";
    summaries.push("主布局方向已设为从上到下");
    requiresLayout = true;
    changed = true;
  }
  if (/重新排版|重新布局|自动排版|自动布局|relayout|auto.?layout/.test(lower)) {
    summaries.push("已重新运行布局与重叠修复");
    requiresLayout = true;
    changed = true;
  }
  if (/解锁|忽略手动位置|clear locks/.test(lower)) {
    next.nodes = next.nodes.map((node) => ({ ...node, layoutHints: { ...(node.layoutHints || {}), locked: false } }));
    summaries.push("已解除手动锁定，布局器可以重新排列所有节点");
    requiresLayout = true;
    changed = true;
  }
  if (!changed) {
    return {
      document: next,
      summary: "当前确定性编辑支持节点重命名/新增/删除/移动、关系标签修改、线型与路由调整、External/Storage 位置约束、布局方向和自动排版。更复杂的语义变更需要额外建模支持。",
      requiresLayout: false,
      changed: false
    };
  }
  return { document: next, summary: summaries.join("；"), requiresLayout, changed };
}

export async function applyIntent(document: DiagramDocument, raw: string): Promise<IntentResult> {
  const result = interpretIntent(document, raw);
  if (result.changed && result.requiresLayout) {
    return { ...result, document: await layoutDiagram(result.document) };
  }
  return result;
}