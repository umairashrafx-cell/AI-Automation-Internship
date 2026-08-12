# Subtask 3 — Connect Slack to n8n

There are three ways to do this. They are not equivalent — pick based on what you need.

| Method | Setup effort | Can post to | Can read/react/upload | Use when |
| --- | --- | --- | --- | --- |
| **A. Incoming Webhook** | 2 min | One fixed channel per webhook | No | Quick one-way alerts |
| **B. Bot token (`xoxb-`)** | 10 min | Any channel it's allowed in | Yes | **Recommended for this task** |
| **C. OAuth2** | 15 min | Any channel it's allowed in | Yes | Distributing to other workspaces |

Do **B**. It's the one that supports threads, reactions, and the Slack Trigger, which is what the
rest of this task needs.

---

## Method B — Bot token (recommended)

### B1. Create the Slack app

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. App name: `n8n` (this is the name that shows on every message it posts).
3. Pick your workspace → **Create App**.

### B2. Add bot scopes

**OAuth & Permissions** → *Scopes* → **Bot Token Scopes** → **Add an OAuth Scope**.

Add these:

| Scope | Why |
| --- | --- |
| `chat:write` | Post messages. Non-negotiable. |
| `chat:write.public` | Post to public channels **without** being invited first. |
| `chat:write.customize` | Override the bot's display name/icon per message (e.g. post as "Error Bot" into `#workflow-errors`). |
| `channels:read` | Lets n8n's channel dropdown list your channels instead of you typing IDs. |
| `users:read` | Resolve `@name` → user ID, needed to mention people correctly. |
| `reactions:write` | Add ✅ / 🚨 reactions to messages. |
| `files:write` | Upload files (CSV reports, logs). |
| `channels:history` | Required **only** if you use the Slack Trigger to react to messages. |
| `app_mentions:read` | Required **only** if you want the bot to respond when someone `@n8n`s it. |

The last two are optional for the basic task — add them if you want two-way workflows.

### B3. Install and copy the token

1. Scroll up on the same page → **Install to Workspace** → **Allow**.
2. Copy the **Bot User OAuth Token**. It starts with `xoxb-`.

> **Treat this like a password.** Anyone holding it can post as your bot. Don't paste it into a
> chat, a screenshot, or a git commit. If it leaks, **OAuth & Permissions → Revoke All OAuth Tokens**
> and reinstall.

### B4. Add the credential in n8n

1. n8n → **Credentials** (left sidebar) → **Add credential** → search **Slack API**.
2. Paste the token into *Access Token*.
3. Name it `Slack — n8n bot`.
4. **Save**. n8n runs a connection test; you should get a green tick.

If the test fails: the token was truncated on copy (they're long), or you copied the *User* token
(`xoxp-`) instead of the *Bot* token (`xoxb-`).

### B5. Invite the bot to the channels

Even with `chat:write.public`, invite it explicitly — it makes the bot visible in the member list
and is required for private channels and for reading history.

In each of the five channels, type:

```
/invite @n8n
```

Or: channel name → **Integrations** tab → **Add apps**.

### B6. Send a test message

Import [../workflows/01-alert-to-slack.json](../workflows/01-alert-to-slack.json), open the Slack
node, re-select your credential (credential IDs don't survive export), and click
**Execute workflow**. Check `#n8n-alerts`.

---

## Method A — Incoming Webhook (fallback)

Useful if you can't install an app, or want zero-scope one-way posting.

1. In your Slack app → **Incoming Webhooks** → toggle **On**.
2. **Add New Webhook to Workspace** → pick `#n8n-alerts` → **Allow**.
3. Copy the URL: `https://hooks.slack.com/services/T…/B…/…`
4. In n8n, use an **HTTP Request** node:
   - Method: `POST`
   - URL: the webhook URL
   - Body Content Type: `JSON`
   - Body: `{ "text": "Hello from n8n" }`

Limitations: the channel is baked into the URL, you can't thread reliably, you can't react, you
can't read anything. One webhook per channel.

---

## Method C — OAuth2

Only needed if the app will be installed by other workspaces.

1. In the Slack app → **OAuth & Permissions** → **Redirect URLs** → **Add New Redirect URL**.
2. The URL depends on where n8n runs:
   - **n8n Cloud:** `https://oauth.n8n.cloud/oauth2/callback`
   - **Self-hosted:** `https://<your-n8n-domain>/rest/oauth2-credential/callback`

   n8n shows you the exact string at the top of the credential form — copy it from there rather
   than typing it, since a mismatch is the single most common cause of `redirect_uri did not match`.
3. **Save URLs**.
4. **Basic Information** → copy **Client ID** and **Client Secret**.
5. n8n → **Add credential** → **Slack OAuth2 API** → paste both → **Connect my account** →
   authorise in the popup.

Self-hosted n8n must be reachable over **HTTPS** on a public domain for this. `localhost` will not
work — use `n8n tunnel` or a real domain.

---

## Using the Slack node

The Slack node's **Channel** field is a *resource locator* — the dropdown next to it lets you pick
**From list** (needs `channels:read`), **By ID** (`C01ABCDEF`), or **By name** (`#n8n-alerts`).

Prefer **By ID** in production workflows. Channel names can be renamed by anyone with permission;
IDs never change. Get an ID from the channel's **About** tab, at the bottom.

### Key operations

| Resource / Operation | Does |
| --- | --- |
| Message → Send | Post a message |
| Message → Update | Edit a message you already posted (needs its `ts`) |
| Message → Delete | Remove a message |
| Message → Send and Wait for Approval | Posts buttons and pauses the workflow until someone clicks |
| Reaction → Add | Add an emoji to a message |
| File → Upload | Attach a file |
| Channel → Get Many | List channels |

**Message → Send and Wait for Approval** is worth knowing about for `#client-updates`: the
workflow pauses, a human clicks Approve/Decline in Slack, and the workflow resumes down the
matching branch. That's how you put a human in the loop without building anything custom.

---

## Verification checklist

- [ ] Credential saves with a green connection test
- [ ] Bot appears in the member list of all five channels
- [ ] Test message arrives in `#n8n-alerts`
- [ ] Channel dropdown in the Slack node populates (proves `channels:read`)
- [ ] Error workflow posts to `#workflow-errors` when a workflow fails

## Common failures

| Error | Cause |
| --- | --- |
| `not_in_channel` | Bot not invited, and `chat:write.public` not granted |
| `channel_not_found` | Wrong ID, or a private channel the bot can't see |
| `invalid_auth` | Token revoked, truncated, or from a different workspace |
| `missing_scope` | Add the scope, then **reinstall the app** — scope changes need a reinstall |
| `ratelimited` | Slack allows ~1 message/second per channel. Add a Wait node in loops. |
| `redirect_uri did not match` | OAuth2 only — the redirect URL in Slack ≠ the one n8n shows |

The reinstall requirement catches everyone: adding a scope in the Slack UI does nothing to your
existing token. You must click **Install to Workspace** again afterwards. The token string stays
the same.
