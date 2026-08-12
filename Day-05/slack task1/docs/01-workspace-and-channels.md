# Subtasks 1 & 2 — Workspace and Channels

## 1. Create the workspace

1. Go to <https://slack.com/get-started> and choose **Create a Workspace**.
2. Enter your email, confirm the 6-digit code Slack emails you.
3. **Workspace name** — this is the org name shown in the sidebar. Use something like
   `Internship — Automation` rather than your own name; it appears in every invite.
4. **What's your team working on?** — this creates your first channel. Type `internship`
   here and Slack creates `#internship` for you, one of the five you need.
5. Skip the "add teammates" step for now (you can invite later from
   **Workspace name → Invite people to <workspace>**).
6. Slack lands you in the workspace with `#general`, `#random`, and whatever you named in step 4.

Your workspace URL will be `https://<something>.slack.com`. Note it down — n8n doesn't need it,
but you will when you switch between workspaces.

### Roles, briefly

| Role | Can do |
| --- | --- |
| **Owner (Primary)** | Everything, including deleting the workspace. You, as creator. |
| **Admin** | Manage members, channels, app approvals. |
| **Member** | Post, create channels, install apps *if* the owner allows it. |
| **Guest** (paid) | Restricted to specific channels. |

App installation is the one that bites people: **Settings & administration → Workspace settings
→ Permissions → Apps** controls whether non-admins can install apps. As the owner you're fine.

## 2. Create the five channels

For each channel: click the **+** next to *Channels* in the sidebar (or **Channels → Create**)
→ **Create a channel** → enter the name → **Create** → choose **Public**.

Slack normalises names: lowercase, no spaces, hyphens instead. Max 80 characters.

Create these five:

| Channel | Visibility | Purpose (paste into the channel's Description) | Topic |
| --- | --- | --- | --- |
| `#n8n-alerts` | Public | Automated, non-urgent notifications from n8n workflows — successful runs, scheduled reports, data-sync summaries. | Routine automation output |
| `#client-updates` | Public | Client-facing status: deliveries, milestones, approvals, anything a client asked to be notified about. | What clients are told, and when |
| `#internship` | Public | General internship coordination — tasks, questions, standups, learning notes. | Internship HQ |
| `#workflow-errors` | Public | Failures only. n8n Error Trigger posts here. Every message here should be actionable. | 🚨 Failures need a human |
| `#project-status` | Public | Daily/weekly rollups of project progress. Scheduled, not event-driven. | Periodic progress digest |

To set the description and topic after creating: click the channel name at the top →
**About** tab → **Edit** next to *Topic* / *Description*.

### Public vs. private — why all five are public here

- **Public (`#`)** — any workspace member can find, join, and read history. Searchable by everyone.
- **Private (`🔒`)** — invite-only, invisible in the channel browser, excluded from other people's
  search. **You cannot convert private back to public**, only public → private.

Keep all five public. A bot with `chat:write.public` can post to any public channel without being
invited; private channels *always* require `/invite @yourbot`. Making these private now creates
work for you later for no benefit in a practice workspace.

### Separating the two error-ish channels

`#n8n-alerts` and `#workflow-errors` will blur together unless you enforce a rule. The one that
works:

> **`#workflow-errors` is for things that need a human. `#n8n-alerts` is for things that don't.**

That distinction is what lets you set `#workflow-errors` to *All new messages* notifications and
`#n8n-alerts` to *Mentions only* — see [03-slack-concepts.md](03-slack-concepts.md#notifications).

## Verification

- All five channels appear in the sidebar.
- **Channels → Browse channels** lists them as public.
- Each has a description filled in.
