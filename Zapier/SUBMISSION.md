# Submission — Day 8–11 (Zapier)

**Intern:** Umair Ashraf
**Program:** MATalogics AI Automation Internship
**Task sheet:** Day 8–11 — Zapier
**Submitted:** August 2026

---

## Coverage against the task sheet

Every requirement, mapped to where it lives in this folder.

### Fundamentals

| Requirement | File |
|-------------|------|
| What is Zapier | [`00-fundamentals/README.md`](00-fundamentals/README.md) §1 |
| Zap = Trigger + Actions | §2 |
| n8n vs Zapier comparison table | §3 |
| Build your first Zap — Google Forms → Sheets → Gmail | §4 |
| Data mapping — static vs dynamic | §5 |
| Filters & Logic/Paths, Formatter | §6 |
| AI Content Pipeline | §7 |

### Module 1 — Interface + Form + Table: Lead Intake System

| Requirement | Where |
|-------------|-------|
| Interface page `Sales Lead Intake`, 9 form fields | [`01/README.md`](01-lead-intake-system/README.md) Part 1 |
| Lead Source + Urgency options | Part 1 |
| Zapier Table `Leads`, 13 columns, default Status `New` | Part 2 · [`schema/leads-table.csv`](01-lead-intake-system/schema/leads-table.csv) |
| Capture form data | Zap step 1 |
| Calculate Lead Score | [`code/lead-scoring.js`](01-lead-intake-system/code/lead-scoring.js) |
| Store complete lead in Tables | Zap step 5 |
| Generate unique Lead ID | [`code/lead-id-generator.js`](01-lead-intake-system/code/lead-id-generator.js) |
| Notify sales team if high priority | Zap steps 6–7 (Filter + Email) |
| **Expected result: 75 / Hot / LEAD-2026-001** | ✅ verified |

### Module 2 — Interface + Form + Table: Employee Expense Approval

| Requirement | Where |
|-------------|-------|
| Interface `Employee Expense Portal`, 9 fields | [`02/README.md`](02-expense-approval/README.md) Part 1 |
| Table `Expense Requests`, 11 columns | Part 2 |
| Generate Request ID | [`code/request-id-generator.js`](02-expense-approval/code/request-id-generator.js) |
| Store request, determine risk | [`code/risk-assessment.js`](02-expense-approval/code/risk-assessment.js) |
| Low → auto Approved / Medium → manager / High → manager + finance | Paths A–C |
| Extra: missing receipt → `Receipt Required` | Path D + override in code |
| Approval step | Part 5 |
| **Expected: EXP-0045 / High / Receipt Required** | ✅ verified |

### Module 3 — AI Customer Support Bot (CloudFlow)

| Requirement | Where |
|-------------|-------|
| Chatbot handling pricing, features, account, troubleshooting, support requests | [`03/README.md`](03-ai-support-bot/README.md) |
| Knowledge base — plans, features, refund, support hours, troubleshooting | [`knowledge-base.md`](03-ai-support-bot/knowledge-base.md) |
| **Bot must NOT invent information** + exact fallback line | [`prompts/system-prompt.md`](03-ai-support-bot/prompts/system-prompt.md) — enforced three ways |
| Escalation on "talk to a human" → collect Name, Email, Problem | system prompt §Escalation |
| Chatbot → Zapier → `Support Tickets` table | Zap steps 1–4 |
| Priority detection (Critical / High / Medium / Low) | [`code/priority-detection.js`](03-ai-support-bot/code/priority-detection.js) |

### Module 4 — AI Appointment Booking Assistant

| Requirement | Where |
|-------------|-------|
| Collect 6 fields; 3 doctors | [`04/README.md`](04-appointment-booking/README.md) |
| Understand doctor / convert "tomorrow" / extract time | [`code/parse-booking-request.js`](04-appointment-booking/code/parse-booking-request.js) |
| Check availability → ask details → create → confirm | Zap steps 3–6, Path A |
| Table `Appointments`, 8 columns | [`schema/appointments-table.csv`](04-appointment-booking/schema/appointments-table.csv) |
| If unavailable: must NOT book; exact alternative-slots wording | [`code/availability-check.js`](04-appointment-booking/code/availability-check.js) → `botMessage` |
| **Extra: prevent double booking** | three layers — slot search + gate, prompt constraint, `Slot Key` column |

### Module 5 — Customer Onboarding Pipeline (Kanban)

