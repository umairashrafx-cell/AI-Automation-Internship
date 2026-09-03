/**
 * Unit tests for the pure logic that the rest of the system depends on.
 * No database, no network.
 */

// MUST be the first import: it sets the environment before the config is read.
import './helpers/env.ts';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalisePhone, formatPhoneForDisplay, extractPhone } from '../backend/src/utils/phone.ts';
import { parseBudget, formatPkr, safeCompare, signPayload } from '../backend/src/utils/misc.ts';
import { cleanDocumentText, stem, tokenize, splitSentences } from '../backend/src/utils/text.ts';
import { chunkDocument } from '../backend/src/rag/chunker.ts';
import { cosineSimilarity } from '../backend/src/rag/embeddings.ts';
import { computeConfidence, resolveDocumentTypes } from '../backend/src/rag/retriever.ts';
import { findUnsupportedClaims } from '../backend/src/rag/generator.ts';
import { classify, extractBudget, extractOrderNumber, extractProductQuery } from '../backend/src/services/intent.service.ts';
import { scoreLead } from '../backend/src/services/lead.service.ts';
import { speakAmount, speakOrderNumber, toSpeech } from '../backend/src/services/voice.service.ts';
import { redact, maskPii } from '../backend/src/utils/logger.ts';
import type { RetrievedChunk } from '../backend/src/models/types.ts';

describe('phone normalisation', () => {
  test('collapses every Pakistani format to one E.164 value', () => {
    for (const input of ['03001234567', '+923001234567', '923001234567', '0300 123 4567', '0300-123-4567', '00923001234567']) {
      const r = normalisePhone(input);
      assert.equal(r.ok, true, `${input} should parse`);
      assert.equal(r.e164, '+923001234567', `${input} should normalise to +923001234567`);
    }
  });

  test('rejects malformed numbers rather than guessing', () => {
    for (const input of ['', '123', 'not a phone', '03001', '+0300123456789012345']) {
      assert.equal(normalisePhone(input).ok, false, `${input} should be rejected`);
    }
  });

  test('formats for display and extracts from free text', () => {
    assert.equal(formatPhoneForDisplay('+923001234567'), '+92 300 1234567');
    assert.equal(extractPhone('you can reach me on 0300 123 4567 any time'), '+923001234567');
    assert.equal(extractPhone('no number here'), null);
  });
});

describe('budget parsing', () => {
  test('handles the ways a customer states a budget', () => {
    assert.equal(parseBudget('200000'), 200_000);
    assert.equal(parseBudget('Rs. 200,000'), 200_000);
    assert.equal(parseBudget('2 lakh'), 200_000);
    assert.equal(parseBudget('2.5 lakh'), 250_000);
    assert.equal(parseBudget('200k'), 200_000);
    assert.equal(parseBudget('1 crore'), 10_000_000);
    assert.equal(parseBudget(null), null);
  });

  test('does NOT mistake a product model number for a budget', () => {
    // The bug this guards: "buy iPhone 15, budget Rs 200,000" once returned 15.
    assert.equal(extractBudget('I want to buy iPhone 15. My budget is Rs. 200,000.'), 200_000);
    assert.equal(extractBudget('Is the Galaxy S24 available?'), null);
    assert.equal(extractBudget('iPhone 15 please'), null);
  });

  test('formats PKR the way Pakistani retail does', () => {
    assert.equal(formatPkr(200000), 'Rs. 200,000');
    assert.equal(formatPkr('249999'), 'Rs. 249,999');
    assert.equal(formatPkr(null), 'N/A');
  });
});

describe('text processing', () => {
  test('stems inflections to a shared root', () => {
    assert.equal(stem('cancellation'), stem('cancel'));
    assert.equal(stem('returns'), stem('return'));
    assert.equal(stem('warranties'), stem('warranty'));
    assert.equal(stem('shipping'), stem('ship'));
  });

  test('does not over-stem "-es" that is part of the word', () => {
    // "headphones" -> "headphone", not "headphon"
    assert.equal(stem('headphones'), 'headphone');
    assert.equal(stem('devices'), 'device');
    // real sibilant plurals still lose the "es"
    assert.equal(stem('boxes'), 'box');
    assert.equal(stem('batches'), 'batch');
  });

  test('cleans extraction artefacts', () => {
    assert.equal(cleanDocumentText('war-\nranty'), 'warranty', 'rejoins hyphenated line breaks');
    assert.equal(cleanDocumentText('delivery\\. Next'), 'delivery. Next', 'removes markdown escapes');
    assert.ok(!cleanDocumentText('Policy\nPage 3\nText').includes('Page 3'), 'drops page-number lines');
  });

  test('splits sentences without breaking on abbreviations', () => {
    const sentences = splitSentences('The price is Rs. 200,000. Delivery takes 2 days.');
    assert.equal(sentences.length, 2, 'Rs. must not end a sentence');
  });

  test('tokenize drops stop words', () => {
    const tokens = tokenize('Can I return the headphones after 10 days?');
    assert.ok(!tokens.includes('the'));
    assert.ok(tokens.includes('return'));
  });
});

