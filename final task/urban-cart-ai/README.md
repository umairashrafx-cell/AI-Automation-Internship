# UrbanCart AI Automation System

A 24/7 AI support and sales layer for UrbanCart, a Pakistani e-commerce
business. It answers customer questions on chat and voice using UrbanCart's own
documents and database, captures sales leads, handles order enquiries, and hands
anything difficult to a human — with the team alerted only when it matters.

Built for the MATalogics final task, from the UrbanCart discovery meeting of
1 September 2026.

---

## Run it

```bash
npm install
cp .env.example .env
npm run demo:setup
npm start
```

Open <http://localhost:3000>.

**Requires Node.js 22.6+ and nothing else.** No Docker, no database server, no
API keys. TypeScript runs directly through Node's native type stripping — there
is no build step.

```bash
npm run verify   # what is live, degraded, or in dry-run
npm test         # 89 tests, ~8 seconds
```

---

## What it does

Ask it these at <http://localhost:3000>:

| Ask | What happens |
|---|---|
| *"Is iPhone 15 available?"* | Exact price and stock, read from PostgreSQL. No model involved. |
| *"Can I return headphones after 10 days?"* | **No** — quotes the 7-day audio window from the return policy **PDF**, not the general 14-day rule. |
| *"Does the iPhone 15 have a warranty?"* | 12 months, from the warranty policy **DOCX**. |
| *"My order UC-10452 hasn't arrived"* | Verifies you own the order, returns the real delayed status, and flags the delay to operations. |
| *"I want to buy iPhone 15, budget Rs. 200,000, Lahore…"* | Creates the customer and lead, scores it 81/100, alerts `#urbancart-sales`, pushes it to the CRM via Zapier. |
| *"My product arrived damaged"* | Urgent ticket **and** an owned task, pages `#urbancart-support`, hands you to a person. |
| *"What's your laptop trade-in policy?"* | **Refuses to answer** and fetches a human, because no document covers it. |

That last one is the point of the whole system.

---

## The hard requirement

> *"We don't want the AI making up information."* — Sarah Malik, UrbanCart

Handled structurally, not by asking a model nicely:

1. **Price and stock never come from the AI.** They are read from SQL.
2. **Policy answers must cite retrieved evidence** from UrbanCart's own
   documents, scored against a confidence threshold. Below it, the system
   refuses and escalates.
3. **Generated answers are audited for invented numbers.** A price, return
   window or warranty term that does not trace back to the evidence is rejected
   and the turn escalates.
4. **Refusing is the easy path.** The prompt defines an explicit way to decline,
   because a model told only "don't guess" — with no alternative — still guesses.

---

## Architecture

```
CHANNELS      Website · WhatsApp · Instagram · Phone
AI LAYER      Chat API                  Vapi (voice)
ORCHESTRATION n8n — 7 workflows
BACKEND       intent → lookup / RAG → grounding gate → action
DATA          PostgreSQL (record)       Supabase pgvector (knowledge)
SURFACES      Airtable · Slack · Zapier · Notion
KNOWLEDGE     Google Drive → ingestion → Supabase
```

Diagrams: [`docs/diagrams/architecture.md`](docs/diagrams/architecture.md)

| Platform | Role | Why it, specifically |
|---|---|---|
| **PostgreSQL** | System of record | Constraints and transactions make the business data trustworthy |
| **Supabase** | Vectors + RAG | Managed pgvector with RLS, isolated from the OLTP workload |
| **n8n** | Orchestration | Self-hosted, version-controlled, and a failure path operations can *see* |
| **Zapier** | Sales stack integration | 8,000 OAuth integrations sales rewires themselves, off the critical path |
| **Vapi** | Voice receptionist | Owns telephony and speech; holds **no** business knowledge |
| **Airtable** | Operational UI | Grid and mobile UX that would otherwise be weeks of internal tooling |
| **Slack** | Selective alerts | Four event classes only, enforced in one module |
| **Notion** | Internal handbook | Published from git so docs cannot drift from the code |
| **Google Drive** | Source documents | The folder *is* the publishing workflow |
| **RAG** | Grounded knowledge | Policy answers change with the document, not with a deployment |

Why Airtable *and* PostgreSQL, and why Zapier *and* n8n, are answered in
[`docs/task-1-solution-proposal.md`](docs/task-1-solution-proposal.md) §17 and §22.

---

## It runs with no credentials — honestly

