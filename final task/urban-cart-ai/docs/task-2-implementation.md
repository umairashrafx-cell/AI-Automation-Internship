# Task 2 — Implementation

What was built, how to run it, what needs credentials, and what does not work.

---

## 1. What was implemented

### Working, end to end, with no credentials

| # | Capability | Evidence |
|---|---|---|
| 1 | **PostgreSQL system of record** — 11 tables, constraints, triggers, indexes, views | `database/schema.sql`; constraint enforcement asserted in tests |
| 2 | **Supabase / pgvector knowledge store** — documents, chunks, HNSW index, `match_document_chunks`, RLS | `database/supabase-schema.sql` |
| 3 | **Real RAG pipeline** — genuine PDF, DOCX and XLSX parsing → clean → chunk → embed → vector search → grounded answer | 6 documents, 42 chunks; T03–T05, T14 |
| 4 | **Anti-hallucination enforcement** — three independent gates | T04, T12; unit tests for the claim auditor |
| 5 | **Chat API + web interface** — multi-turn, persisted, with sources shown | T17; <http://localhost:3000> |
| 6 | **Voice tool backend** — all 8 Vapi tools, speakable output | T16, real Vapi payloads in `vapi/test-payloads/` |
| 7 | **Lead capture** — six fields, scoring, de-duplication | T07, T08, T09, T18 |
| 8 | **Order lookup with ownership verification** | T06, T13 |
| 9 | **Complaint detection and escalation** — ticket + task in one transaction | T10, T11, T20 |
| 10 | **Selective Slack notification** — four event classes only, suppression logged | T08, T09, T10, T15 |
| 11 | **Centralised error handling** — safe customer messages, internal alerting | T15, T19, API tests |
| 12 | **7 n8n workflows** — importable JSON | `n8n/workflows/` |
| 13 | **Security** — API keys, HMAC, parameterised SQL, RLS, log redaction, rate limiting | API test suite |
| 14 | **89 automated tests** | `npm test` |

### Built and wired, needs credentials to transmit

These have complete client code and build the **real** request. Without keys the
exact payload is written to `data/outbox/<service>.jsonl` and the delivery is
recorded as `dry_run` — never as delivered.

| Integration | Status |
|---|---|
| **Slack** | Block Kit payloads for all four alert types; `chat.postMessage` and incoming-webhook paths |
| **Airtable** | Three tables, field maps, create/update, rate-paced backfill script |
| **Notion** | Page creation, markdown→blocks, handbook publisher |
| **Zapier** | Catch-hook payload with regional routing and a shared-secret token |
| **Google Drive** | Service-account JWT auth, recursive listing, Google-native export |
| **Vapi** | Complete assistant config; the tool backend is fully tested offline |
| **Supabase (hosted)** | RPC client; the identical SQL runs locally on pgvector |
| **OpenAI / Anthropic** | Real SDK/API clients with retry and timeout |

### Not implemented

Stated plainly:

- **Instagram DM ingestion** — the channel is modelled throughout (`instagram`
  is a valid channel everywhere) but no Meta Graph API integration exists.
- **WhatsApp Business API** — the same: modelled, not connected. Messages can be
  posted to `/api/chat` with `channel: "whatsapp"` today.
- **Outbound campaigns / proactive messaging** — out of scope.
- **Order placement or payment** — deliberately excluded (see the proposal's
  automation-vs-human section).
- **Urdu language support** — phase 3.
- **A live phone call** — requires a Vapi account and a phone number.

---

## 2. Setup

Full detail in [`setup.md`](setup.md).

```bash
npm install
cp .env.example .env
npm run demo:setup     # reset + seed + generate documents + build the index
npm start              # http://localhost:3000
npm run verify         # what is live, degraded or dry-run
npm test               # 89 tests
```

**Requirement: Node.js 22.6+.** Nothing else — no Docker, no database server, no
API keys.

---

## 3. Environment variables

Every variable is documented in [`.env.example`](../.env.example). Summary:

