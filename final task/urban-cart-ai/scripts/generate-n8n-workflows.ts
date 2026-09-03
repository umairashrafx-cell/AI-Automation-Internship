/**
 * Emit the seven n8n workflow JSON files into n8n/workflows/.
 *
 *   npm run n8n:generate
 *
 * Why generated rather than hand-written: n8n workflow JSON is verbose and
 * every workflow repeats the same auth headers, the same error branch and the
 * same safe-fallback response. Building them from shared helpers keeps those
 * identical across all seven, which is exactly the property you want in an
 * error-handling convention. The emitted .json files are the deliverable and
 * are imported into n8n as-is.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../backend/src/config/env.ts';

const OUT_DIR = join(PROJECT_ROOT, 'n8n', 'workflows');

/* -------------------------------------------------------------------------- */
/* Node builders                                                              */
/* -------------------------------------------------------------------------- */

interface N8nNode {
  parameters: Record<string, unknown>;
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  credentials?: Record<string, unknown>;
  onError?: string;
  continueOnFail?: boolean;
  notesInFlow?: boolean;
  notes?: string;
}

let idCounter = 0;
/** Deterministic ids so regenerating produces a clean diff. */
function nodeId(name: string): string {
  idCounter += 1;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}-${String(idCounter).padStart(3, '0')}`;
}

function webhook(name: string, path: string, x: number, y: number, notes?: string): N8nNode {
  return {
    parameters: {
      httpMethod: 'POST',
      path,
      responseMode: 'responseNode',
      options: { rawBody: false },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [x, y],
    ...(notes ? { notes, notesInFlow: true } : {}),
  };
}

function code(name: string, jsCode: string, x: number, y: number, notes?: string): N8nNode {
  return {
    parameters: { jsCode },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [x, y],
    ...(notes ? { notes, notesInFlow: true } : {}),
  };
}

function ifNode(
  name: string,
  leftValue: string,
  operator: { type: string; operation: string },
  rightValue: unknown,
  x: number,
  y: number,
): N8nNode {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: nodeId(`${name}-cond`),
            leftValue,
            rightValue,
            operator,
          },
        ],
        combinator: 'and',
      },
      looseTypeValidation: true,
      options: {},
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [x, y],
  };
}

/**
 * HTTP call to the UrbanCart backend.
 * `onError: continueRegularOutput` matters: a 5xx must flow to our own error
 * branch so the customer still gets a safe reply, instead of n8n aborting the
 * execution and leaving the webhook hanging until it times out.
 */
function backendCall(
  name: string,
  endpoint: string,
  bodyExpression: string,
  x: number,
  y: number,
  notes?: string,
): N8nNode {
  return {
    parameters: {
      method: 'POST',
      url: `={{ $env.URBANCART_API_URL }}${endpoint}`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-API-Key', value: '={{ $env.URBANCART_API_KEY }}' },
          { name: 'X-Correlation-Id', value: '={{ $execution.id }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpression,
      options: {
        timeout: 30000,
        response: { response: { neverError: true, fullResponse: true } },
      },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, y],
    onError: 'continueRegularOutput',
    ...(notes ? { notes, notesInFlow: true } : {}),
  };
}

function respond(name: string, responseBody: string, x: number, y: number, code = 200): N8nNode {
  return {
    parameters: {
      respondWith: 'json',
      responseBody,
      options: { responseCode: code },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position: [x, y],
  };
}

/** Report a failure to the backend, which logs it and alerts Slack. */
function reportError(name: string, workflowLabel: string, x: number, y: number): N8nNode {
  return {
    parameters: {
      method: 'POST',
      url: '={{ $env.URBANCART_API_URL }}/api/webhooks/workflow-error',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'X-Signature', value: '={{ $env.URBANCART_WEBHOOK_SIGNATURE }}' },
          { name: 'Content-Type', value: 'application/json' },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify({ workflow: ${JSON.stringify(workflowLabel)}, errorCode: 'N8N_STEP_FAILED', errorMessage: ($json.error && $json.error.message) || $json.statusCode + ' from backend', execution: { id: $execution.id } }) }}`,
      options: { timeout: 10000, response: { response: { neverError: true } } },
    },
    id: nodeId(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [x, y],
    onError: 'continueRegularOutput',
  };
}

function connect(...pairs: Array<[string, string, number?]>): Record<string, unknown> {
  const connections: Record<string, { main: Array<Array<{ node: string; type: string; index: number }>> }> = {};
  for (const [from, to, outputIndex = 0] of pairs) {
    if (!connections[from]) connections[from] = { main: [] };
    const main = connections[from]!.main;
    while (main.length <= outputIndex) main.push([]);
    main[outputIndex]!.push({ node: to, type: 'main', index: 0 });
  }
  return connections;
}

