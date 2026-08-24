# Module 07 — AI Customer Support Resolution Agent

**Category:** Autonomous Agent
**Hint:** give the agent tools — Search Customer, Search Tickets, Create Ticket, Update Ticket, Send Email

---

## Scenario

Build an **autonomous support agent** that doesn't simply answer questions — it decides what action needs to happen.

This is the step up from Module 03. That bot answered from a knowledge base and collected a ticket when it was stuck. This agent looks up real data, chooses between five different actions, and knows when to get out of the way and fetch a human.

---

## The worked example

**User submits:**

> *"I was charged twice for my subscription."*

**Agent should determine:**

```
Intent:   Billing Issue
Severity: High
```

**Then decide what to do** → create a finance ticket.

---

## Possible actions

| Intent | Action |
|--------|--------|
| **Password problem** | → Send password reset instructions |
| **Billing question** | → Search customer/order data |
| **Duplicate payment** | → Create finance ticket |
| **Technical issue** | → Create technical support ticket |
| **Angry/urgent customer** | → Escalate to human |

Implemented in [`code/intent-severity-router.js`](code/intent-severity-router.js), with the agent's own reasoning instructions in [`prompts/agent-system-prompt.md`](prompts/agent-system-prompt.md).

---

## Tables

### Customer Table — [`schema/customers-table.csv`](schema/customers-table.csv)

| Column | Type |
|--------|------|
| Customer ID | Text |
| Name | Text |
| Email | Email |
| Plan | Dropdown — Starter / Professional / Business |
| Subscription Status | Dropdown — Active / Past Due / Cancelled / Trial |

### Ticket Table — [`schema/tickets-table.csv`](schema/tickets-table.csv)

| Column | Type |
|--------|------|
| Ticket ID | Text |
| Customer | Text |
| Issue | Long text |
| Category | Dropdown — Account / Billing / Technical / General |
| Priority | Dropdown — Critical / High / Medium / Low |
| Action | Text — what the agent did |
| Status | Dropdown — Open / In Progress / Resolved / Closed |

The `Action` column is what makes this an agent rather than a form. It records the decision, so a support lead reviewing the table can see not just what the customer said but what the system chose to do about it.

---

## The agent's tools

Give the agent these five. Each is a Zapier action on the AI Agent, or a step in the Zap if you are building it without the Agent tier.

| Tool | Zapier action | Purpose |
|------|---------------|---------|
| **Search Customer** | Zapier Tables → *Find Record* (Customers) | plan, status, name — before answering anything about the account |
| **Search Tickets** | Zapier Tables → *Find Records* (Tickets) | duplicate check, always before creating |
| **Create Ticket** | Zapier Tables → *Create Record* (Tickets) | |
| **Update Ticket** | Zapier Tables → *Update Record* (Tickets) | append to an existing ticket |
| **Send Email** | Email by Zapier / Gmail | reset instructions, confirmations |

---

## Autonomous requirement

The agent decides:

> **What is the customer's intent?**
> **What data do I need?**
> **Which tool should I use?**
> **Should I answer or escalate?**

The system prompt makes these four questions the agent's explicit loop, in order. Step 2 — *what data do I need* — is the one that separates an agent from a classifier: answering a billing question without reading the customer record is guessing, and the prompt forbids it.

---

## The Zap

**Zap name:** `Support Agent — Resolve or Escalate`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Request received** | Webhooks → *Catch Hook* / Chatbots / Interfaces form | `message`, `customerEmail`, `customerName` |
| 2 | **Classify & Route** | Code by Zapier | [`code/intent-severity-router.js`](code/intent-severity-router.js) |
| 3 | **Search Customer** | Zapier Tables → *Find Record* (Customers) | `Email` equals step 1 email |
| 4 | **Search Tickets** | Zapier Tables → *Find Records* (Tickets) | `Customer` equals step 3 name · `Status` is any of Open, In Progress |
| 5 | **Find Last Ticket** | Zapier Tables → *Find Record* (Tickets) | sort desc, limit 1 — for ID generation |
| 6 | **Duplicate Check** | Code by Zapier | [`code/duplicate-ticket-check.js`](code/duplicate-ticket-check.js) |
| 7 | **Act** | Paths by Zapier | four paths, below |

