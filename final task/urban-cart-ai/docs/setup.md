# Setup and operations

## Requirements

- **Node.js 22.6 or newer** (24 recommended). The project runs TypeScript
  directly via Node's native type stripping — there is no build step.
- Nothing else. No Docker, no database server, no API keys.

## Quick start

```bash
cd urban-cart-ai
npm install
cp .env.example .env
npm run demo:setup
npm start
```

Open <http://localhost:3000>.

`demo:setup` resets the embedded database, applies both schemas, seeds the demo
data, generates the knowledge-base documents and builds the RAG index. It takes
about 20 seconds.

Check everything at any time:

```bash
npm run verify
```

## Why it runs with no credentials

| Component | Without credentials | With credentials |
|---|---|---|
| Database | Embedded **PGlite** — a real PostgreSQL 18 build with pgvector, in-process | External PostgreSQL via `DATABASE_URL` |
| Vector store | pgvector in the same instance | Supabase |
| Embeddings | Deterministic hashed bag-of-words (real vector maths, **lexical only**) | OpenAI `text-embedding-3-small` |
| Answers | Extractive — composed verbatim from retrieved passages, cannot hallucinate | Claude / GPT |
| Slack, Airtable, Notion, Zapier | **Dry run** — the exact request is written to `data/outbox/<service>.jsonl` | Sent |
| Google Drive | Local `knowledge-base/` folder, same pipeline | Drive folder |
| Vapi | Webhook payload tests | Live calls |

Dry run never fabricates a successful response. Callers receive
`{ delivered: false, dryRun: true }`, and the `integration_events` row is marked
`dry_run`, never `delivered`. `/health` reports `degraded`, not `ok`.

---

## npm scripts

| Script | Does |
|---|---|
| `npm start` | Run the server |
| `npm run dev` | Run with `--watch` |
| `npm run verify` | Setup check: what is live, degraded, dry-run |
| `npm run demo:setup` | Reset + seed + generate documents + index |
| `npm run db:reset` | Drop and rebuild the embedded database |
| `npm run db:seed` | Apply `database/seed.sql` |
| `npm run kb:generate` | Write the PDF/DOCX/XLSX knowledge base |
| `npm run rag:ingest` | Ingest changed documents |
| `npm run rag:reindex` | Re-embed everything (after changing provider) |
| `npm run drive:sync` | Ingest from Google Drive |
| `npm run seed:airtable` | Backfill Airtable from PostgreSQL |
| `npm run notion:publish` | Publish the handbook to Notion |
| `npm run n8n:generate` | Regenerate the workflow JSON |
| `npm test` | Full test suite |
| `npm run typecheck` | `tsc --noEmit` |

---

## Configuring the integrations

Each is independent — configure only what you need.

### PostgreSQL (production)

```bash
createdb urbancart
psql -d urbancart -f database/schema.sql
psql -d urbancart -f database/seed.sql
```
```bash
DB_DRIVER=postgres
DATABASE_URL=postgresql://user:password@host:5432/urbancart
```

> The password is yours to set in `.env`. It is never read from, or written to,
> anywhere else in the project.

### Supabase (vectors)

1. Create a project at <https://supabase.com>.
2. SQL Editor → paste and run `database/supabase-schema.sql`. This creates
   `documents`, `document_chunks`, the `match_document_chunks` function, the
   HNSW index and the RLS policies.
3. Settings → API → copy the URL and the **service role** key.

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
VECTOR_STORE=supabase
```
```bash
npm run rag:reindex   # vectors from a different provider are not comparable
```

> The service-role key bypasses RLS and must never reach a browser.

### OpenAI (embeddings)

```bash
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```
```bash
npm run rag:reindex
```

### Anthropic (answers)

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5
```

### Slack

