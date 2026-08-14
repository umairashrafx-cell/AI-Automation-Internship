#!/usr/bin/env python3
"""Builds the n8n workflow JSON for the Day 7 AI Client Onboarding System."""
import json

EXTRACT_JS = r"""
// ============================================================
// STEP 1 - NORMALISE THE INCOMING VAPI PAYLOAD
// ------------------------------------------------------------
// Vapi can hit this webhook in three shapes, plus we want to be
// able to test with a plain flat JSON body from Postman / curl.
//   A) Tool call    -> body.message.toolCalls[0].function.arguments
//   B) Older format -> body.message.toolCallList[0].function.arguments
//   C) End of call  -> body.message.analysis.structuredData
//   D) Flat test    -> body.client_name, body.budget, ...
// This node flattens all of them into one clean object.
// ============================================================

const body = $input.first().json.body || $input.first().json;
const msg  = body.message || {};

let args = {};
let toolCallId = null;

// A) modern Vapi tool-call format
const toolCalls = msg.toolCalls || msg.toolCallList || msg.tool_calls || [];
if (Array.isArray(toolCalls) && toolCalls.length > 0) {
  const call = toolCalls[0];
  toolCallId = call.id || call.toolCallId || null;
  const fn = call.function || {};
  args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments || {});
}

// C) end-of-call-report structured data
if (Object.keys(args).length === 0 && msg.analysis && msg.analysis.structuredData) {
  args = msg.analysis.structuredData;
}

// D) flat body (manual testing)
if (Object.keys(args).length === 0) {
  args = body;
}

// ---- clean each field -------------------------------------
const str = (v, fallback = 'NOT PROVIDED') => {
  if (v === null || v === undefined) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
};

// Budget can arrive as 500000, "500,000", "PKR 500000", "5 lakh", "500k"
function parseBudget(raw) {
  if (typeof raw === 'number' && isFinite(raw)) return Math.round(raw);
  let s = String(raw || '').toLowerCase().trim();
  if (!s) return 0;

  const lakh    = /(\d+(?:\.\d+)?)\s*(lakh|lac|lakhs)/.exec(s);
  const crore   = /(\d+(?:\.\d+)?)\s*(crore|cr)\b/.exec(s);
  const million = /(\d+(?:\.\d+)?)\s*(m|million)\b/.exec(s);
  const kilo    = /(\d+(?:\.\d+)?)\s*k\b/.exec(s);

  if (crore)   return Math.round(parseFloat(crore[1])   * 10000000);
  if (lakh)    return Math.round(parseFloat(lakh[1])    * 100000);
  if (million) return Math.round(parseFloat(million[1]) * 1000000);
  if (kilo)    return Math.round(parseFloat(kilo[1])    * 1000);

  const digits = s.replace(/[^0-9.]/g, '');
  const n = parseFloat(digits);
  return isFinite(n) ? Math.round(n) : 0;
}

const clean = {
  client_name:         str(args.client_name || args.clientName || args.name),
  company_name:        str(args.company_name || args.companyName || args.company),
  email:               str(args.email).toLowerCase().replace(/\s+/g, ''),
  service_required:    str(args.service_required || args.serviceRequired || args.service),
  project_description: str(args.project_description || args.projectDescription || args.description),
  budget:              parseBudget(args.budget),
  tool_call_id:        toolCallId,
  call_id:             msg.call ? (msg.call.id || null) : (body.call_id || null),
  received_at:         new Date().toISOString(),
};

return [{ json: clean }];
"""

