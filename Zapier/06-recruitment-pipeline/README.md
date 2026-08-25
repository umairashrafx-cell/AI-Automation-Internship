# Module 06 — Recruitment Pipeline

**Category:** Kanban + Form Automation
**Hint architecture:** `Forms + Tables + Kanban + Paths + Delay + Email`

---

## Scenario

Build a recruitment management system for a company hiring developers. Candidates apply through a form and automatically enter a Kanban pipeline.

---

## Part 1 — The Form

Zapier Interfaces → new page → **Form**.

**Page name:** `Developer Application`

| Field | Type | Required |
|-------|------|----------|
| Candidate Name | Short text | ✅ |
| Email | Email | ✅ |
| Phone | Phone | ✅ |
| Position | Dropdown | ✅ |
| Experience | Short text / Number | ✅ |
| Expected Salary | Number | ✅ |
| Resume | File upload | ✅ |
| Portfolio | URL | ❌ |
| Availability | Dropdown | ✅ |

**Position options:** `Frontend Developer`, `Backend Developer`, `Full Stack Developer`, `Mobile Developer`, `AI/Automation Engineer`

**Availability options:** `Immediate`, `2 weeks`, `1 month`, `2 months`, `Negotiable`

> **On the Experience field:** a Number field gives you clean input, but real applicants write "3–4 years" and "fresher". [`code/candidate-priority.js`](code/candidate-priority.js) parses all of those, taking the lower bound of a range and treating "fresher" as 0. Either field type works.

---

## Part 2 — Kanban stages

```
Applied → Screening → Technical Interview → HR Interview → Offer → Hired → Rejected
```

Create these as the `Stage` dropdown options in this order, then add a **Kanban** component to the interface grouped by `Stage`.

`Rejected` sits at the end as the terminal column — candidates can be dragged there from *any* stage, and the automation handles that.

---

## Part 3 — The Table

**Create:** `Candidates` — import [`schema/candidates-table.csv`](schema/candidates-table.csv)

| Column | Type |
|--------|------|
| Candidate ID | Text |
| Candidate Name | Text |
| Email | Email |
| Phone | Text |
| Position | Dropdown |
| Experience | Text |
| Years Experience | Number |
| Expected Salary | Number |
| Resume | File |
| Portfolio | URL |
| Availability | Dropdown |
| Priority | Dropdown — High / Medium / Low |
| **Stage** | Dropdown — the Kanban column |
| **Last Update At** | Date/Time — **required for the extra challenge** |
| Applied At | Date/Time |

---

## Part 4 — Zap 1: new application

**Zap name:** `Recruitment — New Application`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **New application** | Zapier Interfaces → *New Form Submission* | `Developer Application` |
| 2 | **Find Last Candidate** | Zapier Tables → *Find Record* | sort `Applied At` desc, limit 1 |
| 3 | **Analyze Candidate** | Code by Zapier | [`code/candidate-priority.js`](code/candidate-priority.js) |
| 4 | **Create candidate record** | Zapier Tables → *Create Record* | `Stage` = `Applied` · `Last Update At` = step 3 `appliedAt` |
| 5 | **Notify recruiter (High only)** | Filter → step 3 `isHighPriority` is true, then Email/Slack | optional but useful |

The task sheet's five automation steps map onto this Zap as:

| Task sheet step | Where |
|-----------------|-------|
| 1. Create candidate record | step 4 |
| 2. Create Kanban card | step 4 — the record *is* the card |
| 3. Analyze experience | step 3 |
| 4. Assign priority | step 3 |
| 5. Put candidate in Applied | step 4, `Stage` = `Applied` |

---

## Priority rules

Implemented in [`code/candidate-priority.js`](code/candidate-priority.js).

| Experience | Priority |
|------------|----------|
| 5+ years | **High** |
| 2–4 years | **Medium** |
| < 2 years | **Low** |

Parsing handles `"5"`, `"5 years"`, `"5+"`, `"3-4 years"` (→ 3, the conservative lower bound), `"fresher"` (→ 0), and free text with no number (→ 0).

---

## Part 5 — Zap 2: stage actions

