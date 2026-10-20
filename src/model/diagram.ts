export type DiagramKind = 'c4-context' | 'c4-container' | 'c4-component' | 'sequence';

export interface DiagramNode {
  id: string;
  type: 'person' | 'system' | 'service' | 'component' | 'database' | 'external' | 'boundary';
  label: string;
  description?: string;
  technology?: string;
  parentId?: string;
  evidenceIds?: string[];
}

export interface DiagramRelation {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  kind?: 'sync' | 'async' | 'data';
  sourceHandleId?: string;
  targetHandleId?: string;
  evidenceIds?: string[];
  waypoints?: Array<{ x: number; y: number }>;
}

export type DiagramPortSide = 'LEFT' | 'RIGHT' | 'TOP' | 'BOTTOM';
export interface DiagramPortLayout { id: string; side: DiagramPortSide; x: number; y: number }
export interface NodeLayout { x: number; y: number; width: number; height: number; locked?: boolean; ports?: DiagramPortLayout[] }

export type SequenceMessageKind = 'call' | 'return' | 'async';
export interface SequenceParticipant {
  id: string;
  label: string;
  role: 'actor' | 'system' | 'container' | 'database' | 'external';
  technology?: string;
  description?: string;
}
export interface SequenceMessage {
  id: string;
  fromParticipantId: string;
  toParticipantId: string;
  label: string;
  kind: SequenceMessageKind;
  order: number;
}
export interface SequenceActivation {
  participantId: string;
  startMessageId: string;
  endMessageId: string;
}
export interface SequenceFragment {
  id: string;
  kind: 'alt' | 'opt' | 'loop' | 'par';
  title: string;
  guard?: string;
  startMessageId: string;
  endMessageId: string;
  participantStartId?: string;
  participantEndId?: string;
}
export interface SequenceDiagramData {
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  activations?: SequenceActivation[];
  fragments?: SequenceFragment[];
}

export interface DiagramBoundary {
  id: string;
  label: string;
  description?: string;
  memberNodeIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: DiagramKind;
  nodes: DiagramNode[];
  relations: DiagramRelation[];
  layout: Record<string, NodeLayout>;
  boundaries?: DiagramBoundary[];
  sequence?: SequenceDiagramData;
}

export const initialDiagram: DiagramDocument = {
  schemaVersion: 1,
  id: 'example-order-platform',
  title: 'Order Platform — Container View',
  kind: 'c4-container',
  nodes: [
    { id: 'customer', type: 'person', label: 'Customer', description: 'Places and tracks orders' },
    { id: 'web', type: 'service', label: 'Web Application', technology: 'React' },
    { id: 'api', type: 'service', label: 'Order API', technology: 'Node.js / TypeScript' },
    { id: 'db', type: 'database', label: 'Order Database', technology: 'PostgreSQL' },
    { id: 'payment', type: 'external', label: 'Payment Provider', description: 'External system' }
  ],
  relations: [
    { id: 'r1', sourceId: 'customer', targetId: 'web', label: 'Browses and places orders' },
    { id: 'r2', sourceId: 'web', targetId: 'api', label: 'HTTPS / JSON' },
    { id: 'r3', sourceId: 'api', targetId: 'db', label: 'SQL' },
    { id: 'r4', sourceId: 'api', targetId: 'payment', label: 'Authorizes payment' }
  ],
  layout: {
    customer: { x: 42, y: 200, width: 220, height: 112, ports: [{ id: 'out-r1', side: 'RIGHT', x: 220, y: 56 }] },
    web: { x: 360, y: 150, width: 220, height: 112, ports: [{ id: 'in-r1', side: 'LEFT', x: 0, y: 56 }, { id: 'out-r2', side: 'RIGHT', x: 220, y: 56 }] },
    api: { x: 670, y: 150, width: 220, height: 112, ports: [{ id: 'in-r2', side: 'LEFT', x: 0, y: 56 }, { id: 'out-r3', side: 'BOTTOM', x: 110, y: 112 }, { id: 'out-r4', side: 'RIGHT', x: 220, y: 40 }] },
    db: { x: 670, y: 340, width: 220, height: 112, ports: [{ id: 'in-r3', side: 'TOP', x: 110, y: 0 }] },
    payment: { x: 1050, y: 150, width: 220, height: 112, ports: [{ id: 'in-r4', side: 'LEFT', x: 0, y: 40 }] }
  },
  boundaries: [{
    id: 'order-platform-boundary',
    label: 'Order Platform',
    description: 'Software system boundary',
    memberNodeIds: ['web', 'api', 'db'],
    x: 315,
    y: 80,
    width: 650,
    height: 420
  }]
};