PARSE_JS = r"""
// ============================================================
// STEP 3 - PARSE THE AI OUTPUT + ENFORCE THE PRIORITY RULE
// ------------------------------------------------------------
// The LLM writes the category / summary / next action.
// The PRIORITY, however, is a hard business rule, so we compute
// it in code. The AI never gets to override it. This is what
// makes the three required test calls pass deterministically:
//   budget >= 500000            -> HIGH
//   budget 200000 .. 499999     -> MEDIUM
//   budget <  200000            -> LOW
// ============================================================

const intake = $('Normalize Vapi Payload').first().json;

// ---- 1. pull the model's raw text -------------------------
const aiItem = $input.first().json;
let raw = aiItem.text || aiItem.output || aiItem.response || aiItem.content || '';
if (typeof raw === 'object') raw = JSON.stringify(raw);

// ---- 2. parse it, tolerating markdown fences --------------
let ai = {};
try {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end   = candidate.lastIndexOf('}');
  ai = JSON.parse(start !== -1 ? candidate.slice(start, end + 1) : candidate);
} catch (e) {
  // Never let a malformed LLM response kill the onboarding.
  ai = {};
}

// ---- 3. deterministic priority ----------------------------
const budget = Number(intake.budget) || 0;
let priority = 'LOW';
if (budget >= 500000)      priority = 'HIGH';
else if (budget >= 200000) priority = 'MEDIUM';

// ---- 4. priority-driven Slack presentation ----------------
const PRESET = {
  HIGH:   { headline: 'HIGH PRIORITY CLIENT',   emoji: ':rotating_light:', color: '#E01E5A', sla: 'Contact within 2 hours' },
  MEDIUM: { headline: 'MEDIUM PRIORITY CLIENT', emoji: ':large_orange_diamond:', color: '#ECB22E', sla: 'Contact within 24 hours' },
  LOW:    { headline: 'STANDARD CLIENT',        emoji: ':white_check_mark:', color: '#2EB67D', sla: 'Contact within 3 business days' },
}[priority];

const fmtPKR = 'PKR ' + budget.toLocaleString('en-US');

return [{
  json: {
    // intake fields
    client_name:         intake.client_name,
    company_name:        intake.company_name,
    email:               intake.email,
    service_required:    intake.service_required,
    project_description: intake.project_description,
    budget:              budget,
    budget_formatted:    fmtPKR,
    tool_call_id:        intake.tool_call_id,
    call_id:             intake.call_id,

    // AI fields
    service_category: ai.service_category || intake.service_required,
    summary:          ai.summary || intake.project_description,
    next_action:      ai.next_action || 'Schedule discovery call',

    // business rule
    priority:         priority,
    status:           'New',
    created_at:       new Date().toISOString(),

    // slack presentation
    slack_headline: PRESET.headline,
    slack_emoji:    PRESET.emoji,
    slack_color:    PRESET.color,
    slack_sla:      PRESET.sla,
  }
}];
"""

NOTIFY_JS = r"""
// ============================================================
// STEP 6 - REBUILD THE CONTEXT FOR THE SLACK BRANCH
// ------------------------------------------------------------
// Airtable and Notion each return their OWN API response, so by
// this point $json is a Notion block object, not our client.
// We reach back to the classifier node and also carry the two
// record IDs so the Slack message can confirm both were written.
// ============================================================

const c = $('Classify with AI').first().json;

let airtable_id = null;
let notion_url  = null;
try { airtable_id = $('Airtable - Create Client Record').first().json.id || null; } catch (e) {}
try {
  const n = $('Notion - Create Onboarding Page').first().json;
  notion_url = n.url || n.id || null;
} catch (e) {}

return [{ json: { ...c, airtable_id, notion_url } }];
"""

RESPOND_JS = r"""
// ============================================================
// STEP 8 - REPLY TO VAPI
// ------------------------------------------------------------
// Vapi expects { results: [ { toolCallId, result } ] } so the
// voice agent can speak a confirmation back to the caller.
// ============================================================

const c = $('Prepare Notification').first().json;

const spoken = 'Thanks ' + c.client_name + ', I have logged ' + c.company_name +
  ' for ' + c.service_category + '. Our team has been notified and will ' +
  c.next_action.toLowerCase() + '.';

return [{
  json: {
    results: [{ toolCallId: c.tool_call_id || 'manual-test', result: spoken }],
    // extra debug info, harmless to Vapi
    meta: {
      priority: c.priority,
      airtable_id: c.airtable_id,
      notion_url: c.notion_url,
    }
  }
}];
"""

AI_PROMPT = """You are a lead qualification analyst for a digital services agency in Pakistan. You classify inbound client enquiries captured by a voice agent.

Return ONLY a raw JSON object. No prose, no explanation, no markdown code fences.

The JSON must have exactly these four keys:
{
  "service_category": "<one of: Web Development | Mobile App Development | Web & Mobile Development | E-Commerce | AI & Automation | Branding & Design | Digital Marketing | Other>",
  "priority": "<HIGH | MEDIUM | LOW>",
  "summary": "<one clear sentence, max 25 words, describing what this client needs>",
  "next_action": "<a short concrete next step for the sales team, max 8 words>"
}

Priority rules (budget is in PKR):
- budget >= 500000            -> HIGH
- budget 200000 to 499999     -> MEDIUM
- budget < 200000             -> LOW

--- CLIENT ENQUIRY ---
Client name: {{ $json.client_name }}
Company: {{ $json.company_name }}
Email: {{ $json.email }}
Service required: {{ $json.service_required }}
Project description: {{ $json.project_description }}
Budget (PKR): {{ $json.budget }}
--- END ---

JSON:"""

