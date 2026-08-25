# Zapier — AI Automation Internship (Day 8–11)

**MATalogics AI Automation Internship**
Author: **Umair Ashraf**
Track: Zapier — Interfaces, Tables, Chatbots, Kanban Automation, Autonomous Agents

---

## What's in this repo

Nine build modules from the Day 8–11 Zapier task sheet. Each module folder is self-contained: a `README.md` that walks through the exact build in Zapier, a `code/` folder with the Code-by-Zapier JavaScript steps, a `schema/` folder with the Zapier Table column definitions (importable CSV + JSON), and where relevant a `prompts/` folder with the AI agent system prompts.

| # | Module | Category | Key Zapier features |
|---|--------|----------|---------------------|
| [00](00-fundamentals/) | Fundamentals | Concepts | Zap anatomy, data mapping, Filters, Paths, Formatter |
| [01](01-lead-intake-system/) | Sales Lead Intake System | Interfaces + Tables | Interface Form → Table → Code → Filter |
| [02](02-expense-approval/) | Employee Expense Approval | Interfaces + Tables | Form → Table → Paths → Approval step |
| [03](03-ai-support-bot/) | AI Customer Support Bot (CloudFlow) | Chatbot | Zapier Chatbot → Zap → Tickets Table |
| [04](04-appointment-booking/) | AI Appointment Booking Assistant | Chatbot | AI extraction → Table search → double-booking guard |
| [05](05-customer-onboarding-kanban/) | Customer Onboarding Pipeline | Kanban | Form → Table → Kanban → Paths → Delay |
| [06](06-recruitment-pipeline/) | Recruitment Pipeline | Kanban | Form → Kanban stages → stage-change emails |
| [07](07-autonomous-support-agent/) | AI Support Resolution Agent | Agent | Tool-using agent, intent + severity routing |
| [08](08-instagram-content-agent/) | Instagram Content Agent | Agent | Generator + Critic agent loop, human approval |
| [09](09-ai-operations-manager/) | AI Operations Manager | Agent | Scheduled multi-table analysis + safe actions |

---

## What Zapier is

Zapier is a no-code automation and integration platform that connects different apps and makes them work together automatically. Instead of manually moving information between apps, Zapier watches for an event in one app and performs actions in other apps.

A **Zap** = **Trigger + one or more Actions**.

```
Someone fills a Google Form
        ↓
Zapier detects the new submission
        ↓
Adds the data to Google Sheets
        ↓
Sends a confirmation email
        ↓
Notifies the sales team on Slack
```

That's a Zap. Zapier is essentially a bridge between business applications — 9,000+ of them — and it is explicitly designed around no-/low-code workflows and managed app connections, so a marketing person, HR person, salesperson, or operations manager can build automation without being a programmer.

### Zapier vs n8n

| n8n | Zapier |
|-----|--------|
| Workflow | Zap |
| Trigger Node | Trigger |
| Action Node | Action |
| IF | Filter / Paths |
| HTTP Request | Webhooks |
| Credentials | App Connections |
| Execution | Task |
| Workflow History | Zap History |
| AI Agent | AI / Agent features |

**Choose Zapier when:** "I want to connect existing business apps quickly."
**Choose n8n when:** "I need deep customization and technical control."

Full write-up in [`00-fundamentals/README.md`](00-fundamentals/README.md).

---

## How to use this repo

1. Open the module folder you want to build.
2. Follow the **Build steps** section of its README inside your Zapier account — it lists every trigger, action, field mapping and condition in order.
3. Where a step says *Code by Zapier*, paste the matching file from that module's `code/` folder. Every code file documents its expected `inputData` keys at the top and returns a plain object, which is what Code by Zapier expects.
4. Import the table columns from `schema/*.csv` (or read `schema/*.json` for exact field types).
5. Drop your build screenshots into [`assets/screenshots/`](assets/screenshots/) and link them from the module README.

### Code by Zapier conventions used here

Every JS file follows the same contract:

```js
// inputData keys the step expects are listed in the header comment
// The step returns a single object; its keys become available to later steps
// as {{steps.<step_name>.<key>}}
output = { ... };   // Zapier assigns whatever you set to `output`
```

All numeric inputs are parsed defensively (`inputData` always arrives as strings from Zapier), and every file is plain ES5/ES2015-safe JavaScript so it runs in Zapier's sandbox without transpilation.

---

## Repository layout

```
Zapier/
├── README.md                       ← you are here
├── SUBMISSION.md                   ← task-sheet checklist mapped to files
├── 00-fundamentals/
├── 01-lead-intake-system/
│   ├── README.md
│   ├── code/*.js
│   └── schema/*.csv, *.json
├── 02-expense-approval/
├── ...
├── 09-ai-operations-manager/
└── assets/screenshots/
```

---

*"Every day you complete in this internship is another building block in your AI career."*
