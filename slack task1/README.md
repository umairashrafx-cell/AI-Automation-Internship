# Task 1 — Slack for Notifications

Deliverables for the internship task: a Slack workspace with five channels, connected to
n8n, plus notes on how Slack messaging actually works.

## Contents

| File | What's in it |
| --- | --- |
| [docs/01-workspace-and-channels.md](docs/01-workspace-and-channels.md) | Subtasks 1 & 2 — create the workspace, create the five channels, purposes and topics for each |
| [docs/02-connect-n8n.md](docs/02-connect-n8n.md) | Subtask 3 — three ways to connect Slack to n8n, scopes, credential setup, verification |
| [docs/03-slack-concepts.md](docs/03-slack-concepts.md) | Messages, threads, mentions, notifications — how they work and how they behave for bot traffic |
| [workflows/](workflows/) | Three importable n8n workflows that post to the channels |

## Completion checklist

- [ ] 1. Slack workspace created
- [ ] 2. Channels created: `#n8n-alerts`, `#client-updates`, `#internship`, `#workflow-errors`, `#project-status`
- [ ] 3. Slack app created, bot token / OAuth credential added to n8n
- [ ] 3a. Bot invited to all five channels
- [ ] 3b. Test message posted from n8n to `#n8n-alerts`
- [ ] 4. Error Trigger workflow wired to `#workflow-errors` and set as the error workflow on at least one other workflow
- [ ] 5. Notes reviewed: threads, mentions, notification settings

## Quick start (the 10-minute path)

1. Sign up at <https://slack.com/get-started> and create the workspace.
2. Create the five channels (`+` next to *Channels* → **Create a channel**).
3. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**.
4. **OAuth & Permissions** → add bot scopes `chat:write`, `chat:write.public`, `channels:read`,
   `users:read`, `reactions:write` → **Install to Workspace** → copy the `xoxb-…` token.
5. In n8n: **Credentials** → **New** → *Slack API* → paste the token.
6. Import [workflows/01-alert-to-slack.json](workflows/01-alert-to-slack.json), select the credential,
   execute. A message should land in `#n8n-alerts`.

Full detail for each step is in the docs above.

## Notes / constraints worth knowing before you start

- **Free plan keeps 90 days of message history.** Anything older is hidden, not deleted. If this
  workspace is meant to be an audit trail for workflow errors, that matters.
- **Free plan allows 10 app integrations.** One n8n app uses one slot.
- You must be a **Workspace Owner or Admin** to install an app. If someone else owns the
  workspace, your install goes into an approval queue.
- A bot can only post to a channel it has been **invited to**, unless you grant
  `chat:write.public` (public channels only — private channels always need an invite).