1. <https://api.slack.com/apps> → Create New App → From scratch.
2. OAuth & Permissions → Bot Token Scopes → `chat:write`.
3. Install to Workspace, copy the Bot User OAuth Token (`xoxb-…`).
4. Create `#urbancart-sales`, `#urbancart-support`, `#urbancart-alerts` and
   invite the bot to each.

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_SALES=#urbancart-sales
SLACK_CHANNEL_SUPPORT=#urbancart-support
SLACK_CHANNEL_ALERTS=#urbancart-alerts
```

### Airtable, Zapier, Notion, Google Drive, Vapi

See [`../airtable/README.md`](../airtable/README.md),
[`../zapier/README.md`](../zapier/README.md),
[`rag.md`](rag.md) (Drive) and [`../vapi/README.md`](../vapi/README.md).

### n8n

```bash
npx n8n
```
Import each file from `n8n/workflows/`, then set these n8n environment
variables:

```bash
URBANCART_API_URL=http://localhost:3000
URBANCART_API_KEY=<INTERNAL_API_KEY>
URBANCART_WEBHOOK_SIGNATURE=<HMAC of the body, see docs/api.md>
GOOGLE_DRIVE_FOLDER_ID=<folder id>
SLACK_CHANNEL_ALERTS=#urbancart-alerts
```

In every workflow: **Settings → Error Workflow → “UrbanCart 7 – Centralised
Error Handling”.**

---

## Security checklist before production

- [ ] `INTERNAL_API_KEY` and `WEBHOOK_SIGNING_SECRET` set (the server refuses to
      start in production without them)
- [ ] `DB_DRIVER=postgres` — PGlite is single-process and rejected in production
- [ ] `EMBEDDING_PROVIDER=openai` — the local provider is rejected in production
- [ ] `NODE_ENV=production`
- [ ] `CORS_ALLOWED_ORIGINS` restricted to your real domains
- [ ] `.env` not committed (it is git-ignored)
- [ ] Supabase RLS verified with the anon key
- [ ] Slack bot limited to `chat:write`; Drive scope read-only; Airtable token
      scoped to one base
- [ ] HTTPS terminated in front of the service

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Troubleshooting

**`Aborted(). Build with -sASSERTIONS`** — the embedded PGlite data directory is
corrupt. This happens if the server was killed (`SIGKILL`, Task Manager) rather
than stopped with Ctrl+C; PGlite is single-process and needs a clean shutdown.

```bash
npm run db:reset && npm run rag:ingest
```

**The assistant escalates everything** — the knowledge base is probably empty:

```bash
npm run verify        # look at the "Knowledge base" section
npm run kb:generate && npm run rag:ingest
```

**Retrieval quality is poor** — expected with `EMBEDDING_PROVIDER=local`, which
matches shared vocabulary rather than meaning. Set `OPENAI_API_KEY` and run
`npm run rag:reindex`.

**Nothing arrives in Slack** — check `/api/admin/readiness`. If `slack: false`,
it is in dry run; read `data/outbox/slack.jsonl` to see exactly what would have
been sent. If `true`, check `/api/admin/integrations` for the delivery error —
`channel_not_found` usually means the bot was not invited to the channel.

**`LOG_LEVEL must be one of…`** — an inline comment in `.env` was included in the
value. The loader strips ` # comment` from unquoted values; quote the value if
it legitimately contains a `#`.

**Port 3000 in use**
```bash
PORT=3001 npm start
```

**Reset everything**
```bash
rm -rf data/ && npm run demo:setup
```

---

## Monitoring in production

| Signal | Where | Act when |
|---|---|---|
| Service health | `GET /health` | `status` is not `ok` |
| Failed workflows | `GET /api/admin/executions` | Any new entry |
| Undelivered integrations | `GET /api/admin/integrations` | `status = failed` with `attempts >= 3` |
| Escalation rate | `GET /api/admin/overview` | Rising — usually a knowledge gap, not a bug |
| Knowledge freshness | `GET /api/knowledge/documents` | `updated_at` older than the document in Drive |

**The escalation rate is the health metric that matters.** A rise means the
documents no longer cover what customers are asking. The fix is to write the
missing document, not to lower the confidence threshold.
