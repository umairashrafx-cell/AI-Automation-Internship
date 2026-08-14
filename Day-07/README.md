# Day 7 — AI Client Onboarding System

**Single end-to-end business automation.** A client calls a Vapi voice agent, the agent collects six pieces of information, n8n classifies the enquiry with AI, and the result is written to Airtable, turned into a Notion onboarding page, and announced in Slack with a priority-based message.

```
Client
  ↓
Vapi Voice Agent  ("Client Onboarding Agent")
  ↓
n8n Webhook
  ↓
AI Processing  (OpenAI — category, summary, next action)
  ↓
  ├──────────────┬──────────────┬──────────────┐
  ↓              ↓              ↓
Airtable       Notion         Slack
Database       Onboarding     Team Alert
```

---

## Repository contents

| Path | What it is |
|---|---|
| `workflow/day7-client-onboarding.json` | The importable n8n workflow (20 nodes) |
| `vapi/client-onboarding-agent.json` | Full Vapi assistant configuration — system prompt, voice, and the webhook tool schema |
| `vapi/system-prompt.md` | The agent system prompt on its own, for pasting into the Vapi dashboard |
| `tests/` | Four sample webhook payloads (HIGH / MEDIUM / LOW / flat) for testing without spending call minutes |
| `build_workflow.py` | The script that generated the workflow JSON — edit and re-run if you want to change node wiring |
| `build_vapi_agent.py` | The script that generated the Vapi assistant JSON and the test payloads. It reads the prompt out of `vapi/system-prompt.md`, so edit the markdown and re-run rather than hand-editing the JSON |
| `screenshots/` | Drop your proof screenshots here (see the checklist at the bottom) |

---

## 1 — Airtable setup

Create a base called **AI Client Onboarding** with one table called **Client Onboarding**.

| Field name | Field type | Notes |
|---|---|---|
| Client Name | Single line text | This is the primary field |
| Company | Single line text | |
| Email | Email | |
| Service | Single line text | What the caller literally asked for |
| Description | Long text | |
| Budget | Number | Precision 0, no decimals |
| Category | Single select | Web Development, Mobile App Development, Web & Mobile Development, E-Commerce, AI & Automation, Branding & Design, Digital Marketing, Other |
| Priority | Single select | HIGH, MEDIUM, LOW |
| Summary | Long text | AI-written |
| Status | Single select | New, Contacted, Proposal Sent, Won, Lost |
| Created At | Date | Turn **Include time** on |

Field names must match exactly — the workflow maps to them by name.

Get a **Personal Access Token** from <https://airtable.com/create/tokens> with the scopes `data.records:write` and `schema.bases:read`, and give it access to this base.

## 2 — Notion setup

Create a database (full page) called **Client Projects** with these properties:

| Property name | Property type | Options |
|---|---|---|
| Name | Title | Holds the company name |
| Client | Text | |
| Email | Email | |
| Service | Text | |
| Budget | Number | Format: Number |
| Priority | Select | HIGH, MEDIUM, LOW |
| Status | Select | New, In Progress, Completed |
| Next Action | Text | |
| Created At | Date | |

Create an internal integration at <https://www.notion.so/my-integrations>, then open the **Client Projects** database → `...` menu → **Connections** → **Connect to** → your integration. Without this step the API returns 404.

The workflow creates the page with those properties and then appends the required page body:

```
Onboarding Details

Client: Ali
Company: ABC Restaurant
Email: ali@abcrestaurant.pk
Service: Web & Mobile Development
Budget: PKR 500,000
Priority: HIGH
Summary: Restaurant requires website and mobile ordering application.
Next Action: Schedule technical consultation
Status: New

☐ Send welcome email to ali@abcrestaurant.pk
☐ Schedule technical consultation
☐ Prepare proposal and quotation
```

## 3 — Slack setup

Create a public channel called **#new-clients**.

Create a Slack app at <https://api.slack.com/apps> → **OAuth & Permissions** → add the bot scopes `chat:write` and `channels:read` → install to workspace → copy the **Bot User OAuth Token** (`xoxb-…`). Then in Slack, type `/invite @YourBotName` inside **#new-clients**.

## 4 — n8n setup

1. **Workflows → Import from File →** `workflow/day7-client-onboarding.json`
2. Add four credentials in n8n: OpenAI, Airtable (Personal Access Token), Notion, Slack (Bot token).
3. Open each of these nodes and re-select the credential and the resource from the dropdown, replacing the `REPLACE_…` placeholders:
   - `OpenAI Chat Model` → credential
   - `Airtable - Create Client Record` → credential, base, table
   - `Notion - Create Onboarding Page` → credential, database
   - `Notion - Append Page Content` → credential
   - the four `Slack - …` nodes → credential, channel
