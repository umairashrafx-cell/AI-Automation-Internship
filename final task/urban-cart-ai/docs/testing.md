# Testing

## Running the tests

```bash
npm test              # everything: 89 tests, ~8 seconds
npm run test:unit     # pure logic, no database
npm run test:scenarios # the 20 documented end-to-end scenarios
npm run test:api      # HTTP layer: auth, validation, error shape
npm run verify        # setup check: what is live, degraded or dry-run
```

## What the tests actually run against

Nothing is stubbed in the data path. Each test process gets a **private
in-memory PostgreSQL 18** (PGlite) with:

- the real `database/schema.sql` — every constraint, trigger and index
- the real `database/seed.sql` — the same products, customers and orders
- a real RAG index built by parsing the **real PDF, DOCX and XLSX files** in
  `knowledge-base/`

Third-party integrations run in dry-run, and assertions read the **actual
outbound payload** from `data/outbox/*.jsonl`. So "a Slack alert was sent" is
verified by inspecting the Block Kit body that would have been POSTed —
including the target channel — rather than by trusting a mock.

### Test isolation

`tests/helpers/env.ts` is imported first by every test file, before any
application module. This matters more than it looks: ES modules hoist imports,
so `process.env.NODE_ENV = 'test'` written at the top of a test file executes
*after* that file's imports have already been evaluated — and the config would
already have been read. During development this bug caused the suite to run
against the developer's persistent database and inherit its state. The dedicated
env module forces the environment to be set first, and additionally blanks every
third-party credential so a test can never reach a real API even if `.env` has
keys in it.

---

## Evidence table

Produced by `npm run test:scenarios`. All 20 pass.

| ID | Scenario | Input | Expected | Actual | Components | Result |
|---|---|---|---|---|---|---|
| T01 | Product availability | "Is iPhone 15 available?" | In-stock confirmation with the exact catalogue price, from PostgreSQL | "Yes, the iPhone 15 is in stock at Rs. 249,999." | chat API → intent → PostgreSQL products | **PASS** |
| T02 | Product price | "What is the price of Samsung Galaxy S24?" | Rs. 219,999 exactly, from the products table | "The Samsung Galaxy S24 is Rs. 219,999." | chat API → intent → PostgreSQL products | **PASS** |
| T03 | Shipping question | "Do you deliver to Lahore and how long does delivery take?" | Grounded answer citing the shipping policy | "According to UrbanCart Shipping and Delivery Policy: UrbanCart delivers to all major cities in Pakistan, including Lahore…" | chat API → RAG → shipping policy **PDF** | **PASS** |
| T04 | Return policy (discriminating) | "Can I return headphones after 10 days?" | **No** — audio has a 7-day window, so 10 days is outside it | "A return request for headphones or earbuds made after 7 days from delivery will not be accepted…" | chat API → RAG → return policy **PDF** | **PASS** |
| T05 | Warranty question | "Does the iPhone 15 have a warranty?" | 12-month manufacturer warranty, from the warranty document | "Smartphones and tablets carry a 12 month manufacturer warranty from the date of delivery…" | chat API → RAG → warranty policy **DOCX** | **PASS** |
| T06 | Existing order lookup | "My order UC-10452 hasnt arrived yet." (from +923001234567) | Delayed status with reason and overdue days; order issue raised | "Order UC-10452 is delayed: Courier hub congestion in Lahore… now 2 days overdue, so I've flagged it for our team." | chat API → PostgreSQL orders → Slack #support | **PASS** |
| T07 | Lead collection | Zainab Malik, 03211234567, Smart Watch, Rs. 20,000, Karachi, considering | Customer + lead created with all six fields | LEAD-001 created, score 43, customer created | lead service → PostgreSQL → Airtable | **PASS** |
| T08 | High-value lead notification | "I want to buy iPhone 15. Budget Rs. 200,000. Lahore. Ahmed Raza, 0300 1234567." | Lead created, Slack #sales alerted, Zapier event emitted | LEAD-002; Block Kit alert to #urbancart-sales; Zapier payload `budget_pkr=200000` | chat API → lead service → Slack → Zapier → Airtable | **PASS** |
| T09 | Normal lead (no notification) | Kamran Ali, charger, Rs. 2,500, Multan, browsing | Stored; **no** Slack; suppression recorded with a reason | LEAD-003 score 30, slack suppressed, `integration_events` = skipped | lead service → notification policy | **PASS** |
| T10 | Damaged product complaint | "My product arrived damaged, the screen is cracked." | Urgent ticket + task, Slack #support, polite handover | SUP-001 (urgent), task created, alert to #urbancart-support | chat API → escalation → tickets/tasks → Slack → Airtable | **PASS** |
| T11 | Angry customer escalation | "THIRD TIME… nobody has replied. This is unacceptable." | Urgent escalation, apology, no attempt to answer | SUP-002 `issue=angry_customer priority=urgent` | chat API → intent signals → escalation → Slack | **PASS** |
| T12 | Missing knowledge (anti-hallucination) | "What is your policy on trading in my old laptop for credit?" | Refuse, escalate, log the gap | `escalated=true`, SUP-003 (low_confidence), confidence 0.166 | chat API → RAG confidence gate → escalation | **PASS** |
| T13 | Invalid / unauthorised order | ABC-123 · UC-99999 · UC-10452 from the wrong phone | invalid_format · not_found · verification_required, **zero leakage** | exactly that; `order = null` when unverified | order service → ownership verification | **PASS** |
| T14 | RAG document update | Add price-match policy (5 days), then change to 14 days | New knowledge live; old version superseded; re-ingest is a no-op | created → updated → skipped_unchanged; answer now says 14 days | ingestion → chunker → embeddings → pgvector | **PASS** |
| T15 | Workflow failure | Embedding fails with HTTP 429 during ingestion | Slack #alerts with workflow + document + error; failure recorded; customer unaffected | alert routed to `alerts`, `workflow_executions` row written | error handling → workflow_executions → Slack | **PASS** |
| T16 | Voice request (Vapi) | Real Vapi `tool-calls` webhook: getOrderStatus, searchProduct | Speakable results, digits spelled out, exact spoken price | "Order U C, one zero four five two is delayed…"; "2 lakh 49 thousand 999 rupees" | Vapi webhook → voice service → PostgreSQL | **PASS** |
| T17 | Chat request (multi-turn) | Hello → ThinkBook availability → return policy | One conversation, correct answer per turn, transcript persisted | conversation `71220f6c` with 6 messages | chat API → conversations → products → RAG | **PASS** |
| T18 | Duplicate lead guard | Same customer + product twice on different channels | Second matches the first; no second Slack alert | both → LEAD-004; Slack payloads unchanged | lead service → duplicate window | **PASS** |
| T19 | Safe error responses | Empty message · 5,000-character message | Friendly guidance, never a technical error | "I didn't quite catch that. Could you rephrase it for me?" | validation → AppError safe messages | **PASS** |
| T20 | Escalation policy coverage | All six escalation triggers | Each has a priority, team, SLA and safe customer message | 6/6 fully specified | escalation service | **PASS** |

