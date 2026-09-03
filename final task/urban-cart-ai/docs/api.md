# API and webhook reference

Base URL: `http://localhost:3000` (development)

Every response carries an `X-Correlation-Id` header. Send your own to trace a
request across the backend, `workflow_executions` and every outbound call.

## Response envelope

Success:
```json
{ "success": true, "data": { } }
```

Failure — the **only** shape ever returned. It never contains an internal
message, a stack trace or SQL:
```json
{
  "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "I didn't quite catch that. Could you rephrase it for me?" },
  "correlationId": "uc_a1b2c3d4"
}
```

## Authentication

| Endpoints | Mechanism | Header |
|---|---|---|
| `/health`, `/api/chat` | None (rate limited) | — |
| `/api/tools/*`, `/api/admin/*`, `/api/knowledge/*` | Shared key, constant-time compare | `X-API-Key: <INTERNAL_API_KEY>` |
| `/api/voice/vapi` | Vapi shared secret | `X-Vapi-Secret: <VAPI_WEBHOOK_SECRET>` |
| `/api/webhooks/*` | HMAC-SHA256 over the raw body | `X-Signature: <hex>` |

In development, a missing `INTERNAL_API_KEY` logs a warning and allows the
request so the demo runs out of the box. **In production its absence is a
boot-time fatal error**, so this can never silently expose data.

---

## `GET /health`

Liveness and an honest component report. `status` is `ok`, `degraded` (running,
but on demo-grade components) or `unhealthy`.

```json
{
  "status": "degraded",
  "checks": {
    "database": { "ok": true, "latencyMs": 5, "driver": "pglite" },
    "vectorStore": { "kind": "pgvector" },
    "embeddings": { "provider": "local", "semantic": false, "dimensions": 1536 },
    "llm": { "provider": "extractive", "model": "claude-opus-5" },
    "ragThresholds": { "minSimilarity": 0.08, "confidenceThreshold": 0.22 }
  },
  "integrations": { "slack": false, "airtable": false, "…": false }
}
```

---

## `POST /api/chat`

The main customer entry point. Used by the web UI and by n8n Workflow 1.

