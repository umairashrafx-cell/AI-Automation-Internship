# Day 06 — Airtable + n8n Integration (Module 3)

n8n workflows built on top of the **MATalogics AI Operations Base** in Airtable (`appqAtUcjqZliQgdS`).
The set covers the full Airtable CRUD cycle plus four event-driven automations that push
notifications to Slack and Gmail whenever records are created or change status.

## Contents

```
Day 06/
├── Workflow/       6 exported n8n workflow JSON files
└── Screen Shot/    8 screenshots of the n8n canvas, Airtable tables and Slack output
```

## Workflows

| File | Trigger | What it does | Active |
|---|---|---|---|
| [Module 3_ Airtable + n8n Integration.json](Workflow/Module%203_%20Airtable%20+%20n8n%20Integration.json) | Manual | CRUD demo — Create → Update → Search → Delete against the `Clients` table | No |
| [Client Onboarding.json](Workflow/Client%20Onboarding.json) | Airtable, on `Created Time` | Generates the next sequential `CL-00X` client ID, writes it back to the record, announces the new client in Slack | Yes |
| [Lead management.json](Workflow/Lead%20management.json) | Airtable, on `Created Time` | Posts new leads (name, source, contact, interested service) to the Slack lead channel | Yes |
| [Project Tracking.json](Workflow/Project%20Tracking.json) | Airtable, on `Status Last Changed` | Emails a project status update via Gmail (project, assignee, status, deadline) | Yes |
| [AI Agent Monitoring.json](Workflow/AI%20Agent%20Monitoring.json) | Airtable, on `Status Changed Time` | Posts agent deployment status to `#operation-team` in Slack | No |
| [Internship Tracker.json](Workflow/Internship%20Tracker.json) | Airtable, on `Status Changed Time` | Scaffold: IF → Search records → Code → Update record (conditions and table refs not yet filled in) | No |

All triggers poll **every minute**.

### Airtable tables used

| Table ID | Purpose |
|---|---|
| `tblm10BtZ9z2TUyXK` | Clients (CRUD demo + onboarding) |
| `tblVKoDKIQGfqbchm` | Leads |
| `tblZshpzL0LcgDzES` | Projects |
| `tblXvzRqam9EqwlVS` | AI Agents |
| `tblFOaOINzj92weyE` | Internships |

### Client ID generation

`Client Onboarding` runs a JavaScript node that reads every existing `Client ID`, keeps the ones
matching `CL-<digits>`, takes the max and increments it, zero-padded to three digits:

```js
const nextNum = ids.length ? Math.max(...ids) + 1 : 1;
const nextId  = `CL-${String(nextNum).padStart(3, '0')}`;
```

The ID is then written back to the triggering record and used in the Slack message.

## Importing a workflow

1. In n8n: **Workflows → … → Import from File**, pick a JSON file from `Workflow/`.
2. Re-map credentials — the exports reference credentials by ID and those won't exist in a new instance:
   - Airtable Personal Access Token (`airtableTokenApi`)
   - Slack (`slackApi`)
   - Gmail OAuth2 (`gmailOAuth2`)
3. Re-select the base and table in each Airtable node (`Internship Tracker` ships with empty base/table refs).
4. Update the hard-coded destinations before activating:
   - Slack channels are stored as workspace URLs / channel IDs specific to the MATalogics workspace.
   - `Project Tracking` sends to a fixed Gmail address.
5. Activate the workflow.

## Notes

- No secrets are stored in these files — only credential *names* and IDs; the tokens live in n8n.
- The `Module 3` demo workflow ends with a **Delete a record** node that removes every record its
  Search step returned (`{Status} = "Active"`). Run it against test data only.
- `Internship Tracker` is incomplete: the IF node has an empty condition and the Airtable nodes have
  no base/table selected, so it will fail if activated as-is.

## Screenshots

`Screen Shot/` documents the build: the n8n canvas with all five CRUD nodes executed successfully,
the Airtable base and its tables, and the resulting Slack notifications in `#operation-team`.