| Requirement | Where |
|-------------|-------|
| Form, 8 fields | [`05/README.md`](05-customer-onboarding-kanban/README.md) Part 1 |
| Kanban stages New Lead → … → Completed | Part 2 |
| Create record, create card, put in New Lead, assign AM, confirmation email, due date | [`code/onboarding-setup.js`](05-customer-onboarding-kanban/code/onboarding-setup.js) + Zap 1 |
| Stage automation ×5 | [`code/stage-router.js`](05-customer-onboarding-kanban/code/stage-router.js) · [`templates/emails.md`](05-customer-onboarding-kanban/templates/emails.md) |
| **Extra: Qualified > 3 days → notify AM** | [`code/stale-card-check.js`](05-customer-onboarding-kanban/code/stale-card-check.js) |

### Module 6 — Recruitment Pipeline (Kanban)

| Requirement | Where |
|-------------|-------|
| Form, 9 fields | [`06/README.md`](06-recruitment-pipeline/README.md) Part 1 |
| Kanban stages Applied → … → Rejected | Part 2 |
| Create record + card, analyze experience, assign priority, put in Applied | [`code/candidate-priority.js`](06-recruitment-pipeline/code/candidate-priority.js) |
| Priority: 5+ High / 2–4 Medium / <2 Low | same file |
| Stage actions ×5 incl. **Any stage → Rejected** | [`code/stage-actions.js`](06-recruitment-pipeline/code/stage-actions.js) |
| **Extra: no update for 5 days → notify recruiter** | [`code/stale-candidate-check.js`](06-recruitment-pipeline/code/stale-candidate-check.js) |

### Module 7 — AI Customer Support Resolution Agent

| Requirement | Where |
|-------------|-------|
| Agent decides intent + severity, then what to do | [`prompts/agent-system-prompt.md`](07-autonomous-support-agent/prompts/agent-system-prompt.md) |
| 5 action mappings (password / billing / duplicate payment / technical / angry) | [`code/intent-severity-router.js`](07-autonomous-support-agent/code/intent-severity-router.js) |
| Customer Table + Ticket Table | [`schema/`](07-autonomous-support-agent/schema/) |
| Autonomous 4-question loop | system prompt |
| 5 tools: Search Customer, Search Tickets, Create, Update, Send Email | [`07/README.md`](07-autonomous-support-agent/README.md) |
| **Extra: check before creating a duplicate** | [`code/duplicate-ticket-check.js`](07-autonomous-support-agent/code/duplicate-ticket-check.js) |
| **Expected: "charged twice" → Billing / High / finance ticket** | ✅ verified |

### Module 8 — Instagram Content Agent

| Requirement | Where |
|-------------|-------|
| `Content Ideas` table, 6 columns | [`schema/content-ideas.csv`](08-instagram-content-agent/schema/content-ideas.csv) |
| Step 1 analyze existing content | [`code/content-gap-analysis.js`](08-instagram-content-agent/code/content-gap-analysis.js) |
| Step 2 choose topic/hook/type/CTA/audience | [`prompts/generator-agent.md`](08-instagram-content-agent/prompts/generator-agent.md) |
| Step 3 generate caption, hook, CTA, hashtags, visual concept | same |
| Step 4 second AI evaluation, 5 criteria, <7 rewrite | [`prompts/critic-agent.md`](08-instagram-content-agent/prompts/critic-agent.md) + [`code/quality-gate.js`](08-instagram-content-agent/code/quality-gate.js) |
| Step 5 store to `Instagram Content Calendar` | [`schema/content-calendar.csv`](08-instagram-content-agent/schema/content-calendar.csv) |
| Step 6 human approval, **do NOT publish** | Status = `Awaiting Approval` |
| **Extra: 3 educational posts → choose another type** | enforced in code *and* penalised by the critic |
| Advanced version | [`08/README.md`](08-instagram-content-agent/README.md) §Advanced |

### Module 9 — AI Operations Manager

| Requirement | Where |
|-------------|-------|
| Sales / Tasks / Support tables | [`schema/`](09-ai-operations-manager/schema/) |
| Sales: stuck deals, follow-ups, high-value at risk | [`code/business-analysis.js`](09-ai-operations-manager/code/business-analysis.js) |
| Tasks: overdue, who is overloaded | same |
| Support: unresolved critical, who needs escalation | same |
| Daily Operations Report | [`code/report-formatter.js`](09-ai-operations-manager/code/report-formatter.js) |
| Analyze → Identify → Prioritise → Recommend → Take permitted actions | [`prompts/ops-agent.md`](09-ai-operations-manager/prompts/ops-agent.md) + Zap steps 5–9 |
| Auto-create follow-up task when overdue | Zap step 9, duplicate-guarded |
| **Safety: no delete / no external messages / no financial changes** | [`code/safe-action-guard.js`](09-ai-operations-manager/code/safe-action-guard.js) — allowlist, default deny |