### Path A — Self-resolve (password problem)

**Condition:** step 2 `canSelfResolve` **is true** AND step 2 `intent` exactly matches `Password Problem`

Send Email → password reset instructions. **No ticket created.**

### Path B — Create new ticket

**Condition:** step 2 `needsTicket` is true AND step 6 `shouldCreate` **is true**

1. Zapier Tables → *Create Record* (Tickets)

| Column | Maps from |
|--------|-----------|
| Ticket ID | step 6 → `newTicketId` |
| Customer | step 3 → Name |
| Issue | step 1 → message |
| Category | step 2 → `category` |
| Priority | step 2 → `severity` |
| Action | step 2 → `action` |
| Status | static: `Open` |

2. Send Email → `{{step6.customerMessage}}`

### Path C — Update existing ticket (duplicate avoided)

**Condition:** step 6 `shouldUpdate` **is true**

1. Zapier Tables → *Update Record* — record `{{step6.existingTicketId}}`, append `{{step6.appendedNote}}` to Issue
2. Send Email → `{{step6.customerMessage}}` ("You already have an open ticket for this…")

### Path D — Escalate to human

**Condition:** step 2 `needsHuman` **is true**

Slack → `#support-escalations`, or email the support lead:

```
🚨 ESCALATION — {{step2.severity}}

Customer: {{step3.Name}} ({{step1.customerEmail}})
Plan:     {{step3.Plan}}
Intent:   {{step2.intent}}
Trace:    {{step2.decisionTrace}}

Message:
{{step1.message}}

A person needs to take this — the agent did not attempt to resolve it.
```

Path D runs *alongside* Path B for an angry customer: the ticket is still created, and a human is still fetched.

---

## Extra challenge — no duplicate tickets

> *The agent should check whether a ticket already exists before creating a duplicate.*

Implemented in [`code/duplicate-ticket-check.js`](code/duplicate-ticket-check.js). The rule: an **open** ticket in the **same category** for the **same customer** means update, not create.

| Situation | Result |
|-----------|--------|
| Open Billing ticket, new billing message | **Update** TKT-0238 |
| Open Billing ticket, new *technical* message | **Create** a new ticket |
| **Resolved** Billing ticket, new billing message | **Create** — the old one is closed |
| No tickets at all | **Create** |

Matching on category rather than text similarity is deliberate: it is predictable, and it is explainable to a support lead in one sentence. The file documents how to add an AI similarity check on top if you want finer matching — with the code step still acting as the gate, so the model advises and the code decides.

---

## Testing checklist

| Message | Intent | Severity | Action | Ticket? |
|---------|--------|----------|--------|---------|
| "I was charged twice for my subscription" | Duplicate Payment | High | Create finance ticket | ✅ new |
| *(same customer, again, ticket still open)* | Duplicate Payment | High | Update existing | ❌ updated |
| "I forgot my password" | Password Problem | Medium | Send reset instructions | ❌ none |
| "What plan am I on?" | Billing Question | Medium | Search customer data | ❌ none |
| "My workflows keep failing" | Technical Issue | Medium | Create technical ticket | ✅ |
| "The system is completely down" | Technical Issue | **Critical** | Create ticket + escalate | ✅ + human |
| "This is the third time and NOBODY has fixed it" | **Angry Customer** | **Critical** | Escalate to human | ✅ + human |
| "This billing error is unacceptable" | **Angry Customer** | Critical | Escalate — anger beats topic | ✅ + human |

Row 8 is the interesting one. The message contains a billing signal *and* an anger signal. The router checks anger first, so it escalates rather than quietly filing a finance ticket — and if an AI step proposed `Billing Question`, the code overrides it and records that it did in `matchedOn`.

---

## Files

```
07-autonomous-support-agent/
├── README.md
├── prompts/
│   └── agent-system-prompt.md      ← the agent's reasoning loop + tool rules
├── code/
│   ├── intent-severity-router.js   ← step 2
│   └── duplicate-ticket-check.js   ← step 6
└── schema/
    ├── customers-table.csv
    ├── tickets-table.csv
    └── tables.json
```