**Result: 20/20 documented scenarios pass.**

The assignment asks for 17 scenarios; T18–T20 were added because duplicate
leads, safe error text and escalation-policy completeness are the three things
most likely to be quietly wrong in a system like this.

---

## Unit tests (42)

| Area | What is asserted |
|---|---|
| Phone normalisation | Six local formats collapse to one E.164 value; malformed input is rejected rather than guessed |
| Budget parsing | "Rs. 200,000", "2 lakh", "200k" all parse; **"iPhone 15, budget Rs 200,000" does not return 15** |
| Text processing | Stemming groups inflections; `headphones → headphone` (not `headphon`); hyphen rejoining; markdown unescaping |
| Chunker | A chunk never spans two policy sections; heading trail preserved; size budget respected |
| Embeddings | Cosine similarity correctness including the zero-vector case |
| Confidence | On-topic evidence scores above off-topic evidence at the same similarity |
| Metadata filtering | Each question type routes to the document types that can answer it |
| Hallucination guard | Supported numbers pass, an invented "Rs. 5,000 fee" is caught, rephrasing does not false-positive |
| Intent classification | Eight intents; entity extraction; all five escalation signals |
| Lead scoring | The client's own example scores high value; a browser does not; no phone → never high value |
| Voice formatting | Amounts exact not rounded; order numbers digit by digit; markdown/URLs stripped |
| Security | HMAC verify/reject including length mismatch; log redaction of secrets and PII |

## API tests (27)

Auth (missing/wrong/correct key, Vapi secret, HMAC signature, tampered body),
validation (missing fields, unknown fields, bad phone, bad order number),
order-lookup authorisation, and a blanket assertion that **no response body ever
contains a stack trace, SQL, or a module path**.

---

## Manual demo

With the server running (`npm start`), open <http://localhost:3000> and use the
example buttons, or:

```bash
curl -s -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d '{"message":"Can I return headphones after 10 days?","sessionId":"demo","channel":"web_chat"}'
```

Then inspect what the system would have sent to each third party:

```bash
cat data/outbox/slack.jsonl | tail -1
cat data/outbox/zapier.jsonl | tail -1
cat data/outbox/airtable.jsonl | tail -1
```

Voice, without making a call:

```bash
curl -s -X POST http://localhost:3000/api/voice/vapi -H "Content-Type: application/json" -H "X-Vapi-Secret: $VAPI_WEBHOOK_SECRET" -d @vapi/test-payloads/tool-call-order-status.json
```

---

## Known gaps in test coverage

Stated plainly rather than implied:

- **No load test.** The latency and throughput figures in the proposal are
  design targets, not measurements.
- **No real third-party integration test.** Slack, Airtable, Notion, Zapier and
  Drive are exercised as far as the outbound request; the network call itself
  is only executed when credentials are configured.
- **No end-to-end voice test.** The Vapi *tool backend* is fully tested with real
  webhook payloads; the audio leg (telephony, STT, TTS) is not, and cannot be
  without a live call.
- **Retrieval quality is tested with the local embedding provider.** With
  OpenAI embeddings recall improves substantially, but the assertions are
  written against the weaker provider so they hold in both modes.
