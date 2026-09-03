# UrbanCart — Solution Proposal

**Client:** UrbanCart (e-commerce, Pakistan)
**Prepared for:** Sarah Malik, Operations Manager
**Discovery meeting:** 1 September 2026 (Business Developer: Ibrahim Wasiq Qurashi)
**Prepared by:** Solutions & Automation Engineering
**Version:** 1.0

---

## 1. Executive summary

UrbanCart sells electronics, accessories, home and lifestyle products online,
taking orders through its website, Instagram, WhatsApp and the phone. Its
support team answers most customer questions by hand, during office hours only.
Anything that arrives at night waits until morning, and some of those customers
do not come back.

We propose a **24/7 AI support and sales layer** that answers the routine
questions from UrbanCart's own documents and database, captures sales leads with
the six details the sales team needs, answers order-status questions without a
human searching for the order, and hands anything difficult to a person
immediately — with the support team alerted the moment that happens.

Four commitments shape every design decision below.

**The AI will not invent business information.** This is the client's stated
hardest requirement and the one most systems get wrong. Our approach is not to
ask the model nicely. Product price and stock are read from the database and
never from the AI. Policy answers must be supported by a retrieved passage from
UrbanCart's own documents, scored against a confidence threshold; below it the
system refuses to answer and fetches a human. Any answer that does slip through
containing a number — a price, a return window, a warranty term — is checked
against the retrieved evidence and rejected if the number is not there. Refusing
is designed to be the easy path, not the exceptional one.

**A human takes over when a human should.** Damaged goods, complicated refunds,
angry customers, missing information and low AI confidence all escalate. Each
creates a support ticket *and* an owned task in one transaction, so an
escalation can never exist without somebody responsible for it.

**Slack stays quiet.** Only four event classes ever notify: a high-value lead, a
serious complaint, a failed automation, and an important order issue. Everything
else is recorded and visible in Airtable and the admin API. When the system
decides *not* to notify, it records that decision and the reason, so "why didn't
we hear about this?" always has an answer.

**Business staff can change the AI's knowledge without an engineer.** Policies
change; the client said so explicitly. Someone drops an updated PDF into a
Google Drive folder and the assistant is using it within the hour. No code
change, no deployment, no developer.

An initial working version is deliverable in **6–8 weeks**, in three phases,
each of which leaves UrbanCart with something usable rather than a half-built
system.

---

## 2. Business problems

Taken directly from the meeting, with the operational cost of each.

| # | Problem (client's words) | What it costs today |
|---|---|---|
| 1 | *"Our biggest problem is customer support… Our support team answers most of these manually."* | Agent time consumed by the same handful of questions about price, availability, delivery and returns. |
| 2 | *"If someone sends a message at night, they may have to wait until the next day. We're losing potential customers."* | Lost revenue outside 9–9, Mon–Sat. Purchase intent is perishable. |
| 3 | *"We don't want the AI making up information."* | A wrong policy quoted to a customer is worse than no answer — it becomes a promise the business has to honour or refuse. |
| 4 | *"Our sales team currently receives these leads through different places, so it's difficult to track them."* | Leads scattered across WhatsApp, Instagram DMs and phone notes. No pipeline, no follow-up discipline. |
| 5 | *"We have data in different places… We don't have one proper internal system."* | Customers in spreadsheets, orders in the e-commerce system, complaints in a separate sheet. Nobody has the whole picture. |
| 6 | *"The support agent has to find the order and then tell them the status."* | A human doing a lookup a machine can do in 50 ms. |
| 7 | *"If someone says their product arrived damaged… the conversation should be passed to a human."* | Needs to be reliable and immediate; a missed damaged-goods report is a lost customer. |
| 8 | *"Currently, someone has to manually update everything… We don't want developers changing the system every time we update a PDF."* | Knowledge goes stale, or engineering becomes a bottleneck for a business process. |
| 9 | *"We don't want Slack to become noisy."* | Alert fatigue makes the important alerts invisible. |

### Root causes

Three underlying issues generate all nine:

1. **No single source of truth.** Data is fragmented, so every question requires
   a human to assemble the answer.
2. **Knowledge is in documents, not in a system.** Policies exist as PDFs a
   person must read; nothing can query them.
3. **No routing layer.** Every interaction, trivial or serious, lands in the
   same human queue at the same priority.

---

## 3. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| F1 | Answer product availability, price and specification questions from live data | Must |
| F2 | Answer policy questions (returns, shipping, warranty, payment) from UrbanCart's own documents | Must |
| F3 | Answer order-status questions for an existing order, after verifying the caller | Must |
| F4 | Capture leads with name, phone, product, budget, location and purchase intent | Must |
| F5 | Detect complaints and escalate to a human with a ticket and an owned task | Must |
| F6 | Operate on web chat, WhatsApp and voice, with consistent behaviour | Must |
| F7 | Notify Slack only for high-value leads, serious complaints, automation failures and order issues | Must |
| F8 | Refuse to answer, and fetch a human, when the knowledge base cannot support an answer | Must |
| F9 | Update AI knowledge automatically when a document changes in Google Drive | Must |
| F10 | Give non-technical staff a usable view of leads, support issues and problem orders | Must |
| F11 | Show a returning customer's history to the agent and the AI | Should |
| F12 | Record every conversation with its intent, confidence and cited sources | Should |
| F13 | Centralised error handling with internal alerting and safe customer messages | Must |
| F14 | Publish and maintain internal documentation the team can read | Should |
| F15 | Push high-value leads into the sales team's own CRM and tooling | Should |
| F16 | Instagram DM support | Could (phase 3) |
| F17 | Urdu / Roman-Urdu conversation | Could (phase 3) |

---