| Component | Without credentials | Reported as |
|---|---|---|
| Database | Embedded **PGlite** — a real PostgreSQL 18 + pgvector, in-process | `driver: pglite` |
| Vectors | pgvector in the same instance | `vectorStore: pgvector` |
| Embeddings | Deterministic hashed bag-of-words — real vector maths, **lexical only** | `semantic: false` |
| Answers | Extractive — composed verbatim from retrieved passages | `provider: extractive` |
| Slack / Airtable / Notion / Zapier | **Dry run** — the exact request is written to `data/outbox/<service>.jsonl` | `delivered: false, dryRun: true` |

Dry run never fabricates a successful response, and `/health` returns
**`degraded`**, not `ok`. You can read `data/outbox/slack.jsonl` and see the
precise Block Kit payload production would POST.

---

## Documentation

| Document | Contents |
|---|---|
| [Task 1 — Solution Proposal](docs/task-1-solution-proposal.md) | Business analysis, architecture, journeys, per-platform rationale, security, cost, 6–8 week plan |
| [Task 2 — Implementation](docs/task-2-implementation.md) | What was built, setup, endpoints, demo, limitations, production plan |
| [Architecture](docs/architecture.md) | Layers, code layout, key design decisions |
| [Diagrams](docs/diagrams/architecture.md) | 7 Mermaid diagrams |
| [RAG](docs/rag.md) | The pipeline in detail, and how to publish a document |
| [Workflows](docs/workflows.md) | All 7 n8n workflows |
| [API](docs/api.md) | Every endpoint and webhook |
| [AI behaviour](docs/ai-behaviour.md) | What it may answer, must refuse, and when a human takes over |
| [Setup](docs/setup.md) | Configuring each integration; troubleshooting |
| [Testing](docs/testing.md) | The evidence table and coverage gaps |

Per-platform guides: [`vapi/`](vapi/README.md) · [`airtable/`](airtable/README.md) · [`zapier/`](zapier/README.md)

---

## Project layout

```
urban-cart-ai/
├── backend/src/
│   ├── config/       env contract + business constants
│   ├── database/     SQL client (PGlite | node-postgres) + repositories
│   ├── rag/          extract · chunk · embed · retrieve · ground · ingest
│   ├── connectors/   slack · airtable · notion · drive · zapier · llm
│   ├── services/     intent · chat · voice · lead · order · escalation
│   └── api/          routes + middleware
├── frontend/         chat interface (no build step)
├── database/         schema.sql · supabase-schema.sql · seed.sql
├── knowledge-base/   real PDF · DOCX · XLSX policy documents
├── n8n/workflows/    7 importable workflows
├── vapi/             assistant config + test payloads
├── airtable/ zapier/ base schema + Zap configuration
├── scripts/          setup, ingestion, sync, verification
├── tests/            89 tests
└── docs/
```

---

## Tests

```
npm test    →  89 passing
```

42 unit · 20 documented scenarios · 27 API. Every test runs against a real
in-memory PostgreSQL with the real schema, the real seed data, and a RAG index
built by parsing the **real PDF, DOCX and XLSX files**. Integration assertions
read the actual outbound payload from the outbox rather than trusting a mock.

The evidence table is in [`docs/testing.md`](docs/testing.md).

---

## Needs credentials

Everything below has complete, working client code; it needs a key to transmit.

| Integration | Needed for | Get it from |
|---|---|---|
| OpenAI | Production-quality embeddings | platform.openai.com |
| Anthropic | Natural-language answers | console.anthropic.com |
| Supabase | Hosted vector store | supabase.com |
| Slack | Real notifications | api.slack.com/apps |
| Airtable | Operational mirror | airtable.com/create/tokens |
| Notion | Published handbook | notion.so/my-integrations |
| Google Drive | Document sync | Google Cloud Console |
| Zapier | CRM hand-off | zapier.com |
| Vapi + a phone number | Live calls | vapi.ai |

Voice is the only capability that cannot be demonstrated offline. The Vapi
**tool backend** is fully tested with real webhook payloads; only the audio leg
needs an account.

---

## Known limitations

The honest list is in
[Task 2 §13](docs/task-2-implementation.md#13-known-limitations). The main ones:
the offline embedding provider is lexical rather than semantic; there is no
Instagram or WhatsApp API integration (both channels are modelled but not
connected); English only; and there is no load test, so the latency figures in
the proposal are design targets rather than measurements.
