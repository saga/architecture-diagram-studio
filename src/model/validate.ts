import type { DiagramDocument } from './diagram';

export interface ValidationIssue {
  code: string;
  message: string;
  elementId?: string;
  severity: 'error' | 'warning';
}

/** Validate the semantic graph before layout or export. Never silently discard invalid references. */
export function validateDiagram(doc: DiagramDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of doc.nodes) {
    if (!node.id.trim()) issues.push({ code: 'NODE_ID_EMPTY', message: 'A node has an empty ID.', severity: 'error' });
    if (ids.has(node.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate element ID "${node.id}".`, elementId: node.id, severity: 'error' });
    ids.add(node.id);
    if (!node.label.trim()) issues.push({ code: 'NODE_LABEL_EMPTY', message: `Node "${node.id}" has no label.`, elementId: node.id, severity: 'warning' });
    if (!doc.layout[node.id]) issues.push({ code: 'LAYOUT_MISSING', message: `Node "${node.id}" has no saved geometry; default geometry will be used.`, elementId: node.id, severity: 'warning' });
  }
  for (const relation of doc.relations) {
    if (!relation.id.trim()) issues.push({ code: 'RELATION_ID_EMPTY', message: 'A relation has an empty ID.', severity: 'error' });
    if (ids.has(relation.id)) issues.push({ code: 'DUPLICATE_ID', message: `Duplicate element ID "${relation.id}".`, elementId: relation.id, severity: 'error' });
    ids.add(relation.id);
    if (!doc.nodes.some(node => node.id === relation.sourceId)) issues.push({ code: 'SOURCE_NOT_FOUND', message: `Relation "${relation.id}" refers to missing source "${relation.sourceId}".`, elementId: relation.id, severity: 'error' });
    if (!doc.nodes.some(node => node.id === relation.targetId)) issues.push({ code: 'TARGET_NOT_FOUND', message: `Relation "${relation.id}" refers to missing target "${relation.targetId}".`, elementId: relation.id, severity: 'error' });
    if (relation.sourceId === relation.targetId) issues.push({ code: 'SELF_RELATION', message: `Relation "${relation.id}" connects an element to itself.`, elementId: relation.id, severity: 'warning' });
  }
  return issues;
}