## 4. Non-functional requirements

The client named their own priorities: *reliability, security, easy maintenance,
reasonable cost, ability to scale, accurate AI responses.*

| Area | Target | How it is achieved |
|---|---|---|
| **Availability** | 99.5% for the chat/voice path | Stateless API behind a load balancer; managed Postgres with automated failover; every integration failure degrades to a safe reply rather than an outage |
| **Latency** | p95 < 2.5 s chat; < 1.2 s per voice tool call | Price/stock/order answered directly from SQL with no model call; RAG only where it is needed; ANN vector index |
| **Accuracy** | Zero fabricated prices, policies or dates | Database for facts, retrieval for policy, confidence gate, numeric-claim audit; measured by the test suite |
| **Security** | No secret in source; least privilege; PII minimised | Env-only config, API-key + HMAC auth, parameterised SQL, Supabase RLS, log redaction, ownership checks on order lookups |
| **Maintainability** | A policy change needs no engineer | Document-driven knowledge; version-controlled workflows; one shared SQL dialect across dev and prod |
| **Cost** | Under ~$250/month at launch volume | Rule-based intent (free), SQL for facts, RAG only when required, content-hashed ingestion so unchanged documents cost nothing |
| **Scalability** | 10× traffic without redesign | Horizontal API scaling; connection pooling; queue-backed integrations; ANN index scales to ~10⁵ chunks on one node |
| **Observability** | Every interaction traceable end to end | One correlation id across logs, `workflow_executions` and the integration outbox |
| **Data protection** | Customer data stays inside the system of record | Notion holds no customer data; Airtable holds only operational fields; logs mask phone and email |

---

## 5. Users and roles

| Role | What they need | Where they get it |
|---|---|---|
| **Customer** | An accurate answer at any hour, on the channel they already use | Web chat, WhatsApp, phone (Vapi) |
| **Sales team** | Qualified leads with context, promptly | Slack `#urbancart-sales` for high-value; Airtable *Leads*; their own CRM via Zapier |
| **Support team** | Immediate notice of serious issues, with the customer's history | Slack `#urbancart-support`; Airtable *Support Issues* |
| **Operations team** | Problem orders and open tasks | Airtable *Orders* and tasks; `/api/admin` |
| **Management** | A view of what is happening | `/api/admin/overview`; Airtable dashboards |
| **Engineering** | To know when something breaks, before a customer does | Slack `#urbancart-alerts`; `workflow_executions` |
| **Content owner** (non-technical) | To publish a policy change without a developer | Drop a file into the Google Drive folder |

---

## 6. Customer journeys — overview

```
                    ┌──────────────────────────────┐
                    │  Customer makes contact      │
                    │  web · WhatsApp · Instagram  │
                    │  · phone                     │
                    └──────────────┬───────────────┘
                                   ▼
                       Classify intent · identify customer
                                   │
   ┌─────────────┬─────────────┬───┴────────┬─────────────┬──────────────┐
   ▼             ▼             ▼            ▼             ▼              ▼
Product      Policy        Order        Buying      Complaint      Unclear /
question     question      status       intent      or anger       undocumented
   │             │             │            │             │              │
PostgreSQL   RAG over      Verify +     Collect 6     Ticket +      Refuse to
(exact)      documents     PostgreSQL   fields       task, page     guess →
   │             │             │            │        support        escalate
   └─────────────┴─────────────┴────────────┴─────────────┴──────────────┘
                                   ▼
                    Every turn recorded: intent, confidence,
                    sources cited, actions taken
```

---

## 7. Chat journey

**Channels:** website widget, WhatsApp Business, Instagram DM (phase 3).
Identity comes from the phone number where the channel supplies one; the website
asks only when it needs to.

1. **Message arrives** at `POST /api/chat` (directly, or via the n8n webhook for
   WhatsApp).
2. **Validate.** Empty or oversized input gets a friendly rephrase request, not
   an error.
3. **Classify** intent and extract entities — order number, product, phone,
   budget, location, name, purchase intent — with rules, in under a millisecond,
   before any model or database work.
4. **Identify the customer** by phone. A returning customer's history (order
   count, last order, lifetime value, open tickets) is loaded so the assistant
   is not "starting from zero", exactly as the client asked.
5. **Check escalation signals first.** Damaged goods, anger, a refund demand or
   an explicit request for a person short-circuits everything else.
6. **Route by intent:**
   - *availability / price* → PostgreSQL, exact, no model call
   - *order status* → verify ownership, then PostgreSQL
   - *policy / product detail* → RAG
   - *buying intent* → lead capture
7. **Ground the answer.** Retrieved passages plus live database facts are given
   to the model with a prompt that permits only those sources, and a defined
   way to decline.
8. **Gate it.** Low confidence, no evidence, or an unsupported number → escalate
   instead of answering.
9. **Reply and record.** The turn, its intent, confidence and cited sources are
   persisted.

**Example — the client's own case.** *"Can I return headphones after 10 days?"*
Retrieval is filtered to the return policy; the top passage is the audio-products
section; the answer is **no** — audio has a 7-day window, not the general 14 —
citing the return policy. A system that retrieved the general section would
answer "yes" and be wrong, which is why chunks are cut on section boundaries.

---

## 8. Voice journey

**Platform:** Vapi handles telephony, transcription, the turn loop and speech.
It holds **no** business knowledge — every fact it can say comes from a tool call
into our backend. A voice model is the hardest place to enforce grounding
(nothing to click, no source to show, no time to check), so we remove the
opportunity rather than rely on instructions alone.