interface Workflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  meta: Record<string, unknown>;
  tags: string[];
}

function workflow(
  name: string,
  nodes: N8nNode[],
  connections: Record<string, unknown>,
  tags: string[],
  errorWorkflowNote?: string,
): Workflow {
  return {
    name,
    nodes,
    connections,
    settings: {
      executionOrder: 'v1',
      saveManualExecutions: true,
      saveExecutionProgress: true,
      // Every workflow reports into Workflow 7.
      errorWorkflow: '',
      timezone: 'Asia/Karachi',
    },
    pinData: {},
    meta: {
      instanceId: 'urbancart-demo',
      description: errorWorkflowNote ?? '',
    },
    tags,
  };
}

/* ========================================================================== */
/* Workflow 1 - Customer Chat Request                                         */
/* ========================================================================== */

function workflow1(): Workflow {
  const nodes = [
    webhook(
      'Chat Webhook',
      'urbancart/chat',
      -520,
      300,
      'POST /webhook/urbancart/chat\nBody: { message, sessionId, channel, phone?, name? }',
    ),
    code(
      'Validate Input',
      `// Validate and normalise before any expensive work happens.
const body = $input.first().json.body ?? $input.first().json;
const errors = [];

const message = typeof body.message === 'string' ? body.message.trim() : '';
if (!message) errors.push('message is required');
if (message.length > 4000) errors.push('message exceeds 4000 characters');

const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim()
  ? body.sessionId.trim()
  : 'n8n-' + $execution.id;

const allowedChannels = ['web_chat', 'whatsapp', 'instagram', 'voice', 'email'];
const channel = allowedChannels.includes(body.channel) ? body.channel : 'web_chat';

return [{
  json: {
    valid: errors.length === 0,
    errors,
    message,
    sessionId,
    channel,
    phone: body.phone ?? null,
    name: body.name ?? null,
    correlationId: $execution.id,
  },
}];`,
      -300,
      300,
      'Reject malformed input here so it never reaches the database.',
    ),
    ifNode('Input Valid?', '={{ $json.valid }}', { type: 'boolean', operation: 'true', singleValue: true } as never, true, -80, 300),
    backendCall(
      'Backend: Process Chat Turn',
      '/api/chat',
      '={{ JSON.stringify({ message: $json.message, sessionId: $json.sessionId, channel: $json.channel, phone: $json.phone, name: $json.name }) }}',
      160,
      200,
      'The backend performs intent classification, customer lookup, RAG retrieval, grounded generation and escalation.',
    ),
    ifNode('Backend OK?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, 380, 200),
    respond(
      'Respond: Answer',
      '={{ JSON.stringify({ success: true, reply: $json.body.data.reply, intent: $json.body.data.intent, confidence: $json.body.data.confidence, escalated: $json.body.data.escalated, requiresHuman: $json.body.data.requiresHuman, sources: $json.body.data.sources, conversationId: $json.body.data.conversationId }) }}',
      620,
      120,
    ),
    reportError('Report Failure', 'Workflow 1 - Customer Chat Request', 620, 300),
    respond(
      'Respond: Safe Fallback',
      `={{ JSON.stringify({ success: false, reply: "I'm sorry, I'm having trouble answering that right now. I've let our team know and a human agent will follow up with you shortly.", requiresHuman: true }) }}`,
      860,
      300,
      200,
    ),
    respond(
      'Respond: Validation Error',
      '={{ JSON.stringify({ success: false, reply: "I didn\'t quite catch that. Could you rephrase it for me?", errors: $json.errors }) }}',
      160,
      440,
      400,
    ),
  ];

  return workflow(
    'UrbanCart 1 - Customer Chat Request',
    nodes,
    connect(
      ['Chat Webhook', 'Validate Input'],
      ['Validate Input', 'Input Valid?'],
      ['Input Valid?', 'Backend: Process Chat Turn', 0],
      ['Input Valid?', 'Respond: Validation Error', 1],
      ['Backend: Process Chat Turn', 'Backend OK?'],
      ['Backend OK?', 'Respond: Answer', 0],
      ['Backend OK?', 'Report Failure', 1],
      ['Report Failure', 'Respond: Safe Fallback'],
    ),
    ['urbancart', 'chat', 'customer-facing'],
    'Entry point for website chat and WhatsApp. Always answers, even on failure.',
  );
}

/* ========================================================================== */
/* Workflow 2 - Voice Request (Vapi)                                          */
/* ========================================================================== */

function workflow2(): Workflow {
  const nodes = [
    webhook(
      'Vapi Webhook',
      'urbancart/voice',
      -520,
      300,
      'Vapi server URL. Receives tool-calls, transcripts and end-of-call reports.',
    ),
    code(
      'Verify + Route Vapi Message',
      `// Vapi sends every call event to one URL. Only tool calls need work;
// the rest are acknowledged so Vapi does not retry them.
const payload = $input.first().json.body ?? $input.first().json;
const headers = $input.first().json.headers ?? {};

// Shared-secret check. Vapi sets this header on every server request.
const expected = $env.VAPI_WEBHOOK_SECRET;
if (expected && headers['x-vapi-secret'] !== expected) {
  return [{ json: { authorised: false, actionable: false, reason: 'bad x-vapi-secret' } }];
}

const message = payload.message ?? {};
const actionable = message.type === 'tool-calls' || message.type === 'function-call';

return [{
  json: {
    authorised: true,
    actionable,
    type: message.type ?? 'unknown',
    callId: message.call?.id ?? null,
    callerPhone: message.call?.customer?.number ?? null,
    payload,
  },
}];`,
      -300,
      300,
    ),
    ifNode('Authorised?', '={{ $json.authorised }}', { type: 'boolean', operation: 'true', singleValue: true } as never, true, -80, 300),
    ifNode('Tool Call?', '={{ $json.actionable }}', { type: 'boolean', operation: 'true', singleValue: true } as never, true, 140, 220),
    backendCall(
      'Backend: Execute Voice Tool',
      '/api/voice/vapi',
      '={{ JSON.stringify($json.payload) }}',
      380,
      140,
      'The backend resolves each tool call against PostgreSQL / the vector store and returns speakable results.',
    ),
    ifNode('Tool OK?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, 600, 140),
    respond('Respond: Tool Results', '={{ JSON.stringify($json.body) }}', 840, 60),
    reportError('Report Voice Failure', 'Workflow 2 - Voice Request', 840, 220),
    respond(
      'Respond: Voice Fallback',
      `={{ JSON.stringify({ results: [{ toolCallId: 'unknown', result: "I'm sorry, I can't check that at the moment. Let me pass you to a colleague who can help." }] }) }}`,
      1080,
      220,
      200,
    ),
    respond('Respond: Acknowledged', '={{ JSON.stringify({ received: true }) }}', 380, 340, 200),
    respond('Respond: Unauthorised', '={{ JSON.stringify({ error: "unauthorised" }) }}', 140, 460, 401),
  ];

  return workflow(
    'UrbanCart 2 - Voice Request (Vapi)',
    nodes,
    connect(
      ['Vapi Webhook', 'Verify + Route Vapi Message'],
      ['Verify + Route Vapi Message', 'Authorised?'],
      ['Authorised?', 'Tool Call?', 0],
      ['Authorised?', 'Respond: Unauthorised', 1],
      ['Tool Call?', 'Backend: Execute Voice Tool', 0],
      ['Tool Call?', 'Respond: Acknowledged', 1],
      ['Backend: Execute Voice Tool', 'Tool OK?'],
      ['Tool OK?', 'Respond: Tool Results', 0],
      ['Tool OK?', 'Report Voice Failure', 1],
      ['Report Voice Failure', 'Respond: Voice Fallback'],
    ),
    ['urbancart', 'voice', 'vapi'],
    'Vapi tool backend. Never returns a non-2xx to Vapi mid-call.',
  );
}

/* ========================================================================== */
/* Workflow 3 - Lead Creation                                                 */
/* ========================================================================== */

function workflow3(): Workflow {
  const nodes = [
    webhook(
      'Lead Webhook',
      'urbancart/lead',
      -560,
      300,
      'Body: { name, phone, product, budget?, location?, purchaseIntent?, source }',
    ),
    code(
      'Validate Lead Fields',
      `// The six fields the client asked to capture.
const body = $input.first().json.body ?? $input.first().json;
const errors = [];

const name = (body.name ?? '').toString().trim();
const product = (body.product ?? '').toString().trim();
let phone = (body.phone ?? '').toString().replace(/[^\\d+]/g, '');

if (name.length < 2) errors.push('name is required');
if (!product) errors.push('product is required');

// Normalise Pakistani numbers to E.164 so the same customer is one record
// whether they called, messaged on WhatsApp or filled in the web form.
if (phone.startsWith('00')) phone = '+' + phone.slice(2);
if (!phone.startsWith('+')) {
  const digits = phone.replace(/\\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) phone = '+92' + digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('92')) phone = '+' + digits;
  else if (digits.length === 10) phone = '+92' + digits;
}
if (!/^\\+[1-9]\\d{7,14}$/.test(phone)) errors.push('a valid phone number is required');

// Budget may arrive as "Rs. 200,000", "2 lakh" or 200000.
let budget = null;
const raw = (body.budget ?? '').toString().toLowerCase();
if (raw) {
  const lakh = raw.match(/([\\d.]+)\\s*(lakh|lac)/);
  const k = raw.match(/([\\d.]+)\\s*k\\b/);
  if (lakh) budget = Math.round(parseFloat(lakh[1]) * 100000);
  else if (k) budget = Math.round(parseFloat(k[1]) * 1000);
  else {
    const n = raw.replace(/[^\\d.]/g, '');
    if (n) budget = Math.round(parseFloat(n));
  }
}

return [{
  json: {
    valid: errors.length === 0,
    errors,
    name, phone, product, budget,
    location: body.location ?? null,
    purchaseIntent: ['ready_to_buy','considering','browsing'].includes(body.purchaseIntent)
      ? body.purchaseIntent : 'considering',
    source: body.source ?? 'web_chat',
  },
}];`,
      -340,
      300,
      'Phone normalisation happens here AND in the backend - n8n gives a fast rejection, the backend is the authority.',
    ),
    ifNode('Lead Valid?', '={{ $json.valid }}', { type: 'boolean', operation: 'true', singleValue: true } as never, true, -100, 300),
    backendCall(
      'Backend: Create Lead',
      '/api/tools/createLead',
      '={{ JSON.stringify({ name: $json.name, phone: $json.phone, product: $json.product, budget: $json.budget, location: $json.location, purchaseIntent: $json.purchaseIntent, source: $json.source }) }}',
      140,
      200,
      'Backend performs: find-or-create customer, duplicate check, lead scoring, PostgreSQL write, Airtable mirror, Slack notification when high value, and the Zapier hand-off.',
    ),
    ifNode('Lead Created?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, 380, 200),
    code(
      'Summarise Outcome',
      `// Surface what actually happened so the caller can tell the customer.
const body = $json.body ?? {};
const data = body.data ?? {};
return [{
  json: {
    success: true,
    leadReference: data.lead?.reference ?? null,
    duplicate: data.duplicate === true,
    leadScore: data.scoring?.score ?? null,
    highValue: data.scoring?.isHighValue === true,
    salesNotified: data.notifications?.slack?.sent === true,
    salesNotificationDryRun: data.notifications?.slack?.dryRun === true,
    airtableMirrored: data.notifications?.airtable?.sent === true,
    zapierTriggered: data.notifications?.zapier?.sent === true,
  },
}];`,
      600,
      120,
    ),
    respond('Respond: Lead Result', '={{ JSON.stringify($json) }}', 840, 120),
    reportError('Report Lead Failure', 'Workflow 3 - Lead Creation', 600, 300),
    respond(
      'Respond: Lead Fallback',
      `={{ JSON.stringify({ success: false, message: "Thanks - I've taken your details and our sales team will follow up with you shortly." }) }}`,
      840,
      300,
      200,
    ),
    respond(
      'Respond: Missing Fields',
      '={{ JSON.stringify({ success: false, errors: $json.errors, message: "I still need a few details before I can pass this to our sales team." }) }}',
      140,
      440,
      400,
    ),
  ];

  return workflow(
    'UrbanCart 3 - Lead Creation',
    nodes,
    connect(
      ['Lead Webhook', 'Validate Lead Fields'],
      ['Validate Lead Fields', 'Lead Valid?'],
      ['Lead Valid?', 'Backend: Create Lead', 0],
      ['Lead Valid?', 'Respond: Missing Fields', 1],
      ['Backend: Create Lead', 'Lead Created?'],
      ['Lead Created?', 'Summarise Outcome', 0],
      ['Lead Created?', 'Report Lead Failure', 1],
      ['Summarise Outcome', 'Respond: Lead Result'],
      ['Report Lead Failure', 'Respond: Lead Fallback'],
    ),
    ['urbancart', 'sales', 'lead'],
    'Lead capture with de-duplication, scoring and selective Slack notification.',
  );
}

/* ========================================================================== */
/* Workflow 4 - Order Lookup                                                  */
/* ========================================================================== */

function workflow4(): Workflow {
  const nodes = [
    webhook('Order Webhook', 'urbancart/order-status', -520, 300, 'Body: { orderNumber, phone?, name? }'),
    code(
      'Extract + Validate Order Number',
      `// Accept "UC-10452", "uc10452" or a whole sentence containing it.
const body = $input.first().json.body ?? $input.first().json;
const raw = (body.orderNumber ?? body.message ?? '').toString();

const match = raw.match(/\\bUC[-\\s]?(\\d{5})\\b/i);
const orderNumber = match ? 'UC-' + match[1] : null;

return [{
  json: {
    valid: orderNumber !== null,
    orderNumber,
    phone: body.phone ?? null,
    name: body.name ?? null,
  },
}];`,
      -300,
      300,
    ),
    ifNode('Order Number Valid?', '={{ $json.valid }}', { type: 'boolean', operation: 'true', singleValue: true } as never, true, -60, 300),
    backendCall(
      'Backend: Get Order Status',
      '/api/tools/getOrderStatus',
      '={{ JSON.stringify({ orderNumber: $json.orderNumber, phone: $json.phone, name: $json.name }) }}',
      180,
      200,
      'The backend verifies ownership (phone or name on the order) before returning anything, and redacts the street address.',
    ),
    ifNode('Lookup OK?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, 420, 200),
    code(
      'Shape Order Response',
      `const data = ($json.body ?? {}).data ?? {};
// 'found' is the only outcome that carries order data. The other outcomes
// (not_found, verification_required, invalid_format) carry only a safe message.
return [{
  json: {
    success: true,
    outcome: data.outcome,
    message: data.message,
    order: data.outcome === 'found' ? {
      orderNumber: data.order?.orderNumber,
      status: data.order?.status,
      orderDate: data.order?.orderDate,
      expectedDelivery: data.order?.expectedDelivery,
      items: data.order?.items ?? [],
      courier: data.order?.courier,
      trackingNumber: data.order?.trackingNumber,
    } : null,
    needsAttention: data.needsAttention === true,
  },
}];`,
      640,
      120,
    ),
    respond('Respond: Order Status', '={{ JSON.stringify($json) }}', 880, 120),
    reportError('Report Order Failure', 'Workflow 4 - Order Lookup', 640, 300),
    respond(
      'Respond: Order Fallback',
      `={{ JSON.stringify({ success: false, message: "I can't reach our order system at the moment. I've flagged it and our support team will check this for you." }) }}`,
      880,
      300,
      200,
    ),
    respond(
      'Respond: Bad Order Number',
      `={{ JSON.stringify({ success: false, message: "That order number doesn't look like one of ours. UrbanCart order numbers look like UC-10452. Could you double-check it?" }) }}`,
      180,
      440,
      400,
    ),
  ];

  return workflow(
    'UrbanCart 4 - Order Lookup',
    nodes,
    connect(
      ['Order Webhook', 'Extract + Validate Order Number'],
      ['Extract + Validate Order Number', 'Order Number Valid?'],
      ['Order Number Valid?', 'Backend: Get Order Status', 0],
      ['Order Number Valid?', 'Respond: Bad Order Number', 1],
      ['Backend: Get Order Status', 'Lookup OK?'],
      ['Lookup OK?', 'Shape Order Response', 0],
      ['Lookup OK?', 'Report Order Failure', 1],
      ['Shape Order Response', 'Respond: Order Status'],
      ['Report Order Failure', 'Respond: Order Fallback'],
    ),
    ['urbancart', 'orders'],
    'Order status with ownership verification.',
  );
}

/* ========================================================================== */
/* Workflow 5 - Complaint / Escalation                                        */
/* ========================================================================== */

function workflow5(): Workflow {
  const nodes = [
    webhook('Escalation Webhook', 'urbancart/escalate', -560, 300, 'Body: { description, phone?, orderNumber?, conversationId? }'),
    code(
      'Detect Escalation Reason',
      `// Classify the complaint so the right team and priority are chosen.
const body = $input.first().json.body ?? $input.first().json;
const text = (body.description ?? body.message ?? '').toString();
const lower = text.toLowerCase();

const has = (terms) => terms.some((t) => lower.includes(t));

const damaged = has(['damaged','damage','broken','cracked','shattered','defective','faulty','not working']);
const refund  = has(['refund','money back','reimburse','compensation']);
const angry   = has(['angry','furious','ridiculous','unacceptable','worst','terrible','pathetic','useless','fed up','scam','fraud','third time','still waiting'])
                || (text.length > 15 && text === text.toUpperCase());
const human   = has(['speak to a human','talk to a human','real person','human agent','manager','supervisor','representative']);

let reason = 'missing_information';
if (damaged) reason = 'damaged_product';
else if (angry) reason = 'angry_customer';
else if (refund) reason = 'complex_refund';
else if (human) reason = 'customer_requested_human';

const orderMatch = text.match(/\\bUC[-\\s]?(\\d{5})\\b/i);

return [{
  json: {
    reason,
    description: text.slice(0, 2000),
    phone: body.phone ?? null,
    conversationId: body.conversationId ?? null,
    orderNumber: body.orderNumber ?? (orderMatch ? 'UC-' + orderMatch[1] : null),
    signals: { damaged, refund, angry, human },
  },
}];`,
      -340,
      300,
    ),
    backendCall(
      'Backend: Escalate To Human',
      '/api/tools/escalateToHuman',
      '={{ JSON.stringify({ reason: $json.reason, description: $json.description, phone: $json.phone, conversationId: $json.conversationId, orderNumber: $json.orderNumber }) }}',
      -80,
      300,
      'Backend creates the support ticket AND the task in one transaction, mirrors to Airtable, and posts the high-priority Slack alert.',
    ),
    ifNode('Escalation OK?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, 180, 300),
    code(
      'Shape Escalation Response',
      `const data = ($json.body ?? {}).data ?? {};
return [{
  json: {
    success: true,
    ticket: data.ticket?.reference ?? null,
    task: data.task?.reference ?? null,
    priority: data.priority ?? null,
    assignedTeam: data.ticket?.assignedTeam ?? null,
    supportNotified: data.notified?.slack === true,
    notificationDryRun: data.notified?.dryRun === true,
    // The polite, non-technical message to show or speak to the customer.
    customerMessage: data.customerMessage,
  },
}];`,
      420,
      220,
    ),
    respond('Respond: Escalated', '={{ JSON.stringify($json) }}', 660, 220),
    reportError('Report Escalation Failure', 'Workflow 5 - Complaint / Escalation', 420, 400),
    respond(
      'Respond: Escalation Fallback',
      `={{ JSON.stringify({ success: false, customerMessage: "I'm sorry about this. I've recorded your issue and a member of our support team will contact you shortly." }) }}`,
      660,
      400,
      200,
    ),
  ];

  return workflow(
    'UrbanCart 5 - Complaint and Escalation',
    nodes,
    connect(
      ['Escalation Webhook', 'Detect Escalation Reason'],
      ['Detect Escalation Reason', 'Backend: Escalate To Human'],
      ['Backend: Escalate To Human', 'Escalation OK?'],
      ['Escalation OK?', 'Shape Escalation Response', 0],
      ['Escalation OK?', 'Report Escalation Failure', 1],
      ['Shape Escalation Response', 'Respond: Escalated'],
      ['Report Escalation Failure', 'Respond: Escalation Fallback'],
    ),
    ['urbancart', 'support', 'escalation'],
    'Damaged goods, complex refunds, angry customers and explicit handoff requests.',
  );
}

/* ========================================================================== */
/* Workflow 6 - RAG Document Ingestion                                        */
/* ========================================================================== */

function workflow6(): Workflow {
  const nodes = [
    {
      parameters: {
        pollTimes: { item: [{ mode: 'everyX', value: 15, unit: 'minutes' }] },
        triggerOn: 'specificFolder',
        folderToWatch: '={{ $env.GOOGLE_DRIVE_FOLDER_ID }}',
        event: 'fileUpdated',
        options: {},
      },
      id: nodeId('Drive: File Changed'),
      name: 'Drive: File Changed',
      type: 'n8n-nodes-base.googleDriveTrigger',
      typeVersion: 1,
      position: [-620, 220],
      notes:
        'Watches "UrbanCart Knowledge Base". Fires when a policy PDF, Word document or spreadsheet is added or updated. Business staff publish by dropping a file in a folder - no developer involvement.',
      notesInFlow: true,
    } as N8nNode,
    {
      parameters: {
        rule: { interval: [{ field: 'hours', hoursInterval: 6 }] },
      },
      id: nodeId('Safety Net: Every 6h'),
      name: 'Safety Net: Every 6h',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: [-620, 420],
      notes:
        'Drive change notifications can be missed. A periodic full pass is cheap because ingestion is content-hashed: unchanged files are skipped and cost no embedding calls.',
      notesInFlow: true,
    } as N8nNode,
    backendCall(
      'Backend: Run Ingestion',
      '/api/knowledge/ingest',
      '={{ JSON.stringify({ source: $env.GOOGLE_DRIVE_FOLDER_ID ? "google_drive" : "local", force: false }) }}',
      -320,
      320,
      'Pipeline: detect changes -> download -> extract text (PDF/DOCX/XLSX) -> clean -> chunk -> embed -> store vectors in Supabase. Idempotent.',
    ),
    ifNode('Ingestion OK?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, -80, 320),
    code(
      'Summarise Ingestion',
      `const data = ($json.body ?? {}).data ?? {};
const failed = (data.files ?? []).filter((f) => f.action === 'failed');
return [{
  json: {
    processed: data.processed ?? 0,
    created: data.created ?? 0,
    updated: data.updated ?? 0,
    skipped: data.skipped ?? 0,
    failed: data.failed ?? 0,
    totalChunks: data.totalChunks ?? 0,
    failedFiles: failed.map((f) => ({ filename: f.filename, error: f.error })),
    // Only a change or a failure is worth a human's attention.
    worthReporting: (data.created ?? 0) + (data.updated ?? 0) + (data.failed ?? 0) > 0,
    anyFailed: (data.failed ?? 0) > 0,
  },
}];`,
      160,
      240,
    ),
    ifNode('Any Document Failed?', '={{ $json.anyFailed }}', { type: 'boolean', operation: 'true', singleValue: true } as never, true, 400, 240),
    {
      parameters: {
        method: 'POST',
        url: '={{ $env.URBANCART_API_URL }}/api/webhooks/workflow-error',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'X-Signature', value: '={{ $env.URBANCART_WEBHOOK_SIGNATURE }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ workflow: 'RAG Document Ingestion', errorCode: 'DOCUMENT_PROCESSING_ERROR', subject: ($json.failedFiles[0] || {}).filename, errorMessage: ($json.failedFiles || []).map(f => f.filename + ': ' + f.error).join('; '), execution: { id: $execution.id } }) }}",
        options: { timeout: 10000, response: { response: { neverError: true } } },
      },
      id: nodeId('Alert: Ingestion Failed'),
      name: 'Alert: Ingestion Failed',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [640, 160],
      onError: 'continueRegularOutput',
      notes: 'Produces the "⚠️ Automation Failed" Slack alert naming the document.',
      notesInFlow: true,
    } as N8nNode,
    code(
      'Log Success',
      `console.log('RAG ingestion complete', JSON.stringify($json));
return [$input.first()];`,
      640,
      340,
    ),
    reportError('Report Ingestion Failure', 'Workflow 6 - RAG Document Ingestion', 160, 460),
  ];

  return workflow(
    'UrbanCart 6 - RAG Document Ingestion',
    nodes,
    connect(
      ['Drive: File Changed', 'Backend: Run Ingestion'],
      ['Safety Net: Every 6h', 'Backend: Run Ingestion'],
      ['Backend: Run Ingestion', 'Ingestion OK?'],
      ['Ingestion OK?', 'Summarise Ingestion', 0],
      ['Ingestion OK?', 'Report Ingestion Failure', 1],
      ['Summarise Ingestion', 'Any Document Failed?'],
      ['Any Document Failed?', 'Alert: Ingestion Failed', 0],
      ['Any Document Failed?', 'Log Success', 1],
    ),
    ['urbancart', 'rag', 'knowledge-base'],
    'Keeps the AI knowledge base in step with Google Drive without any code change.',
  );
}

/* ========================================================================== */
/* Workflow 7 - Centralised Error Handling                                    */
/* ========================================================================== */

function workflow7(): Workflow {
  const nodes = [
    {
      parameters: {},
      id: nodeId('Error Trigger'),
      name: 'Error Trigger',
      type: 'n8n-nodes-base.errorTrigger',
      typeVersion: 1,
      position: [-600, 300],
      notes:
        'Set this workflow as the "Error Workflow" in every other workflow\'s settings. n8n then routes any unhandled failure here.',
      notesInFlow: true,
    } as N8nNode,
    code(
      'Normalise Error',
      `// One consistent error shape regardless of which workflow failed.
const e = $input.first().json;
const workflowName = e.workflow?.name ?? 'unknown workflow';
const message = e.execution?.error?.message ?? e.error?.message ?? 'no message';
const stack = e.execution?.error?.stack ?? '';
const node = e.execution?.lastNodeExecuted ?? 'unknown node';

// Classify so the alert says something more useful than "it broke".
let errorCode = 'N8N_EXECUTION_FAILED';
const lower = message.toLowerCase();
if (lower.includes('timeout') || lower.includes('etimedout')) errorCode = 'UPSTREAM_TIMEOUT';
else if (lower.includes('econnrefused')) errorCode = 'BACKEND_UNREACHABLE';
else if (lower.includes('401') || lower.includes('unauthor')) errorCode = 'AUTH_FAILED';
else if (lower.includes('429')) errorCode = 'RATE_LIMITED';
else if (lower.includes('embedding')) errorCode = 'EMBEDDING_FAILED';

return [{
  json: {
    workflow: workflowName,
    node,
    errorCode,
    // Never surfaced to a customer - this goes to the alerts channel only.
    errorMessage: (message + (stack ? ' | ' + stack.split('\\n')[0] : '')).slice(0, 1500),
    executionId: e.execution?.id ?? null,
    executionUrl: e.execution?.url ?? null,
    failedAt: new Date().toISOString(),
  },
}];`,
      -360,
      300,
    ),
    {
      parameters: {
        method: 'POST',
        url: '={{ $env.URBANCART_API_URL }}/api/webhooks/workflow-error',
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'X-Signature', value: '={{ $env.URBANCART_WEBHOOK_SIGNATURE }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          '={{ JSON.stringify({ workflow: $json.workflow, errorCode: $json.errorCode, errorMessage: $json.errorMessage, subject: $json.node, execution: { id: $json.executionId } }) }}',
        options: { timeout: 10000, response: { response: { neverError: true, fullResponse: true } } },
      },
      id: nodeId('Backend: Log + Alert'),
      name: 'Backend: Log + Alert',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [-120, 300],
      onError: 'continueRegularOutput',
      notes:
        'The backend writes workflow_executions and posts the single "⚠️ Automation Failed" Slack alert. Centralising it here means one format and no duplicate pages.',
      notesInFlow: true,
    } as N8nNode,
    ifNode('Backend Reachable?', '={{ $json.statusCode }}', { type: 'number', operation: 'lt' }, 400, 140, 300),
    code(
      'Done',
      `console.log('Failure recorded and alerted:', JSON.stringify($json.body ?? {}));
return [$input.first()];`,
      400,
      220,
    ),
    {
      parameters: {
        select: 'channel',
        channelId: { __rl: true, value: '={{ $env.SLACK_CHANNEL_ALERTS }}', mode: 'name' },
        text: '=:rotating_light: *UrbanCart backend unreachable* — an n8n workflow failed AND the error webhook could not be delivered.\\n\\n*Workflow:* {{ $("Normalise Error").item.json.workflow }}\\n*Node:* {{ $("Normalise Error").item.json.node }}\\n*Error:* {{ $("Normalise Error").item.json.errorMessage }}\\n\\nThe backend API is probably down. Check it first.',
        otherOptions: {},
      },
      id: nodeId('Slack: Direct Alert'),
      name: 'Slack: Direct Alert (backend down)',
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.2,
      position: [400, 400],
      credentials: { slackApi: { id: 'REPLACE_WITH_SLACK_CREDENTIAL_ID', name: 'UrbanCart Slack' } },
      onError: 'continueRegularOutput',
      notes:
        'Last resort. If the backend is down it cannot alert anyone about itself, so this path posts to Slack directly from n8n.',
      notesInFlow: true,
    } as N8nNode,
  ];

  return workflow(
    'UrbanCart 7 - Centralised Error Handling',
    nodes,
    connect(
      ['Error Trigger', 'Normalise Error'],
      ['Normalise Error', 'Backend: Log + Alert'],
      ['Backend: Log + Alert', 'Backend Reachable?'],
      ['Backend Reachable?', 'Done', 0],
      ['Backend Reachable?', 'Slack: Direct Alert (backend down)', 1],
    ),
    ['urbancart', 'error-handling', 'operations'],
    'Set as the Error Workflow on all other UrbanCart workflows.',
  );
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const workflows: Array<[string, Workflow]> = [
    ['01-customer-chat-request.json', workflow1()],
    ['02-voice-request-vapi.json', workflow2()],
    ['03-lead-creation.json', workflow3()],
    ['04-order-lookup.json', workflow4()],
    ['05-complaint-escalation.json', workflow5()],
    ['06-rag-document-ingestion.json', workflow6()],
    ['07-error-handling.json', workflow7()],
  ];

  for (const [filename, wf] of workflows) {
    await writeFile(join(OUT_DIR, filename), `${JSON.stringify(wf, null, 2)}\n`, 'utf8');
    console.log(`  ${filename.padEnd(34)} ${wf.nodes.length} nodes`);
  }
  console.log(`\n${workflows.length} workflows written to n8n/workflows/`);
}

main().catch((err) => {
  console.error('Failed to generate n8n workflows:', err);
  process.exit(1);
});
