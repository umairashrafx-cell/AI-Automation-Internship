# Module 09 — AI Operations Manager

**Category:** Autonomous Agent — *"This can be your final/master task."*

**Hint architecture:**
`Schedule → AI Agent → Sales Tool + Task Tool + Support Tool → Reasoning → Action Tool → Report → Human`

---

## Scenario

A company wants an AI operations manager that checks business activity every morning and decides what requires attention.

---

## Data sources

Give the agent access to three tables — [`schema/tables.json`](schema/tables.json) has exact types.

### Sales Table — [`schema/sales.csv`](schema/sales.csv)

| Column | Type |
|--------|------|
| Customer | Text |
| Deal | Text |
| Amount | Number |
| Stage | Dropdown |
| Owner | Text |
| Last Activity | Date/Time *(added — the stale-deal check needs it)* |

### Tasks Table — [`schema/tasks.csv`](schema/tasks.csv)

| Column | Type |
|--------|------|
| Task | Text |
| Owner | Text |
| Deadline | Date |
| Status | Dropdown |

### Support Table — [`schema/support.csv`](schema/support.csv)

| Column | Type |
|--------|------|
| Customer | Text |
| Issue | Long text |
| Priority | Dropdown |
| Status | Dropdown |
| Created At | Date/Time *(added — the SLA check needs it)* |

> Two columns are added to the task sheet's spec: `Last Activity` on Sales and `Created At` on Support. Without them "which deals are stuck" and "which critical tickets are unresolved" cannot be answered — there is nothing to measure elapsed time against.

---

## Agent's mission

Every morning, independently analyse the business. It should determine:

**Sales**
- Which deals are stuck?
- Which deals need follow-up?
- Which high-value deals need attention?

**Tasks**
- Which tasks are overdue?
- Who has too many pending tasks?

**Support**
- Which critical tickets are unresolved?
- Which customers need escalation?

---

## The Zap

**Zap name:** `AI Operations Manager — Daily Brief`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Schedule** | Schedule by Zapier → *Every Day* | 08:00 weekdays |
| 2 | **Sales Tool** | Zapier Tables → *Find Records* (Sales) | all open deals |
| 3 | **Task Tool** | Zapier Tables → *Find Records* (Tasks) | `Status` is not `Done` |
| 4 | **Support Tool** | Zapier Tables → *Find Records* (Support) | `Status` is not `Resolved` |
| 5 | **Analyze Business** | Code by Zapier | [`code/business-analysis.js`](code/business-analysis.js) |
| 6 | **Anything to report?** | Filter by Zapier | step 5 `needsAttention` **is true** |
| 7 | **Reasoning** | AI by Zapier / OpenAI | [`prompts/ops-agent.md`](prompts/ops-agent.md) · input: step 5 `analysisText` |
| 8 | **Safe Action Guard** | Code by Zapier | [`code/safe-action-guard.js`](code/safe-action-guard.js) |
| 9 | **Action Tool** | Filter → `createFollowUp` is true, then Tables → *Create Record* (Tasks) | the one auto-action |
| 10 | **Report** | Code by Zapier | [`code/report-formatter.js`](code/report-formatter.js) |
| 11 | **Human** | Email / Slack | send the Daily Operations Report |

**Step 5 does the arithmetic; step 7 does the judgement.** Models are good at deciding what matters and bad at "how many days is 2026-08-19 from today". An ops report built on miscounted days is worse than no report, so every number the agent quotes was computed in step 5.

Step 6 matters more than it looks: on a quiet morning the Zap stops there and sends nothing. A daily report that arrives saying "all clear" every day stops being read within a fortnight.

---

## Agent output

**Create:** a Daily Operations Report.

**Example from the task sheet:**

```
HIGH PRIORITY

1. $12,000 deal hasn't moved for 5 days.
2. Customer XYZ has a critical unresolved ticket.
3. Ahmad has 7 overdue tasks.

RECOMMENDED ACTIONS

- Follow up with XYZ.
- Escalate support ticket.
- Reassign 2 tasks.
```

---

## Autonomous requirement

> The agent should not simply summarise the tables.
>
> ```
> Analyze → Identify problems → Prioritise → Recommend actions → Take permitted actions
> ```

How each link is built:

