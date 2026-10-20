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

export interface DiagramDocument {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: DiagramKind;
  nodes: DiagramNode[];
  relations: DiagramRelation[];
  layout: Record<string, NodeLayout>;
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
    customer: { x: 50, y: 170, width: 170, height: 84 },
    web: { x: 310, y: 170, width: 190, height: 84 },
    api: { x: 600, y: 170, width: 190, height: 84 },
    db: { x: 900, y: 80, width: 190, height: 84 },
    payment: { x: 900, y: 280, width: 190, height: 84 }
  }
};
