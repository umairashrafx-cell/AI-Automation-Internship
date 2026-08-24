/**
 * Module 09 — AI Operations Manager
 * Step: "Safe Action Guard"  (Code by Zapier → Run JavaScript)
 *
 * Enforces the safety rules in code, not in a prompt.
 *
 *   The agent cannot:
 *     - Delete records
 *     - Send external messages without approval
 *     - Change financial information
 *   It can only perform predefined safe actions.
 *
 * A prompt instruction is a request. This step is the enforcement: any action
 * the agent proposes is checked against an allowlist, and anything not on it is
 * downgraded to a recommendation for a human. Nothing downstream acts on an
 * action this step did not approve.
 *
 * ---------------------------------------------------------------------------
 * inputData mapping
 * ---------------------------------------------------------------------------
 *   proposedActions → the agent's proposed actions, one per line, in the form
 *                     ACTION_TYPE | target | detail
 *                     e.g. "create_task | Hassan | Follow up — Skyline ($8,000)"
 *   followUpTaskTitle → {{Analyze: followUpTaskTitle}}
 *   followUpOwner     → {{Analyze: followUpOwner}}
 *   shouldCreateFollowUp → {{Analyze: shouldCreateFollowUp}}
 *   existingTaskTitles → {{Find Records (Tasks): Task}}  comma-joined
 *
 * ---------------------------------------------------------------------------
 * output
 * ---------------------------------------------------------------------------
 *   approvedActions   String   newline-joined, safe to execute
 *   approvedCount     Number
 *   blockedActions    String   newline-joined, with the reason
 *   blockedCount      Number
 *   createFollowUp    Boolean  the one auto-action this Zap performs
 *   followUpTitle     String
 *   followUpOwner     String
 *   followUpDueDate   String   "YYYY-MM-DD" — today
 *   auditLine         String
 */

// --- the allowlist ---------------------------------------------------------
// Only these action types may execute automatically. Everything else is a
// recommendation. Adding to this list is a deliberate decision, not a default.
var SAFE_ACTIONS = [
  'create_task',      // create a follow-up task in the Tasks table
  'update_task_owner',// reassign an internal task
  'flag_record',      // set an internal flag/status column
  'add_note'          // append an internal note
];

// --- explicitly forbidden, with the reason shown in the report -------------
var FORBIDDEN = [
  { match: 'delete',        reason: 'Deleting records is never permitted.' },
  { match: 'remove_record', reason: 'Deleting records is never permitted.' },
  { match: 'send_email',    reason: 'External messages require human approval.' },
  { match: 'send_sms',      reason: 'External messages require human approval.' },
  { match: 'email_customer',reason: 'External messages require human approval.' },
  { match: 'post_',         reason: 'External publishing requires human approval.' },
  { match: 'update_amount', reason: 'Financial information cannot be changed by the agent.' },
  { match: 'update_deal_value', reason: 'Financial information cannot be changed by the agent.' },
  { match: 'refund',        reason: 'Financial actions require a human.' },
  { match: 'discount',      reason: 'Financial actions require a human.' },
  { match: 'invoice',       reason: 'Financial actions require a human.' },
  { match: 'close_deal',    reason: 'Changing deal stage is a sales decision, not an ops one.' }
];

var approved = [];
var blocked = [];

var raw = String(inputData.proposedActions || '').trim();
var proposed = raw ? raw.split('\n') : [];

for (var i = 0; i < proposed.length; i++) {
  var line = String(proposed[i]).trim();
  if (!line) { continue; }

  var actionType = line.split('|')[0].trim().toLowerCase().replace(/\s+/g, '_');

  // Forbidden check runs first and matches on substring, so a creative
  // variant like "send_email_to_customer" is still caught.
  var blockedReason = '';
  for (var f = 0; f < FORBIDDEN.length; f++) {
    if (actionType.indexOf(FORBIDDEN[f].match) !== -1) {
      blockedReason = FORBIDDEN[f].reason;
      break;
    }
  }

  if (blockedReason) {
    blocked.push(line + '   ⟶ BLOCKED: ' + blockedReason);
    continue;
  }

  if (SAFE_ACTIONS.indexOf(actionType) !== -1) {
    approved.push(line);
  } else {
    // Default deny. An action nobody listed is not safe by omission.
    blocked.push(line + '   ⟶ BLOCKED: "' + actionType +
                 '" is not on the safe-action allowlist. Recommended to a human instead.');
  }
}

// --- the one auto-action this Zap performs ---------------------------------
// Create a follow-up task for the most valuable stale deal — but only if no
// task already exists for that customer.
var shouldCreate = String(inputData.shouldCreateFollowUp) === 'true' ||
                   inputData.shouldCreateFollowUp === true;

var followUpTitle = String(inputData.followUpTaskTitle || '').trim();
var existingTitles = String(inputData.existingTaskTitles || '').toLowerCase();

var duplicateExists = false;
if (followUpTitle) {
  // Compare on the customer name portion, not the whole title, since the
  // amount in the title changes as the deal moves.
  var customerPart = followUpTitle.replace(/^Follow up — /, '').split('(')[0].trim().toLowerCase();
  if (customerPart && existingTitles.indexOf(customerPart) !== -1) {
    duplicateExists = true;
  }
}

var createFollowUp = shouldCreate && followUpTitle !== '' && !duplicateExists;

if (createFollowUp) {
  approved.push('create_task | ' + String(inputData.followUpOwner || 'unassigned') +
                ' | ' + followUpTitle);
} else if (shouldCreate && duplicateExists) {
  blocked.push('create_task | ' + followUpTitle +
               '   ⟶ SKIPPED: a follow-up task already exists for this customer.');
}

var today = new Date().toISOString().substring(0, 10);

output = {
  approvedActions: approved.length ? approved.join('\n') : 'None.',
  approvedCount: approved.length,
  blockedActions: blocked.length ? blocked.join('\n') : 'None.',
  blockedCount: blocked.length,
  createFollowUp: createFollowUp,
  followUpTitle: followUpTitle,
  followUpOwner: String(inputData.followUpOwner || 'unassigned'),
  followUpDueDate: today,
  duplicateSkipped: duplicateExists,
  auditLine: approved.length + ' action(s) approved, ' + blocked.length +
             ' blocked or recommended to a human, on ' + today
};

/**
 * ---------------------------------------------------------------------------
 * Default deny
 * ---------------------------------------------------------------------------
 * Note the ordering: forbidden patterns are checked before the allowlist, and
 * anything matching neither is BLOCKED rather than allowed. An agent that
 * invents a plausible-sounding action type ("notify_customer_gently") gets it
 * turned into a recommendation, not executed.
 *
 * This is the difference between a safety rule and a safety mechanism. The
 * prompt in prompts/ops-agent.md tells the agent what it may not do; this file
 * makes it so.
 */
