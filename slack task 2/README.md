# Workflow 1 — Task Creation (Notion → n8n → Slack)

When a new task is added to a Notion database, n8n picks it up and posts a formatted
notification to a Slack channel.

```
Notion Trigger  →  Format Task  →  Has Title?  →  Slack Notification
(page added)       (Code node)      (IF)      └→  Skip (no title)
```

Import `workflow-1-task-creation.json` into n8n via **Workflows → ⋯ → Import from File**.

## What each node does

| Node | Purpose |
| --- | --- |
| **Notion Trigger** | Polls the database once a minute for pages added since the last check. |
| **Format Task** | Flattens the raw Notion page into plain fields and builds the Slack Block Kit payload. |
| **Has Title?** | Drops the empty rows Notion creates when someone clicks **+ New** and walks away. |
| **Slack Notification** | Posts the blocks to your channel. |
| **Skip (no title)** | Dead end for filtered rows, so the execution log shows why nothing was sent. |

## Setup

### 1. Notion

Notion now calls these **connections** rather than "integrations", and the old
`my-integrations` page redirects to the developer portal.

1. Go to <https://app.notion.com/developers/connections> → **Internal connections** in the
   sidebar → **Create a new connection**. Name it something like `n8n Task Sync`.
2. On the **Configuration** tab, enable these capabilities:
   - **Read content** — required, or the trigger sees nothing.
   - **Read user information (without email addresses)** — required for the *Assignee*
     field. Without it, Notion returns person objects with no names and Slack messages
     show no assignee.
3. Still on **Configuration**, copy the **Installation access token**. Newer tokens start
   with `ntn_`; older ones start with `secret_`. Both work. It is shown once — save it now.
4. Grant access to the database, or the trigger returns nothing with no error:
   - **Content access** tab → **Edit access** → select your task database, **or**
   - in Notion, open the database → **•••** (top right) → **Connections** →
     **+ Add connection** → pick your connection → confirm.
5. Copy the database ID from the URL — the 32-character string between the workspace slug and the `?`:
   `notion.so/workspace/`**`8f4a1c2d3e4f5061728394a5b6c7d8e9`**`?v=…`
   If the database is inline on a page, open it as a full page first (**⋯ → Open as full page**),
   otherwise the URL gives you the parent page ID and the trigger will not find it.
6. In n8n: **Credentials → New → Notion API**, paste the token into **Internal Integration Secret**.

On Business and Enterprise workspaces, connection creation may be restricted — a workspace
owner approves it under **Settings → Connections**.

### 2. Slack

1. Create an app at <https://api.slack.com/apps> → **OAuth & Permissions**.
2. Add these bot token scopes: `chat:write`, `chat:write.public`, `channels:read`, `groups:read`.
3. Install to workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
4. Invite the bot to the destination channel: `/invite @YourBotName`.
   Without this, posting to a private channel fails with `not_in_channel`.
5. In n8n: **Credentials → New → Slack API**, paste the bot token.

### 3. Fill in the placeholders

The exported JSON ships with four placeholders. Easiest path is to open each node in the
editor and pick the values from the dropdowns, which fills the credential IDs for you.

| Placeholder | Node | Where to find it |
| --- | --- | --- |
| `REPLACE_WITH_NOTION_DATABASE_ID` | Notion Trigger | Step 1.3 above |
| `REPLACE_WITH_NOTION_CREDENTIAL_ID` | Notion Trigger | Select the credential in the dropdown |
| `REPLACE_WITH_SLACK_CHANNEL_ID` | Slack Notification | Pick **From list**, or use the `C…` ID from the channel's Slack URL |
| `REPLACE_WITH_SLACK_CREDENTIAL_ID` | Slack Notification | Select the credential in the dropdown |

### 4. Test

Use **Fetch Test Event** on the trigger to pull a recent page without waiting for a poll,
then **Execute Workflow**. Once the message looks right, toggle the workflow **Active** —
polling triggers only run on the schedule when the workflow is active.

## Which Notion columns get used

Column names are matched case-insensitively, and the title column is found by type, so it
can be called anything (`Name`, `Task name`, `Title`). Any column that is missing is simply
left out of the Slack message.

| Slack field | Notion column names accepted | Column types |
| --- | --- | --- |
| Title | *(any title column)* | Title |
| Status | `Status`, `State` | Select, Status |
| Priority | `Priority`, `Urgency` | Select, Status |
| Assignee | `Assignee`, `Owner`, `Assigned to` | Person |
| Due | `Due Date`, `Due`, `Deadline` | Date |
| Project | `Project`, `Epic` | Select, Multi-select |
| Tags | `Tags`, `Labels` | Multi-select |
| Body text | `Notes`, `Description`, `Summary` | Rich text |

To support a differently-named column, add it to the relevant `pick(props, …)` call in the
**Format Task** node.

Priority drives the header emoji: `urgent` 🚨, `high` 🔴, `medium` 🟡, `low` 🔵, anything
else 📝.

## Things worth knowing

- **The trigger polls, it does not push.** Notion has no webhook for "page added to
  database" that n8n subscribes to here, so expect up to a minute of delay. Change the
  cadence under **Poll Times** on the trigger.
- **Only tasks created after activation fire.** The trigger records a timestamp when it
  becomes active and ignores anything older. Backfilling old tasks needs a separate
  one-off run using a Notion node with a filter.
- **Deleting a row does not un-send the Slack message.** This workflow is one-directional.
- **Rate limits.** Notion allows roughly 3 requests/second and Slack about 1 message per
  second per channel. A bulk paste of 50 rows into Notion will emit 50 messages; if that is
  a concern, add a **Loop Over Items** node with a small batch interval before the Slack node.
- **Sending plain text instead of blocks.** In the Slack node set **Message Type** to
  *Simple Text* and use `{{ $json.fallbackText }}` — the Code node already builds it.

## Extending this

The Code node emits flat fields (`title`, `status`, `priority`, `assignee`, `dueDate`,
`url`, `pageId`, …) alongside `slackPayload`, so downstream nodes can branch on them
without re-parsing Notion's structure. Common next steps:

- **Route by priority** — insert a Switch node on `{{ $json.priority }}` to send urgent
  tasks to a different channel.
- **DM the assignee** — add a Slack *Get User by Email* lookup, then post to that user.
- **Write back to Notion** — add a Notion *Update Page* node after Slack to stamp the
  message link onto the task, which is what a Workflow 2 (status sync) would build on.