---

## Verification

Every Code by Zapier file was executed against the task sheet's own expected results plus boundary and failure cases, using a harness that reproduces Zapier's `inputData` / `output` globals.

```
131 assertions — 131 passed, 0 failed
```

Highlights of what is covered:

- **Module 1** — Ahmad / $8,000 / LinkedIn / High → score **75**, priority **Hot** ✓ (plus both budget-band boundaries and the blank-budget case)
- **Module 2** — Software / $750 / no receipt → risk **High**, status **Receipt Required** ✓ (plus $99.99 / $100 / $500 / $500.01 boundaries, and receipt-beats-auto-approval)
- **Module 3** — "system completely down" → **Critical**; "can't log in and the whole system is down" → **Critical**, not High
- **Module 4** — "tomorrow at 4 PM" → correct ISO date + `16:00`; taken slot returns the exact required wording; Sunday, past dates, out-of-hours and unknown doctors all rejected; a cancelled appointment frees its slot
- **Module 5/6** — stage routers fire the right action per transition; `Offer → Rejected` still sends the rejection; stale sweeps count days correctly and return an empty array when nothing is stale
- **Module 7** — "I was charged twice" → **Duplicate Payment / High / Create finance ticket** ✓; anger overrides an AI-proposed intent; open same-category ticket updates instead of duplicating
- **Module 8** — `Educational ×3` → `bannedContentTypes = Educational`, observation reads *"Too much educational content recently"* ✓; a critic that returns 9.5 alongside `invented_claim` is **capped to 4 and fails**; unparseable critique **fails closed**
- **Module 9** — closed deals excluded from staleness and pipeline; **compound risk** (same customer stale deal + critical ticket) detected; `send_email`, `delete_record`, `update_amount` and an invented action type all blocked by default-deny

Two real bugs were found and fixed during verification: the support bot missed *"the system **is** completely down"* (keyword shape), and the resolution agent classified *"What plan am I on?"* as a general enquiry rather than a billing question needing a customer lookup.

---

## Two columns added beyond the task sheet

Both are load-bearing, and both are flagged in the schema files:

- **`Last Activity`** on the Sales table (Module 9) and **`Stage Changed At`** / **`Last Update At`** on the Kanban tables (Modules 5, 6) — *"which deals are stuck"* and *"a card that stays in Qualified for more than 3 days"* have nothing to measure without a timestamp for when the state last changed.
- **`Slot Key`** on Appointments (Module 4) — a single exact-match column for the double-booking guard, so the check cannot be defeated by `16:00` vs `4:00 PM` formatting drift.

---

## Notes on approach

**Logic lives in one place per module.** Where a decision is needed, a single Code step makes it and outputs booleans; Paths and Filters then read those booleans rather than re-deriving the rule. Changing a threshold means editing one file, not four path conditions.

**Models advise, code decides.** Every AI step in Modules 7–9 is followed by a deterministic step that validates or overrides its output — an invalid intent falls back to keyword classification, a repetitive content type is banned before generation *and* penalised after, an unreviewable post cannot pass, and an action not on the allowlist cannot execute.

**Safety is a mechanism, not an instruction.** Module 9's prompt tells the agent it may not send external messages; [`safe-action-guard.js`](09-ai-operations-manager/code/safe-action-guard.js) is what makes that true. Default deny, with blocked actions surfaced in the report rather than silently dropped.

**Storage before publishing.** Module 8 writes the post to the calendar *before* any approval decision, so there is an audit trail and a human gate. Nothing publishes automatically.

---

## Repository

```
Zapier/
├── README.md            ← start here
├── SUBMISSION.md        ← this file
├── .gitignore
├── 00-fundamentals/
├── 01-lead-intake-system/
├── 02-expense-approval/
├── 03-ai-support-bot/
├── 04-appointment-booking/
├── 05-customer-onboarding-kanban/
├── 06-recruitment-pipeline/
├── 07-autonomous-support-agent/
├── 08-instagram-content-agent/
├── 09-ai-operations-manager/
└── assets/screenshots/  ← add your build screenshots here
```

**20 JavaScript step files · 6 AI prompt files · 22 table schemas (13 CSV + 9 JSON) · 11 READMEs**
