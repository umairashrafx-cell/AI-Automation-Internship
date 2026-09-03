/**
 * HTTP layer tests: authentication, validation, error shape and the
 * guarantee that no internal detail ever reaches a client.
 *
 * The app is mounted on an ephemeral port with a real listener, so the full
 * middleware chain runs exactly as it does in production.
 */

// MUST be the first import: it sets the environment (including the test API
// keys that make the auth middleware enforce rather than fall back) before any
// application module reads the config.
import './helpers/env.ts';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { bootstrap, teardown } from './helpers/setup.ts';
import { createApp } from '../backend/src/app.ts';
import { signPayload } from '../backend/src/utils/misc.ts';

let server: Server;
let baseUrl = '';

const API_KEY = 'test-internal-key-do-not-use-in-production';

before(async () => {
  await bootstrap();
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await teardown();
});

async function call(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: response.status, json, headers: response.headers };
}

describe('health', () => {
  test('reports component status honestly', async () => {
    const res = await call('/health');
    assert.equal(res.status, 200);
    // Without real credentials the honest answer is "degraded", not "ok".
    assert.equal(res.json.status, 'degraded');
    assert.equal(res.json.checks.database.ok, true);
    assert.equal(res.json.checks.embeddings.semantic, false);
    assert.equal(res.json.integrations.slack, false);
  });

  test('stamps a correlation id on every response', async () => {
    const res = await call('/health');
    assert.ok(res.headers.get('x-correlation-id'), 'responses must be traceable');
  });

  test('echoes a caller-supplied correlation id', async () => {
    const res = await call('/health', { headers: { 'X-Correlation-Id': 'uc_caller_supplied' } });
    assert.equal(res.headers.get('x-correlation-id'), 'uc_caller_supplied');
  });
});

describe('public chat endpoint', () => {
  test('answers a valid request', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      body: { message: 'Is iPhone 15 available?', sessionId: 'api-test-1', channel: 'web_chat' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.success, true);
    assert.match(res.json.data.reply, /in stock/i);
  });

  test('rejects a missing message with a safe explanation', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      body: { sessionId: 'api-test-2' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.success, false);
    assert.equal(res.json.error.code, 'VALIDATION_ERROR');
    // The customer-facing message must not describe the schema.
    assert.ok(!/zod|schema|required|undefined/i.test(res.json.error.message));
  });

  test('strips unknown fields rather than passing them through', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      body: {
        message: 'Hello',
        sessionId: 'api-test-3',
        channel: 'web_chat',
        isAdmin: true,
        customerId: 'injected',
      },
    });
    // .strict() rejects unknown keys outright, which is the safer behaviour.
    assert.equal(res.status, 400);
  });

  test('normalises a local phone number', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      body: {
        message: 'Where is my order UC-10452?',
        sessionId: 'api-test-4',
        channel: 'whatsapp',
        phone: '03001234567',
      },
    });
    assert.equal(res.status, 200);
    assert.match(res.json.data.reply, /UC-10452/);
  });

  test('rejects an unparseable phone number', async () => {
    const res = await call('/api/chat', {
      method: 'POST',
      body: { message: 'Hello', sessionId: 'api-test-5', channel: 'web_chat', phone: '123' },
    });
    assert.equal(res.status, 400);
  });
});

