# n8n workflows

Seven workflows in `n8n/workflows/`, importable as-is.

## Importing

1. `npx n8n` → <http://localhost:5678>
2. **Workflows → Import from File** for each JSON file.
3. Set the n8n environment variables:

```bash
URBANCART_API_URL=http://localhost:3000
URBANCART_API_KEY=<INTERNAL_API_KEY from .env>
URBANCART_WEBHOOK_SIGNATURE=<HMAC signature, see docs/api.md>
GOOGLE_DRIVE_FOLDER_ID=<folder id>
VAPI_WEBHOOK_SECRET=<same as .env>
SLACK_CHANNEL_ALERTS=#urbancart-alerts
```

4. In **every** workflow: Settings → Error Workflow → *UrbanCart 7 – Centralised
   Error Handling*.
5. Activate.

## Regenerating

```bash
npm run n8n:generate
```

The JSON is built from `scripts/generate-n8n-workflows.ts`. n8n workflow JSON is
verbose and every workflow repeats the same auth headers, the same error branch
and the same safe-fallback response; generating them from shared helpers keeps
those *identical* across all seven, which is exactly the property you want in an
error-handling convention. The emitted `.json` files are the deliverable.

## The division of labour

**n8n orchestrates; the backend decides.** Workflows validate input, call the
backend, shape the response and handle failure. They do not contain business
logic — n8n does not decide whether a lead is high value or whether an answer is
grounded. That lives in tested application code.

This keeps the logic unit-testable and stops workflow JSON from becoming an
untested programming language. What n8n gives us in return is the thing
operations staff actually need to *see*: when the support lead asks "what
happens when someone reports damage?", a diagram of the running system is a
better answer than a source file — and it makes the failure branches visible,
which are otherwise the least-read code in the repository.

---

## 1 · Customer Chat Request

**Trigger** `POST /webhook/urbancart/chat` · **9 nodes**

```
Chat Webhook → Validate Input → Input Valid?
   ├─ yes → Backend: Process Chat Turn → Backend OK?
   │            ├─ yes → Respond: Answer
   │            └─ no  → Report Failure → Respond: Safe Fallback
   └─ no  → Respond: Validation Error
```

**Validate Input** rejects an empty or >4000-character message, defaults the
channel, and generates a session id if none was given — so malformed input never
reaches the database.

**Backend: Process Chat Turn** performs intent classification, customer lookup,
RAG retrieval, grounded generation and escalation.

**Failure behaviour:** the HTTP node uses `onError: continueRegularOutput`, so a
5xx flows into our own branch instead of aborting the execution and leaving the
webhook hanging until timeout. The customer always gets a reply — a safe
fallback if necessary — and the failure is reported to the backend, which alerts
engineering.

---

## 2 · Voice Request (Vapi)

**Trigger** `POST /webhook/urbancart/voice` · **11 nodes**

```
Vapi Webhook → Verify + Route → Authorised?
   ├─ no  → Respond: Unauthorised (401)
   └─ yes → Tool Call?
              ├─ no  → Respond: Acknowledged
              └─ yes → Backend: Execute Voice Tool → Tool OK?
                          ├─ yes → Respond: Tool Results
                          └─ no  → Report Failure → Respond: Voice Fallback
```

**Verify + Route** checks `x-vapi-secret` and separates the ~5% of messages that
need work (`tool-calls`) from the high-frequency ones (`status-update`,
`speech-update`, `transcript`) that are simply acknowledged so Vapi does not
retry them.

**Failure behaviour:** never returns a non-2xx to Vapi mid-call. On failure the
assistant receives a *speakable* fallback — "I'm sorry, I can't check that at
the moment. Let me pass you to a colleague" — because an HTTP error during a
live call becomes dead air.

---

## 3 · Lead Creation

**Trigger** `POST /webhook/urbancart/lead` · **10 nodes**

```
Lead Webhook → Validate Lead Fields → Lead Valid?
   ├─ no  → Respond: Missing Fields
   └─ yes → Backend: Create Lead → Lead Created?
               ├─ yes → Summarise Outcome → Respond: Lead Result
               └─ no  → Report Lead Failure → Respond: Lead Fallback
```

**Validate Lead Fields** normalises Pakistani phone numbers to E.164 and parses
budgets in any human form ("Rs. 200,000", "2 lakh", "200k"). This duplicates
backend logic on purpose: n8n gives a fast rejection without a round trip, and
the backend remains the authority.

**Backend: Create Lead** does find-or-create customer, duplicate check, scoring,
the PostgreSQL write, the Airtable mirror, the Slack notification *if high
value*, and the Zapier hand-off.

