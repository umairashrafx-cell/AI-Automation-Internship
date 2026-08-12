# Messages, Threads, Mentions, Notifications

The exploration part of the task. Each section covers the human behaviour first, then how it
behaves when n8n is the one posting — which is where the surprises are.

---

## Messages

A message is the atomic unit. Every message has a **timestamp ID** (`ts`), e.g. `1699887600.123456`,
which uniquely identifies it within a channel. The Slack node returns this after a send, and you
need it for threading, editing, deleting, and reacting.

**What you can do to one:** edit, delete, pin (channel-wide), save for later (personal), forward,
copy link, react with emoji, or start a thread. Hover over a message to see these.

**Formatting** — Slack's markup is `mrkdwn`, not Markdown, and the differences matter:

| Effect | Slack | Note |
| --- | --- | --- |
| Bold | `*bold*` | Markdown uses `**bold**` — that renders literally in Slack |
| Italic | `_italic_` | |
| Strikethrough | `~strike~` | |
| Inline code | `` `code` `` | Same as Markdown |
| Code block | ` ```code``` ` | No language hint support |
| Quote | `> quoted` | |
| Link | `<https://url\|label>` | **Not** `[label](url)` |
| Bullet | `•` (literal character) | `- item` does not become a list |

Headings (`#`) do not exist. n8n's Slack node has an **Include Link to Workflow** option and a
**Markdown** toggle under *Options*; leave Markdown on so `*bold*` renders.

**Block Kit** is the structured alternative — JSON that produces sections, dividers, buttons, and
fields. Use it when a plain string gets unreadable. Set the Slack node's *Message Type* to
**Blocks** and paste JSON. Build it visually at <https://app.slack.com/block-kit-builder>.

**Bot messages** carry an `APP` badge next to the name. With `chat:write.customize` you can set
`username` and `icon_emoji` per message, so one bot can appear as "Error Bot 🚨" in
`#workflow-errors` and "Status Bot 📊" in `#project-status`.

---

## Threads

A thread hangs replies off a parent message instead of adding them to the main channel flow.

**How:** hover a message → **Reply in thread** (speech-bubble icon). The parent gains a
"N replies" link. Replies live in the right-hand pane.

**"Also send to #channel"** — a checkbox on thread replies. Ticked, the reply appears in the main
channel too, marked as "also sent to the channel". Use it for the resolution of a thread, so people
who didn't follow it see the outcome.

**Where threads show up:** the **Threads** item at the top of the sidebar collects every thread
you're following, across all channels. You auto-follow threads you started, replied to, or were
mentioned in. Unfollow via the thread's ⋮ menu.

### Threading from n8n — the useful part

This is what makes threads worth setting up for automation. Pattern:

1. Slack node posts "🔄 Sync started" → returns `ts`.
2. Later nodes post progress **into the thread** by setting *Options → Reply to a message thread*
   and passing that `ts`.
3. The channel shows one line; the detail is one click away.

In the Slack node: **Options → Add option → Reply to a message thread**, then set
*Thread Timestamp* to an expression like:

```
{{ $('Post Start').item.json.ts }}
```

`reply_broadcast` is the API-level equivalent of the "Also send to channel" checkbox.

**Why it matters for `#workflow-errors`:** a retrying workflow that posts five separate failure
messages produces five notifications and looks like five incidents. Threaded under one parent, it's
one incident with a history. Post the first failure to the channel, thread every retry, and reply
in-thread with the resolution and "Also send to channel" ticked.

---

## Mentions

Mentions are how a message escapes someone's notification settings.

| Mention | Notifies | Notes |
| --- | --- | --- |
| `@username` | That person | Works even if their channel setting is "Nothing" |
| `@here` | Members currently **active** in the channel | Doesn't wake people up |
| `@channel` | **Every** member, active or not | Slack warns you first if the channel is large |
| `@everyone` | Everyone in the workspace | Only works in `#general` |
| `@user-group` | Everyone in that group | Paid plans only |

In the Slack UI, typing `@` autocompletes. **From the API — and therefore from n8n — you must use
the raw ID syntax, or it posts as literal text:**

