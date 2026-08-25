# Module 03 — AI Customer Support Bot (CloudFlow)

**Category:** Chatbot
**Hint architecture:** `Chatbot → AI → Intent detection → Filter/Path → Table → Notification`

---

## Scenario

Build an AI chatbot for a fictional software company called **CloudFlow**. The chatbot should answer customer questions and collect support requests when it cannot solve the problem.

---

## Chatbot responsibilities

The bot handles:

- Pricing questions
- Product features
- Account questions
- Basic troubleshooting
- Support requests

---

## Part 1 — Build the chatbot

Zapier → **Chatbots** → *Create Chatbot*.

| Setting | Value |
|---------|-------|
| Name | `CloudFlow Support` |
| Greeting | "Hi — I'm the CloudFlow support assistant. I can help with pricing, features, your account, and troubleshooting. What do you need?" |
| Directive / System instructions | paste from [`prompts/system-prompt.md`](prompts/system-prompt.md) |
| Knowledge | paste / upload [`knowledge-base.md`](knowledge-base.md) |
| Creativity | **Low** — this bot must not improvise |
| Data collection | Name, Email, Problem |

### Knowledge base contents

Full text in [`knowledge-base.md`](knowledge-base.md). Summary:

**Pricing**

| Plan | Price |
|------|-------|
| Starter | $19/month |
| Professional | $49/month |
| Business | $149/month |

**Support:** Monday–Friday, 9 AM–6 PM
**Refund:** customers can request a refund within 14 days
Plus features per plan and common troubleshooting solutions.

---

## Part 2 — The important chatbot rule

**The bot should NOT invent information.**

If it doesn't know the answer:

> *"I don't have enough information to answer that accurately. I can create a support request for you."*

This is enforced three ways, and you want all three — a prompt instruction alone is not reliable:

1. The system prompt states it explicitly and gives the exact wording.
2. **Creativity is set to Low** in the chatbot settings.
3. The knowledge base has an explicit **"Out of scope"** section naming the categories the bot must refuse (specific account balances, custom pricing, roadmap, competitor comparisons).

---

## Part 3 — Escalation

If the user says *"I want to talk to a human"*, collect:

- Name
- Email
- Problem

Then send the request to a Zapier automation.

The system prompt instructs the bot to ask for these **one at a time** rather than in a single wall of questions, and to confirm a problem it has already been told rather than asking twice.

---

## Part 4 — The Zap

```
Chatbot → Zapier → Table
```

**Zap name:** `CloudFlow Support — Create Ticket`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Support request received** | Zapier Chatbots → *New Data Collected* (or Webhooks → *Catch Hook*) | Fields: `name`, `email`, `problem` |
| 2 | **Find Last Ticket** | Zapier Tables → *Find Record* | Table `Support Tickets`, sort `Created At` desc, limit 1 |
| 3 | **Detect Priority** | Code by Zapier | [`code/priority-detection.js`](code/priority-detection.js) · inputs: `problem`, `customerName`, `customerEmail` ← step 1; `lastTicketId` ← step 2 |
| 4 | **Create Ticket** | Zapier Tables → *Create Record* | mapping below |
| 5 | **Urgent?** | Paths by Zapier | two paths, below |

> **If your chatbot plan doesn't expose a native trigger:** give the bot a *Zapier action* / webhook tool instead, and point step 1 at **Webhooks by Zapier → Catch Hook**. The rest of the Zap is identical. The webhook body it should send is:
> ```json
> { "name": "Umair", "email": "umair@example.com", "problem": "Workflows stopped running after reconnecting Slack" }
> ```

### Step 4 field mapping

| Table column | Maps from |
|--------------|-----------|
| Ticket ID | step 3 → `ticketId` |
| Customer | step 1 → name |
| Email | step 1 → email |
| Issue | step 1 → problem |
| Priority | step 3 → `priority` |
| Status | step 3 → `status` (`Open`) |
| Created At | step 3 → `createdAt` |

### Step 5 — Paths

**Path A — Critical / High**
Condition: step 3 `isHighOrAbove` **(Boolean) is true**
Action: Slack → `#support-urgent`, or Email to the support lead.

```
🚨 {{step3.priority}} ticket — {{step3.ticketId}}

Customer: {{step1.name}} ({{step1.email}})
Issue:    {{step1.problem}}
Matched:  {{step3.matchedOn}}

Respond within SLA. Support hours: Mon–Fri, 9 AM–6 PM.
```

**Path B — Medium / Low**
Condition: step 3 `isHighOrAbove` **(Boolean) is false**
Action: Email the customer an acknowledgement.

```
Subject: We've received your request — {{step3.ticketId}}

Hi {{step1.name}},

Thanks for getting in touch. Your request is logged as
{{step3.ticketId}} and our team will reply during support hours
(Monday–Friday, 9 AM–6 PM).

Your message:
{{step1.problem}}
```

---

## Part 5 — The Table

**Create:** `Support Tickets` — import [`schema/support-tickets-table.csv`](schema/support-tickets-table.csv)

| Column | Type |
|--------|------|
| Ticket ID | Text |
| Customer | Text |
| Email | Email |
| Issue | Long text |
| Priority | Dropdown — Critical / High / Medium / Low |
| Status | Dropdown — Open / In Progress / Resolved / Closed |
| Created At | Date/Time |

---

## Priority detection

Implemented in [`code/priority-detection.js`](code/priority-detection.js).

| Signal | Priority |
|--------|----------|
| "System completely down" | **Critical** |
| "Can't access account" | **High** |
| Normal question | **Medium** |
| General request | **Low** |

Bands are checked **most-severe-first** and the first match wins, so *"I can't log in and the whole system is down"* classifies as **Critical**, not High. The code also outputs `matchedOn` so Zap History shows exactly which keyword drove the decision.

Beyond the two literal phrases in the task sheet, the keyword table covers the realistic variants — `locked out`, `charged twice`, `outage`, `data loss` — because a real customer never types the example sentence verbatim.

---

## Testing checklist

| User message | Expected priority | Bot behaviour |
|--------------|-------------------|---------------|
| "How much is Professional?" | — | Answers $49/month from knowledge base, no ticket |
| "What are your support hours?" | — | Answers Mon–Fri 9–6, no ticket |
| "Can I get a refund after 30 days?" | — | States the 14-day policy; does not invent an exception |
| "Do you have a plan for universities?" | Low | Fallback line → offers support request |
| "The system is completely down" | **Critical** | Ticket + urgent Slack alert |
| "I can't access my account" | **High** | Ticket + urgent alert |
| "I was charged twice for my subscription" | **High** | Ticket + urgent alert |
| "My workflow isn't working" | **Medium** | Ticket + acknowledgement email |
| "I'd like to know more about integrations" | **Low** | Ticket + acknowledgement email |
| "I want to talk to a human" | depends on issue | Collects name → email → problem, one at a time |

The third row is the one worth testing hardest. A bot that helpfully invents *"yes, we can make an exception"* has failed the module's central rule.

---

## Files

```
03-ai-support-bot/
├── README.md
├── knowledge-base.md              ← paste into Chatbot → Knowledge
├── prompts/
│   └── system-prompt.md           ← paste into Chatbot → Directive
├── code/
│   └── priority-detection.js      ← step 3
└── schema/
    ├── support-tickets-table.csv
    └── support-tickets-table.json
```
