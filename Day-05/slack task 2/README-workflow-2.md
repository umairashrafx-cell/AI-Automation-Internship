# Workflow 2 — Client Onboarding (Notion → Slack)

When a new client row is added to a Notion database, n8n creates a dedicated Slack channel
for them, invites the team, posts a welcome message with the client's details, and announces
the new client in a shared team channel.

```
New Client in Notion → Format Client → Has Client Name? ──false──→ Skip (no client name)
(page added)           (Code)          (IF)  │
                                            true
                                             ↓
                          Create Slack Channel ──error──→ Skip (channel exists)
                                             ↓
                          Prepare Slack Payloads  (Code: channel ID + Block Kit)
                                             ↓
                          Post Welcome Message    (into the new channel)
                                             ↓
                          Team to Invite? ──true──→ Invite Team ──┐
                                     │ false                     │
                                     └───────────→ Notify Team ←──┘
                                                        ↓
                                          Save Channel to Notion  (disabled)
```

Import `workflow-2-client-onboarding.json` into n8n via **Workflows → ⋯ → Import from File**.

## What each node does

| Node | Purpose |
| --- | --- |
| **New Client in Notion** | Polls the clients database once a minute for rows added since the last check. |
| **Format Client** | Flattens the Notion page into plain fields and turns the client name into a legal Slack channel name. |
| **Has Client Name?** | Drops the empty rows Notion creates when someone clicks **+ New** and walks away. |
| **Create Slack Channel** | `conversations.create`. Its second output catches failures — usually a channel that already exists. |
| **Prepare Slack Payloads** | Joins the new channel's ID back to the client data and builds both Block Kit messages. |
| **Post Welcome Message** | Posts the client brief *inside* the new channel. |
| **Team to Invite?** | Skips the invite step when no member IDs are configured, so the run doesn't fail with `no_user`. |
| **Invite Team** | `conversations.invite` for the member IDs listed in the code node. |
| **Notify Team** | Announces the client in your shared channel, linking to the new one. |
| **Save Channel to Notion** | Writes the channel link back onto the Notion row. **Disabled** — enable once your database has the property. |

## Setup

### 1. Notion

Notion calls these **connections** now rather than "integrations".

1. <https://app.notion.com/developers/connections> → **Internal connections** → **Create a new
   connection**. Name it something like `n8n Client Onboarding`.
2. On **Configuration**, enable **Read content** (required) and **Read user information
   (without email addresses)** for the *Owner* / *Account Manager* column. Enable **Update
   content** only if you plan to use the *Save Channel to Notion* node.
3. Copy the **Installation access token** (`ntn_…`, or `secret_…` on older workspaces). It is
   shown once.
4. Grant it access to the clients database: **Content access → Edit access**, or in Notion open
   the database → **•••** → **Connections → + Add connection**. Skipping this makes the trigger
   return nothing, with no error.
5. Copy the database ID from the URL — the 32 characters between the workspace slug and the `?`.
   Inline databases must be opened as a full page first (**⋯ → Open as full page**), otherwise
   you get the parent page ID.
6. In n8n: **Credentials → New → Notion API**, paste the token into **Internal Integration Secret**.

### 2. Slack credentials and authentication

n8n offers two Slack credential types. This workflow ships with **Slack API** (bot token),
which is the simpler one and the right default for server-side automation.

| Credential type | What it is | When to use it |
| --- | --- | --- |
| **Slack API** | A single bot token (`xoxb-…`) you paste in. Acts as the app itself. | Recommended here. Tokens don't expire, nothing to refresh, and the workflow keeps working when the person who built it leaves. |
| **Slack OAuth2 API** | Full OAuth handshake against your own Slack app, with a redirect URL from n8n. | When you want per-user consent, or the app posting as an installed user. Needs your n8n to be reachable at a public HTTPS URL. |

Steps for the bot token:

1. Create an app at <https://api.slack.com/apps> → **From scratch** → pick your workspace.
2. **OAuth & Permissions → Bot Token Scopes**, add:

   | Scope | Needed for |
   | --- | --- |
   | `channels:manage` | Creating **public** channels and inviting people to them |
   | `groups:write` | Same, for **private** channels — add this only if you switch to private |
   | `chat:write` | Posting the welcome message and the announcement |
   | `chat:write.public` | Posting to a public channel the bot hasn't been invited to |
   | `channels:read`, `groups:read` | The channel dropdown in the n8n node |
   | `users:read` | The member dropdown, and resolving names |
   | `users:read.email` | Only if you extend this to look team members up by email |

   Scope changes require **Reinstall to Workspace** before they take effect.
3. Copy the **Bot User OAuth Token** (`xoxb-…`) from the top of the same page.
4. Invite the bot to your announcement channel: `/invite @YourAppName`. It creates the client
   channels itself, so it's automatically a member of those.