| Link | Where | What makes it more than a summary |
|------|-------|-----------------------------------|
| **Analyze** | `business-analysis.js` | Computes elapsed time, thresholds, per-owner load |
| **Identify problems** | `business-analysis.js` | Flags stale deals, overdue tasks, overload, SLA breaches — **and cross-table compound risk** |
| **Prioritise** | `prompts/ops-agent.md` | Ranks by *cost of inaction*, not by size. 3–5 items, hard cap |
| **Recommend actions** | `prompts/ops-agent.md` | Every action names a person and a verb |
| **Take permitted actions** | `safe-action-guard.js` + step 9 | Creates a follow-up task when a deal is stale and none exists |

The piece that most separates this from a summary is **compound risk**. `business-analysis.js` intersects the three tables and surfaces customers who appear as a problem in more than one:

```
COMPOUND RISK — same customer, problems in two tables
  - Northwind: $18,000 deal idle 6 days AND Critical ticket open 3 days
```

Neither half would top the list alone. Together they are the most urgent thing on the board, and no per-table summary would ever show it.

> *"For example, if a follow-up is overdue, it can automatically create a follow-up task."* — implemented at step 9, guarded against creating a duplicate task for a customer that already has one.

---

## Safety rules

> The agent cannot:
> - Delete records
> - Send external messages without approval
> - Change financial information
>
> It can only perform predefined safe actions.

**Enforced in code, not in the prompt.** [`code/safe-action-guard.js`](code/safe-action-guard.js) checks every proposed action against an allowlist:

| | Action types |
|---|---|
| ✅ **Allowed** | `create_task`, `update_task_owner`, `flag_record`, `add_note` |
| ⛔ **Forbidden** | anything matching `delete`, `send_email`, `send_sms`, `post_`, `update_amount`, `refund`, `discount`, `invoice`, `close_deal` |
| ⛔ **Default** | **everything else** — an action not on the allowlist is blocked, not permitted by omission |

Blocked actions are not discarded. They are moved into the report's RECOMMENDED ACTIONS section for a human, with the reason attached — so the operator sees what the agent wanted to do and why it wasn't allowed to.

A prompt instruction is a request. This file is the mechanism. If you build only one of the two, build this one.

---

## Report format

Generated by [`code/report-formatter.js`](code/report-formatter.js) — produces a plain-text version for email/Slack and an HTML version for a richer email client.

```
DAILY OPERATIONS REPORT — 2026-08-24

HIGH PRIORITY
  1. Vertex Foods — $12,000 deal in Proposal, no activity for 5 days.
  2. Northwind — critical ticket unresolved 3 days AND $18,000 renewal idle.
  3. Ahmad has 7 overdue tasks, 3 blocking other people.

RECOMMENDED ACTIONS
  - Zainab to call Vertex Foods today.
  - Escalate TKT-0239 before contacting Northwind about the renewal.
  - Move 2 of Ahmad's blocking tasks to Hassan (1 open task).

ACTIONS TAKEN
  - Created follow-up task: "Follow up — Vertex Foods ($12,000)" → Zainab

BLOCKED
  - send_email | Northwind ⟶ External messages require human approval.

Pipeline: $312,000 open · 4 stale deals · 7 overdue tasks · 2 critical tickets
```

---

## Testing checklist

| Setup | Expected |
|-------|----------|
| Deal idle 6 days, $12,000 | Appears in HIGH PRIORITY with the amount and day count |
| Deal idle 6 days, $500 | Appears low or in "also worth knowing", not top 3 |
| Deal idle 2 days | Not flagged |
| Closed Won deal idle 30 days | Not flagged — closed stages excluded |
| Same customer: stale deal + critical ticket | Surfaces as **COMPOUND RISK**, ranked top |
| Owner with 7 open tasks | Flagged as overloaded, with the lightest-loaded owner named for reassignment |
| Task past deadline, status Done | Not flagged |
| Critical ticket open 3 days | Flagged and counted as SLA-breached |
| Agent proposes `send_email` | **Blocked**, moved to RECOMMENDED ACTIONS with reason |
| Agent proposes `delete_record` | **Blocked** |
| Agent proposes `notify_customer_gently` | **Blocked** — not on the allowlist, default deny |
| Stale deal with no existing follow-up task | Task auto-created |
| Stale deal that already has a follow-up task | **Skipped**, noted in the report |
| Quiet morning — nothing stale, overdue, or critical | Filter stops the Zap, **no email sent** |

---

## Files

```
09-ai-operations-manager/
├── README.md
├── prompts/
│   └── ops-agent.md              ← step 7
├── code/
│   ├── business-analysis.js      ← step 5
│   ├── safe-action-guard.js      ← step 8
│   └── report-formatter.js       ← step 10
└── schema/
    ├── sales.csv
    ├── tasks.csv
    ├── support.csv
    └── tables.json
```
