# Vapi — Voice AI Receptionist

Vapi runs the telephony side of UrbanCart: it answers the phone, transcribes the
caller, runs the assistant turn loop, and speaks the reply. It does **not** hold
any business knowledge. Every fact it can say comes back from a tool call into
this project's backend.

That split is the whole design. The client said *"we don't want the AI making up
information"*, and a voice model is the hardest place to enforce that, because
there is no UI to show a source and no time for the caller to check. So the
assistant is given no product or policy knowledge in its prompt at all — only
instructions on which tool to call and an explicit instruction that if it has
not called a tool, it does not know the answer.

---

## Files

| File | What it is |
|---|---|
| `assistant.json` | The complete assistant: system prompt, model, voice, transcriber, all 8 tools, server config and the call-analysis plan. POST it to the Vapi API or paste it into the dashboard. |
| `test-payloads/` | Real Vapi webhook payloads for testing the backend without a phone call. |

---

## The 8 tools

Each maps to one backend endpoint. All are synchronous — the assistant waits for
the result before speaking, because speaking first and correcting later is worse
than a half-second pause.

| Tool | Endpoint | Purpose |
|---|---|---|
| `searchProduct` | `POST /api/tools/searchProduct` | Live price, stock and warranty from PostgreSQL |
| `searchKnowledge` | `POST /api/tools/searchKnowledge` | Grounded RAG answer over the policy documents |
| `getOrderStatus` | `POST /api/tools/getOrderStatus` | Order status, verified against the caller id |
| `findCustomer` | `POST /api/tools/findCustomer` | Recognise a returning customer |
| `createCustomer` | `POST /api/tools/createCustomer` | Create a customer record |
| `createLead` | `POST /api/tools/createLead` | Capture the six lead fields, score, notify sales |
| `createSupportTicket` | `POST /api/tools/createSupportTicket` | Log a non-urgent issue |
| `escalateToHuman` | `POST /api/tools/escalateToHuman` | Hand over, raise a high-priority ticket |

Tools can point either **directly at the backend** (simplest, lowest latency) or
**at the n8n webhook** `/webhook/urbancart/voice` (adds n8n's retry, logging and
the ability to change the flow without redeploying). Both are supported; the
committed `assistant.json` points at the backend and the n8n route is documented
in `docs/workflows.md`.

---

## Setup

### 1. Deploy the backend somewhere Vapi can reach

Vapi calls your server from the public internet, so `localhost` will not work.
For local development, tunnel it:

```bash
npx localtunnel --port 3000
```

Note the public URL it prints — that is `YOUR-BACKEND-DOMAIN` below.

### 2. Fill in the placeholders

`assistant.json` contains three placeholders that must be replaced:

| Placeholder | Replace with |
|---|---|
| `YOUR-BACKEND-DOMAIN` | Your public backend host (11 occurrences) |
| `YOUR_INTERNAL_API_KEY` | The `INTERNAL_API_KEY` from your `.env` |
| `YOUR_VAPI_WEBHOOK_SECRET` | The `VAPI_WEBHOOK_SECRET` from your `.env` |

```bash
sed -i "s|YOUR-BACKEND-DOMAIN|your-tunnel.loca.lt|g;
        s|YOUR_INTERNAL_API_KEY|$INTERNAL_API_KEY|g;
        s|YOUR_VAPI_WEBHOOK_SECRET|$VAPI_WEBHOOK_SECRET|g" vapi/assistant.json
```

> Do not commit the filled-in file. `assistant.json` is committed with
> placeholders on purpose.

### 3. Create the assistant

```bash
curl -X POST https://api.vapi.ai/assistant -H "Authorization: Bearer $VAPI_API_KEY" -H "Content-Type: application/json" -d @vapi/assistant.json
```

Save the returned `id` as `VAPI_ASSISTANT_ID` in your `.env`.

### 4. Attach a phone number

Buy a number in the Vapi dashboard (or import a Twilio number), then attach the
assistant to it:

```bash
curl -X PATCH https://api.vapi.ai/phone-number/$VAPI_PHONE_NUMBER_ID -H "Authorization: Bearer $VAPI_API_KEY" -H "Content-Type: application/json" -d "{\"assistantId\":\"$VAPI_ASSISTANT_ID\"}"
```

### 5. Test without spending money on a call

The backend accepts real Vapi webhook payloads directly:

```bash
curl -X POST http://localhost:3000/api/voice/vapi -H "Content-Type: application/json" -H "X-Vapi-Secret: $VAPI_WEBHOOK_SECRET" -d @vapi/test-payloads/tool-call-order-status.json
```

`npm test` runs these same payloads as part of the voice test suite.

---

## Credentials required

Voice is the one part of the system that **cannot** run offline — it needs a
telephony provider and a hosted speech stack.

| What | Needed for | Cost |
|---|---|---|
| Vapi account + `VAPI_API_KEY` | Everything voice | ~$0.05/min platform fee |
| A phone number | Receiving calls | ~$2/month |
| Anthropic key | The assistant's own model | Per token |
| Deepgram / 11Labs | Bundled by Vapi by default | Included in the per-minute rate |

Without these, the voice **tool backend** is still fully testable (the payload
tests above run offline against the real code path); only the audio leg is
absent.

---

## Design notes

**Why `maxTokens: 300`.** A voice reply longer than about 40 words is unusable
on a call. The cap is a hard backstop behind the prompt instruction.

**Why `numWordsToInterruptAssistant: 2`.** Callers interrupt. Two words is
responsive without triggering on a cough or a "mm-hm".

**Why the six lead fields are collected one at a time.** A voice model asked to
"collect name, phone, product, budget, location and intent" will ask for all six
in one breath, and the caller will answer two. The prompt enumerates the order
and says *ask ONE question at a time, then stop and wait*.

**Why order numbers are read back digit by digit.** "UC-10452" spoken naturally
comes out as "U C ten thousand four hundred fifty two", which a caller cannot
match against their SMS. The backend's `speakOrderNumber()` renders it as
"U C, one zero four five two".

**Why `successEvaluationPrompt` asks about grounding.** Vapi scores every call
after it ends. Scoring on *"did it invent anything?"* rather than *"was the
caller happy?"* means the metric that gets watched is the one that matters here.
