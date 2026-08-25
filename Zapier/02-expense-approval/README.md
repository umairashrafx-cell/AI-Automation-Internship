# Module 02 — Employee Expense Approval

**Category:** Interfaces / Tables
**Hint architecture:** `Interface Forms → Tables → Formatter → Filter → Paths → Email/Slack → Approval step`

---

## Scenario

Build an internal expense management system where employees submit expenses through a Zapier Interface. Managers should be able to see the submitted expenses in a Zapier Table, and the automation should determine whether the expense requires approval.

---

## Part 1 — The Interface

**Create:** `Employee Expense Portal`

### Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Employee Name | Short text | ✅ | |
| Employee Email | Email | ✅ | |
| Department | Dropdown | ✅ | Engineering, Sales, Marketing, Operations, Finance, HR |
| Expense Type | Dropdown | ✅ | see options below |
| Amount | Number | ✅ | |
| Expense Date | Date | ✅ | |
| Description | Long text | ✅ | |
| Receipt Upload | File | ❌ | **deliberately optional** — the missing-receipt rule depends on it |
| Manager Email | Email | ✅ | |

**Expense Type options**

- Travel
- Food
- Software
- Equipment
- Other

> **Build tip:** leave Receipt Upload *not required*. If you mark it required the form blocks submission and the "Receipt Required" status can never fire — which is the exact behaviour the task sheet asks you to demonstrate.

---

## Part 2 — The Zapier Table

**Create:** `Expense Requests`

Import [`schema/expense-requests-table.csv`](schema/expense-requests-table.csv), or create manually:

| Column | Type | Notes |
|--------|------|-------|
| Request ID | Text | `EXP-0045` |
| Employee | Text | |
| Department | Dropdown | |
| Type | Dropdown | Travel / Food / Software / Equipment / Other |
| Amount | Number | |
| Description | Long text | |
| Receipt | File / URL | empty when none uploaded |
| Manager | Email | |
| Approval Status | Dropdown | Approved, Pending Manager Approval, Pending Manager + Finance Approval, Receipt Required, Rejected |
| Risk Level | Dropdown | Low / Medium / High |
| Submitted At | Date/Time | |

Exact types: [`schema/expense-requests-table.json`](schema/expense-requests-table.json).

---

## Part 3 — The Zap

**Zap name:** `Expense Portal — Risk & Approval Routing`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **New Expense Submission** | Zapier Interfaces → *New Form Submission* | Form: `Employee Expense Portal` |
| 2 | **Find Last Request** | Zapier Tables → *Find Record* | Table `Expense Requests`, sort `Submitted At` desc, limit 1 |
| 3 | **Generate Request ID** | Code by Zapier | [`code/request-id-generator.js`](code/request-id-generator.js) · input: `lastRequestId` ← step 2 |
| 4 | **Assess Risk** | Code by Zapier | [`code/risk-assessment.js`](code/risk-assessment.js) · inputs: `amount`, `receiptUrl`, `expenseType`, `employeeName`, `managerEmail` ← step 1 |
| 5 | **Store Request** | Zapier Tables → *Create Record* | mapping below |
| 6 | **Route** | **Paths by Zapier** | four paths, below |

### Step 5 field mapping

| Table column | Maps from |
|--------------|-----------|
| Request ID | step 3 → `requestId` |
| Employee | step 1 → Employee Name |
| Department | step 1 → Department |
| Type | step 1 → Expense Type |
| Amount | step 1 → Amount |
| Description | step 1 → Description |
| Receipt | step 1 → Receipt Upload |
| Manager | step 1 → Manager Email |
| Approval Status | step 4 → `approvalStatus` |
| Risk Level | step 4 → `riskLevel` |
| Submitted At | step 3 → `submittedAt` |

The record is written **before** the Paths branch. Storing first means every submission is on record even if an email step later fails — the table is the source of truth, the notifications are a side effect.

---

## Part 4 — Paths configuration

Add **Paths by Zapier** as step 6. Because step 4 already made the decision, each path condition is a single boolean check — no arithmetic in the path rules.

### Path A — Auto-approved (Low risk, receipt present)

**Condition:** step 4 `autoApproved` **(Boolean) is true**

**Actions**

1. Email by Zapier → *Send Outbound Email* to `{{step1.Employee Email}}`

```
Subject: ✅ Expense {{step3.requestId}} approved automatically

Hi {{step1.Employee Name}},

Your expense has been approved automatically.

Request ID:  {{step3.requestId}}
Type:        {{step1.Expense Type}}
Amount:      {{step4.amountFormatted}}
Date:        {{step1.Expense Date}}
Risk Level:  Low

No manager action was needed — expenses under $100 with a valid
receipt are approved on submission.
```

---

### Path B — Manager approval (Medium risk)

**Condition:** step 4 `approvalStatus` **(Text) exactly matches** `Pending Manager Approval`

**Actions**

1. Email by Zapier → to `{{step1.Manager Email}}`

