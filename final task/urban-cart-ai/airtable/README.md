# Airtable — the operational surface

## Why Airtable exists alongside PostgreSQL

This is the question the assignment asks to be answered explicitly, and it has a
real answer, not a "because both were on the list" answer.

**PostgreSQL is the system of record.** It enforces that a lead must belong to a
customer, that an order total cannot be negative, that a delivered order has a
delivery date, and that two concurrent webhooks cannot create the same customer
twice. Those guarantees are the reason the business data can be trusted. What
PostgreSQL cannot do is let Sarah in operations filter today's overdue Lahore
deliveries on her phone, tick one off, and add a note — without SQL, without a
developer, and without a ticket.

**Airtable is the working surface.** Grids, filters, grouping, kanban, comments
and a mobile app, editable by anyone. What it cannot do is enforce a foreign
key, run a transaction, or be trusted after three people have edited the same
row.

Using either one for both jobs fails in a predictable way:

- **Airtable as the system of record** — no constraints, no transactions, a
  5-requests-per-second API limit, and a schema anybody can change by accident.
  A support agent renaming a field silently breaks the automation.
- **PostgreSQL as the operational tool** — every list, filter and status change
  becomes an internal admin app that engineering has to build and maintain. That
  is weeks of work to rebuild what Airtable already does.

So the split is by **job**, not by data type:

| | PostgreSQL | Airtable |
|---|---|---|
| Role | System of record | Operational mirror |
| Written by | The application, transactionally | The application (mirror) + humans (workflow fields) |
| Guarantees | FKs, constraints, ACID | None worth relying on |
| Audience | The system | Sales, support, operations, management |
| If it goes down | Customers get the safe fallback | Staff use the admin API; nothing is lost |

## The sync is one-way, and that is deliberate

```
PostgreSQL (truth) ──write──> Airtable (working surface)
```

A lead is written to PostgreSQL **first**. Only after that transaction commits
is it mirrored to Airtable. The mirror is queued in the `integration_events`
outbox table in the same transaction as the business row, so if Airtable is down
the lead still exists and the delivery is retried — the notification can be
late, but it cannot be lost.

Fields the humans own (`Owner`, `Follow Up Date`, `Resolution`, `Action Taken`)
are never overwritten by the sync, because the sync only ever creates rows or
patches the fields it owns. Those columns are Airtable's alone.

Nothing is read back from Airtable as authoritative. If the two ever disagree,
PostgreSQL wins.

## Setup

1. Create a base called **UrbanCart Operations**.
2. Create three tables — `Leads`, `Support Issues`, `Orders` — with the fields
   in [`base-schema.json`](base-schema.json). Field names must match exactly;
   they are the API keys.
3. Create a personal access token at
   <https://airtable.com/create/tokens> with scopes `data.records:read`,
   `data.records:write` and `schema.bases:read`, granted on this base.
4. Put the token and base id in `.env`:

```bash
AIRTABLE_API_KEY=patXXXXXXXXXXXXXX.xxxxxxxx
AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
```

5. Backfill the existing PostgreSQL rows:

```bash
npm run seed:airtable
```

## Without credentials

Everything still runs. Each Airtable write is built in full and appended to
`data/outbox/airtable.jsonl` instead of being sent — the exact URL, headers and
record body that production would POST. Inspect it with:

```bash
cat data/outbox/airtable.jsonl | head -1
```

The `integration_events` row is marked `dry_run`, never `delivered`, so nothing
in the system believes a record was created when it was not.

## Rate limits

Airtable allows 5 requests/second per base. The sync script batches up to 10
records per request and paces itself; the live path writes one record per
business event, which is far below the limit at UrbanCart's volume.
