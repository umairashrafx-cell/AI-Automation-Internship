# Module 05 — Customer Onboarding Pipeline

**Category:** Kanban + Form Automation
**Hint architecture:** `Form → Table → Kanban → Paths → Delay → Email`

---

## Scenario

Build a CRM-style onboarding system. A new customer submits an onboarding form. Their record should automatically appear in a Kanban board.

---

## Part 1 — The Form

Zapier Interfaces → new page → **Form** component.

**Page name:** `Customer Onboarding`

| Field | Type | Required |
|-------|------|----------|
| Client Name | Short text | ✅ |
| Company | Short text | ✅ |
| Email | Email | ✅ |
| Service | Dropdown | ✅ |
| Project Budget | Number | ✅ |
| Start Date | Date | ✅ |
| Account Manager | Dropdown | ❌ — auto-assigned if left blank |
| Requirements | Long text | ✅ |

**Service options:** `AI Automation`, `Web Development`, `Mobile App`, `AI Consulting`, `Consulting`

> Account Manager is on the form per the task sheet, but [`code/onboarding-setup.js`](code/onboarding-setup.js) assigns one automatically by service line. Keep the field so a salesperson can override; let the code fill it when they don't.

---

## Part 2 — Kanban stages

Interfaces → add a **Kanban** component bound to the `Customers` table, grouped by the `Stage` column.

```
New Lead → Qualified → Proposal → Won → Onboarding → In Progress → Completed
```

Create these as the options of the `Stage` dropdown column, **in this order** — the Kanban board renders columns in the dropdown's option order.

---

## Part 3 — The Table

**Create:** `Customers` — import [`schema/customers-table.csv`](schema/customers-table.csv)

| Column | Type | Notes |
|--------|------|-------|
| Customer ID | Text | `CUST-0112` |
| Client Name | Text | |
| Company | Text | |
| Email | Email | |
| Service | Dropdown | |
| Project Budget | Number | |
| Start Date | Date | |
| Requirements | Long text | |
| Account Manager | Text | auto-assigned |
| Account Manager Email | Email | |
| Tier | Dropdown | Enterprise / Mid-Market / Standard — derived from budget |
| **Stage** | Dropdown | the Kanban grouping column |
| Due Date | Date | first onboarding milestone |
| **Stage Changed At** | Date/Time | **required for the extra challenge** |
| Created At | Date/Time | |

---

## Part 4 — Zap 1: form submission

**Zap name:** `Onboarding — New Customer`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **New submission** | Zapier Interfaces → *New Form Submission* | `Customer Onboarding` |
| 2 | **Find Last Customer** | Zapier Tables → *Find Record* | sort `Created At` desc, limit 1 |
| 3 | **Prepare Record** | Code by Zapier | [`code/onboarding-setup.js`](code/onboarding-setup.js) |
| 4 | **Create customer record** | Zapier Tables → *Create Record* | `Stage` = step 3 `stage` (`New Lead`) · `Stage Changed At` = step 3 `createdAt` |
| 5 | **Send confirmation email** | Email by Zapier | template below |

Steps 4 covers three of the task sheet's six requirements at once — *create customer record*, *create Kanban card*, and *put card into New Lead*. In Zapier, the Kanban card **is** the table row: writing the record with `Stage = "New Lead"` makes the card appear in the first column. There is no separate "create card" action to build.

*Assign account manager* (step 3 → `accountManager`) and *add due date* (step 3 → `dueDate`) are likewise both computed in the code step and written by step 4.

### Step 5 — confirmation email

```
Subject: We've received your details — {{step3.company}}

Hi {{step3.clientName}},

Thanks for completing our onboarding form. Here's what we have:

Reference:   {{step3.customerId}}
Service:     {{step3.service}}
Budget:      {{step3.budgetFormatted}}
Start date:  {{step3.startDate}}

Your account manager is {{step3.accountManager}}, who will be in touch
within one working day.

First milestone: {{step3.dueDate}}
```

---

## Part 5 — Zap 2: stage automation