1. Call connects; the assistant greets the caller.
2. `findCustomer` runs on the caller id. A known caller is greeted by name.
3. The caller states their need; the assistant picks a tool:
   `searchProduct` · `searchKnowledge` · `getOrderStatus` · `createLead` ·
   `createSupportTicket` · `escalateToHuman`.
4. The backend answers with **speakable** text: no markdown, no lists, amounts
   as spoken words, order numbers spelled digit by digit ("U C, one zero four
   five two" — because "UC ten thousand four hundred fifty two" is useless to
   someone holding an SMS).
5. Lead capture asks for the six fields **one question at a time**. A voice model
   asked for six things at once gets two answers back.
6. Complaints and anger escalate immediately; the call is handed over.
7. After the call, Vapi's analysis is scored on *"did it invent anything?"* —
   the metric that matters here — and the transcript is stored.

**Caller id doubles as verification.** On the phone, the number the customer is
calling from is checked against the order, so order status can be given without
an awkward interrogation.

---

## 9. Lead journey

The six fields the client listed are the contract: **name, phone, product,
budget, location, ready-to-buy or just asking.**

1. **Collect** — conversationally, asking only for what is missing.
2. **Validate** — the phone is normalised to E.164 so the same person is one
   record whether they called, messaged, or filled in the form.
3. **Find or create the customer** — a single atomic upsert keyed on phone, so
   two concurrent messages cannot create two customers.
4. **De-duplicate** — the same customer asking about the same product within 24
   hours is *one* lead. Without this, a customer who phones and then also
   messages pages the sales team twice.
5. **Score** — budget dominates (up to 45 points), then purchase intent (30), a
   matched catalogue product (10), a stated location (5), and an existing
   relationship (10). No reachable phone number halves the score, because sales
   cannot act on a lead they cannot call.
6. **Store in PostgreSQL** — this is the commit point. Everything after it is a
   side effect.
7. **Mirror to Airtable** so sales can work it.
8. **Notify Slack `#urbancart-sales`** — *only* if high value.
9. **Emit to Zapier**, which fans out into the CRM, email, calendar and the
   forecast sheet.

**Calibration.** The client's own example — *"New customer interested in iPhone
15, budget Rs. 200,000, located in Lahore"* — scores 81/100 and is high value.
That example is a test case in the suite, so the threshold cannot drift away
from what the client asked for.

---

## 10. Order inquiry journey

**Rule: verify before revealing.** Order numbers are sequential and guessable, so
an unverified lookup would be an enumeration hole exposing names, addresses and
purchase history.

1. **Extract** the order number from anything the customer types — "UC-10452",
   "uc 10452", or a whole sentence containing it.
2. **Validate the format** (`UC-` + five digits). A malformed number gets a
   correction, not a database query.
3. **Verify ownership** — the phone on the order (free from caller id on voice)
   or the full name on the order.
4. **If unverified, reveal nothing** — not the status, not even whether the
   order exists. The customer is asked to confirm a detail; if they cannot, a
   human takes over rather than being refused outright.
5. **Answer from PostgreSQL** — status, dates, items, courier, tracking, and the
   delay reason when there is one. No model involved; the answer is exact.
6. **Redact** — the street address is never read back in full.
7. **Flag genuine problems** — an order more than three days past its expected
   delivery raises an *order issue* in Slack `#urbancart-support`.

---

## 11. Complaint and escalation journey

**Triggers**, exactly as the client specified, plus one we consider mandatory:

| Trigger | Priority | Team | First response |
|---|---|---|---|
| Product arrived damaged | Urgent | Support | 1 hour |
| Complicated refund | High | Support | 4 hours |
| Angry customer | Urgent | Support | 1 hour |
| Customer asks for a human | High | Support | 4 hours |
| Required information unavailable | Medium | Support | 1 working day |
| **AI cannot answer confidently** | Medium | Support | 1 working day |

The last one is ours. It converts "the AI does not know" from a silent failure
into a tracked work item, which is also how the knowledge base gets better: each
one names a real gap.

**On escalation:**
1. A **support ticket** is created with the customer's own words.
2. A **task** is created and assigned to a team, in the same transaction — a
   ticket can never exist without an owner.
3. The conversation is marked escalated.
4. The issue is mirrored to Airtable.
5. Slack `#urbancart-support` is paged **for the top four triggers only**.
   Low-confidence and missing-information cases are queued, not paged; treating
   "the AI declined to guess" as urgent would flood the queue and defeat the
   quiet-Slack rule.
6. The customer gets an apology, a reference number, and a clear statement that
   a person will contact them. Never a ticket internal, never an error.

---

## 12. Automation versus human control

The dividing line is **the cost of being wrong**.

### Fully automated
- Product availability, price, specifications
- Delivery coverage and timelines
- Documented return, warranty and payment policy
- Order status for a verified customer
- Lead capture and scoring
- Complaint detection, ticket and task creation
- Internal notifications
- Knowledge ingestion

### Automated, human notified
- High-value leads — captured automatically, a person calls
- Order issues — detected automatically, a person chases the courier

### Always human
- Refund and replacement **decisions**
- Damaged-goods resolution
- Anything with an angry customer
- Warranty claim outcomes
- Discounts, exceptions, goodwill
- Anything the knowledge base does not cover

### Never automated
- Payment collection or card details
- Changing an order after dispatch
- Legal or dispute correspondence

**The asymmetry is deliberate.** A missed automation costs one agent-minute. A
wrong automated answer costs a refund, a review, or a customer. So the system is
built to escalate too often rather than too rarely, and the escalation rate is a
metric we tune down over time by improving the documents — not by loosening the
gate.

---

## 13. Complete architecture

See [`diagrams/architecture.md`](diagrams/architecture.md) for the rendered
diagrams. In summary:

```
CUSTOMER CHANNELS   Website · WhatsApp · Instagram · Phone
        │
AI LAYER            Chat API                  Vapi (voice)
        │
ORCHESTRATION       n8n — 7 workflows
        │
BACKEND             intent → lookup / RAG → grounding gate → action
        │
DATA                PostgreSQL (record)      Supabase pgvector (knowledge)
        │
SURFACES            Airtable (ops) · Slack (alerts) · Zapier (CRM) · Notion (docs)
        │
KNOWLEDGE           Google Drive → ingestion → Supabase
```

### Why this shape

**The AI layer never touches a data store directly.** Everything goes through
the backend services, so the grounding rules, the verification rules and the
notification policy are enforced in exactly one place and apply identically to
chat and voice. Adding Instagram later means adding a channel, not re-testing
the safety rules.

**Facts and prose are separated.** Anything that changes hourly (price, stock,
order status) is read from SQL. Anything that changes monthly and reads as prose
(policies) goes through retrieval. Putting stock levels in a vector index would
guarantee stale answers; putting policy in the database would mean an engineer
edits it.

**Every external integration is downstream of a committed transaction.** The
business record is written first. Slack, Airtable and Zapier are then attempted
and their outcome recorded in an outbox table. No third-party outage can lose a
lead or a complaint.

---

## 14. Data flow

### A policy question
```
Customer → Chat API → classify (policy_question)
        → pick document types (metadata filter)
        → embed question → cosine search in Supabase
        → confidence gate ──low──→ ticket + human
                           │
                          high
                           ▼
        → LLM with grounding prompt + retrieved passages
        → numeric-claim audit ──fail──→ ticket + human
                           │
                         pass
                           ▼
        → answer + cited sources → customer
        → conversation, intent, confidence and sources persisted
```

### A high-value lead
```
Customer → classify (lead_capture) → collect six fields
        → normalise phone → upsert customer ─┐
        → duplicate check (24h window)       │ one transaction
        → score → INSERT lead ───────────────┘
        → [committed]
        → Airtable mirror        (outbox: delivered | failed | dry_run)
        → Slack #sales           (outbox)
        → Zapier → CRM/email/calendar (outbox)
        → confirmation to customer
```

### A document update
```
Business user drops a PDF in Google Drive
        → n8n Drive trigger (or the 6-hourly safety net)
        → download → extract → clean → chunk → embed
        → supersede the old version, insert the new
        → knowledge live; unchanged files skipped at zero cost
```

---

## 15. PostgreSQL data model

**Role: the structured relational system of record.** Everything the business
must be able to trust lives here, with constraints that make bad data
impossible rather than merely unlikely.

| Table | Purpose | Notable design |
|---|---|---|
| `customers` | One row per person | Phone is the natural key — the one identifier present on every channel — stored E.164 with a format CHECK |
| `products` | Catalogue with live price and stock | `search_aliases[]` (GIN) so "iphone", "apple 15" resolve; full-text index for descriptive search |
| `orders` | Order header | `UC-\d{5}` format CHECK; a CHECK that a delivered order has a delivery timestamp and nothing else does |
| `order_items` | Line items | Unit price stored **at time of sale**, so a later price change cannot rewrite history |
| `leads` | Sales pipeline | Score, high-value flag, and a dedupe index on `(customer_id, lower(product), created_at)` |
| `conversations` | One per (channel, session) | Unique on `(channel, session_id)` so a live chat and a call do not merge |
| `conversation_messages` | Append-only turns | Stores confidence and the cited sources per assistant message |
| `support_tickets` | Escalations | Issue type, priority, owning team, escalation reason |
| `tasks` | The work item | `CHECK (num_nonnulls(ticket_id, lead_id) = 1)` — exactly one parent, never both |
| `workflow_executions` | Every run, success or failure | Queryable execution history without opening n8n |
| `integration_events` | Transactional outbox | Written in the same transaction as the business row |

**Deliberate choices.**

- **UUID primary keys** so the AI layer can generate an id before the row
  reaches the database, making webhook retries idempotent.
- **CHECK constraints rather than ENUM types** for status columns. Adding a
  status becomes a cheap migration instead of an `ALTER TYPE` that takes an
  ACCESS EXCLUSIVE lock on every dependent table.
- **`NUMERIC(12,2)` for all money.** Never floating point.
- **Normalised messages plus a view.** The requirement asked for a `messages`
  field on conversations; messages are stored in an append-only child table
  (indexable, no row rewrite per turn) and the requested JSON shape is exposed
  by the `conversations_with_messages` view. The interface is honoured without
  accepting the storage cost.
- **A transactional outbox**, because "write the row, then call Slack" loses
  notifications whenever the process dies in between.

Full DDL: [`../database/schema.sql`](../database/schema.sql).

---

## 16. Supabase architecture

**Role: the vector and knowledge store.**

| Table | Purpose |
|---|---|
| `documents` | One row per source file: filename, type, source, content hash, version, status, effective date |
| `document_chunks` | Retrievable passages with a `vector(1536)` embedding and JSONB metadata |
| `document_ingestion_log` | Every ingestion attempt, successful or not |

**`match_document_chunks(...)`** is the similarity-search function: cosine
similarity (not distance, so one intuitive threshold works), with metadata
pre-filtering by document type and JSONB containment, restricted to active
documents, preferring the newest effective version on ties.

**Indexing.** HNSW on `vector_cosine_ops`, degrading to IVFFlat and then to a
sequential scan if the pgvector version is older — the schema applies cleanly
everywhere rather than failing on an unexpected build.

**Row Level Security** is enabled on all three tables. Only the service role —
server-side only — can read them. The anon key that ships to browsers gets
nothing. The knowledge base is internal business information, not public content.

