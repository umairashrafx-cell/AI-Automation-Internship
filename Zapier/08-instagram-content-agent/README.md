# Module 08 — Instagram Content Agent

**Category:** Autonomous Agent — *"This one should be your most interesting agent project."*

**Hint architecture:**
`Trigger → Agent → Research Tools → Decision → Content Generation → Critic Agent → Decision → Table → Human Approval`

---

## Scenario

Build an AI Instagram content agent for a fictional brand (**Nova Labs** — AI automation course and done-for-you services for small business owners).

The goal isn't simply generating captions. The agent should decide:

> **What should we post today?**

That question is what makes this an agent. A caption generator is handed a topic. This one reads what has already been posted, notices the pattern, and picks.

---

## Input — the Content Ideas table

**Create:** `Content Ideas` — import [`schema/content-ideas.csv`](schema/content-ideas.csv)

| Column | Type |
|--------|------|
| Topic | Text |
| Product | Dropdown — AI Course / Done-For-You Automation |
| Target Audience | Text |
| Content Type | Dropdown |
| Goal | Dropdown — Leads / Awareness / Trust / Engagement |
| Status | Dropdown — Not Used / Used / Retired |

**Example row:**

```
Topic:    AI Automation
Product:  AI Course
Audience: Business Owners
Type:     Educational
Goal:     Leads
```

---

## Agent workflow

Every time the agent runs:

### Step 1 — Analyze existing content

Check previous Instagram posts. Determine:

- What topics were already posted?
- What content types are being overused?
- Which topics haven't been covered recently?

**Implemented in [`code/content-gap-analysis.js`](code/content-gap-analysis.js).** This is computed in code rather than left to the model, because "count how many of the last five posts were Educational" is something a model does unreliably and a loop does perfectly. The model is then told *which types it may not choose*, which is a far easier instruction to follow than "notice a pattern".

### Step 2 — Choose content

The agent independently chooses:

- Topic
- Hook
- Content type
- CTA
- Target audience

Prompt: [`prompts/generator-agent.md`](prompts/generator-agent.md)

### Step 3 — Generate post

Generates:

- Instagram caption
- Hook
- CTA
- Hashtags
- Suggested visual concept

### Step 4 — Quality check

**A second AI evaluation** checks:

- Is the hook strong?
- Is the content repetitive?
- Is the CTA clear?
- Is it relevant to the audience?
- Does it contain unsupported claims?

**If score < 7 → Rewrite. If score ≥ 7 → Approve.**

Prompt: [`prompts/critic-agent.md`](prompts/critic-agent.md) · Gate: [`code/quality-gate.js`](code/quality-gate.js)

The critic must be a **separate AI step**. A model asked to write and then judge its own work in a single pass approves nearly everything it writes.

### Step 5 — Store

Save the approved post to **Instagram Content Calendar** — [`schema/content-calendar.csv`](schema/content-calendar.csv)

| Column | Type |
|--------|------|
| Date | Date |
| Topic | Text |
| Caption | Long text |
| Hook | Text |
| CTA | Text |
| Hashtags | Text |
| Visual Concept | Long text |
| Score | Number |
| Status | Dropdown |

### Step 6 — Human approval

**Do NOT directly publish.**

Set `Status = Awaiting Approval`, then send the content to the marketing person.

Storage happens **before** any publishing decision. That ordering is the whole safety design — it gives an audit trail and a human gate. An AI pipeline that publishes directly has no undo.

---

## The Zap

**Zap name:** `Instagram Agent — Daily Content`

| # | Step | App / Event | Configuration |
|---|------|-------------|---------------|
| 1 | **Schedule** | Schedule by Zapier → *Every Day* | e.g. 08:00 |
| 2 | **Read calendar** | Zapier Tables → *Find Records* (`Instagram Content Calendar`) | sort `Date` desc, limit 10 |
| 3 | **Read ideas** | Zapier Tables → *Find Records* (`Content Ideas`) | `Status` = `Not Used` |
| 4 | **Analyze Existing Content** | Code by Zapier | [`code/content-gap-analysis.js`](code/content-gap-analysis.js) |
| 5 | **Generate Post** | AI by Zapier / OpenAI → *Conversation* | [`prompts/generator-agent.md`](prompts/generator-agent.md) · inputs: step 4 `recentSummary`, `bannedContentTypes`, `suggestedTypes`, `uncoveredIdeas` |
| 6 | **Quality Check** | AI by Zapier / OpenAI → *Conversation* | [`prompts/critic-agent.md`](prompts/critic-agent.md) · inputs: step 5 output + step 4 `recentSummary` |
| 7 | **Quality Gate** | Code by Zapier | [`code/quality-gate.js`](code/quality-gate.js) · `attemptNumber` = `1` |
| 8 | **Rewrite?** | Paths by Zapier | Path R below |
| 9 | **Store** | Zapier Tables → *Create Record* | Calendar mapping below |
| 10 | **Notify marketing** | Email / Slack | template below |
| 11 | **Mark idea used** | Zapier Tables → *Update Record* (`Content Ideas`) | `Status` = `Used` |