describe('chunker', () => {
  const document = `# Return Policy

## 1. Standard Window
Customers may request a return within 14 days of delivery. The period starts from the delivery date.

## 2. Audio Products
Headphones may only be returned within 7 days of delivery. This limit is strict.

## 3. Refunds
Refunds are credited within 7 to 10 working days.`;

  test('never merges two sections into one chunk', () => {
    const chunks = chunkDocument(document, { chunkSize: 900, overlap: 100 });
    assert.ok(chunks.length >= 3, `expected at least 3 chunks, got ${chunks.length}`);
    for (const chunk of chunks) {
      const mentionsAudio = chunk.text.includes('Headphones may only');
      const mentionsRefund = chunk.text.includes('Refunds are credited');
      assert.ok(!(mentionsAudio && mentionsRefund), 'a chunk must not span two policies');
    }
  });

  test('prefixes each chunk with its heading trail', () => {
    const chunks = chunkDocument(document, { chunkSize: 900, overlap: 100 });
    const audio = chunks.find((c) => c.text.includes('Headphones may only'));
    assert.ok(audio, 'the audio section should be chunked');
    assert.ok(audio.text.includes('Audio Products'), 'chunk should carry its heading');
    assert.equal(audio.metadata.section, '2. Audio Products');
  });

  test('respects the size budget', () => {
    const long = `# Doc\n\n${'This is a sentence about returns. '.repeat(200)}`;
    const chunks = chunkDocument(long, { chunkSize: 500, overlap: 50 });
    assert.ok(chunks.length > 1, 'long text must be split');
    for (const c of chunks) {
      assert.ok(c.text.length <= 900, `chunk of ${c.text.length} chars exceeds the budget`);
    }
  });
});

describe('embeddings and confidence', () => {
  test('cosine similarity behaves', () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
    assert.equal(cosineSimilarity([0, 0, 0], [1, 1, 1]), 0, 'zero vector must not divide by zero');
  });

  test('confidence rewards lexical coverage, not just similarity', () => {
    const make = (text: string, similarity: number): RetrievedChunk => ({
      chunkId: 'c', documentId: 'd', chunkText: text, chunkIndex: 0, similarity,
      filename: 'f.pdf', title: null, documentType: 'return_policy', version: 1,
      effectiveFrom: null, metadata: {},
    });

    const onTopic = computeConfidence('return headphones after 10 days', [
      make('Headphones may only be returned within 7 days of delivery.', 0.3),
    ]);
    const offTopic = computeConfidence('return headphones after 10 days', [
      make('Our warehouse is located in Lahore and operates on weekdays.', 0.3),
    ]);
    assert.ok(onTopic > offTopic, `on-topic ${onTopic} should beat off-topic ${offTopic}`);
  });

  test('empty retrieval is zero confidence', () => {
    assert.equal(computeConfidence('anything', []), 0);
  });
});

describe('metadata filtering', () => {
  test('routes a question to the document types that can answer it', () => {
    assert.deepEqual(resolveDocumentTypes('Can I return this?', 'policy_question'), ['return_policy']);
    assert.deepEqual(resolveDocumentTypes('Does it have a warranty?', 'policy_question'), ['warranty_policy']);
    assert.deepEqual(resolveDocumentTypes('Do you deliver to Lahore?', 'policy_question'), ['shipping_policy']);
    // Cancellation lives in the training notes, which must be reachable.
    assert.ok(resolveDocumentTypes('Can I cancel my order?', 'policy_question')?.includes('training'));
  });
});

describe('hallucination guard', () => {
  const evidence = 'Returns are accepted within 14 days. Audio products within 7 days. Delivery costs Rs. 250.';

  test('accepts numbers that appear in the evidence', () => {
    assert.deepEqual(findUnsupportedClaims('You have 14 days to return it.', evidence), []);
    assert.deepEqual(findUnsupportedClaims('Delivery is Rs. 250.', evidence), []);
  });

  test('flags a number that was invented', () => {
    const claims = findUnsupportedClaims('There is a Rs. 5,000 restocking fee.', evidence);
    assert.ok(claims.length > 0, 'an invented fee must be caught');
  });

  test('tolerates rephrasing of a supported figure', () => {
    assert.deepEqual(findUnsupportedClaims('Returns close after 14 days.', evidence), []);
  });
});