**Request**
```json
{
  "message": "Can I return headphones after 10 days?",
  "sessionId": "web-abc123",
  "channel": "web_chat",
  "phone": "03001234567",
  "name": "Ahmed Raza"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | 1–4000 characters |
| `sessionId` | string | yes | Stable per conversation |
| `channel` | enum | no | `web_chat` (default) · `whatsapp` · `instagram` · `voice` · `email` |
| `phone` | string | no | Any Pakistani format; normalised to E.164 |
| `name` | string | no | |
| `metadata` | object | no | Stored on the conversation |

Unknown fields are **rejected** (400), not silently ignored.

**Response**
```json
{
  "success": true,
  "data": {
    "reply": "According to UrbanCart Return and Refund Policy: A return request for headphones or earbuds made after 7 days from delivery will not be accepted…",
    "intent": "policy_question",
    "conversationId": "0f2c…",
    "confidence": 0.47,
    "escalated": false,
    "requiresHuman": false,
    "sources": [
      {
        "documentId": "…", "filename": "urbancart-return-policy.pdf",
        "documentType": "return_policy",
        "section": "2 Shorter Return Window for Audio and Personal-Use Products",
        "version": 1, "similarity": 0.271
      }
    ],
    "actions": [
      { "type": "knowledge_search", "detail": "grounded: 5 chunk(s), confidence 0.47" }
    ],
    "correlationId": "uc_a1b2c3d4"
  }
}
```

`requiresHuman: true` means a ticket exists and a person must follow up.

---

## Tool endpoints

Each maps 1:1 to a Vapi tool and is callable by n8n. All require `X-API-Key`.

### `POST /api/tools/searchProduct`
```json
{ "query": "iPhone 15" }
```
→ `{ found, ambiguous, matchType, product, alternatives, sentence }`

`matchType` is `sku` · `exact_name` · `alias` · `fulltext`, so the caller can
tell a certain match from a fuzzy one. `found: false` is a valid answer — the
system does not invent a product.

### `POST /api/tools/searchKnowledge`
```json
{ "query": "Can I return headphones after 10 days?", "topK": 5, "documentTypes": ["return_policy"] }
```
→ `{ grounded, answer, refusalReason, confidence, sources, retrievalStatus, appliedFilters }`

When `grounded` is `false`, `answer` is empty and `refusalReason` is one of
`no_evidence` · `low_confidence` · `model_escalated` · `unsupported_claim`.
**The caller must escalate rather than substitute its own answer.**

### `POST /api/tools/getOrderStatus`
```json
{ "orderNumber": "UC-10452", "phone": "03001234567" }
```
→ `{ outcome, message, order, needsAttention, daysOverdue }`

`outcome` is `found` · `invalid_format` · `not_found` · `verification_required`.
**`order` is `null` for every outcome except `found`** — an unverified caller is
told nothing, not even whether the order exists, so the endpoint cannot be used
to enumerate order numbers. Even for the verified owner the street address is
shortened to the last two components.

### `POST /api/tools/findCustomer`
```json
{ "phone": "03001234567" }
```
→ `{ found, customer, history }` where `history` is order count, last order and
status, open tickets and lifetime value.

### `POST /api/tools/createCustomer`
```json
{ "name": "Ahmed Raza", "phone": "03001234567", "location": "Lahore" }
```
→ `{ customer, created }` — 201 when created, 200 when an existing record was
matched and updated. Idempotent on phone.

### `POST /api/tools/createLead`
```json
{
  "name": "Ahmed Raza", "phone": "03001234567", "product": "iPhone 15",
  "budget": "2 lakh", "location": "Lahore",
  "purchaseIntent": "ready_to_buy", "source": "voice"
}
```
`budget` accepts a number or a human string ("Rs. 200,000", "2 lakh", "200k").

→ `{ lead, customerId, customerCreated, duplicate, scoring, notifications }`

`scoring.reasons` explains the score line by line. `notifications` reports
exactly what happened for Slack, Airtable and Zapier, including whether each was
a dry run. Returns 200 with `duplicate: true` when it matched a recent lead.

### `POST /api/tools/createSupportTicket`
```json
{ "description": "Screen arrived cracked", "issueType": "damaged_product", "phone": "03001234567", "orderNumber": "UC-10453" }
```
→ 201 `{ ticket, task, customerMessage, notified, priority }`

### `POST /api/tools/escalateToHuman`
```json
{ "reason": "damaged_product", "description": "…", "phone": "03001234567" }
```
`reason`: `damaged_product` · `complex_refund` · `angry_customer` ·
`missing_information` · `low_confidence` · `customer_requested_human`

→ 201 with `customerMessage` — the polite handover text to show or speak.

---

## `POST /api/voice/vapi`

The Vapi server webhook. Requires `X-Vapi-Secret`.

Handles `tool-calls` (and the legacy `function-call`), `transcript`,
`status-update`, `end-of-call-report` and `assistant-request`.

**Request** (abridged)
```json
{
  "message": {
    "type": "tool-calls",
    "call": { "id": "call_abc", "customer": { "number": "+923001234567" } },
    "toolCalls": [
      { "id": "toolu_1", "type": "function",
        "function": { "name": "getOrderStatus", "arguments": { "orderNumber": "UC-10452" } } }
    ]
  }
}
```

**Response** — the shape Vapi expects:
```json
{ "results": [ { "toolCallId": "toolu_1", "result": "Order U C, one zero four five two is delayed…" } ] }
```

Results are **speakable**: no markdown, no lists, amounts as spoken words, order
numbers digit by digit.

An unrecognised payload returns `200 {"received": true}` rather than a 4xx —
Vapi extends its envelope over time and rejecting an unknown field would break
live calls.

---

## Knowledge endpoints

`GET /api/knowledge/documents` → active documents, chunk statistics, recent
ingestion history.

`POST /api/knowledge/search` → raw retrieval with similarity scores, applied
filters and timings. Useful for debugging why an answer was or was not grounded.

`POST /api/knowledge/ingest` → `{ "source": "local" | "google_drive", "force": false }`.
`force` re-embeds unchanged documents — needed after switching embedding
provider, because vectors from different models are not comparable.

---

## Admin endpoints

All require `X-API-Key`.

| Endpoint | Returns |
|---|---|
| `GET /api/admin/overview` | Orders by status, leads by status, open tickets by priority, workflow executions, integration deliveries, knowledge-base stats, conversations by channel |
| `GET /api/admin/leads` | Lead pipeline with customer details |
| `GET /api/admin/tickets` | Open tickets, priority-ordered |
| `GET /api/admin/tasks` | Task queue |
| `GET /api/admin/orders` | Recent orders |
| `GET /api/admin/customers` | Recent customers |
| `GET /api/admin/executions` | Recent workflow failures |
| `GET /api/admin/integrations` | Outbox delivery log |
| `GET /api/admin/readiness` | Which integrations are live, which are dry-run, and the resolved provider for each component |
| `GET /api/conversations/:id` | Full transcript with per-message confidence and sources |

---

## `POST /api/webhooks/workflow-error`

Workflow 7 reports n8n failures here. Requires an HMAC signature.

```json
{
  "workflow": "RAG Document Ingestion",
  "errorCode": "EMBEDDING_FAILED",
  "errorMessage": "OpenAI returned HTTP 429",
  "subject": "return-policy.pdf",
  "execution": { "id": "1234" }
}
```

Records a `workflow_executions` row and posts the single "⚠️ Automation Failed"
Slack alert. Centralising it here means one format and no duplicate pages.

**Signing:**
```bash
BODY='{"workflow":"test","errorCode":"X","errorMessage":"y"}'
SIG=$(node -e "console.log(require('crypto').createHmac('sha256',process.env.WEBHOOK_SIGNING_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")
curl -X POST http://localhost:3000/api/webhooks/workflow-error -H "Content-Type: application/json" -H "X-Signature: $SIG" -d "$BODY"
```

---

## n8n webhook paths

When routing through n8n rather than calling the backend directly:

| Path | Workflow |
|---|---|
| `POST /webhook/urbancart/chat` | 1 — Customer Chat Request |
| `POST /webhook/urbancart/voice` | 2 — Voice Request |
| `POST /webhook/urbancart/lead` | 3 — Lead Creation |
| `POST /webhook/urbancart/order-status` | 4 — Order Lookup |
| `POST /webhook/urbancart/escalate` | 5 — Complaint / Escalation |

---

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Input failed validation |
| `INVALID_ORDER_NUMBER` | 400 | Not in `UC-#####` format |
| `UNAUTHORIZED` | 401 | Missing or wrong key/signature |
| `VERIFICATION_REQUIRED` | 403 | Caller has not proven ownership |
| `NOT_FOUND` / `ORDER_NOT_FOUND` / `PRODUCT_NOT_FOUND` | 404 | No such record |
| `DUPLICATE_LEAD` | 409 | Matched a recent lead |
| `RATE_LIMITED` | 429 | Too many requests |
| `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT` | 502 / 504 | Third-party failure |
| `DATABASE_ERROR` / `VECTOR_STORE_ERROR` | 503 | Store unavailable |
| `KNOWLEDGE_UNAVAILABLE` / `LOW_CONFIDENCE` | 200 | Handled conversationally, not as an HTTP failure |
| `INTERNAL_ERROR` | 500 | Unexpected |

`KNOWLEDGE_UNAVAILABLE` and `LOW_CONFIDENCE` return **200** deliberately: the
system worked correctly by declining to answer. Returning 500 would make a
correct refusal look like an outage in every monitoring dashboard.