| Group | Keys | Without them |
|---|---|---|
| Core | `PORT`, `NODE_ENV`, `LOG_LEVEL`, `APP_BASE_URL` | Sensible defaults |
| Security | `INTERNAL_API_KEY`, `WEBHOOK_SIGNING_SECRET`, `CORS_ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MINUTE` | Dev allows; **production refuses to start** |
| Database | `DB_DRIVER`, `DATABASE_URL`, `PGLITE_DATA_DIR` | Embedded PGlite |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VECTOR_STORE` | Local pgvector |
| AI | `EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `LLM_EFFORT` | Local embeddings + extractive answers |
| RAG | `RAG_TOP_K`, `RAG_CHUNK_SIZE`, `RAG_CHUNK_OVERLAP`, `RAG_MIN_SIMILARITY`, `RAG_CONFIDENCE_THRESHOLD` | Provider-appropriate defaults |
| Business | `HIGH_VALUE_LEAD_BUDGET_PKR`, `HIGH_VALUE_LEAD_SCORE`, `DUPLICATE_LEAD_WINDOW_HOURS` | 150000 / 70 / 24 |
| Slack | `SLACK_BOT_TOKEN` or `SLACK_WEBHOOK_URL`, 3 channels | Dry run |
| Airtable | `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID`, 3 table names | Dry run |
| Notion | `NOTION_API_KEY`, `NOTION_PARENT_PAGE_ID` | Dry run |
| Drive | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `GOOGLE_DRIVE_FOLDER_ID` | Local `knowledge-base/` |
| Zapier | `ZAPIER_CATCH_HOOK_URL`, `ZAPIER_SHARED_SECRET` | Dry run |
| n8n | `N8N_BASE_URL`, `N8N_SHARED_SECRET` | Not required by the backend |
| Vapi | `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, `VAPI_WEBHOOK_SECRET` | Payload tests only |

**No secret appears anywhere in source.** `.env` is git-ignored;
`.env.example` documents every key with empty values.

---

## 4. Database setup

**Demo (default).** Embedded PGlite — a real PostgreSQL 18 build with pgvector
running in-process. `npm run demo:setup` applies `schema.sql` and
`supabase-schema.sql`, seeds the data and builds the index.

**Production.**
```bash
createdb urbancart
psql -d urbancart -f database/schema.sql
psql -d urbancart -f database/seed.sql
```
```bash
DB_DRIVER=postgres
DATABASE_URL=postgresql://user:password@host:5432/urbancart
```

Both schemas are idempotent (`CREATE ... IF NOT EXISTS`) and applied at boot, so
a fresh checkout works with a single `npm start`.

**Schema:** `customers`, `products`, `orders`, `order_items`, `leads`,
`conversations`, `conversation_messages`, `support_tickets`, `tasks`,
`workflow_executions`, `integration_events`, plus four reporting views and a
`next_reference()` function generating `LEAD-001` / `SUP-001` / `TASK-001` /
`UC-10500`.

**Seed data:** 8 products, 5 customers, 5 orders — including **UC-10452**
(delayed, the order from the meeting minutes), a delivered order, a pending
order and one out for delivery.

---

## 5. Supabase setup

SQL Editor → run `database/supabase-schema.sql`. It creates `documents`,
`document_chunks`, `document_ingestion_log`, the HNSW index, the
`match_document_chunks` RPC and the RLS policies.

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
VECTOR_STORE=supabase
```
```bash
npm run rag:reindex
```

Retrieval behaviour is identical to local pgvector — the Supabase backend calls
the *same* SQL function through the RPC endpoint.

---

## 6. Airtable, Google Drive, Notion, Slack, n8n, Zapier, Vapi

Each has its own setup guide:

- **Airtable** — [`../airtable/README.md`](../airtable/README.md) plus
  [`../airtable/base-schema.json`](../airtable/base-schema.json)
- **Zapier** — [`../zapier/README.md`](../zapier/README.md)
- **Vapi** — [`../vapi/README.md`](../vapi/README.md)
- **Google Drive** — [`rag.md`](rag.md)
- **Slack, Notion, n8n** — [`setup.md`](setup.md)
- **n8n workflows** — [`workflows.md`](workflows.md)

---

## 7. RAG setup

```bash
npm run kb:generate    # write the PDF/DOCX/XLSX documents
npm run rag:ingest     # extract → chunk → embed → store
npm run rag:reindex    # force re-embed (after changing provider)
npm run drive:sync     # ingest from Google Drive instead
```

Result: **6 documents, 42 chunks, all embedded** — across two PDFs, two DOCX,
one XLSX and one Markdown file. Full explanation in [`rag.md`](rag.md).

---

## 8. API endpoints

