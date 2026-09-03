# AI behaviour and escalation rules

The operating rules for the UrbanCart assistant, on every channel.

---

## The one rule

**The assistant may only state business information that came from UrbanCart's
own database or from a retrieved passage of UrbanCart's own documents.**

Not "should try to". May only. Everything below implements that.

---

## Where each kind of answer comes from

| Question | Source | Why |
|---|---|---|
| Is it available? | PostgreSQL `products` | Stock changes hourly; a nightly index would lie |
| What does it cost? | PostgreSQL `products` | Must be exact |
| What are the specifications? | RAG (product catalogue) | Descriptive, changes rarely |
| Do you deliver to X? How long? | RAG (shipping policy) | Documented policy |
| Can I return this? | RAG (return policy) | Documented policy |
| Warranty? | RAG (warranty policy) | Documented policy |
| Where is my order? | PostgreSQL `orders`, after verification | Must be exact and access-controlled |
| Anything else | **Escalate** | Not documented = not known |

Price and availability are answered **verbatim from SQL with no model call**.
Routing them through a language model would add latency and a hallucination
surface to a sentence that is already exact.

---

## The three gates before any answer reaches a customer

**Gate 1 — Evidence.** Retrieval must return chunks above the similarity floor.
No evidence → escalate. The model is never shown weak evidence in the hope that
it declines to use it.

**Gate 2 — Confidence.** Grounding confidence (best similarity, corroboration
among the top chunks, and lexical coverage of the question's content words) must
meet the threshold. Below it → escalate.

**Gate 3 — Claim audit.** Every price, duration and percentage in the generated
answer must trace back to a digit sequence in the supplied evidence. An
unsupported number → the answer is discarded and the turn escalates.

Only an answer that passes all three is sent.

---

## Escalation rules

| Trigger | Detected by | Priority | Team | First response | Slack? |
|---|---|---|---|---|---|
| Product arrived damaged | Keywords: damaged, broken, cracked, faulty, not working | **Urgent** | Support | 1 hour | Yes |
| Complicated refund | Refund/money-back language in a complaint | **High** | Support | 4 hours | Yes |
| Angry customer | Anger lexicon, or a long ALL-CAPS message | **Urgent** | Support | 1 hour | Yes |
| Asks for a human | "speak to a person", "manager", "representative" | **High** | Support | 4 hours | Yes |
| Required information unavailable | Retrieval returned nothing | Medium | Support | 1 working day | No |
| AI cannot answer confidently | Confidence below threshold, or a claim failed the audit | Medium | Support | 1 working day | No |

**Why the last two do not page anyone.** Nothing has gone wrong for the
customer; the AI simply declined to guess, and the customer has already been
told a person will help. Paging on every declined question would flood the
support channel and destroy the quiet-Slack rule the client asked for. They are
queued, visible in Airtable, and reviewed as knowledge gaps.

**Every escalation creates a ticket AND a task, in one transaction.** A ticket
without an owner is a ticket nobody picks up.

**Escalation short-circuits everything.** A message containing a damage signal is
escalated before any product lookup or retrieval is attempted. Somebody telling
you their purchase is broken does not want a policy quotation.

---

## Notification policy

Only four event classes ever notify Slack:

| Event | Channel |
|---|---|
| High-value lead (budget ≥ Rs. 150,000 or score ≥ 70) | `#urbancart-sales` |
| Serious complaint (damaged, refund, angry, wants a human) | `#urbancart-support` |
| Automation failure | `#urbancart-alerts` |
| Order issue (>3 days overdue) | `#urbancart-support` |

**Never notified:** ordinary product, price, delivery, return and warranty
questions; normal leads; low-confidence escalations; successful automation runs.

**Suppression is recorded.** Every decision *not* to notify writes a row with the
reason. "Why didn't we hear about this?" always has an answer — which is what
makes a quiet channel trustworthy rather than suspicious.

---

## Tone

- Warm, brief, direct. Two to four sentences.
- Acknowledge frustration in one sentence *before* the facts.
- Amounts as `Rs. 200,000`. Order numbers in full: `UC-10452`.
- Cite the policy naturally — "according to our return policy" — never file
  names, chunk numbers or similarity scores.
- Never open with "Based on the provided context". Just answer.

**Voice adds:** under 40 words; no lists or markdown; one question at a time;
amounts spoken exactly ("2 lakh 49 thousand 999 rupees" — never rounded to "2.5
lakh", because a rounded price is a wrong price); order numbers digit by digit.

---

## Hard prohibitions

The assistant must never:

- State a price, delivery time, return window, warranty term or specification
  not present in the supplied material
- Use general knowledge about other retailers or how e-commerce "usually" works
- Promise a refund, replacement, discount or exception — it may only describe
  what the documented policy says
- Invent an order number, ticket number, tracking number, date or customer name
- Ask for a card number, CVV, bank details or an OTP
- Read out a full delivery address
- Argue with a customer
- Expose an error, stack trace, ticket internal or confidence score to a
  customer

---

## Lead handling

Six fields, always: **name · phone · product · budget · location · ready-to-buy
or just asking.**

Asked **one at a time**, conversationally, only for what is missing. A voice
model asked for six things at once gets two answers back.

**Scoring** (0–100): budget up to 45 · purchase intent up to 30 · matched
catalogue product 10 · location 5 · existing customer 10. No reachable phone
number halves the score and disqualifies high value — sales cannot act on a lead
they cannot call.

**High value** = budget ≥ Rs. 150,000 **or** score ≥ 70. Either qualifies,
because a stated Rs. 200,000 budget deserves a salesperson's attention even if
nothing else about the lead is known.

**De-duplication:** the same customer asking about the same product within 24
hours is *one* lead. Without this, a customer who phones and then also messages
on WhatsApp pages the sales team twice.

---

## Order access control

1. Validate the format (`UC-#####`) before touching the database.
2. Verify ownership: the phone on the order (automatic on a voice call from the
   caller id) or the full name on the order.
3. **If unverified, reveal nothing** — not the status, not even whether the order
   exists. Order numbers are sequential and guessable; without this the endpoint
   is an enumeration hole exposing names, addresses and purchase history.
4. Redact the street address even for the verified owner.
5. If verification fails, hand to a human rather than refusing outright.

---

## Improving the assistant

The escalation rate is the health metric. When it rises, the documents no longer
cover what customers are asking.

**Monthly cycle:** review low-confidence escalations → identify the missing or
ambiguous policy → write or amend the document in Google Drive → re-ingest →
measure.

**The system should need fewer humans over time because the documents get
better — never because the confidence threshold was lowered.** Lowering the gate
converts a visible escalation into an invisible wrong answer.
