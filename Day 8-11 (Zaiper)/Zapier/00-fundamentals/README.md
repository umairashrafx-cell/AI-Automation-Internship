# 00 — Zapier Fundamentals

Everything the later modules assume you already understand.

---

## 1. What is Zapier?

Zapier is a **no-code automation and integration platform** that connects different apps and makes them work together automatically.

Instead of manually moving information between apps, Zapier watches for an event in one app and performs actions in other apps.

Zapier is best when you want to connect many existing business applications quickly, with minimal technical work.

- Zapier is basically a **bridge between your business applications**
- **9,000+ apps**
- Specially built for **non-technical users**

> "Whenever someone submits our website form, add them to HubSpot and send them an email."

That entire sentence is buildable visually, with no code.

---

## 2. Anatomy of a Zap

A **Zap** consists of a **Trigger + one or more Actions**.

```
TRIGGER   ── the event Zapier watches for   (new form submission, new row, schedule, webhook)
   ↓
ACTION 1  ── something Zapier does           (create record, send email)
   ↓
ACTION 2  ── something else Zapier does      (post to Slack)
```

### Worked example

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

### Vocabulary

| Term | Meaning |
|------|---------|
| **Zap** | One complete automation |
| **Trigger** | The event that starts the Zap |
| **Action** | A step the Zap performs |
| **Task** | One successful action run — this is what Zapier bills |
| **Zap History** | Log of every run, with the data at each step |
| **App Connection** | A stored, managed credential for an app |

---

## 3. Zapier vs n8n

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

**Choose Zapier when:** *"I want to connect existing business apps quickly."*

**Choose n8n when:** *"I need deep customization and technical control."*

Practical read: Zapier trades ceiling for speed. You lose arbitrary code execution at every node and self-hosting, and you gain managed auth for 9,000 apps and a build that a non-engineer can maintain after you hand it over.

---

## 4. Build your first Zap

**Google Forms → Google Sheets → Gmail**

| Step | App | Event | Notes |
|------|-----|-------|-------|
| 1 | Google Forms | **New Form Response** (Trigger) | Connect the account, pick the form, pull a sample response |
| 2 | Google Sheets | **Create Spreadsheet Row** | Map each form field to a column |
| 3 | Gmail | **Send Email** | `To` = the email captured in step 1 |

Test each step before publishing. Zapier will not show you real field names until you have pulled at least one sample record from the trigger.

---

## 5. Data mapping

Every step after the trigger can reference data from earlier steps. Two kinds of data go into a mapping:

### Static data
Typed once, identical on every run.

```
Course: Agentic AI
Batch:  August 2026
```

### Dynamic data
Pulled from an earlier step, different on every run.

```
{{First Name}}
{{Email}}
{{Phone}}
```

In Zapier's editor you insert dynamic data from the field picker rather than typing the braces — the picker guarantees you reference a field that actually exists in that step's output.

**Rule of thumb:** anything that identifies *this particular run* is dynamic. Anything describing the automation itself is static.

---

## 6. Filters, Paths, and Formatter

These three are how logic gets into a Zap.

### Filter
A gate. The Zap **stops** unless the condition passes. One condition set, one outcome.

```
Only continue if …  Urgency  (Text) exactly matches  High
```

Use when: you want the rest of the Zap to run only sometimes.

### Paths
Branching. Up to a few named branches, each with its own conditions and its own chain of actions. Paths are evaluated top-down and **all matching paths run**.

```
Path A — Amount  (Number) less than       100    → auto-approve
Path B — Amount  (Number) greater than    500    → notify manager + finance
Path C — everything else                          → notify manager
```

Use when: different inputs need genuinely different actions. Paths replace what an `IF` node does in n8n.

### Formatter
Zapier's built-in data-transformation app. No connection needed. The transforms used across these modules:

| Transform | Used for |
|-----------|----------|
| **Text → Split Text** | Pulling one item out of a delimited string |
| **Text → Capitalize / Lowercase** | Normalising names and emails before comparison |
| **Numbers → Format Number** | Currency display in emails |
| **Numbers → Spreadsheet-Style Formula** | Light arithmetic without a Code step |
| **Date/Time → Format** | Converting a chatbot's "tomorrow" into `YYYY-MM-DD` |
| **Date/Time → Add/Subtract Time** | Due dates, SLA deadlines |
| **Utilities → Lookup Table** | Mapping a value to another value (e.g. doctor → specialty) |
| **Utilities → Line Itemizer** | Turning repeated fields into line items |

**Formatter vs Code by Zapier:** reach for Formatter first — it is free of code review and readable by whoever inherits the Zap. Drop to Code by Zapier when the logic is arithmetic across several fields, a loop, or a conditional cascade. Modules 01, 02 and 07–09 all cross that line, which is why they ship `.js` files.

---

## 7. AI Content Pipeline

The reference architecture the later agent modules build on:

```
Topic
  ↓
AI
  ↓
Generate Content
  ↓
Formatter
  ↓
Google Sheets
  ↓
Social Media
```

Read left to right: a topic enters (from a table, a form, or a schedule), an AI step turns it into content, Formatter cleans up the output into the exact shape downstream apps expect, the result is stored so there is a record of what was produced, and only then does anything get published.

The important design point — and the one Module 08 makes explicit — is that **storage comes before publishing**. Storing first gives you an audit trail and a human approval gate. An AI pipeline that publishes directly has no undo.

---

## 8. Practical notes learned while building these modules

- **Pull a real sample before mapping.** Zapier's field picker only shows fields it has actually seen from the trigger. Skipping the test leaves you mapping blind.
- **`inputData` in Code by Zapier always arrives as strings.** Always `parseFloat` / `parseInt` before comparing numbers. Every code file in this repo does.
- **Filters cost nothing.** A Zap that stops at a Filter does not bill a task for the steps it skipped.
- **Paths need a catch-all.** If no path matches, nothing runs and nothing warns you. Always define the "everything else" branch.
- **Name your steps.** `Score Lead` is findable in Zap History six weeks later; `Code by Zapier` is not.
- **Test with the ugly input.** Empty budget, missing receipt, "tomorrow" on a Sunday. Every one of those broke a first draft in these modules.