**Versioning, not deletion.** Re-ingesting a changed file marks the previous row
`superseded` and removes its chunks. The history remains, so an answer given
last month can still be explained; the dead vectors do not bloat the index.

### Why Supabase is separate from PostgreSQL

They have opposite operational profiles. Embeddings are large, immutable,
rebuilt in bulk by a background job, and queried with an approximate index.
Orders and leads are small, mutable, and queried transactionally. Separating
them means a catalogue re-index can never slow down or lock the orders table,
and each store is sized and scaled independently. Supabase also brings pgvector,
RLS and a managed backup story without us operating it.

*(Both schemas are portable. In the local demo they run in one embedded
PostgreSQL instance; in production they are two managed databases. The SQL is
identical either way.)*

---

## 17. Airtable's role

**The operational surface for people who do not write SQL.**

PostgreSQL enforces that a lead belongs to a customer and that an order total is
never negative. What it cannot do is let an operations manager filter today's
overdue Lahore deliveries on her phone, tick one off and add a note — without
SQL, without a developer, without a ticket. Airtable does exactly that, and is
correspondingly useless as a system of record: no foreign keys, no transactions,
a 5-request-per-second API limit, and a schema anyone can change by accident.

So the split is by **job**:

| | PostgreSQL | Airtable |
|---|---|---|
| Role | System of record | Operational mirror |
| Guarantees | FKs, constraints, ACID | None to rely on |
| Audience | The system | Sales, support, operations |
| If it fails | Customers get the safe fallback | Staff use `/api/admin`; nothing is lost |

**Tables:** *Leads* (with the six captured fields, score and high-value flag),
*Support Issues* (issue, priority, team, status), *Orders* (only those needing
attention — mirroring every order would make it a worse copy of the database).

**One-way sync.** PostgreSQL is written first; Airtable is mirrored after
commit, queued through the outbox. Columns the humans own (`Owner`,
`Follow Up Date`, `Resolution`) are never overwritten. Nothing is read back as
authoritative. If they disagree, PostgreSQL wins.

Details: [`../airtable/README.md`](../airtable/README.md).

---

## 18. Google Drive's role

**The source document repository — and the reason no developer is needed for a
policy change.**

The client already keeps policies as PDFs, Word documents and spreadsheets. We
do not migrate them into a CMS; we watch the folder they already use.

```
UrbanCart Knowledge Base/
├── Products/     product catalogue, specifications
├── Shipping/     delivery coverage, timelines, charges
├── Returns/      return and refund policy
├── Warranty/     warranty coverage and claims
├── Support/      support guidelines and escalation rules
└── Training/     internal training and FAQ notes
```

**The folder is the classifier.** A file in `Returns/` is a return policy. That
is the entire publishing process: a business user drops in an updated PDF, and
within the hour — Drive change trigger, plus a six-hourly safety net for missed
notifications — the assistant is answering from it.

Formats handled: PDF, DOCX, XLSX, CSV, Markdown, plus Google Docs and Sheets
(exported to DOCX/XLSX automatically).

**Ingestion is content-hashed**, so the safety net is cheap: unchanged files are
skipped and cost nothing in embedding calls.

---

## 19. Notion's role

**Internal documentation for humans.** The team already uses it.

The handbook — architecture, workflow documentation, AI behaviour and escalation
rules, support procedures, lead handling, RAG documentation, troubleshooting,
API reference — is **published from the repository** by a script, not written in
Notion and copied back.

That direction is the point: docs live in git next to the code that implements
them, change in the same commit, and are reviewed together. Documentation cannot
drift from behaviour if the behaviour and its description ship as one change.

**Notion holds no customer, lead or order data.** That belongs in PostgreSQL and
Airtable. Notion is for the team's understanding of the system, which keeps a
broadly-shared workspace free of personal data.

---

## 20. Slack's role

**Selective internal notification.** The client's requirement — *"We don't want
Slack to become noisy"* — is a hard constraint, so it is enforced structurally
rather than by convention: exactly one module can send to Slack, and it accepts
only four event types. Anything else is a compile error, then a runtime refusal.

| Event | Channel | Example |
|---|---|---|
| High-value lead | `#urbancart-sales` | 🔥 Ahmed · iPhone 15 · Rs. 200,000 · Lahore · LEAD-001 |
| Serious complaint | `#urbancart-support` | 🚨 Damaged product · URGENT · SUP-001 · human required |
| Automation failure | `#urbancart-alerts` | ⚠️ RAG ingestion failed · return-policy.pdf · embedding error |
| Order issue | `#urbancart-support` | 📦 UC-10452 · 3 days overdue |

**Never notified:** ordinary product, price, delivery, return and warranty
questions; normal leads; low-confidence escalations (queued, not paged);
successful automation runs.

**Suppression is recorded.** When the system decides not to notify, it writes a
row saying so and why. "Why didn't we hear about this?" always has an answer,
which is what makes a quiet channel trustworthy rather than suspicious.

---

## 21. n8n's role

**The primary orchestration layer**, and the operational contract between the AI
layer and the business systems.

| # | Workflow | Trigger | Does |
|---|---|---|---|
| 1 | Customer Chat Request | Webhook | Validate → backend → answer, with a safe fallback |
| 2 | Voice Request | Vapi webhook | Verify secret → route → execute tool → speakable result |
| 3 | Lead Creation | Webhook | Validate the six fields → create → mirror → notify → hand off |
| 4 | Order Lookup | Webhook | Extract and validate the number → verify owner → status |
| 5 | Complaint / Escalation | Webhook | Classify the complaint → ticket + task → page support |
| 6 | RAG Document Ingestion | Drive change + 6-hourly | Detect → extract → chunk → embed → store |
| 7 | Centralised Error Handling | n8n Error Trigger | Normalise → log → alert, with a direct-to-Slack last resort |

