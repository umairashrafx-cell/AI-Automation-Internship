# Zapier — high-value lead distribution

## The workflow

**Trigger:** Webhooks by Zapier → *Catch Hook*
**Event:** the UrbanCart backend POSTs a `high_value_lead` payload the moment a
lead is scored as high value (budget ≥ Rs. 150,000, or composite score ≥ 70).

**Actions, in order:**

1. **Filter by Zapier** — continue only if `event` is `high_value_lead` **and**
   `signature_token` equals the shared secret. A Catch Hook URL is
   unauthenticated, so this filter is what stops anyone who learns the URL from
   injecting fake leads into the CRM.
2. **Paths by Zapier** — route on `crm_owner_hint`:
   `sales-punjab` → Ali · `sales-sindh` → Fatima · `sales-north` → Bilal ·
   `sales-unassigned` → the sales manager.
3. **CRM → Create or Update Contact** (HubSpot / Zoho / Pipedrive — whichever
   the sales team is on that quarter). Matches on `customer_phone`.
4. **CRM → Create Deal**, amount `budget_pkr`, stage *New Lead*, owner from the
   path.
5. **Gmail → Send Email** to the routed owner: *"New high-value lead: {product},
   {budget_formatted}, {location}"*.
6. **Google Calendar → Create Event** — a 15-minute "Call {customer_name}"
   follow-up task, 2 hours out, on the owner's calendar.
7. **Google Sheets → Create Row** in the *Lead Forecast* sheet the sales manager
   maintains for the monthly commission calculation.

---

## Why Zapier, and why this is not just n8n again

The assignment is explicit that the two must not do the same job. They do not.

**n8n owns the operational pipeline.** It sits inside our infrastructure, on the
customer's latency path. It can reach the private database and the internal API.
Its workflows are version-controlled JSON that engineering deploys and tests. If
n8n stops, customers stop getting answers — so it must be boring, fast and ours.

**Zapier owns the commercial long tail.** Everything in the numbered list above
is a *sales team* tool: their CRM, their inbox, their calendar, their forecast
sheet. Those tools change on the sales team's schedule, not ours, and each one
has an OAuth integration that would otherwise be ours to build, secure, and fix
whenever a vendor rotates their API.

The concrete test of whether the boundary is right:

> The sales manager decides leads should also create a task in Asana.

With this design that is a two-minute change **the sales manager makes
themselves**, in Zapier, with no engineer, no code review and no deployment.
If that step lived in n8n it would be a pull request, a test, and a release.

Three properties make this the correct side of the line:

| | n8n (ours) | Zapier (theirs) |
|---|---|---|
| On the customer's latency path | Yes — must be fast | No — fires after the customer already has their answer |
| Needs private network / database access | Yes | No — receives a self-contained payload |
| Changes when… | The product changes | The sales team's tooling changes |
| Changed by | Engineering, via git | Sales ops, in the Zapier UI |
| If it breaks | Customers are affected | A lead reaches the CRM late; PostgreSQL and Slack are unaffected |

That last row is the safety argument. Zapier is deliberately **downstream of
everything that matters**. The lead is already committed to PostgreSQL, already
mirrored to Airtable, and Slack has already notified the sales channel, before
the Zapier webhook is even attempted. A Zapier outage or a rate limit degrades
CRM enrichment — it cannot lose a lead or delay a customer.

---

## The payload

Flat and stably named, because Zapier's field mapper is far easier to use with a
flat object than with nested JSON (nested structures force users into Code
steps, which defeats the point of handing this to non-engineers).

```json
{
  "event": "high_value_lead",
  "lead_id": "LEAD-001",
  "customer_name": "Ahmed Raza",
  "customer_phone": "+923001234567",
  "customer_email": "ahmed.raza@example.com",
  "product": "iPhone 15",
  "budget_pkr": 200000,
  "budget_formatted": "Rs. 200,000",
  "location": "Lahore",
  "purchase_intent": "considering",
  "lead_source": "web_chat",
  "lead_score": 81,
  "is_existing_customer": true,
  "previous_orders": 2,
  "lifetime_value_pkr": 464997,
  "created_at": "2026-09-02T10:14:51.403Z",
  "crm_owner_hint": "sales-punjab",
  "signature_token": "<ZAPIER_SHARED_SECRET>"
}
```

A live example is written to `data/outbox/zapier.jsonl` every time a high-value
lead is created without credentials configured.

---

## Setup

1. Create a Zap. Trigger: **Webhooks by Zapier → Catch Hook**. Copy the URL.
2. Put it in `.env`, with a secret you generate:

```bash
ZAPIER_CATCH_HOOK_URL=https://hooks.zapier.com/hooks/catch/1234567/abcdefg/
ZAPIER_SHARED_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
```

3. Trigger a test event so Zapier can learn the field names:

```bash
curl -X POST http://localhost:3000/api/tools/createLead -H "Content-Type: application/json" -H "X-API-Key: $INTERNAL_API_KEY" -d '{"name":"Ahmed Raza","phone":"03001234567","product":"iPhone 15","budget":"200000","location":"Lahore","purchaseIntent":"ready_to_buy","source":"web_chat"}'
```

4. Add the Filter step (`signature_token` = your secret) **before** any action.
5. Add the Path and action steps.
6. Turn the Zap on.

## Without credentials

The payload is written to `data/outbox/zapier.jsonl` and the
`integration_events` row is marked `dry_run`. The lead itself is unaffected — it
is already in PostgreSQL, Airtable and Slack.

## Production note

A Catch Hook URL is a bearer secret in itself: anyone holding it can post to
your Zap. The `signature_token` filter is the minimum protection. If the CRM
data becomes sensitive, move this behind a Zapier Private App with proper
authentication, or replace the hook with a direct CRM integration in n8n and
accept the maintenance cost.