4. Open the **Vapi Webhook** node and copy the **Production URL**. It looks like `https://your-instance.app.n8n.cloud/webhook/vapi-client-intake`.
5. **Save**, then toggle the workflow to **Active**.

## 5 — Vapi setup

1. Create a new assistant named **Client Onboarding Agent**.
2. Paste the contents of `vapi/system-prompt.md` into the system prompt.
3. Add a **Function / Tool** called `submit_client_onboarding` with the six parameters listed in `vapi/client-onboarding-agent.json` (`client_name`, `company_name`, `email`, `service_required`, `project_description`, `budget`), and set the **Server URL** to your n8n production webhook URL from step 4.
4. Attach a phone number to the assistant.

Two settings in `vapi/client-onboarding-agent.json` are worth understanding before you change them:

- **`voice`** is set to `{"provider": "vapi", "voiceId": "Neha"}` — Vapi's own built-in voices need no extra API key, so the assistant works on a free account. Swap in `{"provider": "11labs", "voiceId": "sarah"}` if you have an ElevenLabs key connected.
- **`serverMessages`** is deliberately `[]`. The tool already POSTs to n8n when it fires. If you also enable `end-of-call-report` against the same URL, n8n runs a second time for the same caller and you get duplicate Airtable rows and Notion pages.

If you prefer to configure it via the API instead of clicking through the dashboard:

```bash
curl -X POST https://api.vapi.ai/assistant \
  -H "Authorization: Bearer $VAPI_PRIVATE_KEY" \
  -H "Content-Type: application/json" \
  -d @vapi/client-onboarding-agent.json
```

Remember to replace `https://REPLACE-WITH-YOUR-N8N-HOST/webhook/vapi-client-intake` in that file first.

---

## How the AI processing works

The `Classify Enquiry (AI)` node asks the model for exactly this JSON:

```json
{
  "service_category": "Web & Mobile Development",
  "priority": "High",
  "summary": "Restaurant requires website and mobile ordering application.",
  "next_action": "Schedule technical consultation"
}
```

**Important design decision:** the model is asked for a priority, but the workflow does **not** trust it. The `Classify with AI` code node recomputes priority from the budget:

| Budget (PKR) | Priority |
|---|---|
| ≥ 500,000 | HIGH |
| 200,000 – 499,999 | MEDIUM |
| < 200,000 | LOW |

An LLM will occasionally return "High" for a 300,000 budget because it sounds like a big project. Hard-coding the rule is what makes the three required test calls pass every single time. The AI still does the genuinely fuzzy work — categorising the service, summarising the project, and recommending a next step.

The code node is also defensive: if the model wraps its answer in a markdown fence, adds a sentence before the JSON, or returns something unparseable, the parser recovers and falls back to the caller's own words rather than failing the run.

## The one extra feature — priority-based Slack messages

A `Route by Priority` switch sends each lead down a different branch:

| Priority | Slack headline | Extra behaviour |
|---|---|---|
| HIGH | 🚨 HIGH PRIORITY CLIENT | `<!channel>` ping + "contact within 2 hours" SLA |
| MEDIUM | 🔶 MEDIUM PRIORITY CLIENT | 24-hour SLA |
| LOW | ✅ STANDARD CLIENT | 3-business-day SLA |
| *(fallback)* | ⚠️ Unclassified | Asks the team to review manually |

Message shape:

```
:mega: NEW CLIENT :rotating_light: HIGH PRIORITY CLIENT

Ali - ABC Restaurant

> Service:  Web & Mobile Development
> Budget:   PKR 600,000
> Priority: HIGH
> Email:    ali@abcrestaurant.pk

AI Summary: Restaurant requires website and mobile ordering application.
Next Action: Schedule technical consultation
SLA: Contact within 2 hours

:white_check_mark: Airtable + Notion records created successfully.
```

---

## Required test — 3 calls

| # | Budget | Expected priority | Expected Slack headline |
|---|---|---|---|
| 1 | 600,000 | **HIGH** | HIGH PRIORITY CLIENT |
| 2 | 300,000 | **MEDIUM** | MEDIUM PRIORITY CLIENT |
| 3 | 100,000 | **LOW** | STANDARD CLIENT |

Scripts to read out on each call:

> **Call 1 —** "Hi, I'm Ali from ABC Restaurant. We need a website and a mobile app for online ordering. My email is ali at abcrestaurant dot p k. Our budget is around six hundred thousand rupees."

> **Call 2 —** "Hello, this is Sara from Noor Fashion House. We want an e-commerce website with payment integration. Email is sara at noorfashion dot p k. Budget is three hundred thousand rupees."

> **Call 3 —** "Hi, Bilal here from Bilal Auto Works. I just need a simple one page website with a contact form. My email is bilal at bilalautoworks dot p k. Budget is one hundred thousand rupees."

After all three calls you should have 3 Airtable rows, 3 Notion pages, and 3 Slack messages with three different headlines.

### Testing without burning call minutes

The payloads in `tests/` reproduce exactly what Vapi POSTs, so you can validate the whole chain first:

```bash
N8N_WEBHOOK="https://your-instance.app.n8n.cloud/webhook/vapi-client-intake"

for f in tests/test-1-high.json tests/test-2-medium.json tests/test-3-low.json; do
  echo "--- $f"
  curl -s -X POST "$N8N_WEBHOOK" -H "Content-Type: application/json" -d @"$f"
  echo
done
```

Each call returns the spoken confirmation Vapi will read back to the caller:

```json
{
  "results": [
    {
      "toolCallId": "toolu_high_001",
      "result": "Thanks Ali, I have logged ABC Restaurant for Web & Mobile Development. Our team has been notified and will schedule technical consultation."
    }
  ]
}
```

The four payloads each exercise a different shape the webhook has to survive:

| File | Shape | Budget sent | Expected |
|---|---|---|---|
| `test-1-high.json` | Vapi tool call, `arguments` as an object | `600000` | HIGH |
| `test-2-medium.json` | Vapi tool call, `arguments` as an object | `300000` | MEDIUM |
| `test-3-low.json` | Vapi tool call, `arguments` as a **JSON string** | `100000` | LOW |
| `test-4-flat-payload.json` | Flat body (curl / Postman), no `message` wrapper | `"4 lakh"` | `400000` → MEDIUM |

Test 3 matters because Vapi sends `function.arguments` as a string in some versions and as an object in others — the `Normalize Vapi Payload` node handles both. Test 4 additionally checks the budget parser and the email cleanup (it sends `"  Hina@HinaInteriors.PK "`, which must come out as `hina@hinainteriors.pk`).

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Notion node returns 404 | The database was never shared with the integration. Database → `...` → Connections → add your integration. |
| Notion "property does not exist" | Property names are case-sensitive and must match section 2 exactly. |
| Airtable 422 `INVALID_VALUE_FOR_COLUMN` | A single-select option is missing. `typecast` is on, which creates missing options automatically — if it still fails, check that Budget is a Number field, not text. |
| Slack `channel_not_found` | The bot is not in `#new-clients`. Run `/invite @YourBot` in the channel. |
| Slack `not_in_channel` | Same fix as above. |
| Vapi call ends but nothing arrives in n8n | The workflow is not **Active**, or the tool's Server URL still points at `/webhook-test/` instead of `/webhook/`. |
| Vapi times out on the tool call | The chain writes to three services before responding. Raise the tool `timeoutSeconds` to 25–30. |
| Priority is wrong | Check the raw `budget` value in the `Normalize Vapi Payload` node output — the agent probably sent text like "around 5 lakh". The parser handles lakh/crore/k/million, but check the output to confirm. |

---

## Deliverables checklist

- [x] n8n workflow JSON — `workflow/day7-client-onboarding.json`
- [x] Vapi agent configuration — `vapi/client-onboarding-agent.json`
- [ ] `screenshots/airtable/` — Airtable table showing **3 client records**
- [ ] `screenshots/notion/` — Notion **Client Projects** showing **3 onboarding pages** (plus one page opened to show the body content)
- [ ] `screenshots/slack/` — **#new-clients** showing **3 notifications** with HIGH / MEDIUM / LOW headlines
- [ ] `screenshots/vapi/` — the assistant config and the call log for the 3 calls
- [ ] `screenshots/n8n/` — the workflow canvas and a successful execution
- [ ] Push to GitHub

```bash
cd day7-ai-client-onboarding
git init
git add .
git commit -m "Day 7 - AI Client Onboarding System (Vapi + n8n + Airtable + Notion + Slack)"
git branch -M main
git remote add origin https://github.com/<your-username>/day7-ai-client-onboarding.git
git push -u origin main
```