**Why n8n rather than code.** Workflows are the part operations staff need to
*see*. When the support lead asks "what happens when someone reports damage?",
a diagram of the actual running system is a better answer than a source file.
It also makes the failure branches visible and reviewable — the branches that
are otherwise the least-read code in the repository.

**What stays in the backend.** Business logic, grounding, scoring and
verification live in tested application code, not in workflow nodes. n8n
orchestrates and handles failure; it does not decide whether a lead is high
value. That keeps the logic unit-testable and stops workflow JSON from becoming
an untested programming language.

**Workflows are version-controlled JSON**, deployed like code, all reporting
into Workflow 7.

---

## 22. Zapier's role

**Cross-business automation for the sales stack — deliberately a different job
from n8n.**

**The one workflow:** a high-value lead fires a Zapier Catch Hook, which fans out
into create-or-update CRM contact → create deal → email the routed owner →
create a follow-up calendar event → append to the sales forecast sheet, with
routing by region.

**Why not n8n.** The boundary is not arbitrary:

| | n8n (ours) | Zapier (theirs) |
|---|---|---|
| On the customer's latency path | Yes | No — fires after the customer has their answer |
| Needs private network / DB access | Yes | No — receives a self-contained payload |
| Changes when… | The product changes | The sales team's tooling changes |
| Changed by | Engineering, via git | Sales ops, in the Zapier UI |
| If it breaks | Customers affected | A lead reaches the CRM late |

**The decisive test:** the sales manager decides leads should also create an
Asana task. In Zapier that is a two-minute change *they* make. In n8n it is a
pull request, a review and a deployment. Sales tooling changes quarterly;
engineering should not be in that loop, and Zapier's 8,000 pre-built OAuth
integrations are exactly the maintenance we are buying our way out of.

Zapier is downstream of everything that matters — PostgreSQL, Airtable and Slack
are all done before it is attempted — so its outage or rate limit cannot lose a
lead or delay a customer.

Details: [`../zapier/README.md`](../zapier/README.md).

---

## 23. Vapi's role

**The voice AI receptionist.** Vapi owns telephony, transcription, the turn loop
and speech synthesis. It owns **no** business knowledge.

**Capabilities:** greet the caller; understand the request; answer product and
policy questions; look up an order; collect and create a lead; detect
complaints; escalate; send structured information to the backend.

**Eight tools:** `searchProduct`, `searchKnowledge`, `getOrderStatus`,
`findCustomer`, `createCustomer`, `createLead`, `createSupportTicket`,
`escalateToHuman` — each mapping to one backend endpoint.

**The anti-hallucination design.** The system prompt does not describe a single
product, price or policy. It states that the assistant has no knowledge of
UrbanCart's business, that every fact must come from a tool result in the current
call, and that a `NOT_FOUND` result means escalate rather than improvise. A model
with no facts in its prompt has far less to invent from.

**Voice-specific handling:** replies under 40 words; one question at a time;
amounts spoken exactly (Rs. 249,999 → "2 lakh 49 thousand 999 rupees", never
rounded to "2.5 lakh", because a rounded price is a wrong price); order numbers
spelled digit by digit; caller id used as the verification factor.

Details: [`../vapi/README.md`](../vapi/README.md).

---

## 24. RAG architecture

**The pipeline**

```
Google Drive → detect change (SHA-256) → download → extract text
→ clean → chunk → embed → Supabase pgvector
→ similarity search + metadata filter → confidence gate
→ LLM with grounding prompt → numeric-claim audit → grounded answer + sources
```

**Extraction.** PDF via a current pdf.js build (per-page, so repeated
headers/footers can be detected and dropped); DOCX via mammoth to HTML, keeping
heading levels; spreadsheets rendered as labelled `Column: value` pairs rather
than raw CSV — because an embedding of `SKU: UC-ELEC-001 | Product: iPhone 15`
retrieves far better against "how much is the iPhone 15" than a bare comma-
separated line does.

**Cleaning** rejoins words hyphenated across line breaks, removes page-number
lines and repeated boilerplate, normalises unicode punctuation, and unescapes
markdown artefacts. These are not cosmetic: they measurably change what
retrieves.

**Chunking is structure-aware.** Chunks are cut on heading boundaries first,
then packed to ~900 characters with 150 characters of sentence-aligned overlap.
A chunk never spans two policies. This is the single most important quality
decision in the pipeline: *"Can I return headphones after 10 days?"* must not
retrieve a passage that starts in the return policy and ends in the warranty
policy. Each chunk is prefixed with its heading trail so the topic words are
present in the embedded text.

**Embeddings.** OpenAI `text-embedding-3-small`, 1536 dimensions.

**Metadata filtering** restricts a question to the document types that could
answer it. This is not just an optimisation — it stops a superficially similar
sentence in the return policy being retrieved and presented as warranty terms.
When a filtered search returns nothing or only weak matches, the system widens
once and keeps whichever result is genuinely better, so an imperfect topic guess
costs latency rather than the customer's answer.

**Grounding confidence** combines the best chunk's similarity, whether the top
chunks corroborate each other, and how many of the question's content words
actually appear in the retrieved text. That last term is what catches "the
vector store returned its five nearest neighbours, but none of them mention
warranties".

**The prompt** states the rules as prohibitions with a defined escape hatch:
retrieved knowledge is the only source; never state a price, delivery time,
return window or warranty term that is not in the supplied material; if it is
insufficient, reply `ESCALATE:` and the system fetches a human. A model told only
"don't guess", with no alternative, still guesses.