Complete reference: [`api.md`](api.md).

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | — | Component status, honest about degradation |
| `POST /api/chat` | — | Main customer entry point |
| `POST /api/voice/vapi` | `X-Vapi-Secret` | Vapi server webhook |
| `POST /api/tools/searchProduct` | `X-API-Key` | Live price and stock |
| `POST /api/tools/searchKnowledge` | `X-API-Key` | Grounded RAG answer |
| `POST /api/tools/getOrderStatus` | `X-API-Key` | Verified order lookup |
| `POST /api/tools/findCustomer` | `X-API-Key` | Recognise a returning customer |
| `POST /api/tools/createCustomer` | `X-API-Key` | Create/update a customer |
| `POST /api/tools/createLead` | `X-API-Key` | Full lead pipeline |
| `POST /api/tools/createSupportTicket` | `X-API-Key` | Log an issue |
| `POST /api/tools/escalateToHuman` | `X-API-Key` | Hand over |
| `POST /api/knowledge/search` | `X-API-Key` | Raw retrieval, for debugging |
| `POST /api/knowledge/ingest` | `X-API-Key` | Run ingestion |
| `GET /api/knowledge/documents` | `X-API-Key` | Knowledge-base status |
| `GET /api/admin/*` | `X-API-Key` | Overview, leads, tickets, tasks, orders, customers, executions, integrations, readiness |
| `GET /api/conversations/:id` | `X-API-Key` | Full transcript |
| `POST /api/webhooks/workflow-error` | HMAC | n8n failure reports |

---

## 9. Webhooks

**Inbound**

| Path | From | Auth |
|---|---|---|
| `/api/voice/vapi` | Vapi | `X-Vapi-Secret` |
| `/api/webhooks/workflow-error` | n8n Workflow 7 | HMAC-SHA256 |
| `/api/chat`, `/api/tools/*` | n8n workflows | `X-API-Key` |

**Outbound**

| To | When | Payload |
|---|---|---|
| Slack | 4 event classes | Block Kit |
| Airtable | Lead / ticket created | `{ records: [{ fields }], typecast: true }` |
| Zapier | High-value lead | Flat JSON with `signature_token` |
| Notion | `npm run notion:publish` | Page + blocks |

**n8n webhook paths:** `/webhook/urbancart/{chat,voice,lead,order-status,escalate}`.

---

## 10. Workflow descriptions

Full detail in [`workflows.md`](workflows.md).

| # | Workflow | Trigger | Nodes |
|---|---|---|---|
| 1 | Customer Chat Request | Webhook | 9 |
| 2 | Voice Request (Vapi) | Webhook | 11 |
| 3 | Lead Creation | Webhook | 10 |
| 4 | Order Lookup | Webhook | 10 |
| 5 | Complaint and Escalation | Webhook | 8 |
| 6 | RAG Document Ingestion | Drive change + 6-hourly | 9 |
| 7 | Centralised Error Handling | n8n Error Trigger | 6 |

Every workflow has an explicit failure branch that returns a **safe** customer
response and reports the failure to the backend, which logs it and alerts
engineering.

---

## 11. Testing

```bash
npm test   # 89 tests, ~8 seconds
```

- **42 unit tests** — phone, budget, text, chunking, embeddings, confidence,
  claim auditing, intent, lead scoring, voice formatting, security helpers
- **20 scenario tests** — the 17 required scenarios plus duplicate-lead, safe
  errors and escalation-policy coverage
- **27 API tests** — auth, validation, authorisation, error shape

Evidence table and known coverage gaps: [`testing.md`](testing.md).

---

## 12. Demo scenarios

Start the server, open <http://localhost:3000>, and use the example buttons —
or run them from the command line:

```bash
CHAT() { curl -s -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s).data;console.log('\n'+j.reply);console.log('  intent='+j.intent+' confidence='+j.confidence+' escalated='+j.escalated);j.actions.forEach(a=>console.log('  ['+a.type+'] '+a.detail+(a.reference?' ('+a.reference+')':'')));})"; }

# 1 — availability, from PostgreSQL
CHAT '{"message":"Is iPhone 15 available?","sessionId":"d1","channel":"web_chat"}'

# 2 — return policy, grounded in the PDF, and the CORRECT answer
CHAT '{"message":"Can I return headphones after 10 days?","sessionId":"d2","channel":"web_chat"}'

# 3 — warranty, grounded in the DOCX
CHAT '{"message":"Does the iPhone 15 have a warranty?","sessionId":"d3","channel":"web_chat"}'

# 4 — order status, verified, and flags the delay to operations
CHAT '{"message":"My order UC-10452 hasnt arrived yet","sessionId":"d4","channel":"web_chat","phone":"03001234567"}'

# 5 — high-value lead: Slack + Zapier
CHAT '{"message":"I want to buy iPhone 15. My budget is Rs. 200,000. I am in Lahore. My name is Ahmed Raza and my number is 0300 1234567.","sessionId":"d5","channel":"web_chat"}'

# 6 — damaged product: urgent ticket + task + Slack, human takeover
CHAT '{"message":"My product arrived damaged","sessionId":"d6","channel":"web_chat","phone":"03214567890"}'

# 7 — undocumented question: REFUSES rather than guessing
CHAT '{"message":"What is your policy on trading in my old laptop for credit?","sessionId":"d7","channel":"web_chat"}'
```