describe('internal tool endpoints', () => {
  test('reject a request with no API key', async () => {
    const res = await call('/api/tools/searchProduct', {
      method: 'POST',
      body: { query: 'iPhone 15' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'UNAUTHORIZED');
  });

  test('reject a wrong API key', async () => {
    const res = await call('/api/tools/searchProduct', {
      method: 'POST',
      body: { query: 'iPhone 15' },
      headers: { 'X-API-Key': 'wrong-key' },
    });
    assert.equal(res.status, 401);
  });

  test('accept the correct API key', async () => {
    const res = await call('/api/tools/searchProduct', {
      method: 'POST',
      body: { query: 'iPhone 15' },
      headers: { 'X-API-Key': API_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.found, true);
    assert.equal(res.json.data.product.sku, 'UC-ELEC-001');
  });

  test('order lookup refuses to leak data to an unverified caller', async () => {
    const res = await call('/api/tools/getOrderStatus', {
      method: 'POST',
      body: { orderNumber: 'UC-10452', phone: '03009999999' },
      headers: { 'X-API-Key': API_KEY },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.outcome, 'verification_required');
    assert.equal(res.json.data.order, null, 'no order data may be returned');
  });

  test('order lookup succeeds for the verified owner', async () => {
    const res = await call('/api/tools/getOrderStatus', {
      method: 'POST',
      body: { orderNumber: 'UC-10452', phone: '03001234567' },
      headers: { 'X-API-Key': API_KEY },
    });
    assert.equal(res.json.data.outcome, 'found');
    assert.equal(res.json.data.order.status, 'delayed');
    // The street address must be shortened even for the verified owner.
    assert.ok(
      !res.json.data.order.deliveryAddress.includes('House 42'),
      'the full street address must not be returned',
    );
  });

  test('rejects a malformed order number before touching the database', async () => {
    const res = await call('/api/tools/getOrderStatus', {
      method: 'POST',
      body: { orderNumber: 'NOT-AN-ORDER' },
      headers: { 'X-API-Key': API_KEY },
    });
    assert.equal(res.status, 400);
  });

  test('createLead validates required fields', async () => {
    const res = await call('/api/tools/createLead', {
      method: 'POST',
      body: { name: 'X', phone: '03001112222', product: 'iPhone 15' },
      headers: { 'X-API-Key': API_KEY },
    });
    // name must be at least 2 characters
    assert.equal(res.status, 400);
  });

  test('createLead accepts a budget in any human format', async () => {
    const res = await call('/api/tools/createLead', {
      method: 'POST',
      body: {
        name: 'Api Test Customer',
        phone: '03007654321',
        product: 'Samsung Galaxy S24',
        budget: '2 lakh',
        location: 'Karachi',
        source: 'web_chat',
      },
      headers: { 'X-API-Key': API_KEY },
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.data.lead.budget, 200000);
    assert.equal(res.json.data.scoring.isHighValue, true);
  });
});

describe('vapi webhook', () => {
  test('rejects a request without the shared secret', async () => {
    const res = await call('/api/voice/vapi', {
      method: 'POST',
      body: { message: { type: 'tool-calls', toolCalls: [] } },
    });
    assert.equal(res.status, 401);
  });

  test('accepts a correctly-signed request', async () => {
    const res = await call('/api/voice/vapi', {
      method: 'POST',
      headers: { 'X-Vapi-Secret': 'test-vapi-secret' },
      body: {
        message: {
          type: 'tool-calls',
          call: { id: 'call_api_test', customer: { number: '+923001234567' } },
          toolCalls: [
            { id: 'tc_1', type: 'function', function: { name: 'searchProduct', arguments: { query: 'iPhone 15' } } },
          ],
        },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.results[0].toolCallId, 'tc_1');
    assert.match(res.json.results[0].result, /lakh/, 'the price must be spoken, not printed');
  });

  test('acknowledges an unrecognised payload instead of failing a live call', async () => {
    const res = await call('/api/voice/vapi', {
      method: 'POST',
      headers: { 'X-Vapi-Secret': 'test-vapi-secret' },
      body: { something: 'entirely unexpected' },
    });
    assert.equal(res.status, 200, 'never 4xx a live call over an envelope change');
    assert.equal(res.json.received, true);
  });
});

describe('signed webhooks', () => {
  test('rejects an unsigned workflow-error report', async () => {
    const res = await call('/api/webhooks/workflow-error', {
      method: 'POST',
      body: { workflow: 'test', errorMessage: 'boom' },
    });
    assert.equal(res.status, 401);
  });

  test('accepts a correctly signed report and records it', async () => {
    const body = { workflow: 'Test Workflow', errorCode: 'TEST', errorMessage: 'boom' };
    const raw = JSON.stringify(body);
    const res = await call('/api/webhooks/workflow-error', {
      method: 'POST',
      body,
      headers: { 'X-Signature': signPayload(raw, 'test-webhook-secret') },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.recorded, true);
  });

  test('rejects a tampered body', async () => {
    const signed = signPayload(JSON.stringify({ workflow: 'a' }), 'test-webhook-secret');
    const res = await call('/api/webhooks/workflow-error', {
      method: 'POST',
      body: { workflow: 'tampered' },
      headers: { 'X-Signature': signed },
    });
    assert.equal(res.status, 401);
  });
});

describe('error responses', () => {
  test('unknown routes return a safe 404', async () => {
    const res = await call('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.json.success, false);
    assert.ok(!/stack|at Object|node_modules/i.test(JSON.stringify(res.json)));
  });

  test('no response body ever contains a stack trace or SQL', async () => {
    const probes = [
      await call('/api/chat', { method: 'POST', body: { message: '', sessionId: 'x' } }),
      await call('/api/tools/searchProduct', { method: 'POST', body: {} }),
      await call('/api/admin/overview'),
      await call('/api/does-not-exist'),
    ];
    for (const res of probes) {
      const body = JSON.stringify(res.json);
      assert.ok(!/SELECT |INSERT |pg_|postgres|node_modules|\bat \w+\.\w+/i.test(body),
        `internal detail leaked: ${body.slice(0, 200)}`);
    }
  });
});

describe('admin endpoints', () => {
  test('require the API key', async () => {
    assert.equal((await call('/api/admin/overview')).status, 401);
  });

  test('return an operational overview', async () => {
    const res = await call('/api/admin/overview', { headers: { 'X-API-Key': API_KEY } });
    assert.equal(res.status, 200);
    assert.ok(res.json.data.orders);
    assert.ok(res.json.data.knowledgeBase.documents > 0);
  });

  test('readiness names exactly which integrations are in dry-run', async () => {
    const res = await call('/api/admin/readiness', { headers: { 'X-API-Key': API_KEY } });
    assert.ok(Array.isArray(res.json.data.dryRunServices));
    assert.ok(res.json.data.dryRunServices.includes('slack'));
    assert.equal(res.json.data.resolved.database, 'pglite');
  });
});
