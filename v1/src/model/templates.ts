import { initialDiagram, type DiagramDocument, type DiagramKind } from './diagram';

const clone = <T,>(value: T): T => structuredClone(value);

export function createDiagramTemplate(kind: DiagramKind): DiagramDocument {
  if (kind === 'c4-container') {
    const doc = clone(initialDiagram);
    doc.title = 'Order Platform — C4 Container View';
    return doc;
  }

  if (kind === 'c4-context') {
    return {
      schemaVersion: 1,
      id: 'order-platform-context',
      title: 'Order Platform — C4 System Context',
      kind,
      nodes: [
        { id: 'customer', type: 'person', label: 'Customer', description: 'Places and tracks orders' },
        { id: 'order-platform', type: 'system', label: 'Order Platform', description: 'Places, tracks, and manages customer orders' },
        { id: 'payment', type: 'external', label: 'Payment Provider', description: 'Authorizes customer payments' },
        { id: 'identity', type: 'external', label: 'Identity Provider', description: 'Authenticates customers' },
      ],
      relations: [
        { id: 'context-customer-order', sourceId: 'customer', targetId: 'order-platform', label: 'Places and tracks orders' },
        { id: 'context-order-payment', sourceId: 'order-platform', targetId: 'payment', label: 'Authorizes payments' },
        { id: 'context-order-identity', sourceId: 'order-platform', targetId: 'identity', label: 'Authenticates customers' },
      ],
      layout: {
        customer: { x: 60, y: 220, width: 220, height: 112 },
        'order-platform': { x: 390, y: 205, width: 260, height: 130 },
        payment: { x: 800, y: 115, width: 230, height: 115 },
        identity: { x: 800, y: 330, width: 230, height: 115 },
      },
    };
  }

  if (kind === 'c4-component') {
    return {
      schemaVersion: 1,
      id: 'order-platform-components',
      title: 'Order API — C4 Component View',
      kind,
      nodes: [
        { id: 'web', type: 'system', label: 'Web Application', technology: 'React', description: 'Customer-facing order experience' },
        { id: 'controller', type: 'component', label: 'Order Controller', technology: 'HTTP / REST', description: 'Validates API requests and returns responses' },
        { id: 'service', type: 'component', label: 'Order Service', technology: 'TypeScript', description: 'Coordinates order lifecycle and business rules' },
        { id: 'payment-adapter', type: 'component', label: 'Payment Adapter', technology: 'HTTP client', description: 'Integrates with the external payment provider' },
        { id: 'repository', type: 'component', label: 'Order Repository', technology: 'SQL', description: 'Persists and queries orders' },
        { id: 'database', type: 'database', label: 'Order Database', technology: 'PostgreSQL' },
        { id: 'payment', type: 'external', label: 'Payment Provider', description: 'External payment system' },
      ],
      relations: [
        { id: 'component-web-controller', sourceId: 'web', targetId: 'controller', label: 'HTTPS / JSON' },
        { id: 'component-controller-service', sourceId: 'controller', targetId: 'service', label: 'Calls' },
        { id: 'component-service-adapter', sourceId: 'service', targetId: 'payment-adapter', label: 'Authorizes payment' },
        { id: 'component-service-repository', sourceId: 'service', targetId: 'repository', label: 'Reads / writes orders' },
        { id: 'component-repository-db', sourceId: 'repository', targetId: 'database', label: 'SQL' },
        { id: 'component-adapter-payment', sourceId: 'payment-adapter', targetId: 'payment', label: 'Payment API' },
      ],
      layout: {
        web: { x: 40, y: 210, width: 220, height: 112 },
        controller: { x: 330, y: 210, width: 220, height: 112 },
        service: { x: 640, y: 210, width: 220, height: 112 },
        'payment-adapter': { x: 970, y: 85, width: 220, height: 112 },
        repository: { x: 970, y: 330, width: 220, height: 112 },
        database: { x: 1275, y: 330, width: 220, height: 112 },
        payment: { x: 1275, y: 85, width: 220, height: 112 },
      },
      boundaries: [{
        id: 'order-api-component-boundary',
        label: 'Order API',
        description: 'Components inside the Order API container',
        memberNodeIds: ['controller', 'service', 'payment-adapter', 'repository'],
        x: 294,
        y: 47,
        width: 932,
        height: 440,
      }],
    };
  }

  return {
    schemaVersion: 1,
    id: 'order-platform-sequence',
    title: 'Place Order — UML Sequence Diagram',
    kind: 'sequence',
    nodes: [],
    relations: [],
    layout: {},
    sequence: {
      participants: [
        { id: 'customer', label: 'Customer', role: 'actor' },
        { id: 'web', label: 'Web Application', role: 'container', technology: 'React' },
        { id: 'api', label: 'Order API', role: 'container', technology: 'Node.js / TypeScript' },
        { id: 'database', label: 'Order Database', role: 'database', technology: 'PostgreSQL' },
        { id: 'payment', label: 'Payment Provider', role: 'external' },
      ],
      messages: [
        { id: 'msg-1', fromParticipantId: 'customer', toParticipantId: 'web', label: 'Place order', kind: 'call', order: 1 },
        { id: 'msg-2', fromParticipantId: 'web', toParticipantId: 'api', label: 'POST /orders', kind: 'call', order: 2 },
        { id: 'msg-3', fromParticipantId: 'api', toParticipantId: 'database', label: 'INSERT order', kind: 'call', order: 3 },
        { id: 'msg-4', fromParticipantId: 'database', toParticipantId: 'api', label: 'Order created', kind: 'return', order: 4 },
        { id: 'msg-5', fromParticipantId: 'api', toParticipantId: 'payment', label: 'Authorize payment', kind: 'call', order: 5 },
        { id: 'msg-6', fromParticipantId: 'payment', toParticipantId: 'api', label: 'Authorization result', kind: 'return', order: 6 },
        { id: 'msg-7', fromParticipantId: 'api', toParticipantId: 'web', label: '201 Created', kind: 'return', order: 7 },
        { id: 'msg-8', fromParticipantId: 'web', toParticipantId: 'customer', label: 'Show confirmation', kind: 'return', order: 8 },
      ],
      activations: [
        { participantId: 'web', startMessageId: 'msg-1', endMessageId: 'msg-8' },
        { participantId: 'api', startMessageId: 'msg-2', endMessageId: 'msg-7' },
        { participantId: 'database', startMessageId: 'msg-3', endMessageId: 'msg-4' },
        { participantId: 'payment', startMessageId: 'msg-5', endMessageId: 'msg-6' },
      ],
      fragments: [
        { id: 'fragment-payment', kind: 'opt', title: 'Optional payment authorization', guard: '[payment required]', startMessageId: 'msg-5', endMessageId: 'msg-6', participantStartId: 'api', participantEndId: 'payment' },
      ],
    },
  };
}