**The numeric-claim audit** is the backstop. Any price, duration or percentage in
the generated answer must trace to a digit sequence in the supplied evidence.
An invented "Rs. 5,000 restocking fee" is caught and the turn escalates instead.
It is conservative by design — ordinary rephrasing does not trip it.

**Knowledge updates** are content-hashed and idempotent; re-ingesting an
unchanged corpus writes nothing and costs nothing.

---

## 25. Security

| Control | Implementation |
|---|---|
| **No secrets in source** | Everything from environment variables; `.env` is git-ignored; `.env.example` documents every key with no values |
| **Webhook authentication** | `X-API-Key` (constant-time compare) on internal endpoints; HMAC-SHA256 over the raw body for n8n/Zapier; `X-Vapi-Secret` for Vapi |
| **Input validation** | Zod schemas on every endpoint; unknown keys rejected, not passed through |
| **SQL injection** | Every statement parameterised. No SQL is ever concatenated with user input |
| **Supabase RLS** | Enabled on all knowledge tables; service-role only; the browser-facing anon key gets nothing |
| **Least privilege** | Read-only Drive scope; Airtable token scoped to one base; Slack bot limited to `chat:write` |
| **Customer data protection** | Order lookups require ownership verification; street addresses redacted; Notion holds no customer data |
| **Safe logging** | Structured JSON with automatic redaction — credentials removed entirely, phone and email partially masked, business data left readable |
| **Safe errors** | Every error carries an internal message *and* a customer-safe message; only the safe one is ever serialised |
| **Rate limiting** | Per-client fixed window on public endpoints |
| **Transport** | HTTPS everywhere; HSTS and strict security headers |

**Boot-time enforcement.** Production refuses to start without an internal API
key and a webhook signing secret, and refuses to run on the embedded database or
demo-grade embeddings. Misconfiguration is a startup failure, not something a
customer discovers.

**What we deliberately do not do:** never ask for card numbers, CVV or OTP on any
channel; never store payment credentials; never read a full address aloud.

---

## 26. Error handling

**Principle: the customer gets a safe answer; engineering gets the detail.**
Every error carries both messages, and only the safe one crosses the HTTP
boundary.

| Failure | Customer sees | System does |
|---|---|---|
| Missing customer | Normal conversation | Creates one when enough detail exists |
| Missing order | "I couldn't find that order… passing to support" | Logs the attempt |
| Invalid order number | "That doesn't look like ours — they look like UC-10452" | No database query |
| Unverified caller | "Could you confirm the phone number on the order?" | Reveals nothing at all |
| Missing product | "I couldn't find that — shall I have someone help?" | Logs the miss |
| No RAG results | Polite escalation | Ticket created; the gap is tracked |
| API timeout | Safe fallback | Retry with backoff, then alert |
| Vapi failure | Speakable fallback, then handover | Alert |
| n8n failure | Safe fallback | Workflow 7: log + alert |
| Supabase failure | "I need to check with a colleague" | Alert; other intents keep working |
| PostgreSQL failure | Safe fallback | Alert; this is a genuine outage |
| Airtable failure | *Nothing — unaffected* | Outbox retries |
| Slack failure | *Nothing — unaffected* | Outbox retries |
| Invalid input | Friendly rephrase request | No alert (not a system fault) |
| Duplicate lead | "I already have your enquiry on file" | Reuses the lead; no second alert |
| Document processing failure | *Nothing — unaffected* | ⚠️ alert naming the document |

**Layered defence.** Input validation → per-operation try/catch with a domain
error → central HTTP error handler → n8n's own error branch → Workflow 7 → a
direct-to-Slack path for when the backend itself is down and cannot report on
itself.

**Everything is traceable.** One correlation id flows from the HTTP request
through every log line, `workflow_executions` row and outbound integration call.

---

## 27. Scalability

**Current shape** handles UrbanCart's stated volume comfortably on one small
node.

| Dimension | Approach | Headroom |
|---|---|---|
| Chat volume | Stateless API; scale horizontally | 10× on 2 instances |
| Database | Managed Postgres, pooled | 10× before a read replica is needed |
| Vector search | HNSW ANN | ~10⁵ chunks (≈500 documents) on one node |
| Embedding cost | Content-hashed ingestion | Unchanged documents cost nothing |
| Voice | Vapi is elastic | Concurrency limited by phone lines, not by us |
| Integrations | Outbox queue | Absorbs third-party rate limits |

**What we would change at 10×:** move rate limiting to Redis (in-process is a
single-node design, and is documented as such); add a Postgres read replica for
the admin views; move the outbox dispatcher to a worker process; cache hot
product lookups.

**What would need rethinking at 100×:** a dedicated vector database if the
corpus passes ~10⁶ chunks; sharding conversations by date; a proper message
queue in place of the outbox table.

We have deliberately **not** built for 100× now. The client said *"We don't
necessarily need to automate everything on day one. We want something reliable
that we can expand later."* Building a distributed system for a business that
needs a reliable one would be the wrong trade.

---

## 28. Cost considerations

Estimated monthly run cost at launch volume (~3,000 chat conversations, ~500
voice minutes).

| Item | Plan | Monthly (USD) |
|---|---|---|
| Backend hosting | 1 small instance | $10–20 |
| PostgreSQL | Managed, 1 GB | $15–25 |
| Supabase | Pro (or free at this size) | $0–25 |
| n8n | Self-hosted on the same box | $0 |
| Vapi platform | ~$0.05/min × 500 | ~$25 |
| Phone number | 1 local number | ~$2 |
| LLM (answers) | ~3,000 grounded answers | $20–60 |
| Embeddings | ~500 documents, re-embedded on change only | < $1 |
| Airtable | Team, 3 seats | ~$60 |
| Slack / Notion / Drive | Existing plans | $0 |
| Zapier | Starter | ~$20 |
| **Total** | | **≈ $155–240** |