### Path R — rewrite loop

**Condition:** step 7 `needsRewrite` **is true**

1. AI step — generator again, with `rewrite_instructions` from step 7 prepended
2. AI step — critic again
3. Code by Zapier — [`code/quality-gate.js`](code/quality-gate.js) with `attemptNumber` = `2`

Zapier has no loop construct, so the rewrite is a second explicit pair of steps behind a Filter. **Two attempts maximum.** If the second still fails, the record is stored with `Status = Needs Human Rewrite` — nothing is silently dropped.

### Step 9 — calendar mapping

| Column | Maps from |
|--------|-----------|
| Date | `{{zap_meta_human_now}}` |
| Topic | gate → `topic` |
| Caption | gate → `caption` |
| Hook | gate → `hook` |
| CTA | gate → `cta` |
| Hashtags | gate → `hashtags` |
| Visual Concept | gate → `visualConcept` |
| Score | gate → `score` |
| Status | gate → `status` |

### Step 10 — marketing notification

```
Subject: Instagram post ready for approval — {{step7.topic}} ({{step7.score}}/10)

{{step4.agentObservation}}

Topic:        {{step7.topic}}
Content type: {{step7.contentType}}
Score:        {{step7.score}}/10 ({{step7.reviewSummary}})

HOOK
{{step7.hook}}

CAPTION
{{step7.caption}}

CTA
{{step7.cta}}

HASHTAGS
{{step7.hashtags}}

VISUAL CONCEPT
{{step7.visualConcept}}

Reviewer notes: {{step7.strengths}}

Approve or edit in the Instagram Content Calendar table.
Status is currently: {{step7.status}} — nothing has been published.
```

---

## Extra autonomous behaviour

> If there are already 3 educational posts recently, the agent should recognise this and choose another content type.
>
> ```
> Educational → Educational → Educational
> ```
>
> Agent decides: *"Too much educational content recently."*
> So it chooses: **Case Study**

**Implemented and enforced.** [`code/content-gap-analysis.js`](code/content-gap-analysis.js) counts content types across the last 5 posts, flags any type appearing 3+ times (and any straight run of 3), and returns:

```
isOverused         = true
overusedType       = "Educational"
bannedContentTypes = "Educational"
suggestedTypes     = "Case Study, Behind the Scenes, Myth Buster, ..."
agentObservation   = "Too much educational content recently — 3 of the last 3 posts.
                      Choosing a different content type."
```

The generator prompt receives `bannedContentTypes` as a hard constraint, and the **critic independently penalises repetition** — capping the total at 6 if the post is the same type as the last three. Two independent checks, so a model that ignores the constraint still cannot get the post approved.

---

## Advanced version

Give the agent access to:

- Instagram post history
- Content Calendar
- Product information
- Customer personas
- Competitor research
- Web search

Add these as extra **Find Records** steps (personas and product info as their own small tables) plus a web-search action, and map their output into the generator's context. The agent then has enough information to make decisions rather than simply following a fixed sequence.

The architecture doesn't change — more research tools feed step 4, and step 4's brief gets richer. That is the difference between a pipeline and an agent: adding a data source makes the decisions better without rewiring the flow.

---

## Testing checklist

| Setup | Expected |
|-------|----------|
| Calendar has Educational × 3 | `isOverused` true, `bannedContentTypes` = Educational, agent picks something else and says why |
| Calendar has a balanced mix | `isOverused` false, agent chooses on topic gaps |
| Empty calendar | "No post history yet" — agent picks a foundational topic |
| Generator writes a weak "Let's talk about…" hook | Critic scores hook ≤ 4, total < 7 → rewrite |
| Generator invents "87% of businesses…" | Critic caps total at 4, `cap_applied` = `invented_claim` → rewrite |
| Rewrite scores 8.2 | Stored, `Status = Awaiting Approval`, marketing notified |
| Both attempts score < 7 | Stored with `Status = Needs Human Rewrite`, marketing still notified |
| Critic returns malformed JSON | Score 0, does **not** pass — fails closed |
| Post approved | **Nothing is published** — status is `Awaiting Approval` |

The last row is the one to verify deliberately. The module is only correct if a fully approved, 9/10 post still sits and waits for a person.

---

## Files

```
08-instagram-content-agent/
├── README.md
├── prompts/
│   ├── generator-agent.md          ← step 5
│   └── critic-agent.md             ← step 6
├── code/
│   ├── content-gap-analysis.js     ← step 4
│   └── quality-gate.js             ← step 7
└── schema/
    ├── content-ideas.csv
    ├── content-calendar.csv
    └── tables.json
```