**Zap name:** `Onboarding — Stage Changed`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Card moved** | Zapier Tables → *Updated Record* | Table `Customers`, watch the `Stage` column |
| 2 | **Route Stage Change** | Code by Zapier | [`code/stage-router.js`](code/stage-router.js) |
| 3 | **Stamp the move** | Zapier Tables → *Update Record* | `Stage Changed At` ← `{{zap_meta_human_now}}` |
| 4 | **Anything to do?** | Filter by Zapier | continue only if step 2 `shouldAct` **is true** |
| 5 | **Create proposal task** | Paths / Filter → Tasks table or Trello/Asana | only when step 2 `createTask` is true |
| 6 | **Send** | Email by Zapier | To `{{step2.recipient}}`, Subject `{{step2.subject}}`, Body `{{step2.body}}` |

Step 3 runs **before** the Filter so every move is timestamped, including the ones with no notification attached. That timestamp is what the stale-card sweep reads.

### Stage automation implemented

| Transition | Action | Where |
|------------|--------|-------|
| **New Lead → Qualified** | Send *"Lead qualified."* | `stage-router.js` → `notify_internal` |
| **Qualified → Proposal** | Create proposal task | → `create_task`, due in 3 days |
| **Won → Onboarding** | Send onboarding email | → `email_customer` |
| **Onboarding → In Progress** | Notify project manager | → `notify_pm` |
| **In Progress → Completed** | Send completion email to customer | → `email_customer` |

The router keys off the stage the card moved **into**, not the pair — so a card dragged from `New Lead` straight to `Proposal` still creates the proposal task. Keying off exact pairs would silently skip actions whenever someone skips a column, which people do constantly.

---

## Part 6 — Extra challenge: stalled cards

> *If a card stays in **Qualified** for more than 3 days, automatically notify the account manager.*

**Zap 3:** `Onboarding — Stalled Deal Sweep`

| # | Step | App / Event |
|---|------|-------------|
| 1 | Schedule by Zapier → *Every Day* at 09:00 |
| 2 | Zapier Tables → *Find Records* — `Stage` equals `Qualified` |
| 3 | Code by Zapier — [`code/stale-card-check.js`](code/stale-card-check.js) |
| 4 | Filter — continue only if `isStale` is true |
| 5 | Email by Zapier → `{{accountManagerEmail}}` |

Step 3 returns an **array**, so Zapier fans out and runs steps 4–5 once per stale card. An empty array ends the run with nothing sent.

**Why a scheduled sweep instead of Delay by Zapier:** a `Delay For 3 days` step inside the Qualified branch is fewer moving parts, but it holds one Zap run open per card for three days, and editing the Zap drops everything queued. The daily sweep reads current state and survives edits. Both approaches are noted in the code file — the Delay version is the one the hint suggests, the sweep is the one that holds up.

---

## Testing checklist

| Action | Expected |
|--------|----------|
| Submit the form | Record created, card appears in **New Lead**, AM assigned, due date set, confirmation email sent |
| Submit with blank Account Manager | AM auto-assigned by service line |
| Drag card New Lead → Qualified | AM receives *"Lead qualified."* · `Stage Changed At` updated |
| Drag Qualified → Proposal | Proposal task created, due in 3 days |
| Drag New Lead → Proposal (skipping Qualified) | Proposal task still created |
| Drag Won → Onboarding | Customer receives welcome email |
| Drag Onboarding → In Progress | PM notified |
| Drag In Progress → Completed | Customer receives completion email |
| Leave a card in Qualified 4 days | Sweep emails the AM the next morning |
| Leave a card in Qualified 2 days | Sweep sends nothing |
| Drag a card back Proposal → Qualified | `Stage Changed At` resets — the 3-day clock restarts |

---

## Files

```
05-customer-onboarding-kanban/
├── README.md
├── code/
│   ├── onboarding-setup.js     ← Zap 1, step 3
│   ├── stage-router.js         ← Zap 2, step 2
│   └── stale-card-check.js     ← Zap 3, step 3
├── templates/
│   └── emails.md               ← all message templates in one place
└── schema/
    ├── customers-table.csv
    └── customers-table.json
```
