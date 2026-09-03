# Architecture

Diagrams: [`diagrams/architecture.md`](diagrams/architecture.md).
The reasoning behind each choice: [`task-1-solution-proposal.md`](task-1-solution-proposal.md).

---

## Layers

```
CHANNELS      Website · WhatsApp · Instagram · Phone
AI LAYER      Chat API                    Vapi (voice)
ORCHESTRATION n8n — 7 workflows
BACKEND       intent → lookup / RAG → grounding gate → action
DATA          PostgreSQL (record)         Supabase pgvector (knowledge)
SURFACES      Airtable · Slack · Zapier · Notion
KNOWLEDGE     Google Drive → ingestion → Supabase
```

### Two rules that shape everything

**1. The AI layer never touches a data store directly.** Every read and write
goes through the backend services, so the grounding rules, the ownership checks
and the notification policy are enforced in exactly one place and apply
identically to chat and voice. Adding Instagram later means adding a channel,
not re-testing the safety rules.

**2. Facts and prose are separated.** Anything that changes hourly (price,
stock, order status) is read from SQL. Anything that changes monthly and reads
as prose (policies) goes through retrieval. Putting stock in a vector index
guarantees stale answers; putting policy in the database means an engineer edits
it.

---

## Code layout

```
backend/src/
├── config/        env contract, validation, business constants
├── utils/         logger (with redaction), error taxonomy, phone, text, misc
├── database/
│   ├── sql-client.ts       one SQL surface, two transports
│   └── repositories/       parameterised queries, row → domain mapping
├── models/        domain types, zod request schemas
├── rag/           extractors · chunker · embeddings · vector-store
│                  · retriever · prompt · generator · ingest
├── connectors/    http (with dry-run) · slack · airtable · notion
│                  · google-drive · zapier · llm
├── services/      intent · chat · voice · product · order · lead
│                  · escalation · notification
└── api/           routes, middleware
```

**Dependency direction is strictly downward.** `api → services → rag/connectors
→ database → utils/config`. A repository never imports a service; a connector
never imports a route. This is what makes the services unit-testable without a
web server.

---

## Key design decisions

### One SQL dialect, two transports

`SqlClient` is implemented by **PGlite** (embedded PostgreSQL 18 + pgvector,
in-process, no server, no password) and by **node-postgres** (real PostgreSQL or
Supabase). Both speak the same dialect and the same `$1` placeholders, so the
repositories are written once and behave identically in development and
production.

PGlite is not a mock — it is a genuine PostgreSQL build compiled to WebAssembly,
running the project's real schema with real constraints, real triggers and a
real HNSW vector index. That is why the test suite can assert on a CHECK
constraint firing and mean it.

*Caveat, documented rather than hidden:* PGlite is single-process. A hard kill
can corrupt its data directory (`npm run db:reset` recovers). Production
configuration rejects it outright.

### The transactional outbox

Writing the business row and then calling Slack loses the notification whenever
the process dies in between. Instead, `integration_events` is written **in the
same transaction** as the lead or ticket. Delivery is attempted immediately and
the outcome recorded. A Slack or Airtable outage degrades to "delivered late",
never to "silently lost".

It also gives operations a queryable answer to "did that notification go out?"
and records **suppressions** — the deliberate decisions *not* to notify — with
their reason.

### Two-audience errors

Every `AppError` carries an internal message (logged, alerted, stored) **and** a
customer-safe message. Only the safe one is ever serialised to HTTP. This makes
"never show a customer a technical error" a property of the type system rather
than a rule people remember, and it is asserted by a test that scans every
response body for SQL, stack frames and module paths.

### Rule-based intent classification

Deliberately not an LLM call. It runs in under a millisecond on the customer's
latency path before any model or database work; it is deterministic, so tests
can assert on it; it costs nothing per message, and it is the highest-volume
operation in the system. Misclassification is recoverable — retrieval widens and
the confidence gate still protects the answer.

### Provider-specific thresholds

Cosine similarity is not comparable across embedding models. A good match is
~0.4–0.7 with a trained model and ~0.15–0.30 with the local hashed one. One
shared threshold would either reject every correct local answer or accept every
irrelevant OpenAI one, so the defaults are per-provider and an explicit
environment variable always wins.

### Graceful degradation, honestly reported

Every external dependency has a fallback that is **labelled as a fallback**:

| Missing | Falls back to | Reported as |
|---|---|---|
| `DATABASE_URL` | Embedded PGlite | `driver: pglite` |
| Supabase | Local pgvector | `vectorStore: pgvector` |
| `OPENAI_API_KEY` | Hashed lexical embeddings | `semantic: false` |
| `ANTHROPIC_API_KEY` | Extractive answerer | `provider: extractive` |
| SaaS credentials | Dry-run to `data/outbox/` | `delivered: false, dryRun: true` |

`/health` returns **`degraded`**, not `ok`, whenever any of these is active. A
fallback that reports itself as healthy is worse than no fallback.

---

## Request lifecycle

```
HTTP request
  → requestContext   (correlation id, timing, structured access log)
  → securityHeaders
  → cors
  → express.json     (raw body captured for HMAC verification)
  → rateLimit
  → route auth       (API key · Vapi secret · HMAC)
  → validateBody     (zod; unknown keys rejected)
  → handler → service → repository / RAG
  → errorHandler     (safe message out, internal detail logged + alerted)
```

The raw body is captured **before** JSON parsing because an HMAC signature is
computed over the exact bytes received.

---

## Data ownership

| Store | Owns | Never holds |
|---|---|---|
| PostgreSQL | Customers, products, orders, leads, conversations, tickets, tasks, execution log, outbox | Embeddings |
| Supabase | Documents, chunks, embeddings, ingestion log | Customer data |
| Airtable | An operational *mirror* + human workflow fields | Anything authoritative |
| Notion | Documentation | Any customer, lead or order data |
| Google Drive | Source documents | Anything the system writes |
| Slack | Transient notifications | State |

**One-way flows:** PostgreSQL → Airtable, git → Notion, Drive → Supabase.
Nothing is read back from a mirror as authoritative. If PostgreSQL and Airtable
disagree, PostgreSQL wins.

---

## Scaling path

**Now:** one API instance, one Postgres, one Supabase. Handles the stated volume
with headroom.

**At 10×:** two or more API instances behind a load balancer (the API is
stateless); Redis-backed rate limiting (the current in-process limiter is
explicitly single-node); a Postgres read replica for admin views; the outbox
dispatcher moved to a worker.

**At 100×:** a dedicated vector database past ~10⁶ chunks; conversations
partitioned by date; a real message queue in place of the outbox table.

We have not built for 100× now. The client asked for something reliable they can
expand — building a distributed system for a business that needs a dependable
one would be the wrong trade.