Then show what would have gone to each third party:

```bash
cat data/outbox/slack.jsonl    | tail -2
cat data/outbox/zapier.jsonl   | tail -1
cat data/outbox/airtable.jsonl | tail -1
```

And the voice path, without a phone call:

```bash
curl -s -X POST http://localhost:3000/api/voice/vapi -H "Content-Type: application/json" -d @vapi/test-payloads/tool-call-order-status.json
```

**Scenario 7 is the one to dwell on.** It is the requirement the client cared
about most, and a refusal is the correct, valuable answer.

---

## 13. Known limitations

**Demo-mode quality**
- The local embedding provider is **lexical**, not semantic: it matches shared
  vocabulary and misses paraphrases. Configure `OPENAI_API_KEY` for production
  recall.
- The extractive answerer quotes documents verbatim. It cannot hallucinate, but
  it reads stiffly and cannot synthesise across two passages.

**Architectural**
- PGlite is single-process; a hard kill can corrupt its data directory
  (`npm run db:reset` recovers). Rejected in production configuration.
- Rate limiting is in-process — correct for one node, wrong for several. Move to
  Redis before scaling out.
- The outbox is retried inline rather than by a background worker; a long
  third-party outage leaves rows pending until the next event.
- The Airtable sync is one-way and create-only; it does not reconcile a record
  deleted in Airtable.

**Functional**
- Intent classification is rule-based. It handles the documented cases well and
  will misclassify unusual phrasings; retrieval widening and the confidence gate
  limit the damage.
- Order verification accepts a full name as a second factor, which is weaker
  than a phone match. It is accepted only as an exact case-insensitive match, and
  failure routes to a human rather than refusing.
- No Instagram or WhatsApp API integration.
- English only.
- The claim auditor only checks numbers of two or more digits, so a fabricated
  "2 days" would not be caught by it (the confidence gate is the defence there).

**Untested**
- No load test — the latency figures are design targets, not measurements.
- No live third-party call is exercised in CI.
- The Vapi audio leg (telephony, STT, TTS) cannot be tested without a real call.

---

## 14. Production deployment recommendations

**Before launch**

1. `DB_DRIVER=postgres` with managed PostgreSQL, automated backups and PITR.
2. Supabase for vectors; verify RLS with the anon key.
3. `EMBEDDING_PROVIDER=openai`, then `npm run rag:reindex`.
4. `LLM_PROVIDER=anthropic`.
5. Generate and set `INTERNAL_API_KEY` and `WEBHOOK_SIGNING_SECRET` (the server
   refuses to start without them in production).
6. `NODE_ENV=production`; restrict `CORS_ALLOWED_ORIGINS`.
7. TLS terminated at the load balancer; HSTS on.
8. Secrets in a managed secret store, not in a `.env` file on disk.

**Infrastructure**
- Two API instances behind a load balancer (the API is stateless).
- Redis for rate limiting and the session cache.
- The outbox dispatcher as a separate worker process.
- n8n on its own instance with its own database, queue mode enabled.

**Operations**
- Alert on: `/health` not `ok`; any new `workflow_executions` failure; outbox
  rows with `attempts >= 3`; a rising escalation rate.
- Ship logs to a searchable store — they are structured JSON with a correlation
  id already.
- Review low-confidence escalations monthly and fix the *documents*.

**Data**
- Daily PostgreSQL backups, tested by restoring.
- A documented retention policy for conversation transcripts.
- Confirm the Drive service account stays read-only.

**Rollout**
- Week 1: internal staff only.
- Week 2: 10% of website chat, monitoring the escalation rate.
- Week 3: all website chat.
- Week 4: WhatsApp.
- Week 5: voice, starting with out-of-hours calls only.

Keep the human queue staffed throughout. The system is designed to escalate too
often at first; that rate should fall as the documents improve, and it is the
number worth watching.