describe('intent classification', () => {
  const cases: Array<[string, string]> = [
    ['Is iPhone 15 available?', 'availability_inquiry'],
    ['What is the price of Samsung Galaxy S24?', 'price_inquiry'],
    ['Do you deliver to Lahore?', 'policy_question'],
    ['Can I return headphones after 10 days?', 'policy_question'],
    ['My order UC-10452 has not arrived', 'order_status'],
    ['My product arrived damaged', 'complaint'],
    ['I want to speak to a human agent', 'handoff'],
    ['Hello', 'greeting'],
  ];

  for (const [message, expected] of cases) {
    test(`"${message}" -> ${expected}`, () => {
      assert.equal(classify(message).intent, expected);
    });
  }

  test('extracts an order number in any spelling', () => {
    assert.equal(extractOrderNumber('my order UC-10452 please'), 'UC-10452');
    assert.equal(extractOrderNumber('order uc 10452'), 'UC-10452');
    assert.equal(extractOrderNumber('no order here'), null);
  });

  test('does not treat policy words as product names', () => {
    assert.equal(extractProductQuery('Does this product have warranty?'), null);
    assert.equal(extractProductQuery('I want to speak to a human agent'), null);
    assert.equal(extractProductQuery('Is iPhone 15 available?'), 'iPhone 15');
  });

  test('detects every escalation signal the client listed', () => {
    assert.equal(classify('My product arrived damaged').signals.damagedProduct, true);
    assert.equal(classify('I want a refund for this').signals.refundRequest, true);
    assert.equal(classify('This is absolutely unacceptable').signals.isAngry, true);
    assert.equal(classify('I HAVE BEEN WAITING FOR THREE WEEKS').signals.isAngry, true);
    assert.equal(classify('let me speak to a manager').signals.wantsHuman, true);
  });
});

describe('lead scoring', () => {
  test("the client's own example scores as high value", () => {
    // "New customer interested in iPhone 15, budget Rs. 200,000, located in Lahore"
    const score = scoreLead({
      budget: 200_000, purchaseIntent: 'considering', location: 'Lahore',
      productMatched: true, previousOrders: 0, hasPhone: true,
    });
    assert.equal(score.isHighValue, true, 'Rs. 200,000 must qualify as high value');
    assert.ok(score.score >= 70, `expected >= 70, got ${score.score}`);
  });

  test('a low-budget browser is a normal lead and must not page sales', () => {
    const score = scoreLead({
      budget: 5_000, purchaseIntent: 'browsing', location: null,
      productMatched: false, previousOrders: 0, hasPhone: true,
    });
    assert.equal(score.isHighValue, false);
  });

  test('an unreachable lead is never high value', () => {
    const score = scoreLead({
      budget: 500_000, purchaseIntent: 'ready_to_buy', location: 'Lahore',
      productMatched: true, previousOrders: 3, hasPhone: false,
    });
    assert.equal(score.isHighValue, false, 'sales cannot act without a phone number');
  });

  test('explains itself', () => {
    const score = scoreLead({
      budget: 200_000, purchaseIntent: 'ready_to_buy', location: 'Lahore',
      productMatched: true, previousOrders: 2, hasPhone: true,
    });
    assert.ok(score.reasons.length >= 4, 'scoring must be explainable');
  });
});

describe('voice formatting', () => {
  test('speaks amounts exactly, never rounded', () => {
    // Rounding 249999 to "2.5 lakh" would state a price we do not charge.
    assert.equal(speakAmount(249_999), '2 lakh 49 thousand 999 rupees');
    assert.equal(speakAmount(200_000), '2 lakh rupees');
    assert.equal(speakAmount(18_499), '18 thousand 499 rupees');
  });

  test('spells an order number digit by digit', () => {
    assert.equal(speakOrderNumber('UC-10452'), 'U C, one zero four five two');
  });

  test('strips everything unspeakable', () => {
    const spoken = toSpeech('The **iPhone** is Rs. 249,999.\n- In stock\nSee https://x.pk');
    assert.ok(!spoken.includes('*'), 'no markdown');
    assert.ok(!spoken.includes('\n'), 'no newlines');
    assert.ok(!spoken.includes('http'), 'no URLs');
    assert.ok(spoken.includes('lakh'), 'amounts spoken as words');
  });
});

describe('security helpers', () => {
  test('HMAC signatures verify and reject', () => {
    const body = '{"hello":"world"}';
    const sig = signPayload(body, 'secret');
    assert.equal(safeCompare(sig, signPayload(body, 'secret')), true);
    assert.equal(safeCompare(sig, signPayload(body, 'wrong')), false);
    assert.equal(safeCompare(sig, 'short'), false, 'length mismatch must not throw');
  });

  test('logs redact secrets and mask personal data', () => {
    const out = redact({
      apiKey: 'sk-live-123',
      authorization: 'Bearer abc',
      phone: '+923001234567',
      email: 'ahmed@example.com',
      product: 'iPhone 15',
    }) as Record<string, string>;

    assert.equal(out['apiKey'], '[REDACTED]');
    assert.equal(out['authorization'], '[REDACTED]');
    assert.ok(!out['phone']?.includes('1234567'), 'phone must be masked');
    assert.ok(!out['email']?.startsWith('ahmed@'), 'email must be masked');
    assert.equal(out['product'], 'iPhone 15', 'business data must stay readable');
  });

  test('maskPii keeps enough for support to recognise a record', () => {
    assert.equal(maskPii('a@b.com').includes('@b.com'), true);
    assert.ok(maskPii('+923001234567').endsWith('567'));
  });
});