5. In n8n: **Credentials → New → Slack API**, paste the token, **Save**. Use the credential's
   **Test** button — a bad token fails here as `invalid_auth` rather than mid-run.

Store the token only in the n8n credential. Don't paste it into a node field or a code node —
credentials are encrypted at rest and are redacted from execution logs.

### 3. Fill in the placeholders

Four placeholders, spread over the nodes that need them. The easiest path is to open each node
and pick values from the dropdowns, which fills the credential IDs for you.

| Placeholder | Node(s) | Where to find it |
| --- | --- | --- |
| `REPLACE_WITH_NOTION_CLIENTS_DATABASE_ID` | New Client in Notion | Step 1.5 above |
| `REPLACE_WITH_NOTION_CREDENTIAL_ID` | New Client in Notion, Save Channel to Notion | Select the credential in the dropdown |
| `REPLACE_WITH_SLACK_CREDENTIAL_ID` | Create Slack Channel, Post Welcome Message, Invite Team, Notify Team | Select the credential in the dropdown |
| `REPLACE_WITH_SLACK_TEAM_CHANNEL_ID` | Notify Team | Pick **From list**, or use the `C…` ID from the channel's Slack URL |

Then open **Format Client** and add your team's Slack member IDs at the top:

```js
const TEAM_USER_IDS = ['U01ABCDEF', 'U02GHIJKL'];
```

Get an ID from a Slack profile → **⋯ → Copy member ID**. Left empty, the *Team to Invite?* node
routes around the invite step instead of failing.

### 4. Test

Use **Fetch Test Event** on the trigger to pull a recent row without waiting for a poll, then
**Execute Workflow**. Channel creation is real even in a test run — use a throwaway client row
first, and archive the channel afterwards. Once the messages look right, toggle the workflow
**Active**; polling triggers only run on their schedule while active.

## Selecting a Slack channel

Every Slack node here uses n8n's **resource locator** for the channel, the control with a mode
dropdown on its left. The same field accepts three kinds of input:

| Mode | Stored as | Use when |
| --- | --- | --- |
| **From list** | The `C…` ID, with the name cached for display | You are picking a fixed channel by hand — *Notify Team* |
| **By ID** | `C0123456789` | You are pasting an ID, or feeding one in from an expression |
| **By name** | `#general` | Quick and readable, but breaks if the channel is renamed |

Prefer IDs over names for anything permanent: a renamed channel keeps its ID.

The interesting case is *Post Welcome Message*, whose channel isn't known until the workflow
runs. Its locator is set to **By ID** with an expression instead of a literal:

```
{{ $json.channelId }}
```

That value comes out of *Prepare Slack Payloads*, which read it from the `conversations.create`
response. Any locator field accepts an expression this way — that is how you post into a channel
that didn't exist a second ago.

## Mapping dynamic data into Slack messages

Two patterns are in play, and it's worth knowing when to use which.

**1. Expressions in node fields** — good for one or two values:

```
Hi team, {{ $json.clientName }} starts on {{ $json.startDatePretty }}.
```

`$json` is the item coming into *this* node. Because each Slack call replaces the data flowing
down the chain, later nodes reach back to the payload builder explicitly:

```
{{ $('Prepare Slack Payloads').item.json.channelId }}
```

`.item` follows n8n's paired-item trail, so with several new clients in one poll each message
still gets its own client's data. (`.first()` would give you client #1 every time — a classic
bug when a batch of rows arrives at once.)

**2. Block Kit built in a Code node** — what this workflow does for both messages. The code node
assembles `{ blocks, text }`, and the Slack node's **Blocks** field is just:

```
{{ JSON.stringify($json.slackWelcome) }}
```

Building blocks in JavaScript means fields with no value are *omitted* rather than rendered as
`*Plan*` followed by nothing — the `addField` helper in *Prepare Slack Payloads* skips empties.
That is hard to do in a text template and is the main reason to prefer this shape.

Sending plain text instead: set **Message Type** to *Simple Text* and use
`{{ $json.welcomeText }}` or `{{ $('Prepare Slack Payloads').item.json.announceText }}` — the
code node already builds both fallback strings.

Escape hatch: mrkdwn is not Markdown. Bold is `*one asterisk*`, links are `<https://x|label>`,
and channel mentions are `<#C0123456789>` — which is how the announcement turns into a clickable
channel link.

## Channel naming

Slack rejects channel names that aren't lowercase, are over 80 characters, or contain anything
outside letters, digits, hyphens and underscores. **Format Client** normalises the client name
before it ever reaches the API:

| Notion client name | Channel |
| --- | --- |
| `Acme Cafés & Co. — EMEA!!` | `client-acme-cafes-and-co-emea` |
| `Nord/Süd Logistik` | `client-nord-sud-logistik` |
| `24/7 Support Ltd.` | `client-24-7-support-ltd` |

Accents are stripped, `&` becomes `and`, everything else collapses to single hyphens, and the
result is truncated to 80 characters. Change the prefix at the top of the node:

```js
const CHANNEL_PREFIX = 'client-';
```

## Which Notion columns get used

Column names are matched case-insensitively, and the client-name column is found by type, so it
can be called anything (`Name`, `Client`, `Company`). Missing columns are simply left out of the
Slack messages.

| Slack field | Notion column names accepted | Column types |
| --- | --- | --- |
| Client name → channel | *(any title column)* | Title |
| Plan | `Plan`, `Tier`, `Package`, `Product` | Select, Status |
| Industry | `Industry`, `Sector`, `Vertical` | Select, Multi-select, Rich text |
| Owner | `Owner`, `Account Manager`, `CSM`, `Assigned to`, `Assignee` | Person, Rich text |
| Kickoff | `Start Date`, `Kickoff`, `Kickoff Date`, `Onboarding Date`, `Go Live` | Date |
| Contract value | `Contract Value`, `Value`, `ARR`, `MRR`, `Deal Size` | Number |
| Primary contact | `Primary Contact`, `Contact`, `Contact Email`, `Email` | Email, Rich text |
| Website | `Website`, `URL`, `Domain` | URL, Rich text |
| Region | `Region`, `Market`, `Timezone` | Select, Status |
| Body text | `Notes`, `Description`, `Scope`, `Summary` | Rich text |
| *(not shown)* | `Status`, `Stage`, `Onboarding Status` | Select, Status |

To support a differently-named column, add it to the relevant `pick(props, …)` call. Contract
value is formatted as USD — change `CURRENCY` at the top of **Format Client**.

## Things worth knowing

- **If the channel-name field looks empty after import**, paste `{{ $json.channelName }}` into
  **Create Slack Channel → Name**. Slack node builds disagree on the key that field is stored
  under, so the JSON sets both spellings; only one of them will be the one your version reads.
- **Channel creation is not reversible.** Slack has no delete-channel API for regular channels;
  the most you can do is archive. A bad test run leaves clutter behind, so test with a throwaway
  client name.
- **`name_taken`.** Re-running the workflow for the same client, or two clients whose names slug
  identically, fails here. That is what the *Skip (channel exists)* branch catches, so the run
  ends cleanly instead of red. To post into the existing channel instead, replace that NoOp with
  a Slack **Channel → Get** on `{{ $('Format Client').item.json.channelName }}` and wire it into
  *Prepare Slack Payloads*.
- **Private channels.** Switch **Create Slack Channel** to private in the node's options and add
  the `groups:write` scope. Note that `chat:write.public` does not apply to private channels — the
  bot has to be a member, which it is for channels it creates itself.
- **`not_in_channel` on Notify Team.** The announcement channel is the one channel the bot
  doesn't create, so invite it: `/invite @YourAppName`.
- **`invalid_auth` / `missing_scope`.** Token typo, or a scope added without reinstalling the
  app. Reinstall, then re-test the credential.
- **The trigger polls, it does not push.** Expect up to a minute of delay; adjust under **Poll
  Times**. Only rows created after activation fire — backfilling needs a separate one-off run.
- **Rate limits.** `conversations.create` is Tier 2 (~20/minute) and posting is about 1 message
  per second per channel. Pasting 30 clients into Notion at once will hit that; add a **Loop Over
  Items** node with a small batch interval before *Create Slack Channel* if that's realistic for
  you.
- **Deleting the Notion row does nothing.** This workflow is one-directional; offboarding is a
  separate workflow.

## Extending this

- **Route by plan** — a Switch node on `{{ $json.plan }}` before *Create Slack Channel*, so
  enterprise clients get a different prefix or a private channel.
- **Set the channel topic and purpose** — Slack's create call can't do it, but the node's
  **Channel → Set Topic** / **Set Purpose** operations can, right after creation.
- **Invite the owner dynamically** — *Format Client* already emits `ownerEmails`. Add a Slack
  **User → Get** with **By Email**, then merge the returned ID into the invite list. Needs
  `users:read.email`.
- **Save the channel back to Notion** — enable *Save Channel to Notion* once the database has a
  URL property called `Slack Channel`. Rename the property in the node's **Properties** field if
  yours is called something else.
- **Add a kickoff task** — a Notion *Create Database Page* node against your tasks database,
  which is what Workflow 1 already watches. The two workflows then chain: new client → channel →
  kickoff task → task notification.