| Target | Syntax in the message body |
| --- | --- |
| A user | `<@U01ABCDEF>` |
| Channel-wide | `<!channel>` |
| Active members | `<!here>` |
| A user group | `<!subteam^S01ABCDEF>` |
| Link to a channel | `<#C01ABCDEF>` |

Writing `@umar` in an n8n message posts the four characters `@umar` and notifies nobody. This is the
single most common reason an automated alert gets missed.

Find a user ID: click their profile → **⋮** → **Copy member ID**. Channel ID: channel **About** tab,
at the bottom.

**Restraint is the whole skill here.** An automated `<!channel>` on every error trains everyone to
mute the channel, and then real incidents are invisible too. Reasonable policy:

- `#workflow-errors` — plain message for normal failures; `<!here>` only for production-critical
  ones; `<@…>` the on-call person directly.
- `#n8n-alerts` — never mention anyone. That's the point of the channel.
- `#client-updates` — mention the account owner, never the channel.

---

## Notifications

### Per channel

Channel name → **Notifications** tab (or ⋮ next to the channel in the sidebar):

- **All new messages** — badge and alert for everything
- **Mentions** — only `@you`, `@here`, `@channel`, keywords *(the default)*
- **Nothing** — no alerts; the channel still bolds for unreads
- **Mute channel** — greys it out entirely, no bold, no badge

You can set desktop and mobile independently, and tick **Get notified about all replies** to follow
every thread in a channel.

### Workspace-wide

**Preferences → Notifications**:

- **Notify me about** — all messages / mentions / nothing, as the global default
- **My keywords** — arbitrary words that trigger a highlight. Add `deploy`, `failed`, your project
  name. Keywords are how you catch things without setting a channel to "All".
- **Notification schedule** — hours during which Slack is allowed to notify you. Outside them,
  notifications queue silently.
- **Pause notifications** (DND) — the bell icon in the sidebar; temporary. Someone can still force
  through with "Notify anyway" for genuine urgency.
- **Mobile**: "Send notifications to mobile when inactive for N minutes" — the desktop/mobile
  handoff. Default 10 minutes; drop it to 2 for on-call.

### Recommended setup for these five channels

| Channel | Desktop | Reasoning |
| --- | --- | --- |
| `#workflow-errors` | **All new messages** | Every message is by definition actionable |
| `#n8n-alerts` | **Mentions** or **Mute** | High volume, low urgency — read it when you choose to |
| `#client-updates` | **All new messages** | Low volume, external consequences |
| `#internship` | **Mentions** | Normal conversation |
| `#project-status` | **Mentions** | Scheduled digests; nothing time-critical |

This configuration is the payoff for keeping alerts and errors in separate channels. If everything
went to one channel, you'd have to choose between missing errors and being pinged constantly.

### Notification behaviour with bots

- Bot messages obey the same channel notification settings as human ones.
- A bot using `<!channel>` notifies everyone exactly as a human would — no special throttling.
- **Threaded bot replies notify only thread followers**, not the channel. This is why threading
  retries is quiet and posting them separately is loud.
- Slack rate-limits roughly **1 message per second per channel** (`chat.postMessage`, Tier 1+).
  Bursting past it returns `ratelimited`; add a **Wait** node inside loops.

---

## Things worth trying in the workspace

Concrete exercises that make the above stick:

1. Post in `#internship`, then reply in thread. Watch the channel view stay clean.
2. Reply again with **Also send to channel** ticked. Note how it renders differently.
3. Set `#n8n-alerts` to *Mute* and `#workflow-errors` to *All new messages*, then trigger both
   workflows and observe which one interrupts you.
4. Add `failed` as a notification keyword, then post "the sync failed" in a muted channel — it still
   highlights.
5. Send a message from n8n containing `@yourname` and then `<@U…>`. Only the second notifies you.
6. Pin the channel description message in `#workflow-errors` so the escalation rule is one click away.
7. Use **Message → Send and Wait for Approval** in a workflow pointed at `#client-updates` and click
   the button — watch the paused execution resume.