**Where the cost control actually comes from** — these are architectural, not
plan choices:

- **Intent classification is rule-based.** It is the highest-volume operation in
  the system and costs nothing per message.
- **Price, stock and order status never call a model.** In a support workload
  these are the most common questions.
- **RAG runs only for policy and descriptive questions**, roughly 30–40% of
  traffic.
- **Ingestion is content-hashed**, so the six-hourly safety net re-embeds
  nothing.
- **Retrieval is capped** at 5 chunks, keeping prompts small.

**The main lever if cost matters more than quality later:** the answer model is
one environment variable. A smaller model would reduce the LLM line materially;
we default to the most capable model because a wrong policy answer is more
expensive than the tokens, and that is the client's decision to revisit with
real traffic data.

---

## 29. Implementation plan (6–8 weeks)

Each phase ends with something UrbanCart can actually use.

### Phase 1 — Foundation (weeks 1–2)
- PostgreSQL schema, constraints, indexes; seed and demo data
- Supabase project, vector schema, RLS
- Backend skeleton: config, logging, error taxonomy, health
- Product, customer and order services with verification
- **Deliverable:** order and product lookups working against real data
- **Milestone:** *"Where is UC-10452?"* answers correctly and safely

### Phase 2 — Knowledge and conversation (weeks 3–4)
- Google Drive folder structure; documents supplied by the client
- Ingestion pipeline: extract → clean → chunk → embed → store
- Retrieval with metadata filtering, the confidence gate and the claim audit
- Chat API, intent classification, the grounding prompt
- Web chat interface
- **Deliverable:** 24/7 chat answering product and policy questions, grounded
- **Milestone:** *"Can I return headphones after 10 days?"* answers **correctly**
  and cites the return policy

### Phase 3 — Automation and operations (weeks 5–6)
- Lead capture, scoring, de-duplication
- Complaint detection, escalation, tickets and tasks
- Slack notifications with the four-event policy
- Airtable base and the operational mirror
- n8n workflows 1, 3, 4, 5, 6, 7
- Zapier high-value-lead Zap
- **Deliverable:** leads reach sales, complaints reach support, ops has a view
- **Milestone:** a high-value lead appears in Slack and the CRM within seconds

### Phase 4 — Voice and hardening (weeks 7–8)
- Vapi assistant, tools, phone number
- n8n workflow 2; voice-specific formatting
- Notion handbook published
- Full test suite; load test; security review
- Team training and handover
- **Deliverable:** the complete system, chat and voice
- **Milestone:** a phone call captures a lead and escalates a complaint correctly

### If time runs short
Voice moves to week 9–10. Chat delivers most of the value and is the higher
volume channel; voice is the higher-risk integration. We would not compress
Phase 2, because the grounding work is what makes the whole thing trustworthy.

### Dependencies on UrbanCart
| Needed | When | Blocking |
|---|---|---|
| Policy documents (PDF/DOCX/XLSX) | Week 2 | Phase 2 |
| Product catalogue export | Week 1 | Phase 1 |
| Order data or an API to it | Week 1 | Phase 1 |
| Slack workspace access | Week 5 | Phase 3 |
| Decision on the CRM | Week 5 | Zapier |
| A phone number | Week 7 | Phase 4 |

---

## 30. Future improvements

**Near term (3–6 months)**
- Urdu and Roman-Urdu conversation — a real share of UrbanCart's customers
- Instagram DM as a first-class channel
- Proactive delivery-delay notifications, before the customer asks
- A weekly digest of unanswered questions, to prioritise which document to write
  next
- Agent-assist: draft replies for human agents in the same grounded way

**Medium term (6–12 months)**
- Order placement through chat, with human confirmation for high-value orders
- Personalised recommendations from purchase history
- Automated return-label generation for straightforward cases
- Sales dashboards on lead conversion by source, product and region
- A/B testing of assistant phrasing against conversion

**Longer term**
- Predicting which orders will be delayed, before the courier reports it
- Voice in Urdu, which is a materially harder speech problem than text
- Supplier-facing automation for stock replenishment
- A customer self-service portal built on the same grounded knowledge base

**Continuous**
- Every escalation is a labelled example of a gap. The monthly cycle is: review
  low-confidence escalations → write or amend the document → re-ingest → measure
  the escalation rate. The system should need fewer humans over time because the
  documents get better, never because the confidence gate was loosened.

---

## Appendix — technology summary

| Technology | Role | Why it, specifically |
|---|---|---|
| **Vapi** | Voice AI receptionist | Handles telephony, STT, turn loop and TTS as one product; a tool-calling model we can constrain to our backend |
| **n8n** | Primary orchestration | Self-hostable (private data stays private), version-controlled workflows, and a visual failure path operations staff can read |
| **Zapier** | Cross-business automation | 8,000 pre-built OAuth integrations the sales team can rewire themselves, off the critical path |
| **Google Drive** | Source documents | Where the client's documents already are; the folder becomes the publishing workflow |
| **Airtable** | Operational interface | Grid, filter and mobile UX for non-technical staff that would otherwise be weeks of internal-tool work |
| **Notion** | Internal documentation | Already in use; docs published from git so they cannot drift |
| **Slack** | Selective notification | Already in use; Block Kit gives actionable, scannable alerts |
| **PostgreSQL** | System of record | Constraints and transactions are what make the business data trustworthy |
| **Supabase** | Vector store + RAG | Managed pgvector with RLS, isolated from the OLTP workload |
| **RAG** | Grounded knowledge | The only approach that lets policy answers change with the documents rather than with a deployment |
