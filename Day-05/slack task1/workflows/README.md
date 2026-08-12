# n8n workflows

Three importable workflows covering the three notification patterns you'll actually use.

| File | Trigger | Channel | Demonstrates |
| --- | --- | --- | --- |
| `01-alert-to-slack.json` | Manual | `#n8n-alerts` | Basic send + threading a follow-up under the first message |
| `02-error-handler.json` | Error Trigger | `#workflow-errors` | Failure reporting, conditional `<!here>`, custom bot identity, emoji reaction |
| `03-project-status-digest.json` | Schedule (daily 09:00) | `#project-status` | Scheduled digest with formatted metrics |

## Importing

n8n → **Workflows** → **⋯** (top right) → **Import from File…** → pick the JSON.

Or paste: open a blank workflow, `Ctrl+A` on the canvas, then `Ctrl+V` with the JSON in your
clipboard.

## After importing — do this or it won't run

1. **Re-select the credential in every Slack node.** Credential IDs don't survive export; the
   placeholder `REPLACE_WITH_YOUR_CREDENTIAL` will show as a broken credential. Open each Slack
   node → *Credential to connect with* → pick `Slack — n8n bot`.
2. **Check the channel field.** Channels are referenced *By name* (`#n8n-alerts`) so the files work
   in any workspace. For anything you'll keep, switch the resource-locator dropdown to **From list**
   and pick the channel — that stores the immutable channel ID instead.
3. **Activate** workflow 03 (toggle, top right) or its schedule never fires. Workflow 01 is
   manual-only; workflow 02 needs no activation.

## Wiring up the error handler

Workflow 02 does nothing on its own — an Error Trigger only fires when *another* workflow
designates it. For each workflow you want covered:

**Workflow → ⋯ → Settings → Error Workflow → `02 — Error Handler → #workflow-errors`**

Test it by adding a **Stop and Error** node to a throwaway workflow, setting the error workflow,
and executing. A message should appear in `#workflow-errors`.

Note that Error Trigger fires on **production** executions (active workflows, webhooks, schedules).
Manual test runs from the editor do not trigger it — this trips people up. Use *Execute Workflow*
on a saved, activated workflow, or trigger it via its webhook.

## If the thread option doesn't come through on import

The *Reply to a message thread* setting in `01-alert-to-slack.json` lives in a nested options
structure that occasionally shifts between node versions. If the "Reply In Thread" node posts to
the channel instead of into the thread, set it manually:

1. Open the node → **Options** → **Add option** → **Reply to a message thread**
2. Set *Thread Timestamp* to the expression:

   ```
   {{ $('Post Start').item.json.ts }}
   ```

## Block Kit example

For richer formatting, set a Slack node's *Message Type* to **Blocks** and paste
[`block-kit-status.json`](block-kit-status.json). Preview and edit it at
<https://app.slack.com/block-kit-builder> before pasting.