**Zap name:** `Recruitment — Stage Changed`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Card moved** | Zapier Tables → *Updated Record* | watch `Stage` |
| 2 | **Route Stage Action** | Code by Zapier | [`code/stage-actions.js`](code/stage-actions.js) |
| 3 | **Stamp the update** | Zapier Tables → *Update Record* | `Last Update At` ← `{{zap_meta_human_now}}` |
| 4 | **Anything to send?** | Filter by Zapier | step 2 `shouldAct` **is true** |
| 5 | **Send** | Email by Zapier | To `{{step2.recipient}}` · Subject `{{step2.subject}}` · Body `{{step2.body}}` |

### Stage actions implemented

| Transition | Action | Audience |
|------------|--------|----------|
| **Applied → Screening** | Send screening email | candidate |
| **Screening → Technical Interview** | Send interview scheduling email | candidate |
| **Technical Interview → HR Interview** | Notify HR | internal |
| **Offer → Hired** | Send congratulations email | candidate |
| **Any stage → Rejected** | Send rejection email | candidate |

Full wording in [`templates/emails.md`](templates/emails.md).

**Two design decisions worth knowing:**

`Rejected` is checked **first** in the router. Because it can be reached from any column — including straight out of `Offer` — checking it before the others guarantees the rejection email fires regardless of where the card came from. That is exactly what *"Any stage → Rejected"* asks for.

`Offer` deliberately sends **nothing**. An offer is a conversation with a number in it; a Zap should not be the thing that makes it. The board moves, HR follows up personally, and the automation picks back up at `Hired`.

---

## Part 6 — Extra challenge: candidates going quiet

> *If a candidate hasn't received an update for 5 days, notify the recruiter.*

**Zap 3:** `Recruitment — Stale Candidate Sweep`

| # | Step | App / Event |
|---|------|-------------|
| 1 | Schedule by Zapier → *Every Day* at 09:00 |
| 2 | Zapier Tables → *Find Records* — `Stage` is any of `Applied`, `Screening`, `Technical Interview`, `HR Interview`, `Offer` |
| 3 | Code by Zapier — [`code/stale-candidate-check.js`](code/stale-candidate-check.js) |
| 4 | Filter — `isStale` is true |
| 5 | Email by Zapier → the recruiter |

`Hired` and `Rejected` are excluded at step 2 — those candidates have their answer. Results are sorted most-neglected-first so the recruiter's inbox is usefully ordered.

This needs the `Last Update At` column, stamped by Zap 2 step 3 on every move. Without it the sweep measures how long ago someone applied, not how long they have been waiting to hear back.

---

## Testing checklist

| Action | Expected |
|--------|----------|
| Apply with `Experience = 7` | Priority **High**, card in Applied |
| Apply with `Experience = "3-4 years"` | Parsed as 3 → **Medium** |
| Apply with `Experience = "fresher"` | Parsed as 0 → **Low** |
| Apply with `Experience = 5` | **High** (boundary) |
| Apply with `Experience = 2` | **Medium** (boundary) |
| Apply with `Experience = 1.5` | **Low** |
| Drag Applied → Screening | Candidate receives screening email · `Last Update At` refreshed |
| Drag Screening → Technical Interview | Candidate receives scheduling email |
| Drag Technical Interview → HR Interview | **HR** notified, candidate gets nothing |
| Drag HR Interview → Offer | Nothing sent — intentional |
| Drag Offer → Hired | Candidate receives congratulations |
| Drag **Screening → Rejected** | Rejection email sent |
| Drag **Offer → Rejected** | Rejection email sent — the "any stage" rule |
| Leave a candidate 6 days in Screening | Recruiter nudged next morning |
| Leave a **Hired** candidate 10 days | Nothing — terminal stage excluded |

---

## Files

```
06-recruitment-pipeline/
├── README.md
├── code/
│   ├── candidate-priority.js       ← Zap 1, step 3
│   ├── stage-actions.js            ← Zap 2, step 2
│   └── stale-candidate-check.js    ← Zap 3, step 3
├── templates/
│   └── emails.md
└── schema/
    ├── candidates-table.csv
    └── candidates-table.json
```