NOTION_BODY = (
    "=Client: {{ $json.client_name }}\n"
    "Company: {{ $json.company_name }}\n"
    "Email: {{ $json.email }}\n"
    "Service: {{ $json.service_category }}\n"
    "Budget: {{ $json.budget_formatted }}\n"
    "Priority: {{ $json.priority }}\n"
    "Summary: {{ $json.summary }}\n"
    "Next Action: {{ $json.next_action }}\n"
    "Status: New"
)


def slack_text(level):
    return (
        "=:mega: *NEW CLIENT* {{ $json.slack_emoji }} *{{ $json.slack_headline }}*\n"
        "\n"
        "*{{ $json.client_name }} - {{ $json.company_name }}*\n"
        "\n"
        "> *Service:* {{ $json.service_category }}\n"
        "> *Budget:* {{ $json.budget_formatted }}\n"
        "> *Priority:* {{ $json.priority }}\n"
        "> *Email:* {{ $json.email }}\n"
        "\n"
        "*AI Summary:* {{ $json.summary }}\n"
        "*Next Action:* {{ $json.next_action }}\n"
        "*SLA:* {{ $json.slack_sla }}\n"
        "\n"
        ":white_check_mark: Airtable + Notion records created successfully."
        + ("\n\n<!channel> This is a high value lead - please pick it up now."
           if level == "HIGH" else "")
    )


def node(name, ntype, tv, pos, params, **extra):
    n = {
        "parameters": params,
        "id": name.lower().replace(" ", "-").replace("&", "and")
                  .replace("(", "").replace(")", "").replace("-", "-"),
        "name": name,
        "type": ntype,
        "typeVersion": tv,
        "position": pos,
    }
    n.update(extra)
    return n


nodes = []

nodes.append(node(
    "Vapi Webhook", "n8n-nodes-base.webhook", 2, [-620, 300],
    {
        "httpMethod": "POST",
        "path": "vapi-client-intake",
        "responseMode": "responseNode",
        "options": {},
    },
    webhookId="a1b2c3d4-day7-client-intake",
))

nodes.append(node(
    "Normalize Vapi Payload", "n8n-nodes-base.code", 2, [-400, 300],
    {"jsCode": EXTRACT_JS.strip()},
))

nodes.append(node(
    "OpenAI Chat Model", "@n8n/n8n-nodes-langchain.lmChatOpenAi", 1.2, [-140, 500],
    {
        "model": {"__rl": True, "mode": "list", "value": "gpt-4o-mini"},
        "options": {"temperature": 0.2},
    },
    credentials={"openAiApi": {"id": "REPLACE_OPENAI_CRED_ID", "name": "OpenAI account"}},
))

nodes.append(node(
    "Classify Enquiry (AI)", "@n8n/n8n-nodes-langchain.chainLlm", 1.5, [-180, 300],
    {
        "promptType": "define",
        "text": "=" + AI_PROMPT,
        "messages": {},
    },
))

nodes.append(node(
    "Classify with AI", "n8n-nodes-base.code", 2, [80, 300],
    {"jsCode": PARSE_JS.strip()},
))

nodes.append(node(
    "Airtable - Create Client Record", "n8n-nodes-base.airtable", 2.1, [320, 300],
    {
        "operation": "create",
        "base": {"__rl": True, "mode": "list", "value": "REPLACE_AIRTABLE_BASE_ID",
                 "cachedResultName": "AI Client Onboarding"},
        "table": {"__rl": True, "mode": "list", "value": "REPLACE_AIRTABLE_TABLE_ID",
                  "cachedResultName": "Client Onboarding"},
        "columns": {
            "mappingMode": "defineBelow",
            "value": {
                "Client Name": "={{ $json.client_name }}",
                "Company": "={{ $json.company_name }}",
                "Email": "={{ $json.email }}",
                "Service": "={{ $json.service_required }}",
                "Description": "={{ $json.project_description }}",
                "Budget": "={{ $json.budget }}",
                "Category": "={{ $json.service_category }}",
                "Priority": "={{ $json.priority }}",
                "Summary": "={{ $json.summary }}",
                "Status": "New",
                "Created At": "={{ $json.created_at }}",
            },
            "matchingColumns": [],
            "schema": [],
        },
        "options": {"typecast": True},
    },
    credentials={"airtableTokenApi": {"id": "REPLACE_AIRTABLE_CRED_ID", "name": "Airtable Personal Access Token"}},
))

