/**
 * The seventeen scenarios the assignment requires, end to end.
 *
 * Every test runs against a real in-memory PostgreSQL with the real schema, the
 * real seed data and a real RAG index built from the real PDF/DOCX/XLSX files.
 * Nothing is stubbed. Integrations run in dry-run and their payloads are
 * asserted from the outbox, so "a Slack alert was sent" is verified by
 * inspecting the actual Block Kit body rather than trusting a mock.
 *
 * Each test records input / expected / actual / components, and the suite
 * prints the evidence table at the end (also written to docs/test-results.md
 * by `npm run test:scenarios`).
 */

// MUST be the first import: it sets the environment before the config is read.
import './helpers/env.ts';

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';

import { bootstrap, teardown, session, record, results } from './helpers/setup.ts';
import { chatService } from '../backend/src/services/chat.service.ts';
import { voiceService } from '../backend/src/services/voice.service.ts';
import { leadService } from '../backend/src/services/lead.service.ts';
import { orderService } from '../backend/src/services/order.service.ts';
import { escalationService } from '../backend/src/services/escalation.service.ts';
import { notificationService } from '../backend/src/services/notification.service.ts';
import { ingestFile } from '../backend/src/rag/ingest.ts';
import { retrieve } from '../backend/src/rag/retriever.ts';
import { opsRepo } from '../backend/src/database/repositories/ops.repo.ts';
import { supportRepo } from '../backend/src/database/repositories/support.repo.ts';
import { outboxPath } from '../backend/src/connectors/http.ts';
import type { ChatTurnResult } from '../backend/src/models/types.ts';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Read the dry-run outbox for a service and return the parsed records. */
function outbox(service: 'slack' | 'airtable' | 'zapier' | 'notion'): Array<Record<string, any>> {
  const path = outboxPath(service);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Flatten one outbox record to text so assertions read clearly.
 * Includes `operation`, which is where the target channel appears when Slack is
 * addressed through an incoming webhook rather than chat.postMessage.
 */
function slackText(entry: Record<string, any>): string {
  return JSON.stringify(entry ?? {});
}

async function ask(message: string, extra: Record<string, unknown> = {}): Promise<ChatTurnResult> {
  return chatService.handleTurn({
    message,
    sessionId: session(),
    channel: 'web_chat',
    ...extra,
  } as never);
}

const actionTypes = (r: ChatTurnResult) => r.actions.map((a) => a.type);

before(async () => {
  // Start from a clean outbox so assertions cannot pass on a previous run.
  for (const service of ['slack', 'airtable', 'zapier', 'notion'] as const) {
    const path = outboxPath(service);
    if (existsSync(path)) rmSync(path);
  }
  await bootstrap();
});

after(async () => {
  printEvidenceTable();
  await teardown();
});

function printEvidenceTable(): void {
  console.log('\n\n' + '='.repeat(100));
  console.log('TEST EVIDENCE TABLE');
  console.log('='.repeat(100));
  for (const r of results) {
    console.log(`\n[${r.id}] ${r.name}  -- ${r.passed ? 'PASS' : 'FAIL'}`);
    console.log(`  Input      : ${r.input}`);
    console.log(`  Expected   : ${r.expected}`);
    console.log(`  Actual     : ${r.actual}`);
    console.log(`  Components : ${r.components.join(' -> ')}`);
  }
  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${'='.repeat(100)}`);
  console.log(`${passed}/${results.length} documented scenarios passed`);
  console.log('='.repeat(100) + '\n');
}

/* ========================================================================== */

describe('UrbanCart required scenarios', () => {
  /* ---- 1. Product availability ---------------------------------------- */
  test('T01 product availability is answered from the live catalogue', async () => {
    const r = await ask('Is iPhone 15 available?');

    assert.equal(r.intent, 'availability_inquiry');
    assert.match(r.reply, /in stock/i);
    assert.match(r.reply, /Rs\. 249,999/, 'must quote the exact database price');
    assert.equal(r.escalated, false);
    assert.ok(actionTypes(r).includes('product_lookup'));
    // Availability must NOT come from RAG - stock changes hourly.
    assert.equal(r.sources.length, 0, 'availability must be answered from PostgreSQL, not documents');

    record({
      id: 'T01', name: 'Product availability', input: 'Is iPhone 15 available?',
      expected: 'In-stock confirmation with the exact catalogue price, from PostgreSQL',
      actual: r.reply, components: ['chat API', 'intent', 'PostgreSQL products'], passed: true,
    });
  });

  /* ---- 2. Product price ------------------------------------------------ */
  test('T02 product price is exact and never inferred', async () => {
    const r = await ask('What is the price of Samsung Galaxy S24?');

    assert.equal(r.intent, 'price_inquiry');
    assert.match(r.reply, /Rs\. 219,999/);
    assert.equal(r.confidence, 1, 'a database fact is not probabilistic');

    record({
      id: 'T02', name: 'Product price', input: 'What is the price of Samsung Galaxy S24?',
      expected: 'Rs. 219,999 exactly, from the products table',
      actual: r.reply, components: ['chat API', 'intent', 'PostgreSQL products'], passed: true,
    });
  });

  /* ---- 3. Shipping question -------------------------------------------- */
  test('T03 shipping question is grounded in the shipping policy PDF', async () => {
    const r = await ask('Do you deliver to Lahore and how long does delivery take?');

    assert.equal(r.escalated, false, 'this is documented, so it must be answered');
    assert.ok(r.sources.length > 0, 'the answer must cite a document');
    assert.equal(r.sources[0]?.documentType, 'shipping_policy');
    assert.match(r.reply, /Lahore/i);

    record({
      id: 'T03', name: 'Shipping question', input: 'Do you deliver to Lahore and how long does delivery take?',
      expected: 'Grounded answer citing the shipping policy',
      actual: `${r.reply.slice(0, 120)}… [source: ${r.sources[0]?.filename}]`,
      components: ['chat API', 'RAG retrieval', 'shipping policy PDF'], passed: true,
    });
  });

  /* ---- 4. Return policy ------------------------------------------------ */
  test('T04 return policy gives the CORRECT discriminating answer', async () => {
    const r = await ask('Can I return headphones after 10 days?');

    assert.equal(r.escalated, false);
    assert.equal(r.sources[0]?.documentType, 'return_policy');
    // The real answer is NO: audio products have a 7-day window, not 14.
    assert.match(r.reply, /7 days/, 'must quote the 7-day audio window, not the general 14-day one');
    assert.ok(!/14 days.*headphone/i.test(r.reply), 'must not apply the general window to headphones');

    record({
      id: 'T04', name: 'Return policy (discriminating)', input: 'Can I return headphones after 10 days?',
      expected: 'No - audio products have a 7-day window, so 10 days is outside it',
      actual: r.reply.slice(0, 160), components: ['chat API', 'RAG', 'return policy PDF'], passed: true,
    });
  });

  /* ---- 5. Warranty question -------------------------------------------- */
  test('T05 warranty question is answered from the warranty document', async () => {
    const r = await ask('Does the iPhone 15 have a warranty?');

    assert.equal(r.escalated, false);
    assert.ok(r.sources.length > 0);
    assert.match(r.reply, /12 month/i, 'smartphones carry a 12 month warranty');

    record({
      id: 'T05', name: 'Warranty question', input: 'Does the iPhone 15 have a warranty?',
      expected: '12 month manufacturer warranty, from the warranty policy DOCX',
      actual: r.reply.slice(0, 160), components: ['chat API', 'RAG', 'warranty policy DOCX'], passed: true,
    });
  });

  /* ---- 6. Existing order lookup ---------------------------------------- */
  test('T06 existing order lookup returns real status and flags the delay', async () => {
    const r = await ask('My order UC-10452 hasnt arrived yet.', { phone: '+923001234567' });

    assert.equal(r.intent, 'order_status');
    assert.match(r.reply, /UC-10452/);
    assert.match(r.reply, /delayed/i);
    assert.match(r.reply, /overdue/i, 'an overdue order must say so');
    assert.ok(actionTypes(r).includes('order_lookup'));
    // An overdue order is one of the four notifiable events.
    assert.ok(actionTypes(r).includes('notification_sent'), 'operations must be told about the delay');

    record({
      id: 'T06', name: 'Existing order lookup', input: 'My order UC-10452 hasnt arrived yet. (from +923001234567)',
      expected: 'Delayed status with reason and overdue days; order issue raised with operations',
      actual: r.reply.slice(0, 160), components: ['chat API', 'PostgreSQL orders', 'Slack #support'], passed: true,
    });
  });

  /* ---- 7. Lead collection ---------------------------------------------- */
  test('T07 lead collection captures all six fields and creates the records', async () => {
    const result = await leadService.capture({
      name: 'Zainab Malik', phone: '03211234567', product: 'UrbanFit Smart Watch Series 5',
      budget: 20_000, location: 'Karachi', purchaseIntent: 'considering', source: 'web_chat',
    });

    assert.match(result.lead.reference, /^LEAD-\d{3}$/);
    assert.equal(result.duplicate, false);
    assert.ok(result.customerId, 'a customer record must exist for the lead');
    assert.equal(result.lead.budget, 20_000);
    assert.equal(result.lead.location, 'Karachi');
    assert.ok(result.lead.productId, 'the product should have resolved to the catalogue');

    record({
      id: 'T07', name: 'Lead collection', input: 'Zainab Malik, 03211234567, Smart Watch, Rs. 20,000, Karachi, considering',
      expected: 'Customer + lead created in PostgreSQL with all six fields',
      actual: `${result.lead.reference} created, score ${result.scoring.score}, customer ${result.customerCreated ? 'created' : 'matched'}`,
      components: ['lead service', 'PostgreSQL customers/leads', 'Airtable mirror'], passed: true,
    });
  });

  /* ---- 8. High-value lead notification --------------------------------- */
  test('T08 high-value lead notifies sales in Slack AND hands off to Zapier', async () => {
    const before = outbox('slack').length;

    const r = await ask(
      'I want to buy iPhone 15. My budget is Rs. 200,000. I am in Lahore. My name is Ahmed Raza and my number is 0300 1234567.',
    );

    assert.ok(actionTypes(r).includes('lead_created'));
    const leadRef = r.actions.find((a) => a.type === 'lead_created')?.reference;
    assert.ok(leadRef, 'the reply must carry a lead reference');

    const slack = outbox('slack');
    assert.ok(slack.length > before, 'a Slack notification must have been produced');

    const alert = slack.reverse().find((e) => slackText(e).includes('High Value Lead'));
    assert.ok(alert, 'the high-value lead alert must exist in the outbox');
    const body = slackText(alert);
    assert.match(body, /Ahmed Raza/);
    assert.match(body, /iPhone 15/);
    assert.match(body, /Rs\. 200,000/);
    assert.match(body, /Lahore/);
    assert.match(body, /urbancart-sales/, 'must be routed to the sales channel');

    const zap = outbox('zapier').find((e) => JSON.stringify(e).includes('high_value_lead'));
    assert.ok(zap, 'a high-value lead must also be handed to Zapier');
    assert.equal(zap?.['request']?.body?.budget_pkr, 200_000);

    record({
      id: 'T08', name: 'High-value lead notification',
      input: 'I want to buy iPhone 15. Budget Rs. 200,000. Lahore. Ahmed Raza, 0300 1234567.',
      expected: 'Lead created, Slack #sales alerted, Zapier high_value_lead event emitted',
      actual: `${leadRef}; Slack Block Kit alert to #urbancart-sales; Zapier payload budget_pkr=200000`,
      components: ['chat API', 'lead service', 'Slack', 'Zapier', 'Airtable'], passed: true,
    });
  });

  /* ---- 9. Normal lead does NOT notify ---------------------------------- */
  test('T09 a normal lead is recorded but does NOT page the team', async () => {
    const before = outbox('slack').length;

    const result = await leadService.capture({
      name: 'Kamran Ali', phone: '03451119999', product: 'UrbanCharge 20W USB-C Fast Charger',
      budget: 2_500, location: 'Multan', purchaseIntent: 'browsing', source: 'web_chat',
    });

    assert.equal(result.scoring.isHighValue, false);
    assert.equal(result.notifications.slack.suppressed, true, 'normal leads must not notify');
    assert.equal(outbox('slack').length, before, 'no Slack payload should have been produced');

    // But it IS recorded, with the reason, so nothing is silently dropped.
    const events = await opsRepo.listEvents(50);
    const suppressed = events.find(
      (e) => e.entity_type === 'suppressed' && e.event_type === 'high_value_lead',
    );
    assert.ok(suppressed, 'suppression must be auditable');
    assert.equal(suppressed?.status, 'skipped');

    record({
      id: 'T09', name: 'Normal lead (no notification)', input: 'Kamran Ali, charger, Rs. 2,500, Multan, browsing',
      expected: 'Lead stored; NO Slack notification; suppression recorded with a reason',
      actual: `${result.lead.reference} score ${result.scoring.score}, slack suppressed, integration_events row = skipped`,
      components: ['lead service', 'notification policy', 'integration_events'], passed: true,
    });
  });

  /* ---- 10. Damaged product complaint ----------------------------------- */
  test('T10 damaged product creates an urgent ticket, a task and a Slack alert', async () => {
    const before = outbox('slack').length;

    const r = await ask('My product arrived damaged, the screen is cracked.', {
      phone: '+923214567890',
    });

    assert.equal(r.intent, 'complaint');
    assert.equal(r.escalated, true);
    assert.equal(r.requiresHuman, true);
    assert.ok(actionTypes(r).includes('ticket_created'));
    assert.ok(actionTypes(r).includes('task_created'));

    const ticketRef = r.actions.find((a) => a.type === 'ticket_created')?.reference;
    assert.ok(ticketRef);
    const ticket = await supportRepo.findTicketByReference(ticketRef);
    assert.equal(ticket?.issueType, 'damaged_product');
    assert.equal(ticket?.priority, 'urgent');

    assert.ok(outbox('slack').length > before, 'support must be paged');
    const alert = outbox('slack').reverse().find((e) => slackText(e).includes('High Priority Support Issue'));
    assert.ok(alert, 'the complaint alert must exist');
    assert.match(slackText(alert), /urbancart-support/);

    // The customer gets an apology, never a ticket internal or an error.
    assert.match(r.reply, /sorry/i);
    assert.ok(!/error|exception|null|undefined/i.test(r.reply), 'no technical leakage to the customer');

    record({
      id: 'T10', name: 'Damaged product complaint', input: 'My product arrived damaged, the screen is cracked.',
      expected: 'Urgent ticket + task, Slack #support alert, polite handover message',
      actual: `${ticketRef} (urgent), task created, Slack alert to #urbancart-support`,
      components: ['chat API', 'escalation service', 'PostgreSQL tickets/tasks', 'Slack', 'Airtable'], passed: true,
    });
  });

  /* ---- 11. Angry customer ---------------------------------------------- */
  test('T11 an angry customer is escalated before anything else is attempted', async () => {
    const r = await ask('THIS IS THE THIRD TIME I AM CONTACTING YOU AND NOBODY HAS REPLIED. This is unacceptable.');

    assert.equal(r.escalated, true);
    assert.equal(r.requiresHuman, true);
    const ticketRef = r.actions.find((a) => a.type === 'ticket_created')?.reference;
    const ticket = await supportRepo.findTicketByReference(ticketRef as string);
    assert.equal(ticket?.issueType, 'angry_customer');
    assert.equal(ticket?.priority, 'urgent');
    assert.match(r.reply, /sorry/i);

    record({
      id: 'T11', name: 'Angry customer escalation', input: 'THIRD TIME... nobody has replied. This is unacceptable.',
      expected: 'Urgent escalation to a human, apologetic reply, no attempt to answer',
      actual: `${ticketRef} issue=angry_customer priority=urgent`,
      components: ['chat API', 'intent signals', 'escalation service', 'Slack'], passed: true,
    });
  });

  /* ---- 12. Missing knowledge — the anti-hallucination test -------------- */
  test('T12 an undocumented question is REFUSED, not guessed', async () => {
    const r = await ask('What is your policy on trading in my old laptop for credit?');

    assert.equal(r.escalated, true, 'an undocumented question must escalate');
    assert.equal(r.requiresHuman, true);
    // The reply must not contain a fabricated policy.
    assert.ok(
      /human|team|agent|assistance|colleague/i.test(r.reply),
      'the customer must be told a person will help',
    );
    assert.ok(!/\b\d+\s*(days?|%|percent)\b/i.test(r.reply), 'must not invent a number');

    const ticketRef = r.actions.find((a) => a.type === 'ticket_created')?.reference;
    const ticket = await supportRepo.findTicketByReference(ticketRef as string);
    assert.ok(
      ticket && ['missing_information', 'low_confidence'].includes(ticket.issueType),
      'the gap must be logged so the knowledge base can be improved',
    );

    record({
      id: 'T12', name: 'Missing knowledge (anti-hallucination)',
      input: 'What is your policy on trading in my old laptop for credit?',
      expected: 'Refuse to answer, escalate to a human, log the knowledge gap',
      actual: `escalated=${r.escalated}, ticket=${ticketRef} (${ticket?.issueType}), confidence=${r.confidence}`,
      components: ['chat API', 'RAG confidence gate', 'escalation service'], passed: true,
    });
  });

  /* ---- 13. Invalid order ----------------------------------------------- */
  test('T13 invalid and unknown order numbers are handled distinctly and safely', async () => {
    const malformed = await orderService.lookup('ABC-123', { phone: '+923001234567' });
    assert.equal(malformed.outcome, 'invalid_format');
    assert.match(malformed.message, /UC-10452/, 'tell the customer the correct format');

    const unknown = await orderService.lookup('UC-99999', { phone: '+923001234567' });
    assert.equal(unknown.outcome, 'not_found');
    assert.ok(!/error|null|undefined/i.test(unknown.message));

    // An order that exists but belongs to someone else must reveal NOTHING.
    const unverified = await orderService.lookup('UC-10452', { phone: '+923000000000' });
    assert.equal(unverified.outcome, 'verification_required');
    assert.equal(unverified.order, null, 'no order data may leak to an unverified caller');
    assert.ok(!/delayed|Lahore|iPhone/i.test(unverified.message), 'not even the status may leak');

    record({
      id: 'T13', name: 'Invalid / unauthorised order', input: 'ABC-123 · UC-99999 · UC-10452 from the wrong phone',
      expected: 'invalid_format · not_found · verification_required with zero data leakage',
      actual: `${malformed.outcome} · ${unknown.outcome} · ${unverified.outcome} (order=null)`,
      components: ['order service', 'ownership verification', 'safe responses'], passed: true,
    });
  });

  /* ---- 14. RAG document update ----------------------------------------- */
  test('T14 updating a document changes the answer with no code change', async () => {
    const question = 'What is the UrbanCart price-match guarantee?';

    // Before: nothing in the knowledge base covers this.
    const before = await retrieve(question, { intent: 'policy_question' });
    assert.notEqual(before.status, 'grounded', 'this policy should not exist yet');

    // A business user "uploads" a new policy document.
    const v1 = Buffer.from(
      `# UrbanCart Price Match Guarantee\n\n` +
        `## 1. Price Match Guarantee\n\n` +
        `UrbanCart will match the price of any identical product advertised by an ` +
        `authorised Pakistani retailer. A price match claim must be made within 5 days of purchase. ` +
        `The competitor listing must show the product in stock.\n`,
      'utf8',
    );
    const created = await ingestFile({
      sourceRef: 'Returns/price-match-policy.md',
      filename: 'price-match-policy.md',
      buffer: v1,
      source: 'local',
      documentType: 'return_policy',
    });
    assert.equal(created.action, 'created');

    const after = await retrieve(question, { intent: 'policy_question' });
    assert.equal(after.status, 'grounded', 'the new document must be immediately retrievable');
    assert.ok(
      after.chunks.some((c) => c.chunkText.includes('5 days')),
      'the new policy content must be retrievable',
    );

    // The business updates the window from 5 days to 14.
    const v2 = Buffer.from(
      `# UrbanCart Price Match Guarantee\n\n` +
        `## 1. Price Match Guarantee\n\n` +
        `UrbanCart will match the price of any identical product advertised by an ` +
        `authorised Pakistani retailer. A price match claim must be made within 14 days of purchase. ` +
        `The competitor listing must show the product in stock.\n`,
      'utf8',
    );
    const updated = await ingestFile({
      sourceRef: 'Returns/price-match-policy.md',
      filename: 'price-match-policy.md',
      buffer: v2,
      source: 'local',
      documentType: 'return_policy',
    });
    assert.equal(updated.action, 'updated', 'a changed file must supersede, not duplicate');

    const final = await retrieve(question, { intent: 'policy_question' });
    const text = final.chunks.map((c) => c.chunkText).join(' ');
    assert.ok(text.includes('14 days'), 'the updated window must be retrievable');
    assert.ok(!text.includes('5 days'), 'the superseded version must no longer be retrievable');

    // Re-ingesting unchanged content must be a no-op.
    const again = await ingestFile({
      sourceRef: 'Returns/price-match-policy.md',
      filename: 'price-match-policy.md',
      buffer: v2,
      source: 'local',
      documentType: 'return_policy',
    });
    assert.equal(again.action, 'skipped_unchanged', 'ingestion must be idempotent');

    record({
      id: 'T14', name: 'RAG document update', input: 'Add price-match policy (5 days), then update it to 14 days',
      expected: 'New knowledge retrievable immediately; old version superseded; re-ingest is a no-op',
      actual: `created -> updated (v${updated.chunks ? '2' : '?'}) -> skipped_unchanged; answer now says 14 days`,
      components: ['ingestion pipeline', 'chunker', 'embeddings', 'pgvector', 'version supersede'], passed: true,
    });
  });

  /* ---- 15. Workflow failure -------------------------------------------- */
  test('T15 an automation failure alerts engineering and never reaches the customer', async () => {
    const before = outbox('slack').length;

    const outcome = await notificationService.notifyAutomationFailure({
      workflow: 'RAG Document Ingestion',
      errorCode: 'EMBEDDING_FAILED',
      errorMessage: 'OpenAI returned HTTP 429: rate limit exceeded on text-embedding-3-small',
      subject: 'return-policy.pdf',
      correlationId: 'uc_test_failure',
    });

    assert.equal(outcome.channel, 'alerts', 'failures go to the engineering channel');
    assert.ok(outbox('slack').length > before);

    const alert = outbox('slack').reverse().find((e) => slackText(e).includes('Automation Failed'));
    assert.ok(alert);
    const body = slackText(alert);
    assert.match(body, /RAG Document Ingestion/);
    assert.match(body, /return-policy\.pdf/);
    assert.match(body, /urbancart-alerts/);

    // The failure is also recorded for post-hoc analysis.
    await opsRepo.recordExecution({
      workflowName: 'RAG Document Ingestion',
      status: 'failed',
      errorCode: 'EMBEDDING_FAILED',
      errorMessage: 'rate limit',
      correlationId: 'uc_test_failure',
    });
    const failures = await opsRepo.recentFailures(10);
    assert.ok(failures.some((f) => f.correlation_id === 'uc_test_failure'));

    record({
      id: 'T15', name: 'Workflow failure handling', input: 'Embedding generation fails with HTTP 429 during ingestion',
      expected: 'Slack #alerts notified with workflow + document + error; failure row recorded; customer unaffected',
      actual: `alert routed to ${outcome.channel}, workflow_executions row written`,
      components: ['error handling', 'workflow_executions', 'Slack #alerts'], passed: true,
    });
  });

  /* ---- 16. Voice request ----------------------------------------------- */
  test('T16 a real Vapi webhook is handled and returns speakable results', async () => {
    const payload = JSON.parse(
      readFileSync('vapi/test-payloads/tool-call-order-status.json', 'utf8'),
    ) as { message: Record<string, unknown> };

    const response = (await voiceService.handleWebhook(
      payload.message as never,
      'uc_test_voice',
    )) as { results: Array<{ toolCallId: string; result: string }> };

    assert.ok(Array.isArray(response.results));
    assert.equal(response.results[0]?.toolCallId, 'toolu_vapi_001');

    const spoken = response.results[0]?.result ?? '';
    assert.match(spoken, /U C, one zero four five two/, 'order numbers must be spelled out');
    assert.match(spoken, /delayed/i);
    assert.ok(!spoken.includes('*') && !spoken.includes('\n'), 'must be speakable');

    // A product lookup on the voice channel speaks the exact price.
    const productPayload = JSON.parse(
      readFileSync('vapi/test-payloads/tool-call-search-product.json', 'utf8'),
    ) as { message: Record<string, unknown> };
    const productResponse = (await voiceService.handleWebhook(
      productPayload.message as never,
      'uc_test_voice_2',
    )) as { results: Array<{ result: string }> };
    assert.match(
      productResponse.results[0]?.result ?? '',
      /2 lakh 49 thousand 999 rupees/,
      'the spoken price must be exact, not rounded',
    );

    record({
      id: 'T16', name: 'Voice request (Vapi)', input: 'Vapi tool-calls webhook: getOrderStatus(UC-10452), searchProduct(iPhone 15)',
      expected: 'Speakable results, order number spelled digit by digit, exact spoken price',
      actual: spoken.slice(0, 120),
      components: ['Vapi webhook', 'voice service', 'PostgreSQL orders/products'], passed: true,
    });
  });

  /* ---- 17. Chat request (multi-turn) ----------------------------------- */
  test('T17 a multi-turn chat keeps context and persists the transcript', async () => {
    const sid = session('multiturn');
    const opts = { sessionId: sid, channel: 'web_chat' as const };

    const t1 = await chatService.handleTurn({ message: 'Hello', ...opts });
    assert.equal(t1.intent, 'greeting');

    const t2 = await chatService.handleTurn({ message: 'Is the ThinkBook laptop available?', ...opts });
    assert.match(t2.reply, /in stock/i);
    assert.equal(t2.conversationId, t1.conversationId, 'the same session is one conversation');

    const t3 = await chatService.handleTurn({ message: 'What is your return policy?', ...opts });
    assert.ok(t3.sources.length > 0, 'the policy answer must be grounded');

    const { conversationRepo } = await import('../backend/src/database/repositories/conversation.repo.ts');
    const conversation = await conversationRepo.getWithMessages(t1.conversationId);
    assert.ok(conversation);
    // 3 customer turns + 3 assistant turns
    assert.equal(conversation.messages.length, 6, 'every turn must be persisted');
    assert.equal(conversation.messages[0]?.role, 'customer');
    assert.equal(conversation.messages[1]?.role, 'assistant');

    record({
      id: 'T17', name: 'Chat request (multi-turn)', input: 'Hello -> ThinkBook availability -> return policy',
      expected: 'One conversation, correct answer per turn, full transcript persisted',
      actual: `conversation ${t1.conversationId.slice(0, 8)} with ${conversation.messages.length} messages`,
      components: ['chat API', 'conversations', 'conversation_messages', 'products', 'RAG'], passed: true,
    });
  });

  /* ---- Extra: duplicate lead guard ------------------------------------- */
  test('T18 the same enquiry twice does not page sales twice', async () => {
    const input = {
      name: 'Repeat Customer', phone: '03007778888', product: 'ThinkBook 14 Core i5 Laptop',
      budget: 190_000, location: 'Lahore', purchaseIntent: 'ready_to_buy' as const,
      source: 'web_chat' as const,
    };

    const first = await leadService.capture(input);
    assert.equal(first.duplicate, false);
    assert.equal(first.scoring.isHighValue, true);

    const slackAfterFirst = outbox('slack').length;

    // Same customer, same product, different channel.
    const second = await leadService.capture({ ...input, source: 'whatsapp' });
    assert.equal(second.duplicate, true, 'the second enquiry must be recognised as a duplicate');
    assert.equal(second.lead.reference, first.lead.reference);
    assert.equal(outbox('slack').length, slackAfterFirst, 'sales must not be paged twice');

    record({
      id: 'T18', name: 'Duplicate lead guard', input: 'Same customer + product submitted twice on different channels',
      expected: 'Second submission matches the first lead; no second Slack notification',
      actual: `both -> ${first.lead.reference}; Slack payloads unchanged`,
      components: ['lead service', 'duplicate window', 'notification policy'], passed: true,
    });
  });

  /* ---- Extra: safe error responses ------------------------------------- */
  test('T19 invalid input never produces a technical error for the customer', async () => {
    const empty = await ask('');
    assert.ok(!/error|exception|stack|undefined/i.test(empty.reply));
    assert.match(empty.reply, /rephrase|didn't quite catch/i);

    const huge = await ask('x'.repeat(5000));
    assert.ok(!/error|exception|stack/i.test(huge.reply));

    record({
      id: 'T19', name: 'Safe error responses', input: 'Empty message · 5000-character message',
      expected: 'Friendly guidance, never a technical error',
      actual: empty.reply.slice(0, 90),
      components: ['validation', 'AppError safe messages'], passed: true,
    });
  });

  /* ---- Extra: escalation policy coverage -------------------------------- */
  test('T20 every escalation trigger the client named has a defined policy', async () => {
    const triggers = [
      'damaged_product', 'complex_refund', 'angry_customer',
      'missing_information', 'low_confidence', 'customer_requested_human',
    ] as const;

    for (const trigger of triggers) {
      const policy = escalationService.policyFor(trigger);
      assert.ok(policy, `${trigger} must have a policy`);
      assert.ok(policy.priority, `${trigger} must have a priority`);
      assert.ok(policy.team, `${trigger} must have an owning team`);
      assert.ok(policy.slaHours > 0, `${trigger} must have an SLA`);

      const message = escalationService.customerMessageFor(trigger, 'SUP-999');
      assert.ok(message.length > 40, `${trigger} must have a real customer message`);
      assert.ok(!/error|null|undefined|confidence/i.test(message), 'no internals in a customer message');
    }

    record({
      id: 'T20', name: 'Escalation policy coverage', input: 'All six escalation triggers',
      expected: 'Each has a priority, owning team, SLA and a safe customer message',
      actual: `${triggers.length}/${triggers.length} triggers fully specified`,
      components: ['escalation service'], passed: true,
    });
  });
});