**Summarise Outcome** surfaces `leadReference`, `duplicate`, `leadScore`,
`highValue`, `salesNotified`, `airtableMirrored`, `zapierTriggered` — so the
caller can tell the customer something accurate.

**Failure behaviour:** the fallback still thanks the customer and promises
follow-up. The lead is either committed or reported; it is never silently lost.

---

## 4 · Order Lookup

**Trigger** `POST /webhook/urbancart/order-status` · **10 nodes**

```
Order Webhook → Extract + Validate Order Number → Valid?
   ├─ no  → Respond: Bad Order Number
   └─ yes → Backend: Get Order Status → Lookup OK?
               ├─ yes → Shape Order Response → Respond: Order Status
               └─ no  → Report Failure → Respond: Order Fallback
```

**Extract + Validate** pulls `UC-#####` out of free text — "UC-10452", "uc
10452", or a whole sentence — so the customer never has to format anything.

**Shape Order Response** returns order data **only** when the outcome is
`found`. The other outcomes (`not_found`, `verification_required`,
`invalid_format`) carry a safe message and nothing else, so the workflow cannot
leak what the backend deliberately withheld.

---

## 5 · Complaint and Escalation

**Trigger** `POST /webhook/urbancart/escalate` · **8 nodes**

```
Escalation Webhook → Detect Escalation Reason → Backend: Escalate To Human
   → Escalation OK?
       ├─ yes → Shape Escalation Response → Respond: Escalated
       └─ no  → Report Failure → Respond: Escalation Fallback
```

**Detect Escalation Reason** classifies the complaint — damaged, angry, refund,
wants-a-human — and extracts any order number, so the right team and priority
are chosen before the backend is called.

**Backend: Escalate To Human** creates the ticket *and* the task in one
transaction, mirrors to Airtable, and posts the high-priority Slack alert.

**Note there is no "valid?" branch.** An escalation is never rejected for bad
input. If the classifier cannot tell what kind of complaint it is, it defaults
to `missing_information` and a human still gets it.

---

## 6 · RAG Document Ingestion

**Triggers** Google Drive file-changed **and** a 6-hourly schedule · **9 nodes**

```
Drive: File Changed ─┐
Safety Net: Every 6h ─┴→ Backend: Run Ingestion → Ingestion OK?
                              ├─ yes → Summarise → Any Document Failed?
                              │            ├─ yes → Alert: Ingestion Failed
                              │            └─ no  → Log Success
                              └─ no  → Report Ingestion Failure
```

**Two triggers on purpose.** Drive change notifications can be missed. The
periodic full pass is cheap because ingestion is content-hashed: unchanged files
are skipped and cost no embedding calls, so the safety net costs almost nothing
and removes a whole class of "the policy changed but the AI didn't" bugs.

**Alert: Ingestion Failed** produces the "⚠️ Automation Failed" Slack message
naming the specific document — the client's own example of a notification worth
sending.

---

## 7 · Centralised Error Handling

**Trigger** n8n Error Trigger · **6 nodes**

```
Error Trigger → Normalise Error → Backend: Log + Alert → Backend Reachable?
                                      ├─ yes → Done
                                      └─ no  → Slack: Direct Alert
```

**Normalise Error** produces one consistent shape regardless of which workflow
failed, and classifies the message into a useful code —
`UPSTREAM_TIMEOUT`, `BACKEND_UNREACHABLE`, `AUTH_FAILED`, `RATE_LIMITED`,
`EMBEDDING_FAILED` — so the alert says something more useful than "it broke".

**Backend: Log + Alert** writes `workflow_executions` and posts the single
"⚠️ Automation Failed" message. Centralising it here means one format and no
duplicate pages.

**Slack: Direct Alert** is the last resort. If the backend is down it cannot
alert anyone about itself, so this path posts to Slack directly from n8n. Every
monitoring system needs one path that does not depend on the thing being
monitored.

---

## Routing: n8n or direct?

Both are supported.

| | Direct to backend | Via n8n |
|---|---|---|
| Latency | Lower | +50–150 ms |
| Retries | In the backend | n8n's, plus the backend's |
| Change without deploying | No | Yes |
| Visible to operations | No | Yes |

**Recommendation:** point the website chat widget and the Vapi tools **directly**
at the backend for latency, and route WhatsApp, scheduled ingestion and error
handling through **n8n**, where the flexibility matters and the latency does not.

The committed `vapi/assistant.json` points at the backend; the n8n route is a
one-line URL change.
