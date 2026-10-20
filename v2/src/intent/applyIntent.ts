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
      summary: "目前可直接执行：线条改虚线/实线、曲线改折线、External 放右侧、Storage 放底部、切换布局方向、重新排版、解除手动锁定。复杂的业务语义编辑需要接入模型服务。",
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