nodes.append(node(
    "Notion - Create Onboarding Page", "n8n-nodes-base.notion", 2.2, [560, 300],
    {
        "resource": "databasePage",
        "databaseId": {"__rl": True, "mode": "list", "value": "REPLACE_NOTION_DATABASE_ID",
                       "cachedResultName": "Client Projects"},
        "title": "={{ $('Classify with AI').item.json.company_name }}",
        "propertiesUi": {
            "propertyValues": [
                {"key": "Client|rich_text", "textContent": "={{ $('Classify with AI').item.json.client_name }}"},
                {"key": "Email|email", "emailValue": "={{ $('Classify with AI').item.json.email }}"},
                {"key": "Service|rich_text", "textContent": "={{ $('Classify with AI').item.json.service_category }}"},
                {"key": "Budget|number", "numberValue": "={{ $('Classify with AI').item.json.budget }}"},
                {"key": "Priority|select", "selectValue": "={{ $('Classify with AI').item.json.priority }}"},
                {"key": "Status|select", "selectValue": "New"},
                {"key": "Next Action|rich_text", "textContent": "={{ $('Classify with AI').item.json.next_action }}"},
                {"key": "Created At|date", "date": "={{ $('Classify with AI').item.json.created_at }}"},
            ]
        },
        "options": {},
    },
    credentials={"notionApi": {"id": "REPLACE_NOTION_CRED_ID", "name": "Notion account"}},
))

nodes.append(node(
    "Notion - Append Page Content", "n8n-nodes-base.notion", 2.2, [800, 300],
    {
        "resource": "block",
        "blockId": {"__rl": True, "mode": "id", "value": "={{ $json.id }}"},
        "blockUi": {
            "blockValues": [
                {"type": "heading_2", "textContent": "=Onboarding Details"},
                {"type": "paragraph", "textContent": NOTION_BODY},
                {"type": "to_do", "textContent": "=Send welcome email to {{ $('Classify with AI').item.json.email }}"},
                {"type": "to_do", "textContent": "={{ $('Classify with AI').item.json.next_action }}"},
                {"type": "to_do", "textContent": "=Prepare proposal and quotation"},
            ]
        },
    },
    credentials={"notionApi": {"id": "REPLACE_NOTION_CRED_ID", "name": "Notion account"}},
))

nodes.append(node(
    "Prepare Notification", "n8n-nodes-base.code", 2, [1040, 300],
    {"jsCode": NOTIFY_JS.strip()},
))

nodes.append(node(
    "Route by Priority", "n8n-nodes-base.switch", 3.2, [1260, 300],
    {
        "rules": {
            "values": [
                {
                    "conditions": {
                        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                        "conditions": [{
                            "id": "cond-high",
                            "leftValue": "={{ $json.priority }}",
                            "rightValue": "HIGH",
                            "operator": {"type": "string", "operation": "equals"},
                        }],
                        "combinator": "and",
                    },
                    "renameOutput": True,
                    "outputKey": "HIGH",
                },
                {
                    "conditions": {
                        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                        "conditions": [{
                            "id": "cond-medium",
                            "leftValue": "={{ $json.priority }}",
                            "rightValue": "MEDIUM",
                            "operator": {"type": "string", "operation": "equals"},
                        }],
                        "combinator": "and",
                    },
                    "renameOutput": True,
                    "outputKey": "MEDIUM",
                },
                {
                    "conditions": {
                        "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
                        "conditions": [{
                            "id": "cond-low",
                            "leftValue": "={{ $json.priority }}",
                            "rightValue": "LOW",
                            "operator": {"type": "string", "operation": "equals"},
                        }],
                        "combinator": "and",
                    },
                    "renameOutput": True,
                    "outputKey": "LOW",
                },
            ]
        },
        "options": {"fallbackOutput": "extra", "renameFallbackOutput": "UNKNOWN"},
    },
))

for i, (lvl, y) in enumerate([("HIGH", 100), ("MEDIUM", 300), ("LOW", 500)]):
    nodes.append(node(
        f"Slack - {lvl} Priority Alert", "n8n-nodes-base.slack", 2.2, [1520, y],
        {
            "select": "channel",
            "channelId": {"__rl": True, "mode": "name", "value": "#new-clients"},
            "text": slack_text(lvl),
            "otherOptions": {"includeLinkToWorkflow": False, "mrkdwn": True},
        },
        credentials={"slackApi": {"id": "REPLACE_SLACK_CRED_ID", "name": "Slack account"}},
        webhookId=f"slack-{lvl.lower()}",
    ))