```
Subject: 🟡 Approval needed — {{step3.requestId}} · {{step4.amountFormatted}} · {{step1.Employee Name}}

{{step1.Employee Name}} ({{step1.Department}}) submitted an expense
that needs your approval.

Request ID:  {{step3.requestId}}
Type:        {{step1.Expense Type}}
Amount:      {{step4.amountFormatted}}
Date:        {{step1.Expense Date}}
Risk Level:  Medium
Receipt:     {{step1.Receipt Upload}}

Description:
{{step1.Description}}

Approve or reject in the Expense Requests table.
```

2. *(optional)* Slack → send to `#manager-approvals`

---

### Path C — Manager + Finance approval (High risk)

**Condition:** step 4 `notifyFinance` **(Boolean) is true**

**Actions**

1. Email by Zapier → to `{{step1.Manager Email}}` (same template as Path B, Risk Level: High)
2. Email by Zapier → to `finance@company.com`

```
Subject: 🔴 High-value expense for finance review — {{step3.requestId}} · {{step4.amountFormatted}}

A high-risk expense (> $500) has been submitted and requires both
manager and finance sign-off.

Request ID:  {{step3.requestId}}
Employee:    {{step1.Employee Name}} ({{step1.Department}})
Type:        {{step1.Expense Type}}
Amount:      {{step4.amountFormatted}}
Manager:     {{step1.Manager Email}}
Receipt:     {{step1.Receipt Upload}}

Trace: {{step4.decisionTrace}}
```

---

### Path D — Receipt required

**Condition:** step 4 `hasReceipt` **(Boolean) is false**

**Actions**

1. Email by Zapier → back to `{{step1.Employee Email}}`

```
Subject: 📎 Receipt required — {{step3.requestId}}

Hi {{step1.Employee Name}},

Your expense request has been logged but cannot move forward
without a receipt.

Request ID:  {{step3.requestId}}
Type:        {{step1.Expense Type}}
Amount:      {{step4.amountFormatted}}
Risk Level:  {{step4.riskLevel}}
Status:      Receipt Required

Please reply with the receipt attached, or resubmit through the
Employee Expense Portal.
```

> **Why Path D and not a Filter:** Paths in Zapier evaluate independently and *all* matching paths run. Because `risk-assessment.js` sets `autoApproved`, `notifyManager` and `notifyFinance` all to `false` when the receipt is missing, Paths A–C cannot fire alongside Path D. The mutual exclusivity lives in the code step, not in the path conditions — one place to reason about, one place to change.

---

## Part 5 — The approval step

The task sheet's hint lists an **Approval step**. Two ways to do it in Zapier:

**Option 1 — Interfaces approval page (recommended).**
Add a second page to the interface: `Manager Approvals`, containing a **Table** component bound to `Expense Requests` filtered to `Approval Status is not Approved`. Managers change the dropdown directly. Then build a small second Zap:

```
Trigger: Zapier Tables → Updated Record  (Expense Requests)
Filter:  Approval Status exactly matches "Approved"
Action:  Email employee "Your expense was approved"
```

**Option 2 — Approval links in the email.**
Add *Delay by Zapier → Delay After Queue* plus a Zapier Interfaces button, or embed two links that hit **Catch Hook** webhooks (`?id=EXP-0045&decision=approve`) which update the table record.

Option 1 is fewer moving parts and keeps the table as the single source of truth.

---

## Risk rules reference

| Amount | Risk | Action |
|--------|------|--------|
| < $100 | **Low** | Automatically mark **Approved** |
| $100 – $500 | **Medium** | Send approval request to manager |
| > $500 | **High** | Send approval request to manager **+ finance** |

**Override:** if the receipt is missing → `Approval Status = "Receipt Required"` and no approver is notified. Risk Level is still recorded.

---

## Expected workflow

Employee submits:

```
Software | $750 | No receipt
```

System produces:

```
Request: EXP-0045
Risk:    High
Status:  Receipt Required
```

Trace: `$750 > $500` → risk **High** → would normally notify manager + finance, but receipt is missing → status overridden to **Receipt Required**, notifications suppressed, employee emailed instead. ✅

---

## Testing checklist

| Amount | Receipt | Expected risk | Expected status | Path fired |
|--------|---------|---------------|-----------------|------------|
| $45 | ✅ | Low | Approved | A |
| $99.99 | ✅ | Low | Approved | A |
| $100 | ✅ | Medium | Pending Manager Approval | B |
| $500 | ✅ | Medium | Pending Manager Approval | B |
| $500.01 | ✅ | High | Pending Manager + Finance | C |
| $750 | ❌ | High | Receipt Required | D |
| $45 | ❌ | Low | Receipt Required | D |

Rows 2–5 are the boundary tests — run those specifically, since off-by-one banding is the most common bug in this build. Row 7 confirms the receipt rule beats auto-approval.

---

## Files

```
02-expense-approval/
├── README.md
├── code/
│   ├── risk-assessment.js         ← step 4
│   └── request-id-generator.js    ← step 3
└── schema/
    ├── expense-requests-table.csv
    └── expense-requests-table.json
```
