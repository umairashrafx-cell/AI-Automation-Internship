# Module 01 — Sales Lead Intake System

**Category:** Interfaces / Tables
**Hint architecture:** `Interfaces → Zapier Tables → Formatter/Code → Filter/Paths`

---

## Scenario

A company wants a simple lead-capture system for its sales team. Build a **Zapier Interface** containing a lead submission form. Every submitted lead should automatically be stored in a **Zapier Table** and categorised based on the information provided.

---

## Part 1 — The Interface

**Create a page called:** `Sales Lead Intake`

Zapier → **Interfaces** → *Create Interface* → start blank → add a **Form** component.

### Form fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| Full Name | Short text | ✅ | |
| Email | Email | ✅ | Zapier validates format automatically |
| Phone | Phone | ✅ | |
| Company | Short text | ✅ | |
| Industry | Short text / Dropdown | ✅ | Dropdown is nicer for reporting later |
| Budget | Number | ✅ | Set as Number so the scoring step gets clean input |
| Lead Source | Dropdown | ✅ | see options below |
| Requirement | Long text | ✅ | free-text description of what they need |
| Urgency | Dropdown | ✅ | see options below |

**Lead Source options**

- Website
- LinkedIn
- Instagram
- Referral
- Advertisement

**Urgency options**

- Low
- Medium
- High

> **Build tip:** set Budget's field type to *Number*, not text. `lead-scoring.js` strips currency symbols defensively anyway, but a Number field stops the submitter typing "around 8k" in the first place.

---

## Part 2 — The Zapier Table

**Create a table called:** `Leads`

Columns — import [`schema/leads-table.csv`](schema/leads-table.csv), or create manually:

| Column | Type | Default |
|--------|------|---------|
| Lead ID | Text | — |
| Name | Text | — |
| Email | Email | — |
| Phone | Text | — |
| Company | Text | — |
| Industry | Text | — |
| Budget | Number | — |
| Lead Source | Dropdown | — |
| Requirement | Long text | — |
| Urgency | Dropdown | — |
| Lead Score | Number | — |
| Status | Dropdown | **New** |
| Created At | Date/Time | — |

Status dropdown options: `New`, `Contacted`, `Qualified`, `Lost`.
Priority (Hot/Warm/Cold) is derived from Lead Score — if you want it visible in the table, add an optional `Priority` dropdown column and map `priority` from the scoring step.

Exact field types are in [`schema/leads-table.json`](schema/leads-table.json).

---

## Part 3 — The Zap

**Zap name:** `Lead Intake — Score & Store`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **New Form Submission** | Zapier Interfaces → *New Form Submission* | Select the `Sales Lead Intake` form. Pull a sample before continuing. |
| 2 | **Find Last Lead** | Zapier Tables → *Find Record* | Table: `Leads`. Sort by `Created At` descending, limit 1. **Turn off** "create if not found". |
| 3 | **Generate Lead ID** | Code by Zapier → *Run JavaScript* | Paste [`code/lead-id-generator.js`](code/lead-id-generator.js). Input Data: `lastLeadId` ← step 2 `Lead ID` |
| 4 | **Score Lead** | Code by Zapier → *Run JavaScript* | Paste [`code/lead-scoring.js`](code/lead-scoring.js). Input Data: `urgency`, `budget`, `leadSource` ← step 1 |
| 5 | **Store Lead** | Zapier Tables → *Create Record* | Table `Leads`. Field mapping below. |
| 6 | **Only Hot Leads** | Filter by Zapier | `Only continue if…` step 4 `priority` **(Text) exactly matches** `Hot` |
| 7 | **Notify Sales** | Email by Zapier / Gmail / Slack | Template below. |

### Step 5 field mapping

| Table column | Maps from |
|--------------|-----------|
| Lead ID | step 3 → `leadId` |
| Name | step 1 → Full Name |
| Email | step 1 → Email |
| Phone | step 1 → Phone |
| Company | step 1 → Company |
| Industry | step 1 → Industry |
| Budget | step 1 → Budget |
| Lead Source | step 1 → Lead Source |
| Requirement | step 1 → Requirement |
| Urgency | step 1 → Urgency |
| Lead Score | step 4 → `leadScore` |
| Status | static text: `New` |
| Created At | step 3 → `createdAt` |

`Status` is the one static value in this mapping — every new lead enters as `New` regardless of score, which is what the task sheet specifies. The score decides *priority*, not *status*.

### Step 7 — sales notification template

**Subject:** `🔥 HOT LEAD — {{step1.Full Name}} ({{step1.Company}}) — Score {{step4.leadScore}}`

```
A high-priority lead just came in.

Lead ID:     {{step3.leadId}}
Name:        {{step1.Full Name}}
Company:     {{step1.Company}}
Email:       {{step1.Email}}
Phone:       {{step1.Phone}}
Industry:    {{step1.Industry}}
Budget:      ${{step1.Budget}}
Source:      {{step1.Lead Source}}
Urgency:     {{step1.Urgency}}

Score:       {{step4.leadScore}}  →  {{step4.priority}}
Breakdown:   {{step4.scoreBreakdown}}

Requirement:
{{step1.Requirement}}

Contact within 24 hours.
```

---

## Lead scoring rules

Implemented in [`code/lead-scoring.js`](code/lead-scoring.js).

| Factor | Condition | Points |
|--------|-----------|--------|
| Urgency | High | +30 |
| Urgency | Medium | +20 |
| Urgency | Low | +10 |
| Budget | above $5,000 | +30 |
| Budget | $1,000 – $5,000 | +20 |
| Budget | below $1,000 | +10 |
| Source | Referral | +20 |
| Source | LinkedIn | +15 |

**Banding**

| Score | Priority |
|-------|----------|
| 70+ | 🔥 Hot |
| 40–69 | 🌤 Warm |
| below 40 | ❄️ Cold |

Maximum achievable score is 80 (High + >$5k + Referral).

---

## Expected result

A user submits the form:

```
Ahmad | ABC Company | $8,000 | LinkedIn | High
```

Zapier produces:

```
Lead ID:  LEAD-2026-001
Score:    75
Status:   New
Priority: Hot
```

Trace: Urgency High `+30`, Budget $8,000 `+30`, Source LinkedIn `+15` → **75** → 70+ → **Hot** → Filter passes → sales team notified. ✅

---

## Testing checklist

| Test input | Expected score | Expected priority | Notification? |
|------------|----------------|-------------------|---------------|
| High / $8,000 / LinkedIn | 75 | Hot | ✅ yes |
| High / $8,000 / Referral | 80 | Hot | ✅ yes |
| Medium / $3,000 / Website | 40 | Warm | ❌ no |
| Low / $500 / Instagram | 20 | Cold | ❌ no |
| High / $6,000 / Website | 60 | Warm | ❌ no |
| Medium / $1,000 / Referral | 60 | Warm | ❌ no |
| Low / (blank budget) / Website | 10 | Cold | ❌ no |

The last row is the edge case worth actually running — a blank budget scores 0 points rather than defaulting into the "below $1,000" band, so an incomplete form never inflates its way into a warmer band than it earns.

---

## Files

```
01-lead-intake-system/
├── README.md
├── code/
│   ├── lead-scoring.js         ← step 4
│   └── lead-id-generator.js    ← step 3
└── schema/
    ├── leads-table.csv         ← import into Zapier Tables
    └── leads-table.json        ← exact column types
```