nodes.append(node(
    "Slack - Unclassified Fallback", "n8n-nodes-base.slack", 2.2, [1520, 700],
    {
        "select": "channel",
        "channelId": {"__rl": True, "mode": "name", "value": "#new-clients"},
        "text": "=:warning: A client enquiry came in that could not be prioritised. Client: {{ $json.client_name }} ({{ $json.company_name }}), budget {{ $json.budget_formatted }}. Please review manually.",
        "otherOptions": {"includeLinkToWorkflow": False, "mrkdwn": True},
    },
    credentials={"slackApi": {"id": "REPLACE_SLACK_CRED_ID", "name": "Slack account"}},
    webhookId="slack-fallback",
))

nodes.append(node(
    "Build Vapi Response", "n8n-nodes-base.code", 2, [1780, 300],
    {"jsCode": RESPOND_JS.strip()},
))

nodes.append(node(
    "Respond to Vapi", "n8n-nodes-base.respondToWebhook", 1.1, [2000, 300],
    {"respondWith": "json", "responseBody": "={{ JSON.stringify($json) }}", "options": {}},
))

# sticky notes for readability in the canvas
STICKIES = [
    ("## 1. Voice intake\nVapi calls this webhook with the six fields the\n**Client Onboarding Agent** collected.\nThe Code node flattens every Vapi payload shape\n(tool call, end-of-call report, or flat test JSON).",
     [-660, 60], 500, 200, 4),
    ("## 2. AI processing\nThe LLM writes the service category, summary and\nnext action. The **priority is computed in code**\nfrom the budget so the three required test calls\nare 100% deterministic.",
     [-200, 60], 480, 200, 5),
    ("## 3. Fan out\nAirtable = system of record.\nNotion = the onboarding page + checklist.\nSlack = priority-based team alert.",
     [300, 60], 700, 200, 3),
    ("## 4. Priority-based alerts\nHIGH -> HIGH PRIORITY CLIENT (+ @channel)\nMEDIUM -> MEDIUM PRIORITY CLIENT\nLOW -> STANDARD CLIENT",
     [1240, 780], 420, 180, 6),
]
for i, (content, pos, w, h, color) in enumerate(STICKIES):
    nodes.append({
        "parameters": {"content": content, "height": h, "width": w, "color": color},
        "id": f"sticky-{i}",
        "name": f"Sticky Note {i}",
        "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1,
        "position": pos,
    })


def main_conn(target):
    return {"main": [[{"node": target, "type": "main", "index": 0}]]}


connections = {
    "Vapi Webhook": main_conn("Normalize Vapi Payload"),
    "Normalize Vapi Payload": main_conn("Classify Enquiry (AI)"),
    "OpenAI Chat Model": {"ai_languageModel": [[{"node": "Classify Enquiry (AI)", "type": "ai_languageModel", "index": 0}]]},
    "Classify Enquiry (AI)": main_conn("Classify with AI"),
    "Classify with AI": main_conn("Airtable - Create Client Record"),
    "Airtable - Create Client Record": main_conn("Notion - Create Onboarding Page"),
    "Notion - Create Onboarding Page": main_conn("Notion - Append Page Content"),
    "Notion - Append Page Content": main_conn("Prepare Notification"),
    "Prepare Notification": main_conn("Route by Priority"),
    "Route by Priority": {
        "main": [
            [{"node": "Slack - HIGH Priority Alert", "type": "main", "index": 0}],
            [{"node": "Slack - MEDIUM Priority Alert", "type": "main", "index": 0}],
            [{"node": "Slack - LOW Priority Alert", "type": "main", "index": 0}],
            [{"node": "Slack - Unclassified Fallback", "type": "main", "index": 0}],
        ]
    },
    "Slack - HIGH Priority Alert": main_conn("Build Vapi Response"),
    "Slack - MEDIUM Priority Alert": main_conn("Build Vapi Response"),
    "Slack - LOW Priority Alert": main_conn("Build Vapi Response"),
    "Slack - Unclassified Fallback": main_conn("Build Vapi Response"),
    "Build Vapi Response": main_conn("Respond to Vapi"),
}

workflow = {
    "name": "Day 7 - AI Client Onboarding System",
    "nodes": nodes,
    "connections": connections,
    "active": False,
    "pinData": {},
    "settings": {"executionOrder": "v1", "saveManualExecutions": True},
    "versionId": "day7-v1",
    "meta": {"instanceId": "day7-ai-client-onboarding"},
    "tags": [],
}

with open("workflow/day7-client-onboarding.json", "w") as f:
    json.dump(workflow, f, indent=2)

print(f"OK - {len(nodes)} nodes, {len(connections)} connection groups")
